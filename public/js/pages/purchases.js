/* Purchases: history, one purchase in full, and the
   upload → read → review → confirm flow that books stock in. */
(function () {
  'use strict';
  const {
    esc, money, rupees, qty, plural, date, dateTime, table, skeleton, statusTag, toast, errorToast, modal,
    productSearch, partySearch, formValues, todayIso, pageHead, wireLinks,
  } = window.ui;

  const SEARCH_ICON = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4A4843"
    stroke-width="1.8" stroke-linecap="round"><path d="M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3"/></svg>`;

  async function history(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Purchases',
    sub: "Everything you've bought from suppliers.",
    actions: '<a class="btn primary" href="#/purchases/add">+ Add Purchase</a>',
  })}
      <div class="filters">
        <div class="search">${SEARCH_ICON}
          <input type="search" id="q" placeholder="Search purchase number or supplier…" autocomplete="off"></div>
        <select id="period" aria-label="Date">
          <option value="month">This month</option>
          <option value="last30">Last 30 days</option>
          <option value="year">This year</option>
          <option value="all">Everything</option>
        </select>
      </div>
      <div class="card" id="list">${skeleton(7)}</div>`;

    const load = async () => {
      const { from, to } = window.ui.range(view.querySelector('#period').value);
      const { purchases } = await window.api.get('/api/purchases', {
        q: view.querySelector('#q').value.trim(), from, to, limit: 200,
      });
      const list = view.querySelector('#list');
      list.innerHTML = purchases.length ? table(purchases, [
        { label: 'Purchase #', class: 'doc', render: (p) => esc(p.purchase_no) },
        { label: 'Supplier', render: (p) => esc(p.supplier_name || '—') },
        { label: 'Date', render: (p) => `<span class="muted nowrap">${date(p.invoice_date)}</span>` },
        { label: 'Items', num: true, render: (p) => qty(p.item_count) },
        { label: 'Amount', num: true, render: (p) => rupees(p.total) },
        { label: 'Status', noLabel: true, render: (p) => statusTag(p.status) },
      ], { rowAttrs: (p) => `data-href="#/purchases/${p.id}"` })
        : `<div class="empty"><h3>No purchases yet</h3>
            <p>Add stock manually or scan a supplier invoice.</p>
            <a class="btn primary" href="#/purchases/add">+ Add Purchase</a></div>`;
      wireLinks(list);
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
    view.querySelector('#period').addEventListener('change', load);
    await load();
  }

  /** One supplier bill: what came in, what it cost, and whether it still needs checking. */
  async function detail(view, id) {
    const { purchase: p, items, serials } = await window.api.get(`/api/purchases/${id}`);
    const units = items.reduce((sum, i) => sum + i.qty, 0);
    const halfGst = p.gst_amount / 2;

    view.innerHTML = `
      <div style="max-width:960px">
        ${pageHead({
    title: `${esc(p.purchase_no)} ${statusTag(p.status)}`,
    sub: `From ${p.supplier_id ? `<a href="#/contacts/supplier/${p.supplier_id}">${esc(p.supplier_name)}</a>` : esc(p.supplier_name || 'an unnamed supplier')}
      · ${date(p.invoice_date)}${p.supplier_invoice_no ? ` · Supplier bill ${esc(p.supplier_invoice_no)}` : ''}`,
    actions: `<button class="btn" data-do="print">Print</button>
      <a class="btn" href="#/purchases/add">Enter another bill</a>`,
  })}

        ${p.status === 'NEEDS_REVIEW' ? `
          <div class="alert warn">
            <span class="glyph">!</span>
            <div class="grow"><strong>${plural(p.flagged_items, 'item')} need checking.</strong>
              Some details were hard to read on the scanned bill.</div>
            <button class="btn small" id="mark-checked">Mark as checked</button>
          </div>` : ''}

        <div class="card">
          <div class="pad" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;border-bottom:1px solid var(--rule)">
            <div>
              <div class="section-label">Supplier</div>
              <div style="font-weight:600;margin-top:6px">${esc(p.supplier_name || '—')}</div>
              ${p.supplier_gstin ? `<div class="small muted">GSTIN ${esc(p.supplier_gstin)}</div>` : ''}
            </div>
            <div>
              <div class="section-label">Recorded</div>
              <div style="font-weight:600;margin-top:6px">${p.source === 'SCAN' ? 'Read from the bill' : 'Entered by hand'}</div>
              <div class="small muted">${esc(p.created_by_name || '')} · ${dateTime(p.created_at)}</div>
            </div>
            ${p.payment_terms || p.due_date ? `<div>
              <div class="section-label">Payment</div>
              <div style="font-weight:600;margin-top:6px">${esc(p.payment_terms || 'Not set')}</div>
              ${p.due_date ? `<div class="small muted">Due ${date(p.due_date)}</div>` : ''}
            </div>` : ''}
          </div>
          ${table(items, [
    { label: 'Product', render: (i) => esc(i.product_name || i.description) },
    { label: 'HSN', num: true, render: (i) => esc(i.hsn_code || '—') },
    { label: 'Qty', num: true, render: (i) => qty(i.qty) },
    { label: 'Rate', num: true, render: (i) => money(i.unit_price) },
    { label: 'Amount', num: true, render: (i) => money(i.total) },
  ], { rowAttrs: (i) => `data-href="#/inventory/product/${i.product_id}"` })}
          <div class="pad" style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap">
            <div class="small muted" style="max-width:360px">
              ✓ ${plural(units, 'unit')} added to stock on ${date(p.invoice_date)}.
              ${serials.length ? `<br>${plural(serials.length, 'serial number')} recorded.` : ''}
            </div>
            <div style="min-width:260px;display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;justify-content:space-between"><span class="muted">Subtotal</span><span class="num">${money(p.subtotal)}</span></div>
              <div style="display:flex;justify-content:space-between"><span class="muted">CGST</span><span class="num">${money(halfGst)}</span></div>
              <div style="display:flex;justify-content:space-between"><span class="muted">SGST</span><span class="num">${money(halfGst)}</span></div>
              <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;font-size:19px;font-weight:600">
                <span>Total</span><span class="num">${money(p.total)}</span></div>
            </div>
          </div>
        </div>
      </div>`;

    wireLinks(view);
    view.querySelector('[data-do="print"]').addEventListener('click', () => window.print());
    const checked = view.querySelector('#mark-checked');
    if (checked) {
      checked.addEventListener('click', async () => {
        try {
          await window.api.post(`/api/purchases/${p.id}/checked`, {});
          toast(`${p.purchase_no} marked as checked.`);
          detail(view, id);
        } catch (err) { errorToast(err); }
      });
    }
  }

  async function add(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Add Purchase',
    sub: 'Upload the supplier bill and check what we read — nothing reaches your stock until you confirm.',
  })}

      <ol class="steps">
        <li class="done"><span class="mark">1</span>Upload the bill</li>
        <li class="now"><span class="mark">2</span>Check what we read</li>
        <li><span class="mark">3</span>Confirm and add to stock</li>
      </ol>

      <div class="card">
        <div class="card-head">
          <div><h2>Upload the supplier invoice</h2>
            <p>PDF, Excel, CSV or text. Several at once are queued and reviewed one after another.</p></div>
        </div>
        <div class="pad">
          <div class="dropzone" id="dropzone">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#1A6C8C" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/></svg>
            <div style="font-weight:600;margin-top:8px">Drag &amp; drop the bill here</div>
            <p class="muted small">or choose the files yourself</p>
            <input type="file" id="file" accept=".pdf,.xlsx,.xlsm,.xltx,.txt,.csv,.tsv,image/*" multiple
              style="max-width:420px;margin:0 auto 12px">
            <button class="btn primary" id="scan" type="button">Read Invoice</button>
          </div>
          <p class="hint">A photo of a paper bill has no text to read — type those items in below instead.</p>
          <div id="scan-status" style="margin-top:12px"></div>
        </div>
      </div>

      <form class="card" id="form">
        <div class="card-head"><h2>Purchase details</h2></div>
        <div class="pad">
          <div id="supplier-pick"></div>
          <div class="form-grid" style="margin-top:16px">
            <label>Supplier invoice no<input name="supplier_invoice_no"></label>
            <label>Invoice date<input name="invoice_date" type="date" value="${todayIso()}"></label>
            <label class="full">Notes <span class="opt">(optional)</span><input name="notes"></label>
          </div>
        </div>

        <div class="card-head" style="border-top:1px solid var(--rule)"><h2>Items</h2>
          <button type="button" class="link-btn" id="add-line">+ Add item</button></div>
        <div id="lines"></div>
        <div class="pad hidden" id="line-picker"></div>

        <div class="card-foot">
          <span class="muted small grow" id="summary"></span>
          <a class="link-btn quiet" href="#/purchases">Cancel</a>
          <button class="btn primary" type="submit" id="confirm">Confirm &amp; Add to Inventory</button>
        </div>
      </form>`;

    const dropzone = view.querySelector('#dropzone');
    const fileInput = view.querySelector('#file');
    ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove('over')));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileInput.files = e.dataTransfer.files;
      view.querySelector('#scan').click();
    });

    const state = { supplierId: null, supplierName: '', lines: [], fileName: '', queue: [], queueIndex: 0 };

    partySearch(view.querySelector('#supplier-pick'), 'suppliers', (s) => {
      state.supplierId = s.id;
      state.supplierName = s.name;
    });

    const linesHost = view.querySelector('#lines');

    function renderLines() {
      if (!state.lines.length) {
        linesHost.innerHTML = `<div class="empty"><h3>No items yet</h3>
          <p>Upload a bill above, or add the items yourself.</p></div>`;
      } else {
        linesHost.innerHTML = table(state.lines, [
          {
            key: 'description',
            label: 'Product',
            render: (l, i) => `
              <strong>${esc(l.description)}</strong>
              <div class="small ${l.productId ? 'muted' : 'error'}">
                ${l.productId
    ? `Matched: ${esc(l.matchName)}${l.matchScore ? ` (${Math.round(l.matchScore * 100)}% match)` : ''}`
    : 'New product - will be created on confirmation'}
                <button type="button" class="btn small ghost" data-rematch="${i}">change</button>
              </div>
              ${l.warnings && l.warnings.length ? `<div class="small" style="color:var(--warn)">⚠ ${esc(l.warnings.join(', '))}</div>` : ''}`,
          },
          { key: 'hsn', label: 'HSN', render: (l, i) => `<input style="width:96px" data-field="hsn" data-i="${i}" value="${esc(l.hsn || '')}">` },
          { key: 'qty', label: 'Qty', num: true, render: (l, i) => `<input type="number" step="1" style="width:74px" data-field="qty" data-i="${i}" value="${l.qty}">` },
          { key: 'unitPrice', label: 'Rate', num: true, render: (l, i) => `<input type="number" step="0.01" style="width:100px" data-field="unitPrice" data-i="${i}" value="${l.unitPrice}">` },
          { key: 'gstRate', label: 'GST %', num: true, render: (l, i) => `<input type="number" step="0.01" style="width:78px" data-field="gstRate" data-i="${i}" value="${l.gstRate ?? 18}">` },
          { key: 'total', label: 'Total', num: true, render: (l) => money(l.qty * l.unitPrice * (1 + (l.gstRate ?? 18) / 100)) },
          { key: 'serials', label: 'Serials', render: (l, i) => `<button type="button" class="btn small" data-serials="${i}">${l.serials && l.serials.length ? `${l.serials.length} ✓` : 'Add'}</button>` },
          { key: 'remove', label: '', render: (l, i) => `<button type="button" class="btn small ghost" data-remove="${i}">✕</button>` },
        ], { clickable: false, stacked: false });
      }

      linesHost.querySelectorAll('[data-field]').forEach((input) => {
        input.addEventListener('change', () => {
          const line = state.lines[Number(input.dataset.i)];
          const field = input.dataset.field;
          line[field] = input.type === 'number' ? Number(input.value) : input.value.trim();
          setTimeout(renderLines, 0);
        });
      });
      linesHost.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
        state.lines.splice(Number(btn.dataset.remove), 1);
        renderLines();
      }));
      linesHost.querySelectorAll('[data-rematch]').forEach((btn) => btn.addEventListener('click',
        () => rematch(Number(btn.dataset.rematch))));
      linesHost.querySelectorAll('[data-serials]').forEach((btn) => btn.addEventListener('click',
        () => editSerials(Number(btn.dataset.serials))));

      const flagged = state.lines.filter((l) => l.warnings && l.warnings.length).length;
      const total = state.lines.reduce((s, l) => s + l.qty * l.unitPrice * (1 + (l.gstRate ?? 18) / 100), 0);
      view.querySelector('#summary').innerHTML = `${plural(state.lines.length, 'item')} · total ${money(total)}`
        + (flagged ? ` · <span style="color:var(--amber);font-weight:600">${plural(flagged, 'item')} to verify</span>` : '');
    }

    async function rematch(index) {
      const line = state.lines[index];
      const chosen = await modal({
        title: `Match "${line.description}"`,
        confirmLabel: '',
        cancelLabel: 'Close',
        body: `<div id="rematch-pick"></div>
          <p class="muted small" style="margin-top:10px">Or leave it unmatched to create a new product when you confirm.</p>
          <button class="btn" id="make-new">Create as new product</button>`,
        onRender: (root, close) => {
          productSearch(root.querySelector('#rematch-pick'), (product) => close(product),
            { keepText: true, createOptions: { stockNote: 'How many you already have on the shelf, '
              + 'not counting this supplier bill.' } });
          root.querySelector('#make-new').addEventListener('click', () => close('new'));
        },
      });
      if (!chosen) return;
      if (chosen === 'new') {
        line.productId = null;
        line.matchName = '';
        line.warnings = (line.warnings || []).filter((w) => w !== 'No matching product found');
      } else {
        line.productId = chosen.id;
        line.matchName = chosen.name;
        line.matchScore = 1;
        line.hsn = line.hsn || chosen.hsn_code || '';
        line.gstRate = line.gstRate ?? chosen.gst_rate;
        line.warnings = [];
      }
      renderLines();
    }

    async function editSerials(index) {
      const line = state.lines[index];
      const value = await modal({
        title: `Serial numbers - ${line.description}`,
        confirmLabel: 'Save',
        body: `<p class="muted small">One serial per line. Enter exactly ${line.qty}, or none.</p>
          <textarea name="serials" rows="6">${esc((line.serials || []).join('\n'))}</textarea>`,
        onConfirm: (root) => root.querySelector('[name=serials]').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
      });
      if (value) {
        if (value.length && value.length !== Number(line.qty)) {
          toast(`This line has ${line.qty} unit(s) but ${value.length} serial(s).`, 'error');
          return;
        }
        line.serials = value;
        renderLines();
      }
    }

    view.querySelector('#add-line').addEventListener('click', () => {
      const picker = view.querySelector('#line-picker');
      picker.classList.remove('hidden');
      productSearch(picker, (product) => {
        state.lines.push({
          description: product.name, productId: product.id, matchName: product.name, matchScore: 1,
          hsn: product.hsn_code || '', qty: 1, unitPrice: product.purchase_price, gstRate: product.gst_rate,
          serials: [], warnings: [],
        });
        picker.classList.add('hidden');
        renderLines();
      }, { label: 'Search product to add' });
      picker.querySelector('input').focus();
    });

    // ---- Upload & review ----
    view.querySelector('#scan').addEventListener('click', async () => {
      const input = view.querySelector('#file');
      const status = view.querySelector('#scan-status');
      if (!input.files.length) { toast('Choose at least one invoice file first.', 'error'); return; }
      status.innerHTML = `<div class="card" style="margin:0">
        <div class="pad">
          <div style="font-weight:600">Reading ${plural(input.files.length, 'invoice')}…</div>
          <div class="small muted">This usually takes a few seconds.</div>
          <ol class="steps" style="flex-direction:column;align-items:flex-start;margin-top:12px">
            <li class="done"><span class="mark">✓</span>Uploading</li>
            <li class="now"><span class="mark">•</span>Reading the bill</li>
            <li><span class="mark"></span>Matching products</li>
            <li><span class="mark"></span>Preparing the review</li>
          </ol>
        </div></div>`;
      const form = new FormData();
      [...input.files].forEach((file) => form.append('files', file));
      try {
        const data = await window.api.post('/api/purchases/extract', form);
        state.queue = (data.results || [data]).filter((r) => r.ok);
        const failed = (data.results || [data]).filter((r) => !r.ok);
        state.queueIndex = 0;
        if (!state.queue.length) {
          status.innerHTML = failed.map((f) => `<div class="alert warn"><span class="glyph">!</span>
            <div><strong>We couldn't read ${esc(f.fileName)}.</strong><br>${esc(f.message)}</div></div>`).join('');
          return;
        }
        status.innerHTML = failed.map((f) => `<div class="alert warn"><span class="glyph">!</span>
          <div><strong>We couldn't read ${esc(f.fileName)}.</strong><br>${esc(f.message)}</div></div>`).join('');
        loadFromQueue();
      } catch (err) {
        status.innerHTML = `<div class="alert error"><span class="glyph">!</span>
          <div><strong>${esc(err.message)}</strong><br>Nothing was saved.</div></div>`;
      }
    });

    /** Load the queued invoice at state.queueIndex into the form for review. */
    function loadFromQueue() {
      const status = view.querySelector('#scan-status');
      const result = state.queue[state.queueIndex];
      const flagged = result.items.filter((i) => (i.needsVerification || []).length).length;
      const position = state.queue.length > 1
        ? `<div class="alert info"><span class="glyph">i</span>
             <div>Invoice ${state.queueIndex + 1} of ${state.queue.length}: <strong>${esc(result.fileName)}</strong>.
             Confirm it to move on to the next.</div></div>` : '';
      status.innerHTML = position
        + (flagged
    ? `<div class="alert warn"><span class="glyph">!</span>
         <div><strong>Please verify ${plural(flagged, 'item')}.</strong>
         We couldn't read every detail confidently — the marked rows need a look.</div></div>`
    : `<div class="alert success"><span class="glyph">✓</span>
         <div>Invoice read. Check the ${plural(result.items.length, 'item')} below before confirming.</div></div>`)
        + (result.warnings || []).map((w) => `<div class="alert warn"><span class="glyph">!</span><div>${esc(w)}</div></div>`).join('');

      state.fileName = result.fileName;
      applyHeader(result.header || {});
      state.lines = result.items.map((item) => ({
        description: item.description,
        productId: item.match ? item.match.productId : null,
        matchName: item.match ? item.match.name : '',
        matchScore: item.match ? item.match.score : 0,
        hsn: item.hsn || (item.match && item.match.hsn_code) || '',
        qty: item.qty,
        unitPrice: item.unitPrice,
        gstRate: item.gstRate ?? 18,
        serials: [],
        warnings: (item.needsVerification || []).map(warningLabel),
      }));
      renderLines();
      view.querySelector('#lines').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function applyHeader(header) {
      if (header.invoiceNo) view.querySelector('[name=supplier_invoice_no]').value = header.invoiceNo;
      if (header.invoiceDate) view.querySelector('[name=invoice_date]').value = header.invoiceDate;
      if (header.supplierMatch) {
        state.supplierId = header.supplierMatch.supplierId;
        state.supplierName = header.supplierMatch.name;
        view.querySelector('#supplier-pick input').value = header.supplierMatch.name;
      } else if (header.supplier) {
        state.supplierId = null;
        state.supplierName = header.supplier;
        view.querySelector('#supplier-pick input').value = header.supplier;
      }
    }

    view.querySelector('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.lines.length) { toast('Add at least one item.', 'error'); return; }
      const values = formValues(e.target);
      const unmatched = state.lines.filter((l) => !l.productId);
      if (unmatched.length) {
        const ok = await window.ui.confirm('Create new products?',
          `${unmatched.length} item(s) do not match an existing product and will be created as new products: `
          + `${unmatched.map((l) => l.description).join(', ')}.`, 'Create and continue');
        if (!ok) return;
      }
      try {
        const res = await window.api.post('/api/purchases', {
          supplier_id: state.supplierId,
          supplier_name: state.supplierId ? '' : (view.querySelector('#supplier-pick input').value.trim() || state.supplierName),
          supplier_invoice_no: values.supplier_invoice_no,
          invoice_date: values.invoice_date,
          notes: values.notes,
          source: state.fileName ? 'SCAN' : 'MANUAL',
          file_name: state.fileName,
          items: state.lines.map((l) => ({
            product_id: l.productId || undefined,
            description: l.description,
            hsn_code: l.hsn,
            qty: l.qty,
            unit_price: l.unitPrice,
            gst_rate: l.gstRate,
            serials: l.serials,
            needs_review: !!(l.warnings && l.warnings.length),
            new_product: l.productId ? undefined : { name: l.description, hsn_code: l.hsn, gst_rate: l.gstRate },
          })),
        });
        toast(`Purchase ${res.purchaseNo} confirmed. Inventory updated.`);
        if (state.queueIndex + 1 < state.queue.length) {
          state.queueIndex += 1;
          state.lines = [];
          state.supplierId = null;
          view.querySelector('#supplier-pick input').value = '';
          loadFromQueue();
          return;
        }
        view.innerHTML = `<div class="card done-panel">
          <div class="glyph ok">✓</div>
          <h2>${plural(res.units, 'unit')} added to inventory</h2>
          <p>Purchase ${esc(res.purchaseNo)} is saved and stock levels are updated.</p>
          <div class="btn-row" style="justify-content:center">
            <a href="#/purchases/${res.purchaseId}">View purchase</a>
            <a href="#/purchases/add">Add more stock</a>
            <a href="#/inventory/list">Go to Inventory</a>
          </div>
        </div>`;
      } catch (err) { errorToast(err); }
    });

    renderLines();
  }

  const WARNING_LABELS = {
    NO_PRODUCT_MATCH: 'No matching product found',
    LOW_CONFIDENCE_MATCH: 'Low confidence match - please check',
    HSN_NOT_IDENTIFIED: 'HSN could not be confidently identified',
    PRICE_NOT_IDENTIFIED: 'Purchase price could not be read',
  };
  const warningLabel = (code) => WARNING_LABELS[code] || code;

  window.Pages = window.Pages || {};
  window.Pages.purchases = { history, detail, add };
})();
