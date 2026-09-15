'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every test file gets an isolated database, created before server modules load.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbms-test-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';

const { app } = require('../server/index');
const { db } = require('../server/db');
const { createUser } = require('../server/lib/auth');

let server;
let baseUrl;
const tokens = {};

async function start() {
  if (server) return baseUrl;
  createUser({ name: 'Owner', email: 'owner@test.local', password: 'owner123', role: 'ADMIN' });
  createUser({ name: 'Staff', email: 'staff@test.local', password: 'staff123', role: 'STAFF' });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = (await api('POST', '/api/auth/login', { email: 'owner@test.local', password: 'owner123' })).body.token;
  tokens.staff = (await api('POST', '/api/auth/login', { email: 'staff@test.local', password: 'staff123' })).body.token;
  // Most tests assert GST-exclusive maths; the inclusive mode has its own suite.
  await api('PUT', '/api/settings', { price_includes_gst: false, gstin: '27AAAPV1234C1ZK' }, 'admin');
  return baseUrl;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal JSON API client. `as` is 'admin' | 'staff' | undefined (anonymous). */
async function api(method, url, body, as) {
  const headers = { 'content-type': 'application/json' };
  if (as && tokens[as]) headers.authorization = `Bearer ${tokens[as]}`;
  const res = await fetch(`${baseUrl || ''}${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const stockOf = (productId) => db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock;

/** Create a product straight through the API and return it. */
async function makeProduct(overrides = {}) {
  const payload = {
    name: `Test Product ${Math.random().toString(36).slice(2, 8)}`,
    category: 'Components',
    brand: 'Generic',
    hsn_code: '84733099',
    gst_rate: 18,
    purchase_price: 1000,
    selling_price: 1500,
    min_stock: 2,
    opening_stock: 10,
    ...overrides,
  };
  const res = await api('POST', '/api/products', payload, 'admin');
  if (res.status !== 201) throw new Error(`Product creation failed: ${JSON.stringify(res.body)}`);
  return res.body.product;
}

const url = (suffix = '') => `${baseUrl}${suffix}`;

module.exports = { start, stop, api, db, stockOf, makeProduct, tokens, url };
