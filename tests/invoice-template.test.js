'use strict';
/**
 * The supplied invoice template is the reference for these numbers: a GST-inclusive rate of 55,500 x 2 prints as 1,11,000 incl GST,
 * 94,067.80 taxable and 8,466.10 each of CGST and SGST.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, makeProduct, tokens, url } = require('./helpers');
const { rupeesInWords, inWords } = require('../server/lib/numberwords');
const { placeOfSupply } = require('../server/lib/states');
const { formatNumber } = require('../server/db');

test.after(stop);

test.before(async () => {
  await start();
  await api('PUT', '/api/settings', {
    name: 'Thirumala Computer Services',
    gstin: '36AXIPK2327D1ZR',
    price_includes_gst: true,
    invoice_no_format: 'TCS/{MM}{YY}/{SEQ4}',
    default_payment_terms: 'Due on Receipt',
    bank_account_name: 'Thirumala Computer Services',
    bank_account_no: '50200000000000',
    bank_branch_ifsc: 'Moulali, HDFC0000000',
  }, 'admin');
});

test('GST-inclusive rates match the template arithmetic', async () => {
  const laptop = await makeProduct({
    name: 'Dell Latitude 3550 LAPTOP', hsn_code: '84713010', gst_rate: 18,
    purchase_price: 48000, selling_price: 55500, opening_stock: 5,
  });
  const bag = await makeProduct({
    name: 'Dell Carry Case', hsn_code: '42029200', gst_rate: 18,
    purchase_price: 700, selling_price: 1000, opening_stock: 5,
  });

  const res = await api('POST', '/api/invoices', {
    items: [{ product_id: laptop.id, qty: 2 }, { product_id: bag.id, qty: 2 }],
  }, 'admin');
  assert.equal(res.status, 201);
  const { invoice, items } = res.body;

  assert.equal(items[0].unit_price, 55500);
  assert.equal(items[0].total, 111000, 'total including GST is qty x rate');
  assert.equal(items[0].taxable_value, 94067.8);
  assert.equal(items[0].gst_amount, 16932.2);
  assert.equal(items[1].total, 2000);
  assert.equal(items[1].taxable_value, 1694.92);

  // The template's Sub Total row: 1,13,000 incl GST, 95,762.71 taxable,
  // 8,618.64 CGST and the same SGST (per-line rounding puts us a paisa above).
  assert.equal(invoice.total, 113000, 'the customer pays the quoted price');
  assert.equal(invoice.subtotal, 95762.72);
  assert.equal(invoice.cgst, 8618.64);
  assert.equal(invoice.sgst, 8618.64);
  assert.equal(invoice.igst, 0);
  assert.equal(invoice.gst_amount, 17237.28);
});

test('an invoice carries terms, due date, place of supply and ship-to', async () => {
  const product = await makeProduct({ opening_stock: 4, selling_price: 5000 });
  const customer = (await api('POST', '/api/customers', {
    name: 'Skyline Auto Components Pvt Ltd',
    address: '2nd Floor, SBI Colony, Gandhi Nagar, Secunderabad, Hyderabad, Telangana, 500080',
    shipping_address: 'Phase II, IDA, Cherlapally, Hyderabad 500051',
    gstin: '36AAACS1234A1Z5',
  }, 'admin')).body.record;

  const res = await api('POST', '/api/invoices', {
    customer_id: customer.id,
    invoice_date: '2026-08-14',
    payment_terms: 'Net 30',
    items: [{ product_id: product.id, qty: 1 }],
    product_brief: '1. Intel Core i3-13100, 8GB DDR5, 512GB SSD, Win11',
  }, 'admin');

  const { invoice } = res.body;
  assert.equal(invoice.payment_terms, 'Net 30');
  assert.equal(invoice.due_date, '2026-09-13', 'Net 30 is 30 days after the invoice date');
  assert.equal(invoice.place_of_supply, 'Telangana(36)');
  assert.equal(invoice.ship_to_address, 'Phase II, IDA, Cherlapally, Hyderabad 500051');
  assert.equal(invoice.customer_gstin, '36AAACS1234A1Z5');
  assert.match(invoice.product_brief, /Intel Core i3-13100/);
  assert.match(invoice.invoice_no, /^TCS\/\d{4}\/\d{4}$/, 'numbering follows the configured format');
});

test('an out-of-state customer is still billed CGST + SGST, never IGST', async () => {
  const product = await makeProduct({ opening_stock: 4, selling_price: 11800, gst_rate: 18 });
  const customer = (await api('POST', '/api/customers', {
    name: 'Mumbai Buyer Pvt Ltd', gstin: '27AABCS1429B1ZX',
  }, 'admin')).body.record;
  const { invoice } = (await api('POST', '/api/invoices', {
    customer_id: customer.id, items: [{ product_id: product.id, qty: 1 }],
  }, 'admin')).body;

  assert.equal(invoice.total, 11800);
  assert.equal(invoice.igst, 0);
  assert.equal(invoice.cgst, 900);
  assert.equal(invoice.sgst, 900);
  assert.equal(invoice.place_of_supply, 'Maharashtra(27)');
});

test('the template PDF renders with the template blocks', async () => {
  const product = await makeProduct({ opening_stock: 3, selling_price: 55500, serial_tracked: true });
  await api('POST', '/api/inventory/serials', { product_id: product.id, serials: ['5GSZ4C4', '4HSZ4C4'] }, 'admin');
  const created = await api('POST', '/api/invoices', {
    items: [{ product_id: product.id, qty: 2 }],
    product_brief: 'Intel Core i3-13100, 8GB DDR5, 512GB SSD, 15.6" FHD, Win11, MS Office',
  }, 'admin');
  const id = created.body.invoice.id;
  await api('POST', `/api/invoices/${id}/serials`,
    { item_id: created.body.items[0].id, serials: ['5GSZ4C4', '4HSZ4C4'] }, 'admin');
  await api('POST', `/api/invoices/${id}/issue`, {}, 'admin');

  const res = await fetch(url(`/api/invoices/${id}/pdf`), { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.status, 200);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');

  // Read the generated PDF back with our own extractor and check every block.
  const { pdfText } = require('../server/lib/extract');
  const text = await pdfText(pdf);
  for (const expected of [
    'Thirumala Computer Services', 'GSTIN 36AXIPK2327D1ZR',
    'Invoice No.', 'Invoice Date', 'Terms', 'Due Date', 'Place Of Supply',
    'Bill To', 'Ship To', 'Item & Description', 'HSN', 'Total', 'Incl', 'Taxable', 'Amount',
    'CGST (9%)', 'SGST (9%)', 'Sub Total', 'Items Total', 'Product Brief',
    'Total In words', 'Rupees One Lakh Eleven Thousand Only',
    'Bank Details', 'Account Name : Thirumala Computer Services', 'A/c No', 'Br & IFSC',
    'For Thirumala Computer Services', 'Authorized Signatory', 'Declaration',
    '1,11,000.00', '94,067.80', '8,466.10', '5GSZ4C4',
  ]) {
    assert.ok(text.includes(expected), `the PDF should contain "${expected}"`);
  }
});

test('amounts are written out in Indian numbering', () => {
  assert.equal(inWords(113000), 'One Lakh Thirteen Thousand');
  assert.equal(rupeesInWords(113000), 'Rupees One Lakh Thirteen Thousand Only');
  assert.equal(rupeesInWords(1234567.5), 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only');
  assert.equal(rupeesInWords(0), 'Rupees Zero Only');
  assert.equal(inWords(10000000), 'One Crore');
});

test('place of supply resolves from the GSTIN state code', () => {
  assert.equal(placeOfSupply('36'), 'Telangana(36)');
  assert.equal(placeOfSupply('27'), 'Maharashtra(27)');
  assert.equal(placeOfSupply('99'), 'Centre Jurisdiction(99)');
  assert.equal(placeOfSupply(''), '');
});

test('invoice numbering honours the configured format', () => {
  assert.equal(formatNumber('TCS/{MM}{YY}/{SEQ4}', 'TCS', 53).length, 'TCS/0826/0053'.length);
  assert.match(formatNumber('TCS/{MM}{YY}/{SEQ4}', 'TCS', 53), /^TCS\/\d{4}\/0053$/);
  assert.equal(formatNumber('{PREFIX}-{SEQ}', 'INV', 1001), 'INV-1001');
  assert.match(formatNumber('{PREFIX}/{FY}/{SEQ3}', 'INV', 7), /^INV\/\d{2}-\d{2}\/007$/);
});
