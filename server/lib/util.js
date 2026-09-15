'use strict';

class AppError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wrap an async express handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function required(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === '');
  if (missing.length) throw new AppError(`Missing required field(s): ${missing.join(', ')}`, 422);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Inclusive date range filter helper; returns [from, to] defaulting to a wide window. */
function dateRange(query) {
  const from = str(query.from) || '1900-01-01';
  const to = str(query.to) || '2999-12-31';
  return [from, to];
}

/** Normalised text used for product matching and search. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 0..1 token-overlap similarity, biased towards matching model numbers. */
function similarity(a, b) {
  const ta = normalise(a).split(' ').filter(Boolean);
  const tb = normalise(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hits = 0;
  let weight = 0;
  let total = 0;
  for (const t of ta) {
    const w = /\d/.test(t) ? 2 : 1;
    total += w;
    if (setB.has(t)) { hits += 1; weight += w; }
  }
  const coverage = weight / total;
  const recall = hits / tb.length;
  return round2((coverage * 0.6 + recall * 0.4));
}

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

module.exports = { AppError, wrap, round2, num, str, required, today, dateRange, normalise, similarity, toCsv };
