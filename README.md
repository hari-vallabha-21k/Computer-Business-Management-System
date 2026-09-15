# Computer Business Management System

A web application for a computer retailer/dealer to run the whole shop from one place:
products, HSN/GST, inventory, purchases, sales invoicing, customers, suppliers, returns
and analytics.

The guiding rule is **enter information once and reuse it everywhere** — once a product
carries its HSN, GST rate and price, invoicing it takes a search, a quantity and a
customer.

```
Purchase invoice → scan → review → stock automatically added
Customer sale    → invoice → issue → stock automatically reduced
Return           → select invoice → stock automatically restored
Every transaction → analytics dashboard updates itself
```

## Quick start

```bash
npm install
npm run seed      # optional: demo products, customers, sales and stock
npm start         # http://localhost:3000
```

Demo logins created by `npm run seed`:

| Role | Email | Password |
|---|---|---|
| Owner / Admin | owner@example.com | owner123 |
| Sales Staff | staff@example.com | staff123 |

Without seeding, the first run creates one admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
(default `owner@example.com` / `owner123`) and prints the credentials. Change the
password-holder in **Settings → Users** before using this with real data.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Database and uploads directory |
| `DB_FILE` | `./data/cbms.db` | SQLite database file |
| `SESSION_SECRET` | dev value | HMAC key for session tokens — **set this in production** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `owner@example.com` / `owner123` | First admin on an empty database |

Requires Node.js 22.5 or newer (it uses the built-in `node:sqlite`).

```bash
npm test          # 24 tests covering the business rules
npm run dev       # auto-restarting dev server
```

## How it is built

No build step, no framework: an Express API over SQLite, and a vanilla-JS single page
app served as static files.

```
server/
  index.js            HTTP server, route wiring, error handling, first-admin bootstrap
  db.js               Schema, transactions, document numbering
  lib/inventory.js    The one place stock ever changes; writes the ledger
  lib/gst.js          Line and invoice maths, CGST/SGST vs IGST
  lib/extract.js      Purchase-invoice reading and product matching
  lib/invoicedoc.js   PDF invoice + QR payloads
  lib/auth.js         Password hashing, signed session tokens, role gates
  routes/             products, hsn, inventory, purchases, invoices, returns,
                      parties (customers/suppliers), analytics, reports, misc
public/
  index.html, css/, js/api.js, js/ui.js, js/charts.js, js/pages/*
scripts/seed.js       Demo data
samples/              Example supplier invoices to try the scan flow with
tests/                Business-rule tests (node:test)
```

### Inventory is transaction-based

Stock is never edited directly. Every change writes a row to `inventory_transactions`
with its running balance, reference document and user:

```
Current stock = opening + purchases + returns − sales − damage ± adjustments
```

`products.stock` is the maintained balance, and the ledger is the audit trail — the
product page shows both and flags any mismatch. Movement types: `OPENING`, `PURCHASE`,
`SALE`, `RETURN`, `DAMAGE`, `ADJUSTMENT`, `CANCELLED_SALE`.

### Business rules enforced by the server

| Rule | Behaviour |
|---|---|
| 1 | A draft invoice does not touch inventory. |
| 2 | Issuing an invoice reduces stock and marks its serial numbers sold. |
| 3 | A return restores stock; returning more than was sold is rejected. |
| 4 | Adjustments require one of: damaged, lost, missing, warranty, correction, other. |
| 5 | A duplicate product name is refused unless explicitly forced. |
| 6 | HSN and GST come from the product master onto every invoice line. |
| 7 | Serial numbers are globally unique and only sellable while available. |
| 8 | Selling more than available stock is blocked unless the owner enables negative stock. |
| 9 | Extracted invoice data never changes inventory before the user confirms. |
| 10 | Every inventory change is logged with user, reference and reason. |

Cancelling an issued invoice restores the stock and releases its serial numbers.

### Purchase-invoice scanning

`POST /api/purchases/extract` reads an uploaded supplier invoice and returns a review
payload — it writes nothing. The UI shows the extracted header, the matched products
with a confidence score, and a per-line verification flag; inventory changes only when
the user presses **Confirm & Add to Inventory**.

