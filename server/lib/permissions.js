'use strict';
/**
 * What sales staff are allowed to do. The owner can always do everything;
 * these switches only ever widen or narrow the STAFF role, and they are
 * enforced here on the server, not merely hidden in the UI.
 */
const { db, settings } = require('../db');
const { AppError } = require('./util');

/** key -> [label, description, default] */
const PERMISSIONS = {
  invoices: ['Create invoices', 'Sell products and print bills', true],
  stock: ['Add stock', 'Receive new items into inventory', true],
  customers: ['Add and edit customers', 'Save customer phone and address', true],
  serials: ['See serial numbers', 'Look up where a unit came from', true],
  discount: ['Give discounts', 'Change the price on an invoice', false],
  cancel: ['Cancel invoices', 'Undo an issued invoice', false],
  costs: ['See purchase prices and profit', 'Sensitive — usually kept for the owner', false],
};

const DEFAULTS = Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v[2]]));

/** The stored switches, with any missing key falling back to its default. */
function staffPermissions(stored) {
  const raw = stored === undefined ? (settings().staff_permissions || '') : stored;
  let saved = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
  const out = { ...DEFAULTS };
  for (const key of Object.keys(PERMISSIONS)) if (key in saved) out[key] = !!saved[key];
  return out;
}

function savePermissions(input) {
  const next = staffPermissions();
  for (const key of Object.keys(PERMISSIONS)) if (key in (input || {})) next[key] = !!input[key];
  db.prepare('UPDATE business_settings SET staff_permissions = ? WHERE id = 1').run(JSON.stringify(next));
  return next;
}

/** True when this user may do `key`. Admins always may. */
function can(user, key) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return staffPermissions()[key] === true;
}

/** Express gate for a single permission. An unknown key is owner-only. */
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Please sign in to continue.', 401));
    if (can(req.user, key)) return next();
    const action = PERMISSIONS[key] ? PERMISSIONS[key][0].toLowerCase() : 'do this';
    next(new AppError(`Sales staff are not allowed to ${action}. Ask the owner to turn this on in Settings.`, 403));
  };
}

/**
 * Purchase prices and margins are the owner's business unless the `costs`
 * switch is on, so they are removed from what goes back over the wire rather
 * than only hidden by the screens.
 */
const COST_FIELDS = ['purchase_price', 'cost_price', 'unit_cost', 'stock_value',
  'stockValue', 'lastPurchasePrice'];

function hideCosts(user, value, fields = COST_FIELDS) {
  if (can(user, 'costs')) return value;
  const scrub = (row) => {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const field of fields) delete out[field];
    return out;
  };
  return Array.isArray(value) ? value.map(scrub) : scrub(value);
}

/** The list the settings screen renders. */
const describe = () => {
  const current = staffPermissions();
  return Object.entries(PERMISSIONS).map(([key, [label, desc]]) => ({ key, label, description: desc, allowed: current[key] }));
};

module.exports = {
  PERMISSIONS, DEFAULTS, staffPermissions, savePermissions, can, requirePermission, hideCosts, describe,
};
