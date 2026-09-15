'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'cbms.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STAFF',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Computer Store',
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  state_code TEXT DEFAULT '',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  purchase_prefix TEXT NOT NULL DEFAULT 'PUR',
  return_prefix TEXT NOT NULL DEFAULT 'RET',
  adjustment_prefix TEXT NOT NULL DEFAULT 'ADJ',
  allow_negative_stock INTEGER NOT NULL DEFAULT 0,
  qr_mode TEXT NOT NULL DEFAULT 'INVOICE_INFO',
  upi_id TEXT DEFAULT '',
  bank_details TEXT DEFAULT '',
  terms TEXT DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR'
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS hsn_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  gst_rate REAL NOT NULL DEFAULT 18,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  brand TEXT DEFAULT '',
  model TEXT DEFAULT '',
  hsn_id INTEGER REFERENCES hsn_codes(id),
  gst_rate REAL NOT NULL DEFAULT 18,
  purchase_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  serial_tracked INTEGER NOT NULL DEFAULT 0,
  barcode TEXT DEFAULT '',
  description TEXT DEFAULT '',
  stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_invoice_no TEXT DEFAULT '',
  invoice_date TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  source TEXT NOT NULL DEFAULT 'MANUAL',
  file_name TEXT DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  description TEXT DEFAULT '',
  hsn_code TEXT DEFAULT '',
  qty REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id),
  invoice_date TEXT NOT NULL DEFAULT (date('now')),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_mode TEXT DEFAULT 'CASH',
  payment_status TEXT DEFAULT 'PAID',
  notes TEXT DEFAULT '',
  issued_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  description TEXT DEFAULT '',
  hsn_code TEXT DEFAULT '',
  qty REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  taxable_value REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  returned_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS serial_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  serial TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  purchase_id INTEGER REFERENCES purchases(id),
  invoice_id INTEGER REFERENCES invoices(id),
  invoice_item_id INTEGER REFERENCES invoice_items(id),
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (serial)
);
CREATE INDEX IF NOT EXISTS idx_serials_product ON serial_numbers(product_id, status);

CREATE TABLE IF NOT EXISTS sales_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  return_date TEXT NOT NULL DEFAULT (date('now')),
  reason TEXT DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  restock INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  invoice_item_id INTEGER NOT NULL REFERENCES invoice_items(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  balance_after REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  reference_type TEXT DEFAULT '',
  reference_id INTEGER,
  reference_no TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  note TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_product ON inventory_transactions(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_type ON inventory_transactions(type);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'INFO',
  type TEXT NOT NULL DEFAULT 'GENERAL',
  message TEXT NOT NULL,
  link TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

db.exec(SCHEMA);

/**
 * Add a column to an existing table if it is not there yet, so databases
 * created by an earlier version upgrade in place on startup.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Fields matching the client's GST tax invoice layout.
const MIGRATIONS = [
  ['business_settings', 'price_includes_gst', "INTEGER NOT NULL DEFAULT 1"],
  ['business_settings', 'state_name', "TEXT DEFAULT ''"],
  ['business_settings', 'bank_account_name', "TEXT DEFAULT ''"],
  ['business_settings', 'bank_account_no', "TEXT DEFAULT ''"],
  ['business_settings', 'bank_branch_ifsc', "TEXT DEFAULT ''"],
  ['business_settings', 'declaration', "TEXT DEFAULT 'We declare that this invoice shows the actual charges of the goods and services described and that all particulars are true and correct.'"],
  ['business_settings', 'signatory_name', "TEXT DEFAULT ''"],
  ['business_settings', 'invoice_no_format', "TEXT DEFAULT '{PREFIX}-{SEQ}'"],
  ['business_settings', 'default_payment_terms', "TEXT DEFAULT 'Due on Receipt'"],
  ['invoices', 'payment_terms', "TEXT DEFAULT ''"],
  ['invoices', 'due_date', 'TEXT'],
  ['invoices', 'place_of_supply', "TEXT DEFAULT ''"],
  ['invoices', 'ship_to_name', "TEXT DEFAULT ''"],
  ['invoices', 'ship_to_address', "TEXT DEFAULT ''"],
  ['invoices', 'product_brief', "TEXT DEFAULT ''"],
  ['invoices', 'price_includes_gst', 'INTEGER NOT NULL DEFAULT 0'],
  ['customers', 'shipping_address', "TEXT DEFAULT ''"],
  ['customers', 'state_code', "TEXT DEFAULT ''"],
];
for (const [table, column, definition] of MIGRATIONS) ensureColumn(table, column, definition);

db.exec(`INSERT OR IGNORE INTO business_settings (id) VALUES (1)`);

/** Run fn inside a SQLite transaction; rolls back on any throw. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Next document number for a series, e.g. nextNumber('INV') -> 'INV-1001'.
 * `format` accepts the tokens {PREFIX}, {SEQ}, {SEQ3}..{SEQ6}, {MM}, {YY}, {YYYY}
 * and {FY} (Indian financial year, e.g. 26-27), so a house style such as
 * 'TCS/{MM}{YY}/{SEQ4}' produces TCS/0826/0053.
 */
function nextNumber(prefix, start = 1001, format = '') {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(prefix);
  const next = row ? row.value + 1 : start;
  db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
    .run(prefix, next);
  return formatNumber(format || '{PREFIX}-{SEQ}', prefix, next);
}

function formatNumber(format, prefix, seq) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  // The Indian financial year starts in April.
  const fyStart = now.getMonth() + 1 >= 4 ? yyyy : yyyy - 1;
  return String(format)
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{SEQ(\d)\}/g, (_, width) => String(seq).padStart(Number(width), '0'))
    .replace(/\{SEQ\}/g, String(seq))
    .replace(/\{MM\}/g, mm)
    .replace(/\{YYYY\}/g, String(yyyy))
    .replace(/\{YY\}/g, String(yyyy).slice(2))
    .replace(/\{FY\}/g, `${String(fyStart).slice(2)}-${String(fyStart + 1).slice(2)}`);
}

function settings() {
  return db.prepare('SELECT * FROM business_settings WHERE id = 1').get();
}

module.exports = { db, tx, nextNumber, formatNumber, settings, ensureColumn, DATA_DIR, DB_FILE };
