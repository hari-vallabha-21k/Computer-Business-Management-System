'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, db, stockOf, makeProduct, tokens, url } = require('./helpers');

test.before(start);
test.after(stop);

const INVOICE_TEXT = [
  'ABC Computers',
  'Wholesale Market, Mumbai',
  'GSTIN: 27AAACA1111A1Z5',
  'Invoice No: PUR/24-25/1024',
  'Invoice Date: 05/09/2026',
  '',
  'Description | HSN | Qty | Rate | GST | Amount',
  'Intel Core i5 14400 | 84715000 | 10 | 18000 | 18 | 212400',
  'Kingston Fury 16GB DDR4 | 84733099 | 5 | 4200 | 18 | 24780',
  'Mystery Widget XL | | 3 | 6500 | 18 | 23010',
  'Total | | | | | 260190',
].join('\n');

/** Upload a file to the extract endpoint exactly as the browser does. */
async function upload(text, filename = 'supplier-invoice.txt', type = 'text/plain') {
  const form = new FormData();
  form.append('file', new Blob([text], { type }), filename);
  const res = await fetch(url('/api/purchases/extract'), {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.admin}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('extraction reads header, line items and matches existing products', async () => {
  await makeProduct({ name: 'Intel Core i5-14400', brand: 'Intel', model: 'Core i5-14400', hsn_code: '84715000', opening_stock: 0 });
  await makeProduct({ name: 'Kingston Fury 16GB DDR4', brand: 'Kingston', hsn_code: '84733099', opening_stock: 0 });

  const { extractPurchaseInvoice } = require('../server/lib/extract');
  const result = extractPurchaseInvoice(Buffer.from(INVOICE_TEXT), 'supplier-invoice.txt');

  assert.equal(result.ok, true);
  assert.equal(result.header.invoiceNo, 'PUR/24-25/1024');
  assert.equal(result.header.invoiceDate, '2026-09-05');
  assert.equal(result.header.supplierGstin, '27AAACA1111A1Z5');
  assert.equal(result.items.length, 3);

  const [intel, kingston, unknown] = result.items;
  assert.equal(intel.qty, 10);
  assert.equal(intel.unitPrice, 18000);
  assert.equal(intel.hsn, '84715000');
  assert.ok(intel.match, 'the Intel line should match the product master');
  assert.match(intel.match.name, /Intel Core i5-14400/);
  assert.ok(kingston.match);
  assert.equal(unknown.match, null, 'an unknown product must not be matched');
  assert.ok(unknown.needsVerification.includes('NO_PRODUCT_MATCH'));
  assert.ok(result.warnings.some((w) => /require verification/.test(w)));
});

test('the upload endpoint returns a review payload without changing stock', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM purchases').get().n;
  const res = await upload(INVOICE_TEXT);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.fileName, 'supplier-invoice.txt');
  assert.equal(res.body.items.length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, before,
    'uploading an invoice must not create a purchase on its own');
});

test('a scanned image is reported as unreadable instead of failing silently', () => {
  const { extractPurchaseInvoice } = require('../server/lib/extract');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const result = extractPurchaseInvoice(png, 'bill.png');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'IMAGE_NO_TEXT_LAYER');
  assert.match(result.message, /enter the purchase manually/);
});

test('Rule 9: extraction alone changes nothing; confirming the purchase adds stock', async () => {
  const product = await makeProduct({ name: 'Confirm Flow SSD', opening_stock: 2 });
  const { extractPurchaseInvoice } = require('../server/lib/extract');
  const text = [
    'Prime Distributors',
    'Invoice No: PD-9001',
    'Date: 01/09/2026',
    'Description | HSN | Qty | Rate',
    'Confirm Flow SSD | 84733099 | 4 | 5200',
  ].join('\n');
  const extracted = extractPurchaseInvoice(Buffer.from(text), 'pd-9001.txt');
  assert.equal(extracted.ok, true);
  assert.equal(stockOf(product.id), 2, 'extraction must not touch inventory');

  const confirm = await api('POST', '/api/purchases', {
    supplier_name: 'Prime Distributors',
    supplier_invoice_no: extracted.header.invoiceNo,
    invoice_date: extracted.header.invoiceDate,
    source: 'SCAN',
    file_name: 'pd-9001.txt',
    items: [{ product_id: extracted.items[0].match.productId, qty: 4, unit_price: 5200, gst_rate: 18 }],
  }, 'admin');

  assert.equal(confirm.status, 201);
  assert.equal(stockOf(product.id), 6);
  assert.equal(confirm.body.subtotal, 20800);
  assert.equal(confirm.body.total, 24544);
  const movement = db.prepare(
    "SELECT * FROM inventory_transactions WHERE product_id = ? AND type = 'PURCHASE'").get(product.id);
  assert.equal(movement.qty, 4);
  assert.equal(movement.reference_no, confirm.body.purchaseNo);
});

