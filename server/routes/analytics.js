'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, num, str, round2, dateRange } = require('../lib/util');

const router = express.Router();

/** Shared WHERE fragment for issued invoices with the dashboard's filters applied. */
function salesFilter(query) {
  const [from, to] = dateRange(query);
  const where = ["i.status = 'ISSUED'", 'i.invoice_date >= ?', 'i.invoice_date <= ?'];
  const params = [from, to];
  if (query.category) { where.push('c.name = ?'); params.push(str(query.category)); }
  if (query.brand) { where.push('p.brand = ?'); params.push(str(query.brand)); }
  if (query.productId) { where.push('p.id = ?'); params.push(Number(query.productId)); }
  return { clause: where.join(' AND '), params, from, to };
}

const ITEM_JOIN = `
  FROM invoice_items it
  JOIN invoices i ON i.id = it.invoice_id
  JOIN products p ON p.id = it.product_id
  LEFT JOIN categories c ON c.id = p.category_id`;

function summaryFor(query) {
  const { clause, params } = salesFilter(query);
  const sold = db.prepare(`
    SELECT COALESCE(SUM(it.qty - it.returned_qty), 0) AS units,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.taxable_value / NULLIF(it.qty, 0))), 0) AS revenue,
           COALESCE(SUM((it.qty - it.returned_qty) * it.cost_price), 0) AS cost,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.total / NULLIF(it.qty, 0))), 0) AS revenue_with_tax
    ${ITEM_JOIN} WHERE ${clause}`).get(...params);
  const invoices = db.prepare(`
    SELECT COUNT(DISTINCT i.id) AS count ${ITEM_JOIN} WHERE ${clause}`).get(...params);
  return {
    unitsSold: round2(sold.units),
    revenue: round2(sold.revenue),
    revenueWithTax: round2(sold.revenue_with_tax),
    cost: round2(sold.cost),
    grossProfit: round2(sold.revenue - sold.cost),
    invoices: invoices.count,
  };
}

/** Previous window of the same length, for period-on-period comparison. */
function previousRange(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.max(Math.round((end - start) / 86400000) + 1, 1);
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  return [prevStart.toISOString().slice(0, 10), prevEnd.toISOString().slice(0, 10)];
}

