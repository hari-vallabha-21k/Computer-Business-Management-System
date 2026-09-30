'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, str, round2 } = require('../lib/util');
const { splitGst } = require('../lib/gst');
const { requireRole } = require('../lib/auth');

const router = express.Router();

/**
 * HSN-wise sales - the summary a GST return is built from. Only issued
 * invoices count, returned units come back off the figures, and the tax is
 * what each line actually charged rather than 9% + 9% assumed for everything.
 */
router.get('/', requireRole('ADMIN'), wrap((req, res) => {
  const from = str(req.query.from);
  const to = str(req.query.to);
  const q = str(req.query.q);

  const params = [];
  let dateFilter = '';
  if (from) { dateFilter += ' AND i.invoice_date >= ?'; params.push(from); }
  if (to) { dateFilter += ' AND i.invoice_date <= ?'; params.push(to); }

  const sql = `
    WITH product_names AS (
      SELECT hsn_code, group_concat(name, ', ') AS names
      FROM (
        SELECT hc.code AS hsn_code, p.name, ROW_NUMBER() OVER (PARTITION BY hc.code ORDER BY p.name) AS rn
        FROM products p
        JOIN hsn_codes hc ON hc.id = p.hsn_id
        WHERE hc.code IS NOT NULL AND hc.code != ''
      ) named
      WHERE rn <= 4
      GROUP BY hsn_code
    ),
    sales_data AS (
      SELECT
        it.hsn_code,
        SUM(it.qty - it.returned_qty) AS qty_sold,
        SUM((it.qty - it.returned_qty) * (it.taxable_value / NULLIF(it.qty, 0))) AS taxable_amount,
        SUM((it.qty - it.returned_qty) * (it.gst_amount / NULLIF(it.qty, 0))) AS gst_amount
      FROM invoice_items it
      JOIN invoices i ON i.id = it.invoice_id
      WHERE i.status = 'ISSUED' AND it.hsn_code IS NOT NULL AND it.hsn_code != ''
      ${dateFilter}
      GROUP BY it.hsn_code
    )
    SELECT
      base.hsn_code,
      names.names AS product_names,
      COALESCE(s.qty_sold, 0) AS qty_sold,
      COALESCE(s.taxable_amount, 0) AS taxable_amount,
      COALESCE(s.gst_amount, 0) AS gst_amount
    FROM (SELECT DISTINCT hc.code AS hsn_code FROM products p JOIN hsn_codes hc ON hc.id = p.hsn_id
          WHERE hc.code IS NOT NULL AND hc.code != '') base
    LEFT JOIN product_names names ON names.hsn_code = base.hsn_code
    LEFT JOIN sales_data s ON s.hsn_code = base.hsn_code
    ${q ? 'WHERE base.hsn_code LIKE ?' : ''}
    ORDER BY base.hsn_code ASC`;

  if (q) params.push(`%${q}%`);

  const hsn = db.prepare(sql).all(...params).map((r) => {
    const [cgst, sgst] = splitGst(r.gst_amount);
    return {
      hsn_code: r.hsn_code,
      product_names: r.product_names || '',
      qty_sold: round2(r.qty_sold),
      taxable_amount: round2(r.taxable_amount),
      cgst,
      sgst,
      total_gst: round2(r.gst_amount),
    };
  });

  res.json({ hsn });
}));

// GET /api/hsn/:code
router.get('/:code', requireRole('ADMIN'), wrap((req, res) => {
  const code = str(req.params.code);
  // A code that has been taken off the master list can still sit on old
  // invoices, so show what there is rather than failing on the missing row.
  const known = db.prepare('SELECT * FROM hsn_codes WHERE code = ?').get(code);
  const hsn = known || { id: null, code, description: 'Not in your HSN list', gst_rate: 18 };
  const hsnId = known ? known.id : -1;

  const products = db.prepare(`
    SELECT id, product_code, name, brand, stock, selling_price
    FROM products WHERE hsn_id = ? ORDER BY name`).all(hsnId);

  const sales = db.prepare(`
    SELECT
      i.id AS invoice_id, i.invoice_no, i.invoice_date,
      c.name AS customer_name,
      it.qty, it.unit_price, it.taxable_value,
      it.gst_amount, it.total, p.name AS product_name
    FROM invoice_items it
    JOIN invoices i ON i.id = it.invoice_id
    JOIN products p ON p.id = it.product_id
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE (it.hsn_code = ? OR p.hsn_id = ?) AND i.status = 'ISSUED'
    ORDER BY i.invoice_date DESC, i.id DESC`).all(code, hsnId);

  res.json({ hsn, products, sales });
}));

module.exports = router;
