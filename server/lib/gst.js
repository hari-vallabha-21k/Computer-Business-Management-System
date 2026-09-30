'use strict';
const { round2, num } = require('./util');
const { stateCode } = require('./states');

/**
 * Line maths for one invoice item.
 *
 * `priceIncludesGst` follows the business setting: when on, the rate the user
 * types is what the customer pays (the tax is backed out of it, which is how
 * the client's own invoice is laid out); when off, GST is added on top.
 * `discount` is an absolute amount on the line, in the same basis as the rate.
 */
function lineTotals({ qty, unitPrice, discount = 0, gstRate = 0, priceIncludesGst = false }) {
  const rate = num(gstRate);
  const gross = round2(num(qty) * num(unitPrice));
  const net = round2(Math.max(gross - num(discount), 0));

  if (priceIncludesGst) {
    const taxable = round2(net / (1 + rate / 100));
    const gstAmount = round2(net - taxable);
    return { gross, taxable, gstAmount, total: net };
  }
  const gstAmount = round2(net * rate / 100);
  return { gross, taxable: net, gstAmount, total: round2(net + gstAmount) };
}

/**
 * One line's GST as [CGST, SGST], each half of it (9% + 9% on an 18% item).
 * An odd paisa goes to CGST: 1.01 splits as 0.51 + 0.50. This is the only
 * place the split is made; invoice totals add these per-line halves up, so
 * the CGST and SGST columns always sum to the totals printed under them.
 */
function splitGst(gst) {
  const cgst = round2(num(gst) / 2);
  return [cgst, round2(num(gst) - cgst)];
}

/** Invoice CGST and SGST: the sum of every line's own split. */
function sumSplit(gstAmounts) {
  let cgst = 0;
  let sgst = 0;
  for (const g of gstAmounts) {
    const [c, s] = splitGst(g);
    cgst += c;
    sgst += s;
  }
  return [round2(cgst), round2(sgst)];
}

/**
 * Totals for a whole invoice. The store bills every sale as CGST + SGST,
 * whatever the customer's state; IGST is no longer charged.
 */
function invoiceTotals(lines) {
  const subtotal = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const discount = round2(lines.reduce((s, l) => s + num(l.discount), 0));
  const gstAmount = round2(lines.reduce((s, l) => s + l.gstAmount, 0));
  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  const [cgst, sgst] = sumSplit(lines.map((l) => l.gstAmount));
  return { subtotal, discount, gstAmount, total, cgst, sgst, igst: 0 };
}

module.exports = { lineTotals, invoiceTotals, splitGst, sumSplit, stateOf: stateCode };
