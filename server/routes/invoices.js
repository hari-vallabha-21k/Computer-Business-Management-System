'use strict';
const express = require('express');
const { db, tx, nextNumber, settings } = require('../db');
const { AppError, wrap, num, str, required, round2, today } = require('../lib/util');
const inv = require('../lib/inventory');
const { lineTotals, invoiceTotals } = require('../lib/gst');

const router = express.Router();

function loadInvoice(id) {
  const invoice = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
           c.address AS customer_address, c.gstin AS customer_gstin, u.name AS created_by_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN users u ON u.id = i.created_by
    WHERE i.id = ?`).get(id);
  if (!invoice) throw new AppError('Invoice not found.', 404);
  const items = db.prepare(`
    SELECT it.*, p.name AS product_name, p.product_code, p.serial_tracked
    FROM invoice_items it JOIN products p ON p.id = it.product_id
    WHERE it.invoice_id = ? ORDER BY it.id`).all(id);
  for (const item of items) {
    item.serials = db.prepare('SELECT serial FROM serial_numbers WHERE invoice_item_id = ?')
      .all(item.id).map((r) => r.serial);
  }
  return { invoice, items };
}

/** Build persisted line rows from the request payload, pulling defaults off the product master. */
function buildLines(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new AppError('Add at least one product to the invoice.', 422);
  return rawItems.map((raw) => {
    const product = db.prepare(`
      SELECT p.*, h.code AS hsn_code FROM products p LEFT JOIN hsn_codes h ON h.id = p.hsn_id WHERE p.id = ?`)
      .get(Number(raw.product_id));
    if (!product) throw new AppError(`Product ${raw.product_id} not found.`, 404);
    const qty = num(raw.qty);
    if (qty <= 0) throw new AppError(`Quantity for ${product.name} must be greater than zero.`, 422);

    const unitPrice = raw.unit_price === undefined ? product.selling_price : num(raw.unit_price);
    const gstRate = raw.gst_rate === undefined ? product.gst_rate : num(raw.gst_rate);
    const discount = num(raw.discount);
    const serials = Array.isArray(raw.serials) ? raw.serials.map((s) => str(s)).filter(Boolean) : [];
    if (product.serial_tracked && serials.length && serials.length !== qty) {
      throw new AppError(`${product.name} needs exactly ${qty} serial number(s); ${serials.length} supplied.`, 422);
    }
    const totals = lineTotals({ qty, unitPrice, discount, gstRate });
    return {
      product, qty, unitPrice, discount, gstRate, serials,
      description: str(raw.description) || product.name,
      hsnCode: product.hsn_code || '',
      ...totals,
    };
  });
}

function persistLines(invoiceId, lines) {
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
  const insert = db.prepare(`
    INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit_price, discount,
      gst_rate, gst_amount, taxable_value, total, cost_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return lines.map((l) => {
    const id = Number(insert.run(invoiceId, l.product.id, l.description, l.hsnCode, l.qty, l.unitPrice,
      l.discount, l.gstRate, l.gstAmount, l.taxable, l.total, l.product.purchase_price).lastInsertRowid);
    return { ...l, itemId: id };
  });
}

function saveTotals(invoiceId, lines, customerGstin) {
  const t = invoiceTotals(lines, { businessGstin: settings().gstin, customerGstin });
  db.prepare(`UPDATE invoices SET subtotal = ?, discount = ?, gst_amount = ?, cgst = ?, sgst = ?, igst = ?, total = ?
    WHERE id = ?`).run(t.subtotal, t.discount, t.gstAmount, t.cgst, t.sgst, t.igst, t.total, invoiceId);
  return t;
}

// GET /api/invoices
router.get('/', wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('i.status = ?'); params.push(str(req.query.status).toUpperCase()); }
  if (req.query.customerId) { where.push('i.customer_id = ?'); params.push(Number(req.query.customerId)); }
  if (req.query.from) { where.push('i.invoice_date >= ?'); params.push(str(req.query.from)); }
  if (req.query.to) { where.push('i.invoice_date <= ?'); params.push(str(req.query.to)); }
  if (req.query.q) { where.push('(i.invoice_no LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)'); params.push(`%${str(req.query.q)}%`, `%${str(req.query.q)}%`, `%${str(req.query.q)}%`); }
  const sql = `
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.id DESC LIMIT ?`;
  params.push(num(req.query.limit, 100));
  res.json({ invoices: db.prepare(sql).all(...params) });
}));

