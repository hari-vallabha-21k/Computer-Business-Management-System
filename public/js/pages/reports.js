/* Analytics & Reports: deeper analytics views plus downloadable reports. */
(function () {
  'use strict';
  const { esc, money, moneyShort, qty, table, loading, range, todayIso, errorToast, toast } = window.ui;

  const PRESETS = [['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This year'],
    ['last30', 'Last 30 days'], ['all', 'All time'], ['custom', 'Custom range']];

  async function render(view) {
    const state = { preset: 'month', from: '', to: '', report: 'sales' };
    const period = () => (state.preset === 'custom'
      ? { from: state.from || '2000-01-01', to: state.to || todayIso() }
      : range(state.preset));

    view.innerHTML = `
      <div class="page-head"><div><h1>Analytics &amp; Reports</h1>
        <p class="muted">Where the money and the stock actually went.</p></div></div>
      <div class="card"><div class="filters">
        <label>Period<select id="preset">${PRESETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="hidden" id="from-wrap">From<input type="date" id="from"></label>
        <label class="hidden" id="to-wrap">To<input type="date" id="to"></label>
        <span class="muted small" id="period-label"></span>
      </div></div>
      <div id="analytics">${loading()}</div>

      <div class="card">
        <div class="card-head"><h2>Downloadable Reports</h2>
          <div class="actions">
            <select id="report" style="width:auto"></select>
            <button class="btn" id="run">View</button>
            <button class="btn primary" id="csv">Download CSV</button>
          </div>
        </div>
        <div id="report-body"><div class="empty">Pick a report and select View.</div></div>
      </div>`;

    const { reports } = await window.api.get('/api/reports');
    const select = view.querySelector('#report');
    reports.forEach((r) => select.add(new Option(r.label, r.key)));

    async function loadAnalytics() {
      const { from, to } = period();
      view.querySelector('#period-label').textContent = `${window.ui.date(from)} – ${window.ui.date(to)}`;
      const host = view.querySelector('#analytics');
      try {
        const [byProduct, byCategory, byHsn, inventory, dash] = await Promise.all([
          window.api.get('/api/analytics/by-product', { from, to, limit: 15 }),
          window.api.get('/api/analytics/by-category', { from, to }),
          window.api.get('/api/analytics/by-hsn', { from, to }),
          window.api.get('/api/analytics/inventory'),
          window.api.get('/api/analytics/dashboard', { from, to }),
        ]);
        const k = dash.kpis;

        host.innerHTML = `
          <div class="grid kpis">
            ${window.ui.kpi({ label: 'Revenue (incl. GST)', value: moneyShort(k.totalSales), sub: money(k.totalSales), accent: 'accent' })}
            ${window.ui.kpi({ label: 'Revenue (excl. GST)', value: moneyShort(k.netRevenue), sub: 'Taxable value' })}
            ${window.ui.kpi({ label: 'Cost of Goods Sold', value: moneyShort(k.cost), sub: 'At recorded purchase price' })}
            ${window.ui.kpi({ label: 'Gross Profit', value: moneyShort(k.grossProfit), sub: 'Before business expenses' })}
          </div>
          <div class="alert info">Gross profit is revenue excluding GST minus the cost of the goods sold. It is not net
            business profit - rent, salaries and other expenses are not tracked in this system.</div>

          <div class="grid cols-2">
            <div class="card"><div class="card-head"><h2>Sales by Product</h2></div><div id="prod-bars"></div>
              <details class="small muted" style="margin-top:10px"><summary>View as table</summary><div id="prod-table"></div></details>
            </div>
            <div class="card"><div class="card-head"><h2>Sales by Category</h2></div><div id="cat-chart"></div></div>
          </div>

          <div class="card">
            <div class="card-head"><h2>HSN Analysis</h2><span class="muted small">Sales grouped by tax classification</span></div>
            <div id="hsn-table"></div>
          </div>

          <div class="card">
            <div class="card-head"><h2>Stock Position by Category</h2></div>
            <div id="stock-table"></div>
          </div>`;

        window.charts.bars(host.querySelector('#prod-bars'),
          byProduct.products.map((p) => ({ label: p.name, value: p.units, display: `${qty(p.units)} · ${moneyShort(p.sales)}` })),
          { empty: 'No sales in this period.' });

        host.querySelector('#prod-table').innerHTML = table(byProduct.products, [
          { key: 'product_code', label: 'Product ID' },
          { key: 'name', label: 'Product' },
          { key: 'units', label: 'Units', num: true },
          { key: 'sales', label: 'Sales', num: true, render: (r) => money(r.sales) },
          { key: 'grossProfit', label: 'Gross Profit', num: true, render: (r) => money(r.grossProfit) },
        ], { empty: 'No sales in this period.' });

        window.charts.donut(host.querySelector('#cat-chart'),
          byCategory.categories.map((c) => ({ label: c.category, value: c.sales })));

        host.querySelector('#hsn-table').innerHTML = table(byHsn.hsn, [
          { key: 'hsn_code', label: 'HSN Code' },
          { key: 'description', label: 'Description', render: (r) => esc(r.description || '-') },
          { key: 'units', label: 'Units Sold', num: true },
          { key: 'taxable', label: 'Taxable Value', num: true, render: (r) => money(r.taxable) },
          { key: 'gst', label: 'GST', num: true, render: (r) => money(r.gst) },
          { key: 'sales', label: 'Sales Value', num: true, render: (r) => money(r.sales) },
        ], { empty: 'No sales in this period.' });

        host.querySelector('#stock-table').innerHTML = table(inventory.byCategory, [
          { key: 'category', label: 'Category' },
          { key: 'products', label: 'Products', num: true },
          { key: 'units', label: 'Units', num: true, render: (r) => qty(r.units) },
          { key: 'value', label: 'Stock Value', num: true, render: (r) => money(r.value) },
        ], { empty: 'No stock on hand.' });
      } catch (err) {
        host.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      }
    }

    view.querySelector('#preset').addEventListener('change', (e) => {
      state.preset = e.target.value;
      const custom = state.preset === 'custom';
      view.querySelector('#from-wrap').classList.toggle('hidden', !custom);
      view.querySelector('#to-wrap').classList.toggle('hidden', !custom);
      if (!custom) loadAnalytics();
    });
    ['#from', '#to'].forEach((sel) => view.querySelector(sel).addEventListener('change', (e) => {
      state[e.target.id] = e.target.value;
      loadAnalytics();
    }));

    view.querySelector('#run').addEventListener('click', async () => {
      const { from, to } = period();
      const host = view.querySelector('#report-body');
      host.innerHTML = loading();
      try {
        const data = await window.api.get(`/api/reports/${select.value}`, { from, to });
        host.innerHTML = `<h3>${esc(data.label)} <span class="muted small">${window.ui.date(from)} – ${window.ui.date(to)}</span></h3>
          ${table(data.rows, data.columns.map((c) => ({
          key: c.key,
          label: c.label,
          num: /value|price|profit|total|gst|qty|units|stock|margin|purchases|sales|returns|adjustments|opening/i.test(c.key),
          render: (r) => (/value|price|profit|total|gst/i.test(c.key) && typeof r[c.key] === 'number'
            ? money(r[c.key]) : esc(r[c.key])),
        })), { empty: 'No rows for this period.' })}`;
      } catch (err) { host.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
    });

    view.querySelector('#csv').addEventListener('click', async () => {
      const { from, to } = period();
      try {
        await window.api.download(`/api/reports/${select.value}`, { from, to, format: 'csv' },
          `${select.value}-report-${from}-to-${to}.csv`);
        toast('Report downloaded.', 'success');
      } catch (err) { errorToast(err); }
    });

    await loadAnalytics();
  }

  window.Pages = window.Pages || {};
  window.Pages.reports = { render };
})();
