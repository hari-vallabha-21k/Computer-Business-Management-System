/* Analytics: how the business is doing, in plain numbers.
   Reports: pick one, choose the dates, download it for the accountant. */
(function () {
  'use strict';
  const {
    esc, money, moneyShort, rupees, qty, date, table, skeleton, toast, errorToast,
    pageHead, tiles, wireLinks, todayIso,
  } = window.ui;

  const PERIODS = [
    ['month', 'This Month'], ['lastMonth', 'Last Month'], ['quarter', 'Last 3 Months'], ['year', 'This Year'],
  ];

  function periodRange(key) {
    const now = new Date();
    if (key === 'lastMonth') {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: iso(start), to: iso(end) };
    }
    if (key === 'quarter') {
      const start = new Date(now);
      start.setMonth(now.getMonth() - 2, 1);
      return { from: iso(start), to: iso(now) };
    }
    if (key === 'year') return { from: `${now.getFullYear()}-01-01`, to: iso(now) };
    return { from: `${iso(now).slice(0, 7)}-01`, to: iso(now) };
  }
  const iso = (d) => d.toISOString().slice(0, 10);

  /** The design's sales chart: this period solid, last period dashed behind it. */
  function lineChart(current, previous) {
    const width = 600;
    const height = 200;
    const all = [...current, ...previous];
    const max = Math.max(...all.map((v) => v), 1);
    const points = (values) => values
      .map((v, i) => `${((i / Math.max(values.length - 1, 1)) * width).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`)
      .join(' ');
    return `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="line-chart" role="img"
        aria-label="Daily sales for this period against the last one">
        ${[50, 100, 150].map((y) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#EFEDE8" stroke-dasharray="3 3"/>`).join('')}
        <line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="#D5D3CC"/>
        ${previous.length ? `<polyline points="${points(previous)}" fill="none" stroke="#BFBFB8" stroke-width="2"
          stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>` : ''}
        <polyline points="${points(current)}" fill="none" stroke="#1A6C8C" stroke-width="2.5"
          stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>`;
  }

  /** Fill every day in the window so a quiet day is a dip, not a missing point. */
  function daily(trend, from, to) {
    const out = [];
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = iso(d);
      const row = trend.find((t) => t.period === key);
      out.push(row ? row.sales : 0);
    }
    return out;
  }

  // ---------- Analytics ----------
  async function analytics(view) {
    const state = { period: 'month' };
    view.innerHTML = `
      ${pageHead({
    title: 'Analytics',
    sub: 'How the business is doing, in plain numbers.',
    actions: `<select id="period" style="width:auto" aria-label="Period">
      ${PERIODS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`,
  })}
      <div id="body">${skeleton(4)}</div>`;

    const load = async () => {
      const body = view.querySelector('#body');
      const { from, to } = periodRange(state.period);
      const [dash, trend, categories, top, stock] = await Promise.all([
        window.api.get('/api/analytics/dashboard', { from, to, compare: true }),
        window.api.get('/api/analytics/sales-trend', { from, to, bucket: 'day', compare: true }),
        window.api.get('/api/analytics/by-category', { from, to }),
        window.api.get('/api/analytics/by-product', { from, to, limit: 5 }),
        window.api.get('/api/analytics/inventory'),
      ]);

      const k = dash.kpis;
      const change = dash.comparison ? dash.comparison.change : {};
      const previousRange = dash.comparison ? dash.comparison.range : null;
      const maxCategory = Math.max(...categories.categories.map((c) => c.sales), 1);
      const totalUnits = stock.byCategory.reduce((sum, c) => sum + c.units, 0);
      const totalProducts = stock.byCategory.reduce((sum, c) => sum + c.products, 0);

      body.innerHTML = `
        ${tiles([
    {
      label: 'Sales', value: moneyShort(k.totalSales),
      note: change.revenue === undefined ? 'In this period' : undefined, delta: change.revenue,
    },
    { label: 'Purchases', value: moneyShort(k.totalPurchases), note: 'Stock bought' },
    {
      label: 'Gross Profit', value: moneyShort(k.grossProfit),
      note: k.netRevenue ? `${((k.grossProfit / k.netRevenue) * 100).toFixed(1)}% of sales` : '—',
    },
    { label: 'Stock Value', value: moneyShort(k.stockValue), note: 'At purchase price' },
  ])}

        <section class="card">
          <div class="card-head">
            <div><h2>Sales Trend</h2>
              <div class="small muted" style="margin-top:3px">Daily sales${previousRange
    ? ` · the dashed line is ${date(previousRange.from)} – ${date(previousRange.to)}` : ''}</div></div>
          </div>
          <div class="pad">
            ${lineChart(daily(trend.trend, from, to), trend.previous && previousRange
    ? daily(trend.previous, previousRange.from, previousRange.to) : [])}
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:8px">
              <span>${date(from)}</span><span>${date(to)}</span>
            </div>
          </div>
        </section>

        <div class="grid cols-2">
          <section class="card">
            <div class="card-head"><h2>Sales by Category</h2></div>
            <div class="pad">
              ${categories.categories.length ? categories.categories.map((c) => `
                <div style="margin-bottom:14px">
                  <div style="display:flex;justify-content:space-between;margin-bottom:6px">
                    <span style="font-weight:500">${esc(c.category)}</span>
                    <span class="num">${rupees(c.sales)}</span>
                  </div>
                  <span class="bar-track"><span class="bar-fill" style="width:${(c.sales / maxCategory) * 100}%"></span></span>
                </div>`).join('')
    : '<div class="muted">No sales in this period.</div>'}
            </div>
          </section>

          <section class="card">
            <div class="card-head"><h2>Top Products</h2></div>
            ${top.products.length ? top.products.map((p, i) => `
              <div class="row-link clickable" data-href="#/inventory/product/${p.id}">
                <div class="rank">${i + 1}</div>
                <div class="grow"><div style="font-weight:500">${esc(p.name)}</div>
                  <div class="small muted">${qty(p.units)} sold</div></div>
                <div class="num" style="font-weight:500">${rupees(p.sales)}</div>
              </div>`).join('')
    : '<div class="empty"><h3>Nothing sold yet</h3><p>Issued invoices feed this list.</p></div>'}
          </section>
        </div>

        <section>
          <h2 style="margin-bottom:12px">Inventory Overview</h2>
          ${tiles([
    { label: 'Total Products', value: qty(totalProducts), href: '#/inventory/products' },
    { label: 'Total Units', value: qty(totalUnits), href: '#/inventory' },
    { label: 'Low Stock', value: qty(k.lowStockItems), accent: 'warn', href: '#/inventory/low-stock' },
    { label: 'Out of Stock', value: qty(k.outOfStock), accent: 'danger', href: '#/inventory/low-stock' },
  ])}
        </section>`;
      wireLinks(body);
    };

    view.querySelector('#period').addEventListener('change', (e) => {
      state.period = e.target.value;
      load();
    });
    await load();
  }

  // ---------- Reports ----------
  const DATE_CHOICES = [
    ['month', 'This month'], ['lastMonth', 'Last month'], ['year', 'This financial year'], ['custom', 'Custom dates…'],
  ];

  function reportRange(key, from, to) {
    if (key === 'custom') return { from: from || '2000-01-01', to: to || todayIso() };
    if (key === 'year') {
      const now = new Date();
      const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
      return { from: `${startYear}-04-01`, to: todayIso() };
    }
    return periodRange(key);
  }

  async function render(view) {
    const state = { report: 'sales', dates: 'month', from: '', to: '', category: '', productId: '' };
    const [{ reports }, { categories }] = await Promise.all([
      window.api.get('/api/reports'),
      window.api.get('/api/products/filters'),
    ]);

    view.innerHTML = `
      <div style="max-width:960px">
        ${pageHead({
    title: 'Reports',
    sub: 'Pick a report, choose the dates, and download it for your accountant.',
  })}
        <div class="card">
          <div class="pad" style="border-bottom:1px solid var(--rule)">
            <div style="font-weight:500;margin-bottom:10px">1. Which report?</div>
            <div class="choices" style="gap:10px;margin:0">
              ${reports.map((r) => `
                <button type="button" class="choice" data-report="${r.key}" style="padding:14px 16px;gap:4px">
                  <span class="title" style="font-size:15px">${esc(r.label)}</span>
                  <span class="desc">${esc(r.description || '')}</span>
                </button>`).join('')}
            </div>
          </div>
          <div class="pad" style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
            <label style="flex:1 1 180px">2. Date
              <select id="dates">${DATE_CHOICES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
            </label>
            <label style="flex:1 1 150px" id="from-wrap" hidden>From<input type="date" id="from"></label>
            <label style="flex:1 1 150px" id="to-wrap" hidden>To<input type="date" id="to"></label>
            <label style="flex:1 1 160px">Category
              <select id="category"><option value="">All categories</option>
                ${categories.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select>
            </label>
            <label style="flex:1 1 200px">Product
              <select id="product"><option value="">All products</option></select>
            </label>
            <button class="btn primary" id="generate">Generate Report</button>
          </div>
        </div>
        <div id="result"></div>
      </div>`;

    window.api.get('/api/products', { limit: 300 }).then(({ products }) => {
      const select = view.querySelector('#product');
      products.forEach((p) => select.add(new Option(p.name, p.id)));
    });

    const markReport = () => view.querySelectorAll('[data-report]').forEach((b) => {
      const on = b.dataset.report === state.report;
      b.style.border = on ? '2px solid var(--primary)' : '1px solid var(--field)';
      b.style.background = on ? 'var(--primary-pale)' : 'var(--surface)';
    });
    view.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => {
      state.report = b.dataset.report;
      markReport();
    }));
    markReport();

    view.querySelector('#dates').addEventListener('change', (e) => {
      state.dates = e.target.value;
      view.querySelector('#from-wrap').hidden = state.dates !== 'custom';
      view.querySelector('#to-wrap').hidden = state.dates !== 'custom';
    });
    ['category', 'product'].forEach((field) => view.querySelector(`#${field}`).addEventListener('change', (e) => {
      state[field === 'product' ? 'productId' : 'category'] = e.target.value;
    }));

    const params = () => {
      const { from, to } = reportRange(state.dates, view.querySelector('#from').value, view.querySelector('#to').value);
      return { from, to, category: state.category, productId: state.productId };
    };

    view.querySelector('#generate').addEventListener('click', async () => {
      const result = view.querySelector('#result');
      result.innerHTML = `<div class="card" style="margin-top:24px"><div class="pad">
        <div class="muted" style="margin-bottom:16px">Preparing your report…</div>
        ${skeleton(5)}</div></div>`;
      try {
        const query = params();
        const data = await window.api.get(`/api/reports/${state.report}`, query);
        const foot = Object.keys(data.totals || {}).length
          ? data.columns.map((c, i) => {
            if (i === 0) return '<td>Total</td>';
            const value = data.totals[c.key];
            return `<td class="num">${value === undefined ? '' : qty(value)}</td>`;
          }).join('')
          : '';

        result.innerHTML = `
          <section class="card" style="margin-top:24px">
            <div class="card-head">
              <div><h2>${esc(data.label)}</h2>
                <div class="small muted" style="margin-top:2px">
                  ${date(data.range.from)} – ${date(data.range.to)} · ${esc(state.category || 'All categories')}</div></div>
              <div class="actions">
                <button class="link-btn" id="csv">↓ Export CSV</button>
                <button class="link-btn" id="xlsx">↓ Export Excel</button>
              </div>
            </div>
            ${data.rows.length ? table(data.rows, data.columns.map((c) => ({
    label: c.label,
    num: /qty|value|total|price|gst|stock|units|sold|profit|margin|opening|purchases|sales|returns|adjustments|rate|taxable/i.test(c.label),
    render: (row) => {
      const value = row[c.key];
      if (typeof value === 'number' && /value|total|price|gst|profit|taxable/i.test(c.label)) return money(value);
      return esc(value);
    },
  })), { clickable: false, foot })
    : '<div class="empty"><h3>Nothing to report</h3><p>No records in this period.</p></div>'}
          </section>`;

        const stem = `${state.report}-report-${data.range.from}-to-${data.range.to}`;
        result.querySelector('#csv').addEventListener('click',
          () => window.api.download(`/api/reports/${state.report}`, { ...query, format: 'csv' }, `${stem}.csv`));
        result.querySelector('#xlsx').addEventListener('click',
          () => window.api.download(`/api/reports/${state.report}`, { ...query, format: 'xlsx' }, `${stem}.xlsx`));
      } catch (err) {
        errorToast(err);
        result.innerHTML = `<div class="alert error" style="margin-top:24px"><span class="glyph">!</span>
          <div><strong>${esc(err.message)}</strong><br>Nothing was downloaded.</div></div>`;
      }
    });
  }

  window.Pages = window.Pages || {};
  window.Pages.reports = { render, analytics };
})();
