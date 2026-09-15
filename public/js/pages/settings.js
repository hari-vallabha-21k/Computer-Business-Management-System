/* Settings: business profile, invoice/QR configuration, stock rules and users. */
(function () {
  'use strict';
  const { esc, table, loading, toast, errorToast, modal, formValues, date } = window.ui;

  async function render(view) {
    const admin = window.api.isAdmin();
    if (!admin) {
      view.innerHTML = '<div class="alert warn">Settings are available to the business owner only.</div>';
      return;
    }
    view.innerHTML = loading();
    const { settings } = await window.api.get('/api/settings');

    view.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1>
        <p class="muted">Set this up once - invoices, numbering and stock rules follow it everywhere.</p></div></div>

      <form class="card" id="business">
        <div class="card-head"><h2>Business Profile</h2></div>
        <div class="form-grid">
          <label class="full">Business Name<input name="name" value="${esc(settings.name)}"></label>
          <label class="full">Address<textarea name="address">${esc(settings.address || '')}</textarea></label>
          <label>Phone<input name="phone" value="${esc(settings.phone || '')}"></label>
          <label>Email<input name="email" value="${esc(settings.email || '')}"></label>
          <label>GSTIN<input name="gstin" value="${esc(settings.gstin || '')}" placeholder="27AAAPV1234C1ZK"></label>
          <label class="full">Bank / Payment Details<input name="bank_details" value="${esc(settings.bank_details || '')}"></label>
          <label class="full">Invoice Terms<textarea name="terms">${esc(settings.terms || '')}</textarea></label>
        </div>

        <div class="card-head" style="margin-top:18px"><h2>Invoice &amp; QR</h2></div>
        <div class="form-grid">
          <label>Invoice Prefix<input name="invoice_prefix" value="${esc(settings.invoice_prefix)}"></label>
          <label>Purchase Prefix<input name="purchase_prefix" value="${esc(settings.purchase_prefix)}"></label>
          <label>Return Prefix<input name="return_prefix" value="${esc(settings.return_prefix)}"></label>
          <label>Adjustment Prefix<input name="adjustment_prefix" value="${esc(settings.adjustment_prefix)}"></label>
          <label>QR Code On Invoices<select name="qr_mode">
            <option value="INVOICE_INFO" ${settings.qr_mode === 'INVOICE_INFO' ? 'selected' : ''}>Invoice information</option>
            <option value="PAYMENT_UPI" ${settings.qr_mode === 'PAYMENT_UPI' ? 'selected' : ''}>UPI payment</option>
            <option value="VERIFY_URL" ${settings.qr_mode === 'VERIFY_URL' ? 'selected' : ''}>Invoice verification link</option>
          </select></label>
          <label>UPI ID<input name="upi_id" value="${esc(settings.upi_id || '')}" placeholder="business@upi"></label>
        </div>
        <p class="small muted">Official GST e-invoicing (IRN / signed government QR) is a separate compliance integration
          and is not produced by these QR modes.</p>

        <div class="card-head" style="margin-top:18px"><h2>Stock Rules</h2></div>
        <label class="check"><input type="checkbox" name="allow_negative_stock" ${settings.allow_negative_stock ? 'checked' : ''}>
          Allow invoices to be issued for more units than are in stock (negative stock)</label>
        <p class="small muted">Off by default: an invoice that would take stock below zero is blocked with a clear message.</p>

        <div class="btn-row" style="margin-top:16px"><button class="btn primary" type="submit">Save Settings</button></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>Users</h2>
          <div class="actions"><button class="btn primary" id="add-user">+ Add User</button></div></div>
        <div id="users">${loading()}</div>
        <p class="small muted">Sales staff can create invoices and look up stock, but cannot change products,
          settings or record stock adjustments.</p>
      </div>`;

    view.querySelector('#business').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { settings: saved } = await window.api.put('/api/settings', formValues(e.target));
        window.api.state.business = saved;
        document.getElementById('brand-name').textContent = saved.name;
        toast('Settings saved.', 'success');
      } catch (err) { errorToast(err); }
    });

    const loadUsers = async () => {
      const { users } = await window.api.get('/api/users');
      view.querySelector('#users').innerHTML = table(users, [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'role', label: 'Role', render: (r) => `<span class="tag ${r.role === 'ADMIN' ? 'blue' : ''}">${esc(r.role)}</span>` },
        { key: 'active', label: 'Status', render: (r) => (r.active ? '<span class="tag green">Active</span>' : '<span class="tag red">Disabled</span>') },
        { key: 'created_at', label: 'Added', render: (r) => date(r.created_at) },
        { key: 'actions', label: '', render: (r) => `<button class="btn small" data-user="${r.id}">Edit</button>` },
      ]);

      view.querySelectorAll('[data-user]').forEach((btn) => btn.addEventListener('click', async () => {
        const user = users.find((u) => String(u.id) === btn.dataset.user);
        const saved = await modal({
          title: `Edit ${user.name}`,
          confirmLabel: 'Save',
          body: `<div class="form-grid">
              <label class="full">Name<input name="name" value="${esc(user.name)}"></label>
              <label>Role<select name="role">
                <option value="ADMIN" ${user.role === 'ADMIN' ? 'selected' : ''}>Owner / Admin</option>
                <option value="STAFF" ${user.role === 'STAFF' ? 'selected' : ''}>Sales Staff</option>
              </select></label>
              <label class="check"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> Active</label>
            </div>`,
          onConfirm: (root) => window.api.put(`/api/users/${user.id}`, formValues(root)),
        });
        if (saved) { toast('User updated.', 'success'); loadUsers(); }
      }));
    };

    view.querySelector('#add-user').addEventListener('click', async () => {
      const created = await modal({
        title: 'Add User',
        confirmLabel: 'Create User',
        body: `<div class="form-grid">
            <label class="full">Name *<input name="name"></label>
            <label>Email *<input name="email" type="email"></label>
            <label>Password *<input name="password" type="password" placeholder="At least 6 characters"></label>
            <label>Role<select name="role"><option value="STAFF">Sales Staff</option><option value="ADMIN">Owner / Admin</option></select></label>
          </div>`,
        onConfirm: (root) => window.api.post('/api/users', formValues(root)),
      });
      if (created) { toast('User created.', 'success'); loadUsers(); }
    });

    await loadUsers();
  }

  window.Pages = window.Pages || {};
  window.Pages.settings = { render };
})();
