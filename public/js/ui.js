/* Shared rendering helpers: formatting, tables, modals, toasts, product pickers. */
(function () {
  'use strict';

  const esc = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const money = (n, withSymbol = true) => {
    const value = Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return withSymbol ? `₹${value}` : value;
  };

  /** Compact money for KPI cards: ₹8.45L / ₹1.2Cr. */
  const moneyShort = (n) => {
    const v = Number(n || 0);
    if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
    if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
    if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
    return money(v);
  };

  const qty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  /** Rupees without paise, the way the shop reads a headline number. */
  const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

  /** "1 product" / "3 products" — small courtesies the design insists on. */
  const plural = (n, one, many) => `${qty(n)} ${Number(n) === 1 ? one : (many || `${one}s`)}`;

  const date = (value) => {
    if (!value) return '-';
    const d = new Date(String(value).length <= 10 ? `${value}T00:00:00` : value.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const dateTime = (value) => {
    if (!value) return '-';
    const d = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = () => iso(new Date());

  /** Named date ranges used by the dashboard and report filters. */
  function range(key) {
    const now = new Date();
    const start = new Date(now);
    switch (key) {
      case 'today': break;
      case 'week': start.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); break;
      case 'month': start.setDate(1); break;
      case 'quarter': start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); break;
      case 'year': start.setMonth(0, 1); break;
      case 'last30': start.setDate(now.getDate() - 29); break;
      case 'all': return { from: '2000-01-01', to: iso(now) };
      default: start.setDate(1);
    }
    return { from: iso(start), to: iso(now) };
  }

  const STATUS_CLASS = {
    ISSUED: 'green', DRAFT: '', CANCELLED: 'red', CONFIRMED: 'green', NEEDS_REVIEW: 'amber',
    AVAILABLE: 'green', SOLD: 'blue', RETURNED: 'blue', DAMAGED: 'red',
  };
  const STATUS_LABEL = {
    ISSUED: 'Issued', DRAFT: 'Draft', CANCELLED: 'Cancelled', CONFIRMED: 'Received',
    NEEDS_REVIEW: 'Needs review', AVAILABLE: 'Available', SOLD: 'Sold',
    RETURNED: 'Returned', DAMAGED: 'Damaged',
  };
  const statusTag = (status) =>
    `<span class="tag ${STATUS_CLASS[status] || ''}">${esc(STATUS_LABEL[status] || status)}</span>`;

  /** In stock / Low stock / Out of stock, always text plus colour. */
  function stockState(product) {
    if (Number(product.stock) <= 0) return { label: 'Out of Stock', tone: 'red' };
    if (Number(product.min_stock) > 0 && Number(product.stock) <= Number(product.min_stock)) {
      return { label: 'Low Stock', tone: 'amber' };
    }
    return { label: 'In Stock', tone: 'green' };
  }
  const stockTag = (product) => {
    const s = stockState(product);
    return `<span class="tag ${s.tone}">${s.label}</span>`;
  };

  const MOVEMENT_LABEL = {
    OPENING: 'Opening', PURCHASE: 'Purchase', SALE: 'Sale', RETURN: 'Return',
    DAMAGE: 'Damage', ADJUSTMENT: 'Adjustment', CANCELLED_SALE: 'Invoice cancelled',
  };

  function toast(message, type = 'info', timeout = 4200) {
    const stack = document.getElementById('toast-stack');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  const errorToast = (err) => toast(err && err.message ? err.message : 'Something went wrong.', 'error', 6000);

  /** Promise-based modal. resolve(null) on cancel. */
  function modal({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', deleteLabel, onRender, onConfirm, onDelete, wide, danger }) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" ${wide ? 'style="width:min(900px,100%)"' : ''}>
          <header><h2>${esc(title)}</h2></header>
          <div class="body">${body}</div>
          <footer>
            ${deleteLabel ? `<button class="btn danger" data-delete style="margin-right:auto">${esc(deleteLabel)}</button>` : ''}
            <button class="btn" data-cancel>${esc(cancelLabel)}</button>
            ${confirmLabel ? `<button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmLabel)}</button>` : ''}
          </footer>
        </div>`;
      root.appendChild(backdrop);

      const close = (value) => { backdrop.remove(); resolve(value); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
      backdrop.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      const confirmBtn = backdrop.querySelector('[data-confirm]');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
          try {
            const value = onConfirm ? await onConfirm(backdrop, close) : true;
            if (value !== undefined) close(value);
          } catch (err) { errorToast(err); }
        });
      }
      const delBtn = backdrop.querySelector('[data-delete]');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          try {
            const value = onDelete ? await onDelete(backdrop, close) : true;
            if (value !== undefined) close(value);
          } catch (err) { errorToast(err); }
        });
      }
      if (onRender) onRender(backdrop, close);
    });
  }

  const confirm = (title, message, confirmLabel = 'Confirm', danger = false) =>
    modal({ title, body: `<p>${esc(message)}</p>`, confirmLabel, danger, onConfirm: () => true });

  /** Build a table; columns: {key,label,class,render,num}. */
  function table(rows, columns, options = {}) {
    if (!rows.length) return `<div class="empty">${esc(options.empty || 'Nothing to show yet.')}</div>`;
    const head = columns.map((c) => `<th class="${c.num ? 'num' : ''} ${c.class || ''}">${esc(c.label)}</th>`).join('');
    const body = rows.map((row, i) => {
      const cells = columns.map((c, ci) => {
        const value = c.render ? c.render(row, i) : esc(row[c.key]);
        const classes = [c.num ? 'num' : '', c.class || '', ci === 0 ? 'headline' : ''].filter(Boolean).join(' ');
        const label = c.noLabel ? '' : esc(c.label);
        return `<td class="${classes}" data-label="${label}">${value === undefined || value === null ? '' : value}</td>`;
      }).join('');
      const attrs = options.rowAttrs ? options.rowAttrs(row) : '';
      return `<tr class="${options.clickable === false ? '' : 'clickable'}" ${attrs}>${cells}</tr>`;
    }).join('');
    // On a phone the same markup renders as cards, which is what the design asks for.
    return `<div class="table-wrap"><table class="${options.stacked === false ? '' : 'stacked'}">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody>
      ${options.foot ? `<tfoot><tr>${options.foot}</tr></tfoot>` : ''}</table></div>`;
  }

  const kpi = ({ label, value, sub, delta, accent }) => `
    <div class="kpi ${accent || ''}">
      <div class="label">${esc(label)}</div>
      <div class="value">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
      ${delta === undefined || delta === null ? '' :
      `<div class="sub delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs previous</div>`}
    </div>`;

  /** Skeleton rows: loading shows the shape of the answer, never a spinner. */
  const skeleton = (rows = 6) => `<div class="card">${Array.from({ length: rows }, () => `
    <div class="skeleton-row"><div style="flex:2"></div><div style="flex:1"></div><div style="flex:1"></div>
    <div style="width:80px"></div></div>`).join('')}</div>`;

  const loading = () => skeleton(6);

  /** The page title block. One primary action, everything else a link. */
  function pageHead({ eyebrow, title, sub, actions, back }) {
    // Accept a bare href as well as { href, label }.
    if (typeof back === 'string') back = { href: back, label: 'Back' };
    return `
      ${back ? `<a class="back-link" href="${back.href}">← ${esc(back.label)}</a>` : ''}
      <div class="page-head">
        <div>
          ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
          <div class="title-row"><h1>${title}</h1></div>
          ${sub ? `<p>${sub}</p>` : ''}
        </div>
        ${actions ? `<div class="actions">${actions}</div>` : ''}
      </div>`;
  }

  /** Hairline grid of numbers; each tile may link somewhere. */
  const tiles = (list) => `<div class="tiles">${list.map((t) => `
    <div class="kpi ${t.accent || ''} ${t.href ? 'clickable' : ''}" ${t.href ? `data-href="${t.href}"` : ''}>
      <div class="label">${esc(t.label)}</div>
      <div class="value">${t.value}</div>
      ${t.note ? `<div class="sub">${t.note}</div>` : ''}
      ${t.delta === undefined || t.delta === null ? ''
    : `<div class="sub delta ${t.delta >= 0 ? 'up' : 'down'}">${t.delta >= 0 ? '▲' : '▼'} ${Math.abs(t.delta)}% vs previous</div>`}
    </div>`).join('')}</div>`;

  const emptyState = ({ title, text, action }) => `
    <div class="card"><div class="empty">
      <h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${action || ''}
    </div></div>`;

  /**
   * Buttons you can read, in place of a hidden "more" menu. `items` are
   * {label, action, danger}; the action name comes back through data-action.
   * Keep it to two or three per row — anything rarer belongs on the page the
   * row opens.
   */
  const rowActions = (items) => `<div class="row-actions">${items.filter(Boolean).map((i) =>
    `<button type="button" class="btn small ${i.danger ? 'danger' : ''}" data-action="${esc(i.action)}">${esc(i.label)}</button>`).join('')}</div>`;

  /** Wire every row button inside `root`, calling handlers[action](row). */
  function wireRowActions(root, handlers) {
    root.querySelectorAll('.row-actions [data-action]').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const handler = handlers[button.dataset.action];
        if (handler) handler(button.closest('[data-id]'));
      });
    });
  }

  /** Clickable rows: wire every element carrying data-href. */
  function wireLinks(root) {
    root.querySelectorAll('[data-href]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions') || e.target.closest('button') || e.target.closest('a')) return;
      window.location.hash = el.dataset.href;
    }));
  }

  /**
   * Type-ahead product search box. Calls onSelect(product).
   * Used by invoicing, add stock and adjustments so products are searched, never typed.
   * options.type 'SERVICE' searches services instead of goods. options.onCreate(text),
   * when given, offers "+ Add New Product" for a search with no match; it resolves
   * to the created record (or null), which is then selected like any other.
   */
  function productSearch(container, onSelect, options = {}) {
    const service = options.type === 'SERVICE';
    const noun = service ? 'service' : 'product';
    container.innerHTML = `
      <label>${esc(options.label || 'Product')}
        <input type="search" placeholder="${esc(options.placeholder || 'Search by name, brand, model, ID, HSN or serial…')}" autocomplete="off">
      </label>
      <div class="pick-list" hidden></div>`;
    const input = container.querySelector('input');
    const list = container.querySelector('.pick-list');
    let timer;

    const choose = (product) => {
      list.hidden = true;
      input.value = options.keepText ? product.name : '';
      onSelect(product);
    };

    const render = (products) => {
      const typed = input.value.trim();
      if (!products.length && options.onCreate) {
        list.innerHTML = `<div class="item muted">No ${noun} matches “${esc(typed)}”.</div>
          <div class="item" data-new="1"><strong>+ Add New ${service ? 'Service' : 'Product'}</strong>
            <span class="small muted">&nbsp;“${esc(typed)}”</span></div>`;
      } else if (!products.length) {
        list.innerHTML = service
          ? '<div class="item muted">No matching service. Add it from Inventory → Services.</div>'
          : '<div class="item muted">No matching product. Add it from Inventory → Add Product.</div>';
      } else {
        list.innerHTML = products.map((p) => `
          <div class="item" data-id="${p.id}">
            <div class="grow">
              <strong>${esc(p.name)}</strong>
              <div class="small muted">${esc(p.product_code)} · ${esc(p.brand || '-')} · HSN ${esc(p.hsn_code || '-')}</div>
            </div>
            <div class="right small">
              ${p.item_type === 'SERVICE' ? '<div class="tag blue">Service</div>'
    : `<div class="tag ${p.stock <= 0 ? 'red' : (p.min_stock > 0 && p.stock <= p.min_stock ? 'amber' : 'green')}">Stock: ${qty(p.stock)}</div>`}
              <div class="muted">${money(p.selling_price)}</div>
            </div>
          </div>`).join('');
      }
      list.hidden = false;
      list.querySelectorAll('.item[data-id]').forEach((el) => {
        el.addEventListener('click', () => choose(products.find((p) => String(p.id) === el.dataset.id)));
      });
      const add = list.querySelector('[data-new]');
      if (add) {
        add.addEventListener('click', async () => {
          list.hidden = true;
          const created = await options.onCreate(typed);
          if (created) choose(created);
        });
      }
    };

    const search = async (all = false) => {
      const q = input.value.trim();
      if (q.length < 1 && !all) { list.hidden = true; return; }
      try {
        const data = await window.api.get('/api/products', { q, limit: 12, type: service ? 'SERVICE' : '' });
        render(data.products);
      } catch (err) { errorToast(err); }
    };


    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(service), 180); });
    // Services are few, so their picker lists them all before anything is typed.
    input.addEventListener('focus', () => { if (input.value.trim() || service) search(service); });
    document.addEventListener('click', (e) => { if (!container.contains(e.target)) list.hidden = true; });
    return input;
  }

  /** Generic search-select for customers or suppliers. */
  function partySearch(container, kind, onSelect, options = {}) {
    container.innerHTML = `
      <label>${esc(options.label || (kind === 'customers' ? 'Customer' : 'Supplier'))}
        <input type="search" placeholder="Search by name, phone, email or GSTIN…" autocomplete="off" value="${esc(options.value || '')}">
      </label>
      <div class="pick-list" hidden></div>`;
    const input = container.querySelector('input');
    const list = container.querySelector('.pick-list');
    let timer;

    const search = async () => {
      const q = input.value.trim();
      try {
        const data = await window.api.get(`/api/${kind}`, { q, limit: 10 });
        const rows = data[kind];
        list.innerHTML = `${rows.map((r) => `
          <div class="item" data-id="${r.id}">
            <div class="grow"><strong>${esc(r.name)}</strong>
              <div class="small muted">${esc(r.phone || '-')} ${r.gstin ? `· ${esc(r.gstin)}` : ''} · ${r.transactions || 0} transaction(s)</div>
            </div>
          </div>`).join('')}
          <div class="item" data-new="1"><strong>+ Add "${esc(input.value.trim() || 'new')}"</strong></div>`;
        list.hidden = false;
        list.querySelectorAll('.item[data-id]').forEach((el) => el.addEventListener('click', () => {
          const record = rows.find((r) => String(r.id) === el.dataset.id);
          input.value = record.name;
          list.hidden = true;
          onSelect(record);
        }));
        list.querySelector('[data-new]').addEventListener('click', async () => {
          list.hidden = true;
          const created = await quickAddParty(kind, input.value.trim());
          if (created) { input.value = created.name; onSelect(created); }
        });
      } catch (err) { errorToast(err); }
    };

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 180); });
    input.addEventListener('focus', search);
    document.addEventListener('click', (e) => { if (!container.contains(e.target)) list.hidden = true; });
    return input;
  }

  async function quickAddParty(kind, name = '') {
    const label = kind === 'customers' ? 'Customer' : 'Supplier';
    return modal({
      title: `Add ${label}`,
      confirmLabel: `Save ${label}`,
      body: `
        <div class="form-grid">
          <label class="full">Name<input name="name" value="${esc(name)}" required></label>
          <label>Phone<input name="phone"></label>
          <label>Email<input name="email" type="email"></label>
          <label class="full">Address<textarea name="address"></textarea></label>
          ${kind === 'customers' ? '<label class="full">Shipping Address (if different)<textarea name="shipping_address"></textarea></label>' : ''}
          <label>GSTIN<input name="gstin" placeholder="Optional"></label>
        </div>`,
      onConfirm: async (root) => {
        const form = Object.fromEntries([...root.querySelectorAll('[name]')].map((el) => [el.name, el.value.trim()]));
        if (!form.name) { toast('Name is required.', 'error'); return undefined; }
        const data = await window.api.post(`/api/${kind}`, form);
        toast(`${label} saved.`, 'success');
        return data.record;
      },
    });
  }

  const formValues = (root) => {
    const out = {};
    root.querySelectorAll('[name]').forEach((el) => {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number') out[el.name] = el.value === '' ? '' : Number(el.value);
      else out[el.name] = el.value.trim();
    });
    return out;
  };

  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
    'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
  const three = (n) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? two(n % 100) : '']
    .filter(Boolean).join(' ');

  /** Indian numbering, mirroring server/lib/numberwords.js for the preview. */
  function inWords(value) {
    let n = Math.floor(Math.abs(Number(value) || 0));
    if (!n) return '';
    const out = [];
    const crore = Math.floor(n / 1e7); n %= 1e7;
    const lakh = Math.floor(n / 1e5); n %= 1e5;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) out.push(`${inWords(crore)} Crore`);
    if (lakh) out.push(`${two(lakh)} Lakh`);
    if (thousand) out.push(`${two(thousand)} Thousand`);
    if (n) out.push(three(n));
    return out.join(' ');
  }

  function rupeesInWords(amount) {
    const value = Number(amount) || 0;
    const whole = Math.floor(Math.abs(value));
    const paise = Math.round((Math.abs(value) - whole) * 100);
    return `Rupees ${whole ? inWords(whole) : 'Zero'}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
  }

  window.ui = {
    esc, money, moneyShort, rupees, plural, qty, date, dateTime, iso, todayIso, range, statusTag, stockTag, stockState,
    MOVEMENT_LABEL, inWords, rupeesInWords,
    toast, errorToast, modal, confirm, table, kpi, tiles, loading, skeleton, pageHead, emptyState,
    rowActions, wireRowActions, wireLinks,
    productSearch, partySearch, quickAddParty, formValues,
  };
})();
