'use strict';
const express = require('express');
const { db } = require('../db');
const { AppError, wrap, num, str, required } = require('../lib/util');
const { requireRole } = require('../lib/auth');

const router = express.Router();

router.get('/', wrap((req, res) => {
  const q = str(req.query.q);
  const rows = q
    ? db.prepare('SELECT * FROM hsn_codes WHERE code LIKE ? OR description LIKE ? ORDER BY code LIMIT 100')
      .all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM hsn_codes ORDER BY code').all();
  const withUsage = rows.map((r) => ({
    ...r,
    products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE hsn_id = ?').get(r.id).n,
  }));
  res.json({ hsn: withUsage });
}));

router.post('/', requireRole('ADMIN'), wrap((req, res) => {
  required(req.body, ['code']);
  const code = str(req.body.code).replace(/\s+/g, '');
  if (db.prepare('SELECT id FROM hsn_codes WHERE code = ?').get(code)) {
    throw new AppError(`HSN ${code} already exists.`, 409);
  }
  const id = db.prepare('INSERT INTO hsn_codes (code, description, gst_rate) VALUES (?, ?, ?)')
    .run(code, str(req.body.description), num(req.body.gst_rate, 18)).lastInsertRowid;
  res.status(201).json({ hsn: db.prepare('SELECT * FROM hsn_codes WHERE id = ?').get(id) });
}));

router.put('/:id', requireRole('ADMIN'), wrap((req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM hsn_codes WHERE id = ?').get(id);
  if (!current) throw new AppError('HSN code not found.', 404);
  db.prepare('UPDATE hsn_codes SET code = ?, description = ?, gst_rate = ? WHERE id = ?')
    .run(str(req.body.code, current.code).replace(/\s+/g, '') || current.code,
      str(req.body.description, current.description), num(req.body.gst_rate, current.gst_rate), id);
  if (req.body.apply_gst_to_products) {
    db.prepare('UPDATE products SET gst_rate = ? WHERE hsn_id = ?').run(num(req.body.gst_rate, current.gst_rate), id);
  }
  res.json({ hsn: db.prepare('SELECT * FROM hsn_codes WHERE id = ?').get(id) });
}));

router.delete('/:id', requireRole('ADMIN'), wrap((req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM products WHERE hsn_id = ?').get(id).n;
  if (used) throw new AppError(`This HSN is used by ${used} product(s) and cannot be deleted.`, 409);
  db.prepare('DELETE FROM hsn_codes WHERE id = ?').run(id);
  res.json({ ok: true });
}));

module.exports = router;
