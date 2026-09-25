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
npm test          # 53 tests: business rules, scanning, multi-invoice, invoice template, screens
npm run dev       # auto-restarting dev server
```

## How it is built

No build step, no framework: an Express API over SQLite, and a vanilla-JS single page
app served as static files.

### The interface

The screens follow the **Retail Manager** design: a dark sidebar whose sections open
onto their own pages, a topbar with one search box across products, invoices, customers
and serial numbers, and one set of patterns everywhere.

| Pattern | Rule |
|---|---|
| Actions | One primary button per page, top right. Everything secondary is a plain link; rare actions live in a **More ⋮** menu, and red buttons appear only inside a confirmation dialog. |
| Rows | Table rows are clickable — no "View" buttons. |
| Status | Always text plus colour: In Stock, Low Stock, Out of Stock, Issued, Draft, Cancelled, Needs review. |
| Auto-filled data | Shown in a blue panel that says where it came from, so nothing is typed twice. |
| Loading | Skeletons of the answer, never a full-screen spinner. |
| Errors | Plain language, what happened, and what to do next. |
| Phones | Under 900px the sidebar becomes a drawer, tables become cards, and touch targets grow. |
| Text size | Settings → Preferences offers Normal / Large / Extra large for reading across the counter. |

Type is Cormorant Garamond for page titles and DM Sans for everything else, loaded from
Google Fonts; offline the system font stack takes over and the layout is unchanged.

```
server/
  index.js            HTTP server, route wiring, error handling, first-admin bootstrap
  db.js               Schema, transactions, document numbering
  lib/inventory.js    The one place stock ever changes; writes the ledger
  lib/gst.js          Line and invoice maths, GST-inclusive rates, CGST/SGST vs IGST
  lib/states.js       GST state codes -> place of supply
  lib/numberwords.js  Amount in words, Indian numbering
  lib/extract.js      Purchase-invoice reading and product matching
  lib/xlsx.js         Minimal .xlsx reader (ZIP + sheet XML), no dependencies
  lib/invoicedoc.js   Template PDF invoice + QR payloads
  lib/auth.js         Password hashing, signed session tokens, role gates
  lib/permissions.js  What sales staff may do, enforced server-side
  lib/xlsxwrite.js    Minimal .xlsx writer for the report exports
  routes/             products, categories, hsn, inventory, purchases, invoices, returns,
                      parties (customers/suppliers), analytics, reports, misc
