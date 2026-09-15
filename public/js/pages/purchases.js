/* Purchases: history, and the upload → extract → match → review → confirm flow. */
(function () {
  'use strict';
  const {
    esc, money, qty, date, dateTime, table, loading, statusTag, toast, errorToast, modal,
    productSearch, partySearch, formValues, todayIso,
  } = window.ui;

  const tabs = (active) => `
    <div class="tabs">
      <a href="#/purchases" class="${active === 'history' ? 'active' : ''}">Purchase History</a>
      <a href="#/purchases/add" class="${active === 'add' ? 'active' : ''}">Add Purchase</a>
    </div>`;

  async function history(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Purchases</h1><p class="muted">Stock coming in from suppliers.</p></div>
        <div class="actions"><a class="btn primary" href="#/purchases/add">+ Add Purchase</a></div></div>
      ${tabs('history')}
      <div class="card"><div class="filters">
        <label class="grow">Search<input type="search" id="q" placeholder="Purchase no, supplier invoice or supplier"></label>
        <label>From<input type="date" id="from"></label>
        <label>To<input type="date" id="to"></label>
      </div></div>
      <div class="card" id="list">${loading()}</div>`;

    const load = async () => {
      const { purchases } = await window.api.get('/api/purchases', {
        q: view.querySelector('#q').value.trim(),
        from: view.querySelector('#from').value,
        to: view.querySelector('#to').value,
      });
      view.querySelector('#list').innerHTML = table(purchases, [
        { key: 'purchase_no', label: 'Purchase No', render: (r) => `<strong>${esc(r.purchase_no)}</strong>` },
        { key: 'invoice_date', label: 'Date', render: (r) => date(r.invoice_date) },
        { key: 'supplier_name', label: 'Supplier', render: (r) => esc(r.supplier_name || '-') },
        { key: 'supplier_invoice_no', label: 'Supplier Invoice', render: (r) => esc(r.supplier_invoice_no || '-') },
        { key: 'item_count', label: 'Items', num: true },
        { key: 'source', label: 'Source', render: (r) => `<span class="tag ${r.source === 'SCAN' ? 'blue' : ''}">${esc(r.source)}</span>` },
        { key: 'total', label: 'Total', num: true, render: (r) => money(r.total) },
        { key: 'view', label: '', render: (r) => `<button class="btn small" data-view="${r.id}">View</button>` },
      ], { empty: 'No purchases recorded yet.' });

      view.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showPurchase(b.dataset.view)));
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    ['#from', '#to'].forEach((s) => view.querySelector(s).addEventListener('change', load));
    await load();
  }

  async function showPurchase(id) {
    const { purchase, items } = await window.api.get(`/api/purchases/${id}`);
    modal({
      title: `${purchase.purchase_no} · ${purchase.supplier_name || 'No supplier'}`,
      wide: true,
      confirmLabel: '',
      cancelLabel: 'Close',
      body: `
        <div class="grid cols-3" style="margin-bottom:12px">
          <div><div class="small muted">Supplier Invoice</div><strong>${esc(purchase.supplier_invoice_no || '-')}</strong></div>
          <div><div class="small muted">Invoice Date</div><strong>${date(purchase.invoice_date)}</strong></div>
          <div><div class="small muted">Recorded</div><strong>${dateTime(purchase.created_at)} by ${esc(purchase.created_by_name || '-')}</strong></div>
        </div>
        ${table(items, [
        { key: 'product_name', label: 'Product' },
        { key: 'hsn_code', label: 'HSN' },
        { key: 'qty', label: 'Qty', num: true },
        { key: 'unit_price', label: 'Rate', num: true, render: (r) => money(r.unit_price) },
        { key: 'gst_rate', label: 'GST', num: true, render: (r) => `${r.gst_rate}%` },
        { key: 'total', label: 'Total', num: true, render: (r) => money(r.total) },
      ])}
        <p class="right" style="margin-top:10px">Subtotal ${money(purchase.subtotal)} · GST ${money(purchase.gst_amount)} ·
          <strong>Total ${money(purchase.total)}</strong></p>`,
    });
  }

  // ---------- Add purchase: scan or manual ----------
  async function add(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Add Purchase</h1>
        <p class="muted">Upload a supplier invoice and review what was read, or enter the items yourself.</p></div></div>
      ${tabs('add')}

      <div class="card">
        <div class="card-head"><h2>1. Upload supplier invoice (optional)</h2></div>
        <div class="filters">
          <label class="grow">Invoice file
            <input type="file" id="file" accept=".pdf,.txt,.csv,.tsv,image/*">
          </label>
          <button class="btn primary" id="scan">Read Invoice</button>
        </div>
        <p class="small muted" style="margin-top:8px">
          PDFs with a text layer, CSV and text invoices are read automatically. A photo or scan of a paper invoice has no
          text to read - the form below stays available for manual entry. Nothing is added to inventory until you confirm.
        </p>
        <div id="scan-status"></div>
      </div>

      <form class="card" id="form">
        <div class="card-head"><h2>2. Purchase details</h2></div>
        <div id="supplier-pick"></div>
        <div class="form-grid" style="margin-top:10px">
          <label>Supplier Invoice No<input name="supplier_invoice_no"></label>
          <label>Invoice Date<input name="invoice_date" type="date" value="${todayIso()}"></label>
          <label class="full">Notes<input name="notes"></label>
        </div>

        <div class="card-head" style="margin-top:18px"><h2>3. Items</h2>
          <div class="actions"><button type="button" class="btn small" id="add-line">+ Add item</button></div></div>
        <div id="lines"></div>
        <div id="line-picker" class="hidden" style="margin-top:10px"></div>

        <div class="btn-row" style="margin-top:16px">
          <button class="btn success" type="submit" id="confirm">Confirm &amp; Add to Inventory</button>
          <span class="muted small" id="summary"></span>
        </div>
      </form>`;

    const state = { supplierId: null, supplierName: '', lines: [], fileName: '' };

    partySearch(view.querySelector('#supplier-pick'), 'suppliers', (s) => {
      state.supplierId = s.id;
      state.supplierName = s.name;
    });

    const linesHost = view.querySelector('#lines');

    function renderLines() {
      if (!state.lines.length) {
        linesHost.innerHTML = '<div class="empty">No items yet. Upload an invoice above or add items manually.</div>';
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
        ]);
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
      view.querySelector('#summary').innerHTML = `${state.lines.length} item(s) · total ${money(total)}`
        + (flagged ? ` · <span style="color:var(--warn)">⚠ ${flagged} need verification</span>` : '');
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
          productSearch(root.querySelector('#rematch-pick'), (product) => close(product), { keepText: true });
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
      if (!input.files.length) { toast('Choose an invoice file first.', 'error'); return; }
      status.innerHTML = '<div class="alert info">Reading the invoice…</div>';
      const form = new FormData();
      form.append('file', input.files[0]);
      try {
        const result = await window.api.post('/api/purchases/extract', form);
        state.fileName = result.fileName || input.files[0].name;
        if (!result.ok) {
          status.innerHTML = `<div class="alert warn">⚠ ${esc(result.message)}</div>`;
          applyHeader(result.header || {});
          return;
        }
        status.innerHTML = `<div class="alert success">Invoice read. Review the ${result.items.length} item(s) below before confirming.</div>
          ${(result.warnings || []).map((w) => `<div class="alert warn">⚠ ${esc(w)}</div>`).join('')}`;
        applyHeader(result.header);
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
      } catch (err) {
        status.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      }
    });

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
            new_product: l.productId ? undefined : { name: l.description, hsn_code: l.hsn, gst_rate: l.gstRate },
          })),
        });
        toast(`Purchase ${res.purchaseNo} confirmed. Inventory updated.`, 'success');
        window.location.hash = '#/purchases';
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
  window.Pages.purchases = { history, add };
})();
