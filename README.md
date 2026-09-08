# Scent Nest

Premium fragrance decant e-commerce platform. Customers order 3ml, 5ml or 10ml
vials of authentic perfumes and pay cash on delivery anywhere in Bangladesh.

CSE482L / ETE334L, North South University — Summer 2026.
Ajmain Ahmed Prottay (1821756642).

---

## Running it in VS Code

**1.** Open the folder in VS Code (File → Open Folder).

**2.** Open the terminal (Ctrl + `) and install:

```bash
npm install
```

Needs Node 18 or newer — check with `node -v`.

**3.** Set up MongoDB Atlas: create a free M0 cluster, add a database user
under Database Access, and under Network Access allow `0.0.0.0/0`. Netlify's
functions run from IPs you can't predict, so a narrow allowlist won't work.

Copy the connection string from Database → Connect → Drivers.

**4.** Rename `.env.example` to `.env` and fill in `MONGODB_URI`. For the
signing secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**5.** Load the database and make yourself an admin:

```bash
npm run seed
node create-admin.js you@example.com "Your Name" 01712345678 YourPassword
```

**6.** Start it:

```bash
npm start
```

Open http://localhost:3000.

`server.js` calls the same handler functions Netlify runs in production, so
what works locally works deployed. Edits to anything in `functions/` take
effect on the next request — no restart. Changes to `server.js` itself need
Ctrl+C and `npm start` again.

---

## Files

Everything sits in one folder. The only subfolder is `functions/`, and it has
to exist: Netlify turns every file in the functions directory into its own
HTTP endpoint, so shared code can't live there. That's why `core.js` and
`matcher.js` are at the root instead.

```
index.html          landing page
styles.css          all styling
app.js              API client, session, and the localStorage cart

server.js           local dev server — not deployed, just for VS Code
core.js             database pool, JWT, validation, pricing rules
matcher.js          note-similarity engine
seed.js             creates indexes, categories, products
create-admin.js     promotes an account to admin

functions/
  auth.js           register, login, profile
  products.js       catalog, search, admin CRUD
  orders.js         COD checkout, tracking, reports
  reviews.js        ratings and moderation
  match.js          "we don't stock that — here's the closest"

netlify.toml        build + routing config
package.json
.env                your secrets (never committed)
```

---

## The optional reference catalog

The note-matching feature compares what a customer searched for against what
you have in stock. It needs the fragrance dataset:

```bash
node seed.js --reference ./fra_cleaned.csv
```

Put `fra_cleaned.csv` in this folder first. It imports about 24,000
fragrances in batches of 1,000, taking a minute or so. Skip this and
everything else still works — only `/api/match` goes quiet.

---

## API

Responses are `{ ok: true, data }` or `{ ok: false, error, details? }`, where
`details` maps field names to messages the frontend paints onto forms.
Protected routes need `Authorization: Bearer <token>`.

| Method | Route | Who |
|---|---|---|
| POST | `/api/auth/register` · `/api/auth/login` | anyone |
| GET · PUT | `/api/auth/me` | signed in |
| GET | `/api/products` · `/api/products/filters` · `/api/products/:id` | anyone |
| POST · PUT · DELETE | `/api/products` · `/api/products/:id` | admin |
| PATCH | `/api/products/:id/stock` | admin |
| POST | `/api/orders` | anyone, guest checkout allowed |
| GET | `/api/orders/track?ref=&phone=` | anyone with both |
| GET | `/api/orders/mine` | signed in |
| GET | `/api/orders` · `/api/orders/report` · `/api/orders/:id` | admin |
| PUT | `/api/orders/:id/status` | admin |
| GET | `/api/reviews?product_id=` | anyone |
| POST | `/api/reviews` | signed in, delivered order only |
| GET · PUT · DELETE | `/api/reviews/pending` · `/api/reviews/:id/moderate` · `/api/reviews/:id` | admin |
| GET | `/api/match/search?q=` · `/api/match?reference_id=` | anyone |

Catalog filters: `q`, `brand`, `scent`, `gender`, `category`, `size`,
`min_price`, `max_price`, `in_stock`, `sort`, `page`, `limit`.

---

## Decisions worth knowing

**Prices never come from the browser.** The cart stores them for display, but
`POST /api/orders` recomputes every line from `price_per_ml` in the database.
Editing localStorage changes what you see, not what you're charged.

**Stock is millilitres, not units.** One pool per fragrance, because one
bottle serves every decant size. A 5ml order deducts 5ml from the same number
a 10ml order draws on, so you maintain one figure per product instead of three.

**Checkout can't oversell.** Stock decrements through a guarded update whose
filter requires the millilitres to still be there. Two people buying the last
vial at the same moment can't both succeed, and if any line fails partway
through, what was already taken goes back before the error returns.

**Deletes are soft.** Removing a product sets `is_active: false` so past
`order_items` rows still resolve. `?hard=true` deletes for real.

**One database connection per warm function.** The connection promise is
cached on `global`, because Netlify freezes functions between invocations
rather than destroying them. Connecting per request would exhaust the Atlas
free tier's connection limit.

---

## Deploying

Push to GitHub, then in Netlify: Add new site → Import an existing project.
Build settings come from `netlify.toml`.

Add every variable from your `.env` under **Site configuration → Environment
variables**. `.env` is gitignored and never reaches Netlify by itself.

One note on the flat layout: with `publish = "."`, Netlify serves the whole
folder, which would expose `core.js` and `seed.js` as readable text. They hold
no secrets — those live in environment variables — but if you'd rather they
weren't public, move the HTML, CSS and `app.js` into a `public/` folder and
change `publish` to `"public"`. The local server already refuses them either
way.

---

## Still to build

- `shop.html` — filter sidebar and search (FR-02)
- `product.html` — size selector, reviews, closest-match panel (FR-03, FR-08)
- `cart.html`, `checkout.html` — COD checkout (FR-04, FR-05)
- `account.html` — order tracking timeline (FR-06)
- `admin.html` — metrics, orders, inventory (FR-09, FR-10)

`index.html` currently renders from a product array inside the page, so it
works before the database is set up. Point it at `API.products.list()` once
you've seeded.