What it can read, entirely locally with no external service:

- PDFs **with a text layer** (content streams are inflated and the text operators read)
- CSV / TSV / plain-text invoices, either delimited or `… <hsn> <qty> <rate> <amount>` rows

What it cannot read: a photo or a scanned image of a paper invoice — there is no text
layer and no OCR engine bundled. Rather than failing quietly it says so and points at
manual entry, and a notification is recorded. Wiring in an OCR or LLM extraction service
means replacing `readText()` in `server/lib/extract.js`; the review-and-confirm flow
around it stays as is.

Product matching is a token-overlap score that weights model numbers, with an HSN-match
bonus and an exact-name override. Lines scoring below 0.75 are flagged for verification,
and unmatched lines can either be pointed at an existing product or created as new ones
on confirmation.

Try it with `samples/sample-supplier-invoice.txt` or `samples/sample-supplier-invoice.csv`.

### Invoices, GST and QR

Prices are GST-exclusive and discounts apply per line. Tax splits CGST/SGST, or IGST when
the customer's GSTIN state code differs from the business's. Invoices download as a
generated PDF and print from the browser.

The invoice QR code is configurable in Settings:

- **Invoice information** (default) — seller, GSTIN, invoice number, date and total
- **UPI payment** — a `upi://pay` string for the invoice amount
- **Verification link** — a URL back to the invoice in this system

Official GST e-invoicing (IRN and the signed government QR) is a separate compliance
integration and is deliberately **not** produced by these modes.

### Roles

**Owner / Admin** can do everything. **Sales staff** can search stock, manage customers,
and create and issue invoices, but cannot change products, HSN, settings or users, and
cannot record stock adjustments. Roles are enforced server-side, not just hidden in the UI.

## API

All endpoints live under `/api` and need a bearer token (or the session cookie) from
`POST /api/auth/login`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Products | `GET/POST /products`, `GET/PUT/DELETE /products/:id`, `GET /products/filters`, `POST /products/match` |
| HSN | `GET/POST /hsn`, `PUT/DELETE /hsn/:id` |
| Inventory | `GET /inventory/movements`, `GET /inventory/low-stock`, `POST /inventory/add-stock`, `POST /inventory/adjust`, `GET/POST /inventory/serials` |
| Purchases | `GET/POST /purchases`, `GET /purchases/:id`, `POST /purchases/extract` |
| Sales | `GET/POST /invoices`, `GET/PUT/DELETE /invoices/:id`, `POST /invoices/:id/issue`, `POST /invoices/:id/cancel`, `POST /invoices/:id/serials`, `GET /invoices/:id/pdf`, `GET /invoices/:id/qr` |
| Returns | `GET /returns`, `GET /returns/invoice/:invoiceNo`, `POST /returns` |
| Parties | `GET/POST /customers`, `GET/POST /suppliers`, `GET/PUT/DELETE /:id` on both |
| Analytics | `GET /analytics/dashboard`, `/sales-trend`, `/by-product`, `/by-category`, `/by-hsn`, `/inventory` |
| Reports | `GET /reports`, `GET /reports/:name` (`?format=csv` to download) |
| Admin | `GET/PUT /settings`, `GET/POST/PUT /users`, `GET /notifications`, `POST /notifications/read` |

Errors always come back as JSON with a readable `error` message, and stock failures
include `details` (requested vs available) so the UI can suggest the fix.

## Scope

Delivered: the whole of Phase 1 (authentication, dashboard, products, HSN, inventory,
purchases, sales, customers, suppliers, invoice generation with automatic stock
deduction, adjustments, returns, analytics) plus most of Phase 2 — purchase-invoice
extraction, product matching, serial tracking, HSN analytics, CSV reports and
notifications.

Not included, and needing decisions or third-party services: OCR for photographed
invoices, official GST e-invoice/IRN integration, payment gateway integration,
automated backups, and accounting-package exports beyond CSV.

Gross profit here is revenue excluding GST minus the recorded cost of goods sold. It is
not net business profit — rent, salaries and other expenses are not tracked.
