'use strict';
const express = require('express');
const { db, settings } = require('../db');
const { AppError, wrap, num, str, required } = require('../lib/util');
const { login, createUser, requireRole } = require('../lib/auth');

const auth = express.Router();

auth.post('/login', wrap((req, res) => {
  required(req.body, ['email', 'password']);
  const { user, token } = login(req.body.email, req.body.password);
  res.set('Set-Cookie', `cbms_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`);
  res.json({ user, token });
}));

auth.post('/logout', wrap((req, res) => {
  res.set('Set-Cookie', 'cbms_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}));

auth.get('/me', wrap((req, res) => {
  if (!req.user) throw new AppError('Not signed in.', 401);
  res.json({ user: req.user, business: settings() });
}));

const users = express.Router();

users.get('/', requireRole('ADMIN'), wrap((req, res) => {
  res.json({ users: db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all() });
}));

users.post('/', requireRole('ADMIN'), wrap((req, res) => {
  required(req.body, ['name', 'email', 'password']);
  const role = str(req.body.role, 'STAFF').toUpperCase();
  if (!['ADMIN', 'STAFF'].includes(role)) throw new AppError('Role must be ADMIN or STAFF.', 422);
  if (String(req.body.password).length < 6) throw new AppError('Password must be at least 6 characters.', 422);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(String(req.body.email).toLowerCase())) {
    throw new AppError('A user with that email already exists.', 409);
  }
  res.status(201).json({ user: createUser({ ...req.body, role }) });
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
  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?')
    .run(str(req.body.name, user.name) || user.name, role, active, id);
  res.json({ user: db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?').get(id) });
}));

const settingsRouter = express.Router();

settingsRouter.get('/', wrap((req, res) => res.json({ settings: settings() })));

settingsRouter.put('/', requireRole('ADMIN'), wrap((req, res) => {
  const current = settings();
  const b = req.body;
  const gstin = str(b.gstin, current.gstin).toUpperCase();
  db.prepare(`
    UPDATE business_settings SET name = ?, address = ?, phone = ?, email = ?, gstin = ?, state_code = ?,
      invoice_prefix = ?, purchase_prefix = ?, return_prefix = ?, adjustment_prefix = ?,
      allow_negative_stock = ?, qr_mode = ?, upi_id = ?, bank_details = ?, terms = ?, currency = ?
    WHERE id = 1`)
    .run(str(b.name, current.name) || current.name, str(b.address, current.address), str(b.phone, current.phone),
      str(b.email, current.email), gstin, gstin.slice(0, 2) || str(b.state_code, current.state_code),
      str(b.invoice_prefix, current.invoice_prefix) || current.invoice_prefix,
      str(b.purchase_prefix, current.purchase_prefix) || current.purchase_prefix,
      str(b.return_prefix, current.return_prefix) || current.return_prefix,
      str(b.adjustment_prefix, current.adjustment_prefix) || current.adjustment_prefix,
      b.allow_negative_stock === undefined ? current.allow_negative_stock : (b.allow_negative_stock ? 1 : 0),
      str(b.qr_mode, current.qr_mode).toUpperCase(), str(b.upi_id, current.upi_id),
      str(b.bank_details, current.bank_details), str(b.terms, current.terms),
      str(b.currency, current.currency) || current.currency);
  res.json({ settings: settings() });
}));

const notifications = express.Router();

notifications.get('/', wrap((req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications ${req.query.unread === 'true' ? 'WHERE is_read = 0' : ''}
    ORDER BY id DESC LIMIT ?`).all(num(req.query.limit, 50));
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
