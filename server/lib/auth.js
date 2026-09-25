'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { AppError } = require('./util');

const SECRET = process.env.SESSION_SECRET || 'cbms-dev-secret-change-me';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const hashPassword = (password) => bcrypt.hashSync(String(password), 10);

function createUser({ name, email, password, role = 'STAFF' }) {
  const hash = hashPassword(password);
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, String(email).toLowerCase(), hash, role);
  return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function login(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    throw new AppError('Invalid email or password.', 401);
  }
  const safe = { id: user.id, name: user.name, email: user.email, role: user.role };
  return { user: safe, token: signToken(safe) };
}

/** Populate req.user from the bearer token / session cookie. */
function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cookie = (req.headers.cookie || '')
    .split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === 'cbms_token');
  const payload = verifyToken(bearer || (cookie && decodeURIComponent(cookie[1])));
  if (payload) req.user = payload;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new AppError('Please sign in to continue.', 401));
  next();
}

/** Role gate. ADMIN implicitly passes every check. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Please sign in to continue.', 401));
    if (req.user.role === 'ADMIN' || roles.includes(req.user.role)) return next();
    next(new AppError('Your account does not have permission for this action.', 403));
  };
}

module.exports = { hashPassword, signToken, verifyToken, createUser, login, authenticate, requireAuth, requireRole };
