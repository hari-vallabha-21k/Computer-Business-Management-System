'use strict';
/**
 * Purchase-invoice extraction.
 *
 * Text-bearing files (PDF with a text layer, TXT, CSV) are parsed locally with
 * no external service. Scanned images have no text layer, so instead of
 * silently returning nothing the extractor reports that it could not read the
 * file and the UI falls back to manual entry (PRD section 32).
 */
const zlib = require('node:zlib');
const path = require('node:path');
const { db } = require('../db');
const { round2, similarity, normalise } = require('./util');

const TEXT_EXT = new Set(['.txt', '.csv', '.tsv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.bmp']);

/** Pull readable text out of a PDF: inflate content streams and collect show-text operands. */
function pdfText(buffer) {
  const chunks = [];
  const raw = buffer.toString('latin1');
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    const bytes = Buffer.from(m[1], 'latin1');
    let content = null;
    try {
      content = zlib.inflateSync(bytes).toString('latin1');
    } catch {
      try { content = zlib.inflateRawSync(bytes).toString('latin1'); } catch { content = null; }
    }
    if (content === null) content = bytes.toString('latin1');
    if (!/(Tj|TJ)/.test(content)) continue;

    const lines = [];
    const textRe = /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|T\*|ET/g;
    let t;
    let current = '';
    while ((t = textRe.exec(content)) !== null) {
      if (t[1] !== undefined) {
        const parts = [...t[1].matchAll(/\(((?:[^)\\]|\\.)*)\)/g)].map((p) => p[1]);
        current += parts.join('');
      } else if (t[2] !== undefined) {
        current += t[2];
      } else {
        if (current.trim()) lines.push(current);
        current = '';
      }
    }
    if (current.trim()) lines.push(current);
    chunks.push(lines.join('\n'));
  }
  return chunks.join('\n')
    .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([()\\])/g, '$1');
}

function readText(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return { text: '', reason: 'IMAGE_NO_TEXT_LAYER' };
  if (TEXT_EXT.has(ext)) return { text: buffer.toString('utf8'), reason: null };
  if (ext === '.pdf' || buffer.subarray(0, 4).toString() === '%PDF') {
    const text = pdfText(buffer);
    return { text, reason: text.trim() ? null : 'PDF_NO_TEXT_LAYER' };
  }
  const text = buffer.toString('utf8');
  const binary = /[\x00-\x08]/.test(text.slice(0, 200));
  return { text: binary ? '' : text, reason: binary ? 'UNSUPPORTED_FILE' : null };
}

const MONEY = '([0-9][0-9,]*\\.?[0-9]*)';
const toNumber = (s) => Number(String(s || '').replace(/,/g, '')) || 0;

