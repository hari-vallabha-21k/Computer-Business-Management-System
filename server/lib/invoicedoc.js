'use strict';
/**
 * Tax invoice PDF, laid out to match the client's template:
 * seller block, invoice meta, Bill To / Ship To, an item grid with
 * Total Incl GST / Taxable Amount / CGST / SGST columns, product brief,
 * amount in words, bank details, signatory, terms and declaration.
 */
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { settings } = require('../db');
const { round2 } = require('./util');
const { rupeesInWords } = require('./numberwords');

const amount = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LINE = '#94a3b8';
const HEAD_BG = '#eef2f7';
const INK = '#0f172a';
const MUTED = '#475569';

/**
 * Build the QR payload for an invoice. The mode is configurable (Section 17):
 *  - PAYMENT_UPI  : a UPI collect string so the customer can pay by scanning
 *  - INVOICE_INFO : a compact summary of the invoice
 *  - VERIFY_URL   : a link back to this invoice for verification
 * Official GST e-invoice (IRN) QR is a separate integration and is not produced here.
 */
function qrPayload(invoice, business, baseUrl = '') {
  const mode = (business.qr_mode || 'INVOICE_INFO').toUpperCase();
  if (mode === 'PAYMENT_UPI') {
    if (!business.upi_id) return { mode, data: '', note: 'No UPI ID configured in Settings.' };
    const params = new URLSearchParams({
      pa: business.upi_id, pn: business.name, am: Number(invoice.total).toFixed(2),
      cu: business.currency || 'INR', tn: `Invoice ${invoice.invoice_no}`,
    });
    return { mode, data: `upi://pay?${params.toString()}` };
  }
  if (mode === 'VERIFY_URL') return { mode, data: `${baseUrl}/#/sales/invoice/${invoice.id}` };
  return {
    mode: 'INVOICE_INFO',
    data: JSON.stringify({
      seller: business.name, gstin: business.gstin || undefined, invoice: invoice.invoice_no,
      date: invoice.invoice_date, total: round2(invoice.total),
    }),
  };
}

async function qrDataUrl(invoice, business, baseUrl) {
  const payload = qrPayload(invoice, business, baseUrl);
  if (!payload.data) return { ...payload, dataUrl: null };
  const dataUrl = await QRCode.toDataURL(payload.data, { margin: 1, width: 240 });
  return { ...payload, dataUrl };
}

/** Item grid columns; widths sum to the printable width. */
function columns(left, width, interState) {
  const spec = interState
    ? [['#', 22, 'left'], ['Item & Description', 0, 'left'], ['HSN', 58, 'left'], ['Qty', 30, 'right'],
      ['Rate', 62, 'right'], ['Total Incl GST', 72, 'right'], ['Taxable Amount', 74, 'right'], ['IGST', 74, 'right']]
    : [['#', 22, 'left'], ['Item & Description', 0, 'left'], ['HSN', 58, 'left'], ['Qty', 30, 'right'],
      ['Rate', 62, 'right'], ['Total Incl GST', 72, 'right'], ['Taxable Amount', 74, 'right'],
      ['CGST', 56, 'right'], ['SGST', 56, 'right']];
  const fixed = spec.reduce((s, c) => s + c[1], 0);
  let x = left;
  return spec.map(([label, w, align]) => {
    const colWidth = w || width - fixed;
    const col = { label, x, w: colWidth, align };
    x += colWidth;
    return col;
  });
}

