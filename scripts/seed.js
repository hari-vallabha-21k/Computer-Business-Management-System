'use strict';
/**
 * Demo data: a small computer store with products, stock, customers,
 * suppliers, issued invoices and a return, so the dashboard has something
 * to show on a fresh install.
 */
const { db, tx } = require('../server/db');
const { createUser } = require('../server/lib/auth');
const inv = require('../server/lib/inventory');

function reset() {
  const tables = ['return_items', 'sales_returns', 'invoice_items', 'invoices', 'purchase_items', 'purchases',
    'serial_numbers', 'inventory_transactions', 'notifications', 'products', 'hsn_codes', 'categories',
    'customers', 'suppliers', 'counters', 'users'];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence`);
  db.exec('PRAGMA foreign_keys = ON');
}

const HSN = [
  ['84713010', 'Laptops and portable computers', 18],
  ['84715000', 'Processing units / processors', 18],
  ['84733099', 'Computer parts and accessories', 18],
  ['85235290', 'Solid state storage devices', 18],
  ['84716060', 'Keyboards, mice and input devices', 18],
  ['85285900', 'Monitors and display units', 18],
];

const PRODUCTS = [
  ['LAP-001', 'Dell Inspiron 3530', 'Laptops', 'Dell', 'Inspiron 3530', '84713010', 44000, 52000, 3, 1, 8],
  ['LAP-002', 'HP Pavilion 14', 'Laptops', 'HP', 'Pavilion 14-dv', '84713010', 48000, 56500, 2, 1, 5],
  ['CPU-001', 'Intel Core i5-14400', 'Processors', 'Intel', 'Core i5-14400', '84715000', 18000, 21000, 4, 1, 12],
  ['CPU-002', 'AMD Ryzen 5 7600', 'Processors', 'AMD', 'Ryzen 5 7600', '84715000', 17500, 20500, 3, 1, 6],
  ['SSD-001', 'Samsung 980 SSD 1TB', 'Storage', 'Samsung', '980 NVMe 1TB', '85235290', 5200, 6500, 5, 1, 4],
  ['RAM-001', 'Kingston Fury 16GB DDR4', 'Components', 'Kingston', 'Fury Beast 16GB', '84733099', 3400, 4200, 6, 0, 9],
  ['MON-001', 'LG 24MK600 Monitor', 'Monitors', 'LG', '24MK600M', '85285900', 8200, 10500, 3, 0, 7],
  ['ACC-001', 'Logitech B170 Wireless Mouse', 'Accessories', 'Logitech', 'B170', '84716060', 520, 799, 10, 0, 3],
  ['ACC-002', 'TP-Link Archer C6 Router', 'Accessories', 'TP-Link', 'Archer C6', '84733099', 1650, 2299, 5, 0, 11],
];

const CUSTOMERS = [
  ['Rahul Kumar', '9876543210', 'rahul@example.com', '12 MG Road, Secunderabad, Hyderabad 500003', '', ''],
  ['Skyline Auto Components Pvt Ltd', '9820011223', 'accounts@skylineauto.example',
    '2nd Floor, SBI Colony, Gandhi Nagar, Secunderabad, Hyderabad, Telangana, 500080',
    '36AAACS1234A1Z5', 'Phase II, IDA, Cherlapally, Hyderabad 500051'],
  ['Priya Sharma', '9812345678', 'priya@example.com', '7 Lake View, Kompally, Hyderabad 500014', '', ''],
  ['Nova Tech Services', '9900112233', 'buy@novatech.example', 'IT Park, Madhapur, Hyderabad 500081',
    '27AAECN5522F1ZP', ''],
];

const SUPPLIERS = [
  ['ABC Computers', '9000011111', 'sales@abccomputers.example', 'Wholesale Market, Mumbai', '27AAACA1111A1Z5'],
  ['Prime Distributors', '9000022222', 'orders@primedist.example', 'Sector 18, Noida', '09AAACP2222B1Z3'],
  ['Techno Supplies', '9000033333', 'info@technosupplies.example', 'Ring Road, Nagpur', '27AAACT3333C1Z1'],
];

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function seed() {
  reset();
  const admin = createUser({ name: 'Business Owner', email: 'owner@example.com', password: 'owner123', role: 'ADMIN' });
  createUser({ name: 'Sales Staff', email: 'staff@example.com', password: 'staff123', role: 'STAFF' });

  db.prepare(`UPDATE business_settings SET name = ?, address = ?, phone = ?, email = ?, gstin = ?,
    state_code = '36', state_name = 'Telangana', invoice_prefix = 'TCS', upi_id = ?, qr_mode = 'INVOICE_INFO', terms = ?,
    bank_account_name = ?, bank_account_no = ?, bank_branch_ifsc = ?, signatory_name = ?,
    invoice_no_format = ?, default_payment_terms = 'Due on Receipt', price_includes_gst = 1
    WHERE id = 1`)
    .run('Thirumala Computer Services',
      'H.No 43-261/1, Hanuman Nagar, Moulali, Kapra, Hyderabad, Medchal Malkajgiri, 500040.',
      '+91 98765 43210', 'sales@thirumalacomputers.example', '36AXIPK2327D1ZR', 'thirumalacomputers@upi',
      '1. Goods warranty covers as per the manufacturer terms\n'
      + '2. Physical damage of product must be checked on arrival.\n'
      + '3. Warranty does not cover damage from electrical burning.',
      'Thirumala Computer Services', '50200000000000', 'Moulali, HDFC0000000',
      'Thirumala Computer Services', 'TCS/{MM}{YY}/{SEQ4}');

  for (const [code, description, rate] of HSN) {
    db.prepare('INSERT INTO hsn_codes (code, description, gst_rate) VALUES (?, ?, ?)').run(code, description, rate);
  }
  for (const [name, phone, email, address, gstin, shipping] of CUSTOMERS) {
    db.prepare(`INSERT INTO customers (name, phone, email, address, gstin, shipping_address, state_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(name, phone, email, address, gstin, shipping || '', gstin.slice(0, 2));
  }
  for (const [name, phone, email, address, gstin] of SUPPLIERS) {
    db.prepare('INSERT INTO suppliers (name, phone, email, address, gstin) VALUES (?, ?, ?, ?, ?)')
      .run(name, phone, email, address, gstin);
  }

  tx(() => {
    for (const [code, name, category, brand, model, hsn, cost, price, minStock, serialTracked, qty] of PRODUCTS) {
      let cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(category);
      if (!cat) cat = { id: Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(category).lastInsertRowid) };
      const hsnRow = db.prepare('SELECT * FROM hsn_codes WHERE code = ?').get(hsn);
      const id = Number(db.prepare(`
        INSERT INTO products (product_code, name, category_id, brand, model, hsn_id, gst_rate, purchase_price,
          selling_price, min_stock, serial_tracked, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(code, name, cat.id, brand, model, hsnRow.id, hsnRow.gst_rate, cost, price, minStock, serialTracked)
        .lastInsertRowid);

      if (serialTracked) {
        const serials = Array.from({ length: qty }, (_, i) => `${code.replace('-', '')}-${String(i + 1).padStart(4, '0')}`);
        inv.addSerials(id, serials);
      }
      inv.move({
        productId: id, type: 'OPENING', qty, unitCost: cost, referenceType: 'OPENING',
        referenceNo: 'OPENING', note: 'Opening stock', userId: admin.id,
      });
    }
  });

  // A handful of issued invoices spread over the last three weeks.
  const { issueInvoice } = require('../server/routes/invoices');
  const products = db.prepare('SELECT * FROM products').all();
  const pick = (code) => products.find((p) => p.product_code === code);
  const SALES = [
    [1, daysAgo(18), [['LAP-001', 1], ['ACC-001', 1]]],
    [2, daysAgo(15), [['CPU-001', 2], ['RAM-001', 2]]],
    [3, daysAgo(12), [['SSD-001', 1]]],
    [4, daysAgo(9), [['LAP-002', 1], ['MON-001', 1]]],
    [1, daysAgo(6), [['CPU-002', 1], ['RAM-001', 1]]],
    [2, daysAgo(4), [['ACC-002', 3], ['ACC-001', 2]]],
    [3, daysAgo(2), [['LAP-001', 1]]],
    [4, daysAgo(1), [['MON-001', 2], ['SSD-001', 1]]],
  ];

  const customers = db.prepare('SELECT * FROM customers ORDER BY id').all();
  const { lineTotals } = require('../server/lib/gst');
  const { placeOfSupply } = require('../server/lib/states');
  const business = db.prepare('SELECT * FROM business_settings WHERE id = 1').get();
  let counter = 52;
  for (const [customerIndex, date, lines] of SALES) {
    const customer = customers[customerIndex - 1];
    tx(() => {
      counter += 1;
      const invoiceNo = `TCS/${date.slice(5, 7)}${date.slice(2, 4)}/${String(counter).padStart(4, '0')}`;
      const invoiceId = Number(db.prepare(`
        INSERT INTO invoices (invoice_no, customer_id, invoice_date, status, payment_mode, created_by,
          payment_terms, due_date, place_of_supply, ship_to_name, ship_to_address, price_includes_gst)
        VALUES (?, ?, ?, 'DRAFT', 'CASH', ?, 'Due on Receipt', ?, ?, ?, ?, 1)`)
        .run(invoiceNo, customer.id, date, admin.id, date,
          placeOfSupply(customer.state_code || business.state_code), customer.name,
          customer.shipping_address || customer.address).lastInsertRowid);
      let subtotal = 0;
      let gst = 0;
      for (const [code, qty] of lines) {
        const p = pick(code);
        // Selling prices are GST-inclusive, as on the client's own invoices.
        const t = lineTotals({ qty, unitPrice: p.selling_price, gstRate: p.gst_rate, priceIncludesGst: true });
        const taxable = t.taxable;
        const gstAmount = t.gstAmount;
        subtotal += taxable;
        gst += gstAmount;
        const hsnCode = db.prepare('SELECT code FROM hsn_codes WHERE id = ?').get(p.hsn_id).code;
        const itemId = Number(db.prepare(`
          INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit_price, discount,
            gst_rate, gst_amount, taxable_value, total, cost_price)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
          .run(invoiceId, p.id, p.name, hsnCode, qty, p.selling_price, p.gst_rate, gstAmount, taxable,
            t.total, p.purchase_price).lastInsertRowid);
        if (p.serial_tracked) {
          const serials = db.prepare("SELECT id FROM serial_numbers WHERE product_id = ? AND status = 'AVAILABLE' LIMIT ?")
            .all(p.id, qty);
          for (const s of serials) db.prepare('UPDATE serial_numbers SET invoice_item_id = ? WHERE id = ?').run(itemId, s.id);
        }
      }
      db.prepare('UPDATE invoices SET subtotal = ?, gst_amount = ?, cgst = ?, sgst = ?, total = ? WHERE id = ?')
        .run(subtotal, gst, gst / 2, gst / 2, subtotal + gst, invoiceId);
      db.prepare("INSERT INTO counters (name, value) VALUES ('TCS', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
        .run(counter);
      issueInvoice(invoiceId, admin.id);
      db.prepare('UPDATE invoices SET invoice_date = ?, issued_at = ? WHERE id = ?').run(date, `${date} 11:00:00`, invoiceId);
    });
  }

  // One restocking purchase and one customer return.
  const supplier = db.prepare("SELECT id FROM suppliers WHERE name = 'ABC Computers'").get();
  tx(() => {
    const purchaseId = Number(db.prepare(`
      INSERT INTO purchases (purchase_no, supplier_id, supplier_invoice_no, invoice_date, status, source, subtotal, gst_amount, total, created_by)
      VALUES ('PUR-1001', ?, 'ABC/24-25/881', ?, 'CONFIRMED', 'MANUAL', 0, 0, 0, ?)`)
      .run(supplier.id, daysAgo(7), admin.id).lastInsertRowid);
    let subtotal = 0;
    for (const [code, qty] of [['SSD-001', 5], ['RAM-001', 10]]) {
      const p = pick(code);
      const taxable = p.purchase_price * qty;
      subtotal += taxable;
      db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, description, hsn_code, qty, unit_price, gst_rate, gst_amount, total)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`)
        .run(purchaseId, p.id, p.name, qty, p.purchase_price, p.gst_rate, taxable * p.gst_rate / 100,
          taxable * (1 + p.gst_rate / 100));
      if (p.serial_tracked) {
        const serials = Array.from({ length: qty }, (_, i) => `${code.replace('-', '')}-9${String(i + 1).padStart(3, '0')}`);
        inv.addSerials(p.id, serials, { purchaseId });
      }
      inv.move({
        productId: p.id, type: 'PURCHASE', qty, unitCost: p.purchase_price, referenceType: 'PURCHASE',
        referenceId: purchaseId, referenceNo: 'PUR-1001', userId: admin.id,
      });
    }
    db.prepare('UPDATE purchases SET subtotal = ?, gst_amount = ?, total = ? WHERE id = ?')
      .run(subtotal, subtotal * 0.18, subtotal * 1.18, purchaseId);
    db.prepare("INSERT INTO counters (name, value) VALUES ('PUR', 1001) ON CONFLICT(name) DO UPDATE SET value = 1001").run();
  });

  const lastInvoice = db.prepare("SELECT * FROM invoices WHERE status = 'ISSUED' ORDER BY id DESC LIMIT 1").get();
  const returnLine = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? LIMIT 1').get(lastInvoice.id);
  tx(() => {
    const returnId = Number(db.prepare(`
      INSERT INTO sales_returns (return_no, invoice_id, return_date, reason, total, restock, created_by)
      VALUES ('RET-1001', ?, ?, 'Customer changed their mind', ?, 1, ?)`)
      .run(lastInvoice.id, daysAgo(0), returnLine.total / returnLine.qty, admin.id).lastInsertRowid);
    db.prepare('INSERT INTO return_items (return_id, invoice_item_id, product_id, qty, amount) VALUES (?, ?, ?, 1, ?)')
      .run(returnId, returnLine.id, returnLine.product_id, returnLine.total / returnLine.qty);
    db.prepare('UPDATE invoice_items SET returned_qty = 1 WHERE id = ?').run(returnLine.id);
    db.prepare("INSERT INTO counters (name, value) VALUES ('RET', 1001) ON CONFLICT(name) DO UPDATE SET value = 1001").run();
    inv.move({
      productId: returnLine.product_id, type: 'RETURN', qty: 1, unitCost: returnLine.cost_price,
      referenceType: 'RETURN', referenceId: returnId, referenceNo: 'RET-1001',
      reason: 'CUSTOMER_RETURN', userId: admin.id,
    });
  });

  db.prepare('DELETE FROM notifications').run();
  console.log('Seeded demo data.');
  console.log('  Owner : owner@example.com / owner123');
  console.log('  Staff : staff@example.com / staff123');
}

seed();
