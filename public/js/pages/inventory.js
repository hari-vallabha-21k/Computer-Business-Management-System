/* Inventory: what is on the shelves, the product master, stock in and out,
   adjustments, low stock and serial numbers. */
(function () {
  'use strict';
  const {
    esc, money, rupees, qty, date, dateTime, table, loading, skeleton, toast, errorToast, modal, confirm,
    statusTag, stockTag, stockState, MOVEMENT_LABEL, productSearch, partySearch, formValues,
    pageHead, tiles, wireLinks, rowActions, wireRowActions, emptyState,
  } = window.ui;

  const SEARCH_ICON = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4A4843"
    stroke-width="1.8" stroke-linecap="round"><path d="M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3"/></svg>`;

  const searchField = (id, placeholder, value = '') => `
    <div class="search">${SEARCH_ICON}
      <input type="search" id="${id}" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off">
    </div>`;

  // ---------- Inventory overview ----------
  async function overview(view) {
    const state = { q: '', filter: 'all' };
    view.innerHTML = `
      ${pageHead({
    title: 'Inventory',
    sub: "See what's on your shelves and what needs reordering.",
    actions: '<a class="btn primary" href="#/inventory/add">+ Add Stock</a>',
  })}
      <div class="filters">
        ${searchField('q', 'Search products…')}
        <div class="segmented" id="stock-filter"></div>
      </div>
      <div class="card" id="list">${skeleton(6)}</div>`;

    const load = async () => {
      const { products } = await window.api.get('/api/products', { q: state.q, limit: 300 });
      const counts = {
        all: products.length,
        low: products.filter((p) => stockState(p).label === 'Low Stock').length,
        out: products.filter((p) => p.stock <= 0).length,
      };
      view.querySelector('#stock-filter').innerHTML = [
        ['all', `All (${counts.all})`], ['low', `Low Stock (${counts.low})`], ['out', `Out (${counts.out})`],
      ].map(([k, l]) => `<button data-filter="${k}" class="${state.filter === k ? 'active' : ''}">${l}</button>`).join('');
      view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
        state.filter = b.dataset.filter;
        load();
      }));

      const rows = products.filter((p) => (state.filter === 'all'
        || (state.filter === 'low' && stockState(p).label === 'Low Stock')
        || (state.filter === 'out' && p.stock <= 0)));

      const list = view.querySelector('#list');
      list.innerHTML = rows.length ? table(rows, [
        {
          label: 'Product',
          render: (p) => `<div style="font-weight:500">${esc(p.name)}</div>
            <div class="sub">${esc(p.product_code)} · Minimum ${qty(p.min_stock)}</div>`,
        },
        { label: 'Stock', num: true, render: (p) => `${qty(p.stock)} ${p.stock === 1 ? 'unit' : 'units'}` },
        { label: 'Status', noLabel: true, render: (p) => stockTag(p) },
        { label: 'Location', render: (p) => esc(p.location || '—') },
        { label: 'Action', render: () => '<span class="link-btn">Add stock →</span>' },
      ], { rowAttrs: (p) => `data-href="#/inventory/product/${p.id}"` })
        : `<div class="empty"><h3>Nothing here</h3><p>No products match this search.</p></div>`;
      wireLinks(list);
      list.querySelectorAll('tr.clickable').forEach((tr) => {
        const action = tr.querySelector('td:last-child .link-btn');
        if (action) {
          action.addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.hash = `#/inventory/add?product=${tr.dataset.href.split('/').pop()}`;
          });
        }
      });
    };

    let timer;
    view.querySelector('#q').addEventListener('input', (e) => {
      state.q = e.target.value.trim();
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    });
    await load();
  }

  // ---------- Products ----------
  async function products(view) {
    const state = { q: '', category: '', brand: '', stock: '' };
    const { categories, brands } = await window.api.get('/api/products/filters');

    view.innerHTML = `
      ${pageHead({
    title: 'Products',
    sub: 'Manage your products and pricing.',
    actions: window.api.isAdmin() ? '<a class="btn primary" href="#/inventory/add-product">+ Add Product</a>' : '',
  })}
      <div class="filters">
        ${searchField('q', 'Search by name, brand, model, HSN or serial number…')}
        <select id="category" aria-label="Category">
          <option value="">All categories</option>
          ${categories.map((c) => `<option>${esc(c.name)}</option>`).join('')}
        </select>
        <select id="brand" aria-label="Brand">
          <option value="">All brands</option>
          ${brands.map((b) => `<option>${esc(b)}</option>`).join('')}
        </select>
        <select id="stock" aria-label="Stock status">
          <option value="">Any stock status</option>
          <option value="in">In Stock</option>
          <option value="low">Low Stock</option>
          <option value="out">Out of Stock</option>
        </select>
      </div>
      <div class="card" id="list">${skeleton(8)}</div>`;

    const load = async () => {
      const { products: all } = await window.api.get('/api/products', {
        q: state.q, category: state.category, brand: state.brand, limit: 300,
      });
      const rows = all.filter((p) => {
        const label = stockState(p).label;
        if (state.stock === 'in') return label === 'In Stock';
        if (state.stock === 'low') return label === 'Low Stock';
        if (state.stock === 'out') return label === 'Out of Stock';
        return true;
      });

      const list = view.querySelector('#list');
      if (!rows.length) {
        list.innerHTML = `<div class="empty">
          <h3>No products match ${state.q ? `“${esc(state.q)}”` : 'these filters'}</h3>
          <p>Check the spelling, or search by model number or serial number.</p>
          <button class="link-btn" id="clear">Clear search and filters</button>
        </div>`;
        list.querySelector('#clear').addEventListener('click', () => {
          Object.assign(state, { q: '', category: '', brand: '', stock: '' });
          view.querySelector('#q').value = '';
          ['category', 'brand', 'stock'].forEach((f) => { view.querySelector(`#${f}`).value = ''; });
          load();
        });
        return;
      }

      list.innerHTML = `${table(rows, [
    {
      label: 'Product',
      render: (p) => `<div style="font-weight:500">${esc(p.name)}</div>
        <div class="sub">${esc(p.product_code)} · ${esc(p.category || 'Uncategorised')}</div>`,
    },
    { label: 'Brand / Model', render: (p) => esc([p.brand, p.model].filter(Boolean).join(' · ') || '—') },
    { label: 'HSN', num: true, render: (p) => esc(p.hsn_code || '—') },
    { label: 'Stock', num: true, render: (p) => `${qty(p.stock)} ${p.stock === 1 ? 'unit' : 'units'}` },
    { label: 'Selling Price', num: true, render: (p) => money(p.selling_price) },
    { label: 'Status', noLabel: true, render: (p) => stockTag(p) },
    {
      label: '', noLabel: true,
      render: () => rowActions([{ label: 'Open', action: 'view' }, { label: 'Add stock', action: 'stock' }]),
    },
  ], { rowAttrs: (p) => `data-id="${p.id}" data-href="#/inventory/product/${p.id}"` })}
        <div class="table-foot"><span>Showing ${rows.length} product${rows.length === 1 ? '' : 's'}</span></div>`;

      wireLinks(list);
      wireRowActions(list, {
        view: (row) => { window.location.hash = `#/inventory/product/${row.dataset.id}`; },
        stock: (row) => { window.location.hash = `#/inventory/add?product=${row.dataset.id}`; },
      });
    };

    let timer;
    view.querySelector('#q').addEventListener('input', (e) => {
      state.q = e.target.value.trim();
      clearTimeout(timer);
      timer = setTimeout(load, 220);
    });
    ['category', 'brand', 'stock'].forEach((field) => view.querySelector(`#${field}`)
      .addEventListener('change', (e) => { state[field] = e.target.value; load(); }));
    await load();
  }

  // ---------- Add / edit product ----------

  /**
   * The product form, shared by the Add Product page, the Services page and the
   * "+ Add New Product" pop-up on the invoice screen. A service keeps the same
   * record shape but has no brand, stock, shelf or serial numbers.
   */
  function productFormHtml(p, { categories, brands, service = false, name = '', openingStock = true }) {
    const noun = service ? 'Service' : 'Product';
    return `
        <form class="card product-form" id="form">
          <input type="hidden" name="item_type" value="${service ? 'SERVICE' : 'PRODUCT'}">
          <div class="form-section">
            <span class="section-label">${noun} Information</span>
            <label style="margin-bottom:18px">${noun} name <span class="req">*</span>
              <input name="name" placeholder="${service ? 'e.g. Windows installation' : 'e.g. Dell Inspiron 3530'}"
                value="${esc(p ? p.name : name)}" required>
            </label>
            <div class="form-grid">
              <label>Category ${service ? '<span class="opt">(optional)</span>' : '<span class="req">*</span>'}
                <select name="category" data-role="category" ${service ? '' : 'required'}>
                  <option value="">Choose a category</option>
                  ${categories.map((c) => `<option ${p && p.category === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                  <option value="__new">+ New category…</option>
                </select>
              </label>
              ${service ? `<label class="full">Description <span class="opt">(optional)</span>
                <input name="description" placeholder="What the job covers" value="${esc(p ? p.description || '' : '')}"></label>` : `
              <label>Brand
                <input name="brand" list="brand-list" placeholder="e.g. Dell" value="${esc(p ? p.brand : '')}">
                <datalist id="brand-list">${brands.map((b) => `<option value="${esc(b)}"></option>`).join('')}</datalist>
              </label>
              <label>Model <span class="opt">(optional)</span>
                <input name="model" placeholder="e.g. 3530" value="${esc(p ? p.model : '')}"></label>`}
            </div>
          </div>

          <div class="form-section">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px">
              <span class="section-label">Tax &amp; Identification</span>
              <span class="tag blue" data-role="auto-tax" hidden>✓ Filled from category — change if needed</span>
            </div>
            <div class="form-grid">
              <label>HSN/SAC code <span class="req">*</span>
                <input name="hsn_code" data-role="hsn" list="hsn-list" placeholder="${service ? 'e.g. 998713' : 'e.g. 84713010'}"
                  value="${esc(p ? p.hsn_code || '' : '')}" required>
                <datalist id="hsn-list"></datalist>
              </label>
              <label>GST rate <span class="req">*</span>
                <select name="gst_rate" data-role="gst">
                  ${[5, 12, 18, 28].map((r) => `<option value="${r}" ${p && Number(p.gst_rate) === r ? 'selected' : (!p && r === 18 ? 'selected' : '')}>${r}%</option>`).join('')}
                </select>
                <div class="hint">Billed as CGST + SGST, half each.</div>
              </label>
            </div>
          </div>

          <div class="form-section">
            <span class="section-label">Pricing</span>
            <div class="form-grid">
              <label>${service ? 'Cost to you' : 'Purchase price'} <span class="opt">(optional)</span>
                <div class="money-field"><span>₹</span>
                  <input name="purchase_price" data-role="buy" type="number" step="0.01" placeholder="${service ? '0' : '45000'}" value="${p ? p.purchase_price : ''}"></div>
                ${service ? '' : '<div class="hint">Updates automatically from your latest purchase.</div>'}
              </label>
              <label>${service ? 'Service charge' : 'Selling price'} <span class="req">*</span>
                <div class="money-field"><span>₹</span>
                  <input name="selling_price" data-role="sell" type="number" step="0.01" placeholder="${service ? '500' : '52000'}" value="${p ? p.selling_price : ''}" required></div>
                <div class="hint good" data-role="margin" hidden></div>
              </label>
            </div>
          </div>

          ${service ? '' : `<div class="form-section">
            <span class="section-label">Inventory</span>
            <div class="form-grid" style="align-items:start">
              <label>Minimum stock
                <input name="min_stock" type="number" step="1" value="${p ? p.min_stock : 3}">
                <div class="hint">We'll warn you when stock falls to this number.</div>
              </label>
              <label>Shelf location <span class="opt">(optional)</span>
                <input name="location" placeholder="e.g. Display shelf A" value="${esc(p ? p.location || '' : '')}">
              </label>
              ${p || !openingStock ? '' : `<label>Opening stock <span class="opt">(optional)</span>
                <input name="opening_stock" type="number" step="1" value="0">
                <div class="hint">What you already have on the shelf today.</div></label>`}
              <label class="check boxed" style="margin-top:24px">
                <input type="checkbox" name="serial_tracked" ${p ? (p.serial_tracked ? 'checked' : '') : 'checked'}>
                <span>Track serial numbers
                  <span class="hint">Recommended for laptops, processors and monitors.</span></span>
              </label>
            </div>
          </div>`}
        </form>`;
  }

  /**
   * Wire the product form inside root and return save(), which creates or
   * updates the record and resolves to it, or to null when nothing was saved.
   */
  function wireProductForm(root, p, categories, { service = false } = {}) {
    const form = root.querySelector('form.product-form');
    const field = (role) => form.querySelector(`[data-role="${role}"]`);

    window.api.get('/api/hsn').then(({ hsn: codes }) => {
      form.querySelector('#hsn-list').innerHTML = codes
        .map((h) => `<option value="${esc(h.code)}">${esc(h.description || '')}</option>`).join('');
    }).catch(() => {});

    // Choosing a category fills the tax fields — entered once, reused everywhere.
    const categorySelect = field('category');
    categorySelect.addEventListener('change', async () => {
      if (categorySelect.value === '__new') {
        const name = await promptForCategory();
        if (!name) { categorySelect.value = p ? p.category || '' : ''; return; }
        categorySelect.insertAdjacentHTML('beforeend', `<option selected>${esc(name)}</option>`);
        categorySelect.value = name;
        return;
      }
      const chosen = categories.find((c) => c.name === categorySelect.value);
      if (chosen && chosen.hsn_code) {
        field('hsn').value = chosen.hsn_code;
        field('gst').value = String(chosen.gst_rate);
        field('auto-tax').hidden = false;
      }
    });

    const showMargin = () => {
      const buy = Number(field('buy').value);
      const sell = Number(field('sell').value);
      const hint = field('margin');
      hint.hidden = !(buy > 0 && sell > 0);
      if (!hint.hidden) hint.textContent = `Profit per unit: ${money(sell - buy)} (${((sell - buy) / buy * 100).toFixed(1)}%)`;
    };
    [field('buy'), field('sell')].forEach((el) => el.addEventListener('input', showMargin));
    showMargin();

    const invalid = (input, message) => {
      input.classList.add('invalid');
      input.closest('label').insertAdjacentHTML('beforeend', `<div class="field-error">${esc(message)}</div>`);
      input.focus();
      return null;
    };

    return async function save() {
      form.querySelectorAll('.field-error').forEach((el) => el.remove());
      form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
      const nameField = form.querySelector('[name=name]');
      if (!nameField.value.trim()) return invalid(nameField, `Please enter a ${service ? 'service' : 'product'} name.`);
      if (!service && !categorySelect.value) return invalid(categorySelect, 'Please choose a category.');
      if (!field('hsn').value.trim()) return invalid(field('hsn'), 'Please enter the HSN/SAC code.');
      if (field('sell').value === '') return invalid(field('sell'), 'Please enter the price.');
      const values = formValues(form);
      try {
        if (p) return (await window.api.put(`/api/products/${p.id}`, values)).product;
        return (await window.api.post('/api/products', values)).product;
      } catch (err) {
        if (err.status === 409 && err.details && err.details.existingId) {
          const force = await confirm('Already in your list',
            `${values.name} already exists. Add it a second time anyway?`, 'Add anyway');
          if (force) return (await window.api.post('/api/products', { ...values, force: true })).product;
          return null;
        }
        throw err;
      }
    };
  }

  const formData = () => Promise.all([window.api.get('/api/categories'), window.api.get('/api/products/filters')])
    .then(([{ categories }, { brands }]) => ({ categories, brands }));

  /**
   * Create a product (or service) in a pop-up without leaving the current
   * screen; resolves to the saved record, or null if the pop-up is closed.
   */
  async function quickAddProduct(name = '', { service = false, openingStock = true } = {}) {
    if (!window.api.isAdmin()) {
      toast(`Only the owner can add a new ${service ? 'service' : 'product'}. Ask them to add it.`, 'warn');
      return null;
    }
    const { categories, brands } = await formData();
    let save;
    return modal({
      title: service ? 'Add New Service' : 'Add New Product',
      confirmLabel: service ? 'Save Service' : 'Save Product',
      wide: true,
      body: productFormHtml(null, { categories, brands, service, name, openingStock }),
      onRender: (root) => {
        save = wireProductForm(root, null, categories, { service });
        root.querySelector('[name=name]').focus();
      },
      onConfirm: async () => {
        const product = await save();
        if (!product) return undefined; // keep the pop-up open to fix the form
        toast(`${product.name} saved.`, 'success');
        return product;
      },
    });
  }

  async function addProduct(view, id, { service = false } = {}) {
    const [{ categories, brands }, existing] = await Promise.all([
      formData(),
      id ? window.api.get(`/api/products/${id}`) : Promise.resolve(null),
    ]);
    const p = existing ? existing.product : null;
    const isService = service || !!(p && p.item_type === 'SERVICE');
    const back = isService
      ? { href: '#/inventory/services', label: 'Services' }
      : { href: '#/inventory/list', label: 'Products' };
    const noun = isService ? 'Service' : 'Product';

    view.innerHTML = `
      <div style="max-width:820px">
        ${pageHead({
    title: p ? `Edit ${noun}` : `Add ${noun}`,
    sub: isService
      ? 'Services are billed on invoices like products, but never use stock. <span class="req">*</span> Required'
      : 'Enter these details once — they fill in automatically on every purchase and invoice. <span class="req">*</span> Required',
    back,
  })}

        ${p || isService ? '' : `
        <div class="card" id="scan-card">
          <div class="card-head">
            <div><h2>Have the supplier's bill?</h2>
              <p>Upload one or several invoices and we'll read the products out of them — you check before anything is saved.</p></div>
          </div>
          <div class="pad">
            <div class="form-grid">
              <label class="full">Supplier invoices (PDF, Excel, CSV or text — several at once)
                <input type="file" id="scan-files" multiple accept=".pdf,.csv,.txt,.tsv,.xlsx,.xls,image/*"></label>
            </div>
            <div class="btn-row" style="margin-top:12px"><button class="btn" id="scan-btn" type="button">Read invoices</button></div>
            <div id="scan-status" style="margin-top:12px"></div>
            <div id="scan-results"></div>
          </div>
        </div>`}

        ${productFormHtml(p, { categories, brands, service: isService })}

        <div class="btn-row end" style="margin-top:20px">
          <a class="link-btn quiet" href="${back.href}">Cancel</a>
          <button class="btn primary" id="save">${p ? 'Save Changes' : `Save ${noun}`}</button>
        </div>
      </div>`;

    const save = wireProductForm(view, p, categories, { service: isService });
    view.querySelector('#save').addEventListener('click', async () => {
      try {
        const saved = await save();
        if (!saved) return;
        toast(`${saved.name} saved.`);
        window.location.hash = isService ? '#/inventory/services' : `#/inventory/product/${saved.id}`;
      } catch (err) { errorToast(err); }
    });

    if (!p && !isService) setupInvoiceScan(view);
  }

  // ---------- Services ----------
  async function services(view) {
    const admin = window.api.isAdmin();
    view.innerHTML = `
      ${pageHead({
    title: 'Services',
    sub: 'Installation, repairs and other work you bill for. Services appear on invoices but never change stock.',
    actions: admin ? '<a class="btn primary" href="#/inventory/add-service">+ Add Service</a>' : '',
  })}
      <div class="filters">${searchField('q', 'Search services…')}</div>
      <div class="card" id="list">${skeleton(5)}</div>`;

    const load = async () => {
      const { products: rows } = await window.api.get('/api/products', {
        q: view.querySelector('#q').value.trim(), type: 'SERVICE', limit: 300,
      });
      const list = view.querySelector('#list');
      list.innerHTML = rows.length ? `${table(rows, [
        {
          label: 'Service',
          render: (p) => `<div style="font-weight:500">${esc(p.name)}</div>
            <div class="sub">${esc(p.product_code)}${p.description ? ` · ${esc(p.description)}` : ''}</div>`,
        },
        { label: 'SAC', num: true, render: (p) => esc(p.hsn_code || '—') },
        { label: 'GST', num: true, render: (p) => `${Number(p.gst_rate)}%` },
        { label: 'Charge', num: true, render: (p) => money(p.selling_price) },
        ...(admin ? [{
          label: '', noLabel: true,
          render: () => rowActions([
            { label: 'Edit', action: 'edit' },
            { label: 'Delete', action: 'delete', danger: true },
          ]),
        }] : []),
      ], { rowAttrs: (p) => `data-id="${p.id}"${admin ? ` data-href="#/inventory/add-service/${p.id}"` : ''}` })}
        <div class="table-foot"><span>Showing ${rows.length} service${rows.length === 1 ? '' : 's'}</span></div>`
        : `<div class="empty"><h3>No services yet</h3>
            <p>Add the work you charge for, such as installation or repairs, to bill it on invoices.</p></div>`;
      wireLinks(list);
      wireRowActions(list, {
        edit: (row) => { window.location.hash = `#/inventory/add-service/${row.dataset.id}`; },
        delete: async (row) => {
          const service = rows.find((p) => String(p.id) === row.dataset.id);
          const ok = await confirm(`Delete ${service.name}?`,
            'It will be removed from your services. Past invoices stay unchanged.', 'Delete Service', true);
          if (!ok) return;
          try {
            await window.api.del(`/api/products/${service.id}`);
            toast(`${service.name} deleted.`);
            load();
          } catch (err) { errorToast(err); }
        },
      });
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
    await load();
  }

  const promptForCategory = () => modal({
    title: 'New category',
    confirmLabel: 'Add category',
    body: `<label>Category name<input name="name" placeholder="e.g. Printers"></label>
      <label>Default HSN code <span class="opt">(optional)</span><input name="hsn_code" placeholder="e.g. 84433100"></label>
      <label>Default GST rate<select name="gst_rate">
        ${[5, 12, 18, 28].map((r) => `<option value="${r}" ${r === 18 ? 'selected' : ''}>${r}%</option>`).join('')}
      </select></label>`,
    onConfirm: async (root) => {
      const values = formValues(root);
      if (!values.name) { toast('Give the category a name.', 'error'); return undefined; }
      await window.api.post('/api/categories', values);
      return values.name;
    },
  });

  // ---------- Add stock ----------
  const queryParam = (key) => {
    const raw = (window.location.hash.split('?')[1] || '');
    return new URLSearchParams(raw).get(key) || '';
  };

  async function addStock(view) {
    const preset = queryParam('product');
    view.innerHTML = `
      ${pageHead({ title: 'Add Stock', sub: 'Book new units in — by reading the supplier bill, or by hand.' })}
      <div id="flow"></div>`;
    const flow = view.querySelector('#flow');

    const chooser = () => {
      flow.innerHTML = `
        <div class="choices">
          <button class="choice" id="pick-scan" type="button">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#1A6C8C" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2M8 9h8M8 12h8M8 15h5"/></svg>
            <span class="title">Scan Supplier Invoice</span>
            <span class="desc">Upload a PDF, spreadsheet or text bill. We read the products, quantities and prices for you.</span>
            <span class="flag">Fastest · Recommended</span>
          </button>
          <button class="choice" id="pick-manual" type="button">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#1A6C8C" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
            <span class="title">Manual Entry</span>
            <span class="desc">Pick a product and type the quantity. Good for one or two items.</span>
          </button>
        </div>`;
      flow.querySelector('#pick-scan').addEventListener('click', () => { window.location.hash = '#/purchases/add'; });
      flow.querySelector('#pick-manual').addEventListener('click', manual);
    };

    function manual() {
      flow.innerHTML = `
        <a class="back-link" id="back-choose" href="#/inventory/add">← Choose another way</a>
        <div style="max-width:720px">
          <form class="card" id="form">
            <div class="pad" style="display:flex;flex-direction:column;gap:18px">
              <div id="product-pick"></div>
              <div id="selected" hidden></div>
              <div class="form-grid">
                <label>Quantity <span class="req">*</span>
                  <div class="stepper-input" style="margin-top:6px">
                    <button type="button" id="minus" aria-label="Decrease">−</button>
                    <input name="qty" id="qty" type="number" min="1" step="1" value="1">
                    <button type="button" id="plus" aria-label="Increase">+</button>
                  </div>
                </label>
                <label>Purchase price (per unit)
                  <div class="money-field"><span>₹</span><input name="purchase_price" type="number" step="0.01"></div>
                  <div class="hint" id="last-price" hidden></div>
                </label>
                <label>Supplier invoice no <span class="opt">(optional)</span><input name="supplier_invoice_no"></label>
                <label>Invoice date<input name="invoice_date" type="date" value="${window.ui.todayIso()}"></label>
              </div>
              <div id="supplier-pick"></div>
              <div id="serial-block" hidden>
                <label>Serial numbers
                  <textarea name="serials" placeholder="Scan or type one serial per line"></textarea></label>
                <div class="hint">Leave blank to add the units now and record their serials later.</div>
              </div>
            </div>
            <div class="card-foot">
              <a class="link-btn quiet" href="#/inventory">Cancel</a>
              <button class="btn primary" type="submit" id="submit" disabled>Add Stock</button>
            </div>
          </form>
        </div>`;

      let selected = null;
      let supplierId = null;
      const qtyInput = flow.querySelector('#qty');
      flow.querySelector('#minus').addEventListener('click', () => { qtyInput.value = Math.max(1, Number(qtyInput.value) - 1); });
      flow.querySelector('#plus').addEventListener('click', () => { qtyInput.value = Number(qtyInput.value) + 1; });
      flow.querySelector('#back-choose').addEventListener('click', (e) => { e.preventDefault(); chooser(); });

      const choose = async (product) => {
        selected = product;
        const box = flow.querySelector('#selected');
        box.hidden = false;
        box.className = 'autofill';
        box.innerHTML = `<div class="head">✓ Filled in automatically from the product</div>
          <div class="facts">
            <span>${esc(product.name)}</span>
            <span>HSN <b>${esc(product.hsn_code || '—')}</b></span>
            <span>GST <b>${product.gst_rate}%</b></span>
            <span>In stock <b>${qty(product.stock)}</b></span>
          </div>`;
        flow.querySelector('[name=purchase_price]').value = product.purchase_price || '';
        flow.querySelector('#serial-block').hidden = !product.serial_tracked;
        flow.querySelector('#submit').disabled = false;

        try {
          const detail = await window.api.get(`/api/products/${product.id}`);
          const hint = flow.querySelector('#last-price');
          if (detail.stats.lastPurchasePrice) {
            hint.hidden = false;
            hint.textContent = `Last time you paid ${money(detail.stats.lastPurchasePrice)}`
              + (detail.stats.lastSupplier ? ` to ${detail.stats.lastSupplier}` : '');
          }
        } catch { /* the hint is a nicety */ }
      };

      productSearch(flow.querySelector('#product-pick'), choose,
        { label: 'Product', createOptions: { openingStock: false } });
      partySearch(flow.querySelector('#supplier-pick'), 'suppliers', (s) => { supplierId = s.id; },
        { label: 'Supplier (optional)' });
      if (preset) window.api.get(`/api/products/${preset}`).then(({ product }) => choose(product)).catch(() => {});

      flow.querySelector('#form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!selected) { toast('Choose a product first.', 'error'); return; }
        const values = formValues(e.target);
        const serials = String(values.serials || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        try {
          const res = await window.api.post('/api/inventory/add-stock', {
            product_id: selected.id, qty: values.qty, purchase_price: values.purchase_price,
            supplier_id: supplierId, supplier_invoice_no: values.supplier_invoice_no,
            invoice_date: values.invoice_date, serials,
          });
          done(res, values.qty);
        } catch (err) { errorToast(err); }
      });

      const done = (res, added) => {
        flow.innerHTML = `<div class="card done-panel">
          <div class="glyph ok">✓</div>
          <h2>${qty(added)} unit${added === 1 ? '' : 's'} added to inventory</h2>
          <p>Purchase ${esc(res.purchaseNo)} is saved. ${esc(selected.name)} is now at ${qty(res.balance)}.</p>
          <div class="btn-row" style="justify-content:center">
            <a href="#/inventory/product/${selected.id}">View product</a>
            <a href="#/inventory/add" id="again">Add more stock</a>
            <a href="#/inventory">Go to Inventory</a>
          </div>
        </div>`;
        flow.querySelector('#again').addEventListener('click', (e) => { e.preventDefault(); manual(); });
      };
    }

    if (preset) manual(); else chooser();
  }

  // ---------- Stock movements ----------
  async function movements(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Stock Movements',
    sub: 'Every time stock goes in or out. Click a row to open its bill.',
    actions: window.api.isAdmin() ? '<a class="btn primary" href="#/inventory/adjust">Adjust Stock</a>' : '',
  })}
      <div class="filters">
        <select id="type" aria-label="Type">
          <option value="">All types</option>
          ${Object.entries(MOVEMENT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <select id="period" aria-label="Date">
          <option value="month">This month</option>
          <option value="last30">Last 30 days</option>
          <option value="year">This year</option>
          <option value="all">Everything</option>
        </select>
      </div>
      <div class="card" id="list">${skeleton(8)}</div>`;

    const load = async () => {
      const { from, to } = window.ui.range(view.querySelector('#period').value);
      const { movements: rows } = await window.api.get('/api/inventory/movements', {
        type: view.querySelector('#type').value, from, to, limit: 300,
      });
      const list = view.querySelector('#list');
      list.innerHTML = rows.length ? table(rows, [
        { label: 'Date', render: (r) => dateTime(r.created_at) },
        {
          label: 'Type',
          render: (r) => `${esc(MOVEMENT_LABEL[r.type] || r.type)}${r.reason ? `<span class="muted"> · ${esc(r.reason)}</span>` : ''}`,
        },
        { label: 'Product', render: (r) => esc(r.product_name) },
        {
          label: 'Quantity',
          num: true,
          render: (r) => `<span style="color:${r.qty > 0 ? 'var(--green)' : 'var(--red-text)'};font-weight:500">${r.qty > 0 ? '+' : ''}${qty(r.qty)}</span>`,
        },
        { label: 'Stock after', num: true, render: (r) => qty(r.balance_after) },
        { label: 'Reference', class: 'doc', render: (r) => esc(r.reference_no || '—') },
        { label: 'By', render: (r) => `<span class="muted">${esc(r.user_name || '—')}</span>` },
      ], { rowAttrs: (r) => `data-href="#/inventory/product/${r.product_id}"` })
        : '<div class="empty"><h3>No movements yet</h3><p>Stock going in and out will be listed here.</p></div>';
      wireLinks(list);
    };
    ['#type', '#period'].forEach((s) => view.querySelector(s).addEventListener('change', load));
    await load();
  }

  // ---------- Adjust stock ----------
  const REASONS = ['Damaged', 'Lost', 'Missing', 'Warranty Replacement', 'Manual Correction', 'Other'];

  async function adjust(view) {
    const preset = queryParam('product');
    view.innerHTML = `
      <div style="max-width:720px">
        ${pageHead({
    title: 'Adjust Stock',
    sub: "Use this when the count on the shelf doesn't match the system.",
  })}
        <form class="card" id="form">
          <div class="pad" style="display:flex;flex-direction:column;gap:18px">
            <div id="product-pick"></div>
            <div class="tiles" style="margin:0">
              <div class="kpi compact"><div class="label">System stock</div><div class="value" id="current">—</div></div>
              <div class="kpi compact"><div class="label">Physical stock</div>
                <input name="physical" id="physical" type="number" step="1" style="margin-top:6px"></div>
              <div class="kpi compact"><div class="label">Difference</div><div class="value" id="difference">—</div></div>
            </div>
            <label>Reason <span class="req">*</span>
              <select name="reason">${REASONS.map((r) => `<option>${r}</option>`).join('')}</select>
            </label>
            <label>Note <span class="opt">(optional)</span>
              <input name="note" placeholder="e.g. Screen cracked during unpacking"></label>
          </div>
          <div class="card-foot">
            <a class="link-btn quiet" href="#/inventory/movements">Cancel</a>
            <button class="btn primary" type="submit" id="submit" disabled>Save Adjustment</button>
          </div>
        </form>
      </div>`;

    let selected = null;
    const currentEl = view.querySelector('#current');
    const diffEl = view.querySelector('#difference');
    const physical = view.querySelector('#physical');

    const refreshDiff = () => {
      if (!selected || physical.value === '') { diffEl.textContent = '—'; return; }
      const diff = Number(physical.value) - Number(selected.stock);
      diffEl.textContent = `${diff > 0 ? '+' : ''}${qty(diff)}`;
      diffEl.style.color = diff === 0 ? '' : (diff > 0 ? 'var(--green)' : 'var(--red-text)');
    };

    const choose = (product) => {
      selected = product;
      currentEl.textContent = qty(product.stock);
      physical.value = product.stock;
      view.querySelector('#submit').disabled = false;
      refreshDiff();
    };
    productSearch(view.querySelector('#product-pick'), choose,
      { label: 'Product', createOptions: { openingStock: false } });
    physical.addEventListener('input', refreshDiff);
    if (preset) window.api.get(`/api/products/${preset}`).then(({ product }) => choose(product)).catch(() => {});

    view.querySelector('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selected) { toast('Choose a product first.', 'error'); return; }
      const values = formValues(e.target);
      const diff = Number(values.physical) - Number(selected.stock);
      if (!diff) { toast('The physical count already matches the system.', 'warn'); return; }

      const ok = await modal({
        title: 'Adjust stock?',
        confirmLabel: 'Confirm Adjustment',
        body: `<div class="summary-line"><span class="muted">Product</span><strong>${esc(selected.name)}</strong></div>
          <div class="summary-line"><span class="muted">Current</span><strong>${qty(selected.stock)}</strong></div>
          <div class="summary-line"><span class="muted">New</span><strong>${qty(values.physical)}</strong></div>
          <div class="summary-line"><span class="muted">Reason</span><strong>${esc(values.reason)}</strong></div>
          <p class="muted">Stock will change from <strong>${qty(selected.stock)} → ${qty(values.physical)}</strong>.</p>`,
        onConfirm: () => true,
      });
      if (!ok) return;

      try {
        const res = await window.api.post('/api/inventory/adjust', {
          product_id: selected.id, new_qty: values.physical, reason: values.reason, note: values.note,
        });
        toast(`Stock adjusted (${res.adjustmentNo}). ${selected.name} is now at ${qty(res.balance)}.`);
        window.location.hash = `#/inventory/product/${selected.id}`;
      } catch (err) { errorToast(err); }
    });
  }

  // ---------- Low stock ----------
  async function lowStock(view) {
    const { items, outOfStock, low } = await window.api.get('/api/inventory/low-stock');
    view.innerHTML = `
      ${pageHead({
    title: 'Low Stock',
    sub: items.length
      ? `${low} product${low === 1 ? '' : 's'} running low, ${outOfStock} out of stock.`
      : 'Nothing is below its minimum right now.',
  })}
      <div class="card" id="list"></div>`;

    const list = view.querySelector('#list');
    list.innerHTML = items.length ? items.map((p) => `
      <div class="row-link">
        <div class="grow" style="cursor:pointer" data-href="#/inventory/product/${p.id}">
          <div style="font-weight:500">${esc(p.name)}</div>
          <div class="small muted">
            <strong>${p.stock <= 0 ? 'Out of stock' : `${qty(p.stock)} left`}</strong>
            · Minimum: ${qty(p.min_stock)}${p.usual_supplier ? ` · Usually from ${esc(p.usual_supplier)}` : ''}
          </div>
        </div>
        <span class="tag ${p.stock <= 0 ? 'red' : 'amber'}">${p.stock <= 0 ? 'Out of Stock' : 'Low Stock'}</span>
        <a href="#/inventory/add?product=${p.id}">Add stock →</a>
      </div>`).join('')
      : `<div class="empty"><h3>Everything is in stock</h3>
          <p>Products fall into this list when they reach their minimum level.</p>
          <a class="btn" href="#/inventory">Back to Inventory</a></div>`;
    wireLinks(list);
  }

  // ---------- Serial numbers ----------
  async function serials(view) {
    const state = { q: '', status: '' };
    view.innerHTML = `
      ${pageHead({
    title: 'Serial Numbers',
    sub: 'Find any unit by its serial number — see where it came from and who bought it.',
  })}
      <div class="filters">
        ${searchField('q', 'Search serial number…')}
        <div class="segmented" id="status-filter">
          ${[['', 'All'], ['AVAILABLE', 'Available'], ['SOLD', 'Sold']].map(([k, l]) =>
    `<button data-status="${k}" class="${state.status === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="card" id="list">${skeleton(8)}</div>`;

    const load = async () => {
      const { serials: rows } = await window.api.get('/api/inventory/serials', {
        q: state.q, status: state.status, limit: 300,
      });
      const list = view.querySelector('#list');
      list.innerHTML = rows.length ? table(rows, [
        { label: 'Serial Number', render: (r) => `<strong>${esc(r.serial)}</strong>` },
        { label: 'Product', render: (r) => esc(r.product_name) },
        { label: 'Status', noLabel: true, render: (r) => statusTag(r.status) },
        { label: 'Invoice', class: 'doc', render: (r) => esc(r.invoice_no || '—') },
      ], { rowAttrs: (r) => `data-serial="${r.id}"` })
        : `<div class="empty"><h3>No serial number ${state.q ? `“${esc(state.q)}”` : 'yet'}</h3>
            <p>Check the sticker on the box — letters like O and 0 are easy to mix up.</p></div>`;

      list.querySelectorAll('[data-serial]').forEach((tr) => tr.addEventListener('click', () => showSerial(tr.dataset.serial)));
    };

    view.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
      state.status = b.dataset.status;
      view.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
      load();
    }));
    let timer;
    view.querySelector('#q').addEventListener('input', (e) => {
      state.q = e.target.value.trim();
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    });
    await load();
  }

  /** One unit's whole life, from the supplier bill to the customer's invoice. */
  async function showSerial(id) {
    const { serial, timeline } = await window.api.get(`/api/inventory/serials/${id}`);
    await modal({
      title: serial.serial,
      confirmLabel: '',
      cancelLabel: 'Close',
      body: `
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div><div class="muted small">${esc(serial.product_name)}</div>
            <div class="small muted">${esc(serial.product_code)}</div></div>
          ${statusTag(serial.status)}
        </div>
        ${timeline.map((t) => `
          <div class="row-link" style="padding:12px 0">
            <div class="small muted" style="width:110px">${date(t.date)}</div>
            <div class="grow"><div style="font-weight:500">${esc(t.what)}</div>
              <div class="small muted">${esc(t.detail)}</div></div>
          </div>`).join('')}`,
    });
  }

  // ---------- Product detail ----------
  async function productDetail(view, id) {
    const data = await window.api.get(`/api/products/${id}`);
    const p = data.product;
    const admin = window.api.isAdmin();
    const showCosts = window.api.can('costs');
    const facts = [
      ['Brand', p.brand || '—'], ['Model', p.model || '—'], ['Category', p.category || 'Uncategorised'],
      ['HSN code', p.hsn_code || '—'], ['GST', `${p.gst_rate}%`], ['Selling price', money(p.selling_price)],
    ];
    if (showCosts) {
      facts.push(['Purchase price', money(p.purchase_price)],
        ['Profit per unit', money(p.selling_price - p.purchase_price)]);
    }
    facts.push(['Serial tracking', p.serial_tracked ? 'Yes' : 'No'], ['Location', p.location || 'Not set']);

    view.innerHTML = `
      ${pageHead({
    title: `${esc(p.name)} ${stockTag(p)}`,
    sub: `Product ID ${esc(p.product_code)} · ${esc(p.category || 'Uncategorised')}`,
    actions: `
      <button class="btn primary" data-do="sell">Sell this product</button>
      <button class="btn" data-do="stock">Add stock</button>
      ${admin ? `<button class="btn" data-do="edit">Edit product</button>
        <button class="btn" data-do="adjust">Correct stock count</button>
        <button class="btn danger" data-do="delete">Delete product</button>` : ''}`,
  })}
      ${tiles([
    { label: 'Current Stock', value: qty(p.stock) },
    { label: 'Minimum Stock', value: qty(p.min_stock) },
    ...(showCosts ? [{ label: 'Stock Value', value: money(data.stats.stockValue) }] : []),
    { label: 'Sold This Month', value: qty(data.stats.soldThisMonth) },
  ])}
      ${data.ledgerStock !== undefined && Math.abs(data.ledgerStock - p.stock) > 0.001 ? `
        <div class="alert warn"><span class="glyph">!</span>
          <div>The ledger totals ${qty(data.ledgerStock)} but the product shows ${qty(p.stock)}. Ask for a stock check.</div>
        </div>` : ''}
      <div class="page-section">
        <h2>Details</h2>
        <div class="card"><div class="facts">
          ${facts.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}
        </div></div>
      </div>

      <div class="page-section">
        <h2>Stock History</h2>
        <div id="sec-history"></div>
      </div>
      <div class="page-section">
        <h2>Sales</h2>
        <div id="sec-sales"></div>
      </div>
      ${admin ? `<div class="page-section">
        <h2>Purchases</h2>
        <div id="sec-purchases"></div>
      </div>` : ''}
      ${p.serial_tracked ? `<div class="page-section">
        <h2>Serial Numbers</h2>
        <div id="sec-serials"></div>
      </div>` : ''}`;

    const section = (id) => view.querySelector(`#${id}`);

    section('sec-history').innerHTML = `<div class="card">${table(data.movements, [
          { label: 'Date', render: (m) => dateTime(m.created_at) },
          {
            label: 'Type',
            render: (m) => `${esc(MOVEMENT_LABEL[m.type] || m.type)}${m.reason ? `<span class="muted"> · ${esc(m.reason)}</span>` : ''}`,
          },
          { label: 'Quantity', num: true, render: (m) => `${m.qty > 0 ? '+' : ''}${qty(m.qty)}` },
          { label: 'Stock after', num: true, render: (m) => qty(m.balance_after) },
          { label: 'Reference', class: 'doc', render: (m) => esc(m.reference_no || '—') },
    ], { empty: 'Nothing has moved yet.', clickable: false })}</div>`;

    section('sec-sales').innerHTML = `<div class="card">${table(data.sales, [
          { label: 'Invoice', class: 'doc', render: (s) => esc(s.invoice_no) },
          { label: 'Customer', render: (s) => esc(s.customer_name || 'Walk-in') },
          { label: 'Date', render: (s) => date(s.invoice_date) },
          { label: 'Qty', num: true, render: (s) => qty(s.qty) },
          { label: 'Amount', num: true, render: (s) => money(s.total) },
    ], { rowAttrs: (s) => `data-href="#/sales/invoice/${s.invoice_id}"`, empty: 'This product has not been sold yet.' })}</div>`;

    if (section('sec-purchases')) section('sec-purchases').innerHTML = `<div class="card">${table(data.purchases, [
          { label: 'Purchase #', class: 'doc', render: (r) => esc(r.purchase_no) },
          { label: 'Supplier', render: (r) => esc(r.supplier_name || '—') },
          { label: 'Date', render: (r) => date(r.invoice_date) },
          { label: 'Qty', num: true, render: (r) => qty(r.qty) },
          { label: 'Rate', num: true, render: (r) => money(r.unit_price) },
    ], { rowAttrs: (r) => `data-href="#/purchases/${r.purchase_id}"`, empty: 'No purchases recorded for this product.' })}</div>`;

    if (section('sec-serials')) section('sec-serials').innerHTML = `<div class="card">${table(data.serials, [
        { label: 'Serial number', render: (s) => `<strong>${esc(s.serial)}</strong>` },
        { label: 'Status', noLabel: true, render: (s) => statusTag(s.status) },
        { label: 'Invoice', class: 'doc', render: (s) => esc(s.invoice_no || '—') },
        { label: 'Purchased', render: (s) => (s.purchased_on ? date(s.purchased_on) : date(s.created_at)) },
    ], { empty: 'No serial numbers recorded for this product.', clickable: false })}</div>`;

    wireLinks(view);

    const actions = {
      edit: () => { window.location.hash = `#/inventory/add-product/${p.id}`; },
      stock: () => { window.location.hash = `#/inventory/add?product=${p.id}`; },
      adjust: () => { window.location.hash = `#/inventory/adjust?product=${p.id}`; },
      sell: () => { window.location.hash = `#/sales/new?product=${p.id}`; },
      delete: async () => {
        const ok = await modal({
          title: `Delete ${p.name}?`,
          confirmLabel: 'Delete Product',
          danger: true,
          body: '<p>It will be removed from your product list. Past invoices and purchases stay unchanged.</p>',
          onConfirm: () => true,
        });
        if (!ok) return;
        try {
          await window.api.del(`/api/products/${p.id}`);
          toast(`${p.name} deleted.`);
          window.location.hash = '#/inventory/list';
        } catch (err) { errorToast(err); }
      },
    };
    view.querySelectorAll('[data-do]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.do]()));
  }

  async function hsn(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'HSN Codes',
    sub: 'HSN classifies goods for tax. Products carry an HSN; invoices pick it up automatically.',
    actions: window.api.isAdmin() ? '<button class="btn primary" id="add">+ Add HSN</button>' : '',
  })}
      <div class="filters">${searchField('q', 'Search by code or description…')}</div>
      <div class="card" id="list">${skeleton(6)}</div>`;

    const load = async () => {
      const { hsn: rows } = await window.api.get('/api/hsn', { q: view.querySelector('#q').value.trim() });
      view.querySelector('#list').innerHTML = table(rows, [
        { key: 'code', label: 'HSN Code', render: (r) => `<strong>${esc(r.code)}</strong>` },
        { key: 'description', label: 'Description', render: (r) => esc(r.description || '-') },
        { key: 'gst_rate', label: 'GST Rate', num: true, render: (r) => `${r.gst_rate}%` },
        { key: 'products', label: 'Products', num: true },
        {
          key: 'actions',
          label: '',
          render: (r) => (window.api.isAdmin() ? `<button class="btn small" data-edit="${r.id}">Edit</button>` : ''),
        },
      ], { empty: 'No HSN codes yet.', clickable: false });

      view.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', async () => {
        const row = rows.find((r) => String(r.id) === btn.dataset.edit);
        const saved = await modal({
          title: `Edit HSN ${row.code}`,
          confirmLabel: 'Save',
          body: `<div class="form-grid">
              <label>HSN Code<input name="code" value="${esc(row.code)}"></label>
              <label>GST Rate (%)<input name="gst_rate" type="number" step="0.01" value="${row.gst_rate}"></label>
              <label class="full">Description<input name="description" value="${esc(row.description || '')}"></label>
              <label class="check full"><input type="checkbox" name="apply_gst_to_products"> Apply this GST rate to all ${row.products} product(s) using it</label>
            </div>`,
          onConfirm: async (root) => window.api.put(`/api/hsn/${row.id}`, formValues(root)),
        });
        if (saved) { toast('HSN updated.', 'success'); load(); }
      }));
    };

    const addBtn = view.querySelector('#add');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const created = await modal({
          title: 'Add HSN Code',
          confirmLabel: 'Save',
          body: `<div class="form-grid">
              <label>HSN Code *<input name="code" placeholder="84713010"></label>
              <label>GST Rate (%)<input name="gst_rate" type="number" step="0.01" value="18"></label>
              <label class="full">Description<input name="description" placeholder="Laptops and portable computers"></label>
            </div>`,
          onConfirm: async (root) => window.api.post('/api/hsn', formValues(root)),
        });
        if (created) { toast('HSN added.', 'success'); load(); }
      });
    }
    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    await load();
  }
  // ---------- Create products from scanned invoices ----------
  const SCAN_WARNINGS = {
    NO_PRODUCT_MATCH: 'New product',
    LOW_CONFIDENCE_MATCH: 'Low confidence match - check the name',
    HSN_NOT_IDENTIFIED: 'HSN could not be identified',
    PRICE_NOT_IDENTIFIED: 'Purchase price could not be read',
  };

  /**
   * Upload one or more supplier invoices, list every product found across
   * them, and create the selected ones - optionally booking the quantities in
   * as stock through the normal purchase flow.
   */
  function setupInvoiceScan(view) {
    const statusHost = view.querySelector('#scan-status');
    const resultsHost = view.querySelector('#scan-results');
    let rows = [];
    let invoices = [];

    view.querySelector('#scan-btn').addEventListener('click', async () => {
      const input = view.querySelector('#scan-files');
      if (!input.files.length) { toast('Choose one or more invoice files first.', 'error'); return; }
      const form = new FormData();
      [...input.files].forEach((file) => form.append('files', file));
      statusHost.innerHTML = `<div class="alert info">Reading ${input.files.length} invoice(s)…</div>`;
      resultsHost.innerHTML = '';
      try {
        const data = await window.api.post('/api/purchases/extract', form);
        const results = data.results || [data];
        invoices = results;
        const failed = results.filter((r) => !r.ok);
        rows = [];
        results.forEach((result, fileIndex) => {
          (result.items || []).forEach((item) => {
            rows.push({
              fileIndex,
              fileName: result.fileName,
              selected: !item.match,
              name: item.match ? item.match.name : item.description,
              description: item.description,
              productId: item.match ? item.match.productId : null,
              matchScore: item.match ? item.match.score : 0,
              category: '',
              brand: '',
              hsn: item.hsn || (item.match && item.match.hsn_code) || '',
              gstRate: item.gstRate ?? 18,
              qty: item.qty,
              purchasePrice: item.unitPrice,
              sellingPrice: Math.round(item.unitPrice * 1.15),
              serials: [],
              warnings: (item.needsVerification || []).map((w) => SCAN_WARNINGS[w] || w),
            });
          });
        });

        statusHost.innerHTML = `
          <div class="alert ${rows.length ? 'success' : 'warn'}">
            Read ${data.readCount ?? (results[0].ok ? 1 : 0)} of ${results.length} file(s) -
            ${rows.length} product line(s) found.
          </div>
          ${failed.map((f) => `<div class="alert warn">⚠ ${esc(f.fileName)}: ${esc(f.message)}</div>`).join('')}`;
        renderRows();
      } catch (err) {
        statusHost.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      }
    });

    function renderRows() {
      if (!rows.length) { resultsHost.innerHTML = ''; return; }
      const newCount = rows.filter((r) => r.selected).length;
      resultsHost.innerHTML = `
        <div class="card-head" style="margin-top:16px;border-top:1px solid var(--rule)"><h3>Review what we read</h3>
          <div class="actions">
            <label class="check" style="margin:0"><input type="checkbox" id="select-all"> Select all new</label>
          </div>
        </div>
        ${table(rows, [
          { key: 'sel', label: '', render: (r, i) => `<input type="checkbox" data-sel="${i}" ${r.selected ? 'checked' : ''}>` },
          {
            key: 'name',
            label: 'Product',
            render: (r, i) => `<input style="min-width:200px" data-f="name" data-i="${i}" value="${esc(r.name)}">
              <div class="small ${r.productId ? 'muted' : ''}">
                ${r.productId
    ? `Already in inventory (${Math.round(r.matchScore * 100)}% match) - will be skipped unless selected`
    : 'New product'}
                ${r.warnings.length ? `<span style="color:var(--warn)"> · ⚠ ${esc(r.warnings.join(', '))}</span>` : ''}
              </div>
              <div class="small muted">from ${esc(r.fileName)}</div>`,
          },
          { key: 'category', label: 'Category', render: (r, i) => `<input style="width:120px" list="category-list" data-f="category" data-i="${i}" value="${esc(r.category)}">` },
          { key: 'brand', label: 'Brand', render: (r, i) => `<input style="width:110px" data-f="brand" data-i="${i}" value="${esc(r.brand)}">` },
          { key: 'hsn', label: 'HSN', render: (r, i) => `<input style="width:96px" list="hsn-list" data-f="hsn" data-i="${i}" value="${esc(r.hsn)}">` },
          { key: 'gstRate', label: 'GST %', num: true, render: (r, i) => `<input type="number" step="0.01" style="width:74px" data-f="gstRate" data-i="${i}" value="${r.gstRate}">` },
          { key: 'qty', label: 'Qty', num: true, render: (r, i) => `<input type="number" step="1" style="width:70px" data-f="qty" data-i="${i}" value="${r.qty}">` },
          { key: 'purchasePrice', label: 'Cost', num: true, render: (r, i) => `<input type="number" step="0.01" style="width:100px" data-f="purchasePrice" data-i="${i}" value="${r.purchasePrice}">` },
          { key: 'sellingPrice', label: 'Selling', num: true, render: (r, i) => `<input type="number" step="0.01" style="width:100px" data-f="sellingPrice" data-i="${i}" value="${r.sellingPrice}">` },
        ], { clickable: false, stacked: false })}
        <div class="btn-row" style="margin-top:14px">
          <label class="check" style="margin:0"><input type="checkbox" id="also-stock" checked>
            Also add these quantities as stock (records a purchase per invoice)</label>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn primary" id="create-products">Create ${newCount} product(s)</button>
          <span class="muted small">${rows.length - newCount} line(s) already exist and will be reused.</span>
        </div>`;

      resultsHost.querySelectorAll('[data-sel]').forEach((box) => box.addEventListener('change', () => {
        rows[Number(box.dataset.sel)].selected = box.checked;
        setTimeout(renderRows, 0);
      }));
      resultsHost.querySelectorAll('[data-f]').forEach((input) => input.addEventListener('change', () => {
        const row = rows[Number(input.dataset.i)];
        const field = input.dataset.f;
        row[field] = input.type === 'number' ? Number(input.value) : input.value.trim();
        if (field === 'purchasePrice') row.sellingPrice = Math.round(Number(input.value) * 1.15);
        setTimeout(renderRows, 0);
      }));
      resultsHost.querySelector('#select-all').addEventListener('change', (e) => {
        rows.forEach((r) => { if (!r.productId) r.selected = e.target.checked; });
        renderRows();
      });
      resultsHost.querySelector('#create-products').addEventListener('click', () => confirmScan());
    }

    async function confirmScan() {
      const addStock = resultsHost.querySelector('#also-stock').checked;
      const chosen = rows.filter((r) => r.selected || (addStock && r.productId));
      if (!chosen.length) { toast('Select at least one product.', 'error'); return; }

      try {
        if (!addStock) {
          const payload = rows.filter((r) => r.selected).map((r) => ({
            name: r.name, category: r.category, brand: r.brand, hsn_code: r.hsn,
            gst_rate: r.gstRate, purchase_price: r.purchasePrice, selling_price: r.sellingPrice,
          }));
          const res = await window.api.post('/api/products/bulk', { items: payload });
          toast(`${res.createdCount} product(s) created${res.skippedCount ? `, ${res.skippedCount} skipped as duplicates` : ''}.`, 'success');
          window.location.hash = '#/inventory/list';
          return;
        }

        // One purchase per invoice file, so stock and cost history stay per supplier bill.
        let purchases = 0;
        let products = 0;
        for (let fileIndex = 0; fileIndex < invoices.length; fileIndex += 1) {
          const invoice = invoices[fileIndex];
          const lines = chosen.filter((r) => r.fileIndex === fileIndex);
          if (!lines.length) continue;
          const header = invoice.header || {};
          const res = await window.api.post('/api/purchases', {
            supplier_id: header.supplierMatch ? header.supplierMatch.supplierId : null,
            supplier_name: header.supplierMatch ? '' : (header.supplier || ''),
            supplier_gstin: header.supplierGstin || '',
            supplier_invoice_no: header.invoiceNo || '',
            invoice_date: header.invoiceDate || '',
            source: 'SCAN',
            file_name: invoice.fileName,
            items: lines.map((r) => ({
              product_id: r.productId || undefined,
              description: r.name,
              hsn_code: r.hsn,
              qty: r.qty,
              unit_price: r.purchasePrice,
              gst_rate: r.gstRate,
              needs_review: r.warnings.length > 0,
              new_product: r.productId ? undefined : {
                name: r.name, category: r.category, brand: r.brand, hsn_code: r.hsn,
                gst_rate: r.gstRate, selling_price: r.sellingPrice,
              },
            })),
          });
          purchases += 1;
          products += lines.filter((r) => !r.productId).length;
          if (!res.purchaseNo) throw new Error('The purchase could not be recorded.');
        }
        toast(`${products} product(s) created and stock added from ${purchases} invoice(s).`, 'success');
        window.location.hash = '#/inventory/list';
      } catch (err) { errorToast(err); }
    }
  }

  // ---------- HSN Code ----------
  async function hsn(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'HSN Code',
    sub: 'View sales and tax details grouped by HSN code.',
    actions: '<button class="btn" id="export-excel">Export Excel</button>',
  })}
      <div class="filters">
        ${searchField('q', 'Search HSN number…')}
        <select id="period" aria-label="Date">
          <option value="month">This month</option>
          <option value="last30">Last 30 days</option>
          <option value="year">This year</option>
          <option value="all">Everything</option>
        </select>
      </div>
      <div class="card" id="list">${skeleton(8)}</div>`;

    const load = async () => {
      const { from, to } = window.ui.range(view.querySelector('#period').value);
      const q = view.querySelector('#q').value.trim();
      const { hsn: rows } = await window.api.get('/api/hsn', { q, from, to });
      
      const list = view.querySelector('#list');
      list.innerHTML = rows.length ? table(rows, [
        { label: 'HSN Code', class: 'doc', render: (r) => esc(r.hsn_code) },
        { label: 'Products', render: (r) => esc(r.product_names) },
        { label: 'Qty Sold', num: true, render: (r) => qty(r.qty_sold) },
        { label: 'Taxable Amount', num: true, render: (r) => rupees(r.taxable_amount) },
        { label: 'CGST (9%)', num: true, render: (r) => rupees(r.cgst) },
        { label: 'SGST (9%)', num: true, render: (r) => rupees(r.sgst) },
        { label: 'Total GST', num: true, render: (r) => rupees(r.total_gst) },
      ], { rowAttrs: (r) => `data-href="#/inventory/hsn/${encodeURIComponent(r.hsn_code)}"` }) : '<div class="empty"><h3>No HSN data found</h3><p>Try adjusting your search or date range.</p></div>';
      
      wireLinks(list);
      
      // Wire Export to Excel
      view.querySelector('#export-excel').onclick = () => {
        if (!rows.length) return toast('No data to export', 'error');
        
        let csv = 'HSN Code,Products,Quantity,Taxable Amount,CGST,SGST,Total GST,Invoice total amount\n';
        rows.forEach(r => {
          const names = '"' + (r.product_names || '').replace(/"/g, '""') + '"';
          const totalAmount = r.taxable_amount + r.total_gst;
          csv += `${r.hsn_code},${names},${r.qty_sold},${r.taxable_amount.toFixed(2)},${r.cgst.toFixed(2)},${r.sgst.toFixed(2)},${r.total_gst.toFixed(2)},${totalAmount.toFixed(2)}\n`;
        });
        
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `HSN_Report_${window.ui.todayIso()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      };
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    view.querySelector('#period').addEventListener('change', load);
    
    await load();
  }

  // ---------- HSN Code Detail ----------
  async function hsnDetail(view, code) {
    view.innerHTML = `
      ${pageHead({
    title: 'Loading...',
    back: '#/inventory/hsn',
  })}
      <div id="content" class="pad">${skeleton(10)}</div>`;

    try {
      const data = await window.api.get(`/api/hsn/${encodeURIComponent(code)}`);
      
      let html = `
        ${pageHead({
        title: `HSN: ${esc(data.hsn.code)}`,
        sub: esc(data.hsn.description),
        back: '#/inventory/hsn',
        actions: data.sales.length ? '<button id="export-hsn-excel" class="btn primary">Export Excel</button>' : ''
      })}
        <div class="row">
          <div class="card col">
            <div class="card-head"><h2>Details</h2></div>
            <div class="pad form-grid">
              <label>HSN Code<input value="${esc(data.hsn.code)}" readonly></label>
              <label>GST Rate<input value="${data.hsn.gst_rate}%" readonly></label>
              <label class="full">Description<input value="${esc(data.hsn.description)}" readonly></label>
            </div>
          </div>
        </div>
        
        <div class="card" style="margin-top:24px">
          <div class="card-head"><h2>Associated Products (${data.products.length})</h2></div>
          ${data.products.length ? table(data.products, [
          { label: 'Product Code', class: 'doc', render: (r) => esc(r.product_code) },
          { label: 'Name', render: (r) => esc(r.name) },
          { label: 'Brand', render: (r) => esc(r.brand) },
          { label: 'Stock', num: true, render: (r) => qty(r.stock) },
          { label: 'Selling Price', num: true, render: (r) => money(r.selling_price) },
        ], { rowAttrs: (r) => `data-href="#/inventory/product/${r.id}"` }) : '<div class="empty"><p>No products linked.</p></div>'}
        </div>
        
        <div class="card" style="margin-top:24px">
          <div class="card-head">
            <h2>Sales History</h2>
          </div>
          ${data.sales.length ? table(data.sales, [
          { label: 'Invoice No.', class: 'doc', render: (r) => esc(r.invoice_no) },
          { label: 'Date', render: (r) => date(r.invoice_date) },
          { label: 'Product', render: (r) => esc(r.product_name) },
          { label: 'Qty', num: true, render: (r) => qty(r.qty) },
          { label: 'Unit Price', num: true, render: (r) => money(r.unit_price) },
          { label: 'Taxable Amount', num: true, render: (r) => rupees(r.taxable_value) },
          { label: 'GST', num: true, render: (r) => rupees(r.gst_amount) },
          { label: 'Total', num: true, render: (r) => rupees(r.total) },
        ], { rowAttrs: (r) => `data-href="#/sales/invoice/${r.invoice_id}"` }) : '<div class="empty"><p>No sales history.</p></div>'}
        </div>
      `;
      view.innerHTML = html;
      wireLinks(view);
      
      const exportBtn = view.querySelector('#export-hsn-excel');
      if (exportBtn) {
        exportBtn.onclick = () => {
          let csv = 'Invoice number,Date,Billed to,Total Taxable amount,CGST,SGST,Total gst,Invoice total\n';
          data.sales.forEach(r => {
            const customer = '"' + (r.customer_name || 'Walk-in').replace(/"/g, '""') + '"';
            const cgst = (r.gst_amount / 2).toFixed(2);
            const sgst = (r.gst_amount / 2).toFixed(2);
            const d = new Date(r.invoice_date);
            const shortDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            csv += `${r.invoice_no},${shortDate},${customer},${r.taxable_value.toFixed(2)},${cgst},${sgst},${r.gst_amount.toFixed(2)},${r.total.toFixed(2)}\n`;
          });
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `HSN_${data.hsn.code}_Sales_${window.ui.todayIso()}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        };
      }
    } catch (err) {
      errorToast(err);
      view.innerHTML = emptyState('Error loading HSN details', err.message);
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.inventory = {
    overview, products, addProduct, addStock, movements, adjust, lowStock, serials, hsn, hsnDetail, productDetail,
    services, addService: (view, id) => addProduct(view, id, { service: true }), quickAddProduct,
  };
})();
