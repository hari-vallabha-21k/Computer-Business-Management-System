'use strict';
const express = require('express');
const { db, tx, nextNumber, settings } = require('../db');
const { AppError, wrap, num, str, required, round2 } = require('../lib/util');
const inv = require('../lib/inventory');
const { requireRole } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');

const router = express.Router();

// GET /api/inventory/movements - full audit trail with filters
router.get('/movements', wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.productId) { where.push('t.product_id = ?'); params.push(Number(req.query.productId)); }
  if (req.query.type) { where.push('t.type = ?'); params.push(str(req.query.type)); }
  if (req.query.from) { where.push('date(t.created_at) >= ?'); params.push(str(req.query.from)); }
  if (req.query.to) { where.push('date(t.created_at) <= ?'); params.push(str(req.query.to)); }
  const sql = `
    SELECT t.*, p.name AS product_name, p.product_code, u.name AS user_name
    FROM inventory_transactions t
    JOIN products p ON p.id = t.product_id
    LEFT JOIN users u ON u.id = t.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.id DESC LIMIT ?`;
  params.push(num(req.query.limit, 200));
  res.json({ movements: db.prepare(sql).all(...params) });
}));

// GET /api/inventory/low-stock
router.get('/low-stock', wrap((req, res) => {
  const items = db.prepare(`
    SELECT p.id, p.product_code, p.name, p.brand, p.stock, p.min_stock, p.selling_price, p.location,
      c.name AS category,
      (SELECT s.name FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        LEFT JOIN suppliers s ON s.id = pu.supplier_id
        WHERE pi.product_id = p.id AND s.name IS NOT NULL
        ORDER BY pu.id DESC LIMIT 1) AS usual_supplier
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.active = 1 AND p.item_type = 'PRODUCT' AND (p.stock <= 0 OR (p.min_stock > 0 AND p.stock <= p.min_stock))
    ORDER BY (p.stock <= 0) DESC, p.stock ASC`).all();
  res.json({
    items,
    outOfStock: items.filter((i) => i.stock <= 0).length,
    low: items.filter((i) => i.stock > 0).length,
  });
}));

router.post('/add-stock', requirePermission('stock'), wrap((req, res) => {
  const b = req.body;
  required(b, ['product_id', 'qty']);
  const productId = Number(b.product_id);
  const qty = num(b.qty);
  if (qty <= 0) throw new AppError('Quantity must be greater than zero.', 422);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new AppError('Product not found.', 404);

  const serials = Array.isArray(b.serials) ? b.serials.map((s) => str(s)).filter(Boolean) : [];
  if (product.serial_tracked && serials.length && serials.length !== qty) {
    throw new AppError(`Serial tracking is on for this product: provide ${qty} serial number(s) or none.`, 422);
  }

  const result = tx(() => {
    const purchaseNo = nextNumber(settings().purchase_prefix || 'PUR');
    const unitPrice = num(b.purchase_price, product.purchase_price);
    const gstRate = num(b.gst_rate, product.gst_rate);
    const taxable = round2(unitPrice * qty);
    const gstAmount = round2(taxable * gstRate / 100);
    const purchaseId = Number(db.prepare(`
      INSERT INTO purchases (purchase_no, supplier_id, supplier_invoice_no, invoice_date, status, source,
        subtotal, gst_amount, total, notes, created_by)
      VALUES (?, ?, ?, ?, 'CONFIRMED', 'MANUAL', ?, ?, ?, ?, ?)`)
      .run(purchaseNo, b.supplier_id ? Number(b.supplier_id) : null, str(b.supplier_invoice_no),
        str(b.invoice_date) || new Date().toISOString().slice(0, 10), taxable, gstAmount,
        round2(taxable + gstAmount), str(b.notes), req.user.id).lastInsertRowid);

    db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, description, hsn_code, qty, unit_price, gst_rate, gst_amount, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(purchaseId, productId, product.name,
        db.prepare('SELECT code FROM hsn_codes WHERE id = ?').get(product.hsn_id)?.code || '',
        qty, unitPrice, gstRate, gstAmount, round2(taxable + gstAmount));

    if (serials.length) inv.addSerials(productId, serials, { purchaseId });
    if (unitPrice > 0 && b.update_purchase_price !== false) {
      db.prepare('UPDATE products SET purchase_price = ? WHERE id = ?').run(unitPrice, productId);
    }
    const move = inv.move({
      productId, type: 'PURCHASE', qty, unitCost: unitPrice,
      referenceType: 'PURCHASE', referenceId: purchaseId, referenceNo: purchaseNo, userId: req.user.id,
    });
    return { purchaseNo, purchaseId, balance: move.balance };
  });
  res.status(201).json(result);
}));

