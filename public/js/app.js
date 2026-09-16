/* Application shell: sign-in, navigation, hash router, global search and notifications. */
(function () {
  'use strict';
  const { esc, money, qty, dateTime, toast, errorToast } = window.ui;

  const NAV = [
    { group: '', items: [{ href: '#/', label: 'Dashboard' }] },
    {
      group: 'Inventory',
      items: [
        { href: '#/inventory', label: 'All Products' },
        { href: '#/inventory/add-product', label: 'Add Product / Stock', admin: true },
        { href: '#/inventory/movements', label: 'Stock Movements' },
        { href: '#/inventory/low-stock', label: 'Low Stock', badge: 'lowStock' },
        { href: '#/inventory/tracking', label: 'Tracking & Codes' },
      ],
    },
    {
      group: 'Purchases',
      items: [
        { href: '#/purchases', label: 'Purchase History' },
        { href: '#/purchases/add', label: 'Add Purchase' },
      ],
    },
    {
      group: 'Sales',
      items: [
        { href: '#/sales/create', label: 'Create Invoice' },
        { href: '#/sales', label: 'Invoice History' },
        { href: '#/sales/returns', label: 'Returns' },
      ],
    },
    {
      group: 'Business',
      items: [
        { href: '#/customers', label: 'Customers' },
        { href: '#/suppliers', label: 'Suppliers' },
        { href: '#/reports', label: 'Analytics & Reports' },
        { href: '#/settings', label: 'Settings', admin: true },
      ],
    },
  ];

  const ROUTES = [
    [/^\/?$/, (view) => window.Pages.dashboard.render(view)],
    [/^\/inventory\/?$/, (view) => window.Pages.inventory.products(view)],
    [/^\/inventory\/add-product$/, (view) => window.Pages.inventory.addProduct(view)],
    [/^\/inventory\/movements$/, (view) => window.Pages.inventory.movements(view)],
    [/^\/inventory\/low-stock$/, (view) => window.Pages.inventory.lowStock(view)],
    [/^\/inventory\/tracking$/, (view) => window.Pages.inventory.tracking(view)],
    [/^\/inventory\/product\/(\d+)$/, (view, id) => window.Pages.inventory.productDetail(view, id)],
    [/^\/purchases\/?$/, (view) => window.Pages.purchases.history(view)],
    [/^\/purchases\/add$/, (view) => window.Pages.purchases.add(view)],
    [/^\/sales\/?$/, (view) => window.Pages.sales.history(view)],
    [/^\/sales\/create$/, (view) => window.Pages.sales.create(view)],
    [/^\/sales\/create\/(\d+)$/, (view, id) => window.Pages.sales.create(view, id)],
    [/^\/sales\/invoice\/(\d+)$/, (view, id) => window.Pages.sales.invoice(view, id)],
    [/^\/sales\/returns$/, (view) => window.Pages.sales.returns(view)],
    [/^\/customers$/, (view) => window.Pages.customers.render(view)],
    [/^\/suppliers$/, (view) => window.Pages.suppliers.render(view)],
    [/^\/reports$/, (view) => window.Pages.reports.render(view)],
    [/^\/settings$/, (view) => window.Pages.settings.render(view)],
  ];

  const counters = { lowStock: 0 };

  function renderNav() {
    const nav = document.getElementById('nav');
    const admin = window.api.isAdmin();
    const current = window.location.hash || '#/';
    nav.innerHTML = NAV.map((section) => {
      const items = section.items.filter((i) => !i.admin || admin);
      if (!items.length) return '';
      return `${section.group ? `<div class="group">${esc(section.group)}</div>` : ''}
        ${items.map((i) => `<a href="${i.href}" class="${current === i.href ? 'active' : ''}">
            <span>${esc(i.label)}</span>
            ${i.badge && counters[i.badge] ? `<span class="pill">${counters[i.badge]}</span>` : ''}
          </a>`).join('')}`;
    }).join('');
  }

  async function route() {
    const view = document.getElementById('view');
    const path = (window.location.hash || '#/').slice(1) || '/';
    renderNav();
    document.getElementById('sidebar').classList.remove('open');
    window.scrollTo(0, 0);

    for (const [pattern, handler] of ROUTES) {
      const match = path.match(pattern);
      if (match) {
        view.innerHTML = window.ui.loading();
        try {
          await handler(view, match[1]);
        } catch (err) {
          view.innerHTML = `<div class="alert error">${esc(err.message || 'This page could not be loaded.')}</div>`;
        }
        return;
      }
    }
    view.innerHTML = `<div class="card"><h1>Page not found</h1>
      <p class="muted">The page <code>${esc(path)}</code> does not exist. <a href="#/">Back to the dashboard</a>.</p></div>`;
  }

  // ---------- Global search ----------
  function setupSearch() {
    const input = document.getElementById('global-search');
    const results = document.getElementById('search-results');
    let timer;

    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      try {
        const [products, invoices, customers] = await Promise.all([
          window.api.get('/api/products', { q, limit: 6 }),
          window.api.get('/api/invoices', { q, limit: 4 }),
          window.api.get('/api/customers', { q, limit: 4 }),
        ]);
        const rows = [
          ...products.products.map((p) => ({
            href: `#/inventory/product/${p.id}`,
            html: `<strong>${esc(p.name)}</strong> <span class="muted small">${esc(p.product_code)} · stock ${qty(p.stock)} · ${money(p.selling_price)}</span>`,
          })),
          ...invoices.invoices.map((i) => ({
            href: `#/sales/invoice/${i.id}`,
            html: `<strong>${esc(i.invoice_no)}</strong> <span class="muted small">${esc(i.customer_name || 'Walk-in')} · ${money(i.total)} · ${esc(i.status)}</span>`,
          })),
          ...customers.customers.map((c) => ({
            href: '#/customers',
            html: `<strong>${esc(c.name)}</strong> <span class="muted small">${esc(c.phone || '')} · ${c.transactions} invoice(s)</span>`,
          })),
        ];
        results.innerHTML = rows.length
          ? rows.map((r) => `<div class="item" data-href="${r.href}">${r.html}</div>`).join('')
          : '<div class="item muted">Nothing found.</div>';
        results.hidden = false;
        results.querySelectorAll('[data-href]').forEach((el) => el.addEventListener('click', () => {
          window.location.hash = el.dataset.href;
          results.hidden = true;
          input.value = '';
        }));
      } catch (err) { errorToast(err); }
    };

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.global-search')) results.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // ---------- Notifications ----------
  async function refreshNotifications() {
    try {
      const { notifications, unread } = await window.api.get('/api/notifications', { limit: 20 });
      const badge = document.getElementById('bell-count');
      badge.textContent = unread;
      badge.hidden = !unread;

      const panel = document.getElementById('notification-panel');
      panel.innerHTML = `
        <div class="row" style="background:var(--surface-2)">
          <strong>Notifications</strong>
          <div class="grow"></div>
          <button class="btn small ghost" id="mark-read">Mark all read</button>
        </div>
        ${notifications.length
    ? notifications.map((n) => `<div class="row">
              <span>${n.level === 'ERROR' ? '⛔' : n.level === 'WARN' ? '⚠️' : n.level === 'SUCCESS' ? '✅' : 'ℹ️'}</span>
              <div class="grow">${n.link ? `<a href="${esc(n.link)}">${esc(n.message)}</a>` : esc(n.message)}
                <div class="small muted">${dateTime(n.created_at)}</div></div>
              ${n.is_read ? '' : '<span class="tag blue">New</span>'}
            </div>`).join('')
    : '<div class="row muted">Nothing to report.</div>'}`;

      panel.querySelector('#mark-read').addEventListener('click', async () => {
        await window.api.post('/api/notifications/read', {});
        refreshNotifications();
      });

      const { items } = await window.api.get('/api/inventory/low-stock');
      counters.lowStock = items.length;
      renderNav();
    } catch { /* the badge is best-effort */ }
  }

  // ---------- Boot ----------
  function showLogin(message) {
    document.getElementById('shell').hidden = true;
    const login = document.getElementById('login');
    login.hidden = false;
    const error = document.getElementById('login-error');
    error.hidden = !message;
    error.textContent = message || '';
  }

  async function showApp(user) {
    document.getElementById('login').hidden = true;
    document.getElementById('shell').hidden = false;
    document.getElementById('user-chip').innerHTML = `${esc(user.name)}<span>${esc(user.role === 'ADMIN' ? 'Owner / Admin' : 'Sales Staff')}</span>`;
    if (window.api.state.business) {
      document.getElementById('brand-name').textContent = window.api.state.business.name;
      document.title = `${window.api.state.business.name} · Business Management`;
    }
    renderNav();
    await route();
    refreshNotifications();
    setInterval(refreshNotifications, 60000);
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      const user = await window.api.login(form.get('email'), form.get('password'));
      await window.api.me();
      await showApp(user);
    } catch (err) {
      showLogin(err.message);
    }
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await window.api.logout();
    window.location.hash = '#/';
    showLogin();
  });

  document.getElementById('menu-toggle').addEventListener('click',
    () => document.getElementById('sidebar').classList.toggle('open'));

  document.getElementById('bell').addEventListener('click', () => {
    const panel = document.getElementById('notification-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) refreshNotifications();
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('cbms:signed-out', () => showLogin('Your session has expired. Please sign in again.'));

  setupSearch();

  (async () => {
    try {
      const user = await window.api.me();
      if (user) await showApp(user);
      else showLogin();
    } catch {
      showLogin();
    }
  })();
})();
