'use strict';
/**
 * Regression tests for the production review: serial-number integrity,
 * who is allowed to do what, and the crashes behind a few 500s.
 * Every test here fails on the code as it stood before these fixes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { start, stop, api, db, stockOf, makeProduct, tokens, url } = require('./helpers');

test.after(stop);
test.before(start);

/** A product that tracks serials, with `count` serials booked into stock. */
async function serialProduct(count = 2, overrides = {}) {
  const product = await makeProduct({ serial_tracked: true, opening_stock: 0, ...overrides });
  const serials = Array.from({ length: count }, (_, i) => `SN-${product.id}-${i + 1}`);
  const res = await api('POST', '/api/inventory/add-stock',
    { product_id: product.id, qty: count, serials }, 'admin');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { product, serials };
}

const statusOf = (serial) => db.prepare('SELECT * FROM serial_numbers WHERE serial = ?').get(serial);

// ---------- 1. A draft with serials can be saved again and issued ----------

test('a draft with serial numbers can be re-saved, edited and issued', async () => {
  const { product, serials } = await serialProduct(2);
  const draft = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  assert.equal(draft.status, 201);
  const invoiceId = draft.body.invoice.id;

  const picked = await api('POST', `/api/invoices/${invoiceId}/serials`,
    { item_id: draft.body.items[0].id, serials: [serials[0]] }, 'admin');
  assert.equal(picked.status, 200, JSON.stringify(picked.body));

  // Saving the draft again used to fail on a foreign key, which left the
  // invoice impossible to edit or issue from the screen.
  const resaved = await api('PUT', `/api/invoices/${invoiceId}`,
    { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  assert.deepEqual(resaved.body.items[0].serials, [serials[0]], 'the chosen serial survives the save');

  const issued = await api('POST', `/api/invoices/${invoiceId}/issue`, {}, 'admin');
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(statusOf(serials[0]).status, 'SOLD');
  assert.equal(statusOf(serials[1]).status, 'AVAILABLE');
});

// ---------- 9 & 10. Serial reservations are exclusive, and are honoured ----------

test('two drafts cannot reserve the same serial number', async () => {
  const { product, serials } = await serialProduct(1);
  const first = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  const second = await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  const ok = await api('POST', `/api/invoices/${first.body.invoice.id}/serials`,
    { item_id: first.body.items[0].id, serials: [serials[0]] }, 'admin');
  assert.equal(ok.status, 200);

  const clash = await api('POST', `/api/invoices/${second.body.invoice.id}/serials`,
    { item_id: second.body.items[0].id, serials: [serials[0]] }, 'admin');
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.match(clash.body.error, /already reserved/i);

  // The first invoice keeps its unit.
  const reload = await api('GET', `/api/invoices/${first.body.invoice.id}`, undefined, 'admin');
  assert.deepEqual(reload.body.items[0].serials, [serials[0]]);
});

test('serial numbers sent when the invoice is created are actually reserved', async () => {
  const { product, serials } = await serialProduct(2);
  const created = await api('POST', '/api/invoices', {
    status: 'ISSUED', items: [{ product_id: product.id, qty: 2, serials }],
  }, 'admin');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const serial of serials) assert.equal(statusOf(serial).status, 'SOLD', `${serial} should be sold`);
  assert.deepEqual(created.body.items[0].serials.sort(), [...serials].sort());
});

// ---------- 3. Issuing keeps serials and stock in step ----------

test('issuing a serial-tracked line always accounts for the units that left', async () => {
  const { product, serials } = await serialProduct(2);
  const before = stockOf(product.id);
  // No serials chosen at all: stock used to fall while every serial stayed available.
  const issued = await api('POST', '/api/invoices',
    { status: 'ISSUED', items: [{ product_id: product.id, qty: 1 }] }, 'admin');
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(stockOf(product.id), before - 1);

  const sold = serials.filter((s) => statusOf(s).status === 'SOLD');
  assert.equal(sold.length, 1, 'exactly one serial is marked sold');
  const available = db.prepare(
    "SELECT COUNT(*) AS n FROM serial_numbers WHERE product_id = ? AND status = 'AVAILABLE'",
  ).get(product.id).n;
  assert.equal(available, stockOf(product.id), 'serial count matches stock');
});

test('a serial-tracked line cannot be issued when there are not enough serials', async () => {
  const { product } = await serialProduct(1);
  const res = await api('POST', '/api/invoices',
    { status: 'ISSUED', items: [{ product_id: product.id, qty: 2 }] }, 'admin');
  assert.equal(res.status, 409, JSON.stringify(res.body));
});

// ---------- 2 & 3 (auth). Tokens and live accounts ----------

test('login tokens are not signed with a secret from the source code', () => {
  const forged = (secret) => {
    const body = Buffer.from(JSON.stringify({ id: 1, role: 'ADMIN', exp: Date.now() + 60000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  };
  const { verifyToken } = require('../server/lib/auth');
  assert.equal(verifyToken(forged('cbms-dev-secret-change-me')), null, 'the old built-in secret must not work');
  assert.ok(verifyToken(forged('test-secret')), 'the configured secret still works');
});

test('the server refuses to run in production without SESSION_SECRET', () => {
  const env = { ...process.env, NODE_ENV: 'production', DATA_DIR: path.join(os.tmpdir(), `cbms-prod-${Date.now()}`) };
  delete env.SESSION_SECRET;
  delete env.DB_FILE;
  let failed = false;
  try {
    execFileSync(process.execPath, ['-e', "require('./server/lib/auth')"], { env, stdio: 'pipe' });
  } catch (err) {
    failed = true;
    assert.match(String(err.stderr), /SESSION_SECRET must be set in production/);
  }
  assert.ok(failed, 'starting without a session secret in production should stop the server');
});

test('switching an account off ends its access at once', async () => {
  const created = await api('POST', '/api/users',
    { name: 'Temp Staff', email: 'temp@test.local', password: 'temp123', role: 'STAFF' }, 'admin');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const login = await api('POST', '/api/auth/login', { email: 'temp@test.local', password: 'temp123' });
  tokens.temp = login.body.token;

  assert.equal((await api('GET', '/api/products', undefined, 'temp')).status, 200);
  await api('PUT', `/api/users/${created.body.user.id}`, { active: false }, 'admin');
  const after = await api('GET', '/api/products', undefined, 'temp');
  assert.equal(after.status, 401, 'a disabled account cannot keep using its token');
});

test('demoting an admin takes effect on the next request', async () => {
  const created = await api('POST', '/api/users',
    { name: 'Second Owner', email: 'second@test.local', password: 'owner123', role: 'ADMIN' }, 'admin');
  const login = await api('POST', '/api/auth/login', { email: 'second@test.local', password: 'owner123' });
  tokens.second = login.body.token;
  assert.equal((await api('GET', '/api/reports', undefined, 'second')).status, 200);

  await api('PUT', `/api/users/${created.body.user.id}`, { role: 'STAFF' }, 'admin');
  const after = await api('GET', '/api/reports', undefined, 'second');
  assert.equal(after.status, 403, 'the role comes from the account, not the token');
});

// ---------- 4, 5, 6. HSN ----------

test('staff asking for the HSN summary are refused, not met with a crash', async () => {
  const res = await api('GET', '/api/hsn', undefined, 'staff');
  assert.equal(res.status, 403, JSON.stringify(res.body));
});

test('the HSN summary uses each line’s own GST and leaves out drafts and returns', async () => {
  const product = await makeProduct({ hsn_code: '99990001', gst_rate: 28, selling_price: 100, opening_stock: 10 });
  const issued = await api('POST', '/api/invoices',
    { status: 'ISSUED', items: [{ product_id: product.id, qty: 2 }] }, 'admin');
  assert.equal(issued.status, 201);
  // A draft must not show up in a GST return.
  await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 5 }] }, 'admin');
  // One unit comes back.
  const ret = await api('POST', '/api/returns', {
    invoice_id: issued.body.invoice.id,
    items: [{ invoice_item_id: issued.body.items[0].id, qty: 1 }],
  }, 'admin');
  assert.equal(ret.status, 201, JSON.stringify(ret.body));

  const { hsn } = (await api('GET', '/api/hsn', undefined, 'admin')).body;
  const row = hsn.find((r) => r.hsn_code === '99990001');
  assert.ok(row, 'the code appears in the summary');
  assert.equal(row.qty_sold, 1, 'the returned unit is off the figures and the draft never counted');
  assert.equal(row.taxable_amount, 100);
  assert.equal(row.total_gst, 28, '28% GST, not an assumed 18%');
  assert.equal(row.cgst, 14);
  assert.equal(row.sgst, 14);
});