// POST /api/inventory/adjust - controlled stock adjustment (Section 21)
router.post('/adjust', requireRole('ADMIN'), wrap((req, res) => {
  const b = req.body;
  required(b, ['product_id', 'reason']);
  const productId = Number(b.product_id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new AppError('Product not found.', 404);

  // The screen counts the shelf ("physical stock"); the ledger stores the difference.
  const qty = b.new_qty === undefined || b.new_qty === ''
    ? num(b.qty)
    : round2(num(b.new_qty) - product.stock);
  if (qty === 0) throw new AppError('The physical count already matches the system.', 422);

  const ALLOWED = ['DAMAGED', 'LOST', 'MISSING', 'WARRANTY', 'CORRECTION', 'OTHER'];
  // "Warranty replacement" and "Manual correction" are the same reasons in longhand.
  const words = str(b.reason).toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const reason = ALLOWED.find((code) => words.includes(code)) || '';
  if (!reason) {
    throw new AppError(`Reason must be one of: ${ALLOWED.map((r) => r.toLowerCase()).join(', ')}.`, 422);
  }

  const out = tx(() => {
    const adjNo = nextNumber(settings().adjustment_prefix || 'ADJ', 1);
    // Damage write-offs are logged under their own type; everything else is a signed adjustment.
    const damage = reason === 'DAMAGED' && qty < 0;
    const move = inv.move({
      productId, type: damage ? 'DAMAGE' : 'ADJUSTMENT', qty: damage ? Math.abs(qty) : qty,
      referenceType: 'ADJUSTMENT', referenceNo: adjNo, reason,
      note: str(b.note), userId: req.user.id,
    });
    if (Array.isArray(b.serials) && b.serials.length) {
      for (const serial of b.serials) {
        db.prepare("UPDATE serial_numbers SET status = ?, note = ? WHERE serial = ?")
          .run(qty < 0 ? 'DAMAGED' : 'AVAILABLE', reason, str(serial));
      }
    }
    if (Math.abs(qty) >= 5) {
      db.prepare(`INSERT INTO notifications (level, type, message, link)
        VALUES ('WARN', 'ADJUSTMENT', ?, ?)`)
        .run(`Unusual stock adjustment of ${qty} on ${product.name} (${reason}).`, `#/inventory/product/${productId}`);
    }
    return { adjustmentNo: adjNo, balance: move.balance };
  });
  res.status(201).json(out);
}));

// ---- Serial numbers ----
router.get('/serials', requirePermission('serials'), wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) { where.push('s.serial LIKE ?'); params.push(`%${str(req.query.q)}%`); }
  if (req.query.productId) { where.push('s.product_id = ?'); params.push(Number(req.query.productId)); }
  if (req.query.status) { where.push('s.status = ?'); params.push(str(req.query.status).toUpperCase()); }
  const sql = `
    SELECT s.*, p.name AS product_name, p.product_code, i.invoice_no
    FROM serial_numbers s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN invoices i ON i.id = s.invoice_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.name, s.serial LIMIT ?`;
  params.push(num(req.query.limit, 300));
  res.json({ serials: db.prepare(sql).all(...params) });
}));

/** One serial number and everything that ever happened to it. */
router.get('/serials/:id', requirePermission('serials'), wrap((req, res) => {
  const serial = db.prepare(`
    SELECT s.*, p.name AS product_name, p.product_code, i.invoice_no, i.invoice_date,
      c.name AS customer_name, pu.purchase_no, pu.invoice_date AS purchased_on, su.name AS supplier_name
    FROM serial_numbers s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN invoices i ON i.id = s.invoice_id
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN purchases pu ON pu.id = s.purchase_id
    LEFT JOIN suppliers su ON su.id = pu.supplier_id
    WHERE s.id = ?`).get(Number(req.params.id));
  if (!serial) throw new AppError('Serial number not found.', 404);

  const timeline = [];
  if (serial.purchase_no) {
    timeline.push({
      date: serial.purchased_on || serial.created_at,
      what: 'Received into stock',
      detail: `${serial.purchase_no}${serial.supplier_name ? ` · ${serial.supplier_name}` : ''}`,
      link: `#/purchases/${serial.purchase_id}`,
    });
  } else {
    timeline.push({ date: serial.created_at, what: 'Added to stock', detail: 'Entered by hand', link: '' });
  }
  if (serial.invoice_no) {
    timeline.push({
      date: serial.invoice_date,
      what: serial.status === 'RETURNED' ? 'Sold, then returned' : 'Sold',
      detail: `${serial.invoice_no}${serial.customer_name ? ` · ${serial.customer_name}` : ''}`,
      link: `#/sales/invoice/${serial.invoice_id}`,
    });
  }
  res.json({ serial, timeline });
}));

router.post('/serials', requirePermission('stock'), wrap((req, res) => {
  required(req.body, ['product_id', 'serials']);
  const productId = Number(req.body.product_id);
  const serials = (Array.isArray(req.body.serials) ? req.body.serials : String(req.body.serials).split(/[\s,]+/))
    .map((s) => str(s)).filter(Boolean);
  tx(() => inv.addSerials(productId, serials));
  res.status(201).json({ added: serials.length });
}));

module.exports = router;