test('a purchase line with no match can create the product on confirmation', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const res = await api('POST', '/api/purchases', {
    supplier_name: 'Techno Supplies',
    invoice_date: '2026-09-02',
    items: [{
      qty: 3,
      unit_price: 6500,
      gst_rate: 18,
      description: 'Mystery Widget XL',
      new_product: { name: 'Mystery Widget XL', category: 'Components', hsn_code: '84733099', selling_price: 7800 },
    }],
  }, 'admin');
  assert.equal(res.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, before + 1);
  const created = db.prepare('SELECT * FROM products WHERE name = ?').get('Mystery Widget XL');
  assert.equal(created.stock, 3);
  assert.equal(created.purchase_price, 6500);
  assert.equal(created.selling_price, 7800);
});

test('manual add-stock records a purchase, serials and the movement', async () => {
  const product = await makeProduct({ name: 'Manual Entry Laptop', opening_stock: 0, serial_tracked: true });
  const res = await api('POST', '/api/inventory/add-stock', {
    product_id: product.id, qty: 2, purchase_price: 41000, serials: ['MEL-001', 'MEL-002'],
  }, 'admin');
  assert.equal(res.status, 201);
  assert.equal(stockOf(product.id), 2);
  const serials = db.prepare("SELECT * FROM serial_numbers WHERE product_id = ? AND status = 'AVAILABLE'").all(product.id);
  assert.equal(serials.length, 2);
  const mismatch = await api('POST', '/api/inventory/add-stock', {
    product_id: product.id, qty: 2, serials: ['MEL-003'],
  }, 'admin');
  assert.equal(mismatch.status, 422);
});

test('analytics reflect issued sales, stock and profit', async () => {
  const product = await makeProduct({ name: 'Analytics Widget', opening_stock: 10, purchase_price: 1000, selling_price: 2000, gst_rate: 18 });
  await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 2 }], status: 'ISSUED' }, 'admin');

  const dash = await api('GET', '/api/analytics/dashboard', undefined, 'admin');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.kpis.itemsSold >= 2);
  assert.ok(dash.body.kpis.grossProfit >= 2000);
  assert.ok(dash.body.kpis.stockValue > 0);

  const byProduct = await api('GET', '/api/analytics/by-product?limit=20', undefined, 'admin');
  const row = byProduct.body.products.find((p) => p.name === 'Analytics Widget');
  assert.equal(row.units, 2);
  assert.equal(row.sales, 4720);
  assert.equal(row.grossProfit, 2000);

  const trend = await api('GET', '/api/analytics/sales-trend?bucket=day', undefined, 'admin');
  assert.ok(trend.body.trend.length >= 1);

  const hsn = await api('GET', '/api/analytics/by-hsn', undefined, 'admin');
  assert.ok(hsn.body.hsn.length >= 1);
});

test('reports export as JSON and CSV', async () => {
  const json = await api('GET', '/api/reports/sales', undefined, 'admin');
  assert.equal(json.status, 200);
  assert.ok(Array.isArray(json.body.rows));
  const csv = await api('GET', '/api/reports/profit?format=csv', undefined, 'admin');
  assert.equal(csv.status, 200);
  assert.match(String(csv.body), /Product ID,Product,Units Sold/);
});

test('an issued invoice renders as a PDF with a QR payload', async () => {
  const product = await makeProduct({ name: 'PDF Test Product', opening_stock: 3 });
  const invoice = await api('POST', '/api/invoices',
    { items: [{ product_id: product.id, qty: 1 }], status: 'ISSUED' }, 'admin');
  const id = invoice.body.invoice.id;

  const qr = await api('GET', `/api/invoices/${id}/qr`, undefined, 'admin');
  assert.equal(qr.status, 200);
  assert.ok(qr.body.dataUrl.startsWith('data:image/png;base64,'));

  const res = await fetch(url(`/api/invoices/${id}/pdf`), {
    headers: { authorization: `Bearer ${tokens.admin}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  assert.ok(buf.length > 1000);
});

test('low stock alerts appear as notifications', async () => {
  const product = await makeProduct({ name: 'Low Stock Widget', opening_stock: 3, min_stock: 2 });
  await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 2 }], status: 'ISSUED' }, 'admin');
  const notifications = await api('GET', '/api/notifications?unread=true', undefined, 'admin');
  assert.ok(notifications.body.notifications.some((n) => /Low Stock Widget/.test(n.message)));
  const low = await api('GET', '/api/inventory/low-stock', undefined, 'admin');
  assert.ok(low.body.items.some((i) => i.name === 'Low Stock Widget'));
});
