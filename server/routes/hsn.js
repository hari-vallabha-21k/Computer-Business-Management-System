'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, str } = require('../lib/util');
const { requirePermission } = require('../lib/permissions');

const router = express.Router();

// GET /api/hsn
router.get('/', requirePermission('reports'), wrap((req, res) => {
  const from = str(req.query.from);
  const to = str(req.query.to);
  const q = str(req.query.q);

  let dateFilter = '';
  const params = [];

  if (from) { dateFilter += ' AND i.invoice_date >= ?'; params.push(from); }
  if (to) { dateFilter += ' AND i.invoice_date <= ?'; params.push(to); }

  let hsnFilter = '';
  if (q) {
    hsnFilter = ' WHERE hsn_code LIKE ? ';
    params.unshift(`%${q}%`); // add q to the front of params because hsnFilter is used before dateFilter in CTE
  }

  // We want to return:
  // - HSN Code
  // - Product Names (3-4)
  // - Quantity sold
  // - Total taxable amount
  // - SGST (9%), CGST (9%), Total GST

  const sql = `
    WITH product_names AS (
      SELECT hsn_code, group_concat(name, ', ') AS names
      FROM (
        SELECT hc.code AS hsn_code, p.name, ROW_NUMBER() OVER (PARTITION BY hc.code ORDER BY p.name) as rn
        FROM products p
        JOIN hsn_codes hc ON hc.id = p.hsn_id
        WHERE hc.code IS NOT NULL AND hc.code != ''
      ) p
      WHERE rn <= 4
      GROUP BY hsn_code
    ),
    sales_data AS (
      SELECT 
        it.hsn_code,
        SUM(it.qty) AS qty_sold,
        SUM(it.taxable_value) AS taxable_amount
      FROM invoice_items it
      JOIN invoices i ON i.id = it.invoice_id
      WHERE i.status != 'CANCELLED' AND it.hsn_code IS NOT NULL AND it.hsn_code != ''
      ${dateFilter}
      GROUP BY it.hsn_code
    )
    SELECT 
      COALESCE(s.hsn_code, p.hsn_code) AS hsn_code,
      p.names AS product_names,
      COALESCE(s.qty_sold, 0) AS qty_sold,
      COALESCE(s.taxable_amount, 0) AS taxable_amount,
      COALESCE(s.taxable_amount, 0) * 0.09 AS cgst,
      COALESCE(s.taxable_amount, 0) * 0.09 AS sgst
    FROM (SELECT DISTINCT hc.code AS hsn_code FROM products p JOIN hsn_codes hc ON hc.id = p.hsn_id WHERE hc.code IS NOT NULL AND hc.code != '') base
    LEFT JOIN product_names p ON p.hsn_code = base.hsn_code
    LEFT JOIN sales_data s ON s.hsn_code = base.hsn_code
    ${q ? 'WHERE base.hsn_code LIKE ?' : ''}
    ORDER BY base.hsn_code ASC
  `;

  let finalParams = [];
  if (from) finalParams.push(from);
  if (to) finalParams.push(to);
  if (q) finalParams.push(`%${q}%`);

  const rows = db.prepare(sql).all(...finalParams);

  // process row for exact 9% display requested if the rate is 18
  const processed = rows.map(r => {
    // If requirement dictates hardcoding 9% of taxable:
    // But let's use the actual DB values which are accurate.
    const cgst = r.cgst || 0;
    const sgst = r.sgst || 0;
    const totalGst = cgst + sgst;
    
    return {
      hsn_code: r.hsn_code,
      product_names: r.product_names || '',
      qty_sold: r.qty_sold,
      taxable_amount: r.taxable_amount,
      cgst,
      sgst,
      total_gst: totalGst
    };
  });

  res.json({ hsn: processed });
}));
// GET /api/hsn/:code
router.get('/:code', requirePermission('reports'), wrap((req, res) => {
  const code = str(req.params.code);

  const hsnInfo = db.prepare(`SELECT * FROM hsn_codes WHERE code = ?`).get(code) || { code, description: 'Unknown HSN', gst_rate: 18 };

  const products = db.prepare(`
    SELECT id, product_code, name, brand, stock, selling_price
    FROM products
    WHERE hsn_id = ? OR hsn_id = (SELECT id FROM hsn_codes WHERE code = ?)
  `).all(hsnInfo.id, code);

  const sales = db.prepare(`
    SELECT 
      i.id as invoice_id, i.invoice_no, i.invoice_date,
      c.name as customer_name,
      it.qty, it.unit_price, it.taxable_value,
      it.gst_amount, it.total, p.name as product_name
    FROM invoice_items it
    JOIN invoices i ON i.id = it.invoice_id
    JOIN products p ON p.id = it.product_id
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE (it.hsn_code = ? OR p.hsn_id = ?) AND i.status != 'CANCELLED'
    ORDER BY i.invoice_date DESC, i.id DESC
  `).all(code, hsnInfo.id);

  res.json({ hsn: hsnInfo, products, sales });
}));

module.exports = router;
