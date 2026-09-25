/* Sales: create an invoice, the invoice itself, history and returns. */
(function () {
  'use strict';
  const {
    esc, money, rupees, plural, qty, date, dateTime, table, loading, skeleton, statusTag, toast, errorToast,
    modal, confirm, productSearch, partySearch, todayIso, rupeesInWords, pageHead, wireLinks,
    moreMenu, wireMenus,
  } = window.ui;

  const SEARCH_ICON = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4A4843"
    stroke-width="1.8" stroke-linecap="round"><path d="M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3"/></svg>`;

  async function create(view, invoiceId) {
    view.innerHTML = `
      ${pageHead({
    title: invoiceId ? 'Edit Draft Invoice' : 'New Invoice',
    sub: 'Choose the customer and products. Prices, HSN and GST fill in by themselves.',
    actions: `<span class="muted" id="invoice-meta">${date(todayIso())}</span>`,
  })}
      <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start">
        <div style="flex:2 1 480px;min-width:0;display:flex;flex-direction:column;gap:20px">
          <section class="card" style="margin:0">
            <div class="pad">
              <div id="customer-pick"></div>
              <div id="customer-info" class="autofill" style="margin-top:12px" hidden></div>
            </div>
          </section>

          <section class="card" style="margin:0">
            <div class="pad">
              <div id="product-pick"></div>
            </div>
            <div id="lines" class="pad" style="padding-top:0"></div>
          </section>

          <section class="card" style="margin:0">
            <div class="card-head"><h2>Invoice details</h2></div>
            <div class="pad">
              <div class="form-grid">
                <label>Invoice date<input name="invoice_date" type="date" value="${todayIso()}"></label>
                <label>Payment<select name="payment_mode">
                  <option>CASH</option><option>UPI</option><option>CARD</option>
                  <option>BANK TRANSFER</option><option>CREDIT</option>
                </select></label>
                <label>Payment status<select name="payment_status">
                  <option>PAID</option><option>UNPAID</option><option>PARTIAL</option></select></label>
                <label>Terms<input name="payment_terms" list="terms-list" placeholder="Due on Receipt">
                  <datalist id="terms-list"><option>Due on Receipt</option><option>Net 15</option>
                    <option>Net 30</option><option>Net 45</option></datalist></label>
                <label>Due date<input name="due_date" type="date"></label>
                <label class="full">Ship to <span class="opt">(leave blank to use the customer's address)</span>
                  <input name="ship_to_address" placeholder="Delivery address"></label>
                <label class="full">Product brief <span class="opt">(printed under the items)</span>
                  <textarea name="product_brief" rows="2"></textarea></label>
                <label class="full">Notes <span class="opt">(optional)</span><input name="notes"></label>
              </div>
            </div>
          </section>
        </div>

        <aside class="card summary" style="flex:1 1 300px;min-width:280px;margin:0">
          <div class="card-head"><h2>Summary</h2></div>
          <div class="pad">
            <div id="totals"></div>
            <div class="hint" id="price-mode" style="margin-bottom:12px"></div>
            <div id="stock-note"></div>
            <button class="btn primary block tall" id="issue">Issue Invoice</button>
            <p class="hint center">Issuing reduces stock straight away.</p>
            <div class="center"><button class="link-btn" id="save-draft">Save as draft</button></div>
          </div>
        </aside>
      </div>`;

    const state = { customer: null, lines: [], invoiceId: invoiceId || null };

    partySearch(view.querySelector('#customer-pick'), 'customers', (c) => {
      state.customer = c;
      const box = view.querySelector('#customer-info');
      box.hidden = false;
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div>
            <div style="font-weight:600">${esc(c.name)}</div>
            <div class="small muted">${esc(c.phone || 'No phone')}${c.gstin ? ` · GSTIN ${esc(c.gstin)}` : ''}
              · ${plural(c.transactions || 0, 'previous invoice')}</div>
          </div>
          <button class="link-btn" id="clear-customer">Change</button>
        </div>`;
      box.querySelector('#clear-customer').addEventListener('click', () => {
        state.customer = null;
        box.hidden = true;
        view.querySelector('#customer-pick input').value = '';
        renderTotals();
      });
      renderTotals();
    }, { label: 'Customer' });

    productSearch(view.querySelector('#product-pick'), (product) => addLine(product),
      { label: 'Add product', placeholder: 'Search product, model or scan a barcode…' });

    function addLine(product) {
      const existing = state.lines.find((l) => l.product.id === product.id);
      if (existing) { existing.qty += 1; }
      else state.lines.push({ product, qty: 1, unitPrice: product.selling_price, discount: 0, serials: [] });
      renderLines();
    }

    // Mirrors server/lib/gst.js: the rate either includes GST or has it added.
    const inclusive = () => !!(window.api.state.business && window.api.state.business.price_includes_gst);

    function lineTotals(l) {
      const gross = l.qty * l.unitPrice;
      const net = Math.max(gross - l.discount, 0);
      const rate = Number(l.product.gst_rate) || 0;
      if (inclusive()) {
        const taxable = net / (1 + rate / 100);
        return { gross, taxable, gst: net - taxable, total: net };
      }
      const gst = net * rate / 100;
      return { gross, taxable: net, gst, total: net + gst };
    }

    function renderLines() {
      const host = view.querySelector('#lines');
      if (!state.lines.length) {
        host.innerHTML = '<div class="empty" style="padding:28px 8px"><h3>No products yet</h3>'
          + '<p>Search above to add the first item.</p></div>';
        renderTotals();
        return;
      }

      host.innerHTML = `<div class="line-list">${state.lines.map((l, i) => {
    const totals = lineTotals(l);
    const short = l.qty > l.product.stock;
    return `<div class="line-item">
          <div class="top">
            <div class="grow">
              <div class="name">${esc(l.product.name)}</div>
              <div class="meta">HSN ${esc(l.product.hsn_code || '—')} · GST ${l.product.gst_rate}%
                · ${qty(l.product.stock)} in stock</div>
            </div>
            <div class="stepper-input">
              <button type="button" data-step="-1" data-i="${i}" aria-label="Decrease">−</button>
              <input type="number" min="1" step="1" data-field="qty" data-i="${i}" value="${l.qty}">
              <button type="button" data-step="1" data-i="${i}" aria-label="Increase">+</button>
            </div>
            <div class="amount">${money(totals.total)}
              <div class="meta">${money(l.unitPrice)} each</div></div>
            <button type="button" class="link-btn quiet" data-remove="${i}">Remove</button>
          </div>
          ${short ? `<div class="field-error">Only ${plural(l.product.stock, 'unit')} available.</div>` : ''}
          <div class="form-grid" style="margin-top:12px">
            <label class="small">Rate<input type="number" step="0.01" data-field="unitPrice" data-i="${i}" value="${l.unitPrice}"></label>
            ${window.api.can('discount')
    ? `<label class="small">Discount<input type="number" step="0.01" data-field="discount" data-i="${i}" value="${l.discount}"></label>`
    : ''}
          </div>
          ${l.product.serial_tracked ? `<div style="margin-top:10px">
            <button type="button" class="link-btn" data-serials="${i}">
              ${l.serials.length ? `${plural(l.serials.length, 'serial number')} chosen` : 'Choose serial numbers'}</button>
            ${l.serials.length ? `<div class="small muted">${esc(l.serials.join(', '))}</div>` : ''}
          </div>` : ''}
        </div>`;
  }).join('')}</div>`;

      host.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('change', () => {
        const line = state.lines[Number(input.dataset.i)];
        line[input.dataset.field] = Number(input.value) || 0;
        setTimeout(renderLines, 0);
      }));
      host.querySelectorAll('[data-step]').forEach((btn) => btn.addEventListener('click', () => {
        const line = state.lines[Number(btn.dataset.i)];
        line.qty = Math.max(1, line.qty + Number(btn.dataset.step));
        renderLines();
      }));
      host.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
        state.lines.splice(Number(btn.dataset.remove), 1);
        renderLines();
      }));
      host.querySelectorAll('[data-serials]').forEach((btn) => btn.addEventListener('click',
        () => pickSerials(Number(btn.dataset.serials))));
      renderTotals();
    }

    async function pickSerials(index) {
      const line = state.lines[index];
      const { serials } = await window.api.get('/api/inventory/serials', {
        productId: line.product.id, status: 'AVAILABLE', limit: 500,
      });
      const chosen = await modal({
        title: `Select ${line.qty} serial number(s) - ${line.product.name}`,
        confirmLabel: 'Use selected',
        body: serials.length
          ? `<p class="muted small">${serials.length} available. Click to select, or scan into the box.</p>
             <input id="scan-serial" placeholder="Scan a serial number and press Enter">
             <div class="serial-chips" id="chips">
               ${serials.map((s) => `<span class="serial-chip ${line.serials.includes(s.serial) ? 'selected' : ''}" data-serial="${esc(s.serial)}">${esc(s.serial)}</span>`).join('')}
             </div>`
          : '<p class="alert warn">No available serial numbers for this product. Add stock with serials first.</p>',
        onRender: (root) => {
          const chips = root.querySelectorAll('.serial-chip');
          chips.forEach((chip) => chip.addEventListener('click', () => {
            const selected = root.querySelectorAll('.serial-chip.selected').length;
            if (!chip.classList.contains('selected') && selected >= line.qty) {
              toast(`This line sells ${line.qty} unit(s).`, 'warn');
              return;
            }
            chip.classList.toggle('selected');
          }));
          const scan = root.querySelector('#scan-serial');
          if (scan) {
            scan.addEventListener('keydown', (e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const value = scan.value.trim();
              const chip = [...chips].find((c) => c.dataset.serial.toLowerCase() === value.toLowerCase());
              if (chip) { chip.classList.add('selected'); scan.value = ''; }
              else toast(`Serial ${value} is not available for this product.`, 'error');
            });
            scan.focus();
          }
        },
        onConfirm: (root) => [...root.querySelectorAll('.serial-chip.selected')].map((c) => c.dataset.serial),
      });
      if (chosen) { line.serials = chosen; renderLines(); }
    }

    function renderTotals() {
      const totals = state.lines.reduce((acc, l) => {
        const t = lineTotals(l);
        acc.subtotal += t.taxable;
        acc.discount += l.discount;
        acc.gst += t.gst;
        acc.total += t.total;
        return acc;
      }, { subtotal: 0, discount: 0, gst: 0, total: 0 });

      const business = window.api.state.business;
      const interState = state.customer && state.customer.gstin && business && business.gstin
        && state.customer.gstin.slice(0, 2) !== business.gstin.slice(0, 2);
      const units = state.lines.reduce((sum, l) => sum + l.qty, 0);

      view.querySelector('#totals').innerHTML = `
        <div class="line"><span class="muted">Subtotal · ${plural(units, 'item')}</span>
          <span class="num">${money(totals.subtotal)}</span></div>
        ${totals.discount ? `<div class="line"><span class="muted">Discount</span>
          <span class="num">− ${money(totals.discount)}</span></div>` : ''}
        ${interState
    ? `<div class="line"><span class="muted">IGST</span><span class="num">${money(totals.gst)}</span></div>`
    : `<div class="line"><span class="muted">CGST</span><span class="num">${money(totals.gst / 2)}</span></div>
       <div class="line"><span class="muted">SGST</span><span class="num">${money(totals.gst / 2)}</span></div>`}
        <div class="total"><span>Total</span><span class="value">${rupees(totals.total)}</span></div>`;

      view.querySelector('#price-mode').textContent = inclusive()
        ? 'Rates include GST — the tax is backed out of the price.'
        : 'Rates exclude GST — the tax is added on top.';

      const short = state.lines.filter((l) => l.qty > l.product.stock);
      view.querySelector('#stock-note').innerHTML = short.length
        ? `<div class="alert error" style="margin-bottom:12px"><span class="glyph">!</span>
             <div>${plural(short.length, 'line')} more than you have in stock.</div></div>` : '';
    }

    const payload = (status) => ({
      status,
      customer_id: state.customer ? state.customer.id : null,
      invoice_date: view.querySelector('[name=invoice_date]').value,
      payment_mode: view.querySelector('[name=payment_mode]').value,
      payment_status: view.querySelector('[name=payment_status]').value,
      payment_terms: view.querySelector('[name=payment_terms]').value,
      due_date: view.querySelector('[name=due_date]').value,
      ship_to_address: view.querySelector('[name=ship_to_address]').value,
      product_brief: view.querySelector('[name=product_brief]').value,
      notes: view.querySelector('[name=notes]').value,
      items: state.lines.map((l) => ({
        product_id: l.product.id, qty: l.qty, unit_price: l.unitPrice, discount: l.discount, serials: l.serials,
      })),
    });

    /** Save the draft, attach serial selections, then optionally issue it. */
    async function save(issue) {
      if (!state.lines.length) { toast('Add at least one product.', 'error'); return; }
      try {
        const saved = state.invoiceId
          ? await window.api.put(`/api/invoices/${state.invoiceId}`, payload('DRAFT'))
          : await window.api.post('/api/invoices', payload('DRAFT'));
        state.invoiceId = saved.invoice.id;

        for (let i = 0; i < state.lines.length; i += 1) {
          if (state.lines[i].serials.length) {
            await window.api.post(`/api/invoices/${state.invoiceId}/serials`, {
              item_id: saved.items[i].id, serials: state.lines[i].serials,
            });
          }
        }
        if (!issue) {
          toast(`Draft ${saved.invoice.invoice_no} saved. Inventory is unchanged.`, 'success');
          window.location.hash = `#/sales/invoice/${state.invoiceId}`;
          return;
        }
        await window.api.post(`/api/invoices/${state.invoiceId}/issue`, {});
        toast(`Invoice ${saved.invoice.invoice_no} issued. Inventory updated.`, 'success');
        window.location.hash = `#/sales/invoice/${state.invoiceId}`;
      } catch (err) {
        errorToast(err);
        if (err.details && err.details.available !== undefined) {
          toast(`Reduce the quantity to ${qty(err.details.available)} or add stock first.`, 'warn', 7000);
        }
      }
    }

    view.querySelector('#save-draft').addEventListener('click', () => save(false));
    view.querySelector('#issue').addEventListener('click', () => save(true));

    if (invoiceId) {
      const data = await window.api.get(`/api/invoices/${invoiceId}`);
      if (data.invoice.status !== 'DRAFT') { window.location.hash = `#/sales/invoice/${invoiceId}`; return; }
      if (data.invoice.customer_id) {
        const { record } = await window.api.get(`/api/customers/${data.invoice.customer_id}`);
        state.customer = record;
        view.querySelector('#customer-pick input').value = record.name;
      }
      view.querySelector('[name=invoice_date]').value = data.invoice.invoice_date;
      view.querySelector('[name=notes]').value = data.invoice.notes || '';
      view.querySelector('[name=payment_terms]').value = data.invoice.payment_terms || '';
      view.querySelector('[name=due_date]').value = data.invoice.due_date || '';
      view.querySelector('[name=ship_to_address]').value = data.invoice.ship_to_address || '';
      view.querySelector('[name=product_brief]').value = data.invoice.product_brief || '';
      for (const item of data.items) {
        const { product } = await window.api.get(`/api/products/${item.product_id}`);
        state.lines.push({
          product, qty: item.qty, unitPrice: item.unit_price, discount: item.discount, serials: item.serials || [],
        });
      }
    }
    renderLines();
  }

  // ---------- Invoice history ----------
  async function history(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Invoice History',
    sub: "All invoices you've issued. Click one to view, print or share.",
    actions: '<a class="btn primary" href="#/sales/create">+ Create Invoice</a>',
  })}
      <div class="filters">
        <div class="search">${SEARCH_ICON}
          <input type="search" id="q" placeholder="Search invoice number or customer…" autocomplete="off"></div>
        <select id="period" aria-label="Date">
          <option value="month">This month</option>
          <option value="today">Today</option>
          <option value="last30">Last 30 days</option>
          <option value="all">Everything</option>
        </select>
        <select id="status" aria-label="Status">
          <option value="">All statuses</option>
          <option value="ISSUED">Issued</option>
          <option value="DRAFT">Draft</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </div>
      <div class="card" id="list">${skeleton(8)}</div>`;

    const load = async () => {
      const { from, to } = window.ui.range(view.querySelector('#period').value);
      const { invoices } = await window.api.get('/api/invoices', {
        q: view.querySelector('#q').value.trim(),
        status: view.querySelector('#status').value,
        from, to, limit: 200,
      });
      const list = view.querySelector('#list');
      list.innerHTML = invoices.length ? table(invoices, [
        { label: 'Invoice', class: 'doc', render: (r) => esc(r.invoice_no) },
        {
          label: 'Customer',
          render: (r) => `${esc(r.customer_name || 'Walk-in')}${r.customer_phone
    ? `<div class="sub">${esc(r.customer_phone)}</div>` : ''}`,
        },
        { label: 'Date', render: (r) => `<span class="muted nowrap">${date(r.invoice_date)}</span>` },
        { label: 'Amount', num: true, render: (r) => rupees(r.total) },
        { label: 'Status', noLabel: true, render: (r) => statusTag(r.status) },
        {
          label: '', noLabel: true,
          render: () => moreMenu([
            { label: 'View', action: 'view' },
            { label: 'Print', action: 'print' },
            { label: 'Download PDF', action: 'pdf' },
            { label: 'Share on WhatsApp', action: 'share' },
          ], '⋮'),
        },
      ], { rowAttrs: (r) => `data-id="${r.id}" data-no="${esc(r.invoice_no)}" data-total="${r.total}" data-href="#/sales/invoice/${r.id}"` })
        : `<div class="empty"><h3>No invoices found</h3>
            <p>Try the invoice number (e.g. ${esc(window.api.state.business ? `${window.api.state.business.invoice_prefix}-1024` : 'INV-1024')})
            or the customer's phone.</p>
            <a class="btn primary" href="#/sales/create">Create Invoice</a></div>`;

      wireLinks(list);
      wireMenus(list, {
        view: (row) => { window.location.hash = `#/sales/invoice/${row.dataset.id}`; },
        print: (row) => { window.location.hash = `#/sales/invoice/${row.dataset.id}`; setTimeout(() => window.print(), 900); },
        pdf: (row) => window.api.download(`/api/invoices/${row.dataset.id}/pdf`, {}, `${row.dataset.no}.pdf`),
        share: (row) => shareOnWhatsApp(row.dataset.no, Number(row.dataset.total)),
      });
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
    ['#status', '#period'].forEach((sel) => view.querySelector(sel).addEventListener('change', load));
    await load();
  }

  /** Open WhatsApp with the invoice summary ready to send. */
  function shareOnWhatsApp(invoiceNo, total, phone) {
    const business = window.api.state.business || {};
    const text = `${business.name || 'Invoice'}\nInvoice ${invoiceNo}\nTotal: ${rupees(total)}\nThank you for your business.`;
    const url = `https://wa.me/${phone ? String(phone).replace(/\D/g, '') : ''}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
  }

  // ---------- Invoice view ----------
  async function invoice(view, id) {
    view.innerHTML = loading();
    const { invoice: inv, items, business } = await window.api.get(`/api/invoices/${id}`);
    const qr = await window.api.get(`/api/invoices/${id}/qr`).catch(() => ({ dataUrl: null }));
    const interState = inv.igst > 0;
    const gstRate = items.length ? Number(items[0].gst_rate) : 18;
    const halfRate = Math.round((gstRate / 2) * 100) / 100;
    const unitsTotal = items.reduce((s, it) => s + Number(it.qty), 0);
    const bankLines = [
      business.bank_account_name ? `Account Name : ${business.bank_account_name}` : '',
      business.bank_account_no ? `A/c No : ${business.bank_account_no}` : '',
      business.bank_branch_ifsc ? `Br &amp; IFSC : ${business.bank_branch_ifsc}` : '',
      (!business.bank_account_name && business.bank_details) ? business.bank_details : '',
    ].filter(Boolean);

    view.innerHTML = `
      ${pageHead({
    title: `${esc(inv.invoice_no)} ${statusTag(inv.status)}`,
    sub: `${esc(inv.customer_name || 'Walk-in customer')} · ${date(inv.invoice_date)} · Paid by ${esc(inv.payment_mode || '—')}`,
    back: { href: '#/sales', label: 'Invoice History' },
    actions: `
      ${inv.status === 'DRAFT' ? '<button class="btn primary" id="issue">Issue Invoice</button>' : '<button class="btn primary" id="print">Print</button>'}
      ${moreMenu([
    ...(inv.status === 'DRAFT' ? [{ label: 'Edit draft', action: 'edit' }, { label: 'Print', action: 'print' }] : []),
    { label: 'Download PDF', action: 'pdf' },
    { label: 'Share on WhatsApp', action: 'share' },
    ...(inv.status === 'ISSUED' ? [{ label: 'Return items', action: 'return' }] : []),
    ...(inv.status !== 'CANCELLED' && window.api.can('cancel')
    ? [{ sep: true }, { label: 'Cancel invoice', action: 'cancel', danger: true }] : []),
  ])}`,
  })}

      ${inv.status === 'DRAFT' ? `<div class="alert warn"><span class="glyph">!</span>
        <div><strong>This is a draft.</strong> Nothing has left your stock yet — issue it when the sale is done.</div></div>` : ''}
      ${inv.status === 'CANCELLED' ? `<div class="alert error"><span class="glyph">!</span>
        <div><strong>Cancelled${inv.cancel_reason ? `: ${esc(inv.cancel_reason)}` : ''}.</strong> The stock went back on the shelf.</div></div>` : ''}

      <div class="invoice-sheet">
        <div class="inv-box inv-seller">
          <div>
            <div class="inv-business">${esc(business.name)}</div>
            <div class="small muted">${esc(business.address || '')}</div>
            <div class="small muted">${esc([business.phone, business.email].filter(Boolean).join('  |  '))}</div>
            ${business.gstin ? `<div class="small"><strong>GSTIN ${esc(business.gstin)}</strong></div>` : ''}
          </div>
          <div class="inv-title">${inv.status === 'CANCELLED' ? 'TAX INVOICE (CANCELLED)' : 'TAX INVOICE'}</div>
        </div>

        <div class="inv-box inv-split">
          <table class="inv-meta">
            <tr><th>Invoice No.</th><td>${esc(inv.invoice_no)}</td></tr>
            <tr><th>Invoice Date</th><td>${date(inv.invoice_date)}</td></tr>
            <tr><th>Terms</th><td>${esc(inv.payment_terms || business.default_payment_terms || 'Due on Receipt')}</td></tr>
            <tr><th>Due Date</th><td>${date(inv.due_date || inv.invoice_date)}</td></tr>
          </table>
          <table class="inv-meta">
            <tr><th>Place Of Supply</th><td>${esc(inv.place_of_supply || '-')}</td></tr>
            <tr><th>Payment</th><td>${esc(inv.payment_mode || '-')} (${esc(inv.payment_status || '-')})</td></tr>
          </table>
        </div>

        <div class="inv-box inv-split">
          <div>
            <div class="inv-label">Bill To</div>
            <strong>${esc(inv.customer_name || 'Walk-in Customer')}</strong>
            <div class="small muted">${esc(inv.customer_address || '')}</div>
            ${inv.customer_gstin ? `<div class="small"><strong>GSTIN ${esc(inv.customer_gstin)}</strong></div>` : ''}
          </div>
          <div>
            <div class="inv-label">Ship To</div>
            <strong>${esc(inv.ship_to_name || inv.customer_name || 'Walk-in Customer')}</strong>
            <div class="small muted">${esc(inv.ship_to_address || inv.customer_shipping_address || inv.customer_address || '')}</div>
            ${inv.customer_phone ? `<div class="small">Phone ${esc(inv.customer_phone)}</div>` : ''}
          </div>
        </div>

        <div class="table-wrap">
          <table class="inv-items">
            <thead>
              <tr>
                <th>#</th><th>Item &amp; Description</th><th>HSN</th>
                <th class="num">Qty</th><th class="num">Rate</th><th class="num">Total Incl GST</th>
                <th class="num">Taxable Amount</th>
                ${interState
    ? `<th class="num">${gstRate}% IGST<div class="small">Amount</div></th>`
    : `<th class="num">${halfRate}% CGST<div class="small">Amount</div></th>
                   <th class="num">${halfRate}% SGST<div class="small">Amount</div></th>`}
              </tr>
            </thead>
            <tbody>
              ${items.map((item, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>${esc(item.description)}
                    ${item.serials && item.serials.length ? `<div class="small muted">S/N: ${esc(item.serials.join(', '))}</div>` : ''}</td>
                  <td>${esc(item.hsn_code || '-')}</td>
                  <td class="num">${qty(item.qty)}</td>
                  <td class="num">${money(item.unit_price)}</td>
                  <td class="num">${money(item.total)}</td>
                  <td class="num">${money(item.taxable_value)}</td>
                  ${interState
    ? `<td class="num">${money(item.gst_amount)}</td>`
    : `<td class="num">${money(item.gst_amount / 2)}</td><td class="num">${money(item.gst_amount / 2)}</td>`}
                </tr>`).join('')}
              <tr class="inv-subtotal">
                <td></td><td>Sub Total</td><td></td><td></td><td></td>
                <td class="num">${money(inv.total)}</td>
                <td class="num">${money(inv.subtotal)}</td>
                ${interState
    ? `<td class="num">${money(inv.igst)}</td>`
    : `<td class="num">${money(inv.cgst)}</td><td class="num">${money(inv.sgst)}</td>`}
              </tr>
              <tr class="inv-grand">
                <td></td><td>Items Total ${qty(unitsTotal)}</td>
                <td colspan="${interState ? 4 : 5}"></td>
                <td class="num">Total</td>
                <td class="num"><strong>${money(inv.total)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

        ${inv.product_brief ? `<div class="inv-section"><div class="inv-label">Product Brief</div>
          <div class="small">${esc(inv.product_brief).replace(/\n/g, '<br>')}</div></div>` : ''}

        <div class="inv-section">
          <div class="inv-label">Total In words</div>
          <em>${esc(window.ui.rupeesInWords(inv.total))}</em>
        </div>

        <div class="inv-footer">
          <div>
            ${bankLines.length ? `<div class="inv-label">Bank Details</div>
              <div class="small muted">${bankLines.join('<br>')}</div>` : ''}
            ${inv.notes ? `<div class="small muted" style="margin-top:6px">Notes: ${esc(inv.notes)}</div>` : ''}
          </div>
          ${qr.dataUrl ? `<div class="qr-box"><img src="${qr.dataUrl}" alt="Invoice QR code">
            <div class="small muted">${qr.mode === 'PAYMENT_UPI' ? 'Scan to pay' : 'Scan for invoice details'}</div></div>` : ''}
          <div class="inv-sign">
            <strong>For ${esc(business.name)}</strong>
            <div class="inv-sign-space"></div>
            <div class="small muted">${esc(business.signatory_name || '')}</div>
            <div class="small">Authorized Signatory</div>
          </div>
        </div>

        ${business.terms ? `<div class="inv-section"><div class="inv-label">Terms and Conditions</div>
          <div class="small muted">${esc(business.terms).replace(/\n/g, '<br>')}</div></div>` : ''}
        ${business.declaration ? `<div class="inv-section"><div class="inv-label">Declaration</div>
          <div class="small muted">${esc(business.declaration)}</div></div>` : ''}
      </div>`;

    const pdfBtn = view.querySelector('#pdf');
    if (pdfBtn) pdfBtn.addEventListener('click',
      () => window.api.download(`/api/invoices/${id}/pdf`, {}, `${inv.invoice_no.replace(/\//g, '-')}.pdf`).catch(errorToast));
    const printBtn = view.querySelector('#print');
    if (printBtn) printBtn.addEventListener('click', () => window.print());

    const wireInvoiceMenu = () => wireMenus(view, {
      edit: () => { window.location.hash = `#/sales/create/${inv.id}`; },
      print: () => window.print(),
      pdf: () => window.api.download(`/api/invoices/${inv.id}/pdf`, {}, `${inv.invoice_no}.pdf`),
      share: () => shareOnWhatsApp(inv.invoice_no, inv.total, inv.customer_phone),
      return: () => { window.location.hash = '#/sales/returns/new'; },
      cancel: () => askCancel(),
    });

    const issueBtn = view.querySelector('#issue');
    if (issueBtn) {
      issueBtn.addEventListener('click', async () => {
        try {
          await window.api.post(`/api/invoices/${id}/issue`, {});
          toast('Invoice issued. Inventory updated.', 'success');
          invoice(view, id);
        } catch (err) { errorToast(err); }
      });
    }

    const askCancel = async () => {
      const reason = await modal({
        title: `Cancel invoice ${inv.invoice_no}?`,
        confirmLabel: 'Cancel Invoice',
        cancelLabel: 'Keep Invoice',
        danger: true,
        body: `<p>${inv.status === 'ISSUED'
          ? 'The items will go back into stock and any serial numbers are released. The invoice stays in your history marked as Cancelled.'
          : 'This draft will be marked cancelled.'}</p>
          <label>Reason<input name="reason" placeholder="Why is this being cancelled?"></label>`,
        onConfirm: (root) => root.querySelector('[name=reason]').value.trim() || 'Cancelled',
      });
      if (!reason) return;
      try {
        await window.api.post(`/api/invoices/${id}/cancel`, { reason });
        toast('Invoice cancelled and the stock is back on the shelf.');
        invoice(view, id);
      } catch (err) { errorToast(err); }
    };

    wireInvoiceMenu();
  }


  // ---------- Returns ----------
  async function returns(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Returns',
    sub: 'Items customers brought back. Returned stock goes back on the shelf.',
    actions: '<a class="btn primary" href="#/sales/returns/new">+ New Return</a>',
  })}
      <div class="card" id="list">${skeleton(6)}</div>`;

    const { returns: rows } = await window.api.get('/api/returns', { limit: 100 });
    const list = view.querySelector('#list');
    list.innerHTML = rows.length ? table(rows, [
      { label: 'Return #', class: 'doc', render: (r) => esc(r.return_no) },
      { label: 'Invoice', render: (r) => esc(r.invoice_no) },
      { label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
      {
        label: 'Product',
        render: (r) => esc(r.items.map((i) => `${i.product_name} ×${qty(i.qty)}`).join(', ')),
      },
      { label: 'Reason', render: (r) => `<span class="muted">${esc(r.reason || '—')}</span>` },
      { label: 'Value', num: true, render: (r) => rupees(r.total) },
      {
        label: 'Stock',
        render: (r) => (r.restock ? '<span class="tag green">Back on shelf</span>' : '<span class="tag red">Written off</span>'),
      },
      { label: 'Date', render: (r) => `<span class="muted nowrap">${date(r.return_date)}</span>` },
    ], { rowAttrs: (r) => `data-href="#/sales/invoice/${r.invoice_id}"` })
      : `<div class="empty"><h3>No returns yet</h3>
          <p>When a customer brings something back, record it here and the stock goes up again.</p>
          <a class="btn primary" href="#/sales/returns/new">+ New Return</a></div>`;
    wireLinks(list);
  }

  /** New return: find the invoice, choose what came back, confirm. */
  async function newReturn(view) {
    view.innerHTML = `
      <div style="max-width:820px">
        ${pageHead({
    title: 'New Return',
    sub: 'Find the original invoice, then say what is coming back.',
    back: { href: '#/sales/returns', label: 'Returns' },
  })}
        <ol class="steps" id="steps"></ol>
        <div class="card">
          <div class="pad">
            <label>Find the original invoice
              <input id="invoice-no" placeholder="Invoice number, e.g. ${esc(window.api.state.business ? window.api.state.business.invoice_prefix : 'INV')}-1024"
                list="recent-invoices" autocomplete="off">
              <datalist id="recent-invoices"></datalist>
            </label>
            <div class="btn-row" style="margin-top:12px">
              <button class="btn primary" id="find">Find Invoice</button>
            </div>
            <div id="found"></div>
          </div>
        </div>
      </div>`;

    const setStep = (current) => {
      view.querySelector('#steps').innerHTML = [
        'Find the invoice', 'Choose what came back', 'Confirm',
      ].map((label, i) => `<li class="${i < current ? 'done' : ''} ${i === current ? 'now' : ''}">
          <span class="mark">${i < current ? '✓' : i + 1}</span>${label}</li>`).join('');
    };
    setStep(0);

    window.api.get('/api/invoices', { status: 'ISSUED', limit: 30 }).then(({ invoices }) => {
      view.querySelector('#recent-invoices').innerHTML = invoices
        .map((i) => `<option value="${esc(i.invoice_no)}">${esc(i.customer_name || 'Walk-in')} · ${money(i.total)}</option>`).join('');
    });

    view.querySelector('#find').addEventListener('click', async () => {
      const no = view.querySelector('#invoice-no').value.trim();
      const host = view.querySelector('#found');
      if (!no) { toast('Enter an invoice number.', 'error'); return; }
      host.innerHTML = skeleton(3);
      try {
        const { invoice: inv, items, customer } = await window.api.get(`/api/returns/invoice/${encodeURIComponent(no)}`);
        const returnable = items.filter((i) => i.returnable > 0);
        setStep(1);
        host.innerHTML = `
          <div class="autofill" style="margin-top:16px">
            <div class="head">✓ Invoice found</div>
            <div class="facts"><span><b>${esc(inv.invoice_no)}</b></span><span>${date(inv.invoice_date)}</span>
              <span>${esc(customer ? customer.name : 'Walk-in')}</span><span>${money(inv.total)}</span></div>
          </div>
          ${returnable.length ? '' : `<div class="alert warn" style="margin-top:16px"><span class="glyph">!</span>
            <div>Every line on this invoice has already been returned.</div></div>`}
          <div id="return-lines" style="margin-top:16px"></div>
          <div class="form-grid" style="margin-top:16px">
            <label class="full">Return reason
              <select name="reason">
                <option>Not working / defective</option><option>Wrong product</option>
                <option>Customer changed mind</option><option>Warranty replacement</option><option>Other</option>
              </select></label>
            <label class="check boxed full"><input type="checkbox" name="restock" checked>
              <span>Put the goods back into sellable stock
                <span class="hint">Leave this off for anything damaged — it is written off instead.</span></span></label>
          </div>
          <div class="btn-row end" style="margin-top:16px">
            <a class="link-btn quiet" href="#/sales/returns">Cancel</a>
            <button class="btn primary" id="confirm-return" ${returnable.length ? '' : 'disabled'}>Record Return</button>
          </div>`;

        host.querySelector('#return-lines').innerHTML = table(returnable, [
          {
            label: 'Product',
            render: (r) => `${esc(r.product_name)}<div class="sub">Sold ${qty(r.qty)}, already returned ${qty(r.returned_qty)}</div>`,
          },
          { label: 'Can return', num: true, render: (r) => qty(r.returnable) },
          {
            label: 'Return qty',
            num: true,
            render: (r) => `<input type="number" min="0" max="${r.returnable}" step="1" value="0" style="width:90px" data-item="${r.id}">`,
          },
          {
            label: 'Serials',
            render: (r) => (r.serial_tracked && r.serials.length
              ? `<select multiple size="2" style="min-width:150px" data-serials="${r.id}">
                  ${r.serials.map((x) => `<option value="${esc(x.serial)}">${esc(x.serial)}</option>`).join('')}</select>`
              : '<span class="muted small">—</span>'),
          },
        ], { clickable: false, stacked: false });

        host.querySelector('#confirm-return').addEventListener('click', async () => {
          const lines = [];
          host.querySelectorAll('[data-item]').forEach((input) => {
            const qtyValue = Number(input.value);
            if (qtyValue > 0) {
              const serialSelect = host.querySelector(`[data-serials="${input.dataset.item}"]`);
              lines.push({
                invoice_item_id: Number(input.dataset.item),
                qty: qtyValue,
                serials: serialSelect ? [...serialSelect.selectedOptions].map((o) => o.value) : [],
              });
            }
          });
          if (!lines.length) { toast('Enter how many units are coming back.', 'error'); return; }

          const restock = host.querySelector('[name=restock]').checked;
          const reason = host.querySelector('[name=reason]').value;
          const units = lines.reduce((sum, l) => sum + l.qty, 0);
          const ok = await modal({
            title: 'Record this return?',
            confirmLabel: 'Record Return',
            body: `<div class="summary-line"><span class="muted">Invoice</span><strong>${esc(inv.invoice_no)}</strong></div>
              <div class="summary-line"><span class="muted">Units</span><strong>${qty(units)}</strong></div>
              <div class="summary-line"><span class="muted">Reason</span><strong>${esc(reason)}</strong></div>
              <p class="muted">${restock
    ? `Stock will increase by ${qty(units)}.`
    : 'The goods are written off — stock will not increase.'}</p>`,
            onConfirm: () => true,
          });
          if (!ok) return;

          try {
            const res = await window.api.post('/api/returns', {
              invoice_id: inv.id, reason, restock, items: lines,
            });
            setStep(3);
            view.innerHTML = `<div class="card done-panel">
              <div class="glyph ok">✓</div>
              <h2>Return ${esc(res.returnNo)} recorded</h2>
              <p>${restock ? `${plural(units, 'unit')} went back on the shelf.` : 'The goods were written off.'}</p>
              <div class="btn-row" style="justify-content:center">
                <a href="#/sales/invoice/${inv.id}">View invoice</a>
                <a href="#/sales/returns">Back to Returns</a>
              </div>
            </div>`;
          } catch (err) { errorToast(err); }
        });
      } catch (err) {
        host.innerHTML = `<div class="alert error" style="margin-top:16px"><span class="glyph">!</span>
          <div><strong>${esc(err.message)}</strong><br>Check the invoice number and try again.</div></div>`;
      }
    });

    view.querySelector('#invoice-no').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); view.querySelector('#find').click(); }
    });
  }

  window.Pages = window.Pages || {};
  window.Pages.sales = { create, history, invoice, returns, newReturn };
})();
