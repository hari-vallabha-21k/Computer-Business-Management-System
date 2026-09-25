/* Settings: set these up once, and everything else uses them automatically. */
(function () {
  'use strict';
  const {
    esc, money, table, skeleton, toast, errorToast, modal, formValues, date, dateTime, pageHead,
  } = window.ui;

  const SECTIONS = [
    ['business', 'Business Details'],
    ['invoice', 'Invoice Settings'],
    ['tax', 'Tax / GST'],
    ['users', 'Users & Roles'],
    ['backup', 'Backup'],
    ['prefs', 'Preferences'],
  ];

  async function render(view) {
    if (!window.api.isAdmin()) {
      view.innerHTML = `<div class="card"><div class="empty"><h3>This page is for the owner</h3>
        <p>Ask the owner if you need something changed here.</p>
        <a class="btn" href="#/">Back to Dashboard</a></div></div>`;
      return;
    }

    const state = { section: sessionStorage.getItem('cbms_settings_section') || 'business' };
    let data = await window.api.get('/api/settings');

    view.innerHTML = `
      ${pageHead({ title: 'Settings', sub: 'Set these up once. Everything else uses them automatically.' })}
      <div class="settings-layout">
        <nav class="settings-nav">
          ${SECTIONS.map(([key, label]) =>
    `<button data-section="${key}" class="${state.section === key ? 'active' : ''}">${label}</button>`).join('')}
        </nav>
        <div class="settings-body" id="section"></div>
      </div>`;

    const save = async (values, message = 'Settings saved.') => {
      try {
        const saved = await window.api.put('/api/settings', values);
        data = { ...data, ...saved };
        window.api.state.business = saved.settings;
        window.dispatchEvent(new CustomEvent('cbms:settings-changed'));
        toast(message);
        return true;
      } catch (err) {
        errorToast(err);
        return false;
      }
    };

    const saveButton = () => `<div class="card-foot"><button class="btn primary" type="submit">Save Changes</button></div>`;

    const sections = {
      business: () => {
        const s = data.settings;
        return `
          <form class="card" id="form">
            <div class="card-head"><div><h2>Business Details</h2>
              <p>Printed at the top of every invoice.</p></div></div>
            <div class="pad" style="display:flex;flex-direction:column;gap:18px">
              <label>Shop name<input name="name" value="${esc(s.name)}"></label>
              <label>Address<textarea name="address" rows="2">${esc(s.address || '')}</textarea></label>
              <div class="form-grid">
                <label>Phone<input name="phone" value="${esc(s.phone || '')}"></label>
                <label>Email <span class="opt">(optional)</span><input name="email" value="${esc(s.email || '')}"></label>
                <label>GSTIN<input name="gstin" value="${esc(s.gstin || '')}" placeholder="36AXIPK2327D1ZR"></label>
                <label>State<input value="${esc(s.state_name || '')}" disabled placeholder="From the GSTIN"></label>
              </div>
              <div>
                <span class="section-label">Bank details</span>
                <div class="form-grid" style="margin-top:12px">
                  <label>Account name<input name="bank_account_name" value="${esc(s.bank_account_name || '')}"></label>
                  <label>A/c no<input name="bank_account_no" value="${esc(s.bank_account_no || '')}"></label>
                  <label>Branch &amp; IFSC<input name="bank_branch_ifsc" value="${esc(s.bank_branch_ifsc || '')}"></label>
                  <label>Other payment details<input name="bank_details" value="${esc(s.bank_details || '')}"></label>
                </div>
              </div>
            </div>
            ${saveButton()}
          </form>`;
      },

      invoice: () => {
        const s = data.settings;
        return `
          <form class="card" id="form">
            <div class="card-head"><div><h2>Invoice Settings</h2>
              <p>How your invoices are numbered and what they say.</p></div></div>
            <div class="pad" style="display:flex;flex-direction:column;gap:18px">
              <div class="form-grid">
                <label>Invoice number starts with<input name="invoice_prefix" value="${esc(s.invoice_prefix)}"></label>
                <label>Next invoice number
                  <input name="next_invoice_no" type="number" min="1" value="${data.nextNumbers.invoice}">
                  <div class="hint">The next invoice you issue takes this number.</div></label>
                <label>Purchase prefix<input name="purchase_prefix" value="${esc(s.purchase_prefix)}"></label>
                <label>Return prefix<input name="return_prefix" value="${esc(s.return_prefix)}"></label>
                <label>Adjustment prefix<input name="adjustment_prefix" value="${esc(s.adjustment_prefix)}"></label>
                <label>Default terms<input name="default_payment_terms" value="${esc(s.default_payment_terms || '')}"
                  placeholder="Due on Receipt"></label>
              </div>
              <label>Invoice number format
                <input name="invoice_no_format" value="${esc(s.invoice_no_format || '')}" placeholder="TCS/{MM}{YY}/{SEQ4}">
                <div class="hint">Tokens: {PREFIX} {SEQ} {SEQ3}–{SEQ6} {MM} {YY} {YYYY} {FY}.
                  "TCS/{MM}{YY}/{SEQ4}" gives TCS/0926/0053.</div></label>
              <div class="form-grid">
                <label>QR code on invoices<select name="qr_mode">
                  <option value="INVOICE_INFO" ${s.qr_mode === 'INVOICE_INFO' ? 'selected' : ''}>Invoice information</option>
                  <option value="PAYMENT_UPI" ${s.qr_mode === 'PAYMENT_UPI' ? 'selected' : ''}>UPI payment</option>
                  <option value="VERIFY_URL" ${s.qr_mode === 'VERIFY_URL' ? 'selected' : ''}>Verification link</option>
                </select></label>
                <label>UPI ID for the payment QR<input name="upi_id" value="${esc(s.upi_id || '')}" placeholder="business@upi"></label>
              </div>
              <label>Note at the bottom of invoices
                <textarea name="terms" rows="3">${esc(s.terms || '')}</textarea></label>
              <label>Declaration<textarea name="declaration" rows="2">${esc(s.declaration || '')}</textarea></label>
              <label>Authorised signatory<input name="signatory_name" value="${esc(s.signatory_name || '')}"></label>
              <label class="check"><input type="checkbox" name="print_serials" ${s.print_serials ? 'checked' : ''}>
                <span>Print serial numbers on invoices</span></label>
              <div class="hint">Official GST e-invoicing (IRN and the signed government QR) is a separate compliance
                integration and is not produced by these QR modes.</div>

              <div>
                <span class="section-label">Pricing &amp; stock rules</span>
                <label class="check" style="margin-top:12px"><input type="checkbox" name="price_includes_gst"
                  ${s.price_includes_gst ? 'checked' : ''}>
                  <span>Selling prices include GST
                    <span class="hint">On: ₹55,500 × 2 prints as ₹1,11,000 incl GST, ₹94,067.80 taxable and
                      ₹8,466.10 each of CGST and SGST. Off: GST is added on top.</span></span></label>
                <label class="check" style="margin-top:14px"><input type="checkbox" name="allow_negative_stock"
                  ${s.allow_negative_stock ? 'checked' : ''}>
                  <span>Allow selling more units than are in stock
                    <span class="hint">Off by default: an invoice that would take stock below zero is blocked.</span></span></label>
              </div>
            </div>
            ${saveButton()}
          </form>`;
      },

      tax: async () => {
        const { categories } = await window.api.get('/api/categories');
        return `
          <section class="card">
            <div class="card-head"><div><h2>Tax / GST</h2>
              <p>Default HSN and GST for each category. New products fill these in automatically.</p></div></div>
            <div class="pad" style="border-bottom:1px solid var(--rule)">
              <form id="gstin-form" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
                <label style="max-width:360px;flex:1 1 240px">Your GSTIN
                  <input name="gstin" value="${esc(data.settings.gstin || '')}"></label>
                <button class="btn" type="submit">Save GSTIN</button>
              </form>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Category</th><th>HSN code</th><th>GST</th><th>Products</th></tr></thead>
                <tbody>
                  ${categories.map((c) => `<tr>
                    <td style="font-weight:500">${esc(c.name)}</td>
                    <td><input style="width:150px" data-cat="${c.id}" data-field="hsn_code" value="${esc(c.hsn_code || '')}"></td>
                    <td><select style="width:110px" data-cat="${c.id}" data-field="gst_rate">
                      ${[5, 12, 18, 28].map((r) => `<option value="${r}" ${Number(c.gst_rate) === r ? 'selected' : ''}>${r}%</option>`).join('')}
                    </select></td>
                    <td class="num">${c.products}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
            <div class="card-foot">
              <a href="#/inventory/hsn">Manage HSN codes</a>
              <button class="btn primary" id="save-tax">Save Changes</button>
            </div>
          </section>`;
      },

      users: async () => {
        const { users, permissions } = await window.api.get('/api/users');
        return `
          <section class="card">
            <div class="card-head">
              <div><h2>Users &amp; Roles</h2><p>Who can sign in to the shop software.</p></div>
              <button class="btn primary" id="add-user">+ Add User</button>
            </div>
            ${users.map((u) => `
              <div class="row-link">
                <div class="rank">${esc(u.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</div>
                <div class="grow">
                  <div style="font-weight:600">${esc(u.name)}</div>
                  <div class="small muted">${esc(u.email)} · ${u.last_login_at ? `Last signed in ${dateTime(u.last_login_at)}` : 'Never signed in'}</div>
                </div>
                <span class="tag ${u.role === 'ADMIN' ? 'blue' : ''}">${u.role === 'ADMIN' ? 'Owner · Admin' : 'Sales Staff'}</span>
                ${u.active ? '' : '<span class="tag red">Disabled</span>'}
                <button class="link-btn" data-user="${u.id}">Edit</button>
              </div>`).join('')}
          </section>

          <section class="card">
            <div class="card-head"><div><h2>What sales staff can do</h2>
              <p>The owner can always do everything. Changes save immediately.</p></div></div>
            ${permissions.map((p) => `
              <label class="row-link" style="cursor:pointer">
                <div class="grow">
                  <div style="font-weight:500">${esc(p.label)}</div>
                  <div class="small muted">${esc(p.description)}</div>
                </div>
                <span style="font-weight:600;min-width:56px;text-align:right" data-state="${p.key}">${p.allowed ? 'Allowed' : 'Off'}</span>
                <input type="checkbox" data-permission="${p.key}" ${p.allowed ? 'checked' : ''}>
              </label>`).join('')}
          </section>`;
      },

      backup: () => `
        <section class="card">
          <div class="card-head"><div><h2>Backup</h2>
            <p>A copy of all your data, to keep somewhere safe in case the computer fails.</p></div></div>
          <div class="pad" style="display:flex;flex-direction:column;gap:18px">
            <div class="alert success" style="margin:0"><span class="glyph">✓</span>
              <div>Your data lives in one file on this computer. Downloading a backup copies everything —
                products, invoices, purchases and the stock ledger — as it stands right now.</div></div>
            <div class="hint">Automatic nightly backups to cloud storage are not part of this system yet;
              download a copy at the end of the day and keep it somewhere else.</div>
          </div>
          <div class="card-foot"><button class="btn primary" id="backup-now">Download Backup</button></div>
        </section>`,

      prefs: () => {
        const s = data.settings;
        return `
          <form class="card" id="form">
            <div class="card-head"><h2>Preferences</h2></div>
            <div class="pad" style="display:flex;flex-direction:column;gap:18px">
              <div>
                <div style="font-weight:500;margin-bottom:8px">Text size</div>
                <div class="segmented" id="text-size">
                  ${[['normal', 'Normal'], ['large', 'Large'], ['xl', 'Extra large']].map(([k, l]) =>
    `<button type="button" data-size="${k}" class="${(s.text_size || 'normal') === k ? 'active' : ''}">${l}</button>`).join('')}
                </div>
                <div class="hint">Larger text is easier to read from across the counter.</div>
                <input type="hidden" name="text_size" value="${esc(s.text_size || 'normal')}">
              </div>
              <label style="max-width:320px">Low stock alerts
                <select name="low_stock_alerts">
                  <option value="NOTIFY" ${s.low_stock_alerts === 'NOTIFY' ? 'selected' : ''}>Show in notifications</option>
                  <option value="OFF" ${s.low_stock_alerts === 'OFF' ? 'selected' : ''}>Off</option>
                </select></label>
            </div>
            ${saveButton()}
          </form>`;
      },
    };

    const host = view.querySelector('#section');

    const renderSection = async () => {
      sessionStorage.setItem('cbms_settings_section', state.section);
      host.innerHTML = skeleton(4);
      host.innerHTML = await sections[state.section]();

      const form = host.querySelector('#form');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          await save(formValues(form));
          if (state.section === 'invoice' || state.section === 'prefs') renderSection();
        });
      }

      if (state.section === 'prefs') {
        host.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
          host.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('active', x === b));
          host.querySelector('[name=text_size]').value = b.dataset.size;
          document.documentElement.dataset.textSize = b.dataset.size;
        }));
      }

      if (state.section === 'tax') {
        host.querySelector('#gstin-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await save(formValues(e.target), 'GSTIN saved.');
        });
        host.querySelector('#save-tax').addEventListener('click', async () => {
          const rows = {};
          host.querySelectorAll('[data-cat]').forEach((input) => {
            rows[input.dataset.cat] = rows[input.dataset.cat] || { id: Number(input.dataset.cat) };
            rows[input.dataset.cat][input.dataset.field] = input.value;
          });
          try {
            await window.api.put('/api/categories', { categories: Object.values(rows) });
            toast('Category tax defaults saved.');
          } catch (err) { errorToast(err); }
        });
      }

      if (state.section === 'users') {
        host.querySelectorAll('[data-permission]').forEach((box) => box.addEventListener('change', async () => {
          const key = box.dataset.permission;
          const ok = await save({ staff_permissions: { [key]: box.checked } },
            `Sales staff: ${box.checked ? 'allowed' : 'no longer allowed'}.`);
          if (!ok) { box.checked = !box.checked; return; }
          host.querySelector(`[data-state="${key}"]`).textContent = box.checked ? 'Allowed' : 'Off';
        }));

        host.querySelectorAll('[data-user]').forEach((btn) => btn.addEventListener('click', async () => {
          const { users } = await window.api.get('/api/users');
          const user = users.find((u) => String(u.id) === btn.dataset.user);
          const saved = await modal({
            title: `Edit ${user.name}`,
            confirmLabel: 'Save',
            deleteLabel: window.api.state.user.id !== user.id ? 'Delete user' : undefined,
            body: `
              <label>Name<input name="name" value="${esc(user.name)}"></label>
              <label>Phone <span class="opt">(optional)</span><input name="phone" value="${esc(user.phone || '')}"></label>
              <label>Role<select name="role">
                <option value="ADMIN" ${user.role === 'ADMIN' ? 'selected' : ''}>Owner / Admin</option>
                <option value="STAFF" ${user.role === 'STAFF' ? 'selected' : ''}>Sales Staff</option>
              </select></label>
              <label>New password <span class="opt">(leave blank to keep the current one)</span>
                <input name="password" type="password" autocomplete="new-password"></label>
              <label class="check"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}>
                <span>Can sign in</span></label>`,
            onConfirm: (root) => window.api.put(`/api/users/${user.id}`, formValues(root)),
            onDelete: async () => {
              if (!await window.ui.confirm(`Delete ${user.name}?`, `Are you sure you want to completely remove ${user.name}?`)) return undefined;
              await window.api.del(`/api/users/${user.id}`);
              return true;
            },
          });
          if (saved) { toast('User updated.'); renderSection(); }
        }));

        host.querySelector('#add-user').addEventListener('click', async () => {
          const created = await modal({
            title: 'Add User',
            confirmLabel: 'Create User',
            body: `
              <label>Name <span class="req">*</span><input name="name"></label>
              <label>Email <span class="req">*</span><input name="email" type="email"></label>
              <label>Phone <span class="opt">(optional)</span><input name="phone"></label>
              <label>Password <span class="req">*</span>
                <input name="password" type="password" placeholder="At least 6 characters"></label>
              <label>Role<select name="role">
                <option value="STAFF">Sales Staff</option><option value="ADMIN">Owner / Admin</option></select></label>`,
            onConfirm: (root) => window.api.post('/api/users', formValues(root)),
          });
          if (created) { toast('User created.'); renderSection(); }
        });
      }

      if (state.section === 'backup') {
        host.querySelector('#backup-now').addEventListener('click', async () => {
          try {
            const stamp = new Date().toISOString().slice(0, 10);
            await window.api.download('/api/settings/backup', {}, `backup-${stamp}.db`);
            toast('Backup downloaded. Keep it somewhere safe.');
          } catch (err) { errorToast(err); }
        });
      }
    };

    view.querySelectorAll('[data-section]').forEach((b) => b.addEventListener('click', () => {
      state.section = b.dataset.section;
      view.querySelectorAll('[data-section]').forEach((x) => x.classList.toggle('active', x === b));
      renderSection();
    }));
    await renderSection();
  }

  window.Pages = window.Pages || {};
  window.Pages.settings = { render };
})();
