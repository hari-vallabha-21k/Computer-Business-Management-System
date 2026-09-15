'use strict';
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { settings } = require('../db');
const { round2 } = require('./util');

const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  if (mode === 'VERIFY_URL') {
    return { mode, data: `${baseUrl}/#/sales/invoice/${invoice.id}` };
  }
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

/** Render a tax invoice as a PDF and stream it to res. */
async function renderInvoicePdf(res, { invoice, items, business = settings(), baseUrl = '' }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  const left = 40;
  const right = 555;
  doc.fontSize(18).font('Helvetica-Bold').text(business.name || 'Tax Invoice', left, 40);
  doc.fontSize(9).font('Helvetica').fillColor('#444');
  if (business.address) doc.text(business.address, { width: 280 });
  const contact = [business.phone, business.email].filter(Boolean).join('  |  ');
  if (contact) doc.text(contact);
  if (business.gstin) doc.text(`GSTIN: ${business.gstin}`);

  doc.fillColor('#000').font('Helvetica-Bold').fontSize(14)
    .text(invoice.status === 'CANCELLED' ? 'TAX INVOICE (CANCELLED)' : 'TAX INVOICE', 320, 42, { width: 235, align: 'right' });
  doc.font('Helvetica').fontSize(9)
    .text(`Invoice No: ${invoice.invoice_no}`, 320, 64, { width: 235, align: 'right' })
    .text(`Date: ${invoice.invoice_date}`, { width: 235, align: 'right' })
    .text(`Status: ${invoice.status}`, { width: 235, align: 'right' });

  let y = 140;
  doc.moveTo(left, y - 10).lineTo(right, y - 10).strokeColor('#ccc').stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text('Bill To', left, y);
  doc.font('Helvetica').fontSize(9).fillColor('#333');
  doc.text(invoice.customer_name || 'Walk-in Customer', left, y + 14, { width: 260 });
  if (invoice.customer_address) doc.text(invoice.customer_address, { width: 260 });
  if (invoice.customer_phone) doc.text(`Phone: ${invoice.customer_phone}`);
  if (invoice.customer_gstin) doc.text(`GSTIN: ${invoice.customer_gstin}`);

  y = 215;
  const cols = [
    { label: '#', x: left, w: 20, align: 'left' },
    { label: 'Description', x: 62, w: 170, align: 'left' },
    { label: 'HSN', x: 235, w: 50, align: 'left' },
    { label: 'Qty', x: 288, w: 30, align: 'right' },
    { label: 'Rate', x: 320, w: 60, align: 'right' },
    { label: 'Disc', x: 382, w: 45, align: 'right' },
    { label: 'GST%', x: 429, w: 35, align: 'right' },
    { label: 'Amount', x: 465, w: 90, align: 'right' },
  ];
  doc.rect(left, y - 4, right - left, 18).fill('#f0f2f5');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(8.5);
  for (const c of cols) doc.text(c.label, c.x, y, { width: c.w, align: c.align });
  y += 20;

  doc.font('Helvetica').fontSize(8.5).fillColor('#222');
  items.forEach((item, i) => {
    if (y > 680) { doc.addPage(); y = 50; }
    const cells = [String(i + 1), item.description, item.hsn_code || '-', String(item.qty),
      Number(item.unit_price).toFixed(2), Number(item.discount).toFixed(2),
      `${item.gst_rate}%`, Number(item.total).toFixed(2)];
    cells.forEach((value, idx) => doc.text(value, cols[idx].x, y, { width: cols[idx].w, align: cols[idx].align }));
    y += 14;
    if (item.serials && item.serials.length) {
      doc.fillColor('#777').fontSize(7.5).text(`S/N: ${item.serials.join(', ')}`, 62, y, { width: 480 });
      doc.fillColor('#222').fontSize(8.5);
      y += 12;
    }
  });

  y += 6;
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').stroke();
  y += 10;

  const totalRow = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
      .text(label, 350, y, { width: 100, align: 'right' })
      .text(money(value), 452, y, { width: 103, align: 'right' });
    y += bold ? 18 : 14;
  };
  totalRow('Subtotal', invoice.subtotal);
  if (invoice.discount) totalRow('Discount', -invoice.discount);
  if (invoice.igst) totalRow('IGST', invoice.igst);
  else { totalRow('CGST', invoice.cgst); totalRow('SGST', invoice.sgst); }
  totalRow('Total', invoice.total, true);

  const qr = await qrDataUrl(invoice, business, baseUrl);
  const infoY = Math.max(y + 10, 620);
  if (qr.dataUrl) {
    doc.image(Buffer.from(qr.dataUrl.split(',')[1], 'base64'), left, infoY, { width: 90 });
    doc.fontSize(7.5).fillColor('#666')
      .text(qr.mode === 'PAYMENT_UPI' ? 'Scan to pay' : 'Scan for invoice details', left, infoY + 94, { width: 90, align: 'center' });
  }
  doc.fontSize(8.5).fillColor('#333');
  const notesX = qr.dataUrl ? 145 : left;
  let notesY = infoY;
  doc.font('Helvetica-Bold').text(`Payment: ${invoice.payment_mode || '-'} (${invoice.payment_status || '-'})`, notesX, notesY);
  notesY = doc.y + 4;
  doc.font('Helvetica');
  if (business.bank_details) { doc.text(business.bank_details, notesX, notesY, { width: 380 }); notesY = doc.y + 4; }
  if (invoice.notes) { doc.text(`Notes: ${invoice.notes}`, notesX, notesY, { width: 380 }); notesY = doc.y + 4; }
  if (business.terms) doc.fillColor('#777').fontSize(7.5).text(business.terms, notesX, notesY, { width: 380 });

  doc.fontSize(7.5).fillColor('#999')
    .text('This is a computer generated invoice.', left, 780, { width: right - left, align: 'center' });
  doc.end();
}

module.exports = { renderInvoicePdf, qrPayload, qrDataUrl };
