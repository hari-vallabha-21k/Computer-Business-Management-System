'use strict';
const express = require('express');
const { db } = require('../db');
const { AppError, wrap, str, required } = require('../lib/util');

/** Customers and suppliers share the same shape, so one factory builds both routers. */
function partyRouter(table) {
  const router = express.Router();
  const isCustomer = table === 'customers';

  router.get('/', wrap((req, res) => {
    const q = str(req.query.q);
    const rows = q
      ? db.prepare(`SELECT * FROM ${table} WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR gstin LIKE ? ORDER BY name LIMIT 50`)
        .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare(`SELECT * FROM ${table} ORDER BY name LIMIT 500`).all();

    const enriched = rows.map((r) => {
      const stats = isCustomer
        ? db.prepare(`SELECT COUNT(*) AS invoices, COALESCE(SUM(total), 0) AS value
             FROM invoices WHERE customer_id = ? AND status = 'ISSUED'`).get(r.id)
        : db.prepare(`SELECT COUNT(*) AS invoices, COALESCE(SUM(total), 0) AS value
             FROM purchases WHERE supplier_id = ?`).get(r.id);
      return { ...r, transactions: stats.invoices, total_value: stats.value };
    });
    res.json({ [table]: enriched });
  }));

  router.get('/:id', wrap((req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params.id));
    if (!row) throw new AppError('Record not found.', 404);
    const history = isCustomer
      ? db.prepare(`SELECT id, invoice_no AS doc_no, invoice_date AS date, status, total
           FROM invoices WHERE customer_id = ? ORDER BY id DESC`).all(row.id)
      : db.prepare(`SELECT id, purchase_no AS doc_no, invoice_date AS date, status, total
           FROM purchases WHERE supplier_id = ? ORDER BY id DESC`).all(row.id);
    res.json({ record: row, history });
  }));

  router.post('/', wrap((req, res) => {
    required(req.body, ['name']);
    const b = req.body;
    const gstin = str(b.gstin).toUpperCase();
    const id = isCustomer
      ? db.prepare(`INSERT INTO customers (name, phone, email, address, gstin, shipping_address, state_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(str(b.name), str(b.phone), str(b.email), str(b.address), gstin,
          str(b.shipping_address), gstin.slice(0, 2) || str(b.state_code)).lastInsertRowid
      : db.prepare('INSERT INTO suppliers (name, phone, email, address, gstin) VALUES (?, ?, ?, ?, ?)')
        .run(str(b.name), str(b.phone), str(b.email), str(b.address), gstin).lastInsertRowid;
    res.status(201).json({ record: db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) });
  }));

  router.put('/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    const current = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!current) throw new AppError('Record not found.', 404);
    const b = req.body;
    const gstin = str(b.gstin, current.gstin).toUpperCase();
    db.prepare(`UPDATE ${table} SET name = ?, phone = ?, email = ?, address = ?, gstin = ? WHERE id = ?`)
      .run(str(b.name, current.name) || current.name, str(b.phone, current.phone), str(b.email, current.email),
        str(b.address, current.address), gstin, id);
    if (isCustomer) {
      db.prepare('UPDATE customers SET shipping_address = ?, state_code = ? WHERE id = ?')
        .run(str(b.shipping_address, current.shipping_address), gstin.slice(0, 2) || str(b.state_code, current.state_code), id);
    }
    res.json({ record: db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) });
  }));

  router.delete('/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    const linked = isCustomer
      ? db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?').get(id).n
      : db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id = ?').get(id).n;
    if (linked) throw new AppError(`This record has ${linked} linked transaction(s) and cannot be deleted.`, 409);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { partyRouter };
