'use strict';
/**
 * The API behind the Retail Manager screens: category tax defaults, the
 * product and contact pages, flagged purchases, staff permissions, the
 * serial-number trail and the report exports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, db, makeProduct, tokens, url } = require('./helpers');
const { workbookToText } = require('../server/lib/xlsx');

test.before(start);
test.after(stop);

const setPermissions = (changes) => api('PUT', '/api/settings', { staff_permissions: changes }, 'admin');

test('a category carries the HSN code and GST rate onto new products', async () => {
  const created = await api('POST', '/api/categories', { name: 'Monitors', hsn_code: '85285200', gst_rate: 18 }, 'admin');
  assert.equal(created.status, 201);
  assert.equal(created.body.category.hsn_code, '85285200');

  const product = await api('POST', '/api/products', { name: 'Design Monitor 24', category: 'Monitors', selling_price: 9490 }, 'admin');
  assert.equal(product.status, 201);
  assert.equal(product.body.product.hsn_code, '85285200', 'HSN comes from the category, not retyped');
  assert.equal(product.body.product.gst_rate, 18);
});

test('the tax table saves every category in one go', async () => {
  const before = (await api('GET', '/api/categories', undefined, 'admin')).body.categories;
  const monitors = before.find((c) => c.name === 'Monitors');
  const res = await api('PUT', '/api/categories', {
    categories: [{ id: monitors.id, hsn_code: '85285900', gst_rate: 28 }],
  }, 'admin');
  assert.equal(res.status, 200);
  const after = res.body.categories.find((c) => c.id === monitors.id);
  assert.equal(after.hsn_code, '85285900');
  assert.equal(after.gst_rate, 28);
});

test('a category may not be edited by sales staff', async () => {
  const res = await api('POST', '/api/categories', { name: 'Staff Category' }, 'staff');
  assert.equal(res.status, 403);
});

test('the product page gets its stats and its three histories', async () => {
  const product = await makeProduct({ name: 'Design Detail Laptop', opening_stock: 0, purchase_price: 40000, selling_price: 48000 });
  await api('POST', '/api/purchases', {
    supplier_name: 'Design Distributors',
    items: [{ product_id: product.id, qty: 5, unit_price: 41000, gst_rate: 18 }],
  }, 'admin');
  const invoice = await api('POST', '/api/invoices', {
    status: 'ISSUED', items: [{ product_id: product.id, qty: 2 }],
  }, 'admin');
  assert.equal(invoice.status, 201);

  const res = await api('GET', `/api/products/${product.id}`, undefined, 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.stats.lastPurchasePrice, 41000, 'the price paid last time');
  assert.equal(res.body.stats.lastSupplier, 'Design Distributors');
  assert.equal(res.body.stats.soldThisMonth, 2);
  assert.equal(res.body.stats.stockValue, 3 * 41000, 'stock at the cost it was bought for');
  assert.equal(res.body.sales.length, 1);
  assert.equal(res.body.purchases.length, 1);
});

test('a scanned purchase with unreadable lines is flagged, then cleared', async () => {
  const product = await makeProduct({ name: 'Design Review Item', opening_stock: 0 });
  const created = await api('POST', '/api/purchases', {
    supplier_name: 'Design Distributors',
    source: 'SCAN',
    items: [{ product_id: product.id, qty: 4, unit_price: 900, gst_rate: 18, needs_review: true }],
  }, 'admin');
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'NEEDS_REVIEW');
  assert.equal(created.body.flaggedItems, 1);
  assert.equal(created.body.units, 4);

  const checked = await api('POST', `/api/purchases/${created.body.purchaseId}/checked`, {}, 'admin');
  assert.equal(checked.status, 200);
  assert.equal(checked.body.purchase.status, 'CONFIRMED');
  assert.equal(checked.body.purchase.flagged_items, 0);
});

test('a customer page shows what they bought and what it came to', async () => {
  const customer = (await api('POST', '/api/customers', { name: 'Design Customer', phone: '98450 12345' }, 'admin')).body.record;
  const product = await makeProduct({ name: 'Design Sold Item', opening_stock: 5, selling_price: 2000 });
  await api('POST', '/api/invoices', {
    status: 'ISSUED', customer_id: customer.id, items: [{ product_id: product.id, qty: 2 }],
  }, 'admin');

  const res = await api('GET', `/api/customers/${customer.id}`, undefined, 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.stats.transactions, 1);
  assert.ok(res.body.stats.totalValue > 0);
  assert.equal(res.body.products[0].product, 'Design Sold Item');
  assert.equal(res.body.products[0].qty, 2);
});

test('a serial number tells you where it came from and who bought it', async () => {
  const product = await makeProduct({ name: 'Design Serial Laptop', opening_stock: 0, serial_tracked: true });
  await api('POST', '/api/purchases', {
    supplier_name: 'Design Distributors',
    items: [{ product_id: product.id, qty: 1, unit_price: 30000, serials: ['DSN-0001'] }],
  }, 'admin');
  const list = await api('GET', '/api/inventory/serials?q=DSN-0001', undefined, 'admin');
  assert.equal(list.status, 200);
  assert.equal(list.body.serials.length, 1);

  const row = db.prepare('SELECT id FROM serial_numbers WHERE serial = ?').get('DSN-0001');
  const res = await api('GET', `/api/inventory/serials/${row.id}`, undefined, 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.serial.serial, 'DSN-0001');
  assert.equal(res.body.timeline[0].what, 'Received into stock');
  assert.match(res.body.timeline[0].detail, /Design Distributors/);
});

test('low stock says where the product is usually bought from', async () => {
  const product = await makeProduct({ name: 'Design Low Item', opening_stock: 0, min_stock: 5 });
  await api('POST', '/api/purchases', {
    supplier_name: 'Reorder Supplies', items: [{ product_id: product.id, qty: 1, unit_price: 100 }],
  }, 'admin');
  const res = await api('GET', '/api/inventory/low-stock', undefined, 'admin');
  const row = res.body.items.find((i) => i.id === product.id);
  assert.equal(row.usual_supplier, 'Reorder Supplies');
  assert.ok(typeof res.body.outOfStock === 'number');
});

test('staff permissions are enforced on the server, not just hidden', async () => {
  const product = await makeProduct({ name: 'Design Permission Item', opening_stock: 5, selling_price: 1000 });

  await setPermissions({ discount: false, cancel: false, stock: false, serials: false });
  const discounted = await api('POST', '/api/invoices', {
    items: [{ product_id: product.id, qty: 1, discount: 100 }],
  }, 'staff');
  assert.equal(discounted.status, 403, 'a discount needs permission');
  assert.match(discounted.body.error, /discount/i);

  const plain = await api('POST', '/api/invoices', { status: 'ISSUED', items: [{ product_id: product.id, qty: 1 }] }, 'staff');
  assert.equal(plain.status, 201, 'selling is allowed by default');

  const cancelled = await api('POST', `/api/invoices/${plain.body.invoice.id}/cancel`, { reason: 'Test' }, 'staff');
  assert.equal(cancelled.status, 403);

  const stock = await api('POST', '/api/inventory/add-stock', { product_id: product.id, qty: 1 }, 'staff');
  assert.equal(stock.status, 403);

  const serials = await api('GET', '/api/inventory/serials', undefined, 'staff');
  assert.equal(serials.status, 403);

  await setPermissions({ discount: true, cancel: true, stock: true, serials: true });
  const allowed = await api('POST', '/api/inventory/add-stock', { product_id: product.id, qty: 1 }, 'staff');
  assert.equal(allowed.status, 201, 'the same call works once the owner allows it');
  const admin = await api('POST', '/api/inventory/add-stock', { product_id: product.id, qty: 1 }, 'admin');
  assert.equal(admin.status, 201, 'the owner is never blocked');
});

test('the dashboard hides cost figures from staff who may not see them', async () => {
  await setPermissions({ costs: false });
  const staff = await api('GET', '/api/analytics/dashboard', undefined, 'staff');
  assert.equal(staff.status, 200);
  assert.equal(staff.body.kpis.grossProfit, undefined);
  assert.equal(staff.body.kpis.stockValue, undefined);
  assert.ok(staff.body.kpis.currentStock !== undefined);

  const owner = await api('GET', '/api/analytics/dashboard', undefined, 'admin');
  assert.ok(owner.body.kpis.grossProfit !== undefined);
});

test('analytics and reports are for the owner only', async () => {
  assert.equal((await api('GET', '/api/reports', undefined, 'staff')).status, 403);
  assert.equal((await api('GET', '/api/analytics/inventory', undefined, 'staff')).status, 403);
});

test('the sales trend can carry the previous period for comparison', async () => {
  const res = await api('GET', '/api/analytics/sales-trend?compare=true&from=2026-09-01&to=2026-09-30', undefined, 'admin');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.trend));
  assert.ok(Array.isArray(res.body.previous), 'the dashed last-period line has data to draw');
});

test('a report downloads as a spreadsheet as well as CSV', async () => {
  const res = await fetch(url('/api/reports/sales?format=xlsx'), { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const text = workbookToText(Buffer.from(await res.arrayBuffer()));
  assert.match(text, /Invoice No/, 'the header row survives the round trip');
  assert.match(text, /Design Sold Item/);
});

test('an adjustment can be entered as a shelf count in plain words', async () => {
  const product = await makeProduct({ name: 'Design Count Item', opening_stock: 10 });
  const res = await api('POST', '/api/inventory/adjust', {
    product_id: product.id, new_qty: 9, reason: 'Warranty Replacement', note: 'Swapped under warranty',
  }, 'admin');
  assert.equal(res.status, 201);
  assert.equal(res.body.balance, 9, 'the physical count becomes the new stock');
  const movement = db.prepare(
    "SELECT * FROM inventory_transactions WHERE product_id = ? AND type IN ('ADJUSTMENT','DAMAGE') ORDER BY id DESC",
  ).get(product.id);
  assert.equal(movement.qty, -1, 'the ledger stores the difference, not the count');
  assert.equal(movement.reason, 'WARRANTY');

  const same = await api('POST', '/api/inventory/adjust', { product_id: product.id, new_qty: 9, reason: 'Lost' }, 'admin');
  assert.equal(same.status, 422, 'counting the same number is not an adjustment');

  const nonsense = await api('POST', '/api/inventory/adjust', { product_id: product.id, new_qty: 4, reason: 'Because' }, 'admin');
  assert.equal(nonsense.status, 422);
  assert.match(nonsense.body.error, /damaged/);
});

test('the contact list downloads as a spreadsheet', async () => {
  const res = await fetch(url('/api/customers/export/excel'), { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const text = workbookToText(Buffer.from(await res.arrayBuffer()));
  assert.match(text, /Name \| Phone/);
  assert.match(text, /Design Customer/);
});

test('the invoice numbering can be set to continue from a given number', async () => {
  const res = await api('PUT', '/api/settings', { next_invoice_no: 5000 }, 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.nextNumbers.invoice, 5000);
  const product = await makeProduct({ name: 'Design Numbering Item', opening_stock: 2 });
  const invoice = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  assert.match(invoice.body.invoice.invoice_no, /5000$/);
});

// ---- Fixes from the code review ----

test('staff never receive cost or profit, even from top products or the comparison', async () => {
  await setPermissions({ costs: false });
  const top = await api('GET', '/api/analytics/by-product', undefined, 'staff');
  assert.equal(top.status, 200);
  for (const p of top.body.products) {
    assert.equal(p.cost, undefined);
    assert.equal(p.grossProfit, undefined);
  }
  const dash = await api('GET', '/api/analytics/dashboard?compare=true', undefined, 'staff');
  assert.equal(dash.body.comparison.previous.cost, undefined);
  assert.equal(dash.body.comparison.previous.grossProfit, undefined);

  const owner = await api('GET', '/api/analytics/by-product', undefined, 'admin');
  if (owner.body.products.length) assert.ok(owner.body.products[0].grossProfit !== undefined);
});

test('only the owner can clear a flagged purchase', async () => {
  const product = await makeProduct({ name: 'Design Guard Item', opening_stock: 0 });
  const created = await api('POST', '/api/purchases', {
    supplier_name: 'Design Distributors', source: 'SCAN',
    items: [{ product_id: product.id, qty: 1, unit_price: 100, needs_review: true }],
  }, 'admin');
  const res = await api('POST', `/api/purchases/${created.body.purchaseId}/checked`, {}, 'staff');
  assert.equal(res.status, 403);
});

test('the invoice tax headers use the invoice’s own GST rate', () => {
  const { columns, sharedRate } = require('../server/lib/invoicedoc');
  assert.equal(sharedRate([{ gst_rate: 28 }, { gst_rate: 28 }]), 28);
  assert.equal(sharedRate([{ gst_rate: 12 }, { gst_rate: 18 }]), null);
  const twelve = columns(30, 535, 12).map((c) => c.label);
  assert.ok(twelve.includes('CGST (6%)\nAmount') && twelve.includes('SGST (6%)\nAmount'));
  const eighteen = columns(30, 535, 18);
  assert.ok(eighteen.some((c) => c.label === 'CGST (9%)\nAmount'));
  assert.ok(!eighteen.some((c) => /IGST/.test(c.label)), 'there is no IGST column');
  const last = eighteen[eighteen.length - 1];
  assert.ok(Math.abs(last.x + last.w - 565) < 0.01, 'the columns fill the printable width exactly');
  const mixed = columns(30, 535, null).map((c) => c.label);
  assert.ok(mixed.includes('CGST\nAmount'), 'mixed rates name the tax without a wrong percentage');
});

test('a long invoice flows onto further pages instead of off the bottom', async () => {
  const product = await makeProduct({ name: 'Design Many Lines Item', opening_stock: 100, selling_price: 100 });
  const items = Array.from({ length: 60 }, () => ({ product_id: product.id, qty: 1 }));
  const invoice = await api('POST', '/api/invoices', { status: 'ISSUED', items }, 'admin');
  assert.equal(invoice.status, 201);
  const res = await fetch(url(`/api/invoices/${invoice.body.invoice.id}/pdf`), {
    headers: { authorization: `Bearer ${tokens.admin}` },
  });
  const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pages >= 2, `expected several pages, got ${pages}`);
  const text = await require('../server/lib/extract').pdfText(Buffer.from(pdf, 'latin1'));
  assert.match(text, /Declaration/, 'the footer blocks are still printed');
  assert.match(text, /Page \d of \d/);
});