function normaliseDate(value) {
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function findHeader(text) {
  const out = { supplier: '', invoiceNo: '', invoiceDate: '', supplierGstin: '' };
  const invoiceNo = text.match(/(?:invoice|bill|inv)\s*(?:no|number|#)\s*[:.#-]?\s*([A-Za-z0-9/-]{3,})/i);
  if (invoiceNo) out.invoiceNo = invoiceNo[1];
  const date = text.match(/(?:invoice\s*)?date\s*[:.-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  if (date) out.invoiceDate = normaliseDate(date[1]);
  const gstin = text.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d][A-Z\d])\b/);
  if (gstin) out.supplierGstin = gstin[1];
  const supplier = text.match(/(?:supplier|seller|sold\s*by|vendor)\s*[:.-]\s*(.{3,60})/i);
  if (supplier) {
    out.supplier = supplier[1].split(/[\n\r]/)[0].trim();
  } else {
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (firstLine && firstLine.length <= 60 && !/invoice/i.test(firstLine)) out.supplier = firstLine;
  }
  return out;
}

/**
 * Parse item rows. Two shapes are understood:
 *  - delimited rows (CSV / pipe separated) under a recognisable header, and
 *  - free-text lines ending in "<hsn?> <qty> <rate> <amount?>".
 */
function findItems(text) {
  const items = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const delimited = lines.filter((l) => (l.match(/[|,;\t]/g) || []).length >= 3);
  if (delimited.length >= 2) {
    const headerIdx = delimited.findIndex((l) => /(item|product|description|particular)/i.test(l) && /(qty|quantity)/i.test(l));
    if (headerIdx >= 0) {
      const split = (l) => l.replace(/^\||\|$/g, '').split(/\s*[|,;\t]\s*/).map((c) => c.trim());
      const header = split(delimited[headerIdx]).map((h) => h.toLowerCase());
      const col = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const iName = col('description', 'product', 'item', 'particular');
      const iHsn = col('hsn');
      const iQty = col('qty', 'quantity');
      const iRate = col('rate', 'price', 'unit');
      const iGst = col('gst', 'tax');
      const iAmount = col('amount', 'total', 'value');
      for (const row of delimited.slice(headerIdx + 1)) {
        const cells = split(row);
        if (cells.length < 3) continue;
        const name = iName >= 0 ? cells[iName] : cells[0];
        const qty = toNumber(iQty >= 0 ? cells[iQty] : 0);
        if (!name || /^(total|grand|sub)/i.test(name) || qty <= 0) continue;
        items.push({
          description: name,
          hsn: iHsn >= 0 ? (cells[iHsn] || '').replace(/\D/g, '') : '',
          qty,
          unitPrice: toNumber(iRate >= 0 ? cells[iRate] : 0),
          gstRate: iGst >= 0 && cells[iGst] ? toNumber(cells[iGst]) : null,
          amount: toNumber(iAmount >= 0 ? cells[iAmount] : 0),
        });
      }
      if (items.length) return items;
    }
  }

  const rowRe = new RegExp(`^(.+?)\\s+(\\d{4,8})?\\s*(\\d+(?:\\.\\d+)?)\\s+${MONEY}(?:\\s+${MONEY})?$`);
  for (const line of lines) {
    if (/^(total|sub\s*total|grand|gst|cgst|sgst|igst|amount in words|discount|round)/i.test(line)) continue;
    const m = line.match(rowRe);
    if (!m) continue;
    const description = m[1].replace(/^\d+[.)]\s*/, '').trim();
    if (description.length < 3 || /^(hsn|qty|rate|description|item|product)$/i.test(description)) continue;
    const qty = Number(m[3]);
    const unitPrice = toNumber(m[4]);
    if (!qty || !unitPrice) continue;
    items.push({ description, hsn: m[2] || '', qty, unitPrice, gstRate: null, amount: toNumber(m[5]) });
  }
  return items;
}

/** Best product-master matches for an extracted description (Section 10). */
function matchProduct(description, hsn) {
  const products = db.prepare(`
    SELECT p.*, h.code AS hsn_code FROM products p LEFT JOIN hsn_codes h ON h.id = p.hsn_id WHERE p.active = 1`).all();
  const scored = products.map((p) => {
    let score = similarity(description, `${p.name} ${p.brand} ${p.model}`);
    if (hsn && p.hsn_code === hsn) score = round2(Math.min(1, score + 0.1));
    if (normalise(p.name) === normalise(description)) score = 1;
    return { product: p, score };
  }).filter((s) => s.score >= 0.35).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}

function matchSupplier(name, gstin) {
  if (gstin) {
    const byGstin = db.prepare('SELECT * FROM suppliers WHERE gstin = ?').get(gstin);
    if (byGstin) return { supplier: byGstin, score: 1 };
  }
  if (!name) return null;
  const suppliers = db.prepare('SELECT * FROM suppliers').all();
  const best = suppliers.map((s) => ({ supplier: s, score: similarity(name, s.name) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 0.5 ? best : null;
}

/** Full extraction: returns a review payload and never touches inventory. */
function extractPurchaseInvoice(buffer, filename) {
  const { text, reason } = readText(buffer, filename);
  const warnings = [];
  if (!text.trim()) {
    return {
      ok: false,
      reason: reason || 'NO_TEXT',
      message: reason === 'IMAGE_NO_TEXT_LAYER'
        ? 'This looks like a scanned image. Text could not be read from it automatically - please enter the purchase manually.'
        : 'No readable text could be extracted from this file. Please enter the purchase manually.',
      header: {}, items: [], warnings,
    };
  }

  const header = findHeader(text);
  if (!header.invoiceNo) warnings.push('Supplier invoice number could not be identified - please enter it.');
  if (!header.invoiceDate) warnings.push('Invoice date could not be identified - please enter it.');

  const supplierMatch = matchSupplier(header.supplier, header.supplierGstin);
  const rawItems = findItems(text);
  if (!rawItems.length) {
    return {
      ok: false,
      reason: 'NO_ITEMS',
      message: 'No product lines could be identified in this invoice. Please add the items manually.',
      header: { ...header, supplierMatch }, items: [], warnings,
    };
  }

  const items = rawItems.map((item) => {
    const matches = matchProduct(item.description, item.hsn);
    const best = matches[0] || null;
    const hsnRow = item.hsn ? db.prepare('SELECT * FROM hsn_codes WHERE code = ?').get(item.hsn) : null;
    const needsVerification = [];
    if (!best) needsVerification.push('NO_PRODUCT_MATCH');
    else if (best.score < 0.75) needsVerification.push('LOW_CONFIDENCE_MATCH');
    if (!item.hsn && !(best && best.product.hsn_code)) needsVerification.push('HSN_NOT_IDENTIFIED');
    if (!item.unitPrice) needsVerification.push('PRICE_NOT_IDENTIFIED');
    return {
      ...item,
      hsnKnown: !!hsnRow,
      gstRate: item.gstRate ?? (hsnRow ? hsnRow.gst_rate : (best ? best.product.gst_rate : null)),
      match: best
        ? {
          productId: best.product.id,
          name: best.product.name,
          product_code: best.product.product_code,
          hsn_code: best.product.hsn_code,
          score: best.score,
        }
        : null,
      alternatives: matches.slice(1).map((m) => ({ productId: m.product.id, name: m.product.name, score: m.score })),
      needsVerification,
    };
  });

  const flagged = items.filter((i) => i.needsVerification.length).length;
  if (flagged) warnings.push(`${flagged} item(s) require verification before they can be added to inventory.`);

  return {
    ok: true,
    header: {
      ...header,
      supplierMatch: supplierMatch
        ? { supplierId: supplierMatch.supplier.id, name: supplierMatch.supplier.name, score: supplierMatch.score }
        : null,
    },
    items,
    warnings,
    textPreview: text.slice(0, 2000),
  };
}

module.exports = { extractPurchaseInvoice, pdfText, findItems, findHeader, matchProduct, normaliseDate };
