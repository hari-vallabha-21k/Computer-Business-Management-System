'use strict';
/**
 * Categories carry the default HSN code and GST rate for the products in them,
 * so "enter it once" starts one level above the product: choose Laptops and the
 * tax fields fill themselves in.
 */
const express = require('express');
const { db } = require('../db');
const { AppError, wrap, num, str, required } = require('../lib/util');
const { requireRole } = require('../lib/auth');

const router = express.Router();

const SELECT = `
  SELECT c.id, c.name, c.gst_rate, h.code AS hsn_code, h.description AS hsn_description,
    (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
  FROM categories c
  LEFT JOIN hsn_codes h ON h.id = c.hsn_id`;

const all = () => db.prepare(`${SELECT} ORDER BY c.name`).all();
const one = (id) => db.prepare(`${SELECT} WHERE c.id = ?`).get(id);

/** Find or create the HSN row for a code, keeping its rate in step. */
function resolveHsn(code, gstRate) {
  const clean = str(code).replace(/\s+/g, '');
  if (!clean) return null;
  const existing = db.prepare('SELECT * FROM hsn_codes WHERE code = ?').get(clean);
  if (existing) return existing;
  const id = db.prepare('INSERT INTO hsn_codes (code, description, gst_rate) VALUES (?, ?, ?)')
    .run(clean, '', num(gstRate, 18)).lastInsertRowid;
  return db.prepare('SELECT * FROM hsn_codes WHERE id = ?').get(id);
}

router.get('/', wrap((req, res) => res.json({ categories: all() })));

router.post('/', requireRole('ADMIN'), wrap((req, res) => {
  required(req.body, ['name']);
  const name = str(req.body.name);
  if (db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?)').get(name)) {
    throw new AppError(`There is already a category called "${name}".`, 409);
  }
  const hsn = resolveHsn(req.body.hsn_code, req.body.gst_rate);
  const id = db.prepare('INSERT INTO categories (name, hsn_id, gst_rate) VALUES (?, ?, ?)')
    .run(name, hsn ? hsn.id : null, num(req.body.gst_rate, hsn ? hsn.gst_rate : 18)).lastInsertRowid;
  res.status(201).json({ category: one(id) });
}));

router.put('/:id', requireRole('ADMIN'), wrap((req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!current) throw new AppError('Category not found.', 404);
  const hsn = req.body.hsn_code === undefined ? null : resolveHsn(req.body.hsn_code, req.body.gst_rate);
  db.prepare('UPDATE categories SET name = ?, hsn_id = ?, gst_rate = ? WHERE id = ?').run(
    str(req.body.name, current.name) || current.name,
    req.body.hsn_code === undefined ? current.hsn_id : (hsn ? hsn.id : null),
    num(req.body.gst_rate, current.gst_rate),
    id,
  );
  res.json({ categories: all() });
}));

/** Bulk save, which is how the Settings → Tax / GST table saves its rows. */
router.put('/', requireRole('ADMIN'), wrap((req, res) => {
  const rows = Array.isArray(req.body.categories) ? req.body.categories : [];
  for (const row of rows) {
    const current = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(row.id));
    if (!current) continue;
    const hsn = resolveHsn(row.hsn_code, row.gst_rate);
    db.prepare('UPDATE categories SET hsn_id = ?, gst_rate = ? WHERE id = ?')
      .run(hsn ? hsn.id : current.hsn_id, num(row.gst_rate, current.gst_rate), current.id);
  }
  res.json({ categories: all() });
}));

module.exports = router;
