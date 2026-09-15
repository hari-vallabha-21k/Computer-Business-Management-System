'use strict';
const { db, settings } = require('../db');
const { AppError, round2 } = require('./util');

const SIGN = {
  OPENING: 1, PURCHASE: 1, RETURN: 1,
  SALE: -1, DAMAGE: -1, CANCELLED_SALE: 1,
  ADJUSTMENT: 0, // signed qty supplied by caller
};

/**
 * Record one stock movement and keep products.stock in step.
 * qty is always supplied as a positive magnitude except for ADJUSTMENT,
 * where the caller passes the signed delta.
 * Must be called inside a transaction.
 */
function move({ productId, type, qty, unitCost = 0, referenceType = '', referenceId = null,
  referenceNo = '', reason = '', note = '', userId = null, allowNegative = null }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new AppError(`Product ${productId} not found`, 404);

  const sign = SIGN[type];
  if (sign === undefined) throw new AppError(`Unknown stock movement type: ${type}`, 422);
  const delta = type === 'ADJUSTMENT' ? Number(qty) : sign * Math.abs(Number(qty));
  if (!Number.isFinite(delta) || delta === 0) throw new AppError('Stock movement quantity must be a non-zero number', 422);

  const balance = round2(product.stock + delta);
  const negativeAllowed = allowNegative === null ? !!settings().allow_negative_stock : allowNegative;
  if (balance < 0 && !negativeAllowed) {
    throw new AppError(
      `Insufficient stock for ${product.name}. Requested: ${Math.abs(delta)}, Available: ${product.stock}.`,
      409,
      { productId, requested: Math.abs(delta), available: product.stock },
    );
  }

  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(balance, productId);
  const info = db.prepare(`
    INSERT INTO inventory_transactions
      (product_id, type, qty, balance_after, unit_cost, reference_type, reference_id, reference_no, reason, note, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(productId, type, delta, balance, unitCost, referenceType, referenceId, referenceNo, reason, note, userId);

  maybeLowStockAlert(product, balance);
  return { transactionId: Number(info.lastInsertRowid), balance };
}

function maybeLowStockAlert(product, balance) {
  if (product.min_stock <= 0 || balance > product.min_stock) return;
  const existing = db.prepare(
    `SELECT id FROM notifications WHERE type = 'LOW_STOCK' AND is_read = 0 AND link = ?`,
  ).get(`#/inventory/product/${product.id}`);
  if (existing) return;
  const message = balance <= 0
    ? `${product.name} is out of stock.`
    : `${product.name} is low in stock (${balance} left, minimum ${product.min_stock}).`;
  db.prepare(`INSERT INTO notifications (level, type, message, link) VALUES (?, 'LOW_STOCK', ?, ?)`)
    .run(balance <= 0 ? 'ERROR' : 'WARN', message, `#/inventory/product/${product.id}`);
}

/** Stock recomputed from the transaction ledger - the audit source of truth. */
function ledgerStock(productId) {
  const row = db.prepare('SELECT COALESCE(SUM(qty), 0) AS total FROM inventory_transactions WHERE product_id = ?')
    .get(productId);
  return round2(row.total);
}

function assertSerialsAvailable(productId, serials) {
  for (const serial of serials) {
    const row = db.prepare('SELECT * FROM serial_numbers WHERE serial = ?').get(serial);
    if (!row) throw new AppError(`Serial number ${serial} is not in stock.`, 422);
    if (row.product_id !== productId) throw new AppError(`Serial number ${serial} belongs to a different product.`, 422);
    if (row.status !== 'AVAILABLE') throw new AppError(`Serial number ${serial} is not available (status: ${row.status}).`, 409);
  }
}

function addSerials(productId, serials, { purchaseId = null } = {}) {
  const insert = db.prepare(
    'INSERT INTO serial_numbers (product_id, serial, status, purchase_id) VALUES (?, ?, \'AVAILABLE\', ?)',
  );
  for (const raw of serials) {
    const serial = String(raw).trim();
    if (!serial) continue;
    const clash = db.prepare('SELECT id FROM serial_numbers WHERE serial = ?').get(serial);
    if (clash) throw new AppError(`Serial number ${serial} already exists.`, 409);
    insert.run(productId, serial, purchaseId);
  }
}

module.exports = { move, ledgerStock, addSerials, assertSerialsAvailable, maybeLowStockAlert };
