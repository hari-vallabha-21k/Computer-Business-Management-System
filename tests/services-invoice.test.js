'use strict';
/**
 * Services on invoices, CGST/SGST-only tax and the full sale flow:
 * create invoice -> add product and service -> add a new product mid-invoice ->
 * CGST/SGST -> issue -> stock falls for goods only -> PDF.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, db, stockOf, makeProduct, tokens, url } = require('./helpers');

test.after(stop);
test.before(async () => {
  await start();
  await api('PUT', '/api/settings', { gstin: '36AXIPK2327D1ZR', price_includes_gst: true }, 'admin');
});

const makeService = async (overrides = {}) => {
  const res = await api('POST', '/api/products', {
    name: `Test Service ${Math.random().toString(36).slice(2, 8)}`, item_type: 'SERVICE',
    hsn_code: '998713', gst_rate: 18, selling_price: 1180, opening_stock: 5, min_stock: 3, serial_tracked: true,
    ...overrides,
  }, 'admin');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.product;
};

test('a service is stored without stock, reorder level or serial tracking', async () => {
  const service = await makeService();
  assert.equal(service.item_type, 'SERVICE');
  assert.equal(service.stock, 0, 'opening stock is ignored for a service');
  assert.equal(service.min_stock, 0);
  assert.equal(service.serial_tracked, 0);
  assert.match(service.product_code, /^SRV-\d{3}$/);
  const moves = db.prepare('SELECT COUNT(*) AS n FROM inventory_transactions WHERE product_id = ?').get(service.id).n;
  assert.equal(moves, 0);
});

test('product lists keep goods and services apart', async () => {
  const service = await makeService({ name: 'Separate Listing Service' });
  const product = await makeProduct({ name: 'Separate Listing Product' });
  const goods = (await api('GET', '/api/products?q=Separate Listing', undefined, 'admin')).body.products;
  assert.deepEqual(goods.map((p) => p.id), [product.id], 'stock screens see products only');
  const services = (await api('GET', '/api/products?q=Separate Listing&type=SERVICE', undefined, 'admin')).body.products;
  assert.deepEqual(services.map((p) => p.id), [service.id]);
  const all = (await api('GET', '/api/products?q=Separate Listing&type=ALL', undefined, 'admin')).body.products;
  assert.equal(all.length, 2);
  const low = (await api('GET', '/api/inventory/low-stock', undefined, 'admin')).body.items;
  assert.ok(!low.some((p) => p.id === service.id), 'a service is never "out of stock"');
});

test('a service cannot be stocked', async () => {
  const service = await makeService();
  const res = await api('POST', '/api/inventory/add-stock', { product_id: service.id, qty: 2 }, 'admin');
  assert.equal(res.status, 422);
  assert.match(res.body.error, /service/i);
});

test('full flow: product + service + a product added mid-invoice, CGST/SGST, issue, stock and PDF', async () => {
  const laptop = await makeProduct({ name: 'Flow Laptop', selling_price: 55500, opening_stock: 4 });
  const service = await makeService({ name: 'Flow OS Installation', selling_price: 1180 });

  // The product is not in the list yet: "+ Add New Product" creates it without leaving the invoice.
  const search = (await api('GET', '/api/products?q=Flow Brand New Mouse', undefined, 'admin')).body.products;
  assert.equal(search.length, 0);
  const created = await makeProduct({ name: 'Flow Brand New Mouse', selling_price: 590, opening_stock: 6 });

  const draft = await api('POST', '/api/invoices', {
    items: [
      { product_id: laptop.id, qty: 1 },
      { product_id: service.id, qty: 1 },
      { product_id: created.id, qty: 2 },
    ],
  }, 'admin');
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const { invoice, items } = draft.body;
  assert.equal(items[1].item_type, 'SERVICE');
  assert.equal(items[1].hsn_code, '998713');
  assert.equal(items[1].taxable_value, 1000);
  assert.equal(items[1].gst_amount, 180);

  // 55,500 + 1,180 + 1,180 all GST-inclusive at 18%.
  assert.equal(invoice.total, 57860);
  assert.equal(invoice.igst, 0, 'IGST is never charged');
  assert.equal(invoice.cgst, invoice.sgst);
  assert.equal(Math.round((invoice.cgst + invoice.sgst) * 100) / 100, invoice.gst_amount);
  assert.equal(Math.round((invoice.subtotal + invoice.gst_amount) * 100) / 100, invoice.total);

  const before = { laptop: stockOf(laptop.id), mouse: stockOf(created.id), service: stockOf(service.id) };
  const issued = await api('POST', `/api/invoices/${invoice.id}/issue`, {}, 'admin');
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(stockOf(laptop.id), before.laptop - 1);
  assert.equal(stockOf(created.id), before.mouse - 2);
  assert.equal(stockOf(service.id), 0, 'a service sale leaves stock untouched');
  const serviceMoves = db.prepare('SELECT COUNT(*) AS n FROM inventory_transactions WHERE product_id = ?').get(service.id).n;
  assert.equal(serviceMoves, 0);

  // Services count as revenue on the dashboard.
  const dash = (await api('GET', `/api/analytics/dashboard?from=${invoice.invoice_date}&to=${invoice.invoice_date}`, undefined, 'admin')).body;
  assert.ok(dash.kpis.serviceRevenue >= 1000, 'service revenue is reported');
  assert.ok(dash.kpis.netRevenue >= dash.kpis.serviceRevenue);

  const res = await fetch(url(`/api/invoices/${invoice.id}/pdf`), { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.status, 200);
  const text = await require('../server/lib/extract').pdfText(Buffer.from(await res.arrayBuffer()));
  for (const expected of ['CGST (9%)', 'SGST (9%)', 'Flow OS Installation', '998713', 'Flow Brand New Mouse', 'HSN/SAC']) {
    assert.ok(text.includes(expected), `the PDF should contain "${expected}"`);
  }
  assert.ok(!/IGST/.test(text), 'the PDF has no IGST column');

  // Cancelling puts the goods back and leaves the service alone.
  const cancelled = await api('POST', `/api/invoices/${invoice.id}/cancel`, { reason: 'test' }, 'admin');
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(stockOf(laptop.id), before.laptop);
  assert.equal(stockOf(service.id), 0);
});

test('an invoice of only services issues with no stock at all', async () => {
  const service = await makeService({ selling_price: 500 });
  const res = await api('POST', '/api/invoices', { status: 'ISSUED', items: [{ product_id: service.id, qty: 3 }] }, 'admin');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.invoice.status, 'ISSUED');
  assert.equal(stockOf(service.id), 0);

  // Returning a service refunds it without restocking anything.
  const ret = await api('POST', '/api/returns', {
    invoice_id: res.body.invoice.id, items: [{ invoice_item_id: res.body.items[0].id, qty: 1 }],
  }, 'admin');
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal(stockOf(service.id), 0);
});

test('odd-paisa GST splits into CGST and SGST that add back exactly', async () => {
  const product = await makeProduct({ selling_price: 100.01, opening_stock: 5 });
  const { invoice } = (await api('POST', '/api/invoices', { items: [{ product_id: product.id, qty: 1 }] }, 'admin')).body;
  assert.equal(Math.round((invoice.cgst + invoice.sgst) * 100) / 100, invoice.gst_amount);
  const { splitGst } = require('../server/lib/gst');
  const { invoiceTaxSplit } = require('../server/lib/invoicedoc');
  assert.deepEqual(splitGst(15.27), [7.64, 7.63], 'the odd paisa goes to CGST');
  assert.deepEqual(invoiceTaxSplit([{ gst_amount: 1800 }]), [900, 900],
    'an invoice saved with IGST before the change is shown as CGST + SGST');
});

test('the PDF keeps at least eight item rows', () => {
  assert.equal(require('../server/lib/invoicedoc').MIN_ROWS, 8);
});

test('CGST and SGST columns add up to the Sub Total row (two lines of 1.01 GST each)', async () => {
  // GST-exclusive so each line's GST is exactly 1.01: 5.61 x 18% = 1.0098 -> 1.01.
  await api('PUT', '/api/settings', { price_includes_gst: false }, 'admin');
  try {
    const product = await makeProduct({ selling_price: 5.61, opening_stock: 5 });
    const res = await api('POST', '/api/invoices', {
      items: [{ product_id: product.id, qty: 1 }, { product_id: product.id, qty: 1, unit_price: 5.61 }],
    }, 'admin');
    const { invoice, items } = res.body;
    assert.deepEqual(items.map((i) => i.gst_amount), [1.01, 1.01]);

    const { splitGst } = require('../server/lib/gst');
    const rows = items.map((i) => splitGst(i.gst_amount));
    assert.deepEqual(rows, [[0.51, 0.5], [0.51, 0.5]]);
    assert.equal(invoice.cgst, 1.02, 'saved CGST is the sum of the CGST column');
    assert.equal(invoice.sgst, 1.0, 'saved SGST is the sum of the SGST column');
    assert.equal(Math.round((invoice.cgst + invoice.sgst) * 100) / 100, invoice.gst_amount);

    const { invoiceTaxSplit } = require('../server/lib/invoicedoc');
    assert.deepEqual(invoiceTaxSplit(items), [1.02, 1.0], 'the PDF Sub Total row matches the columns');

    const pdf = await fetch(url(`/api/invoices/${invoice.id}/pdf`), { headers: { authorization: `Bearer ${tokens.admin}` } });
    const text = await require('../server/lib/extract').pdfText(Buffer.from(await pdf.arrayBuffer()));
    assert.ok(text.includes('1.02') && text.includes('0.51') && text.includes('0.50'));
  } finally {
    await api('PUT', '/api/settings', { price_includes_gst: true }, 'admin');
  }
});