router.get('/:id', wrap((req, res) => {
  const { invoice, items } = loadInvoice(Number(req.params.id));
  res.json({ invoice, items, business: settings() });
}));

// POST /api/invoices - create DRAFT (no stock movement) or ISSUED directly
router.post('/', wrap((req, res) => {
  const b = req.body;
  const status = str(b.status, 'DRAFT').toUpperCase();
  if (!['DRAFT', 'ISSUED'].includes(status)) throw new AppError('Status must be DRAFT or ISSUED.', 422);
  const lines = buildLines(b.items);
  const customer = b.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(b.customer_id))
    : null;
  if (b.customer_id && !customer) throw new AppError('Customer not found.', 404);

  const out = tx(() => {
    const invoiceNo = nextNumber(settings().invoice_prefix || 'INV');
    const invoiceId = Number(db.prepare(`
      INSERT INTO invoices (invoice_no, customer_id, invoice_date, status, payment_mode, payment_status, notes, created_by)
      VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)`)
      .run(invoiceNo, customer ? customer.id : null, str(b.invoice_date) || today(),
        str(b.payment_mode, 'CASH'), str(b.payment_status, 'PAID'), str(b.notes), req.user.id).lastInsertRowid);
    const saved = persistLines(invoiceId, lines);
    saveTotals(invoiceId, saved, customer ? customer.gstin : '');
    if (status === 'ISSUED') issueInvoice(invoiceId, req.user.id);
    return loadInvoice(invoiceId);
  });
  res.status(201).json(out);
}));

// PUT /api/invoices/:id - drafts only
router.put('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!existing) throw new AppError('Invoice not found.', 404);
  if (existing.status !== 'DRAFT') throw new AppError('Only draft invoices can be edited.', 409);
  const lines = buildLines(req.body.items);
  const customer = req.body.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.body.customer_id)) : null;

  const out = tx(() => {
    db.prepare(`UPDATE invoices SET customer_id = ?, invoice_date = ?, payment_mode = ?, payment_status = ?, notes = ?
      WHERE id = ?`).run(customer ? customer.id : null, str(req.body.invoice_date) || existing.invoice_date,
      str(req.body.payment_mode, existing.payment_mode), str(req.body.payment_status, existing.payment_status),
      str(req.body.notes, existing.notes), id);
    const saved = persistLines(id, lines);
    saveTotals(id, saved, customer ? customer.gstin : '');
    return loadInvoice(id);
  });
  res.json(out);
}));

/**
 * Issue a draft: validates stock and serials, then reduces inventory.
 * Rule 2 of the business rules - the only path that consumes sale stock.
 */
function issueInvoice(invoiceId, userId) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw new AppError('Invoice not found.', 404);
  if (invoice.status === 'ISSUED') throw new AppError('This invoice has already been issued.', 409);
  if (invoice.status === 'CANCELLED') throw new AppError('A cancelled invoice cannot be issued.', 409);

  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
  if (!items.length) throw new AppError('Cannot issue an invoice with no items.', 422);
  const allowNegative = !!settings().allow_negative_stock;

  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
    if (!allowNegative && product.stock < item.qty) {
      throw new AppError(
        `Insufficient stock for ${product.name}. Requested: ${item.qty}, Available: ${product.stock}. Reduce the quantity or add stock first.`,
        409, { productId: product.id, requested: item.qty, available: product.stock });
    }
    const serials = db.prepare('SELECT serial FROM serial_numbers WHERE invoice_item_id = ?').all(item.id)
      .map((r) => r.serial);
    if (product.serial_tracked) {
      const available = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE product_id = ? AND status = 'AVAILABLE'")
        .get(product.id).n;
      if (!serials.length && available < item.qty && !allowNegative) {
        throw new AppError(`${product.name} is serial tracked and only ${available} serial number(s) are available.`, 409);
      }
    }
  }

  db.prepare("UPDATE invoices SET status = 'ISSUED', issued_at = datetime('now') WHERE id = ?").run(invoiceId);
  for (const item of items) {
    inv.move({
      productId: item.product_id, type: 'SALE', qty: item.qty, unitCost: item.cost_price,
      referenceType: 'INVOICE', referenceId: invoiceId, referenceNo: invoice.invoice_no, userId,
    });
    db.prepare(`UPDATE serial_numbers SET status = 'SOLD', invoice_id = ? WHERE invoice_item_id = ?`)
      .run(invoiceId, item.id);
  }
  db.prepare(`INSERT INTO notifications (level, type, message, link) VALUES ('SUCCESS', 'INVOICE', ?, ?)`)
    .run(`Invoice ${invoice.invoice_no} issued successfully.`, `#/sales/invoice/${invoiceId}`);
  return invoice.invoice_no;
}

