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
  let mode = (business.qr_mode || 'INVOICE_INFO').toUpperCase();
  if (business.upi_id && mode === 'INVOICE_INFO') mode = 'PAYMENT_UPI';

  if (mode === 'PAYMENT_UPI') {
    if (!business.upi_id) return { mode, data: '', note: 'No UPI ID configured in Settings.' };
    const params = new URLSearchParams({
      pa: business.upi_id, pn: business.name || 'Business', am: Number(invoice.total).toFixed(2),
      cu: business.currency || 'INR', tn: `Invoice ${invoice.invoice_no}`,
    });
    const queryString = params.toString().replace(/\+/g, '%20');
    return { mode, data: `upi://pay?${queryString}` };
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
    ? [['#', 22, 'center'], ['Item & Description', 180, 'left'], ['HSN', 50, 'center'], ['Qty', 30, 'center'],
      ['Rate', 50, 'center'], ['Total Incl\nGST', 60, 'center'], ['Taxable\nAmount', 60, 'center'], ['18% IGST\nAmount', 75, 'center']]
    : [['#', 22, 'center'], ['Item & Description', 170, 'left'], ['HSN', 50, 'center'], ['Qty', 25, 'center'],
      ['Rate', 45, 'center'], ['Total Incl\nGST', 55, 'center'], ['Taxable\nAmount', 55, 'center'],
      ['9% CGST\nAmount', 50, 'center'], ['9% SGST\nAmount', 55, 'center']];
  
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
  const fs = require('fs');
  const path = require('path');
  const doc = new PDFDocument({ size: 'A4', margin: 30, bufferPages: true });
  doc.pipe(res);

  const left = 30;
  const right = 565;
  const width = right - left;
  const interState = invoice.igst > 0;
  
  const LINE = '#000000';
  const INK = '#000000';

  const box = (x, y, w, h) => doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(LINE).stroke();
  const text = (value, x, y, opts = {}) => doc.text(value === null || value === undefined ? '' : String(value), x, y, opts);
  const hLine = (yPos, startX = left, w = width) => doc.moveTo(startX, yPos).lineTo(startX + w, yPos).lineWidth(0.5).strokeColor(LINE).stroke();
  const vLine = (xPos, startY, h) => doc.moveTo(xPos, startY).lineTo(xPos, startY + h).lineWidth(0.5).strokeColor(LINE).stroke();

  let y = left;

  // ---- Seller header ----
  const headerH = 75;
  box(left, y, width, headerH);
  
  const logoPath = path.join(__dirname, '../../public/img/logo.png');
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, left + 5, y + 5, { fit: [65, 65], align: 'left', valign: 'top' });
    } catch(e) {}
  }
  
  vLine(left + 75, y, headerH);

  doc.font('Times-Bold').fontSize(14).fillColor(INK);
  text(business.name || 'THIRUMALA COMPUTER SERVICES', left + 75, y + 5, { width: width - 75, align: 'center' });
  
  doc.font('Times-Roman').fontSize(10);
  if (business.address) text(business.address, left + 75, doc.y + 2, { width: width - 75, align: 'center' });
  if (business.gstin) {
    doc.font('Times-Bold').fontSize(11);
    text(`GSTIN ${business.gstin}`, left + 75, doc.y + 2, { width: width - 75, align: 'center' });
  }

  hLine(y + 60, left + 75, width - 75);
  doc.font('Times-Roman').fontSize(14);
  text('TAX INVOICE', left, y + 62, { width: width - 5, align: 'right' });

  y += headerH;

  // ---- Invoice meta ----
  const rowH = 14;
  const metaRows = [
    ['Invoice No.', invoice.invoice_no],
    ['Invoice Date.', invoice.invoice_date.split(' ')[0]],
    ['Terms', invoice.payment_terms || business.default_payment_terms || 'Due on Receipt'],
    ['Due Date', invoice.due_date ? invoice.due_date.split(' ')[0] : invoice.invoice_date.split(' ')[0]],
  ];
  
  const metaH = metaRows.length * rowH;
  box(left, y, width, metaH);
  vLine(left + width * 0.5, y, metaH); 
  vLine(left + 80, y, metaH); 
  
  doc.fontSize(9);
  metaRows.forEach(([label, value], i) => {
    const ry = y + i * rowH;
    if (i > 0) hLine(ry, left, width / 2);
    doc.font('Times-Roman');
    text(label, left + 2, ry + 3, { width: 76 });
    text(value, left + 82, ry + 3, { width: width * 0.5 - 84 });
  });

  doc.font('Times-Roman');
  text('Place Of Supply', left + width * 0.5 + 2, y + 3, { width: 90 });
  text(`: ${invoice.place_of_supply || 'Telangana(36)'}`, left + width * 0.5 + 90, y + 3);

  y += metaH;

  // ---- Bill To / Ship To ----
  const partyH = 65;
  box(left, y, width, partyH);
  vLine(left + width / 2, y, partyH);
  hLine(y + 14);
  
  const party = (title, name, address, extra, x) => {
    doc.font('Times-Bold').fontSize(10);
    text(title, x + 2, y + 3);
    doc.font('Times-Roman').fontSize(9);
    text(name || '-', x + 2, y + 17, { width: width / 2 - 4 });
    if (address) text(address, x + 2, doc.y + 1, { width: width / 2 - 4, height: 22, ellipsis: true });
    if (extra) {
      doc.font('Times-Bold');
      text(extra, x + 2, y + partyH - 12, { width: width / 2 - 4 });
    }
  };
  party('Bill To', invoice.customer_name || 'Walk-in Customer', invoice.customer_address,
    invoice.customer_gstin ? `GSTIN                  ${invoice.customer_gstin}` : '', left);
  party('Ship To', invoice.ship_to_name || invoice.customer_name || 'Walk-in Customer',
    invoice.ship_to_address || invoice.customer_shipping_address || invoice.customer_address,
    '', left + width / 2);
  y += partyH;

  // ---- Item grid ----
  const cols = columns(left, width, interState);
  const headH = 24;
  const minRows = 5;
  const numRows = Math.max(items.length, minRows);
  const itemsHeight = numRows * rowH;
  
  box(left, y, width, headH + itemsHeight);
  
  doc.font('Times-Bold').fontSize(9);
  cols.forEach((c, i) => {
    if (i) vLine(c.x, y, headH + itemsHeight);
    text(c.label, c.x + 2, y + 4, { width: c.w - 4, align: c.align });
  });
  hLine(y + headH);
  y += headH;

  const money0 = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let currentY = y;
  
  for (let i = 0; i < numRows; i++) {
    const item = items[i];
    if (item) {
      doc.font('Times-Roman').fontSize(9);
      const gstHalf = interState ? [money0(item.gst_amount)]
        : [money0(item.gst_amount / 2), money0(item.gst_amount / 2)];
        
      const cells = [String(i + 1), item.description, item.hsn_code || '-', String(item.qty),
        money0(item.unit_price), money0(item.total), money0(item.taxable_value), ...gstHalf];
        
      cells.forEach((cell, ci) => {
        text(cell, cols[ci].x + 2, currentY + 3, { width: cols[ci].w - 4, align: cols[ci].align });
      });
    }
    currentY += rowH;
    if (i < numRows - 1) hLine(currentY);
  }
  
  // Sub Total Row
  doc.font('Times-Bold').fontSize(9);
  box(left, currentY, width, rowH);
  text('Sub Total', cols[3].x, currentY + 3, { width: cols[4].x - cols[3].x + cols[4].w - 4, align: 'right' });
  
  for (let i = 5; i < cols.length; i++) vLine(cols[i].x, currentY, rowH);
  
  const gstTotals = interState ? [money0(invoice.igst)] : [money0(invoice.cgst), money0(invoice.sgst)];
  const subtotals = [money0(invoice.total), money0(invoice.subtotal), ...gstTotals];
  subtotals.forEach((val, i) => {
    const ci = 5 + i;
    text(val, cols[ci].x + 2, currentY + 3, { width: cols[ci].w - 4, align: cols[ci].align });
  });
  currentY += rowH;
  
  // Total Row
  box(left, currentY, width, rowH);
  vLine(cols[5].x, currentY, rowH);
  
  const unitsTotal = items.reduce((s, it) => s + Number(it.qty), 0);
  doc.font('Times-Roman');
  text(`Items Total ${Number(unitsTotal).toFixed(2)}`, left + 2, currentY + 3);
  doc.font('Times-Bold');
  text('Total', cols[5].x + 2, currentY + 3);
  text(`Rs. ${money0(invoice.total)}`, cols[6].x + 2, currentY + 3, { width: right - cols[6].x - 6, align: 'right' });
  currentY += rowH;
  y = currentY;

  // ---- Product brief ----
  const briefH = 36;
  box(left, y, width, briefH);
  if (invoice.product_brief || items.some(i => i.serials && i.serials.length) || items.length) {
    doc.font('Times-Bold').fontSize(9);
    text('Product Brief :', left + 2, y + 2);
    doc.moveTo(left + 2, y + 12).lineTo(left + 58, y + 12).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Times-Italic').fontSize(8);
    let parts = [];
    items.forEach((item, i) => {
      let desc = `${i + 1}. ${item.description}`;
      if (item.serials && item.serials.length) desc += ` ST:${item.serials.join(', ')}`;
      parts.push(desc);
    });
    text(parts.join('. '), left + 2, y + 14, { width: width - 4, height: briefH - 16, ellipsis: true });
  }
  y += briefH;

  // ---- Amount in words ----
  const wordsH = 26;
  box(left, y, width, wordsH);
  doc.font('Times-Roman').fontSize(9);
  text('Total In words', left + 2, y + 2);
  doc.font('Times-Bold').fontSize(10);
  text(rupeesInWords(invoice.total), left + 2, y + 13, { width: width - 4 });
  y += wordsH;

  // ---- Bank details, QR and signatory ----
  const bankH = 120;
  box(left, y, width, bankH);
  vLine(left + width * 0.6, y, bankH);
  
  doc.font('Times-Roman').fontSize(9);
  text('Bank Details', left + 2, y + 2);
  
  const bankLines = [
    business.bank_account_name ? `Account Name : ${business.bank_account_name}` : '',
    business.bank_account_no ? `A/cNo              : ${business.bank_account_no}` : '',
    business.bank_branch_ifsc ? `Br & IFSC        : ${business.bank_branch_ifsc}` : '',
    !business.bank_account_name && !business.bank_account_no && business.bank_details ? business.bank_details : '',
  ].filter(Boolean);
  
  let bankY = y + 14;
  bankLines.forEach((line) => { text(line, left + 2, bankY, { width: width * 0.6 - 4 }); bankY += 12; });

  const qr = await qrDataUrl(invoice, business, baseUrl);
  if (qr.dataUrl) {
    doc.image(Buffer.from(qr.dataUrl.split(',')[1], 'base64'), left + 2, bankY + 2, { width: 45 });
  }

  // Signatory
  doc.font('Times-Roman').fontSize(9);
  text(`For ${business.name || 'Thirumala Computer Services'}`, left + width * 0.6 + 4, y + 36, { width: width * 0.4 - 8, align: 'right' });
  text('Authorized Signatory', left + width * 0.6 + 4, y + bankH - 12, { width: width * 0.4 - 8, align: 'right' });
  y += bankH;

  // ---- Terms and declaration ----
  const footerH = 65;
  box(left, y, width, footerH);
  hLine(y + 40); 
  
  doc.font('Times-Roman').fontSize(8);
  if (business.terms) {
    text('Terms of Conditions:', left + 2, y + 2);
    const terms = business.terms.split('\n').map((t, i) => `${i + 1}. ${t.replace(/^\d+\.\s*/, '')}`);
    let ty = y + 12;
    terms.forEach(t => { text(t, left + 2, ty); ty += 9; });
  } else {
    text('Terms of Conditions:', left + 2, y + 2);
    text('1. Goods warranty covers asper the manufacturer terms', left + 2, y + 12);
    text('2. Physical damage of product must be checked on arrival.', left + 2, y + 21);
    text('3. warranty does not cover upon electric burning', left + 2, y + 30);
  }
  
  doc.font('Times-Roman').fontSize(8);
  text('Declaration', left + 2, y + 42);
  doc.fontSize(7);
  text(business.declaration || 'We declare that this invoice shows the actual charges of the Services described and that all particulars are true and correct.', left + 2, y + 52, { width: width - 4 });

  // ---- Page footer ----
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    doc.font('Times-Roman').fontSize(7).fillColor('#999999');
    text(`This is a computer generated invoice.${pages.count > 1 ? `   Page ${i + 1} of ${pages.count}` : ''}`,
      left, 810, { width, align: 'center' });
  }
  
  doc.end();
}

module.exports = { renderInvoicePdf, qrPayload, qrDataUrl };
