'use strict';
const express = require('express');
const multer = require('multer');
const { db, tx, nextNumber, settings } = require('../db');
const { AppError, wrap, num, str, required, round2, today } = require('../lib/util');
const inv = require('../lib/inventory');
const { extractPurchaseInvoice } = require('../lib/extract');
const { resolveHsn, resolveCategory, generateCode } = require('./products');
const { requirePermission } = require('../lib/permissions');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get('/', wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.supplierId) { where.push('p.supplier_id = ?'); params.push(Number(req.query.supplierId)); }
  if (req.query.from) { where.push('p.invoice_date >= ?'); params.push(str(req.query.from)); }
  if (req.query.to) { where.push('p.invoice_date <= ?'); params.push(str(req.query.to)); }
  if (req.query.q) {
    where.push('(p.purchase_no LIKE ? OR p.supplier_invoice_no LIKE ? OR s.name LIKE ?)');
    params.push(`%${str(req.query.q)}%`, `%${str(req.query.q)}%`, `%${str(req.query.q)}%`);
  }
  const sql = `
    SELECT p.*, s.name AS supplier_name,
      (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.id DESC LIMIT ?`;
  params.push(num(req.query.limit, 100));
  res.json({ purchases: db.prepare(sql).all(...params) });
}));

router.get('/:id', wrap((req, res) => {
  const purchase = db.prepare(`
    SELECT p.*, s.name AS supplier_name, s.gstin AS supplier_gstin, u.name AS created_by_name
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id = ?`).get(Number(req.params.id));
  if (!purchase) throw new AppError('Purchase not found.', 404);
  const items = db.prepare(`
    SELECT pi.*, pr.name AS product_name, pr.product_code FROM purchase_items pi
    JOIN products pr ON pr.id = pi.product_id WHERE pi.purchase_id = ?`).all(purchase.id);
  const serials = db.prepare('SELECT serial, status, product_id FROM serial_numbers WHERE purchase_id = ?').all(purchase.id);
  res.json({ purchase, items, serials });
}));

/**
 * POST /api/purchases/extract - upload one or more supplier invoices and get a
 * review payload for each. Nothing is written to inventory here; the user
 * confirms on POST /api/purchases.
 *
 * Files arrive under "file" or "files"; the response always carries `results`,
 * and a single upload is also spread at the top level.
 */
router.post('/extract', upload.any(), wrap(async (req, res) => {
  const files = (req.files || []).filter((f) => ['file', 'files', 'files[]'].includes(f.fieldname));
  if (!files.length) throw new AppError('Please choose at least one invoice file to upload.', 422);

  const results = await Promise.all(files.map(async (file) => {
    const result = await extractPurchaseInvoice(file.buffer, file.originalname);
    result.fileName = file.originalname;
    if (!result.ok) {
      db.prepare(`INSERT INTO notifications (level, type, message, link)
        VALUES ('WARN', 'SCAN_FAILED', ?, '#/purchases/add')`)
        .run(`Invoice "${file.originalname}" could not be read automatically: ${result.message}`);
      return result;
    }
    const flagged = result.items.filter((i) => i.needsVerification.length).length;
    if (flagged) {
      db.prepare(`INSERT INTO notifications (level, type, message, link)
        VALUES ('WARN', 'VERIFY', ?, '#/purchases/add')`)
        .run(`${flagged} item(s) from "${file.originalname}" require verification.`);
    }
    return result;
  }));

  const summary = {
    results,
    fileCount: results.length,
    readCount: results.filter((r) => r.ok).length,
    itemCount: results.reduce((n, r) => n + r.items.length, 0),
  };
  res.json(results.length === 1 ? { ...results[0], ...summary } : summary);
}));

/**
 * POST /api/purchases - confirm a purchase (manual or reviewed scan) and add stock.
 * Items may reference an existing product_id or carry new_product details.
 */