/** Render a tax invoice as a PDF and stream it to res. */
async function renderInvoicePdf(res, { invoice, items, business = settings(), baseUrl = '' }) {
  const doc = new PDFDocument({ size: 'A4', margin: 34, bufferPages: true });
  doc.pipe(res);

  const left = 34;
  const right = 561;
  const width = right - left;
  const interState = invoice.igst > 0;
  const gstRate = items.length ? Number(items[0].gst_rate) : 18;
  const halfRate = round2(gstRate / 2);

  const box = (x, y, w, h) => doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(LINE).stroke();
  const text = (value, x, y, opts = {}) => doc.text(value === null || value === undefined ? '' : String(value), x, y, opts);

  // ---- Seller header ----
  let y = left;
  box(left, y, width, 74);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK);
  text(business.name || 'Tax Invoice', left + 10, y + 9, { width: width - 190 });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  if (business.address) text(business.address, left + 10, doc.y + 1, { width: width - 190 });
  const contact = [business.phone, business.email].filter(Boolean).join('  |  ');
  if (contact) text(contact, left + 10, doc.y + 1, { width: width - 190 });
  if (business.gstin) {
    doc.font('Helvetica-Bold').fillColor(INK);
    text(`GSTIN ${business.gstin}`, left + 10, doc.y + 1);
  }
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK);
  text(invoice.status === 'CANCELLED' ? 'TAX INVOICE (CANCELLED)' : 'TAX INVOICE',
    right - 190, y + 28, { width: 180, align: 'center' });
  y += 74;

  // ---- Invoice meta ----
  const metaH = 64;
  box(left, y, width, metaH);
  doc.moveTo(left + width * 0.52, y).lineTo(left + width * 0.52, y + metaH).strokeColor(LINE).stroke();
  const metaRows = [
    ['Invoice No.', invoice.invoice_no],
    ['Invoice Date', invoice.invoice_date],
    ['Terms', invoice.payment_terms || business.default_payment_terms || 'Due on Receipt'],
    ['Due Date', invoice.due_date || invoice.invoice_date],
  ];
  doc.fontSize(8.5);
  metaRows.forEach(([label, value], i) => {
    const ry = y + 7 + i * 13;
    doc.font('Helvetica').fillColor(MUTED);
    text(label, left + 10, ry, { width: 80 });
    doc.font('Helvetica-Bold').fillColor(INK);
    text(value, left + 92, ry, { width: width * 0.52 - 100 });
  });
  doc.font('Helvetica').fillColor(MUTED);
  text('Place Of Supply', left + width * 0.52 + 10, y + 7);
  doc.font('Helvetica-Bold').fillColor(INK);
  text(invoice.place_of_supply || '-', left + width * 0.52 + 10, y + 20, { width: width * 0.48 - 20 });
  doc.font('Helvetica').fillColor(MUTED);
  text('Payment', left + width * 0.52 + 10, y + 36);
  doc.font('Helvetica-Bold').fillColor(INK);
  text(`${invoice.payment_mode || '-'} (${invoice.payment_status || '-'})`, left + width * 0.52 + 10, y + 49);
  y += metaH;

  // ---- Bill To / Ship To ----
  const partyH = 76;
  box(left, y, width, partyH);
  doc.moveTo(left + width / 2, y).lineTo(left + width / 2, y + partyH).strokeColor(LINE).stroke();
  const party = (title, name, address, extra, x) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    text(title, x + 10, y + 7);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK);
    text(name || '-', x + 10, y + 19, { width: width / 2 - 20 });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    if (address) text(address, x + 10, doc.y + 1, { width: width / 2 - 20, height: 26, ellipsis: true });
    if (extra) {
      doc.font('Helvetica-Bold').fillColor(INK);
      text(extra, x + 10, y + partyH - 14, { width: width / 2 - 20 });
    }
  };
  party('Bill To', invoice.customer_name || 'Walk-in Customer', invoice.customer_address,
    invoice.customer_gstin ? `GSTIN  ${invoice.customer_gstin}` : '', left);
  party('Ship To', invoice.ship_to_name || invoice.customer_name || 'Walk-in Customer',
    invoice.ship_to_address || invoice.customer_shipping_address || invoice.customer_address,
    invoice.customer_phone ? `Phone  ${invoice.customer_phone}` : '', left + width / 2);
  y += partyH;

  // ---- Item grid ----
  const cols = columns(left, width, interState);
  const headH = 26;
  doc.rect(left, y, width, headH).fillAndStroke(HEAD_BG, LINE);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK);
  cols.forEach((c, i) => {
    const label = c.label === 'CGST' ? `${halfRate}% CGST`
      : c.label === 'SGST' ? `${halfRate}% SGST`
        : c.label === 'IGST' ? `${gstRate}% IGST` : c.label;
    // Only the tax columns carry the two-line "<rate>% CGST / Amount" heading.
    const isTaxColumn = i >= 7;
    text(label, c.x + 4, y + (isTaxColumn ? 5 : 9), { width: c.w - 8, align: c.align });
    if (isTaxColumn) text('Amount', c.x + 4, y + 15, { width: c.w - 8, align: c.align });
    if (i) doc.moveTo(c.x, y).lineTo(c.x, y + headH).lineWidth(0.6).strokeColor(LINE).stroke();
  });
  y += headH;

  const drawRow = (cells, rowY, h, { bold = false, fill = null } = {}) => {
    if (fill) doc.rect(left, rowY, width, h).fillAndStroke(fill, LINE);
    else box(left, rowY, width, h);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(INK);
    cols.forEach((c, i) => {
      if (i) doc.moveTo(c.x, rowY).lineTo(c.x, rowY + h).lineWidth(0.6).strokeColor(LINE).stroke();
      text(cells[i], c.x + 4, rowY + 6, { width: c.w - 8, align: c.align });
    });
  };

  const money0 = (v) => amount(v);
  items.forEach((item, i) => {
    const serials = item.serials && item.serials.length ? `S/N: ${item.serials.join(', ')}` : '';
    const nameHeight = doc.font('Helvetica').fontSize(8).heightOfString(item.description, { width: cols[1].w - 8 });
    const h = Math.max(20, nameHeight + (serials ? 20 : 10));
    if (y + h > 700) { doc.addPage(); y = left; }
    const gstHalf = interState ? [money0(item.gst_amount)]
      : [money0(item.gst_amount / 2), money0(item.gst_amount / 2)];
    drawRow([String(i + 1), item.description, item.hsn_code || '-', String(item.qty),
      money0(item.unit_price), money0(item.total), money0(item.taxable_value), ...gstHalf], y, h);
    if (serials) {
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(MUTED);
      text(serials, cols[1].x + 4, y + 6 + nameHeight + 1, { width: cols[1].w - 8 });
    }
    y += h;
  });

  const gstTotals = interState ? [money0(invoice.igst)] : [money0(invoice.cgst), money0(invoice.sgst)];
  drawRow(['', 'Sub Total', '', '', '', money0(invoice.total), money0(invoice.subtotal), ...gstTotals],
    y, 20, { bold: true, fill: HEAD_BG });
  y += 20;

  const unitsTotal = items.reduce((s, it) => s + Number(it.qty), 0);
  drawRow(['', `Items Total  ${amount(unitsTotal)}`, '', '', '', '', 'Total', money0(invoice.total)],
    y, 22, { bold: true });
  y += 30;

  // ---- Product brief ----
  if (invoice.product_brief) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
    text('Product Brief :', left, y);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    text(invoice.product_brief, left, doc.y + 2, { width: width - 150 });
    y = doc.y + 8;
  }

  // ---- Amount in words ----
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
  text('Total In words', left, y);
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(INK);
  text(rupeesInWords(invoice.total), left, doc.y + 2, { width: width - 150 });
  y = doc.y + 12;

  // ---- Bank details, QR and signatory ----
  const qr = await qrDataUrl(invoice, business, baseUrl);
  const blockTop = y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
  text('Bank Details', left, blockTop);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  const bankLines = [
    business.bank_account_name ? `Account Name : ${business.bank_account_name}` : '',
    business.bank_account_no ? `A/c No            : ${business.bank_account_no}` : '',
    business.bank_branch_ifsc ? `Br & IFSC       : ${business.bank_branch_ifsc}` : '',
    !business.bank_account_name && !business.bank_account_no && business.bank_details ? business.bank_details : '',
  ].filter(Boolean);
  let bankY = blockTop + 13;
  bankLines.forEach((line) => { text(line, left, bankY, { width: 250 }); bankY = doc.y + 1; });

  if (qr.dataUrl) {
    doc.image(Buffer.from(qr.dataUrl.split(',')[1], 'base64'), left + 270, blockTop, { width: 62 });
    doc.fontSize(6.5).fillColor(MUTED);
    text(qr.mode === 'PAYMENT_UPI' ? 'Scan to pay' : 'Scan for details', left + 262, blockTop + 65,
      { width: 78, align: 'center' });
  }

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
  text(`For ${business.name}`, right - 190, blockTop, { width: 190, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  text(business.signatory_name || '', right - 190, blockTop + 44, { width: 190, align: 'right' });
  text('Authorized Signatory', right - 190, blockTop + 56, { width: 190, align: 'right' });
  y = Math.max(bankY, blockTop + 76) + 8;

  // ---- Terms and declaration ----
  if (business.terms) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
    text('Terms and Conditions:', left, y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    text(business.terms, left, doc.y + 2, { width: width - 20 });
    y = doc.y + 8;
  }
  if (business.declaration) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
    text('Declaration', left, y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    text(business.declaration, left, doc.y + 2, { width: width - 20 });
  }
  if (invoice.notes) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    text(`Notes: ${invoice.notes}`, left, doc.y + 6, { width: width - 20 });
  }

  // ---- Page footer ----
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    doc.font('Helvetica').fontSize(6.5).fillColor('#94a3b8');
    text(`This is a computer generated invoice.${pages.count > 1 ? `   Page ${i + 1} of ${pages.count}` : ''}`,
      left, 806, { width, align: 'center' });
  }
  doc.end();
}

module.exports = { renderInvoicePdf, qrPayload, qrDataUrl };
