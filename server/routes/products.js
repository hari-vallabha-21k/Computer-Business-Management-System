'use strict';
const express = require('express');
const { db, tx } = require('../db');
const { AppError, wrap, num, str, required, similarity, round2 } = require('../lib/util');
const inventory = require('../lib/inventory');
const { requireRole } = require('../lib/auth');
const { can, hideCosts } = require('../lib/permissions');

const router = express.Router();

const SELECT = `
  SELECT p.*, c.name AS category, h.code AS hsn_code, h.description AS hsn_description
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN hsn_codes h ON h.id = p.hsn_id`;

/**
 * Tax defaults for a category, so a new product only needs its category
 * chosen: the HSN code and GST rate come with it.
 */
function categoryDefaults(categoryId) {
  if (!categoryId) return null;
  const row = db.prepare(`SELECT c.gst_rate, c.hsn_id, h.code AS hsn_code
    FROM categories c LEFT JOIN hsn_codes h ON h.id = c.hsn_id WHERE c.id = ?`).get(categoryId);
  return row && row.hsn_id ? row : null;
}

function generateCode(categoryName) {
  const base = (categoryName || 'PRD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
  const row = db.prepare("SELECT COUNT(*) AS n FROM products WHERE product_code LIKE ?").get(`${base}-%`);
  let n = row.n + 1;
  // Skip codes already taken (products may have been deleted).
  while (db.prepare('SELECT id FROM products WHERE product_code = ?').get(`${base}-${String(n).padStart(3, '0')}`)) n += 1;
  return `${base}-${String(n).padStart(3, '0')}`;
}

/** 'SERVICE' or 'PRODUCT' from a request value; anything else is a product. */
const itemType = (value) => (String(value || '').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'PRODUCT');

function resolveCategory(nameOrId) {
  if (!nameOrId) return null;
  if (/^\d+$/.test(String(nameOrId))) {
    const row = db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(nameOrId));
    if (row) return row.id;
  }
  const name = str(nameOrId);
  const existing = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?)').get(name);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid);
}

/** Resolve an HSN code string to a row, creating it when new. Returns null for blank input. */
function resolveHsn(code, gstRate) {
  const clean = str(code).replace(/\s+/g, '');
  if (!clean) return null;
  const existing = db.prepare('SELECT * FROM hsn_codes WHERE code = ?').get(clean);
  if (existing) return existing;
  const id = db.prepare('INSERT INTO hsn_codes (code, description, gst_rate) VALUES (?, ?, ?)')
    .run(clean, '', num(gstRate, 18)).lastInsertRowid;
  return db.prepare('SELECT * FROM hsn_codes WHERE id = ?').get(id);
}

