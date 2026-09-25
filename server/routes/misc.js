'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { db, settings, DATA_DIR } = require('../db');
const { AppError, wrap, num, str, required } = require('../lib/util');
const { login, createUser, requireRole, hashPassword } = require('../lib/auth');
const permissions = require('../lib/permissions');
const { stateName } = require('../lib/states');

const auth = express.Router();

auth.post('/login', wrap((req, res) => {
  required(req.body, ['email', 'password']);
  const { user, token } = login(req.body.email, req.body.password);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString().slice(0, 19).replace('T', ' '), user.id);
  res.set('Set-Cookie', `cbms_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`);
  res.json({ user, token });
}));

auth.post('/logout', wrap((req, res) => {
  res.set('Set-Cookie', 'cbms_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}));

auth.get('/me', wrap((req, res) => {
  if (!req.user) throw new AppError('Not signed in.', 401);
  res.json({ user: req.user, business: settings(), permissions: permissions.staffPermissions() });
}));

const users = express.Router();

users.get('/', requireRole('ADMIN'), wrap((req, res) => {
  res.json({
    users: db.prepare('SELECT id, name, email, phone, role, active, created_at, last_login_at FROM users ORDER BY name').all(),
    permissions: permissions.describe(),
  });
}));

users.post('/', requireRole('ADMIN'), wrap((req, res) => {
  required(req.body, ['name', 'email', 'password']);
  const role = str(req.body.role, 'STAFF').toUpperCase();
  if (!['ADMIN', 'STAFF'].includes(role)) throw new AppError('Role must be ADMIN or STAFF.', 422);
  if (String(req.body.password).length < 6) throw new AppError('Password must be at least 6 characters.', 422);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(String(req.body.email).toLowerCase())) {
    throw new AppError('A user with that email already exists.', 409);
  }
  const user = createUser({ ...req.body, role });
  if (req.body.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(str(req.body.phone, ''), user.id);
  res.status(201).json({ user: { ...user, phone: str(req.body.phone, '') } });
}));

users.put('/:id', requireRole('ADMIN'), wrap((req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new AppError('User not found.', 404);
  const role = str(req.body.role, user.role).toUpperCase();
  const active = req.body.active === undefined ? user.active : (req.body.active ? 1 : 0);
  if (user.role === 'ADMIN' && (role !== 'ADMIN' || !active)) {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND active = 1").get().n;
    if (admins <= 1) throw new AppError('The last active admin cannot be demoted or disabled.', 409);
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE id = ?')
    .run(str(req.body.name, user.name) || user.name, str(req.body.phone, user.phone), role, active, id);
  if (req.body.password) {
    if (String(req.body.password).length < 6) throw new AppError('Password must be at least 6 characters.', 422);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
  }
  res.json({ user: db.prepare('SELECT id, name, email, phone, role, active FROM users WHERE id = ?').get(id) });
}));

const settingsRouter = express.Router();

/** What each series would issue next, so Settings can show and set it. */
function nextNumbers() {
  const current = settings();
  const value = (prefix) => {
    const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(prefix);
    return row ? row.value + 1 : 1001;
  };
  return {
    invoice: value(current.invoice_prefix),
    purchase: value(current.purchase_prefix),
    return: value(current.return_prefix),
  };
}

settingsRouter.get('/', wrap((req, res) => res.json({
  settings: settings(),
  permissions: permissions.describe(),
  nextNumbers: nextNumbers(),
})));

/** A download of the whole SQLite database, for the owner to keep somewhere safe. */
settingsRouter.get('/backup', requireRole('ADMIN'), wrap((req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(DATA_DIR, `backup-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  res.download(file, `cbms-backup-${stamp}.db`, () => fs.unlink(file, () => {}));
}));

settingsRouter.put('/', requireRole('ADMIN'), wrap((req, res) => {
  const current = settings();
  const b = req.body;
  const gstin = str(b.gstin, current.gstin).toUpperCase();
  const stateCode = gstin.slice(0, 2) || str(b.state_code, current.state_code);
  db.prepare(`
    UPDATE business_settings SET name = ?, address = ?, phone = ?, email = ?, gstin = ?, state_code = ?,
      state_name = ?, invoice_prefix = ?, purchase_prefix = ?, return_prefix = ?, adjustment_prefix = ?,
      allow_negative_stock = ?, qr_mode = ?, upi_id = ?, bank_details = ?, terms = ?, currency = ?,
      price_includes_gst = ?, bank_account_name = ?, bank_account_no = ?, bank_branch_ifsc = ?,
      declaration = ?, signatory_name = ?, invoice_no_format = ?, default_payment_terms = ?,
      print_serials = ?, low_stock_alerts = ?, text_size = ?
    WHERE id = 1`)
    .run(str(b.name, current.name) || current.name, str(b.address, current.address), str(b.phone, current.phone),
      str(b.email, current.email), gstin, stateCode, stateName(stateCode) || str(b.state_name, current.state_name),
      str(b.invoice_prefix, current.invoice_prefix) || current.invoice_prefix,
      str(b.purchase_prefix, current.purchase_prefix) || current.purchase_prefix,
      str(b.return_prefix, current.return_prefix) || current.return_prefix,
      str(b.adjustment_prefix, current.adjustment_prefix) || current.adjustment_prefix,
      b.allow_negative_stock === undefined ? current.allow_negative_stock : (b.allow_negative_stock ? 1 : 0),
      str(b.qr_mode, current.qr_mode).toUpperCase(), str(b.upi_id, current.upi_id),
      str(b.bank_details, current.bank_details), str(b.terms, current.terms),
      str(b.currency, current.currency) || current.currency,
      b.price_includes_gst === undefined ? current.price_includes_gst : (b.price_includes_gst ? 1 : 0),
      str(b.bank_account_name, current.bank_account_name), str(b.bank_account_no, current.bank_account_no),
      str(b.bank_branch_ifsc, current.bank_branch_ifsc), str(b.declaration, current.declaration),
      str(b.signatory_name, current.signatory_name),
      str(b.invoice_no_format, current.invoice_no_format) || current.invoice_no_format,
      str(b.default_payment_terms, current.default_payment_terms),
      b.print_serials === undefined ? current.print_serials : (b.print_serials ? 1 : 0),
      str(b.low_stock_alerts, current.low_stock_alerts).toUpperCase() || current.low_stock_alerts,
      str(b.text_size, current.text_size) || current.text_size);
  if (b.next_invoice_no !== undefined && String(b.next_invoice_no).trim() !== '') {
    const next = Math.floor(Number(b.next_invoice_no));
    if (!Number.isFinite(next) || next < 1) throw new AppError('The next invoice number must be a whole number.', 422);
    db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
      .run(str(b.invoice_prefix, current.invoice_prefix) || current.invoice_prefix, next - 1);
  }
  if (b.staff_permissions) permissions.savePermissions(b.staff_permissions);
  res.json({ settings: settings(), permissions: permissions.staffPermissions(), nextNumbers: nextNumbers() });
}));

const notifications = express.Router();

notifications.get('/', wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.unread === 'true') where.push('is_read = 0');
  if (req.query.type) { where.push('type = ?'); params.push(String(req.query.type).toUpperCase()); }
  const rows = db.prepare(`SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`).all(...params, num(req.query.limit, 50));
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0').get().n;
  res.json({ notifications: rows, unread });
}));

notifications.post('/read', wrap((req, res) => {
  if (Array.isArray(req.body.ids) && req.body.ids.length) {
    const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?');
    for (const id of req.body.ids) stmt.run(Number(id));
  } else {
    db.prepare('UPDATE notifications SET is_read = 1').run();
  }
  res.json({ ok: true });
}));

notifications.delete('/', requireRole('ADMIN'), wrap((req, res) => {
  db.prepare('DELETE FROM notifications WHERE is_read = 1').run();
  res.json({ ok: true });
}));

module.exports = { auth, users, settingsRouter, notifications };