public/
  index.html, css/, js/api.js, js/ui.js, js/pages/*
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

The database upgrades itself in place on startup, so an existing installation picks up the
invoice-template columns without a manual migration step.

Cancelling an issued invoice restores the stock and releases its serial numbers.

### Purchase-invoice scanning

`POST /api/purchases/extract` reads an uploaded supplier invoice and returns a review
payload — it writes nothing. The UI shows the extracted header, the matched products
with a confidence score, and a per-line verification flag; inventory changes only when
the user presses **Confirm & Add to Inventory**.

Invoices can be uploaded **one at a time or many at once**, from two places:

- **Inventory → Add Product** pools every product line found across all the selected
  invoices into one review list. Lines that already match a product are marked and left
  unticked; the rest are created in a single confirmed step, optionally booking their
  quantities in as stock (one purchase per invoice, so cost history stays per supplier bill).
- **Purchases → Add Purchase** queues the selected invoices and walks through them one at a
  time — each is reviewed and confirmed as its own purchase.

What it can read, entirely locally with no external service:

- PDFs **with a text layer** — content streams are inflated and both literal and hex show-text
  operands are decoded, so ordinary single-byte-encoded PDFs (including the ones this system
  generates) come back as text
- **Excel workbooks** (`.xlsx`) — the ZIP parts are inflated and the sheet XML read directly,
  so an invoice kept as a spreadsheet is parsed like any other table
- CSV / TSV / plain-text invoices, either delimited or `… <hsn> <qty> <rate> <amount>` rows

What it cannot read: a photo or a scanned image of a paper invoice — there is no text
layer and no OCR engine bundled. Rather than failing quietly it says so and points at
manual entry, and a notification is recorded. Wiring in an OCR or LLM extraction service
means replacing `readText()` in `server/lib/extract.js`; the review-and-confirm flow
around it stays as is.

Product matching is a token-overlap score that weights model numbers, with an exact-name
override and a small bonus when the HSN also matches (only on a line that already looks
like a match, so a shared HSN never invents one). Lines scoring below 0.75 are flagged for verification,
and unmatched lines can either be pointed at an existing product or created as new ones
on confirmation.

Try it with `samples/sample-supplier-invoice.txt` or `samples/sample-supplier-invoice.csv`.

### Invoices, GST and QR

The invoice follows the GST tax-invoice template supplied by the business, on screen and
in the generated PDF:

```
Seller block (name, address, GSTIN)                         TAX INVOICE
Invoice No. / Invoice Date / Terms / Due Date    Place Of Supply / Payment
Bill To                                          Ship To
# | Item & Description | HSN | Qty | Rate | Total Incl GST | Taxable Amount | 9% CGST | 9% SGST
Sub Total                          Items Total / Total
Product Brief
Total In words
Bank Details          QR          For <Business> / Authorized Signatory
Terms and Conditions
Declaration
```

**Prices can include GST.** With *Selling prices include GST* on (the default, matching the
template), a rate of ₹55,500 x 2 prints as ₹1,11,000 incl GST, ₹94,067.80 taxable and
₹8,466.10 each of CGST and SGST — the tax is backed out of the quoted price. With it off,
GST is added on top. The setting lives in Settings → Pricing & Stock Rules and is recorded
on each invoice, so old invoices keep the basis they were raised on.

Tax splits CGST/SGST, or becomes IGST when the customer's GSTIN state code differs from the
business's; *Place of Supply* is derived from the same code (`36` → `Telangana(36)`).
*Terms* such as "Net 30" set the due date automatically. The amount is written out in Indian
numbering ("Rupees One Lakh Thirteen Thousand Only"). Invoices download as a generated PDF
and print from the browser.

**Invoice numbering** follows a configurable format with the tokens `{PREFIX}`, `{SEQ}`,
`{SEQ3}`–`{SEQ6}`, `{MM}`, `{YY}`, `{YYYY}` and `{FY}` — `TCS/{MM}{YY}/{SEQ4}` produces
`TCS/0826/0053`.

The invoice QR code is configurable in Settings:

- **Invoice information** (default) — seller, GSTIN, invoice number, date and total
- **UPI payment** — a `upi://pay` string for the invoice amount
- **Verification link** — a URL back to the invoice in this system

Official GST e-invoicing (IRN and the signed government QR) is a separate compliance
integration and is deliberately **not** produced by these modes.

### Roles and permissions

**Owner / Admin** can do everything. **Sales staff** can search stock, manage customers
and raise invoices, but cannot change products, HSN, settings or users, and cannot open
purchases, suppliers, analytics or reports.

Beyond that the owner decides, in **Settings → Users & Roles**, what staff may do:

| Permission | Default | What it gates |
|---|---|---|
| Create invoices | on | Creating, editing and issuing invoices |
| Add stock | on | Booking stock in and recording serial numbers |
| Add and edit customers | on | Saving customer details |
| See serial numbers | on | The serial-number lookup |
| Give discounts | off | Any discount on an invoice line or total |
| Cancel invoices | off | Cancelling an issued invoice |
| See purchase prices and profit | off | Cost, margin and stock-value figures |

Every one of these is checked on the server, not merely hidden in the UI — a staff
account that tries the API directly gets a 403 with a readable explanation.

### Categories carry the tax

A category holds the default HSN code and GST rate for the products in it, editable in
**Settings → Tax / GST**. Choosing "Laptops" on a new product fills in the HSN and GST,
which then flow on to every purchase and invoice line. "Entered once" starts one level
above the product.

## API

All endpoints live under `/api` and need a bearer token (or the session cookie) from
`POST /api/auth/login`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Products | `GET/POST /products`, `POST /products/bulk`, `GET/PUT/DELETE /products/:id`, `GET /products/filters`, `POST /products/match` |
| Categories | `GET/POST /categories`, `PUT /categories`, `PUT /categories/:id` |
| HSN | `GET/POST /hsn`, `PUT/DELETE /hsn/:id` |
| Inventory | `GET /inventory/movements`, `GET /inventory/low-stock`, `POST /inventory/add-stock`, `POST /inventory/adjust`, `GET/POST /inventory/serials`, `GET /inventory/serials/:id` |
| Purchases | `GET/POST /purchases`, `GET /purchases/:id`, `POST /purchases/:id/checked`, `POST /purchases/extract` |
| Sales | `GET/POST /invoices`, `GET/PUT/DELETE /invoices/:id`, `POST /invoices/:id/issue`, `POST /invoices/:id/cancel`, `POST /invoices/:id/serials`, `GET /invoices/:id/pdf`, `GET /invoices/:id/qr` |
| Returns | `GET /returns`, `GET /returns/invoice/:invoiceNo`, `POST /returns` |
| Parties | `GET/POST /customers`, `GET/POST /suppliers`, `GET/PUT/DELETE /:id` on both |
| Analytics | `GET /analytics/dashboard`, `/sales-trend`, `/by-product`, `/by-category`, `/by-hsn`, `/inventory` |
| Reports | `GET /reports`, `GET /reports/:name` (`?format=csv` or `?format=xlsx` to download, `?category=` / `?productId=` to narrow) |
| Admin | `GET/PUT /settings`, `GET /settings/backup`, `GET/POST/PUT /users`, `GET /notifications`, `POST /notifications/read` |

Errors always come back as JSON with a readable `error` message, and stock failures
include `details` (requested vs available) so the UI can suggest the fix.

## Scope

The invoice layout, its column set and its GST-inclusive arithmetic come from the tax
invoice template supplied by the business; demo data uses that layout with placeholder
bank and customer details.

Delivered: the whole of Phase 1 (authentication, dashboard, products, HSN, inventory,
purchases, sales, customers, suppliers, invoice generation with automatic stock
deduction, adjustments, returns, analytics) plus most of Phase 2 — purchase-invoice
extraction, product matching, serial tracking, HSN analytics, CSV reports and
notifications.

A stock adjustment is entered the way it is counted — type the number on the shelf and
the ledger records the difference — and every adjustment still needs one of the six
reasons.

Not included, and needing decisions or third-party services: OCR for photographed
invoices, official GST e-invoice/IRN integration, payment gateway integration,
scheduled off-site backups (Settings → Backup downloads a copy on demand), other
languages, and accounting-package exports beyond CSV and Excel.

Gross profit here is revenue excluding GST minus the recorded cost of goods sold. It is
not net business profit — rent, salaries and other expenses are not tracked.
