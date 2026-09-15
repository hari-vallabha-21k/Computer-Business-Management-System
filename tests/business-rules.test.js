'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, db, stockOf, makeProduct } = require('./helpers');

test.before(start);
test.after(stop);

test('Rule 1: a draft invoice does not touch inventory', async () => {
  const product = await makeProduct({ opening_stock: 10 });
  const res = await api('POST', '/api/invoices', {
    items: [{ product_id: product.id, qty: 3 }],
  }, 'admin');
  assert.equal(res.status, 201);
  assert.equal(res.body.invoice.status, 'DRAFT');
  assert.equal(stockOf(product.id), 10);
});

test('Rule 2: issuing an invoice reduces stock and logs the movement', async () => {
  const product = await makeProduct({ opening_stock: 10 });
  const created = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 2 }] }, 'admin');
  const id = created.body.invoice.id;

  const issued = await api('POST', `/api/invoices/${id}/issue`, {}, 'admin');
  assert.equal(issued.status, 200);
  assert.equal(issued.body.invoice.status, 'ISSUED');
  assert.equal(stockOf(product.id), 8);

  const movement = db.prepare(
    "SELECT * FROM inventory_transactions WHERE product_id = ? AND type = 'SALE'").get(product.id);
  assert.equal(movement.qty, -2);
  assert.equal(movement.balance_after, 8);
  assert.equal(movement.reference_no, issued.body.invoice.invoice_no);
});

test('Invoice totals apply GST and discounts per line', async () => {
  const product = await makeProduct({ opening_stock: 5, selling_price: 1000, gst_rate: 18 });
  const res = await api('POST', '/api/invoices', {
    items: [{ product_id: product.id, qty: 2, discount: 200 }],
  }, 'admin');
  const { invoice } = res.body;
  assert.equal(invoice.subtotal, 1800, 'subtotal is the taxable value, after discount');
  assert.equal(invoice.discount, 200);
  assert.equal(invoice.gst_amount, 324); // 18% of 1800
  assert.equal(invoice.total, 2124);
  assert.equal(invoice.cgst, 162);
  assert.equal(invoice.sgst, 162);
});

test('Rule 8: an invoice cannot be issued for more units than are in stock', async () => {
  const product = await makeProduct({ opening_stock: 3 });
  const created = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 5 }] }, 'admin');
  const res = await api('POST', `/api/invoices/${created.body.invoice.id}/issue`, {}, 'admin');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Insufficient stock/);
  assert.equal(res.body.details.available, 3);
  assert.equal(res.body.details.requested, 5);
  assert.equal(stockOf(product.id), 3, 'a failed issue must leave stock untouched');
  const still = await api('GET', `/api/invoices/${created.body.invoice.id}`, undefined, 'admin');
  assert.equal(still.body.invoice.status, 'DRAFT', 'a failed issue must roll the status back');
});

test('Cancelling an issued invoice restores stock and frees serials', async () => {
  const product = await makeProduct({ opening_stock: 0, serial_tracked: true });
  await api('POST', '/api/inventory/add-stock', {
    product_id: product.id, qty: 2, purchase_price: 900, serials: ['SNX-1', 'SNX-2'],
  }, 'admin');
  assert.equal(stockOf(product.id), 2);

  const created = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  const invoiceId = created.body.invoice.id;
  const itemId = created.body.items[0].id;
  await api('POST', `/api/invoices/${invoiceId}/serials`, { item_id: itemId, serials: ['SNX-1'] }, 'admin');
  await api('POST', `/api/invoices/${invoiceId}/issue`, {}, 'admin');

  assert.equal(stockOf(product.id), 1);
  assert.equal(db.prepare('SELECT status FROM serial_numbers WHERE serial = ?').get('SNX-1').status, 'SOLD');

  const cancelled = await api('POST', `/api/invoices/${invoiceId}/cancel`, { reason: 'Customer walked away' }, 'admin');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.invoice.status, 'CANCELLED');
  assert.equal(stockOf(product.id), 2);
  assert.equal(db.prepare('SELECT status FROM serial_numbers WHERE serial = ?').get('SNX-1').status, 'AVAILABLE');
});

test('Rule 3: a return puts stock back and records the movement', async () => {
  const product = await makeProduct({ opening_stock: 10 });
  const created = await api('POST', '/api/invoices', {
    items: [{ product_id: product.id, qty: 2 }], status: 'ISSUED',
  }, 'admin');
  assert.equal(created.body.invoice.status, 'ISSUED');
  assert.equal(stockOf(product.id), 8);

  const ret = await api('POST', '/api/returns', {
    invoice_id: created.body.invoice.id,
    items: [{ invoice_item_id: created.body.items[0].id, qty: 1 }],
    reason: 'Not needed',
  }, 'admin');
  assert.equal(ret.status, 201);
  assert.equal(stockOf(product.id), 9);

  const overReturn = await api('POST', '/api/returns', {
    invoice_id: created.body.invoice.id,
    items: [{ invoice_item_id: created.body.items[0].id, qty: 2 }],
  }, 'admin');
  assert.equal(overReturn.status, 422, 'cannot return more than was sold');
  assert.equal(stockOf(product.id), 9);
});

