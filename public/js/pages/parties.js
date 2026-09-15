/* Customers and suppliers - one page factory for both. */
(function () {
  'use strict';
  const { esc, money, date, table, loading, statusTag, toast, errorToast, modal, formValues, quickAddParty } = window.ui;

  function page(kind) {
    const label = kind === 'customers' ? 'Customer' : 'Supplier';
    const title = kind === 'customers' ? 'Customers' : 'Suppliers';

    return async function render(view) {
      view.innerHTML = `
        <div class="page-head"><div><h1>${title}</h1>
          <p class="muted">${kind === 'customers'
        ? 'Searchable on every invoice, with full purchase history.'
        : 'Linked to purchases; scanned invoices try to identify the supplier automatically.'}</p></div>
          <div class="actions"><button class="btn primary" id="add">+ Add ${label}</button></div></div>
        <div class="card"><div class="filters">
          <label class="grow">Search<input type="search" id="q" placeholder="Name, phone, email or GSTIN"></label>
        </div></div>
        <div class="card" id="list">${loading()}</div>`;

      const load = async () => {
        const data = await window.api.get(`/api/${kind}`, { q: view.querySelector('#q').value.trim() });
        const rows = data[kind];
        view.querySelector('#list').innerHTML = table(rows, [
          { key: 'name', label: 'Name', render: (r) => `<strong>${esc(r.name)}</strong>` },
          { key: 'phone', label: 'Phone', render: (r) => esc(r.phone || '-') },
          { key: 'email', label: 'Email', render: (r) => esc(r.email || '-') },
          { key: 'gstin', label: 'GSTIN', render: (r) => esc(r.gstin || '-') },
          { key: 'transactions', label: kind === 'customers' ? 'Invoices' : 'Purchases', num: true },
          { key: 'total_value', label: 'Value', num: true, render: (r) => money(r.total_value) },
          {
            key: 'actions',
            label: '',
            render: (r) => `<button class="btn small" data-history="${r.id}">History</button>
              <button class="btn small ghost" data-edit="${r.id}">Edit</button>`,
          },
        ], { empty: `No ${kind} yet.` });

        view.querySelectorAll('[data-history]').forEach((btn) => btn.addEventListener('click',
          () => showHistory(btn.dataset.history)));
        view.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', async () => {
          const record = rows.find((r) => String(r.id) === btn.dataset.edit);
          const saved = await modal({
            title: `Edit ${label}`,
            confirmLabel: 'Save',
            body: `<div class="form-grid">
                <label class="full">Name<input name="name" value="${esc(record.name)}"></label>
                <label>Phone<input name="phone" value="${esc(record.phone || '')}"></label>
                <label>Email<input name="email" value="${esc(record.email || '')}"></label>
                <label class="full">Address<textarea name="address">${esc(record.address || '')}</textarea></label>
                ${kind === 'customers' ? `<label class="full">Shipping Address (if different)<textarea name="shipping_address">${esc(record.shipping_address || '')}</textarea></label>` : ''}
                <label>GSTIN<input name="gstin" value="${esc(record.gstin || '')}"></label>
              </div>`,
            onConfirm: (root) => window.api.put(`/api/${kind}/${record.id}`, formValues(root)),
          });
          if (saved) { toast(`${label} updated.`, 'success'); load(); }
        }));
      };

      async function showHistory(id) {
        const { record, history } = await window.api.get(`/api/${kind}/${id}`);
        modal({
          title: `${record.name}`,
          wide: true,
          confirmLabel: '',
          cancelLabel: 'Close',
          body: `
            <div class="grid cols-3" style="margin-bottom:12px">
              <div><div class="small muted">Phone</div><strong>${esc(record.phone || '-')}</strong></div>
              <div><div class="small muted">Email</div><strong>${esc(record.email || '-')}</strong></div>
              <div><div class="small muted">GSTIN</div><strong>${esc(record.gstin || '-')}</strong></div>
              <div class="full"><div class="small muted">Address</div>${esc(record.address || '-')}</div>
              ${record.shipping_address ? `<div class="full"><div class="small muted">Shipping Address</div>${esc(record.shipping_address)}</div>` : ''}
            </div>
            ${table(history, [
            { key: 'doc_no', label: kind === 'customers' ? 'Invoice' : 'Purchase' },
            { key: 'date', label: 'Date', render: (r) => date(r.date) },
            { key: 'status', label: 'Status', render: (r) => statusTag(r.status) },
            { key: 'total', label: 'Total', num: true, render: (r) => money(r.total) },
          ], { empty: 'No transactions yet.' })}`,
        });
      }

      view.querySelector('#add').addEventListener('click', async () => {
        const created = await quickAddParty(kind);
        if (created) load();
      });
      let timer;
      view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
      await load();
    };
  }

  window.Pages = window.Pages || {};
  window.Pages.customers = { render: page('customers') };
  window.Pages.suppliers = { render: page('suppliers') };
})();
