/* Dashboard: how the shop is doing today — numbers, what needs reordering,
   what is selling, the sales trend and the last few invoices. */
(function () {
  'use strict';
  const {
    esc, money, moneyShort, rupees, plural, qty, date, tiles, table, skeleton, pageHead, wireLinks,
  } = window.ui;

  const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month']];
  const TRENDS = [['7', '7 Days'], ['30', '30 Days'], ['90', '3 Months'], ['365', '1 Year']];

  const state = { period: 'today', trend: '7' };

  const iso = (d) => d.toISOString().slice(0, 10);

  function periodRange(key) {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    if (key === 'yesterday') { start.setDate(now.getDate() - 1); end.setDate(now.getDate() - 1); }
    if (key === 'week') start.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
    if (key === 'month') start.setDate(1);
    return { from: iso(start), to: iso(end) };
  }

  const trendRange = (days) => {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (Number(days) - 1));
    return { from: iso(start), to: iso(now) };
  };

  function greeting(name) {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return `${part}, ${esc(String(name || '').split(' ')[0])}`;
  }

  async function render(view) {
    const user = window.api.state.user || { name: '' };
    view.innerHTML = `
      ${pageHead({
    eyebrow: 'Dashboard',
    title: greeting(user.name),
    sub: "Here's how the shop is doing today.",
    actions: `<select id="period" aria-label="Period" style="width:auto">
        ${PERIODS.map(([k, l]) => `<option value="${k}" ${state.period === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>`,
  })}
      <div id="dash-body">${skeleton(4)}</div>`;

    view.querySelector('#period').addEventListener('change', (e) => {
      state.period = e.target.value;
      load(view);
    });
    await load(view);
  }

  async function load(view) {
    const body = view.querySelector('#dash-body');
    const { from, to } = periodRange(state.period);
    const admin = window.api.isAdmin();
    const monthRange = periodRange('month');

    const [dash, month, low, top, invoices] = await Promise.all([
      window.api.get('/api/analytics/dashboard', { from, to, compare: true }),
      // The Monthly Sales tile is always the month so far, whatever period is picked.
      window.api.get('/api/analytics/dashboard', monthRange),
      window.api.get('/api/inventory/low-stock'),
      window.api.get('/api/analytics/by-product', { ...monthRange, limit: 4 }),
      window.api.get('/api/invoices', { limit: 5 }),
    ]);

    const k = dash.kpis;
    const change = dash.comparison ? dash.comparison.change : {};
    const periodLabel = PERIODS.find(([key]) => key === state.period)[1];

    const metrics = [
      {
        label: state.period === 'today' ? "Today's Sales" : `Sales · ${periodLabel}`,
        value: rupees(k.totalSales),
        note: plural(k.invoices, 'invoice'),
        delta: change.revenue,
        href: '#/sales',
      },
      admin
        ? {
          label: 'Monthly Sales', value: moneyShort(month.kpis.totalSales),
          note: new Date().toLocaleDateString('en-IN', { month: 'long' }) + ' so far', href: '#/analytics',
        }
        : { label: 'Items Sold', value: qty(k.itemsSold), note: 'This period', href: '#/sales' },
      {
        label: 'Current Stock', value: `${qty(k.currentStock)} units`,
        note: `${k.totalProducts} products`, href: '#/inventory',
      },
      {
        label: 'Low Stock', value: plural(k.lowStockItems + k.outOfStock, 'product'),
        note: `${k.outOfStock} out of stock`, accent: 'warn', href: '#/inventory/low-stock',
      },
    ];

    body.innerHTML = `
      ${tiles(metrics)}
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head">
            <h2><span class="glyph warn">!</span>Low Stock</h2>
            <a href="#/inventory/low-stock">View all</a>
          </div>
          ${low.items.length ? low.items.slice(0, 4).map((p) => `
            <div class="row-link clickable" data-href="#/inventory/product/${p.id}">
              <div>
                <div style="font-weight:500">${esc(p.name)}</div>
                <div class="small muted">Minimum ${qty(p.min_stock)}${p.usual_supplier ? ` · usually from ${esc(p.usual_supplier)}` : ''}</div>
              </div>
              <span class="tag ${p.stock <= 0 ? 'red' : 'amber'}">${p.stock <= 0 ? 'Out of stock' : `${qty(p.stock)} left`}</span>
            </div>`).join('')
    : '<div class="empty"><h3>Everything is in stock</h3><p>Nothing has fallen below its minimum.</p></div>'}
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Top Selling · This Month</h2>
            ${admin ? '<a href="#/analytics">View all</a>' : ''}
          </div>
          ${top.products.length ? top.products.map((p, i) => `
            <div class="row-link clickable" data-href="#/inventory/product/${p.id}">
              <div class="rank">${i + 1}</div>
              <div class="grow" style="font-weight:500">${esc(p.name)}</div>
              <div class="num">${qty(p.units)} sold</div>
            </div>`).join('')
    : '<div class="empty"><h3>No sales this month yet</h3><p>Invoices you issue will show up here.</p></div>'}
        </section>
      </div>

      ${admin ? '<section class="card" id="trend-card"></section>' : ''}

      <section class="card">
        <div class="card-head"><h2>Recent Invoices</h2><a href="#/sales">View all</a></div>
        ${invoices.invoices.length ? table(invoices.invoices, [
    { label: 'Invoice', class: 'doc', render: (r) => esc(r.invoice_no) },
    { label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
    { label: 'Amount', num: true, render: (r) => rupees(r.total) },
    { label: 'Date', render: (r) => `<span class="muted">${date(r.invoice_date)}</span>` },
  ], { rowAttrs: (r) => `data-href="#/sales/invoice/${r.id}"` })
    : '<div class="empty"><h3>No invoices yet</h3><p>Your invoices will appear here.</p></div>'}
      </section>

      <section>
        <h2 style="margin-bottom:12px">Quick Actions</h2>
        <div class="btn-row">
          <a class="btn primary tall" href="#/sales/create">+ Create Invoice</a>
          <a href="#/inventory/add-stock">+ Add Stock</a>
          ${admin ? '<a href="#/inventory/add-product">+ Add Product</a>' : ''}
        </div>
      </section>`;

    wireLinks(body);
    if (admin) await renderTrend(view);
  }

  async function renderTrend(view) {
    const card = view.querySelector('#trend-card');
    if (!card) return;
    const days = Number(state.trend);
    const bucket = days > 90 ? 'month' : 'day';
    const { from, to } = trendRange(days);
    const { trend } = await window.api.get('/api/analytics/sales-trend', { from, to, bucket });

    // Fill the gaps so a quiet day still gets a column.
    const points = [];
    if (bucket === 'day') {
      for (let i = 0; i < days; i += 1) {
        const d = new Date(`${from}T00:00:00`);
        d.setDate(d.getDate() + i);
        const key = iso(d);
        const row = trend.find((t) => t.period === key);
        points.push({ key, label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), value: row ? row.sales : 0 });
      }
    } else {
      trend.forEach((t) => points.push({
        key: t.period,
        label: new Date(`${t.period}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }),
        value: t.sales,
      }));
    }

    const total = points.reduce((sum, p) => sum + p.value, 0);
    const max = Math.max(...points.map((p) => p.value), 1) * 1.1;
    const every = Math.ceil(points.length / 12);

    card.innerHTML = `
      <div class="card-head">
        <div>
          <h2>Sales Trend</h2>
          <div class="small muted" style="margin-top:3px">${rupees(total)} in this period</div>
        </div>
        <div class="segmented">
          ${TRENDS.map(([k, l]) => `<button data-trend="${k}" class="${state.trend === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="pad">
        <div class="column-chart">
          <div class="axis" style="top:0">${moneyShort(max)}</div>
          <div class="gridline" style="top:8px"></div>
          <div class="axis" style="top:104px">${moneyShort(max / 2)}</div>
          <div class="gridline" style="top:112px"></div>
          ${points.map((p, i) => `
            <div class="col ${i === points.length - 1 ? 'latest' : ''}" title="${esc(p.label)} · ${rupees(p.value)}">
              <span style="height:${Math.max((p.value / max) * 100, 0.5)}%"></span>
            </div>`).join('')}
        </div>
        <div class="chart-labels">
          ${points.map((p, i) => `<div>${i % every === 0 || i === points.length - 1 ? esc(p.label) : ''}</div>`).join('')}
        </div>
      </div>`;

    card.querySelectorAll('[data-trend]').forEach((b) => b.addEventListener('click', () => {
      state.trend = b.dataset.trend;
      renderTrend(view);
    }));
  }

  window.Pages = window.Pages || {};
  window.Pages.dashboard = { render };
})();