// GET /api/products - search + filters
router.get('/', wrap((req, res) => {
  const q = str(req.query.q);
  const where = ['p.active = 1'];
  const params = [];
  if (req.query.includeInactive === 'true') where.length = 0;
  // Stock screens list goods only; services are asked for by name ('SERVICE', or 'ALL' for both).
  const type = str(req.query.type).toUpperCase();
  if (type !== 'ALL') { where.push('p.item_type = ?'); params.push(type === 'SERVICE' ? 'SERVICE' : 'PRODUCT'); }
  if (q) {
    where.push(`(p.name LIKE ? OR p.brand LIKE ? OR p.model LIKE ? OR p.product_code LIKE ? OR p.barcode LIKE ?
      OR h.code LIKE ? OR EXISTS (SELECT 1 FROM serial_numbers s WHERE s.product_id = p.id AND s.serial LIKE ?))`);
    for (let i = 0; i < 7; i += 1) params.push(`%${q}%`);
  }
  if (req.query.category) { where.push('c.name = ?'); params.push(str(req.query.category)); }
  if (req.query.brand) { where.push('p.brand = ?'); params.push(str(req.query.brand)); }
  if (req.query.lowStock === 'true') where.push('p.min_stock > 0 AND p.stock <= p.min_stock');
  if (req.query.outOfStock === 'true') where.push('p.stock <= 0');

  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name LIMIT ?`;
  params.push(num(req.query.limit, 200));
  res.json({ products: hideCosts(req.user, db.prepare(sql).all(...params)) });
}));

// GET /api/products/filters - distinct values for dashboard/report filters
router.get('/filters', wrap((req, res) => {
  res.json({
    categories: db.prepare('SELECT id, name FROM categories ORDER BY name').all(),
    brands: db.prepare("SELECT DISTINCT brand FROM products WHERE brand <> '' AND item_type = 'PRODUCT' ORDER BY brand").all().map((r) => r.brand),
  });
}));

// POST /api/products/match - fuzzy match extracted text against the product master
router.post('/match', wrap((req, res) => {
  const text = str(req.body.text);
  if (!text) throw new AppError('Text to match is required.', 422);
  const products = db.prepare(`${SELECT} WHERE p.item_type = 'PRODUCT'`).all();
  const scored = products
    .map((p) => ({ product: p, score: similarity(text, `${p.name} ${p.brand} ${p.model}`) }))
    .filter((m) => m.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  res.json({ matches: scored.map((m) => ({ ...m, product: hideCosts(req.user, m.product) })) });
}));

/**
 * Everything the product page shows: the record, its ledger, and the three
 * histories behind its tabs (sales, purchases, serial numbers).
 */
router.get('/:id', wrap((req, res) => {
  const product = db.prepare(`${SELECT} WHERE p.id = ?`).get(Number(req.params.id));
  if (!product) throw new AppError('Product not found.', 404);
  const movements = db.prepare(
    'SELECT * FROM inventory_transactions WHERE product_id = ? ORDER BY id DESC LIMIT 100',
  ).all(product.id);
  const serials = db.prepare(`
    SELECT s.*, i.invoice_no, pu.purchase_no, pu.invoice_date AS purchased_on
    FROM serial_numbers s
    LEFT JOIN invoices i ON i.id = s.invoice_id
    LEFT JOIN purchases pu ON pu.id = s.purchase_id
    WHERE s.product_id = ? ORDER BY s.status, s.serial`).all(product.id);

  const sales = db.prepare(`
    SELECT i.id AS invoice_id, i.invoice_no, i.invoice_date, i.status, c.name AS customer_name,
      it.qty, it.total
    FROM invoice_items it
    JOIN invoices i ON i.id = it.invoice_id
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE it.product_id = ? AND i.status != 'DRAFT'
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT 50`).all(product.id);

  const purchases = db.prepare(`
    SELECT pu.id AS purchase_id, pu.purchase_no, pu.invoice_date, s.name AS supplier_name,
      pi.qty, pi.unit_price, pi.total
    FROM purchase_items pi
    JOIN purchases pu ON pu.id = pi.purchase_id
    LEFT JOIN suppliers s ON s.id = pu.supplier_id
    WHERE pi.product_id = ?
    ORDER BY pu.invoice_date DESC, pu.id DESC LIMIT 50`).all(product.id);

  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
  const soldThisMonth = db.prepare(`
    SELECT COALESCE(SUM(it.qty - it.returned_qty), 0) AS n
    FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
    WHERE it.product_id = ? AND i.status = 'ISSUED' AND i.invoice_date >= ?`).get(product.id, monthStart).n;

  const stats = {
    stockValue: round2(product.stock * product.purchase_price),
    soldThisMonth,
    soldTotal: sales.reduce((sum, r) => sum + (r.status === 'ISSUED' ? r.qty : 0), 0),
    lastPurchasePrice: purchases.length ? purchases[0].unit_price : null,
    lastSupplier: purchases.length ? purchases[0].supplier_name : null,
    serialsAvailable: serials.filter((s2) => s2.status === 'AVAILABLE').length,
  };
  res.json({
    product: hideCosts(req.user, product),
    movements: hideCosts(req.user, movements),
    serials,
    sales,
    // The purchase history is nothing but supplier prices.
    purchases: can(req.user, 'costs') ? purchases : [],
    stats: hideCosts(req.user, stats),
    ledgerStock: inventory.ledgerStock(product.id),
  });
}));

router.post('/', requireRole('ADMIN'), wrap((req, res) => {
  const b = req.body;
  required(b, ['name']);
  const categoryId = resolveCategory(b.category);
  const fallback = categoryDefaults(categoryId);
  const hsn = resolveHsn(b.hsn_code || (fallback && fallback.hsn_code), b.gst_rate ?? (fallback && fallback.gst_rate));
  const type = itemType(b.item_type);
  const service = type === 'SERVICE';
  const code = str(b.product_code) || generateCode(service ? 'SRV' : str(b.category));
  if (db.prepare('SELECT id FROM products WHERE product_code = ?').get(code)) {
    throw new AppError(`Product ID ${code} is already in use.`, 409);
  }
  const duplicate = db.prepare('SELECT id, name FROM products WHERE lower(name) = lower(?) AND active = 1').get(str(b.name));
  if (duplicate && b.force !== true) {
    throw new AppError(`A product named "${b.name}" already exists. Use it, or resend with force to create a duplicate.`, 409, { existingId: duplicate.id });
  }

  // A service has no shelf: no opening stock, reorder level or serial numbers.
  const openingStock = service ? 0 : num(b.opening_stock, 0);
  const product = tx(() => {
    const id = Number(db.prepare(`
      INSERT INTO products (product_code, name, category_id, brand, model, hsn_id, gst_rate, purchase_price,
        selling_price, min_stock, serial_tracked, barcode, description, location, stock, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(code, str(b.name), categoryId, str(b.brand), str(b.model), hsn ? hsn.id : null,
        num(b.gst_rate, hsn ? hsn.gst_rate : (fallback ? fallback.gst_rate : 18)), num(b.purchase_price),
        num(b.selling_price), service ? 0 : num(b.min_stock), !service && b.serial_tracked ? 1 : 0, str(b.barcode),
        str(b.description), service ? '' : str(b.location), type).lastInsertRowid);

    if (openingStock > 0) {
      if (b.serial_tracked && Array.isArray(b.serials) && b.serials.length) {
        inventory.addSerials(id, b.serials);
      }
      inventory.move({
        productId: id, type: 'OPENING', qty: openingStock, unitCost: num(b.purchase_price),
        referenceType: 'OPENING', referenceNo: 'OPENING', note: 'Opening stock', userId: req.user.id,
      });
    }
    return db.prepare(`${SELECT} WHERE p.id = ?`).get(id);
  });
  res.status(201).json({ product });
}));

