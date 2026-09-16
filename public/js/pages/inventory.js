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
      <a href="#/inventory/add-product" class="${active === 'add-product' ? 'active' : ''}">Add Product / Stock</a>
      <a href="#/inventory/movements" class="${active === 'movements' ? 'active' : ''}">Stock Movements</a>
      <a href="#/inventory/low-stock" class="${active === 'low-stock' ? 'active' : ''}">Low Stock</a>
      <a href="#/inventory/tracking" class="${active === 'tracking' ? 'active' : ''}">Tracking & Codes</a>
    </div>`;

  const stockTag = (p) => `<span class="tag ${p.stock <= 0 ? 'red' : (p.min_stock > 0 && p.stock <= p.min_stock ? 'amber' : 'green')}">${qty(p.stock)}</span>`;

  // ---------- Product list ----------
  async function products(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Inventory</h1><p class="muted">Search by name, brand, model, product ID, HSN or serial number.</p></div>
        <div class="actions">
          <a class="btn primary" href="#/inventory/add-product">+ Add Product or Stock</a>
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
          { key: 'actions', label: 'Action', render: (r) => `<button class="btn small danger delete-btn" data-id="${r.id}" data-name="${esc(r.name)}">Delete</button>` },
        ], { empty: 'No products match this search.' })}`;
      } catch (err) { host.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
    };

    let timer;
    view.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    ['#category', '#brand', '#low'].forEach((sel) => view.querySelector(sel).addEventListener('change', load));
    
    view.addEventListener('click', (e) => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      modal({
        title: 'Delete or Reduce Stock',
        confirmLabel: false,
        body: `
          <form id="del-form">
            <p><strong>${name}</strong></p>
            <label class="check" style="margin-top:14px">
              <input type="radio" name="action" value="delete" checked> Delete entire product (deactivate)
            </label>
            <label class="check">
              <input type="radio" name="action" value="reduce"> Delete a certain number of stock
            </label>
            <label id="reduce-qty-label" style="display:none; margin-top:10px;">Quantity to delete
              <input type="number" name="qty" min="1" step="1">
            </label>
            <div class="btn-row" style="margin-top:20px">
              <button class="btn danger" type="submit">Confirm</button>
            </div>
          </form>
        `,
        onRender: (backdrop, close) => {
          backdrop.querySelector('input[value="reduce"]').addEventListener('change', () => {
            backdrop.querySelector('#reduce-qty-label').style.display = 'block';
            backdrop.querySelector('input[name="qty"]').focus();
          });
          backdrop.querySelector('input[value="delete"]').addEventListener('change', () => {
            backdrop.querySelector('#reduce-qty-label').style.display = 'none';
          });
          backdrop.querySelector('form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const vals = formValues(ev.target);
            try {
              if (vals.action === 'delete') {
                if (!await confirm('Delete Product', 'Are you sure you want to completely delete this product?', 'Delete')) return;
                await window.api.del('/api/products/' + id);
                toast('Product deleted.');
              } else {
                const q = parseInt(vals.qty, 10);
                if (!q) throw new Error('Enter a valid quantity to delete');
                await window.api.post('/api/inventory/adjust', {
                  product_id: id, qty: -q, reason: 'CORRECTION', note: 'Deleted stock manually'
                });
                toast(`Deleted ${q} stock.`);
              }
              close();
              load();
            } catch (err) { errorToast(err); }
          });
        }
      });
    });

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
      <div class="page-head"><div><h1>Add Product or Stock</h1>
        <p class="muted">Upload supplier invoices to read the products off them, or type one in below.</p></div></div>
      ${tabs('add-product')}

      <div class="card">
        <div class="card-head"><h2>Add products from supplier invoices</h2>
          <span class="muted small">Select one or more invoices - PDF, Excel, CSV or text</span></div>
        <div class="filters">
          <label class="grow">Invoice files
            <input type="file" id="scan-files" accept=".pdf,.xlsx,.xlsm,.xltx,.txt,.csv,.tsv,image/*" multiple>
          </label>
          <button class="btn primary" id="scan-btn">Scan Invoices</button>
        </div>
        <p class="small muted" style="margin-top:8px">
          Every product found across the selected invoices is listed for review. Nothing is saved until you confirm,
          and products that already exist are skipped so nothing is duplicated.
        </p>
        <div id="scan-status"></div>
        <div id="scan-results"></div>
      </div>

      <form class="card" id="form">
        <div class="card-head"><h2>Or add a product / stock manually</h2></div>
        ${productForm(null)}
        <div class="form-grid" style="margin-top:14px; border-top:1px solid var(--border); padding-top:14px">
          <label>Quantity to Add<input name="qty" type="number" min="0" step="1" value="0"></label>
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
          <button class="btn primary" type="submit">Save Product / Stock</button>
          <a class="btn" href="#/inventory">Cancel</a>
        </div>
      </form>`;
    await fillLists(view);
    setupInvoiceScan(view);
    
    let supplierId = null;
    partySearch(view.querySelector('#supplier-pick'), 'suppliers', (s) => { supplierId = s.id; });

    const trackBox = view.querySelector('[name=serial_tracked]');
    if (trackBox) {
      trackBox.addEventListener('change', (e) => {
        view.querySelector('#serial-block').classList.toggle('hidden', !e.target.checked);
      });
    }

    view.querySelector('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = formValues(e.target);
      payload.supplier_id = supplierId;
      payload.serials = String(payload.serials || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      
      try {
        const res = await window.api.post('/api/inventory/smart-add', payload);
        if (res.isNew) {
          toast(`${res.name} created. ${res.purchaseNo ? `Stock added (${res.purchaseNo}). Balance is ${qty(res.balance)}.` : ''}`, 'success');
        } else {
          toast(`Existing product '${res.name}' found. ${res.purchaseNo ? `Stock added (${res.purchaseNo}). Balance is ${qty(res.balance)}.` : 'No stock added.'}`, 'success');
        }
        window.location.hash = `#/inventory/product/${res.product_id}`;
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
      { key: 'action', label: '', render: (r) => `<a class="btn small" href="#/inventory/add-product">Add stock</a>` },
    ], { empty: 'Nothing is running low. ✓' });
  }

  // ---------- Tracking & Codes (Serials + HSN) ----------
  async function tracking(view) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Tracking & Codes</h1><p class="muted">Manage individual serial numbers and HSN tax codes.</p></div>
        <div class="actions">${window.api.isAdmin() ? '<button class="btn primary" id="add-hsn">+ Add HSN</button>' : ''}</div></div>
      ${tabs('tracking')}
      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Serial Numbers</h2></div>
          <div class="filters">
            <label class="grow">Search serial<input type="search" id="q-serial" placeholder="Scan or type a serial number"></label>
            <label>Status<select id="status-serial">
              <option value="">All</option><option>AVAILABLE</option><option>SOLD</option><option>DAMAGED</option>
            </select></label>
          </div>
          <div id="list-serial">${loading()}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>HSN Codes</h2></div>
          <div class="filters"><label class="grow">Search<input type="search" id="q-hsn" placeholder="Code or description"></label></div>
          <div id="list-hsn">${loading()}</div>
        </div>
      </div>`;

    const loadSerials = async () => {
      const { serials: rows } = await window.api.get('/api/inventory/serials', {
        q: view.querySelector('#q-serial').value.trim(), status: view.querySelector('#status-serial').value, limit: 300,
      });
      view.querySelector('#list-serial').innerHTML = table(rows, [
        { key: 'serial', label: 'Serial', render: (r) => `<strong>${esc(r.serial)}</strong>` },
        { key: 'product_name', label: 'Product', render: (r) => `<a href="#/inventory/product/${r.product_id}">${esc(r.product_name)}</a>` },
        { key: 'status', label: 'Status', render: (r) => statusTag(r.status) },
        { key: 'invoice_no', label: 'Sold on', render: (r) => (r.invoice_no ? `<a href="#/sales/invoice/${r.invoice_id}">${esc(r.invoice_no)}</a>` : '-') },
      ], { empty: 'No serial numbers recorded yet.' });
    };

    const loadHsn = async () => {
      const { hsn: rows } = await window.api.get('/api/hsn', { q: view.querySelector('#q-hsn').value.trim() });
      view.querySelector('#list-hsn').innerHTML = table(rows, [
        { key: 'code', label: 'Code', render: (r) => `<strong>${esc(r.code)}</strong>` },
        { key: 'description', label: 'Description', render: (r) => esc(r.description || '-') },
        { key: 'gst_rate', label: 'GST', num: true, render: (r) => `${r.gst_rate}%` },
        {
          key: 'actions',
          label: '',
          render: (r) => (window.api.isAdmin() ? `<button class="btn small" data-edit-hsn="${r.id}">Edit</button>` : ''),
        },
      ], { empty: 'No HSN codes yet.' });

      view.querySelectorAll('[data-edit-hsn]').forEach((btn) => btn.addEventListener('click', async () => {
        const row = rows.find((r) => String(r.id) === btn.dataset.editHsn);
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
        if (saved) { toast('HSN updated.', 'success'); loadHsn(); }
      }));
    };

    const addBtn = view.querySelector('#add-hsn');
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
        if (created) { toast('HSN added.', 'success'); loadHsn(); }
      });
    }

    let timerS;
    view.querySelector('#q-serial').addEventListener('input', () => { clearTimeout(timerS); timerS = setTimeout(loadSerials, 200); });
    view.querySelector('#status-serial').addEventListener('change', loadSerials);
    
    let timerH;
    view.querySelector('#q-hsn').addEventListener('input', () => { clearTimeout(timerH); timerH = setTimeout(loadHsn, 200); });

    await Promise.all([loadSerials(), loadHsn()]);
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
        <div class="card-head" style="margin-top:16px"><h3>Review products</h3>
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
        ])}
        <div class="btn-row" style="margin-top:14px">
          <label class="check" style="margin:0"><input type="checkbox" id="also-stock" checked>
            Also add these quantities as stock (records a purchase per invoice)</label>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn success" id="create-products">Create ${newCount} product(s)</button>
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
          window.location.hash = '#/inventory';
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
        window.location.hash = '#/inventory';
      } catch (err) { errorToast(err); }
    }
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
          <a class="btn" href="#/inventory/add-product">Add Stock</a>
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
          body: `<p class="muted small">One serial per line. Adding serials here does not change the stock count - use Add Product for that.</p>
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
  window.Pages.inventory = { products, addProduct, movements, lowStock, tracking, productDetail };
})();
