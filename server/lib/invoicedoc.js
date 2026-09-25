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

/**
 * Item grid columns; widths sum to the printable width. `rate` is the GST rate
 * shared by every line, or null when lines carry different rates, in which case
 * the tax headers name the tax without a percentage.
 */
function columns(left, width, interState, rate) {
  const pct = (value) => (value === null ? '' : `${Number(value)}% `);
  const half = rate === null ? null : round2(rate / 2);
  const spec = interState
    ? [['#', 22, 'center'], ['Item & Description', 180, 'left'], ['HSN', 50, 'center'], ['Qty', 30, 'center'],
      ['Rate', 50, 'center'], ['Total\nIncl', 60, 'center'], ['Taxable\nAmount', 60, 'center'],
      [`${pct(rate)}IGST\nAmount`, 75, 'center']]
    : [['#', 22, 'center'], ['Item & Description', 170, 'left'], ['HSN', 50, 'center'], ['Qty', 25, 'center'],
      ['Rate', 45, 'center'], ['Total\nIncl', 55, 'center'], ['Taxable\nAmount', 55, 'center'],
      [`${pct(half)}CGST\nAmount`, 50, 'center'], [`${pct(half)}SGST\nAmount`, 55, 'center']];

  let x = left;
  return spec.map(([label, w, align]) => {
    const col = { label, x, w, align };
    x += w;
    return col;
  });
}