router.post('/', requirePermission('stock'), wrap((req, res) => {
  const b = req.body;
  required(b, ['items']);
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (!rawItems.length) throw new AppError('Add at least one item to the purchase.', 422);

  let supplierId = b.supplier_id ? Number(b.supplier_id) : null;
  if (!supplierId && str(b.supplier_name)) {
    const name = str(b.supplier_name);
    const existing = db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(name);
    supplierId = existing
      ? existing.id
      : Number(db.prepare('INSERT INTO suppliers (name, gstin) VALUES (?, ?)')
        .run(name, str(b.supplier_gstin).toUpperCase()).lastInsertRowid);
  }

  // Lines the scan could not read confidently come back marked; the purchase is
  // booked in but flagged, so the owner can check it against the paper bill.
  const flagged = rawItems.filter((raw) => raw.needs_review === true || raw.verify === true).length;

  const out = tx(() => {
    const purchaseNo = nextNumber(settings().purchase_prefix || 'PUR');
    const purchaseId = Number(db.prepare(`
      INSERT INTO purchases (purchase_no, supplier_id, supplier_invoice_no, invoice_date, status, source,
        file_name, subtotal, gst_amount, total, notes, payment_terms, due_date, flagged_items, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`)
      .run(purchaseNo, supplierId, str(b.supplier_invoice_no), str(b.invoice_date) || today(),
        flagged > 0 ? 'NEEDS_REVIEW' : 'CONFIRMED',
        str(b.source, 'MANUAL').toUpperCase(), str(b.file_name), str(b.notes),
        str(b.payment_terms), str(b.due_date) || null, flagged, req.user.id).lastInsertRowid);

    let subtotal = 0;
    let gstTotal = 0;
    for (const raw of rawItems) {
      const qty = num(raw.qty);
      if (qty <= 0) throw new AppError('Every purchase line needs a quantity greater than zero.', 422);
      let product = raw.product_id
        ? db.prepare('SELECT * FROM products WHERE id = ?').get(Number(raw.product_id))
        : null;

      if (!product) {
        // Create the product on the fly from the reviewed line (Section 10: create new product).
        const np = raw.new_product || raw;
        const name = str(np.name || raw.description);
        if (!name) throw new AppError('A purchase line must reference a product or supply a new product name.', 422);
        const hsn = resolveHsn(np.hsn_code || raw.hsn, np.gst_rate ?? raw.gstRate);
        const categoryId = np.category ? resolveCategory(np.category) : null;
        const code = str(np.product_code) || generateCode(str(np.category));
        const id = Number(db.prepare(`
          INSERT INTO products (product_code, name, category_id, brand, model, hsn_id, gst_rate,
            purchase_price, selling_price, min_stock, serial_tracked, barcode, description, stock)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
          .run(code, name, categoryId, str(np.brand), str(np.model), hsn ? hsn.id : null,
            num(np.gst_rate ?? raw.gstRate, hsn ? hsn.gst_rate : 18), num(raw.unit_price ?? raw.unitPrice),
            num(np.selling_price, round2(num(raw.unit_price ?? raw.unitPrice) * 1.15)), num(np.min_stock),
            np.serial_tracked ? 1 : 0, str(np.barcode), str(np.description)).lastInsertRowid);
        product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      }

      const unitPrice = num(raw.unit_price ?? raw.unitPrice, product.purchase_price);
      const gstRate = num(raw.gst_rate ?? raw.gstRate, product.gst_rate);
      const taxable = round2(unitPrice * qty);
      const gstAmount = round2(taxable * gstRate / 100);
      subtotal = round2(subtotal + taxable);
      gstTotal = round2(gstTotal + gstAmount);

      const hsnCode = str(raw.hsn_code || raw.hsn)
        || db.prepare('SELECT code FROM hsn_codes WHERE id = ?').get(product.hsn_id)?.code || '';
      db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, description, hsn_code, qty, unit_price,
        gst_rate, gst_amount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(purchaseId, product.id, str(raw.description) || product.name, hsnCode, qty, unitPrice,
          gstRate, gstAmount, round2(taxable + gstAmount));

      const serials = (Array.isArray(raw.serials) ? raw.serials : []).map((s) => str(s)).filter(Boolean);
      if (serials.length) {
        if (serials.length !== qty) throw new AppError(`${product.name}: ${qty} unit(s) but ${serials.length} serial number(s).`, 422);
        inv.addSerials(product.id, serials, { purchaseId });
      }
      if (unitPrice > 0) db.prepare('UPDATE products SET purchase_price = ? WHERE id = ?').run(unitPrice, product.id);

      inv.move({
        productId: product.id, type: 'PURCHASE', qty, unitCost: unitPrice,
        referenceType: 'PURCHASE', referenceId: purchaseId, referenceNo: purchaseNo, userId: req.user.id,
      });
    }

    db.prepare('UPDATE purchases SET subtotal = ?, gst_amount = ?, total = ? WHERE id = ?')
      .run(subtotal, gstTotal, round2(subtotal + gstTotal), purchaseId);
    return {
      purchaseId, purchaseNo, subtotal, gstAmount: gstTotal, total: round2(subtotal + gstTotal),
      units: rawItems.reduce((sum, raw) => sum + num(raw.qty), 0),
      flaggedItems: flagged, status: flagged > 0 ? 'NEEDS_REVIEW' : 'CONFIRMED',
    };
  });
  res.status(201).json(out);
}));

/** "Mark as checked" on a scanned purchase whose lines were flagged. */
router.post('/:id/checked', wrap((req, res) => {
  const id = Number(req.params.id);
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) throw new AppError('Purchase not found.', 404);
  db.prepare(`UPDATE purchases SET status = 'CONFIRMED', flagged_items = 0, checked_at = datetime('now'), checked_by = ?
    WHERE id = ?`).run(req.user.id, id);
  res.json({ purchase: db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) });
}));

module.exports = router;
