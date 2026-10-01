/* Application shell: sign-in, the hash router, global search and notifications.
   Navigation is the Dashboard's grid of buttons - there is no menu here. */
(function () {
  'use strict';
  const { esc, money, qty, dateTime, errorToast } = window.ui;

  /**
   * The Hub. Every task the shop does has one button here, and nothing is
   * hidden behind a menu, a tab or a dropdown.
   */
  const HUB = [
    {
      href: '#/sales/new', icon: '🛒', tone: 'tone-sale',
      label: 'New Sale (Create Bill)', sub: 'Make a bill for a customer and print it.',
    },
    {
      href: '#/sales/history', icon: '📜',
      label: 'Search Past Bills & Returns', sub: 'Find an old bill, print it again, or take goods back.',
    },
    {
      href: '#/inventory/add', icon: '📦', tone: 'tone-stock',
      label: 'Enter Supplier Bill (Add Stock)', sub: 'Put new stock on the shelf from a supplier bill.',
    },
    {
      href: '#/inventory/list', icon: '📋',
      label: 'View Current Inventory', sub: 'See what is on the shelf and what is running out.',
    },
    {
      href: '#/contacts', icon: '📒',
      label: 'Address Book (Contacts)', sub: 'Customers and suppliers, with what they bought.',
    },
    {
      href: '#/admin', icon: '⚙️', tone: 'tone-admin', admin: true,
      label: 'Admin, Reports & Settings', sub: 'GST reports, products, staff and shop settings.',
    },
  ];

  /** Old addresses still work; they land on the page that replaced them. */
  const REDIRECTS = [
    [/^\/sales\/create$/, '#/sales/new'],
    [/^\/sales\/create\/(\d+)$/, (id) => `#/sales/new/${id}`],
    [/^\/sales$/, '#/sales/history'],
    [/^\/inventory$/, '#/inventory/list'],
    [/^\/inventory\/products$/, '#/inventory/list'],
    [/^\/inventory\/add-stock$/, '#/inventory/add'],
    [/^\/customers$/, '#/contacts'],
    [/^\/customers\/(\d+)$/, (id) => `#/contacts/customer/${id}`],
    [/^\/suppliers$/, '#/contacts'],
    [/^\/suppliers\/(\d+)$/, (id) => `#/contacts/supplier/${id}`],
    [/^\/settings$/, '#/admin'],
  ];

  const ROUTES = [
    [/^\/?$/, 'Dashboard', (view) => window.Pages.dashboard.render(view)],

    // The six spokes.
    [/^\/sales\/new$/, 'New Sale', (view) => window.Pages.sales.create(view)],
    [/^\/sales\/new\/(\d+)$/, 'the Draft Bill', (view, id) => window.Pages.sales.create(view, id)],
    [/^\/sales\/history$/, 'Past Bills', (view) => window.Pages.sales.history(view)],
    [/^\/inventory\/add$/, 'Add Stock', (view) => window.Pages.inventory.addStock(view)],
    [/^\/inventory\/list$/, 'Inventory', (view) => window.Pages.inventory.products(view)],
    [/^\/contacts$/, 'the Address Book', (view) => window.Pages.contacts.list(view)],
    [/^\/admin$/, 'Admin', (view) => window.Pages.admin.render(view)],

    // Pages opened from one of the six.
    [/^\/sales\/invoice\/(\d+)$/, 'the Bill', (view, id) => window.Pages.sales.invoice(view, id)],
    [/^\/sales\/returns$/, 'Returns', (view) => window.Pages.sales.returns(view)],
    [/^\/sales\/returns\/new$/, 'the Return', (view) => window.Pages.sales.newReturn(view)],
    [/^\/inventory\/product\/(\d+)$/, 'the Product', (view, id) => window.Pages.inventory.productDetail(view, id)],
    [/^\/inventory\/low-stock$/, 'Low Stock', (view) => window.Pages.inventory.lowStock(view)],
    [/^\/inventory\/serials$/, 'Serial Numbers', (view) => window.Pages.inventory.serials(view)],
    [/^\/contacts\/customer\/(\d+)$/, 'the Contact', (view, id) => window.Pages.customers.detail(view, id)],
    [/^\/contacts\/supplier\/(\d+)$/, 'the Contact', (view, id) => window.Pages.suppliers.detail(view, id)],
    [/^\/inventory\/add-product$/, 'Add Product', (view) => window.Pages.inventory.addProduct(view)],
    [/^\/inventory\/add-product\/(\d+)$/, 'Edit Product', (view, id) => window.Pages.inventory.addProduct(view, id)],
    [/^\/inventory\/services$/, 'Services', (view) => window.Pages.inventory.services(view)],
    [/^\/inventory\/add-service$/, 'Add Service', (view) => window.Pages.inventory.addService(view)],
    [/^\/inventory\/add-service\/(\d+)$/, 'Edit Service', (view, id) => window.Pages.inventory.addService(view, id)],
    [/^\/inventory\/movements$/, 'Stock Movements', (view) => window.Pages.inventory.movements(view)],
    [/^\/inventory\/adjust$/, 'Correct Stock Count', (view) => window.Pages.inventory.adjust(view)],
    [/^\/inventory\/hsn$/, 'HSN Codes', (view) => window.Pages.inventory.hsn(view)],
    [/^\/inventory\/hsn\/([^/]+)$/, 'the HSN Code', (view, code) => window.Pages.inventory.hsnDetail(view, decodeURIComponent(code))],
    [/^\/purchases\/?$/, 'Supplier Bills', (view) => window.Pages.purchases.history(view)],
    [/^\/purchases\/add$/, 'Enter Supplier Bill', (view) => window.Pages.purchases.add(view)],
    [/^\/purchases\/(\d+)$/, 'the Supplier Bill', (view, id) => window.Pages.purchases.detail(view, id)],
    [/^\/analytics$/, 'Sales Figures', (view) => window.Pages.reports.analytics(view)],
    [/^\/reports$/, 'Reports', (view) => window.Pages.reports.render(view)],
    [/^\/notifications$/, 'Notifications', (view) => renderNotificationsPage(view)],
  ];

  /** Pages only the owner may open; staff get a plain explanation instead. */
  const ADMIN_ONLY = [/^\/purchases/, /^\/analytics/, /^\/reports/, /^\/settings/, /^\/admin/,
    /^\/inventory\/add-product/, /^\/inventory\/add-service/, /^\/inventory\/adjust/, /^\/inventory\/hsn/];

  /** The Hub's buttons, used by the Dashboard. */
  const hubButtons = () => HUB.filter((b) => !b.admin || window.api.isAdmin()).map((b) => `
    <a class="hub-btn ${b.tone || ''}" href="${b.href}">
      <span class="hub-icon" aria-hidden="true">${b.icon}</span>
      <span>
        <span class="hub-label">${esc(b.label)}</span>
        <span class="hub-sub">${esc(b.sub)}</span>
      </span>
    </a>`).join('');

  /**
   * Where the user has been, newest last, so the Back button can name the page
   * it returns to instead of always marching them to the Dashboard.
   *
   * It follows its own trail rather than the browser's history, because a page
   * can also be reached by a button that goes "back" without the browser
   * knowing; the two would drift apart. The browser's own back button still
   * works, and lands on the same place.
   */
  const trail = [];

  function rememberVisit(path, title) {
    const last = trail[trail.length - 1];
    if (last && last.path === path) { last.title = title; return; }
    // Returning to the page before this one closes the loop instead of
    // stacking, so going back and forth cannot grow the trail for ever.
    if (trail.length > 1 && trail[trail.length - 2].path === path) { trail.pop(); return; }
    trail.push({ path, title });
    // A very long wander is trimmed from the bottom; the Dashboard is the floor.
    if (trail.length > 50) trail.splice(0, trail.length - 50);
  }

  /** Where Back goes from here: the page before, or the Dashboard. */
  const previousPage = () => (trail.length > 1
    ? trail[trail.length - 2]
    : { path: '/', title: 'Dashboard' });

  function renderBackButton() {
    const bar = document.getElementById('backbar');
    if (trail.length <= 1 && trail[0] && trail[0].path === '/') { bar.innerHTML = ''; return; }
    const previous = previousPage();
    bar.innerHTML = `<a class="back-home" href="#${previous.path}">⬅️ Back to ${esc(previous.title)}</a>`;
  }

  async function route() {
    // Every visit gets a fresh view element. A page still waiting on the
    // server when the next one starts keeps writing to the old element, which
    // is no longer in the document, so a slow page can never paint over the
    // one the user has already moved on to.
    const previous = document.getElementById('view');
    const view = previous.cloneNode(false);
    previous.replaceWith(view);
    // "?product=5" carries context for the page; it is not part of the route.
    const hash = window.location.hash || '#/';
    const path = hash.slice(1).split('?')[0] || '/';
    const query = hash.includes('?') ? `?${hash.split('?')[1]}` : '';

    for (const [pattern, to] of REDIRECTS) {
      const hit = path.match(pattern);
      if (hit) {
        window.location.replace(`${typeof to === 'function' ? to(hit[1]) : to}${query}`);
        return;
      }
    }

    document.getElementById('notification-panel').hidden = true;
    window.scrollTo(0, 0);

    if (!window.api.isAdmin() && ADMIN_ONLY.some((p) => p.test(path))) {
      rememberVisit(path, 'that page');
      renderBackButton();
      view.innerHTML = `<div class="card"><div class="empty">
        <h3>This page is for the owner</h3>
        <p>Ask the owner if you need access to purchases, reports or settings.</p>
      </div></div>`;
      return;
    }

    for (const [pattern, title, handler] of ROUTES) {
      const match = path.match(pattern);
      if (match) {
        rememberVisit(path, title);
        renderBackButton();
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
    rememberVisit(path, 'Page not found');
    renderBackButton();
    view.innerHTML = `<div class="card"><div class="empty">
      <h3>Page not found</h3><p>The page <code>${esc(path)}</code> does not exist.</p></div></div>`;
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

    } catch { /* the badge is best-effort */ }
  }

  async function renderNotificationsPage(view) {
    const tab = sessionStorage.getItem('cbms_notif_tab') || '';
    const { notifications } = await window.api.get('/api/notifications', { limit: 100, type: tab });
    const kinds = [['', 'Everything'], ['LOW_STOCK', 'Stock'], ['INVOICE', 'Invoices'], ['SCAN', 'Scanning']];
    view.innerHTML = `
      <div style="max-width:820px">
        <div class="page-head">
          <div>
            <h1>Notifications</h1>
            <p>Only the things that need your attention.</p>
          </div>
          <div class="actions"><button class="link-btn" id="mark-all">Mark all as read</button></div>
        </div>
        <div class="filters">
          <label style="margin:0">Show
            <select id="kind">${kinds.map(([key, label]) =>
    `<option value="${key}" ${tab === key ? 'selected' : ''}>${label}</option>`).join('')}</select>
          </label>
        </div>
        <div class="card">
          ${notifications.length ? notifications.map((n) => notificationRow(n, true)).join('')
    : '<div class="empty"><h3>Nothing to report</h3><p>Low stock and scanning problems will show up here.</p></div>'}
        </div>
      </div>`;
    wireNotificationLinks(view);
    view.querySelector('#kind').addEventListener('change', (e) => {
      sessionStorage.setItem('cbms_notif_tab', e.target.value);
      renderNotificationsPage(view);
    });
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
  window.addEventListener('cbms:settings-changed', () => applyBusiness(window.api.state.business));

  window.hubButtons = hubButtons;

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
