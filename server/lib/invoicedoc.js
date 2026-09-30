'use strict';
/**
 * Tax invoice PDF, laid out to match the client's template:
 * seller block, invoice meta, Bill To / Ship To, an item grid with
 * Total Incl GST / Taxable Amount / CGST / SGST columns, product brief,
 * amount in words, bank details, signatory, terms and declaration.
 * Every block is sized to its content, so nothing is clipped and no block
 * reserves space it does not use.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { settings } = require('../db');
const { round2 } = require('./util');
const { splitGst, sumSplit } = require('./gst');
const { rupeesInWords } = require('./numberwords');

const amount = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LINE = '#000000';
const INK = '#000000';
const LOGO = path.join(__dirname, '../../public/img/logo.png');

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

/**
 * Item grid columns; widths sum to the printable width (535pt on A4). `rate` is
 * the GST rate shared by every line, or null when lines carry different rates,
 * in which case the tax headers name the tax without a percentage. Tax is
 * always shown as CGST + SGST, each half of the GST rate.
 */
function columns(left, width, rate = 18) {
  const half = rate === null ? null : round2(rate / 2);
  const tax = (name) => (half === null ? `${name}\nAmount` : `${name} (${half}%)\nAmount`);
  const spec = [['#', 22, 'center'], ['Item & Description', 168, 'left'], ['HSN/SAC', 52, 'center'],
    ['Qty', 28, 'center'], ['Rate', 50, 'right'], ['Total Incl\nGST', 58, 'right'], ['Taxable\nAmount', 57, 'right'],
    [tax('CGST'), 50, 'right'], [tax('SGST'), 50, 'right']];
  const scale = width / spec.reduce((sum, [, w]) => sum + w, 0);

  let x = left;
  return spec.map(([label, w, align]) => {
    const col = { label, x, w: w * scale, align };
    x += w * scale;
    return col;
  });
}

/** The single GST rate on an invoice, or null when its lines differ. */
function sharedRate(items) {
  const rates = [...new Set(items.map((i) => Number(i.gst_rate)))];
  return rates.length === 1 ? rates[0] : null;
}

/**
 * Invoice CGST and SGST for the Sub Total row: the sum of the lines' own
 * splits, so the columns always add up. Worked out from the lines rather than
 * read from the invoice, so invoices saved earlier (including ones that
 * stored IGST) print consistently too.
 */
function invoiceTaxSplit(items) {
  return sumSplit(items.map((i) => i.gst_amount));
}

/** What the Product Brief block prints: the typed brief, then any serial numbers sold. */
function briefText(invoice, items) {
  const serials = items.filter((i) => i.serials && i.serials.length)
    .map((i) => `${i.description} ST:${i.serials.join(', ')}`);
  if (invoice.product_brief) return [invoice.product_brief, ...serials].join('. ');
  return items.map((item, i) => {
    const sold = item.serials && item.serials.length ? ` ST:${item.serials.join(', ')}` : '';
    return `${i + 1}. ${item.description}${sold}`;
  }).join('. ');
}

const MIN_ROWS = 8;

