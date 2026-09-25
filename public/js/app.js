/* Application shell: sign-in, navigation, hash router, global search and notifications. */
(function () {
  'use strict';
  const { esc, money, qty, dateTime, errorToast } = window.ui;

  const ICON = {
    dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
    inventory: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
    purchases: 'M3 4h2l2.4 11h11.2L21 8H7M9 20a1 1 0 100-2 1 1 0 000 2zM18 20a1 1 0 100-2 1 1 0 000 2z',
    sales: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6M9 9h2',
    customers: 'M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 10a4 4 0 100-8 4 4 0 000 8zM22 20v-2a4 4 0 00-3-3.9M16 2.1a4 4 0 010 7.8',
    suppliers: 'M3 21h18M5 21V5l7-2v18M12 21V8l7 3v10M8 9h1M8 13h1M8 17h1M15 13h1M15 17h1',
    analytics: 'M4 20V10M10 20V4M16 20v-7M2 20h20',
    reports: 'M14 3H6v18h12V7zM14 3v4h4M9 17v-3M12 17v-6M15 17v-2',
    settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  };

  /**
   * Top-level sections with their children, exactly as the sidebar reads.
   * `match` marks the parent active for any page that belongs to it.
   */
  const NAV = [
    { href: '#/', label: 'Dashboard', icon: ICON.dashboard },
    {
      href: '#/inventory', label: 'Inventory', icon: ICON.inventory, match: /^#\/inventory/,
      children: [
        { href: '#/inventory/products', label: 'Products', match: /^#\/inventory\/(products|add-product|product)/ },
        { href: '#/inventory/add-stock', label: 'Add Stock' },
        { href: '#/inventory/movements', label: 'Stock Movements', match: /^#\/inventory\/(movements|adjust)/ },
        { href: '#/inventory/low-stock', label: 'Low Stock', badge: 'lowStock' },
        { href: '#/inventory/hsn', label: 'HSN Code', admin: true },
      ],
    },
    {
      href: '#/purchases', label: 'Purchases', icon: ICON.purchases, admin: true, match: /^#\/purchases/,
      children: [
        { href: '#/purchases/add', label: 'Add Purchase' },
        { href: '#/purchases', label: 'Purchase History', match: /^#\/purchases(\/\d+)?$/ },
      ],
    },
    {
      href: '#/sales', label: 'Sales', icon: ICON.sales, match: /^#\/sales/,
      children: [
        { href: '#/sales/create', label: 'Create Invoice', match: /^#\/sales\/create/ },
        { href: '#/sales', label: 'Invoice History', match: /^#\/sales$|^#\/sales\/invoice/ },
        { href: '#/sales/returns', label: 'Returns' },
      ],
    },
    { href: '#/customers', label: 'Customers', icon: ICON.customers, match: /^#\/customers/ },
    { href: '#/suppliers', label: 'Suppliers', icon: ICON.suppliers, admin: true, match: /^#\/suppliers/ },
    { href: '#/analytics', label: 'Analytics', icon: ICON.analytics, admin: true },
    { href: '#/reports', label: 'Reports', icon: ICON.reports, admin: true },
  ];

  const ROUTES = [
    [/^\/?$/, (view) => window.Pages.dashboard.render(view)],
    [/^\/inventory\/?$/, (view) => window.Pages.inventory.overview(view)],
    [/^\/inventory\/products$/, (view) => window.Pages.inventory.products(view)],
    [/^\/inventory\/add-product$/, (view) => window.Pages.inventory.addProduct(view)],
    [/^\/inventory\/add-product\/(\d+)$/, (view, id) => window.Pages.inventory.addProduct(view, id)],
    [/^\/inventory\/add-stock$/, (view) => window.Pages.inventory.addStock(view)],
    [/^\/inventory\/movements$/, (view) => window.Pages.inventory.movements(view)],
    [/^\/inventory\/adjust$/, (view) => window.Pages.inventory.adjust(view)],
    [/^\/inventory\/low-stock$/, (view) => window.Pages.inventory.lowStock(view)],
    [/^\/inventory\/hsn$/, (view) => window.Pages.inventory.hsn(view)],
    [/^\/inventory\/hsn\/([^/]+)$/, (view, code) => window.Pages.inventory.hsnDetail(view, decodeURIComponent(code))],
    [/^\/inventory\/product\/(\d+)$/, (view, id) => window.Pages.inventory.productDetail(view, id)],
    [/^\/purchases\/?$/, (view) => window.Pages.purchases.history(view)],
    [/^\/purchases\/add$/, (view) => window.Pages.purchases.add(view)],
    [/^\/purchases\/(\d+)$/, (view, id) => window.Pages.purchases.detail(view, id)],
    [/^\/sales\/?$/, (view) => window.Pages.sales.history(view)],
    [/^\/sales\/create$/, (view) => window.Pages.sales.create(view)],
    [/^\/sales\/create\/(\d+)$/, (view, id) => window.Pages.sales.create(view, id)],
    [/^\/sales\/invoice\/(\d+)$/, (view, id) => window.Pages.sales.invoice(view, id)],
    [/^\/sales\/returns$/, (view) => window.Pages.sales.returns(view)],
    [/^\/sales\/returns\/new$/, (view) => window.Pages.sales.newReturn(view)],
    [/^\/customers$/, (view) => window.Pages.customers.list(view)],
    [/^\/customers\/(\d+)$/, (view, id) => window.Pages.customers.detail(view, id)],
    [/^\/suppliers$/, (view) => window.Pages.suppliers.list(view)],
    [/^\/suppliers\/(\d+)$/, (view, id) => window.Pages.suppliers.detail(view, id)],
    [/^\/analytics$/, (view) => window.Pages.reports.analytics(view)],
    [/^\/reports$/, (view) => window.Pages.reports.render(view)],
    [/^\/notifications$/, (view) => renderNotificationsPage(view)],
    [/^\/settings$/, (view) => window.Pages.settings.render(view)],
  ];

  /** Pages only the owner may open; staff get a plain explanation instead. */
  const ADMIN_ONLY = [/^\/purchases/, /^\/suppliers/, /^\/analytics/, /^\/reports/, /^\/settings/,
    /^\/inventory\/add-product/, /^\/inventory\/adjust/, /^\/inventory\/hsn/];

  const counters = { lowStock: 0 };

  function navLink(item, current, sub) {
    const active = item.match ? item.match.test(current) : current === item.href;
    const badge = item.badge && counters[item.badge]
      ? `<span class="pill">${counters[item.badge]}</span>` : '';
    const icon = item.icon
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
           stroke-linecap="round" stroke-linejoin="round"><path d="${item.icon}"/></svg>` : '';
    return `<a href="${item.href}" class="${sub ? 'sub' : ''} ${active ? 'active' : ''}">${icon}<span>${esc(item.label)}</span>${badge}</a>`;
  }

  function renderNav() {
    const current = window.location.hash || '#/';
    const allowed = (item) => (!item.admin || window.api.isAdmin())
      && (!item.permission || window.api.can(item.permission));

    document.getElementById('nav').innerHTML = NAV.filter(allowed).map((item) => {
      const children = (item.children || []).filter(allowed);
      const open = children.length && (item.match ? item.match.test(current) : false);
      return navLink(item, current) + (open ? children.map((c) => navLink(c, current, true)).join('') : '');
    }).join('');

    document.getElementById('settings-link').innerHTML = window.api.isAdmin()
      ? navLink({ href: '#/settings', label: 'Settings', icon: ICON.settings }, current)
      : '';
  }

  async function route() {
    const view = document.getElementById('view');
    const path = (window.location.hash || '#/').slice(1) || '/';
    renderNav();
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('scrim').hidden = true;
    document.getElementById('notification-panel').hidden = true;
    window.scrollTo(0, 0);

    if (!window.api.isAdmin() && ADMIN_ONLY.some((p) => p.test(path))) {
      view.innerHTML = `<div class="card"><div class="empty">
        <h3>This page is for the owner</h3>
        <p>Ask the owner if you need access to purchases, suppliers, reports or settings.</p>
        <a class="btn" href="#/">Back to Dashboard</a>
      </div></div>`;
      return;
    }

    for (const [pattern, handler] of ROUTES) {
      const match = path.match(pattern);
      if (match) {
        view.innerHTML = window.ui.loading();
        try {
          await handler(view, match[1]);
        } catch (err) {
          view.innerHTML = `<div class="alert error"><span class="glyph">!</span>
            <div><strong>${esc(err.message || 'This page could not be loaded.')}</strong><br>
            Nothing was changed. <a href="${esc(window.location.hash)}" onclick="window.location.reload()">Try again</a></div></div>`;
        }
        return;
      }
    }
    view.innerHTML = `<div class="card"><div class="empty">
      <h3>Page not found</h3><p>The page <code>${esc(path)}</code> does not exist.</p>
      <a class="btn primary" href="#/">Back to the dashboard</a></div></div>`;
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
        const lookups = [
          window.api.get('/api/products', { q, limit: 5 }),
          window.api.get('/api/invoices', { q, limit: 4 }),
          window.api.get('/api/customers', { q, limit: 4 }),
        ];
        if (window.api.can('serials')) lookups.push(window.api.get('/api/inventory/serials', { q, limit: 4 }));
        const [products, invoices, customers, serials] = await Promise.all(lookups);

        const groups = [
          {
            title: 'Products',
            items: products.products.map((p) => ({
              href: `#/inventory/product/${p.id}`,
              label: p.name,
              meta: `${p.product_code} · ${p.stock <= 0 ? 'Out of stock' : `${qty(p.stock)} in stock`}`,
              tone: p.stock <= 0 ? 'red' : 'green',
            })),
          },
          {
            title: 'Invoices',
            items: invoices.invoices.map((i) => ({
              href: `#/sales/invoice/${i.id}`,
              label: i.invoice_no,
              meta: `${i.customer_name || 'Walk-in'} · ${money(i.total)}`,
            })),
          },
          {
            title: 'Customers',
            items: customers.customers.map((c) => ({
              href: `#/customers/${c.id}`, label: c.name, meta: c.phone || `${c.transactions} invoice(s)`,
            })),
          },
          {
            title: 'Serial numbers',
            items: (serials ? serials.serials : []).map((s) => ({
              href: '#/inventory/serials',
              label: s.serial,
              meta: `${s.product_name} · ${s.status === 'AVAILABLE' ? 'Available' : 'Sold'}`,
            })),
          },
        ].filter((g) => g.items.length);

        results.innerHTML = groups.length
          ? groups.map((g) => `<div class="group-label">${esc(g.title)}</div>${g.items.map((r) => `
              <div class="item" data-href="${r.href}">
                <span class="grow">${esc(r.label)}</span>
                <span class="small ${r.tone === 'red' ? 'error' : 'muted'}">${esc(r.meta)}</span>
              </div>`).join('')}`).join('')
          : `<div style="padding:16px">
               <div style="font-size:15px">No results for “${esc(q)}”</div>
               <div class="small muted" style="margin-top:4px">Try a product name, model, serial number, invoice number or phone.</div>
             </div>`;
        results.hidden = false;
        results.querySelectorAll('[data-href]').forEach((el) => el.addEventListener('click', () => {
          window.location.hash = el.dataset.href;
          results.hidden = true;
          input.value = '';
        }));
      } catch (err) { errorToast(err); }
    };

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.global-search')) results.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // ---------- Notifications ----------
  const TONE = { ERROR: 'error', WARN: 'warn', SUCCESS: 'ok', INFO: 'info' };
  const GLYPH = { ERROR: '!', WARN: '!', SUCCESS: '✓', INFO: 'i' };

  const notificationRow = (n, clickable) => `
    <div class="row ${clickable && n.link ? 'clickable' : ''}" ${n.link ? `data-href="${esc(n.link)}"` : ''}>
      <div class="glyph ${TONE[n.level] || 'info'}">${GLYPH[n.level] || 'i'}</div>
      <div class="grow">
        <div>${esc(n.message)}</div>
        <div class="small muted" style="margin-top:3px">${dateTime(n.created_at)}</div>
      </div>
      ${n.is_read ? '' : '<span class="dot-unread"></span>'}
    </div>`;

  function wireNotificationLinks(root) {
    root.querySelectorAll('[data-href]').forEach((el) => el.addEventListener('click', () => {
      window.location.hash = el.dataset.href;
      document.getElementById('notification-panel').hidden = true;
    }));
  }

  async function refreshNotifications() {
    try {
      const { notifications, unread } = await window.api.get('/api/notifications', { limit: 20 });
      const badge = document.getElementById('bell-count');
      badge.textContent = unread;
      badge.hidden = !unread;

      const panel = document.getElementById('notification-panel');
      panel.innerHTML = `
        <div class="row head"><span class="grow">Notifications</span>
          <button class="link-btn" id="mark-read">Mark all as read</button></div>
        ${notifications.length
    ? notifications.slice(0, 5).map((n) => notificationRow(n, true)).join('')
    : '<div class="row"><span class="muted">Nothing needs your attention.</span></div>'}
        <div class="row" style="justify-content:center"><a href="#/notifications">View all notifications</a></div>`;

      panel.querySelector('#mark-read').addEventListener('click', async () => {
        await window.api.post('/api/notifications/read', {});
        refreshNotifications();
      });
      wireNotificationLinks(panel);

      const { items } = await window.api.get('/api/inventory/low-stock');
      counters.lowStock = items.length;
      renderNav();
    } catch { /* the badge is best-effort */ }
  }

  async function renderNotificationsPage(view) {
    const tab = sessionStorage.getItem('cbms_notif_tab') || '';
    const { notifications } = await window.api.get('/api/notifications', { limit: 100, type: tab });
    const tabs = [['', 'All'], ['LOW_STOCK', 'Stock'], ['INVOICE', 'Invoices'], ['SCAN', 'Scanning']];
    view.innerHTML = `
      <div style="max-width:820px">
        <div class="page-head">
          <div>
            <h1>Notifications</h1>
            <p>Only the things that need your attention.</p>
          </div>
          <div class="actions"><button class="link-btn" id="mark-all">Mark all as read</button></div>
        </div>
        <div class="tabs">${tabs.map(([key, label]) =>
    `<button data-tab="${key}" class="${tab === key ? 'active' : ''}">${label}</button>`).join('')}</div>
        <div class="card">
          ${notifications.length ? notifications.map((n) => notificationRow(n, true)).join('')
    : '<div class="empty"><h3>Nothing to report</h3><p>Low stock and scanning problems will show up here.</p></div>'}
        </div>
      </div>`;
    wireNotificationLinks(view);
    view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      sessionStorage.setItem('cbms_notif_tab', b.dataset.tab);
      renderNotificationsPage(view);
    }));
    view.querySelector('#mark-all').addEventListener('click', async () => {
      await window.api.post('/api/notifications/read', {});
      refreshNotifications();
      renderNotificationsPage(view);
    });
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

  function applyBusiness(business) {
    if (!business) return;
    const imgHtml = `<img src="/logo.png" style="width:100%;height:100%;object-fit:contain;border-radius:inherit">`;
    document.getElementById('brand-name').textContent = business.name;
    document.getElementById('brand-mark').style.background = 'transparent';
    document.getElementById('brand-mark').innerHTML = imgHtml;
    document.getElementById('login-brand-name').textContent = business.name;
    document.getElementById('login-mark').style.background = 'transparent';
    document.getElementById('login-mark').innerHTML = imgHtml;
    document.title = `${business.name} · Retail Manager`;
    document.documentElement.dataset.textSize = business.text_size || 'normal';
  }

  async function showApp(user) {
    document.getElementById('login').hidden = true;
    document.getElementById('shell').hidden = false;
    const initials = user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('user-chip').innerHTML = `
      <div class="avatar">${esc(initials)}</div>
      <div class="who"><b>${esc(user.name)}</b><span>${user.role === 'ADMIN' ? 'Owner · Admin' : 'Sales Staff'}</span></div>
      <button class="link" id="logout" title="Sign out" style="padding:8px; border-radius:50%; opacity:0.7; transition:0.2s">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>`;
    document.getElementById('logout').addEventListener('click', async () => {
      await window.api.logout();
      window.location.hash = '#/';
      showLogin();
    });
    document.getElementById('today').textContent = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
    });
    applyBusiness(window.api.state.business);
    renderNav();
    await route();
    refreshNotifications();
    clearInterval(window.__cbmsPoll);
    window.__cbmsPoll = setInterval(refreshNotifications, 60000);
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

  const drawer = (open) => {
    document.getElementById('sidebar').classList.toggle('open', open);
    document.getElementById('scrim').hidden = !open;
  };
  document.getElementById('menu-toggle').addEventListener('click', () => drawer(true));
  document.getElementById('scrim').addEventListener('click', () => drawer(false));

  document.getElementById('bell').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('notification-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) refreshNotifications();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.notification-panel') && !e.target.closest('#bell')) {
      document.getElementById('notification-panel').hidden = true;
    }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('cbms:signed-out', () => showLogin('Your session has expired. Please sign in again.'));
  window.addEventListener('cbms:settings-changed', () => {
    applyBusiness(window.api.state.business);
    renderNav();
  });

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
