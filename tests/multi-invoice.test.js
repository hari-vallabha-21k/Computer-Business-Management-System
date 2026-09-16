'use strict';
/**
 * Reading several supplier invoices in one go, including Excel workbooks,
 * and turning what was read into products.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, api, db, stockOf, makeProduct, tokens, url } = require('./helpers');
const { extractPurchaseInvoice } = require('../server/lib/extract');
const { workbookToText, readWorkbook } = require('../server/lib/xlsx');

test.before(start);
test.after(stop);

const INVOICE_A = [
  'ABC Computers',
  'GSTIN: 27AAACA1111A1Z5',
  'Invoice No: ABC/26-27/1024',
  'Invoice Date: 10/09/2026',
  'Description | HSN | Qty | Rate',
  'Zephyr Ultrabook X1 | 84713010 | 3 | 42000',
  'Zephyr Wireless Mouse | 84716060 | 10 | 450',
].join('\n');

const INVOICE_B = [
  'Prime Distributors',
  'Invoice No: PD/2026/5512',
  'Invoice Date: 12/09/2026',
  'Description | HSN | Qty | Rate',
  'Zephyr NVMe 1TB | 85235290 | 5 | 5100',
].join('\n');

/** Build a minimal but valid .xlsx in memory (stored entries, no compression). */
function buildXlsx(rows) {
  const cell = (value, col, rowNumber) => {
    const ref = `${String.fromCharCode(65 + col)}${rowNumber}`;
    return typeof value === 'number'
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
  };
  const sheetRows = rows.map((row, i) => {
    const cells = row.map((v, c) => (v === '' ? '' : cell(v, c, i + 1))).join('');
    return `<row r="${i + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ];

  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

async function upload(files) {
  const form = new FormData();
  for (const [name, content, type] of files) {
    form.append('files', new Blob([content], { type: type || 'text/plain' }), name);
  }
  const res = await fetch(url('/api/purchases/extract'), {
    method: 'POST', headers: { authorization: `Bearer ${tokens.admin}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('several invoices are read in one upload', async () => {
  const res = await upload([['abc.txt', INVOICE_A], ['prime.csv', INVOICE_B]]);
  assert.equal(res.status, 200);
  assert.equal(res.body.fileCount, 2);
  assert.equal(res.body.readCount, 2);
  assert.equal(res.body.itemCount, 3);
  assert.equal(res.body.results.length, 2);
  assert.equal(res.body.results[0].fileName, 'abc.txt');
  assert.equal(res.body.results[0].header.invoiceNo, 'ABC/26-27/1024');
  assert.equal(res.body.results[1].items[0].description, 'Zephyr NVMe 1TB');
});

test('an unreadable file among several does not stop the others', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const res = await upload([['abc.txt', INVOICE_A], ['photo.png', png, 'image/png']]);
  assert.equal(res.body.fileCount, 2);
  assert.equal(res.body.readCount, 1);
  const failed = res.body.results.find((r) => !r.ok);
  assert.equal(failed.reason, 'IMAGE_NO_TEXT_LAYER');
  assert.match(failed.message, /manually/);
});

test('a single upload keeps the original response shape', async () => {
  const form = new FormData();
  form.append('file', new Blob([INVOICE_A], { type: 'text/plain' }), 'abc.txt');
  const res = await fetch(url('/api/purchases/extract'), {
    method: 'POST', headers: { authorization: `Bearer ${tokens.admin}` }, body: form,
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 2, 'items are still at the top level');
  assert.equal(body.results.length, 1);
});

test('an Excel invoice is read like any other', async () => {
  const xlsx = buildXlsx([
    ['Tech Wholesale Pvt Ltd'],
    ['GSTIN: 36AAACT9999T1Z5'],
    ['Invoice No.', '', 'TW/0926/0142'],
    ['Invoice Date', '', '2026-09-11'],
    [],
    ['#', 'Item & Description', 'HSN', 'Qty', 'Rate', 'Total Incl GST'],
    [1, 'Excel Scan Keyboard', '84716060', 4, 900, 3600],
    [2, 'Excel Scan Monitor', '85285900', 2, 8300, 16600],
    ['', 'Sub Total', '', '', '', 20200],
  ]);

  const sheets = readWorkbook(xlsx);
  assert.equal(sheets.length, 1);
  const text = workbookToText(xlsx);
  assert.match(text, /Excel Scan Keyboard/);

  const result = await extractPurchaseInvoice(xlsx, 'wholesale.xlsx');
  assert.equal(result.ok, true);
  assert.equal(result.header.invoiceNo, 'TW/0926/0142');
  assert.equal(result.header.invoiceDate, '2026-09-11');
  assert.equal(result.header.supplierGstin, '36AAACT9999T1Z5');
  assert.equal(result.items.length, 2, 'the Sub Total row is not an item');
  assert.equal(result.items[0].description, 'Excel Scan Keyboard');
  assert.equal(result.items[0].qty, 4);
  assert.equal(result.items[0].unitPrice, 900, '"Rate" is the unit price, not "Total Incl GST"');
  assert.equal(result.items[1].hsn, '85285900');
});

test('reviewed invoice lines can be created as products in bulk', async () => {
  await makeProduct({ name: 'Bulk Existing Product', opening_stock: 0 });
  const res = await api('POST', '/api/products/bulk', {
    items: [
      { name: 'Bulk New Laptop', category: 'Laptops', brand: 'Dell', hsn_code: '84713010', gst_rate: 18, purchase_price: 42000, selling_price: 48300 },
      { name: 'Bulk New Mouse', category: 'Accessories', hsn_code: '84716060', gst_rate: 18, purchase_price: 450, selling_price: 520 },
      { name: 'Bulk Existing Product', purchase_price: 100 },
    ],
  }, 'admin');

  assert.equal(res.status, 201);
  assert.equal(res.body.createdCount, 2);
  assert.equal(res.body.skippedCount, 1);
  assert.equal(res.body.skipped[0].reason, 'ALREADY_EXISTS');

  const laptop = db.prepare('SELECT * FROM products WHERE name = ?').get('Bulk New Laptop');
  assert.equal(laptop.purchase_price, 42000);
  assert.equal(laptop.selling_price, 48300);
  assert.equal(laptop.stock, 0, 'creating a product does not invent stock');
  assert.equal(db.prepare('SELECT code FROM hsn_codes WHERE id = ?').get(laptop.hsn_id).code, '84713010');
});

test('staff cannot bulk-create products', async () => {
  const res = await api('POST', '/api/products/bulk', { items: [{ name: 'Staff Bulk Product' }] }, 'staff');
  assert.equal(res.status, 403);
});

test('scanned invoices can be booked in as one purchase each', async () => {
  const scan = await upload([['abc.txt', INVOICE_A], ['prime.csv', INVOICE_B]]);
  const before = db.prepare('SELECT COUNT(*) AS n FROM purchases').get().n;

  for (const result of scan.body.results) {
    const res = await api('POST', '/api/purchases', {
      supplier_name: result.header.supplier,
      supplier_invoice_no: result.header.invoiceNo,
      invoice_date: result.header.invoiceDate,
      source: 'SCAN',
      file_name: result.fileName,
      items: result.items.map((item) => ({
        product_id: item.match ? item.match.productId : undefined,
        description: item.description,
        hsn_code: item.hsn,
        qty: item.qty,
        unit_price: item.unitPrice,
        gst_rate: item.gstRate ?? 18,
        new_product: item.match ? undefined : { name: item.description, hsn_code: item.hsn },
      })),
    }, 'admin');
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, before + 2,
    'one purchase per invoice, not one merged purchase');
  const laptop = db.prepare('SELECT * FROM products WHERE name = ?').get('Zephyr Ultrabook X1');
  assert.equal(stockOf(laptop.id), 3);
  assert.equal(stockOf(db.prepare('SELECT id FROM products WHERE name = ?').get('Zephyr NVMe 1TB').id), 5);
});