/** Render a tax invoice as a PDF and stream it to res. */
async function renderInvoicePdf(res, { invoice, items, business = settings(), baseUrl = '' }) {
  const doc = new PDFDocument({ size: 'A4', margin: 30, bufferPages: true });
  doc.pipe(res);

  const left = 30;
  const right = 565;
  const width = right - left;
  const rate = items.length ? sharedRate(items) : 18;

  // Blocks are drawn at explicit positions, so page breaks are ours to make:
  // start a new page whenever the next block would not fit above the footer.
  const PAGE_BOTTOM = 800;
  const ensure = (top, needed) => {
    if (top + needed <= PAGE_BOTTOM) return top;
    doc.addPage();
    return left;
  };

  const box = (x, y, w, h) => doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(LINE).stroke();
  const text = (value, x, y, opts = {}) => doc.text(value === null || value === undefined ? '' : String(value), x, y, opts);
  const hLine = (yPos, startX = left, w = width) => doc.moveTo(startX, yPos).lineTo(startX + w, yPos).lineWidth(0.5).strokeColor(LINE).stroke();
  const vLine = (xPos, startY, h) => doc.moveTo(xPos, startY).lineTo(xPos, startY + h).lineWidth(0.5).strokeColor(LINE).stroke();
  const heightOf = (value, font, size, w) => doc.font(font).fontSize(size).heightOfString(String(value || ''), { width: w });

  doc.fillColor(INK);
  let y = left;

  // ---- Seller header: logo on the left, name/address/GSTIN centred ----
  const logoW = 140;
  const titleH = 18;
  const nameW = width - logoW - 8;
  const contact = [business.phone, business.email].filter(Boolean).join('  |  ');
  const sellerH = heightOf(business.name || 'THIRUMALA COMPUTER SERVICES', 'Times-Bold', 16, nameW)
    + (business.address ? heightOf(business.address, 'Times-Roman', 10, nameW) + 2 : 0)
    + (contact ? heightOf(contact, 'Times-Roman', 9, nameW) + 2 : 0)
    + (business.gstin ? 15 : 0);
  const headerH = Math.max(120, Math.ceil(sellerH) + titleH + 12);
  // The seller block sits centred in the space above the TAX INVOICE strip.
  const sellerTop = y + Math.max(6, (headerH - titleH - sellerH) / 2);
  box(left, y, width, headerH);
  if (fs.existsSync(LOGO)) {
    try {
      doc.image(LOGO, left + 6, y + 6, { fit: [logoW - 12, headerH - 12], align: 'center', valign: 'center' });
    } catch (e) { /* a broken logo file should not stop the invoice */ }
  }
  vLine(left + logoW, y, headerH);

  doc.font('Times-Bold').fontSize(16).fillColor(INK);
  text(business.name || 'THIRUMALA COMPUTER SERVICES', left + logoW + 4, sellerTop, { width: nameW, align: 'center' });
  doc.font('Times-Roman').fontSize(10);
  if (business.address) text(business.address, left + logoW + 4, doc.y + 2, { width: nameW, align: 'center' });
  if (contact) {
    doc.fontSize(9);
    text(contact, left + logoW + 4, doc.y + 2, { width: nameW, align: 'center' });
  }
  if (business.gstin) {
    doc.font('Times-Bold').fontSize(11);
    text(`GSTIN ${business.gstin}`, left + logoW + 4, doc.y + 2, { width: nameW, align: 'center' });
  }
  hLine(y + headerH - titleH, left + logoW, width - logoW);
  doc.font('Times-Bold').fontSize(13);
  text('TAX INVOICE', left + logoW, y + headerH - titleH + 3, { width: width - logoW - 6, align: 'right' });
  y += headerH;

  // ---- Invoice meta ----
  const rowH = 15;
  const metaRows = [
    ['Invoice No.', invoice.invoice_no],
    ['Invoice Date.', String(invoice.invoice_date).split(' ')[0]],
    ['Terms', invoice.payment_terms || business.default_payment_terms || 'Due on Receipt'],
    ['Due Date', String(invoice.due_date || invoice.invoice_date).split(' ')[0]],
  ];
  const metaH = metaRows.length * rowH;
  box(left, y, width, metaH);
  vLine(left + width * 0.5, y, metaH);
  vLine(left + 80, y, metaH);
  doc.font('Times-Roman').fontSize(9);
  metaRows.forEach(([label, value], i) => {
    const ry = y + i * rowH;
    if (i > 0) hLine(ry, left, width / 2);
    text(label, left + 3, ry + 4, { width: 76 });
    text(value, left + 83, ry + 4, { width: width * 0.5 - 86 });
  });
  text('Place Of Supply', left + width * 0.5 + 3, y + 4, { width: 90 });
  text(`: ${invoice.place_of_supply || 'Telangana(36)'}`, left + width * 0.5 + 90, y + 4, { width: width * 0.5 - 94 });
  y += metaH;

  // ---- Bill To / Ship To: tall enough for the longer address ----
  const half = width / 2 - 6;
  const billName = invoice.customer_name || 'Walk-in Customer';
  const billAddr = invoice.customer_address || '';
  const shipName = invoice.ship_to_name || invoice.customer_name || 'Walk-in Customer';
  const shipAddr = invoice.ship_to_address || invoice.customer_shipping_address || invoice.customer_address || '';
  const partyBody = (name, addr) => heightOf(name, 'Times-Roman', 9, half) + (addr ? heightOf(addr, 'Times-Roman', 9, half) + 1 : 0);
  const gstinLine = invoice.customer_gstin ? 13 : 0;
  const partyH = Math.ceil(Math.max(partyBody(billName, billAddr) + gstinLine, partyBody(shipName, shipAddr))) + 24;
  y = ensure(y, partyH);
  box(left, y, width, partyH);
  vLine(left + width / 2, y, partyH);
  hLine(y + 15);
  const party = (title, name, address, x, gstin) => {
    doc.font('Times-Bold').fontSize(10);
    text(title, x + 3, y + 3);
    doc.font('Times-Roman').fontSize(9);
    text(name, x + 3, y + 19, { width: half });
    if (address) text(address, x + 3, doc.y + 1, { width: half });
    if (gstin) {
      doc.font('Times-Bold');
      text(`GSTIN ${gstin}`, x + 3, doc.y + 2, { width: half });
    }
  };
  party('Bill To', billName, billAddr, left, invoice.customer_gstin);
  party('Ship To', shipName, shipAddr, left + width / 2);
  y += partyH;

  // ---- Item grid: at least eight rows, growing with long descriptions ----
  const cols = columns(left, width, rate);
  const headH = Math.ceil(Math.max(...cols.map((c) => heightOf(c.label, 'Times-Bold', 8.5, c.w - 4)))) + 8;
  const itemRowH = 16;
  const numRows = Math.max(items.length, MIN_ROWS);

  const drawHeader = (top) => {
    box(left, top, width, headH);
    doc.font('Times-Bold').fontSize(8.5);
    cols.forEach((c, i) => {
      if (i) vLine(c.x, top, headH);
      const labelH = doc.heightOfString(c.label, { width: c.w - 4 });
      text(c.label, c.x + 2, top + (headH - labelH) / 2, { width: c.w - 4, align: 'center' });
    });
    return top + headH;
  };

  let currentY = drawHeader(ensure(y, headH + itemRowH * 2));
  for (let i = 0; i < numRows; i += 1) {
    const item = items[i];
    let cells = [];
    if (item) {
      const [cgst, sgst] = splitGst(item.gst_amount);
      cells = [String(i + 1), item.description, item.hsn_code || '-', String(Number(item.qty)),
        amount(item.unit_price), amount(item.total), amount(item.taxable_value), amount(cgst), amount(sgst)];
    }
    doc.font('Times-Roman').fontSize(9);
    // A long description wraps, and its row grows to hold it.
    const tallest = cells.length
      ? Math.max(...cells.map((cell, ci) => doc.heightOfString(cell, { width: cols[ci].w - 4 })))
      : 0;
    const h = Math.max(itemRowH, Math.ceil(tallest) + 6);

    if (currentY + h > PAGE_BOTTOM) {
      doc.addPage();
      currentY = drawHeader(left);
      doc.font('Times-Roman').fontSize(9);
    }
    box(left, currentY, width, h);
    cols.forEach((c, ci) => {
      if (ci) vLine(c.x, currentY, h);
      if (cells.length) {
        if (ci === 0) doc.font('Times-Bold');
        text(cells[ci], c.x + 2, currentY + 4, { width: c.w - 4, align: c.align });
        if (ci === 0) doc.font('Times-Roman');
      }
    });
    currentY += h;
  }

  const qr = await qrDataUrl(invoice, business, baseUrl);
  const splitX = left + width * 0.6;
  const qrSize = 120;
  const bankW = splitX - left - qrSize - 14;

  const words = rupeesInWords(invoice.total);
  const wordsH = Math.ceil(heightOf(words, 'Times-Bold', 10, width - 6)) + 17;

  const bankLinesCalc = [
    business.bank_account_name ? `Account Name : ${business.bank_account_name}` : '',
    business.bank_account_no ? `A/c No             : ${business.bank_account_no}` : '',
    business.bank_branch_ifsc ? `Br & IFSC        : ${business.bank_branch_ifsc}` : '',
    !business.bank_account_name && !business.bank_account_no && business.bank_details ? business.bank_details : '',
  ].filter(Boolean);
  const bankTextHCalc = 16 + bankLinesCalc.reduce((sum, line) => sum + heightOf(line, 'Times-Roman', 9, bankW) + 2, 0);
  const bankHCalc = Math.ceil(Math.max(bankTextHCalc, qr.dataUrl ? qrSize + 16 : 0, 76));

  const termsCalc = business.terms
    ? business.terms.split('\n').map((t) => t.trim()).filter(Boolean).map((t, i) => `${i + 1}. ${t.replace(/^\d+\.\s*/, '')}`)
    : ['1. Goods warranty covers asper the manufacturer terms',
      '2. Physical damage of product must be checked on arrival.',
      '3. warranty does not cover upon electric burning'];
  const declarationCalc = business.declaration
    || 'We declare that this invoice shows the actual charges of the Services described and that all particulars are true and correct.';
  const termsHCalc = 13 + termsCalc.reduce((sum, t) => sum + heightOf(t, 'Times-Roman', 8, width - 6), 0) + 3;
  const declHCalc = 12 + heightOf(declarationCalc, 'Times-Roman', 7, width - 6) + 4;
  const footerHCalc = Math.ceil(termsHCalc + declHCalc);

  const briefStr = briefText(invoice, items);
  const briefHCalc = briefStr ? Math.ceil(heightOf(briefStr, 'Times-Italic', 8, width - 6)) + 20 : 0;

  const trailingH = rowH * 2 + briefHCalc + wordsH + bankHCalc + footerHCalc;

  if (currentY + trailingH < PAGE_BOTTOM) {
    const pad = PAGE_BOTTOM - (currentY + trailingH);
    box(left, currentY, width, pad);
    cols.forEach((c, ci) => {
      if (ci) vLine(c.x, currentY, pad);
    });
    currentY += pad;
  }

  currentY = ensure(currentY, rowH * 2);
  const [cgstTotal, sgstTotal] = invoiceTaxSplit(items);

  // Sub Total row
  doc.font('Times-Bold').fontSize(9);
  box(left, currentY, width, rowH);
  text('Sub Total', cols[3].x, currentY + 4, { width: cols[5].x - cols[3].x - 4, align: 'right' });
  for (let i = 5; i < cols.length; i += 1) vLine(cols[i].x, currentY, rowH);
  [amount(invoice.total), amount(invoice.subtotal), amount(cgstTotal), amount(sgstTotal)].forEach((val, i) => {
    const c = cols[5 + i];
    text(val, c.x + 2, currentY + 4, { width: c.w - 4, align: 'right' });
  });
  currentY += rowH;

  // Total row
  box(left, currentY, width, rowH);
  vLine(cols[5].x, currentY, rowH);
  const unitsTotal = items.reduce((s, it) => s + Number(it.qty), 0);
  doc.font('Times-Roman');
  text(`Items Total ${Number(unitsTotal).toFixed(2)}`, left + 3, currentY + 4);
  doc.font('Times-Bold');
  text('Total', cols[5].x + 3, currentY + 4);
  text(`Rs. ${amount(invoice.total)}`, cols[6].x + 2, currentY + 4, { width: right - cols[6].x - 6, align: 'right' });
  y = currentY + rowH;

  // ---- Product brief: only when there is something to say, as tall as it needs ----
  const brief = briefStr;
  if (brief) {
    const briefH = briefHCalc;
    y = ensure(y, briefH);
    box(left, y, width, briefH);
    doc.font('Times-Bold').fontSize(9);
    text('Product Brief :', left + 3, y + 3);
    doc.moveTo(left + 3, y + 13).lineTo(left + 60, y + 13).lineWidth(0.5).strokeColor(LINE).stroke();
    if (invoice.product_brief) {
      doc.font('Times-Italic').fontSize(8);
      text(brief, left + 3, y + 16, { width: width - 6 });
    } else {
      let isFirst = true;
      items.forEach((item, i) => {
        const sold = item.serials && item.serials.length ? ` ST:${item.serials.join(', ')}` : '';
        const numStr = isFirst ? `${i + 1}. ` : ` ${i + 1}. `;
        const isLast = i === items.length - 1;
        const descStr = isLast ? `${item.description}${sold}` : `${item.description}${sold}.`;
        
        doc.font('Times-Bold').fontSize(8);
        if (isFirst) {
          text(numStr, left + 3, y + 16, { width: width - 6, continued: true });
        } else {
          text(numStr, { continued: true });
        }
        
        doc.font('Times-Italic').fontSize(8);
        text(descStr, { continued: !isLast });
        
        isFirst = false;
      });
    }
    y += briefH;
  }

  // ---- Amount in words ----
  y = ensure(y, wordsH);
  box(left, y, width, wordsH);
  doc.font('Times-Roman').fontSize(9);
  text('Total In words', left + 3, y + 3);
  doc.font('Times-Bold').fontSize(10);
  text(words, left + 3, y + 14, { width: width - 6 });
  y += wordsH;

  // ---- Bank details and QR code | signatory ----
  const bankLines = bankLinesCalc;
  const bankH = bankHCalc;
  y = ensure(y, bankH);
  box(left, y, width, bankH);
  vLine(splitX, y, bankH);

  doc.font('Times-Bold').fontSize(9);
  text('Bank Details', left + 3, y + 3);
  doc.font('Times-Roman').fontSize(9);
  let bankY = y + 16;
  bankLines.forEach((line) => { text(line, left + 3, bankY, { width: bankW }); bankY = doc.y + 2; });
  if (qr.dataUrl) {
    const qrX = splitX - qrSize - 8;
    doc.image(Buffer.from(qr.dataUrl.split(',')[1], 'base64'), qrX, y + 4, { width: qrSize, height: qrSize });
    doc.font('Times-Roman').fontSize(7);
    text(qr.mode === 'PAYMENT_UPI' ? 'Scan to pay' : 'Scan for invoice details', qrX, y + qrSize + 5, { width: qrSize, align: 'center' });
  }

  doc.font('Times-Bold').fontSize(9);
  text(`For ${business.name || 'Thirumala Computer Services'}`, splitX + 4, y + 6, { width: right - splitX - 8, align: 'right' });
  doc.font('Times-Roman');
  if (business.signatory_name) text(business.signatory_name, splitX + 4, y + bankH - 26, { width: right - splitX - 8, align: 'right' });
  text('Authorized Signatory', splitX + 4, y + bankH - 13, { width: right - splitX - 8, align: 'right' });
  y += bankH;

  // ---- Terms and declaration, sized to their text ----
  const terms = termsCalc;
  const declaration = declarationCalc;
  const termsH = termsHCalc;
  const footerH = footerHCalc;
  y = ensure(y, footerH);
  box(left, y, width, footerH);
  hLine(y + termsH);

  doc.font('Times-Bold').fontSize(8);
  text('Terms of Conditions:', left + 3, y + 3);
  doc.font('Times-Roman').fontSize(8);
  let ty = y + 13;
  terms.forEach((t) => { text(t, left + 3, ty, { width: width - 6 }); ty = doc.y; });
  doc.font('Times-Bold').fontSize(8);
  text('Declaration', left + 3, y + termsH + 3);
  doc.font('Times-Roman').fontSize(7);
  text(declaration, left + 3, y + termsH + 13, { width: width - 6 });

  // ---- Page footer ----
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    doc.page.margins.bottom = 0; // writing the footer must not trigger another page
    doc.font('Times-Roman').fontSize(7).fillColor('#999999');
    text(`This is a computer generated invoice.${pages.count > 1 ? `   Page ${i + 1} of ${pages.count}` : ''}`,
      left, 810, { width, align: 'center' });
  }

  doc.end();
}

module.exports = { renderInvoicePdf, qrPayload, qrDataUrl, columns, sharedRate, splitGst, invoiceTaxSplit, MIN_ROWS };
