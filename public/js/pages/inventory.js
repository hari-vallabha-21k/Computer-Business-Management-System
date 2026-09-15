/* Inventory: product list, add/edit product, add stock, movements, low stock, serials, product detail. */
(function () {
  'use strict';
  const {
    esc, money, qty, date, dateTime, table, loading, statusTag, toast, errorToast, modal, confirm,
    productSearch, partySearch, formValues, MOVEMENT_LABEL,
  } = window.ui;

  const tabs = (active) => `
    <div class="tabs">
      <a href="#/inventory" class="${active === 'products' ? 'active' : ''}">All Products</a>
      <a href="#/inventory/add-product" class="${active === 'add-product' ? 'active' : ''}">Add Product</a>
      <a href="#/inventory/add-stock" class="${active === 'add-stock' ? 'active' : ''}">Add Stock</a>
      <a href="#/inventory/movements" class="${active === 'movements' ? 'active' : ''}">Stock Movements</a>
      <a href="#/inventory/low-stock" class="${active === 'low-stock' ? 'active' : ''}">Low Stock</a>
      <a href="#/inventory/serials" class="${active === 'serials' ? 'active' : ''}">Serial Numbers</a>
      <a href="#/inventory/hsn" class="${active === 'hsn' ? 'active' : ''}">HSN</a>
    </div>`;

  const stockTag = (p) => `<span class="tag ${p.stock <= 0 ? 'red' : (p.min_stock > 0 && p.stock <= p.min_stock ? 'amber' : 'green')}">${qty(p.stock)}</span>`;

  // ---------- Product list ----------
  async function products(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Inventory</h1><p class="muted">Search by name, brand, model, product ID, HSN or serial number.</p></div>
        <div class="actions">
          <a class="btn" href="#/inventory/add-stock">Add Stock</a>
          ${window.api.isAdmin() ? '<a class="btn primary" href="#/inventory/add-product">+ Add Product</a>' : ''}
        </div>
      </div>
      ${tabs('products')}
      <div class="card">
        <div class="filters">
          <label class="grow">Search<input type="search" id="q" placeholder="Dell 3530, CPU-001, 84713010, serial…"></label>
          <label>Category<select id="category"><option value="">All</option></select></label>
          <label>Brand<select id="brand"><option value="">All</option></select></label>
          <label class="check"><input type="checkbox" id="low"> Low stock only</label>
        </div>
      </div>
      <div class="card" id="list">${loading()}</div>`;

    const { categories, brands } = await window.api.get('/api/products/filters');
    categories.forEach((c) => view.querySelector('#category').add(new Option(c.name, c.name)));
    brands.forEach((b) => view.querySelector('#brand').add(new Option(b, b)));

    const load = async () => {
      const host = view.querySelector('#list');
      try {
        const { products: rows } = await window.api.get('/api/products', {
          q: view.querySelector('#q').value.trim(),
          category: view.querySelector('#category').value,
          brand: view.querySelector('#brand').value,
          lowStock: view.querySelector('#low').checked ? 'true' : '',
          limit: 300,
        });
        host.innerHTML = `
          <div class="card-head"><h2>${rows.length} product(s)</h2></div>
          ${table(rows, [
          { key: 'product_code', label: 'Product ID' },
          { key: 'name', label: 'Product', render: (r) => `<a href="#/inventory/product/${r.id}"><strong>${esc(r.name)}</strong></a><div class="small muted">${esc(r.brand || '')} ${esc(r.model || '')}</div>` },
          { key: 'category', label: 'Category', render: (r) => esc(r.category || '-') },
          { key: 'hsn_code', label: 'HSN', render: (r) => esc(r.hsn_code || '-') },
          { key: 'gst_rate', label: 'GST', num: true, render: (r) => `${r.gst_rate}%` },
          { key: 'purchase_price', label: 'Cost', num: true, render: (r) => money(r.purchase_price) },
          { key: 'selling_price', label: 'Price', num: true, render: (r) => money(r.selling_price) },
          { key: 'stock', label: 'Stock', num: true, render: stockTag },
          { key: 'serial_tracked', label: 'Serial', render: (r) => (r.serial_tracked ? '<span class="tag blue">Tracked</span>' : '') },
        ], { empty: 'No products match this search.' })}`;
      } catch (err) { host.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    ['#category', '#brand', '#low'].forEach((sel) => view.querySelector(sel).addEventListener('change', load));
    await load();
  }

  // ---------- Add / edit product ----------
  function productForm(product) {
    const p = product || {};
    return `
      <div class="form-grid">
        <label class="full">Product Name *<input name="name" value="${esc(p.name || '')}" required placeholder="Dell Inspiron 3530"></label>
        <label>Product ID<input name="product_code" value="${esc(p.product_code || '')}" placeholder="Auto-generated"></label>
        <label>Category<input name="category" value="${esc(p.category || '')}" list="category-list" placeholder="Laptops"><datalist id="category-list"></datalist></label>
        <label>Brand<input name="brand" value="${esc(p.brand || '')}"></label>
        <label>Model<input name="model" value="${esc(p.model || '')}"></label>
        <label>HSN Code<input name="hsn_code" value="${esc(p.hsn_code || '')}" list="hsn-list" placeholder="84713010"><datalist id="hsn-list"></datalist></label>
        <label>GST Rate (%)<input name="gst_rate" type="number" step="0.01" value="${p.gst_rate ?? 18}"></label>
        <label>Purchase Price<input name="purchase_price" type="number" step="0.01" value="${p.purchase_price ?? 0}"></label>
        <label>Selling Price<input name="selling_price" type="number" step="0.01" value="${p.selling_price ?? 0}"></label>
        <label>Minimum Stock Level<input name="min_stock" type="number" step="1" value="${p.min_stock ?? 0}"></label>
        <label>Barcode / SKU<input name="barcode" value="${esc(p.barcode || '')}"></label>
        <label class="check"><input type="checkbox" name="serial_tracked" ${p.serial_tracked ? 'checked' : ''}> Track serial numbers</label>
        ${product ? '' : '<label>Opening Stock<input name="opening_stock" type="number" step="1" value="0"></label>'}
        <label class="full">Description<textarea name="description">${esc(p.description || '')}</textarea></label>
      </div>`;
  }

  async function fillLists(view) {
    const [{ categories }, { hsn }] = await Promise.all([
      window.api.get('/api/products/filters'), window.api.get('/api/hsn'),
    ]);
    const catList = view.querySelector('#category-list');
    const hsnList = view.querySelector('#hsn-list');
    if (catList) catList.innerHTML = categories.map((c) => `<option value="${esc(c.name)}">`).join('');
    if (hsnList) hsnList.innerHTML = hsn.map((h) => `<option value="${esc(h.code)}">${esc(h.description)} (${h.gst_rate}%)</option>`).join('');
  }

  async function addProduct(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Add Product</h1>
        <p class="muted">Enter the details once - invoices reuse the HSN, GST and price automatically.</p></div></div>
      ${tabs('add-product')}
      <form class="card" id="form">
        ${productForm(null)}
        <div class="btn-row" style="margin-top:14px">
          <button class="btn primary" type="submit">Save Product</button>
          <a class="btn" href="#/inventory">Cancel</a>
        </div>
      </form>`;
    await fillLists(view);

    view.querySelector('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = formValues(e.target);
      try {
        const { product } = await window.api.post('/api/products', payload);
        toast(`${product.name} saved as ${product.product_code}.`, 'success');
        window.location.hash = `#/inventory/product/${product.id}`;
      } catch (err) {
        if (err.status === 409 && err.details && err.details.existingId) {
          const useExisting = await modal({
            title: 'Similar product found',
            body: `<p>${esc(err.message)}</p><p class="muted">Reusing the existing product keeps your inventory and reports clean.</p>`,
            confirmLabel: 'Open existing product',
            cancelLabel: 'Create anyway',
            onConfirm: () => 'existing',
          });
          if (useExisting === 'existing') { window.location.hash = `#/inventory/product/${err.details.existingId}`; return; }
          try {
            const { product } = await window.api.post('/api/products', { ...payload, force: true });
            window.location.hash = `#/inventory/product/${product.id}`;
          } catch (e2) { errorToast(e2); }
        } else { errorToast(err); }
      }
    });
  }

  // ---------- Add stock (manual) ----------
  async function addStock(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Add Stock</h1>
        <p class="muted">Manual entry. To read a supplier invoice instead, use <a href="#/purchases/add">Purchases → Add Purchase</a>.</p></div></div>
      ${tabs('add-stock')}
      <div class="grid cols-2">
        <form class="card" id="form">
          <div id="product-pick"></div>
          <div id="selected" class="alert info hidden"></div>
          <div class="form-grid">
            <label>Quantity *<input name="qty" type="number" min="1" step="1" value="1" required></label>
            <label>Purchase Price<input name="purchase_price" type="number" step="0.01"></label>
            <label>GST Rate (%)<input name="gst_rate" type="number" step="0.01"></label>
            <label>Invoice Date<input name="invoice_date" type="date" value="${window.ui.todayIso()}"></label>
            <label class="full">Supplier Invoice No<input name="supplier_invoice_no"></label>
          </div>
          <div id="supplier-pick" style="margin-top:10px"></div>
          <div id="serial-block" class="hidden" style="margin-top:10px">
            <label>Serial Numbers (one per line, or scan into the box)
              <textarea name="serials" placeholder="DL0001&#10;DL0002"></textarea></label>
            <p class="small muted">Leave blank to add the units without serial numbers and record them later.</p>
          </div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn primary" type="submit" id="submit" disabled>Add Stock</button>
          </div>
        </form>
        <div class="card">
          <div class="card-head"><h3>How stock is calculated</h3></div>
          <p class="small muted">Current stock = opening stock + purchases + customer returns − sales − damaged stock ± adjustments.
          Every change is written to the stock ledger, so the product history always reconciles with the number you see.</p>
          <div id="recent">${loading()}</div>
        </div>
      </div>`;

    let selected = null;
    let supplierId = null;

    productSearch(view.querySelector('#product-pick'), (product) => {
      selected = product;
      const box = view.querySelector('#selected');
      box.className = 'alert info';
      box.innerHTML = `<strong>${esc(product.name)}</strong> · ${esc(product.product_code)} · HSN ${esc(product.hsn_code || '-')}
        · GST ${product.gst_rate}% · current stock ${qty(product.stock)}`;
      view.querySelector('[name=purchase_price]').value = product.purchase_price;
      view.querySelector('[name=gst_rate]').value = product.gst_rate;
      view.querySelector('#serial-block').classList.toggle('hidden', !product.serial_tracked);
      view.querySelector('#submit').disabled = false;
    });

    partySearch(view.querySelector('#supplier-pick'), 'suppliers', (s) => { supplierId = s.id; });

    window.api.get('/api/inventory/movements', { type: 'PURCHASE', limit: 8 }).then(({ movements }) => {
      view.querySelector('#recent').innerHTML = `<h3 class="small muted" style="margin-top:14px">Recent stock additions</h3>
        ${table(movements, [
        { key: 'product_name', label: 'Product' },
        { key: 'qty', label: 'Qty', num: true, render: (r) => `+${qty(r.qty)}` },
        { key: 'reference_no', label: 'Reference' },
        { key: 'created_at', label: 'When', render: (r) => dateTime(r.created_at) },
      ], { empty: 'No stock has been added yet.' })}`;
    });

    view.querySelector('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selected) { toast('Search for and select a product first.', 'error'); return; }
      const values = formValues(e.target);
      const serials = String(values.serials || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      try {
        const res = await window.api.post('/api/inventory/add-stock', {
          product_id: selected.id, qty: values.qty, purchase_price: values.purchase_price,
          gst_rate: values.gst_rate, supplier_id: supplierId,
          supplier_invoice_no: values.supplier_invoice_no, invoice_date: values.invoice_date, serials,
        });
        toast(`Stock added (${res.purchaseNo}). ${selected.name} is now at ${qty(res.balance)}.`, 'success');
        window.location.hash = `#/inventory/product/${selected.id}`;
      } catch (err) { errorToast(err); }
    });
  }

  // ---------- Stock movements ----------
  async function movements(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Stock Movements</h1><p class="muted">Every inventory change, with its reference document.</p></div></div>
      ${tabs('movements')}
      <div class="card">
        <div class="filters">
          <label>Type<select id="type">
            <option value="">All types</option>
            ${Object.entries(MOVEMENT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select></label>
          <label>From<input type="date" id="from"></label>
          <label>To<input type="date" id="to"></label>
        </div>
      </div>
      <div class="card" id="list">${loading()}</div>`;

    const load = async () => {
      const { movements: rows } = await window.api.get('/api/inventory/movements', {
        type: view.querySelector('#type').value,
        from: view.querySelector('#from').value,
        to: view.querySelector('#to').value,
        limit: 300,
      });
      view.querySelector('#list').innerHTML = table(rows, [
        { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
        { key: 'product_name', label: 'Product', render: (r) => `<a href="#/inventory/product/${r.product_id}">${esc(r.product_name)}</a>` },
        { key: 'type', label: 'Type', render: (r) => `<span class="tag ${r.qty > 0 ? 'green' : 'red'}">${esc(MOVEMENT_LABEL[r.type] || r.type)}</span>` },
        { key: 'qty', label: 'Qty', num: true, render: (r) => `${r.qty > 0 ? '+' : ''}${qty(r.qty)}` },
        { key: 'balance_after', label: 'Balance', num: true, render: (r) => qty(r.balance_after) },
        { key: 'reference_no', label: 'Reference', render: (r) => esc(r.reference_no || '-') },
        { key: 'reason', label: 'Reason', render: (r) => esc(r.reason || '') },
        { key: 'user_name', label: 'By', render: (r) => esc(r.user_name || '-') },
      ], { empty: 'No stock movements recorded yet.' });
    };
    ['#type', '#from', '#to'].forEach((s) => view.querySelector(s).addEventListener('change', load));
    await load();
  }

  // ---------- Low stock ----------
  async function lowStock(view) {
    view.innerHTML = `<div class="page-head"><div><h1>Low Stock</h1>
      <p class="muted">Products at or below their minimum level. Click a product to restock it.</p></div></div>
      ${tabs('low-stock')}<div class="card" id="list">${loading()}</div>`;
    const { items } = await window.api.get('/api/inventory/low-stock');
    view.querySelector('#list').innerHTML = table(items, [
      { key: 'product_code', label: 'Product ID' },
      { key: 'name', label: 'Product', render: (r) => `<a href="#/inventory/product/${r.id}">${esc(r.name)}</a>` },
      { key: 'category', label: 'Category', render: (r) => esc(r.category || '-') },
      { key: 'stock', label: 'In Stock', num: true, render: (r) => `<span class="tag ${r.stock <= 0 ? 'red' : 'amber'}">${qty(r.stock)}</span>` },
      { key: 'min_stock', label: 'Minimum', num: true },
      { key: 'action', label: '', render: (r) => `<a class="btn small" href="#/inventory/add-stock">Add stock</a>` },
    ], { empty: 'Nothing is running low. ✓' });
  }

  // ---------- Serial numbers ----------
  async function serials(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Serial Numbers</h1><p class="muted">Track individual units from purchase to sale.</p></div></div>
      ${tabs('serials')}
      <div class="card"><div class="filters">
        <label class="grow">Search serial<input type="search" id="q" placeholder="Scan or type a serial number"></label>
        <label>Status<select id="status">
          <option value="">All</option><option>AVAILABLE</option><option>SOLD</option><option>DAMAGED</option>
        </select></label>
      </div></div>
      <div class="card" id="list">${loading()}</div>`;

    const load = async () => {
      const { serials: rows } = await window.api.get('/api/inventory/serials', {
        q: view.querySelector('#q').value.trim(), status: view.querySelector('#status').value, limit: 300,
      });
      view.querySelector('#list').innerHTML = table(rows, [
        { key: 'serial', label: 'Serial', render: (r) => `<strong>${esc(r.serial)}</strong>` },
        { key: 'product_name', label: 'Product', render: (r) => `<a href="#/inventory/product/${r.product_id}">${esc(r.product_name)}</a>` },
        { key: 'status', label: 'Status', render: (r) => statusTag(r.status) },
        { key: 'invoice_no', label: 'Sold on', render: (r) => (r.invoice_no ? `<a href="#/sales/invoice/${r.invoice_id}">${esc(r.invoice_no)}</a>` : '-') },
        { key: 'created_at', label: 'Added', render: (r) => date(r.created_at) },
      ], { empty: 'No serial numbers recorded yet.' });
    };
    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    view.querySelector('#status').addEventListener('change', load);
    await load();
  }

  // ---------- HSN management ----------
  async function hsn(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>HSN Codes</h1>
        <p class="muted">HSN classifies goods for tax. Products carry an HSN; invoices pick it up automatically.</p></div>
        <div class="actions">${window.api.isAdmin() ? '<button class="btn primary" id="add">+ Add HSN</button>' : ''}</div></div>
      ${tabs('hsn')}
      <div class="card"><div class="filters"><label class="grow">Search<input type="search" id="q" placeholder="Code or description"></label></div></div>
      <div class="card" id="list">${loading()}</div>`;

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
      ], { empty: 'No HSN codes yet.' });

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

  // ---------- Product detail ----------
  async function productDetail(view, id) {
    view.innerHTML = loading();
    const data = await window.api.get(`/api/products/${id}`);
    const p = data.product;
    const admin = window.api.isAdmin();

    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${esc(p.name)}</h1>
          <p class="muted">${esc(p.product_code)} · ${esc(p.brand || '-')} ${esc(p.model || '')} · ${esc(p.category || 'Uncategorised')}</p>
        </div>
        <div class="actions">
          <a class="btn" href="#/inventory/add-stock">Add Stock</a>
          ${admin ? '<button class="btn" id="adjust">Adjust Stock</button>' : ''}
          ${admin ? '<button class="btn" id="edit">Edit</button>' : ''}
        </div>
      </div>

      <div class="grid kpis">
        ${window.ui.kpi({ label: 'Current Stock', value: qty(p.stock), sub: `Minimum ${qty(p.min_stock)}`, accent: p.stock <= p.min_stock ? 'warn' : 'accent' })}
        ${window.ui.kpi({ label: 'Stock Value', value: money(p.stock * p.purchase_price), sub: 'At purchase price' })}
        ${window.ui.kpi({ label: 'Selling Price', value: money(p.selling_price), sub: `GST ${p.gst_rate}% · HSN ${esc(p.hsn_code || '-')}` })}
        ${window.ui.kpi({ label: 'Ledger Balance', value: qty(data.ledgerStock), sub: data.ledgerStock === p.stock ? 'Reconciles ✓' : 'Mismatch - check history' })}
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Product Details</h2></div>
          <table>
            <tr><th>Product ID</th><td>${esc(p.product_code)}</td></tr>
            <tr><th>HSN</th><td>${esc(p.hsn_code || '-')}${p.hsn_description ? ` <span class="muted small">${esc(p.hsn_description)}</span>` : ''}</td></tr>
            <tr><th>GST Rate</th><td>${p.gst_rate}%</td></tr>
            <tr><th>Purchase Price</th><td>${money(p.purchase_price)}</td></tr>
            <tr><th>Selling Price</th><td>${money(p.selling_price)}</td></tr>
            <tr><th>Barcode / SKU</th><td>${esc(p.barcode || '-')}</td></tr>
            <tr><th>Serial Tracking</th><td>${p.serial_tracked ? 'Yes' : 'No'}</td></tr>
            <tr><th>Description</th><td>${esc(p.description || '-')}</td></tr>
          </table>
        </div>
        <div class="card">
          <div class="card-head"><h2>Serial Numbers</h2>
            ${p.serial_tracked ? '<div class="actions"><button class="btn small" id="add-serials">+ Add serials</button></div>' : ''}</div>
          ${p.serial_tracked
        ? table(data.serials, [
          { key: 'serial', label: 'Serial' },
          { key: 'status', label: 'Status', render: (r) => statusTag(r.status) },
          { key: 'created_at', label: 'Added', render: (r) => date(r.created_at) },
        ], { empty: 'No serial numbers recorded for this product.' })
        : '<p class="muted">Serial tracking is off for this product.</p>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Inventory History</h2><span class="muted small">Audit trail of every movement</span></div>
        ${table(data.movements, [
        { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
        { key: 'type', label: 'Type', render: (r) => `<span class="tag ${r.qty > 0 ? 'green' : 'red'}">${esc(MOVEMENT_LABEL[r.type] || r.type)}</span>` },
        { key: 'qty', label: 'Qty', num: true, render: (r) => `${r.qty > 0 ? '+' : ''}${qty(r.qty)}` },
        { key: 'balance_after', label: 'Balance', num: true, render: (r) => qty(r.balance_after) },
        { key: 'reference_no', label: 'Reference' },
        { key: 'reason', label: 'Reason', render: (r) => esc([r.reason, r.note].filter(Boolean).join(' · ')) },
        { key: 'user_name', label: 'By', render: (r) => esc(r.user_name || '-') },
      ], { empty: 'No movements yet.' })}
      </div>`;

    const editBtn = view.querySelector('#edit');
    if (editBtn) {
      editBtn.addEventListener('click', async () => {
        const saved = await modal({
          title: 'Edit Product',
          wide: true,
          confirmLabel: 'Save Changes',
          body: productForm(p),
          onRender: (root) => fillLists(root),
          onConfirm: async (root) => window.api.put(`/api/products/${p.id}`, formValues(root)),
        });
        if (saved) { toast('Product updated.', 'success'); productDetail(view, id); }
      });
    }

    const adjustBtn = view.querySelector('#adjust');
    if (adjustBtn) {
      adjustBtn.addEventListener('click', async () => {
        const done = await modal({
          title: `Adjust stock - ${p.name}`,
          confirmLabel: 'Record Adjustment',
          body: `
            <p class="muted small">System stock is ${qty(p.stock)}. Enter the difference, not the new total: use −1 to write one unit off.</p>
            <div class="form-grid">
              <label>Adjustment Quantity *<input name="qty" type="number" step="1" placeholder="-1"></label>
              <label>Reason *<select name="reason">
                <option value="DAMAGED">Damaged</option><option value="LOST">Lost</option>
                <option value="MISSING">Missing</option><option value="WARRANTY">Warranty replacement</option>
                <option value="CORRECTION">Manual correction</option><option value="OTHER">Other</option>
              </select></label>
              <label class="full">Note<input name="note" placeholder="What happened?"></label>
            </div>`,
          onConfirm: async (root) => {
            const values = formValues(root);
            if (!values.qty) { toast('Enter an adjustment quantity.', 'error'); return undefined; }
            return window.api.post('/api/inventory/adjust', { product_id: p.id, ...values });
          },
        });
        if (done) { toast(`Adjustment ${done.adjustmentNo} recorded. Stock is now ${qty(done.balance)}.`, 'success'); productDetail(view, id); }
      });
    }

    const addSerialsBtn = view.querySelector('#add-serials');
    if (addSerialsBtn) {
      addSerialsBtn.addEventListener('click', async () => {
        const done = await modal({
          title: 'Add serial numbers',
          confirmLabel: 'Add',
          body: `<p class="muted small">One serial per line. Adding serials here does not change the stock count - use Add Stock for that.</p>
            <label>Serial numbers<textarea name="serials" rows="6"></textarea></label>`,
          onConfirm: async (root) => window.api.post('/api/inventory/serials', {
            product_id: p.id,
            serials: root.querySelector('[name=serials]').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
          }),
        });
        if (done) { toast(`${done.added} serial number(s) added.`, 'success'); productDetail(view, id); }
      });
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.inventory = { products, addProduct, addStock, movements, lowStock, serials, hsn, productDetail };
})();