test('Rule 4: stock adjustments require a valid reason and are logged', async () => {
  const product = await makeProduct({ opening_stock: 10 });
  const bad = await api('POST', '/api/inventory/adjust', { product_id: product.id, qty: -1 }, 'admin');
  assert.equal(bad.status, 422);

  const invalidReason = await api('POST', '/api/inventory/adjust',
    { product_id: product.id, qty: -1, reason: 'BECAUSE' }, 'admin');
  assert.equal(invalidReason.status, 422);

  const ok = await api('POST', '/api/inventory/adjust',
    { product_id: product.id, qty: -1, reason: 'DAMAGED', note: 'Dropped in transit' }, 'admin');
  assert.equal(ok.status, 201);
  assert.equal(stockOf(product.id), 9);
  const logged = db.prepare(
    'SELECT * FROM inventory_transactions WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(product.id);
  assert.equal(logged.type, 'DAMAGE');
  assert.equal(logged.reason, 'DAMAGED');
  assert.equal(logged.qty, -1);
});

test('Rule 7: serial numbers are unique and only sellable when available', async () => {
  const a = await makeProduct({ opening_stock: 0, serial_tracked: true });
  const b = await makeProduct({ opening_stock: 0, serial_tracked: true });
  const first = await api('POST', '/api/inventory/serials', { product_id: a.id, serials: ['DUP-1'] }, 'admin');
  assert.equal(first.status, 201);
  const clash = await api('POST', '/api/inventory/serials', { product_id: b.id, serials: ['DUP-1'] }, 'admin');
  assert.equal(clash.status, 409);

  const invoice = await api('POST', '/api/invoices', { items: [{ product_id: b.id, qty: 1 }] }, 'admin');
  const wrongProduct = await api('POST', `/api/invoices/${invoice.body.invoice.id}/serials`,
    { item_id: invoice.body.items[0].id, serials: ['DUP-1'] }, 'admin');
  assert.equal(wrongProduct.status, 422);
});

test('Rule 10: the ledger balance always matches the product stock', async () => {
  const product = await makeProduct({ opening_stock: 10 });
  await api('POST', '/api/inventory/add-stock', { product_id: product.id, qty: 5, purchase_price: 800 }, 'admin');
  const invoice = await api('POST', '/api/invoices',
    { items: [{ product_id: product.id, qty: 4 }], status: 'ISSUED' }, 'admin');
  await api('POST', '/api/returns', {
    invoice_id: invoice.body.invoice.id,
    items: [{ invoice_item_id: invoice.body.items[0].id, qty: 1 }],
  }, 'admin');
  await api('POST', '/api/inventory/adjust', { product_id: product.id, qty: -2, reason: 'LOST' }, 'admin');

  const detail = await api('GET', `/api/products/${product.id}`, undefined, 'admin');
  assert.equal(detail.body.product.stock, 10);
  assert.equal(detail.body.ledgerStock, 10, 'ledger must reconcile with the stock column');
  assert.equal(detail.body.movements.length, 5);
});

test('Negative stock is allowed only when the owner switches it on', async () => {
  const product = await makeProduct({ opening_stock: 1 });
  const invoice = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 3 }] }, 'admin');
  assert.equal((await api('POST', `/api/invoices/${invoice.body.invoice.id}/issue`, {}, 'admin')).status, 409);

  await api('PUT', '/api/settings', { allow_negative_stock: true }, 'admin');
  const retry = await api('POST', `/api/invoices/${invoice.body.invoice.id}/issue`, {}, 'admin');
  assert.equal(retry.status, 200);
  assert.equal(stockOf(product.id), -2);
  await api('PUT', '/api/settings', { allow_negative_stock: false }, 'admin');
});

test('Rule 5: creating a product with an existing name is blocked unless forced', async () => {
  const product = await makeProduct({ name: 'Duplicate Guard Test', opening_stock: 0 });
  const again = await api('POST', '/api/products', { name: 'Duplicate Guard Test' }, 'admin');
  assert.equal(again.status, 409);
  assert.equal(again.body.details.existingId, product.id);
  const forced = await api('POST', '/api/products', { name: 'Duplicate Guard Test', force: true }, 'admin');
  assert.equal(forced.status, 201);
});

test('Rule 6: HSN and GST flow from the product master onto the invoice', async () => {
  const product = await makeProduct({ hsn_code: '84713010', gst_rate: 18, opening_stock: 2, selling_price: 50000 });
  const invoice = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  const item = invoice.body.items[0];
  assert.equal(item.hsn_code, '84713010');
  assert.equal(item.gst_rate, 18);
  assert.equal(item.unit_price, 50000, 'selling price is taken from the product master');
});

test('Staff cannot change settings or products, but can sell', async () => {
  const product = await makeProduct({ opening_stock: 5 });
  assert.equal((await api('PUT', '/api/settings', { name: 'Hacked' }, 'staff')).status, 403);
  assert.equal((await api('POST', '/api/products', { name: 'Staff Product' }, 'staff')).status, 403);
  assert.equal((await api('POST', '/api/inventory/adjust',
    { product_id: product.id, qty: -1, reason: 'LOST' }, 'staff')).status, 403);
  const sale = await api('POST', '/api/invoices',
    { items: [{ product_id: product.id, qty: 1 }], status: 'ISSUED' }, 'staff');
  assert.equal(sale.status, 201);
});

test('Unauthenticated API calls are rejected', async () => {
  assert.equal((await api('GET', '/api/products')).status, 401);
  assert.equal((await api('GET', '/api/analytics/dashboard')).status, 401);
});