test('an HSN code that is not in the master list opens instead of crashing', async () => {
  const res = await api('GET', '/api/hsn/00000000', undefined, 'admin');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.hsn.code, '00000000');
  assert.deepEqual(res.body.products, []);
  assert.deepEqual(res.body.sales, []);
});

// ---------- 7. Deleting a user ----------

test('a user who appears in the books cannot be deleted, and is told why', async () => {
  const created = await api('POST', '/api/users',
    { name: 'Busy Staff', email: 'busy@test.local', password: 'busy123', role: 'ADMIN' }, 'admin');
  const id = created.body.user.id;
  const login = await api('POST', '/api/auth/login', { email: 'busy@test.local', password: 'busy123' });
  tokens.busy = login.body.token;
  const product = await makeProduct({ opening_stock: 5 });
  await api('POST', '/api/invoices', { status: 'ISSUED', items: [{ product_id: product.id, qty: 1 }] }, 'busy');

  const res = await api('DELETE', `/api/users/${id}`, undefined, 'admin');
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /record\(s\) in the books/);
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(id), 'the account is still there');
});

test('a user with no history can still be deleted, but not their own account', async () => {
  const created = await api('POST', '/api/users',
    { name: 'Never Used', email: 'unused@test.local', password: 'unused123', role: 'STAFF' }, 'admin');
  assert.equal((await api('DELETE', `/api/users/${created.body.user.id}`, undefined, 'admin')).status, 200);

  const me = db.prepare("SELECT id FROM users WHERE email = 'owner@test.local'").get();
  const self = await api('DELETE', `/api/users/${me.id}`, undefined, 'admin');
  assert.equal(self.status, 409);
});