/**
 * POST /api/products/bulk - create several products in one confirmed step,
 * used by the "create products from scanned invoices" flow. Rows that match an
 * existing product by name or barcode are skipped rather than duplicated
 * (Rule 5), and the whole batch is one transaction.
 */
router.post('/bulk', requireRole('ADMIN'), wrap((req, res) => {
  const rows = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rows.length) throw new AppError('No products to create.', 422);

  const out = tx(() => {
    const created = [];
    const skipped = [];
    for (const row of rows) {
      const name = str(row.name);
      if (!name) { skipped.push({ name: '', reason: 'NO_NAME' }); continue; }
      const existing = db.prepare('SELECT id, name FROM products WHERE lower(name) = lower(?) AND active = 1').get(name);
      if (existing) { skipped.push({ name, reason: 'ALREADY_EXISTS', productId: existing.id }); continue; }

      const categoryId = row.category ? resolveCategory(row.category) : null;
      const fallback = categoryDefaults(categoryId);
      const hsn = resolveHsn(row.hsn_code || (fallback && fallback.hsn_code), row.gst_rate ?? (fallback && fallback.gst_rate));
      const code = str(row.product_code) || generateCode(str(row.category));
      const id = Number(db.prepare(`
        INSERT INTO products (product_code, name, category_id, brand, model, hsn_id, gst_rate, purchase_price,
          selling_price, min_stock, serial_tracked, barcode, description, location, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(code, name, categoryId, str(row.brand), str(row.model), hsn ? hsn.id : null,
          num(row.gst_rate, hsn ? hsn.gst_rate : (fallback ? fallback.gst_rate : 18)), num(row.purchase_price),
          num(row.selling_price), num(row.min_stock), row.serial_tracked ? 1 : 0, str(row.barcode),
          str(row.description), str(row.location)).lastInsertRowid);
      created.push(db.prepare(`${SELECT} WHERE p.id = ?`).get(id));
    }
    return { created, skipped };
  });
  res.status(201).json({ ...out, createdCount: out.created.length, skippedCount: out.skipped.length });
}));

router.put('/:id', requireRole('ADMIN'), wrap((req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) throw new AppError('Product not found.', 404);
  const b = req.body;
  const categoryId = b.category !== undefined ? resolveCategory(b.category) : current.category_id;
  const hsn = b.hsn_code !== undefined ? resolveHsn(b.hsn_code, b.gst_rate) : null;
  const service = current.item_type === 'SERVICE';
  db.prepare(`
    UPDATE products SET name = ?, category_id = ?, brand = ?, model = ?, hsn_id = ?, gst_rate = ?,
      purchase_price = ?, selling_price = ?, min_stock = ?, serial_tracked = ?, barcode = ?, description = ?,
      location = ?, active = ?
    WHERE id = ?`)
    .run(str(b.name, current.name) || current.name, categoryId, str(b.brand, current.brand), str(b.model, current.model),
      hsn ? hsn.id : current.hsn_id, num(b.gst_rate, current.gst_rate), num(b.purchase_price, current.purchase_price),
      num(b.selling_price, current.selling_price), service ? 0 : num(b.min_stock, current.min_stock),
      service || b.serial_tracked === undefined ? current.serial_tracked : (b.serial_tracked ? 1 : 0),
      str(b.barcode, current.barcode), str(b.description, current.description),
      str(b.location, current.location), b.active === undefined ? current.active : (b.active ? 1 : 0), id);
  res.json({ product: hideCosts(req.user, db.prepare(`${SELECT} WHERE p.id = ?`).get(id)) });
}));

// Products are deactivated, never deleted, so history stays intact.
router.delete('/:id', requireRole('ADMIN'), wrap((req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) throw new AppError('Product not found.', 404);
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
  res.json({ ok: true, deactivated: true });
}));

module.exports = { router, resolveHsn, resolveCategory, generateCode };
