'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { db, settings } = require('./db');
const { AppError } = require('./lib/util');
const { authenticate, requireAuth, createUser } = require('./lib/auth');
const { loadInvoice } = require('./routes/invoices');
const { renderInvoicePdf, qrDataUrl } = require('./lib/invoicedoc');
const { partyRouter } = require('./routes/parties');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(authenticate);
/**
 * The shop leaves this open on the counter for days at a time, so a browser
 * holding on to an old copy of a screen is a real support problem. Every file
 * is revalidated on each load - a cheap 304 when nothing has moved - and the
 * page itself is never stored, so an update reaches the counter on the next
 * reload instead of whenever the browser decides its copy is stale.
 */
const noStale = (res, filePath) => {
  res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-store, must-revalidate' : 'no-cache');
};
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: noStale }));

app.get('/api/health', (req, res) => res.json({ ok: true, version: require('../package.json').version }));

app.use('/api/auth', require('./routes/misc').auth);

const api = express.Router();
api.use(requireAuth);
api.use('/products', require('./routes/products').router);
api.use('/hsn', require('./routes/hsn'));
api.use('/categories', require('./routes/categories'));
api.use('/inventory', require('./routes/inventory'));
api.use('/purchases', require('./routes/purchases'));
api.use('/invoices', require('./routes/invoices').router);
api.use('/returns', require('./routes/returns'));
api.use('/customers', partyRouter('customers'));
api.use('/suppliers', partyRouter('suppliers'));
api.use('/analytics', require('./routes/analytics'));
api.use('/reports', require('./routes/reports'));
api.use('/settings', require('./routes/misc').settingsRouter);
api.use('/users', require('./routes/misc').users);
api.use('/notifications', require('./routes/misc').notifications);

// Invoice PDF - streamed straight to the browser as a download.
api.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    const { invoice, items } = loadInvoice(Number(req.params.id));
    res.set('Content-Type', 'application/pdf');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Content-Disposition', `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="${invoice.invoice_no}.pdf"`);
    await renderInvoicePdf(res, {
      invoice, items, business: settings(),
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) { next(err); }
});

api.get('/invoices/:id/qr', async (req, res, next) => {
  try {
    const { invoice } = loadInvoice(Number(req.params.id));
    res.json(await qrDataUrl(invoice, settings(), `${req.protocol}://${req.get('host')}`));
  } catch (err) { next(err); }
});

app.use('/api', api);

app.use('/api', (req, res) => res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}` }));

// SPA fallback for hash-free deep links.
app.get(/^(?!\/api).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Nothing fails silently: every error comes back as JSON the UI can show (Section 32).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err instanceof AppError ? err.status : (err.status || 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || 'Something went wrong.',
    details: err.details,
    code: err.code,
  });
});

/**
 * Create the first admin so a fresh install can be signed into.
 *
 * The shop sets ADMIN_EMAIL and ADMIN_PASSWORD. When they have not, the
 * account still gets made - otherwise nobody could ever sign in - but with a
 * password drawn at random and printed once to the log, because a default
 * anybody could read in this file would be an open door on a public address.
 */
function ensureFirstAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count) return null;
  const email = process.env.ADMIN_EMAIL || 'owner@example.com';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  createUser({ name: 'Owner', email, password, role: 'ADMIN' });
  return { email, password, generated: !process.env.ADMIN_PASSWORD };
}

if (require.main === module) {
  const created = ensureFirstAdmin();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Computer Business Management System running on http://localhost:${port}`);
    if (created) {
      console.log(`First admin created -> ${created.email} / ${created.password}`);
      if (created.generated) {
        console.log('That password was generated because ADMIN_PASSWORD was not set. '
          + 'Write it down now - it is not stored anywhere else - and change it in Settings.');
      }
    }
  });
}

module.exports = { app, ensureFirstAdmin };