// ---------- 8. Deleting customers and suppliers ----------

test('only the owner can delete a customer or supplier', async () => {
  const customer = (await api('POST', '/api/customers', { name: 'Deletable Customer' }, 'admin')).body.record;
  const staffTry = await api('DELETE', `/api/customers/${customer.id}`, undefined, 'staff');
  assert.equal(staffTry.status, 403, JSON.stringify(staffTry.body));
  assert.ok(db.prepare('SELECT id FROM customers WHERE id = ?').get(customer.id), 'still there');
  assert.equal((await api('DELETE', `/api/customers/${customer.id}`, undefined, 'admin')).status, 200);
});

// ---------- 11. A full return is a cancellation in disguise ----------

test('staff who may not cancel cannot refund a whole invoice', async () => {
  const product = await makeProduct({ opening_stock: 10, selling_price: 500 });
  const issued = await api('POST', '/api/invoices',
    { status: 'ISSUED', items: [{ product_id: product.id, qty: 2 }] }, 'admin');
  const itemId = issued.body.items[0].id;

  const whole = await api('POST', '/api/returns',
    { invoice_id: issued.body.invoice.id, items: [{ invoice_item_id: itemId, qty: 2 }] }, 'staff');
  assert.equal(whole.status, 403, JSON.stringify(whole.body));
  assert.match(whole.body.error, /Cancel invoices/);

  // A genuine partial return is still part of the counter's job.
  const part = await api('POST', '/api/returns',
    { invoice_id: issued.body.invoice.id, items: [{ invoice_item_id: itemId, qty: 1 }] }, 'staff');
  assert.equal(part.status, 201, JSON.stringify(part.body));

  // The last remaining unit would now empty the invoice, so it is barred too.
  const rest = await api('POST', '/api/returns',
    { invoice_id: issued.body.invoice.id, items: [{ invoice_item_id: itemId, qty: 1 }] }, 'staff');
  assert.equal(rest.status, 403);
  assert.equal((await api('POST', '/api/returns',
    { invoice_id: issued.body.invoice.id, items: [{ invoice_item_id: itemId, qty: 1 }] }, 'admin')).status, 201);
});