// GET /api/analytics/dashboard
router.get('/dashboard', wrap((req, res) => {
  const { from, to } = salesFilter(req.query);
  const current = summaryFor(req.query);

  let comparison = null;
  if (req.query.compare === 'true') {
    const [pFrom, pTo] = previousRange(from, to);
    const previous = summaryFor({ ...req.query, from: pFrom, to: pTo });
    const delta = (a, b) => (b === 0 ? (a === 0 ? 0 : 100) : round2(((a - b) / Math.abs(b)) * 100));
    comparison = {
      range: { from: pFrom, to: pTo },
      previous,
      change: {
        revenue: delta(current.revenue, previous.revenue),
        unitsSold: delta(current.unitsSold, previous.unitsSold),
        grossProfit: delta(current.grossProfit, previous.grossProfit),
        invoices: delta(current.invoices, previous.invoices),
      },
    };
  }

  const stock = db.prepare(`
    SELECT COUNT(*) AS products, COALESCE(SUM(stock), 0) AS units,
           COALESCE(SUM(stock * purchase_price), 0) AS value,
           COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
           COALESCE(SUM(CASE WHEN stock > 0 AND min_stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END), 0) AS low_stock
    FROM products WHERE active = 1`).get();

  const purchases = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count
    FROM purchases WHERE invoice_date >= ? AND invoice_date <= ?`).get(from, to);

  const drafts = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'DRAFT'").get().n;

  res.json({
    range: { from, to },
    kpis: {
      totalSales: current.revenueWithTax,
      netRevenue: current.revenue,
      itemsSold: current.unitsSold,
      invoices: current.invoices,
      grossProfit: current.grossProfit,
      cost: current.cost,
      currentStock: round2(stock.units),
      stockValue: round2(stock.value),
      totalProducts: stock.products,
      lowStockItems: stock.low_stock,
      outOfStock: stock.out_of_stock,
      totalPurchases: round2(purchases.total),
      purchaseCount: purchases.count,
      draftInvoices: drafts,
    },
    comparison,
  });
}));

// GET /api/analytics/sales-trend?bucket=day|week|month
router.get('/sales-trend', wrap((req, res) => {
  const { clause, params } = salesFilter(req.query);
  const bucket = str(req.query.bucket, 'day');
  const fmt = bucket === 'month' ? '%Y-%m' : bucket === 'week' ? '%Y-W%W' : '%Y-%m-%d';
  const rows = db.prepare(`
    SELECT strftime('${fmt}', i.invoice_date) AS period,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.total / NULLIF(it.qty, 0))), 0) AS sales,
           COALESCE(SUM(it.qty - it.returned_qty), 0) AS units,
           COUNT(DISTINCT i.id) AS invoices
    ${ITEM_JOIN} WHERE ${clause}
    GROUP BY period ORDER BY period`).all(...params);
  res.json({ trend: rows.map((r) => ({ ...r, sales: round2(r.sales), units: round2(r.units) })) });
}));

// GET /api/analytics/by-product
router.get('/by-product', wrap((req, res) => {
  const { clause, params } = salesFilter(req.query);
  const rows = db.prepare(`
    SELECT p.id, p.name, p.product_code, p.brand, c.name AS category,
           COALESCE(SUM(it.qty - it.returned_qty), 0) AS units,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.total / NULLIF(it.qty, 0))), 0) AS sales,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.taxable_value / NULLIF(it.qty, 0))), 0) AS taxable,
           COALESCE(SUM((it.qty - it.returned_qty) * it.cost_price), 0) AS cost
    ${ITEM_JOIN} WHERE ${clause}
    GROUP BY p.id HAVING units > 0 ORDER BY units DESC LIMIT ?`).all(...params, num(req.query.limit, 10));
  res.json({
    products: rows.map((r) => ({
      ...r, units: round2(r.units), sales: round2(r.sales), cost: round2(r.cost),
      grossProfit: round2(r.taxable - r.cost),
    })),
  });
}));

// GET /api/analytics/by-category
router.get('/by-category', wrap((req, res) => {
  const { clause, params } = salesFilter(req.query);
  const rows = db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorised') AS category,
           COALESCE(SUM(it.qty - it.returned_qty), 0) AS units,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.total / NULLIF(it.qty, 0))), 0) AS sales
    ${ITEM_JOIN} WHERE ${clause}
    GROUP BY category ORDER BY sales DESC`).all(...params);
  const total = rows.reduce((s, r) => s + r.sales, 0);
  res.json({
    categories: rows.map((r) => ({
      ...r, units: round2(r.units), sales: round2(r.sales),
      share: total ? round2((r.sales / total) * 100) : 0,
    })),
  });
}));

// GET /api/analytics/by-hsn
router.get('/by-hsn', wrap((req, res) => {
  const { clause, params } = salesFilter(req.query);
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(it.hsn_code, ''), 'Not set') AS hsn_code,
           COALESCE(SUM(it.qty - it.returned_qty), 0) AS units,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.taxable_value / NULLIF(it.qty, 0))), 0) AS taxable,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.gst_amount / NULLIF(it.qty, 0))), 0) AS gst,
           COALESCE(SUM((it.qty - it.returned_qty) * (it.total / NULLIF(it.qty, 0))), 0) AS sales
    ${ITEM_JOIN} WHERE ${clause}
    GROUP BY hsn_code ORDER BY sales DESC`).all(...params);
  const withDesc = rows.map((r) => ({
    ...r,
    units: round2(r.units), taxable: round2(r.taxable), gst: round2(r.gst), sales: round2(r.sales),
    description: db.prepare('SELECT description FROM hsn_codes WHERE code = ?').get(r.hsn_code)?.description || '',
  }));
  res.json({ hsn: withDesc });
}));

// GET /api/analytics/inventory
router.get('/inventory', wrap((req, res) => {
  const byCategory = db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorised') AS category, COUNT(*) AS products,
           COALESCE(SUM(p.stock), 0) AS units, COALESCE(SUM(p.stock * p.purchase_price), 0) AS value
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.active = 1 GROUP BY category ORDER BY value DESC`).all();
  const lowStock = db.prepare(`
    SELECT id, product_code, name, stock, min_stock FROM products
    WHERE active = 1 AND (stock <= 0 OR (min_stock > 0 AND stock <= min_stock))
    ORDER BY stock ASC LIMIT 20`).all();
  const serials = db.prepare(`
    SELECT status, COUNT(*) AS n FROM serial_numbers GROUP BY status`).all();
  res.json({ byCategory: byCategory.map((r) => ({ ...r, value: round2(r.value), units: round2(r.units) })), lowStock, serials });
}));

module.exports = router;
