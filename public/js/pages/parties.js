/* Customers and suppliers: the same two screens for both — a searchable list,
   and one contact with their numbers and their history. */
(function () {
  'use strict';
  const {
    esc, money, rupees, qty, date, table, skeleton, toast, errorToast, modal, formValues,
    pageHead, tiles, wireLinks, table: renderTable,
  } = window.ui;

  const SEARCH_ICON = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4A4843"
    stroke-width="1.8" stroke-linecap="round"><path d="M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3"/></svg>`;

  const COPY = {
    customers: {
      title: 'Customers',
      sub: 'People and businesses who buy from you.',
      add: '+ Add Customer',
      addTitle: 'Add Customer',
      save: 'Save Customer',
      search: 'Search customers by name or phone…',
      countCol: 'Invoices',
      kind: 'Customer',
      primary: '+ Create Invoice',
      primaryHref: '#/sales/new',
      namePlaceholder: 'e.g. Rahul Kumar',
      docLabel: 'Invoice',
      docHref: (id) => `#/sales/invoice/${id}`,
      lastLabel: 'Last visit',
    },
    suppliers: {
      title: 'Suppliers',
      sub: 'The distributors you buy stock from.',
      add: '+ Add Supplier',
      addTitle: 'Add Supplier',
      save: 'Save Supplier',
      search: 'Search suppliers by name or phone…',
      countCol: 'Purchases',
      kind: 'Supplier',
      primary: '+ Add Purchase',
      primaryHref: '#/purchases/add',
      namePlaceholder: 'e.g. ABC Computers',
      docLabel: 'Purchase #',
      docHref: (id) => `#/purchases/${id}`,
      lastLabel: 'Last purchase',
    },
  };

  function contactForm(kind, record = {}) {
    const c = COPY[kind];
    return `
      <label>Name <span class="req">*</span>
        <input name="name" placeholder="${esc(c.namePlaceholder)}" value="${esc(record.name || '')}"></label>
      <label>Phone<input name="phone" inputmode="tel" placeholder="e.g. 98450 12345" value="${esc(record.phone || '')}"></label>
      <label>Email <span class="opt">(optional)</span>
        <input name="email" type="email" value="${esc(record.email || '')}"></label>
      <label>Address <span class="opt">(optional)</span>
        <input name="address" placeholder="Area, city" value="${esc(record.address || '')}"></label>
      <label>GSTIN <span class="opt">(optional — only for businesses)</span>
        <input name="gstin" placeholder="e.g. 29AAKFS2231Q1Z9" value="${esc(record.gstin || '')}"></label>
      ${kind === 'customers' ? `<label>Shipping address <span class="opt">(if different)</span>
        <input name="shipping_address" value="${esc(record.shipping_address || '')}"></label>` : ''}`;
  }

  async function saveContact(kind, record) {
    const c = COPY[kind];
    return modal({
      title: record ? `Edit ${record.name}` : c.addTitle,
      confirmLabel: c.save,
      body: contactForm(kind, record || {}),
      onConfirm: async (root) => {
        const values = formValues(root);
        if (!values.name) {
          const field = root.querySelector('[name=name]');
          field.classList.add('invalid');
          toast('Please enter a name.', 'error');
          return undefined;
        }
        const res = record
          ? await window.api.put(`/api/${kind}/${record.id}`, values)
          : await window.api.post(`/api/${kind}`, values);
        toast(`${values.name} saved.`);
        return res.record;
      },
    });
  }

  function list(kind) {
    return async function render(view) {
      const c = COPY[kind];
      view.innerHTML = `
        ${pageHead({
    title: c.title,
    sub: c.sub,
    actions: `<button class="link-btn" id="download-excel">↓ Download Excel</button>
      <button class="btn primary" id="add">${c.add}</button>`,
  })}
        <div class="filters" style="max-width:520px">
          <div class="search">${SEARCH_ICON}
            <input type="search" id="q" placeholder="${esc(c.search)}" autocomplete="off"></div>
        </div>
        <div class="card" id="list">${skeleton(7)}</div>`;

      const load = async () => {
        const data = await window.api.get(`/api/${kind}`, { q: view.querySelector('#q').value.trim() });
        const rows = data[kind];
        const host = view.querySelector('#list');
        host.innerHTML = rows.length ? table(rows, [
          {
            label: 'Name',
            render: (r) => `<div style="font-weight:500">${esc(r.name)}</div>
              ${r.address ? `<div class="sub">${esc(r.address)}</div>` : ''}`,
          },
          { label: 'Phone', num: true, render: (r) => esc(r.phone || '—') },
          { label: c.countCol, num: true, render: (r) => qty(r.transactions) },
          { label: 'Total Business', num: true, render: (r) => rupees(r.total_value) },
          { label: 'Last', render: (r) => `<span class="muted nowrap">${r.last_transaction ? date(r.last_transaction) : '—'}</span>` },
        ], { rowAttrs: (r) => `data-href="#/contacts/${kind === 'customers' ? 'customer' : 'supplier'}/${r.id}"` })
          : (() => {
            const q = view.querySelector('#q').value.trim();
            return `<div class="empty">
              <h3>${q ? `No one called “${esc(q)}”` : `No ${c.title.toLowerCase()} yet`}</h3>
              <p>${q ? 'Try the phone number instead.' : `Add your first ${c.kind.toLowerCase()} to get started.`}</p>
              <button class="btn primary" id="add-empty">${c.add}</button></div>`;
          })();
        wireLinks(host);
        const addEmpty = host.querySelector('#add-empty');
        if (addEmpty) addEmpty.addEventListener('click', add);
      };

      const add = async () => { if (await saveContact(kind)) load(); };
      view.querySelector('#add').addEventListener('click', add);
      view.querySelector('#download-excel').addEventListener('click', async () => {
        try {
          await window.api.download(`/api/${kind}/export/excel`, {}, `${kind}.xlsx`);
          toast(`${c.title} downloaded as a spreadsheet.`);
        } catch (err) { errorToast(err); }
      });
      let timer;
      view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
      await load();
    };
  }

  function detail(kind) {
    return async function render(view, id) {
      const c = COPY[kind];
      const { record, history, products, stats } = await window.api.get(`/api/${kind}/${id}`);

      view.innerHTML = `
        ${pageHead({
    title: esc(record.name),
    sub: `${c.kind} since ${date(stats.since)} · <button class="link-btn" id="edit">Edit details</button>`,
    actions: `<a class="btn primary" href="${c.primaryHref}">${c.primary}</a>`,
  })}
        <div class="grid cols-2" style="align-items:start">
          <section class="card">
            <div class="facts" style="grid-template-columns:1fr">
              <div><div class="k">Phone</div><div class="v">${esc(record.phone || 'Not provided')}</div></div>
              <div><div class="k">Address</div><div class="v">${esc(record.address || 'Not provided')}</div></div>
              <div><div class="k">GSTIN</div><div class="v">${esc(record.gstin || 'Not provided')}</div></div>
              <div><div class="k">Email</div><div class="v">${esc(record.email || 'Not provided')}</div></div>
            </div>
          </section>
          <div style="min-width:0">
            ${tiles([
    { label: 'Total business', value: rupees(stats.totalValue) },
    { label: c.countCol, value: qty(stats.transactions) },
    { label: c.lastLabel, value: stats.last ? date(stats.last) : '—' },
  ])}
          </div>
        </div>

        <div class="page-section">
          <h2>Products</h2>
          <div class="card" id="products-list"></div>
        </div>
        <div class="page-section">
          <h2>${kind === 'suppliers' ? 'Bills' : 'Invoices'}</h2>
          <div class="card" id="docs-list"></div>
        </div>`;

      view.querySelector('#products-list').innerHTML = renderTable(products, [
        { label: 'Date', render: (r) => date(r.date) },
        { label: 'Product', render: (r) => esc(r.product) },
        { label: 'Qty', num: true, render: (r) => qty(r.qty) },
        { label: 'Amount', num: true, render: (r) => money(r.total) },
      ], {
        rowAttrs: (r) => `data-href="${c.docHref(r.doc_id)}"`,
        empty: kind === 'suppliers' ? 'Nothing bought from them yet.' : 'Nothing bought yet.',
      });
      view.querySelector('#docs-list').innerHTML = renderTable(history, [
        { label: c.docLabel, class: 'doc', render: (r) => esc(r.doc_no) },
        { label: 'Date', render: (r) => date(r.date) },
        { label: 'Items', num: true, render: (r) => qty(r.items) },
        { label: 'Amount', num: true, render: (r) => money(r.total) },
        { label: 'Status', render: (r) => window.ui.statusTag(r.status) },
      ], { rowAttrs: (r) => `data-href="${c.docHref(r.id)}"`, empty: 'Nothing recorded yet.' });
      wireLinks(view);

      view.querySelector('#edit').addEventListener('click', async () => {
        try {
          if (await saveContact(kind, record)) render(view, id);
        } catch (err) { errorToast(err); }
      });
    };
  }

  /**
   * The Address Book: one list holding everybody, customers and suppliers
   * together, so nobody has to work out which list a name belongs to.
   */
  async function contacts(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Address Book',
    sub: 'Everyone you deal with — customers and suppliers in one list.',
    actions: `<button class="btn" id="add-customer">+ Add Customer</button>
      ${window.api.isAdmin() ? '<button class="btn" id="add-supplier">+ Add Supplier</button>' : ''}`,
  })}
      <div class="filters" style="max-width:560px">
        <div class="search">${SEARCH_ICON}
          <input type="search" id="q" placeholder="Search anyone by name, phone, email or GSTIN…" autocomplete="off"></div>
      </div>
      <div class="card" id="list">${skeleton(8)}</div>`;

    const load = async () => {
      const q = view.querySelector('#q').value.trim();
      const admin = window.api.isAdmin();
      const [customers, suppliers] = await Promise.all([
        window.api.get('/api/customers', { q }),
        admin ? window.api.get('/api/suppliers', { q }) : Promise.resolve({ suppliers: [] }),
      ]);
      const rows = [
        ...customers.customers.map((r) => ({ ...r, kind: 'customers' })),
        ...suppliers.suppliers.map((r) => ({ ...r, kind: 'suppliers' })),
      ].sort((a, b) => a.name.localeCompare(b.name));

      const host = view.querySelector('#list');
      host.innerHTML = rows.length ? table(rows, [
        {
          label: 'Name',
          render: (r) => `<div style="font-weight:500">${esc(r.name)}</div>
            ${r.address ? `<div class="sub">${esc(r.address)}</div>` : ''}`,
        },
        {
          label: 'They are',
          render: (r) => `<span class="tag ${r.kind === 'customers' ? 'green' : 'blue'}">
            ${r.kind === 'customers' ? 'Customer' : 'Supplier'}</span>`,
        },
        { label: 'Phone', num: true, render: (r) => esc(r.phone || '—') },
        { label: 'Deals', num: true, render: (r) => qty(r.transactions) },
        { label: 'Total Business', num: true, render: (r) => rupees(r.total_value) },
        { label: 'Last', render: (r) => `<span class="muted nowrap">${r.last_transaction ? date(r.last_transaction) : '—'}</span>` },
      ], {
        rowAttrs: (r) => `data-href="#/contacts/${r.kind === 'customers' ? 'customer' : 'supplier'}/${r.id}"`,
      }) : `<div class="empty">
          <h3>${q ? `No one called “${esc(q)}”` : 'Nobody saved yet'}</h3>
          <p>${q ? 'Try their phone number instead.' : 'Add the people you sell to and buy from.'}</p></div>`;
      wireLinks(host);
    };

    view.querySelector('#add-customer').addEventListener('click', async () => {
      if (await saveContact('customers')) load();
    });
    const addSupplier = view.querySelector('#add-supplier');
    if (addSupplier) addSupplier.addEventListener('click', async () => {
      if (await saveContact('suppliers')) load();
    });
    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
    await load();
  }

  window.Pages = window.Pages || {};
  window.Pages.contacts = { list: contacts };
  window.Pages.customers = { list: list('customers'), detail: detail('customers') };
  window.Pages.suppliers = { list: list('suppliers'), detail: detail('suppliers') };
})();