// ---------- 12. Purchase prices follow the "costs" switch ----------

test('staff cannot read purchase prices or margins anywhere', async () => {
  const product = await makeProduct({ purchase_price: 4242, selling_price: 9999, opening_stock: 4 });
  const invoice = await api('POST', '/api/invoices',
    { status: 'ISSUED', items: [{ product_id: product.id, qty: 1 }] }, 'admin');

  const list = await api('GET', '/api/products', undefined, 'staff');
  assert.ok(list.body.products.length);
  for (const row of list.body.products) assert.ok(!('purchase_price' in row), 'the product list hides cost');

  const detail = await api('GET', `/api/products/${product.id}`, undefined, 'staff');
  assert.ok(!('purchase_price' in detail.body.product));
  assert.deepEqual(detail.body.purchases, [], 'no supplier price history');
  assert.ok(!('stockValue' in detail.body.stats));
  for (const m of detail.body.movements) assert.ok(!('unit_cost' in m));

  const inv = await api('GET', `/api/invoices/${invoice.body.invoice.id}`, undefined, 'staff');
  for (const item of inv.body.items) assert.ok(!('cost_price' in item), 'invoice lines hide cost');

  assert.equal((await api('GET', '/api/purchases', undefined, 'staff')).status, 403);
  assert.equal((await api('GET', '/api/purchases/1', undefined, 'staff')).status, 403);

  // The owner still sees everything.
  const owner = await api('GET', `/api/products/${product.id}`, undefined, 'admin');
  assert.equal(owner.body.product.purchase_price, 4242);
  assert.equal((await api('GET', '/api/purchases', undefined, 'admin')).status, 200);
});

// ---------- 13. Stock adjustments stay on their own product ----------

test('a stock adjustment cannot touch another product’s serial, or a sold one', async () => {
  const mine = await serialProduct(2);
  const other = await serialProduct(1);

  const wrongProduct = await api('POST', '/api/inventory/adjust', {
    product_id: mine.product.id, reason: 'DAMAGED', qty: -1, serials: [other.serials[0]],
  }, 'admin');
  assert.equal(wrongProduct.status, 422, JSON.stringify(wrongProduct.body));
  assert.equal(statusOf(other.serials[0]).status, 'AVAILABLE');

  await api('POST', '/api/invoices',
    { status: 'ISSUED', items: [{ product_id: mine.product.id, qty: 1, serials: [mine.serials[0]] }] }, 'admin');
  assert.equal(statusOf(mine.serials[0]).status, 'SOLD');

  const soldUnit = await api('POST', '/api/inventory/adjust', {
    product_id: mine.product.id, reason: 'CORRECTION', qty: 1, serials: [mine.serials[0]],
  }, 'admin');
  assert.equal(soldUnit.status, 409, JSON.stringify(soldUnit.body));
  assert.equal(statusOf(mine.serials[0]).status, 'SOLD', 'a sold unit stays sold');

  // A serial that really is this product's own is still adjustable.
  const ok = await api('POST', '/api/inventory/adjust', {
    product_id: mine.product.id, reason: 'DAMAGED', qty: -1, serials: [mine.serials[1]],
  }, 'admin');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(statusOf(mine.serials[1]).status, 'DAMAGED');
});
