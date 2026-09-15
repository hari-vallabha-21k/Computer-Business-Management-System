/* Sales: create invoice, invoice history, invoice view (PDF/QR/print) and returns. */
(function () {
  'use strict';
  const {
    esc, money, qty, date, dateTime, table, loading, statusTag, toast, errorToast, modal, confirm,
    productSearch, partySearch, formValues, todayIso,
  } = window.ui;

  const tabs = (active) => `
    <div class="tabs">
      <a href="#/sales/create" class="${active === 'create' ? 'active' : ''}">Create Invoice</a>
      <a href="#/sales" class="${active === 'history' ? 'active' : ''}">Invoice History</a>
      <a href="#/sales/returns" class="${active === 'returns' ? 'active' : ''}">Returns</a>
    </div>`;

  // ---------- Create invoice ----------
  async function create(view, invoiceId) {
    view.innerHTML = `
      <div class="page-head"><div><h1>${invoiceId ? 'Edit Draft Invoice' : 'Create Invoice'}</h1>
        <p class="muted">Pick a customer, search products, and the rest fills itself in.</p></div></div>
      ${tabs('create')}
      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Customer</h2></div>
          <div id="customer-pick"></div>
          <div id="customer-info" class="alert info hidden"></div>
          <div class="form-grid" style="margin-top:10px">
            <label>Invoice Date<input name="invoice_date" type="date" value="${todayIso()}"></label>
            <label>Payment Mode<select name="payment_mode">
              <option>CASH</option><option>UPI</option><option>CARD</option><option>BANK TRANSFER</option><option>CREDIT</option>
            </select></label>
            <label>Payment Status<select name="payment_status"><option>PAID</option><option>UNPAID</option><option>PARTIAL</option></select></label>
            <label>Terms<input name="payment_terms" list="terms-list" placeholder="Due on Receipt">
              <datalist id="terms-list"><option>Due on Receipt</option><option>Net 15</option><option>Net 30</option><option>Net 45</option></datalist></label>
            <label>Due Date<input name="due_date" type="date"></label>
            <label class="full">Ship To (leave blank to use the customer address)
              <input name="ship_to_address" placeholder="Delivery address"></label>
            <label class="full">Notes<input name="notes"></label>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Add Products</h2></div>
          <div id="product-pick"></div>
          <div id="totals" style="margin-top:16px"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Invoice Items</h2>
          <span class="muted small" id="price-mode"></span>
          <span class="muted small" id="stock-note"></span></div>
        <div id="lines"></div>
        <label style="margin-top:12px">Product Brief (specifications and serial numbers printed under the items)
          <textarea name="product_brief" rows="2"></textarea></label>
      </div>
      <div class="btn-row">
        <button class="btn" id="save-draft">Save as Draft</button>
        <button class="btn primary" id="issue">Issue Invoice</button>
        <span class="muted small">A draft does not change stock. Issuing the invoice reduces inventory.</span>
      </div>`;

    const state = { customer: null, lines: [], invoiceId: invoiceId || null };

    partySearch(view.querySelector('#customer-pick'), 'customers', (c) => {
      state.customer = c;
      const box = view.querySelector('#customer-info');
      box.className = 'alert info';
      box.innerHTML = `<strong>${esc(c.name)}</strong> · ${esc(c.phone || 'no phone')}${c.gstin ? ` · GSTIN ${esc(c.gstin)}` : ''}
        · ${c.transactions || 0} previous invoice(s)`;
    });

    productSearch(view.querySelector('#product-pick'), (product) => addLine(product), { label: 'Search product' });

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
        host.innerHTML = '<div class="empty">No items yet. Search for a product above to start.</div>';
      } else {
        host.innerHTML = table(state.lines, [
          {
            key: 'product',
            label: 'Product',
            render: (l) => `<strong>${esc(l.product.name)}</strong>
              <div class="small muted">${esc(l.product.product_code)} · HSN ${esc(l.product.hsn_code || '-')} · GST ${l.product.gst_rate}%
              · in stock ${qty(l.product.stock)}</div>
              ${l.qty > l.product.stock ? `<div class="small error">⚠ Only ${qty(l.product.stock)} in stock</div>` : ''}`,
          },
          { key: 'qty', label: 'Qty', num: true, render: (l, i) => `<input type="number" min="1" step="1" style="width:74px" data-field="qty" data-i="${i}" value="${l.qty}">` },
          { key: 'unitPrice', label: 'Rate', num: true, render: (l, i) => `<input type="number" step="0.01" style="width:104px" data-field="unitPrice" data-i="${i}" value="${l.unitPrice}">` },
          { key: 'discount', label: 'Discount', num: true, render: (l, i) => `<input type="number" step="0.01" style="width:96px" data-field="discount" data-i="${i}" value="${l.discount}">` },
          { key: 'gst', label: 'GST', num: true, render: (l) => money(lineTotals(l).gst) },
          { key: 'total', label: 'Amount', num: true, render: (l) => `<strong>${money(lineTotals(l).total)}</strong>` },
          {
            key: 'serials',
            label: 'Serials',
            render: (l, i) => (l.product.serial_tracked
              ? `<button class="btn small" data-serials="${i}">${l.serials.length ? `${l.serials.length} selected` : 'Select'}</button>`
              : '<span class="muted small">-</span>'),
          },
          { key: 'remove', label: '', render: (l, i) => `<button class="btn small ghost" data-remove="${i}">✕</button>` },
        ]);

        host.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('change', () => {
          const line = state.lines[Number(input.dataset.i)];
          line[input.dataset.field] = Number(input.value) || 0;
          setTimeout(renderLines, 0);
        }));
        host.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
          state.lines.splice(Number(btn.dataset.remove), 1);
          renderLines();
        }));
        host.querySelectorAll('[data-serials]').forEach((btn) => btn.addEventListener('click',
          () => pickSerials(Number(btn.dataset.serials))));
      }
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
      const interState = state.customer && state.customer.gstin && window.api.state.business
        && window.api.state.business.gstin
        && state.customer.gstin.slice(0, 2) !== window.api.state.business.gstin.slice(0, 2);
      view.querySelector('#totals').innerHTML = `
        <table>
          <tr><th>Taxable Value</th><td class="num">${money(totals.subtotal)}</td></tr>
          ${totals.discount ? `<tr><th>Discount</th><td class="num">− ${money(totals.discount)}</td></tr>` : ''}
          ${interState
        ? `<tr><th>IGST</th><td class="num">${money(totals.gst)}</td></tr>`
        : `<tr><th>CGST</th><td class="num">${money(totals.gst / 2)}</td></tr>
             <tr><th>SGST</th><td class="num">${money(totals.gst / 2)}</td></tr>`}
          <tr><th>Total</th><td class="num"><strong style="font-size:17px">${money(totals.total)}</strong></td></tr>
        </table>`;
      const modeNote = view.querySelector('#price-mode');
      if (modeNote) {
        modeNote.textContent = inclusive()
          ? 'Rates include GST - tax is backed out of the price.'
          : 'Rates exclude GST - tax is added on top.';
      }
      const short = state.lines.filter((l) => l.qty > l.product.stock);
      view.querySelector('#stock-note').innerHTML = short.length
        ? `<span class="error">⚠ ${short.length} line(s) exceed available stock</span>` : '';
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
      <div class="page-head"><div><h1>Invoices</h1><p class="muted">Drafts hold no stock; issued invoices have already reduced it.</p></div>
        <div class="actions"><a class="btn primary" href="#/sales/create">+ New Invoice</a></div></div>
      ${tabs('history')}
      <div class="card"><div class="filters">
        <label class="grow">Search<input type="search" id="q" placeholder="Invoice no, customer or phone"></label>
        <label>Status<select id="status"><option value="">All</option><option>DRAFT</option><option>ISSUED</option><option>CANCELLED</option></select></label>
        <label>From<input type="date" id="from"></label>
        <label>To<input type="date" id="to"></label>
      </div></div>
      <div class="card" id="list">${loading()}</div>`;

    const load = async () => {
      const { invoices } = await window.api.get('/api/invoices', {
        q: view.querySelector('#q').value.trim(),
        status: view.querySelector('#status').value,
        from: view.querySelector('#from').value,
        to: view.querySelector('#to').value,
        limit: 200,
      });
      view.querySelector('#list').innerHTML = table(invoices, [
        { key: 'invoice_no', label: 'Invoice No', render: (r) => `<a href="#/sales/invoice/${r.id}"><strong>${esc(r.invoice_no)}</strong></a>` },
        { key: 'invoice_date', label: 'Date', render: (r) => date(r.invoice_date) },
        { key: 'customer_name', label: 'Customer', render: (r) => `${esc(r.customer_name || 'Walk-in')}<div class="small muted">${esc(r.customer_phone || '')}</div>` },
        { key: 'status', label: 'Status', render: (r) => statusTag(r.status) },
        { key: 'payment_mode', label: 'Payment', render: (r) => `${esc(r.payment_mode || '-')} <span class="small muted">${esc(r.payment_status || '')}</span>` },
        { key: 'total', label: 'Total', num: true, render: (r) => money(r.total) },
      ], { empty: 'No invoices yet.' });
    };
    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    ['#status', '#from', '#to'].forEach((s) => view.querySelector(s).addEventListener('change', load));
    await load();
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
      <div class="page-head">
        <div><h1>${esc(inv.invoice_no)} ${statusTag(inv.status)}</h1>
          <p class="muted">${date(inv.invoice_date)} · ${esc(inv.customer_name || 'Walk-in customer')}
            ${inv.issued_at ? `· issued ${dateTime(inv.issued_at)}` : ''}</p></div>
        <div class="actions">
          ${inv.status === 'DRAFT' ? `<button class="btn success" id="issue">Issue Invoice</button>
            <a class="btn" href="#/sales/create/${inv.id}">Edit</a>` : ''}
          <button class="btn" id="pdf">Download PDF</button>
          <button class="btn" id="print">Print</button>
          ${inv.status !== 'CANCELLED' ? '<button class="btn danger" id="cancel">Cancel Invoice</button>' : ''}
        </div>
      </div>

      ${inv.status === 'DRAFT' ? '<div class="alert warn">This is a draft. Inventory has not been reduced yet.</div>' : ''}
      ${inv.status === 'CANCELLED' ? `<div class="alert error">Cancelled${inv.cancel_reason ? `: ${esc(inv.cancel_reason)}` : ''}. Stock was restored.</div>` : ''}

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

    view.querySelector('#pdf').addEventListener('click',
      () => window.api.download(`/api/invoices/${id}/pdf`, {}, `${inv.invoice_no.replace(/\//g, '-')}.pdf`).catch(errorToast));
    view.querySelector('#print').addEventListener('click', () => window.print());

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

    const cancelBtn = view.querySelector('#cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        const reason = await modal({
          title: `Cancel ${inv.invoice_no}?`,
          confirmLabel: 'Cancel Invoice',
          cancelLabel: 'Keep it',
          body: `<p>${inv.status === 'ISSUED'
            ? 'The stock sold on this invoice will be returned to inventory and any serial numbers released.'
            : 'This draft will be marked cancelled.'}</p>
            <label>Reason<input name="reason" placeholder="Why is this being cancelled?"></label>`,
          onConfirm: (root) => root.querySelector('[name=reason]').value.trim() || 'Cancelled',
        });
        if (!reason) return;
        try {
          await window.api.post(`/api/invoices/${id}/cancel`, { reason });
          toast('Invoice cancelled and stock restored.', 'success');
          invoice(view, id);
        } catch (err) { errorToast(err); }
      });
    }
  }


  // ---------- Returns ----------
  async function returns(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Returns</h1><p class="muted">Search the invoice, pick what came back, and stock goes up again.</p></div></div>
      ${tabs('returns')}
      <div class="card">
        <div class="filters">
          <label class="grow">Invoice number<input id="invoice-no" placeholder="INV-1024" list="recent-invoices">
            <datalist id="recent-invoices"></datalist></label>
          <button class="btn primary" id="find">Find Invoice</button>
        </div>
        <div id="found"></div>
      </div>
      <div class="card"><div class="card-head"><h2>Recent Returns</h2></div><div id="recent">${loading()}</div></div>`;

    window.api.get('/api/invoices', { status: 'ISSUED', limit: 30 }).then(({ invoices }) => {
      view.querySelector('#recent-invoices').innerHTML = invoices
        .map((i) => `<option value="${esc(i.invoice_no)}">${esc(i.customer_name || 'Walk-in')} · ${money(i.total)}</option>`).join('');
    });

    const loadRecent = async () => {
      const { returns: rows } = await window.api.get('/api/returns', { limit: 30 });
      view.querySelector('#recent').innerHTML = table(rows, [
        { key: 'return_no', label: 'Return No' },
        { key: 'return_date', label: 'Date', render: (r) => date(r.return_date) },
        { key: 'invoice_no', label: 'Invoice', render: (r) => `<a href="#/sales/invoice/${r.invoice_id}">${esc(r.invoice_no)}</a>` },
        { key: 'customer_name', label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
        { key: 'items', label: 'Items', render: (r) => esc(r.items.map((i) => `${i.product_name} ×${qty(i.qty)}`).join(', ')) },
        { key: 'total', label: 'Value', num: true, render: (r) => money(r.total) },
        { key: 'restock', label: 'Restocked', render: (r) => (r.restock ? '<span class="tag green">Yes</span>' : '<span class="tag red">Written off</span>') },
      ], { empty: 'No returns recorded yet.' });
    };

    view.querySelector('#find').addEventListener('click', async () => {
      const no = view.querySelector('#invoice-no').value.trim();
      const host = view.querySelector('#found');
      if (!no) { toast('Enter an invoice number.', 'error'); return; }
      host.innerHTML = loading('Looking up the invoice…');
      try {
        const { invoice: inv, items, customer } = await window.api.get(`/api/returns/invoice/${encodeURIComponent(no)}`);
        const returnable = items.filter((i) => i.returnable > 0);
        host.innerHTML = `
          <div class="alert info" style="margin-top:12px">
            <strong>${esc(inv.invoice_no)}</strong> · ${date(inv.invoice_date)} · ${esc(customer ? customer.name : 'Walk-in')} · ${money(inv.total)}
          </div>
          ${returnable.length ? '' : '<div class="alert warn">Every line on this invoice has already been returned.</div>'}
          <div id="return-lines"></div>
          <div class="form-grid" style="margin-top:10px">
            <label class="full">Reason<input name="reason" placeholder="Why is it coming back?"></label>
            <label class="check"><input type="checkbox" name="restock" checked> Put the goods back into sellable stock</label>
          </div>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn success" id="confirm-return" ${returnable.length ? '' : 'disabled'}>Confirm Return</button>
          </div>`;

        const selections = new Map();
        host.querySelector('#return-lines').innerHTML = table(returnable, [
          { key: 'product_name', label: 'Product', render: (r) => `${esc(r.product_name)}<div class="small muted">Sold ${qty(r.qty)}, already returned ${qty(r.returned_qty)}</div>` },
          { key: 'returnable', label: 'Can return', num: true, render: (r) => qty(r.returnable) },
          { key: 'qty', label: 'Return qty', num: true, render: (r) => `<input type="number" min="0" max="${r.returnable}" step="1" value="0" style="width:84px" data-item="${r.id}">` },
          {
            key: 'serials',
            label: 'Serials',
            render: (r) => (r.serial_tracked && r.serials.length
              ? `<select multiple size="2" style="min-width:150px" data-serials="${r.id}">
                  ${r.serials.map((s) => `<option value="${esc(s.serial)}">${esc(s.serial)}</option>`).join('')}</select>`
              : '<span class="muted small">-</span>'),
          },
        ]);

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
          if (!lines.length) { toast('Enter a return quantity for at least one item.', 'error'); return; }
          try {
            const res = await window.api.post('/api/returns', {
              invoice_id: inv.id,
              items: lines,
              reason: host.querySelector('[name=reason]').value.trim(),
              restock: host.querySelector('[name=restock]').checked,
            });
            toast(`Return ${res.returnNo} recorded (${money(res.total)}). Inventory updated.`, 'success');
            host.innerHTML = '';
            view.querySelector('#invoice-no').value = '';
            loadRecent();
          } catch (err) { errorToast(err); }
        });
      } catch (err) {
        host.innerHTML = `<div class="alert error" style="margin-top:12px">${esc(err.message)}</div>`;
      }
    });

    view.querySelector('#invoice-no').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); view.querySelector('#find').click(); }
    });

    await loadRecent();
  }

  window.Pages = window.Pages || {};
  window.Pages.sales = { create, history, invoice, returns };
})();
