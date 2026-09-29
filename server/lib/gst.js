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
 * Totals for a whole invoice. The store bills every sale as CGST + SGST, each
 * half of the line's GST (9% + 9% on an 18% item), whatever the customer's
 * state; IGST is no longer charged. SGST takes the rounding remainder so the
 * two halves always add back to the GST total.
 */
function invoiceTotals(lines) {
  const subtotal = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const discount = round2(lines.reduce((s, l) => s + num(l.discount), 0));
  const gstAmount = round2(lines.reduce((s, l) => s + l.gstAmount, 0));
  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  const cgst = round2(gstAmount / 2);
  return { subtotal, discount, gstAmount, total, cgst, sgst: round2(gstAmount - cgst), igst: 0 };
}

module.exports = { lineTotals, invoiceTotals, stateOf: stateCode };