// POST /api/invoices/:id/issue
router.post('/:id/issue', wrap((req, res) => {
  const id = Number(req.params.id);
  const out = tx(() => {
    issueInvoice(id, req.user.id);
    return loadInvoice(id);
  });
  res.json(out);
}));

// POST /api/invoices/:id/serials - reserve serial numbers against a draft line
router.post('/:id/serials', wrap((req, res) => {
  const id = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) throw new AppError('Invoice not found.', 404);
  if (invoice.status !== 'DRAFT') throw new AppError('Serial numbers can only be changed on a draft invoice.', 409);
  const itemId = Number(req.body.item_id);
  const item = db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?').get(itemId, id);
  if (!item) throw new AppError('Invoice line not found.', 404);
  const serials = (Array.isArray(req.body.serials) ? req.body.serials : []).map((s) => str(s)).filter(Boolean);
  if (serials.length > item.qty) throw new AppError(`This line sells ${item.qty} unit(s); ${serials.length} serial(s) selected.`, 422);

  tx(() => {
    db.prepare('UPDATE serial_numbers SET invoice_item_id = NULL WHERE invoice_item_id = ?').run(itemId);
    inv.assertSerialsAvailable(item.product_id, serials);
    for (const serial of serials) {
      db.prepare('UPDATE serial_numbers SET invoice_item_id = ? WHERE serial = ?').run(itemId, serial);
    }
  });
  res.json({ ok: true, serials });
}));

// POST /api/invoices/:id/cancel - restores stock (Section 15)
router.post('/:id/cancel', wrap((req, res) => {
  const id = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) throw new AppError('Invoice not found.', 404);
  if (invoice.status === 'CANCELLED') throw new AppError('This invoice is already cancelled.', 409);
  const returned = db.prepare(`SELECT COALESCE(SUM(returned_qty), 0) AS n FROM invoice_items WHERE invoice_id = ?`).get(id).n;
  if (returned > 0) throw new AppError('This invoice has returns recorded against it and cannot be cancelled.', 409);

  const out = tx(() => {
    if (invoice.status === 'ISSUED') {
      const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(id);
      for (const item of items) {
        inv.move({
          productId: item.product_id, type: 'CANCELLED_SALE', qty: item.qty, unitCost: item.cost_price,
          referenceType: 'INVOICE_CANCELLED', referenceId: id, referenceNo: invoice.invoice_no,
          reason: 'INVOICE_CANCELLED', note: str(req.body.reason), userId: req.user.id,
        });
        db.prepare(`UPDATE serial_numbers SET status = 'AVAILABLE', invoice_id = NULL, invoice_item_id = NULL
          WHERE invoice_item_id = ?`).run(item.id);
      }
    }
    db.prepare(`UPDATE invoices SET status = 'CANCELLED', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?`)
      .run(str(req.body.reason), id);
    return loadInvoice(id);
  });
  res.json(out);
}));

router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) throw new AppError('Invoice not found.', 404);
  if (invoice.status !== 'DRAFT') throw new AppError('Only draft invoices can be deleted. Cancel the invoice instead.', 409);
  tx(() => {
    db.prepare('UPDATE serial_numbers SET invoice_item_id = NULL WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  });
  res.json({ ok: true });
}));

module.exports = { router, loadInvoice, issueInvoice };
