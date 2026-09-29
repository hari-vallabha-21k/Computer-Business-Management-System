'use strict';
const express = require('express');
const { db, tx, nextNumber, settings } = require('../db');
const { AppError, wrap, num, str, required, round2, today } = require('../lib/util');
const inv = require('../lib/inventory');

const router = express.Router();

router.get('/', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT r.*, i.invoice_no, c.name AS customer_name
    FROM sales_returns r
    JOIN invoices i ON i.id = r.invoice_id
    LEFT JOIN customers c ON c.id = i.customer_id
    ORDER BY r.id DESC LIMIT ?`).all(num(req.query.limit, 100));
  for (const r of rows) {
    r.items = db.prepare(`
      SELECT ri.*, p.name AS product_name FROM return_items ri
      JOIN products p ON p.id = ri.product_id WHERE ri.return_id = ?`).all(r.id);
  }
  res.json({ returns: rows });
}));

// GET /api/returns/invoice/:invoiceNo - returnable lines for an issued invoice
router.get('/invoice/:invoiceNo', wrap((req, res) => {
  const key = str(req.params.invoiceNo);
  const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_no = ? OR id = ?').get(key, Number(key) || -1);
  if (!invoice) throw new AppError('Invoice not found.', 404);
  if (invoice.status !== 'ISSUED') throw new AppError(`Only issued invoices can be returned (this one is ${invoice.status}).`, 409);
  const items = db.prepare(`
    SELECT it.*, p.name AS product_name, p.serial_tracked, p.item_type, (it.qty - it.returned_qty) AS returnable
    FROM invoice_items it JOIN products p ON p.id = it.product_id
    WHERE it.invoice_id = ? ORDER BY it.id`).all(invoice.id);
  for (const item of items) {
    item.serials = db.prepare("SELECT serial, status FROM serial_numbers WHERE invoice_item_id = ?").all(item.id);
  }
  const customer = invoice.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id) : null;
  res.json({ invoice, items, customer });
}));

// POST /api/returns - restores inventory (Rule 3)
router.post('/', wrap((req, res) => {
  const b = req.body;
  required(b, ['invoice_id', 'items']);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(b.invoice_id));
  if (!invoice) throw new AppError('Invoice not found.', 404);
  if (invoice.status !== 'ISSUED') throw new AppError('Only issued invoices can be returned.', 409);
  const lines = (Array.isArray(b.items) ? b.items : []).filter((l) => num(l.qty) > 0);
  if (!lines.length) throw new AppError('Select at least one item and quantity to return.', 422);
  const restock = b.restock === false ? 0 : 1;

  const out = tx(() => {
    const returnNo = nextNumber(settings().return_prefix || 'RET', 1001);
    const returnId = Number(db.prepare(`
      INSERT INTO sales_returns (return_no, invoice_id, return_date, reason, total, restock, created_by)
      VALUES (?, ?, ?, ?, 0, ?, ?)`)
      .run(returnNo, invoice.id, str(b.return_date) || today(), str(b.reason), restock, req.user.id).lastInsertRowid);

    let total = 0;
    for (const line of lines) {
      const item = db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?')
        .get(Number(line.invoice_item_id), invoice.id);
      if (!item) throw new AppError('Invoice line not found on this invoice.', 404);
      const qty = num(line.qty);
      const remaining = round2(item.qty - item.returned_qty);
      if (qty > remaining) {
        throw new AppError(`Cannot return ${qty} unit(s); only ${remaining} remain un-returned on this line.`, 422);
      }
      const unitValue = item.qty ? round2(item.total / item.qty) : 0;
      const amount = round2(unitValue * qty);
      total = round2(total + amount);

      db.prepare('INSERT INTO return_items (return_id, invoice_item_id, product_id, qty, amount) VALUES (?, ?, ?, ?, ?)')
        .run(returnId, item.id, item.product_id, qty, amount);
      db.prepare('UPDATE invoice_items SET returned_qty = returned_qty + ? WHERE id = ?').run(qty, item.id);

      const serials = (Array.isArray(line.serials) ? line.serials : []).map((s) => str(s)).filter(Boolean);
      if (serials.length && serials.length !== qty) {
        throw new AppError(`Select exactly ${qty} serial number(s) for this return.`, 422);
      }
      for (const serial of serials) {
        const row = db.prepare('SELECT * FROM serial_numbers WHERE serial = ? AND invoice_item_id = ?').get(serial, item.id);
        if (!row) throw new AppError(`Serial ${serial} was not sold on this invoice line.`, 422);
        db.prepare(`UPDATE serial_numbers SET status = ?, invoice_id = NULL, invoice_item_id = NULL WHERE id = ?`)
          .run(restock ? 'AVAILABLE' : 'DAMAGED', row.id);
      }

      // A returned service is refunded, but there is nothing to put back on the shelf.
      const service = inv.isService(db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id));
      if (!service) inv.move({
        productId: item.product_id, type: 'RETURN', qty, unitCost: item.cost_price,
        referenceType: 'RETURN', referenceId: returnId, referenceNo: returnNo,
        reason: 'CUSTOMER_RETURN', note: str(b.reason), userId: req.user.id,
      });
      if (!restock && !service) {
        // Goods came back damaged: the return is logged, then written straight off again.
        inv.move({
          productId: item.product_id, type: 'DAMAGE', qty, unitCost: item.cost_price,
          referenceType: 'RETURN', referenceId: returnId, referenceNo: returnNo,
          reason: 'RETURNED_DAMAGED', note: str(b.reason), userId: req.user.id,
        });
      }
    }
    db.prepare('UPDATE sales_returns SET total = ? WHERE id = ?').run(total, returnId);
    return { returnNo, returnId, total };
  });
  res.status(201).json(out);
}));

module.exports = router;
