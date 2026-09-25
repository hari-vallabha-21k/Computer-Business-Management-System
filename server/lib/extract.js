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
const { PDFParse } = require('pdf-parse');
const { db } = require('../db');
const { round2, similarity, normalise } = require('./util');
const { workbookToText } = require('./xlsx');

const TEXT_EXT = new Set(['.txt', '.csv', '.tsv']);
const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.xltx']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.bmp']);

/** Decode a PDF hex string; single-byte codes cover WinAnsi/Standard encodings. */
function fromHex(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean) return '';
  const bytes = clean.length % 2 ? `${clean}0` : clean;
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return out;
}

/** Pull readable text out of a PDF using pdf-parse. */
async function pdfText(buffer) {
  try {
    const standardFontDataUrl = path.join(require.resolve('pdfjs-dist'), '../../standard_fonts/');
    const parser = new PDFParse(new Uint8Array(buffer), { standardFontDataUrl });
    const data = await parser.getText();
    return data.text || '';
  } catch (err) {
    console.error('pdfParse error:', err);
    return '';
  }
}

async function readText(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return { text: '', reason: 'IMAGE_NO_TEXT_LAYER' };
  if (TEXT_EXT.has(ext)) return { text: buffer.toString('utf8'), reason: null };
  if (SHEET_EXT.has(ext) || buffer.subarray(0, 2).toString() === 'PK') {
    try {
      const text = workbookToText(buffer);
      return { text, reason: text.trim() ? null : 'SHEET_EMPTY' };
    } catch {
      return { text: '', reason: 'UNSUPPORTED_FILE' };
    }
  }
  if (ext === '.pdf' || buffer.subarray(0, 4).toString() === '%PDF') {
    const text = await pdfText(buffer);
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
  const invoiceNo = text.match(/(?:invoice|bill|inv)\s*(?:no|number|#)[\s:.#|-]*([A-Za-z0-9][A-Za-z0-9/-]{2,})/i);
  if (invoiceNo) out.invoiceNo = invoiceNo[1];
  const date = text.match(/(?:invoice\s*)?date[\s:.|-]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  if (date) out.invoiceDate = normaliseDate(date[1]);
  const gstin = text.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d][A-Z\d])\b/);
  if (gstin) out.supplierGstin = gstin[1];
  const supplier = text.match(/(?:supplier|seller|sold\s*by|vendor)\s*[:.-]\s*(.{3,60})/i);
  if (supplier) {
    out.supplier = supplier[1].split(/[\n\r]/)[0].trim();
  } else {
    // Fall back to the first line that reads like a business name.
    const firstLine = text.split(/\r?\n/).map((l) => l.trim())
      .find((l) => l.length >= 3 && l.length <= 60 && /[A-Za-z]{3}/.test(l) && !/invoice|^gstin/i.test(l));
    if (firstLine) out.supplier = firstLine;
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
      const col = (names, exclude = []) => header.findIndex((h) => names.some((n) => h.includes(n))
        && !exclude.some((n) => h.includes(n)));
      const iName = col(['description', 'product', 'item', 'particular']);
      const iHsn = col(['hsn']);
      const iQty = col(['qty', 'quantity']);
      // "Rate" is the unit price; "Total Incl GST" and "Taxable Amount" are line values,
      // and a GST column only counts when it carries a rate, not an amount.
      const iRate = col(['rate', 'price', 'unit'], ['total', 'amount', 'value', 'taxable']);
      const iGst = col(['gst', 'tax'], ['total', 'amount', 'value', 'taxable', 'incl', 'cgst', 'sgst', 'igst']);
      const iAmount = col(['amount', 'total', 'value'], ['taxable', 'cgst', 'sgst', 'igst']);
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

  const rowRe = new RegExp(`^(.+?)\\s+(\\d{4,8})?\\s*(\\d+(?:\\.\\d+)?)\\s+${MONEY}(?:\\s+\\d{1,2}(?:\\.\\d+)?%)?(?:\\s+${MONEY})?$`);
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
  const FLOOR = 0.35;
  const scored = products.map((p) => {
    let score = similarity(description, `${p.name} ${p.brand} ${p.model}`);
    // A shared HSN strengthens a plausible match but must not create one:
    // two unrelated laptops share an HSN, and that is not the same product.
    if (hsn && p.hsn_code === hsn && score >= FLOOR) score = round2(Math.min(1, score + 0.1));
    if (normalise(p.name) === normalise(description)) score = 1;
    return { product: p, score };
  }).filter((s) => s.score >= FLOOR).sort((a, b) => b.score - a.score);
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
async function extractPurchaseInvoice(buffer, filename) {
  const { text, reason } = await readText(buffer, filename);
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
