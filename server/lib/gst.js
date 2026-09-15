'use strict';
const { round2, num } = require('./util');

const stateOf = (gstin) => String(gstin || '').trim().slice(0, 2);

/**
 * Line maths for one invoice item. Prices are GST-exclusive; discount is an
 * absolute amount on the line.
 */
function lineTotals({ qty, unitPrice, discount = 0, gstRate = 0 }) {
  const gross = round2(num(qty) * num(unitPrice));
  const taxable = round2(Math.max(gross - num(discount), 0));
  const gstAmount = round2(taxable * num(gstRate) / 100);
  return { gross, taxable, gstAmount, total: round2(taxable + gstAmount) };
}

/**
 * Totals for a whole invoice. Intra-state supply is split CGST/SGST; when the
 * customer's GSTIN state differs from the business state the tax is IGST.
 */
function invoiceTotals(lines, { businessGstin = '', customerGstin = '' } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + l.gross, 0));
  const discount = round2(lines.reduce((s, l) => s + num(l.discount), 0));
  const gstAmount = round2(lines.reduce((s, l) => s + l.gstAmount, 0));
  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  const bs = stateOf(businessGstin);
  const cs = stateOf(customerGstin);
  const interState = !!(bs && cs && bs !== cs);
  return {
    subtotal,
    discount,
    gstAmount,
    total,
    interState,
    cgst: interState ? 0 : round2(gstAmount / 2),
    sgst: interState ? 0 : round2(gstAmount / 2),
    igst: interState ? gstAmount : 0,
  };
}

module.exports = { lineTotals, invoiceTotals, stateOf };
