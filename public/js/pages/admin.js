/* Admin, Reports & Settings — the owner's single page.
   The top is buttons, one per job, laid out exactly like the Dashboard so
   there is nothing new to learn. Below them, every shop setting on the same
   scrolling page. Nothing is behind a tab or a menu. */
(function () {
  'use strict';
  const { esc, pageHead } = window.ui;

  const GROUPS = [
    ['Reports & GST', [
      ['#/reports', '📄', 'Download Reports', 'GST, sales, stock and profit, as Excel or PDF.'],
      ['#/analytics', '📈', 'Sales Figures', 'What sold, what earns most, and the trend.'],
      ['#/inventory/hsn', '🧾', 'HSN Summary', 'Sales grouped by HSN code, for your GST return.'],
    ]],
    ['Products & Services', [
      ['#/inventory/add-product', '➕', 'Add a Product', 'Put a new item in the price list.'],
      ['#/inventory/services', '🔧', 'Services', 'Installation, repairs and other work you charge for.'],
      ['#/inventory/list', '📋', 'All Products', 'The full price list and what is on the shelf.'],
    ]],
    ['Stock Control', [
      ['#/inventory/movements', '🔁', 'Stock Movements', 'Every item that came in or went out.'],
      ['#/inventory/adjust', '✏️', 'Correct Stock Count', 'Fix the count after a stock check or breakage.'],
      ['#/inventory/low-stock', '⚠️', 'Low Stock', 'What has run out or is about to.'],
      ['#/inventory/serials', '#️⃣', 'Serial Numbers', 'Look up where any unit came from and went.'],
    ]],
    ['Supplier Bills', [
      ['#/purchases/add', '📥', 'Enter a Supplier Bill', 'Record a bill from a distributor.'],
      ['#/purchases', '🗂️', 'Past Supplier Bills', 'Everything you have bought.'],
    ]],
  ];

  const button = ([href, icon, label, sub]) => `
    <a class="hub-btn" href="${href}">
      <span class="hub-icon" aria-hidden="true">${icon}</span>
      <span>
        <span class="hub-label">${esc(label)}</span>
        <span class="hub-sub">${esc(sub)}</span>
      </span>
    </a>`;

  async function render(view) {
    view.innerHTML = `
      ${pageHead({
    title: 'Admin, Reports & Settings',
    sub: 'Everything the owner looks after. Scroll down for the shop settings.',
  })}
      ${GROUPS.map(([heading, items]) => `
        <div class="page-section">
          <h2>${esc(heading)}</h2>
          <div class="hub compact">${items.map(button).join('')}</div>
        </div>`).join('')}

      <div class="page-section">
        <h2>Shop Settings</h2>
        <div id="settings-host"></div>
      </div>`;

    await window.Pages.settings.render(view.querySelector('#settings-host'), { embedded: true });
  }

  window.Pages = window.Pages || {};
  window.Pages.admin = { render };
})();