/** The single GST rate on an invoice, or null when its lines differ. */
function sharedRate(items) {
  const rates = [...new Set(items.map((i) => Number(i.gst_rate)))];
  return rates.length === 1 ? rates[0] : null;
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
  const rate = items.length ? sharedRate(items) : 18;

  // Everything below the grid is drawn at explicit positions, so page breaks are
  // ours to make: start a new page whenever the next block would not fit.
  const PAGE_BOTTOM = 790;
  const ensure = (y, needed) => {
    if (y + needed <= PAGE_BOTTOM) return y;
    doc.addPage();
    return left;
  };

  const LINE = '#000000';
  const INK = '#000000';

  const box = (x, y, w, h) => doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(LINE).stroke();
  const text = (value, x, y, opts = {}) => doc.text(value === null || value === undefined ? '' : String(value), x, y, opts);

  // ---- Seller header ----
  let y = left;
  box(left, y, width, 60);
  
  // Try loading logo
  const logoPath = path.join(__dirname, '../../public/img/logo.png');
  let hasLogo = false;
  if (fs.existsSync(logoPath)) {
    try {
      // Place logo at top right
      doc.image(logoPath, right - 60, y + 5, { fit: [50, 50], align: 'right', valign: 'top' });
      hasLogo = true;
    } catch(e) {}
  }

  doc.font('Times-Bold').fontSize(14).fillColor(INK);
  text(business.name || 'Tax Invoice', left, y + 5, { width, align: 'center' });
  doc.font('Times-Roman').fontSize(10);
  if (business.address) text(business.address, left, doc.y + 2, { width, align: 'center' });
  if (business.gstin) {
    doc.font('Times-Bold').fontSize(11);
    text(`GSTIN ${business.gstin}`, left, doc.y + 2, { width, align: 'center' });
  }

  y += 60;

  // ---- Invoice meta ----
  const metaH = 52;
  box(left, y, width, metaH);
  doc.moveTo(left + width * 0.5, y).lineTo(left + width * 0.5, y + metaH).strokeColor(LINE).stroke();
  
  const metaRows = [
    ['Invoice No.', invoice.invoice_no],
    ['Invoice Date.', invoice.invoice_date],
    ['Terms', invoice.payment_terms || business.default_payment_terms || 'Due on Receipt'],
    ['Due Date', invoice.due_date || invoice.invoice_date],
  ];
  
  doc.fontSize(9);
  metaRows.forEach(([label, value], i) => {
    const ry = y + 2 + i * 12;
    doc.font('Times-Roman');
    text(label, left + 4, ry, { width: 80 });
    doc.font('Times-Roman');
    text(value, left + 80, ry, { width: width * 0.5 - 84 });
  });

  doc.font('Times-Roman');
  text('Place Of Supply', left + width * 0.5 + 4, y + 2);
  text(`: ${invoice.place_of_supply || '-'}`, left + width * 0.5 + 100, y + 2);
  
  text('Payment', left + width * 0.5 + 4, y + 26);
  text(`: ${invoice.payment_mode || '-'} (${invoice.payment_status || '-'})`, left + width * 0.5 + 100, y + 26);
  y += metaH;

  // ---- Bill To / Ship To ----
  const partyH = 65;
  box(left, y, width, partyH);
  doc.moveTo(left + width / 2, y).lineTo(left + width / 2, y + partyH).strokeColor(LINE).stroke();
  const party = (title, name, address, extra, x) => {
    doc.font('Times-Bold').fontSize(10);
    text(title, x + 4, y + 2);
    box(x, y + 14, width / 2, 0); // underline title
    doc.font('Times-Roman').fontSize(9);
    text(name || '-', x + 4, y + 16, { width: width / 2 - 8 });
    if (address) text(address, x + 4, doc.y + 1, { width: width / 2 - 8, height: 22, ellipsis: true });
    if (extra) {
      doc.font('Times-Bold');
      text(extra, x + 4, y + partyH - 12, { width: width / 2 - 8 });
    }
  };
  party('Bill To', invoice.customer_name || 'Walk-in Customer', invoice.customer_address,
    invoice.customer_gstin ? `GSTIN                  ${invoice.customer_gstin}` : '', left);
  party('Ship To', invoice.ship_to_name || invoice.customer_name || 'Walk-in Customer',
    invoice.ship_to_address || invoice.customer_shipping_address || invoice.customer_address,
    invoice.customer_phone ? `Phone ${invoice.customer_phone}` : '', left + width / 2);
  y += partyH;

  // ---- Item grid ----
  const cols = columns(left, width, interState, rate);
  const headH = 24;
  const rowH = 14;

  const drawHeader = (top) => {
    box(left, top, width, headH);
    doc.font('Times-Bold').fontSize(9);
    cols.forEach((c, i) => {
      if (i) doc.moveTo(c.x, top).lineTo(c.x, top + headH).lineWidth(0.5).strokeColor(LINE).stroke();
      text(c.label, c.x + 2, top + 4, { width: c.w - 4, align: c.align });
    });
    return top + headH;
  };

  const money0 = (v) => amount(v);
  let currentY = drawHeader(ensure(y, headH + rowH));

  items.forEach((item, i) => {
    doc.font('Times-Roman').fontSize(9);
    const gstHalf = interState ? [money0(item.gst_amount)]
      : [money0(item.gst_amount / 2), money0(item.gst_amount / 2)];
    const cells = [String(i + 1), item.description, item.hsn_code || '-', String(item.qty),
      money0(item.unit_price), money0(item.total), money0(item.taxable_value), ...gstHalf];

    // A long description wraps, and the row grows to hold it.
    const tallest = Math.max(...cells.map((cell, ci) => doc.heightOfString(String(cell), { width: cols[ci].w - 4 })));
    const h = Math.max(rowH, Math.ceil(tallest) + 4);

    if (currentY + h > PAGE_BOTTOM) {
      doc.addPage();
      currentY = drawHeader(left);
      doc.font('Times-Roman').fontSize(9);
    }

    box(left, currentY, width, h);
    cols.forEach((c, ci) => {
      if (ci) doc.moveTo(c.x, currentY).lineTo(c.x, currentY + h).lineWidth(0.5).strokeColor(LINE).stroke();
      text(cells[ci], c.x + 2, currentY + 2, { width: c.w - 4, align: c.align });
    });
    currentY += h;
  });

  currentY = ensure(currentY, rowH * 2);
  // Sub Total Row
  doc.font('Times-Bold').fontSize(9);
  box(left, currentY, width, rowH);
  text('Sub Total', cols[4].x - 60, currentY + 2, { width: 56, align: 'right' });
  
  // Draw vertical lines for Sub Total row starting from col 5 (Total Incl)
  for (let i = 5; i < cols.length; i++) {
    doc.moveTo(cols[i].x, currentY).lineTo(cols[i].x, currentY + rowH).stroke();
  }
  
  const gstTotals = interState ? [money0(invoice.igst)] : [money0(invoice.cgst), money0(invoice.sgst)];
  const subtotals = [money0(invoice.total), money0(invoice.subtotal), ...gstTotals];
  subtotals.forEach((val, i) => {
    const ci = 5 + i;
    text(val, cols[ci].x + 2, currentY + 2, { width: cols[ci].w - 4, align: cols[ci].align });
  });
  currentY += rowH;
  
  // Total Row
  box(left, currentY, width, rowH);
  
  // Draw one vertical line before "Total" to separate the left and right halves
  doc.moveTo(cols[5].x, currentY).lineTo(cols[5].x, currentY + rowH).stroke();
  
  const unitsTotal = items.reduce((s, it) => s + Number(it.qty), 0);
  doc.font('Times-Roman');
  text(`Items Total ${amount(unitsTotal)}`, left + 2, currentY + 2);
  doc.font('Times-Bold');
  text('Total', cols[5].x + 2, currentY + 2);
  text(`₹ ${money0(invoice.total)}`, cols[6].x + 2, currentY + 2, { width: right - cols[6].x - 4, align: 'right' });
  currentY += rowH;
  y = currentY;

  // ---- Product brief ----
  if (invoice.product_brief || items.some(i => i.serials && i.serials.length)) {
    y = ensure(y, 40);
    doc.font('Times-Bold').fontSize(10);
    text('Product Brief :', left, y + 2);
    doc.font('Times-Italic').fontSize(8);
    let briefY = doc.y + 2;
    
    // Custom brief from manual input
    if (invoice.product_brief) {
      text(invoice.product_brief, left, briefY, { width: width - 10 });
      briefY = doc.y + 2;
    }
    
    // Auto serials brief
    items.forEach((item, i) => {
      if (item.serials && item.serials.length) {
        text(`${i + 1}. ST: ${item.serials.join(', ')}`, left, briefY, { width: width - 10 });
        briefY = doc.y + 2;
      }
    });
    
    y = briefY + 4;
  }
  doc.moveTo(left, y).lineTo(right, y).stroke();

  // ---- Amount in words ----
  y = ensure(y, 30);
  doc.font('Times-Roman').fontSize(9);
  text('Total In words', left, y + 2);
  doc.font('Times-Bold').fontSize(10);
  text(rupeesInWords(invoice.total), left, doc.y + 2, { width: width - 10 });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(right, y).stroke();

  // ---- Bank details, QR and signatory ----
  const qr = await qrDataUrl(invoice, business, baseUrl);
  const bankH = 100;
  y = ensure(y, bankH + 20);
  // No box here as per user request to simplify the footer
  
  doc.font('Times-Bold').fontSize(9);
  text('Bank Details', left, y + 2);
  
  const bankLines = [
    business.bank_account_name ? `Account Name : ${business.bank_account_name}` : '',
    business.bank_account_no ? `A/c No             : ${business.bank_account_no}` : '',
    business.bank_branch_ifsc ? `Br & IFSC        : ${business.bank_branch_ifsc}` : '',
    !business.bank_account_name && !business.bank_account_no && business.bank_details ? business.bank_details : '',
  ].filter(Boolean);
  
  let bankY = y + 14;
  bankLines.forEach((line) => { text(line, left, bankY, { width: 300 }); bankY += 12; });

  let qrBottomY = bankY;
  if (qr.dataUrl) {
    doc.image(Buffer.from(qr.dataUrl.split(',')[1], 'base64'), left + 2, bankY + 2, { width: 60 });
    qrBottomY = bankY + 65;
  }

  // Signatory
  doc.font('Times-Roman').fontSize(9);
  text(`For ${business.name}`, left + width * 0.6 + 4, y + 2, { width: width * 0.4 - 8, align: 'right' });
  text('Authorized Signatory', left + width * 0.6 + 4, y + bankH - 12, { width: width * 0.4 - 8, align: 'right' });
  
  y = Math.max(y + bankH, qrBottomY + 10);

  // ---- Terms and declaration ----
  y = ensure(y, 40 + (business.terms ? business.terms.split('\n').length * 10 : 0));
  doc.font('Times-Roman').fontSize(9);
  if (business.terms) {
    text('Terms and Conditions:', left, y + 2);
    const terms = business.terms.split('\n').map((t, i) => `${i + 1}. ${t.replace(/^\d+\.\s*/, '')}`);
    let ty = doc.y + 2;
    terms.forEach(t => { text(t, left, ty); ty += 10; });
    y = ty + 4;
  }
  
  doc.moveTo(left, y).lineTo(right, y).stroke();
  
  if (business.declaration) {
    y = ensure(y, 30);
    text('Declaration', left, y + 2);
    text(business.declaration, left, doc.y + 2, { width: width - 10 });
  }

  // ---- Page footer ----
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    doc.page.margins.bottom = 0;
    doc.font('Times-Roman').fontSize(7).fillColor('#999999');
    text(`This is a computer generated invoice.${pages.count > 1 ? `   Page ${i + 1} of ${pages.count}` : ''}`,
      left, 810, { width, align: 'center' });
  }
  
  doc.end();
}

module.exports = { renderInvoicePdf, qrPayload, qrDataUrl, columns, sharedRate };
