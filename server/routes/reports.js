'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, str, round2, dateRange, toCsv } = require('../lib/util');

const router = express.Router();

const REPORTS = {
  inventory: {
    label: 'Inventory Report',
    columns: [
      { key: 'product_code', label: 'Product ID' }, { key: 'name', label: 'Product' },
      { key: 'hsn_code', label: 'HSN' }, { key: 'opening', label: 'Opening' },
      { key: 'purchases', label: 'Purchases' }, { key: 'sales', label: 'Sales' },
      { key: 'returns', label: 'Returns' }, { key: 'adjustments', label: 'Adjustments' },
      { key: 'stock', label: 'Current Stock' }, { key: 'stock_value', label: 'Stock Value' },
    ],
    run: (from, to) => db.prepare(`
      SELECT p.product_code, p.name, COALESCE(h.code, '') AS hsn_code, p.stock,
        ROUND(p.stock * p.purchase_price, 2) AS stock_value,
        COALESCE((SELECT SUM(qty) FROM inventory_transactions t WHERE t.product_id = p.id AND t.type = 'OPENING'), 0) AS opening,
        COALESCE((SELECT SUM(qty) FROM inventory_transactions t WHERE t.product_id = p.id AND t.type = 'PURCHASE' AND date(t.created_at) BETWEEN ? AND ?), 0) AS purchases,
        COALESCE((SELECT -SUM(qty) FROM inventory_transactions t WHERE t.product_id = p.id AND t.type = 'SALE' AND date(t.created_at) BETWEEN ? AND ?), 0) AS sales,
        COALESCE((SELECT SUM(qty) FROM inventory_transactions t WHERE t.product_id = p.id AND t.type = 'RETURN' AND date(t.created_at) BETWEEN ? AND ?), 0) AS returns,
        COALESCE((SELECT SUM(qty) FROM inventory_transactions t WHERE t.product_id = p.id AND t.type IN ('ADJUSTMENT','DAMAGE') AND date(t.created_at) BETWEEN ? AND ?), 0) AS adjustments
      FROM products p LEFT JOIN hsn_codes h ON h.id = p.hsn_id
      WHERE p.active = 1 ORDER BY p.name`).all(from, to, from, to, from, to, from, to),
  },
  sales: {
    label: 'Sales Report',
    columns: [
      { key: 'invoice_no', label: 'Invoice No' }, { key: 'invoice_date', label: 'Date' },
      { key: 'customer', label: 'Customer' }, { key: 'product', label: 'Product' },
      { key: 'hsn_code', label: 'HSN' }, { key: 'qty', label: 'Qty' },
      { key: 'taxable_value', label: 'Taxable Value' }, { key: 'gst_amount', label: 'GST' },
      { key: 'total', label: 'Total' },
    ],
    run: (from, to) => db.prepare(`
      SELECT i.invoice_no, i.invoice_date, COALESCE(c.name, 'Walk-in') AS customer,
             it.description AS product, it.hsn_code, it.qty, it.taxable_value, it.gst_amount, it.total
      FROM invoice_items it
      JOIN invoices i ON i.id = it.invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'ISSUED' AND i.invoice_date BETWEEN ? AND ?
      ORDER BY i.invoice_date, i.id`).all(from, to),
  },
  purchases: {
    label: 'Purchase Report',
    columns: [
      { key: 'supplier', label: 'Supplier' }, { key: 'purchase_no', label: 'Purchase No' },
      { key: 'supplier_invoice_no', label: 'Supplier Invoice' }, { key: 'invoice_date', label: 'Date' },
      { key: 'product', label: 'Product' }, { key: 'hsn_code', label: 'HSN' },
      { key: 'qty', label: 'Qty' }, { key: 'unit_price', label: 'Purchase Price' },
      { key: 'gst_amount', label: 'GST' }, { key: 'total', label: 'Total' },
    ],
    run: (from, to) => db.prepare(`
      SELECT COALESCE(s.name, '-') AS supplier, p.purchase_no, p.supplier_invoice_no, p.invoice_date,
             pi.description AS product, pi.hsn_code, pi.qty, pi.unit_price, pi.gst_amount, pi.total
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.invoice_date BETWEEN ? AND ?
      ORDER BY p.invoice_date, p.id`).all(from, to),
  },
  profit: {
    label: 'Profit Report',
    columns: [
      { key: 'product_code', label: 'Product ID' }, { key: 'name', label: 'Product' },
      { key: 'units', label: 'Units Sold' }, { key: 'revenue', label: 'Revenue (excl. GST)' },
      { key: 'cost', label: 'Cost' }, { key: 'gross_profit', label: 'Gross Profit' },
      { key: 'margin', label: 'Margin %' },
    ],
    run: (from, to) => db.prepare(`
      SELECT p.product_code, p.name,
        SUM(it.qty - it.returned_qty) AS units,
        ROUND(SUM((it.qty - it.returned_qty) * (it.taxable_value / NULLIF(it.qty, 0))), 2) AS revenue,
        ROUND(SUM((it.qty - it.returned_qty) * it.cost_price), 2) AS cost
      FROM invoice_items it
      JOIN invoices i ON i.id = it.invoice_id
      JOIN products p ON p.id = it.product_id
      WHERE i.status = 'ISSUED' AND i.invoice_date BETWEEN ? AND ?
      GROUP BY p.id HAVING units > 0 ORDER BY (revenue - cost) DESC`).all(from, to)
      .map((r) => ({
        ...r,
        gross_profit: round2(r.revenue - r.cost),
        margin: r.revenue ? round2(((r.revenue - r.cost) / r.revenue) * 100) : 0,
      })),
  },
  gst: {
    label: 'GST Summary (HSN wise)',
    columns: [
      { key: 'hsn_code', label: 'HSN' }, { key: 'units', label: 'Units' },
      { key: 'taxable', label: 'Taxable Value' }, { key: 'gst', label: 'GST' }, { key: 'total', label: 'Total' },
    ],
    run: (from, to) => db.prepare(`
      SELECT COALESCE(NULLIF(it.hsn_code, ''), 'Not set') AS hsn_code,
        SUM(it.qty - it.returned_qty) AS units,
        ROUND(SUM((it.qty - it.returned_qty) * (it.taxable_value / NULLIF(it.qty, 0))), 2) AS taxable,
        ROUND(SUM((it.qty - it.returned_qty) * (it.gst_amount / NULLIF(it.qty, 0))), 2) AS gst,
        ROUND(SUM((it.qty - it.returned_qty) * (it.total / NULLIF(it.qty, 0))), 2) AS total
      FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
      WHERE i.status = 'ISSUED' AND i.invoice_date BETWEEN ? AND ?
      GROUP BY hsn_code ORDER BY total DESC`).all(from, to),
  },
};

router.get('/', wrap((req, res) => {
  res.json({ reports: Object.entries(REPORTS).map(([key, r]) => ({ key, label: r.label })) });
}));

router.get('/:name', wrap((req, res) => {
  const report = REPORTS[str(req.params.name)];
  if (!report) return res.status(404).json({ error: 'Unknown report.' });
  const [from, to] = dateRange(req.query);
  const rows = report.run(from, to);
  if (str(req.query.format) === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.params.name}-report-${from}-to-${to}.csv"`);
    return res.send(toCsv(rows, report.columns));
  }
  res.json({ label: report.label, columns: report.columns, rows, range: { from, to } });
}));

module.exports = router;
