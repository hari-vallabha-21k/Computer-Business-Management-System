/* Dashboard: KPIs, sales trend, category share, top products, low stock. */
(function () {
  'use strict';
  const { esc, money, moneyShort, qty, kpi, table, loading, range, todayIso } = window.ui;

  const RANGES = [
    ['today', 'Today'], ['week', 'This week'], ['month', 'This month'],
    ['quarter', 'This quarter'], ['year', 'This year'], ['last30', 'Last 30 days'], ['all', 'All time'],
  ];

  const filters = { preset: 'month', from: '', to: '', category: '', brand: '', compare: true };

  function currentRange() {
    if (filters.preset === 'custom') return { from: filters.from || '2000-01-01', to: filters.to || todayIso() };
    return range(filters.preset);
  }

  async function render(view) {
    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Business Control Center</h1>
          <p class="muted" id="range-label">Loading…</p>
        </div>
        <div class="actions">
          <a class="btn" href="#/purchases/add">Add Stock</a>
          <a class="btn primary" href="#/sales/create">Create Invoice</a>
        </div>
      </div>
      <div class="card"><div class="filters" id="dash-filters"></div></div>
      <div id="dash-body">${loading()}</div>`;

    renderFilters(view.querySelector('#dash-filters'), () => load(view));
    await load(view);
  }

  function renderFilters(host, onChange) {
    host.innerHTML = `
      <label>Date
        <select name="preset">
          ${RANGES.map(([k, l]) => `<option value="${k}" ${filters.preset === k ? 'selected' : ''}>${l}</option>`).join('')}
          <option value="custom" ${filters.preset === 'custom' ? 'selected' : ''}>Custom range</option>
        </select>
      </label>
      <label class="${filters.preset === 'custom' ? '' : 'hidden'}">From<input type="date" name="from" value="${esc(filters.from)}"></label>
      <label class="${filters.preset === 'custom' ? '' : 'hidden'}">To<input type="date" name="to" value="${esc(filters.to)}"></label>
      <label>Category<select name="category"><option value="">All categories</option></select></label>
      <label>Brand<select name="brand"><option value="">All brands</option></select></label>
      <label class="check"><input type="checkbox" name="compare" ${filters.compare ? 'checked' : ''}> Compare with previous period</label>`;

    window.api.get('/api/products/filters').then(({ categories, brands }) => {
      const cat = host.querySelector('[name=category]');
      const brand = host.querySelector('[name=brand]');
      categories.forEach((c) => cat.add(new Option(c.name, c.name, false, filters.category === c.name)));
      brands.forEach((b) => brand.add(new Option(b, b, false, filters.brand === b)));
    });

    host.addEventListener('change', (e) => {
      const el = e.target;
      filters[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.name === 'preset') { renderFilters(host, onChange); }
      onChange();
    });
  }

  async function load(view) {
    const body = view.querySelector('#dash-body');
    const { from, to } = currentRange();
    const params = { from, to, category: filters.category, brand: filters.brand };
    view.querySelector('#range-label').textContent = `${window.ui.date(from)} – ${window.ui.date(to)}`;

    try {
      const [dash, trend, byCategory, byProduct, inventory] = await Promise.all([
        window.api.get('/api/analytics/dashboard', { ...params, compare: filters.compare }),
        window.api.get('/api/analytics/sales-trend', { ...params, bucket: bucketFor(from, to) }),
        window.api.get('/api/analytics/by-category', params),
        window.api.get('/api/analytics/by-product', { ...params, limit: 8 }),
        window.api.get('/api/analytics/inventory'),
      ]);

      const k = dash.kpis;
      const change = dash.comparison ? dash.comparison.change : {};
      body.innerHTML = `
        <div class="grid kpis">
          ${kpi({ label: 'Total Sales', value: moneyShort(k.totalSales), sub: money(k.totalSales), delta: change.revenue, accent: 'accent' })}
          ${kpi({ label: 'Items Sold', value: qty(k.itemsSold), sub: `${k.invoices} invoice(s)`, delta: change.unitsSold })}
          ${kpi({ label: 'Current Stock', value: qty(k.currentStock), sub: `${k.totalProducts} products` })}
          ${kpi({ label: 'Stock Value', value: moneyShort(k.stockValue), sub: 'At purchase price' })}
          ${kpi({ label: 'Gross Profit', value: moneyShort(k.grossProfit), sub: `Revenue ${moneyShort(k.netRevenue)} − cost ${moneyShort(k.cost)}`, delta: change.grossProfit })}
          ${kpi({ label: 'Purchases', value: moneyShort(k.totalPurchases), sub: `${k.purchaseCount} purchase(s)` })}
          ${kpi({ label: 'Low Stock Items', value: qty(k.lowStockItems), sub: `${k.outOfStock} out of stock`, accent: k.lowStockItems ? 'warn' : '' })}
          ${kpi({ label: 'Draft Invoices', value: qty(k.draftInvoices), sub: 'Not yet issued - no stock impact' })}
        </div>

        <div class="card">
          <div class="card-head"><h2>Sales Trend</h2><span class="muted small">Issued invoices, net of returns</span></div>
          <div id="trend"></div>
          <details class="small muted" style="margin-top:8px"><summary>View as table</summary><div id="trend-table"></div></details>
        </div>

        <div class="grid cols-2">
          <div class="card">
            <div class="card-head"><h2>Sales by Category</h2></div>
            <div id="category-chart"></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Top Selling Products</h2></div>
            <div id="top-products"></div>
          </div>
        </div>

        <div class="grid cols-2">
          <div class="card">
            <div class="card-head"><h2>⚠ Low Stock</h2>
              <div class="actions"><a class="btn small" href="#/inventory/low-stock">View all</a></div></div>
            <div id="low-stock"></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Stock Value by Category</h2></div>
            <div id="stock-by-category"></div>
          </div>
        </div>`;

      window.charts.lineChart(body.querySelector('#trend'),
        trend.trend.map((t) => ({ label: t.period, value: t.sales, sub: `${qty(t.units)} unit(s), ${t.invoices} invoice(s)` })),
        { title: 'Sales trend' });

      body.querySelector('#trend-table').innerHTML = table(trend.trend, [
        { key: 'period', label: 'Period' },
        { key: 'sales', label: 'Sales', num: true, render: (r) => money(r.sales) },
        { key: 'units', label: 'Units', num: true },
        { key: 'invoices', label: 'Invoices', num: true },
      ], { empty: 'No sales in this period.' });

      window.charts.donut(body.querySelector('#category-chart'),
        byCategory.categories.map((c) => ({ label: c.category, value: c.sales, units: c.units })),
        { title: 'Sales by category' });

      window.charts.bars(body.querySelector('#top-products'),
        byProduct.products.map((p) => ({ label: p.name, value: p.units, display: `${qty(p.units)} · ${moneyShort(p.sales)}` })),
        { empty: 'No products sold in this period.' });

      body.querySelector('#low-stock').innerHTML = table(inventory.lowStock, [
        { key: 'name', label: 'Product', render: (r) => `<a href="#/inventory/product/${r.id}">${esc(r.name)}</a>` },
        { key: 'stock', label: 'Left', num: true, render: (r) => `<span class="tag ${r.stock <= 0 ? 'red' : 'amber'}">${qty(r.stock)}</span>` },
        { key: 'min_stock', label: 'Minimum', num: true, render: (r) => qty(r.min_stock) },
      ], { empty: 'Every product is above its minimum level.' });

      window.charts.bars(body.querySelector('#stock-by-category'),
        inventory.byCategory.map((c) => ({ label: c.category, value: c.value, display: moneyShort(c.value) })),
        { empty: 'No stock on hand.' });
    } catch (err) {
      body.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    }
  }

  function bucketFor(from, to) {
    const days = (new Date(to) - new Date(from)) / 86400000;
    if (days > 240) return 'month';
    if (days > 60) return 'week';
    return 'day';
  }

  window.Pages = window.Pages || {};
  window.Pages.dashboard = { render };
})();
