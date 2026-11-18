# PuTTY Commands — shopifydemo.cskills.me

The commands we run on the dev server over PuTTY (SSH), and a log of the fixes we made there.

- Server user: `cskills-shopifydemo`
- App folder: `~/htdocs/shopifydemo.cskills.me`
  - `shopify-backend/`: NestJS API, port **3008**, runs under PM2 as `shopify-backend`
  - `shopify-forntend/`: React app. Nginx serves `dist/`.
- Database: PostgreSQL `shopify_app_db` on `localhost:5432` (schema `public`)

---

## 1. Normal update (after pushing new code)

### Backend

```bash
cd ~/htdocs/shopifydemo.cskills.me/shopify-backend
git pull
npm ci                                  # also runs "prisma generate"
npx prisma migrate deploy               # applies any new migrations
npm run build
pm2 restart shopify-backend --update-env
pm2 logs shopify-backend --lines 20     # look for "Nest application successfully started"
```

### Frontend

```bash
cd ~/htdocs/shopifydemo.cskills.me/shopify-forntend
git pull
npm ci
npm run build                           # uses .env.production, writes dist/
```

### Check

```bash
curl -i https://shopifydemo.cskills.me/api/products
# Expected: HTTP 401 "Missing Shopify session token"
# HTTP 200 here means auth is OFF on the server. See section 3.
```

---

## 2. Fix log: 17 Nov 2026

### Problem 1: Products page crashed with `e.tags is not iterable`

**Cause:** the server was running an **old backend build**. Its products had no `tags`, `vendor`, `status` or other newer fields. The new frontend expects `tags` to always be an array, so the page crashed.

**How we found it:**

```bash
curl -s https://shopifydemo.cskills.me/api/products
# returned products with only id, name, sku, description, price, stock, createdAt, updatedAt
# and HTTP 200 without a token (auth not working either)
```

**Fix:** deploy the current backend (section 1). That led to Problem 2.

### Problem 2: `npx prisma migrate deploy` failed with P3005

```
Error: P3005
The database schema is not empty.
```

**Cause:** the old app created the database tables itself, without Prisma migrations. Prisma found tables but no `_prisma_migrations` history, so it refused to touch them.

**Why we did NOT baseline:** baselining (`prisma migrate resolve --applied 0_init`) only marks the migration as applied. The old `products` table was missing the new columns, so the backend would still have crashed.

**Fix:** the only data was one test product, so we reset the database and applied the migrations from scratch:

```bash
cd ~/htdocs/shopifydemo.cskills.me/shopify-backend

grep DATABASE_URL .env                  # make sure it points at shopify_app_db
npx prisma migrate reset                # DROPS ALL TABLES in public, then applies 0_init + add_shops
                                        # answer "y" (or add --force)
npx prisma generate
npm run build
pm2 restart shopify-backend --update-env
```

> ⚠️ `migrate reset` deletes **all data** in the database. Only use it when the data can be thrown away. To keep the data, back it up with `pg_dump` first, then apply the diff from `npx prisma migrate diff` by hand and baseline it.

After the reset the database is empty. Products come back by importing them from the Shopify store.

### Problem 3: "Shopify denied access: the app needs the read_locations / read_inventory scope"

**Cause:** the app version installed in the store didn't have the access scopes the product sync and import need. This is fixed in Shopify, not on the server.

**Fix (Shopify Dev Dashboard):**

1. App → **Versions** → **Create version**
2. **Access scopes**: `write_products, write_inventory, read_inventory, read_locations`
3. **Release** the version
4. Store admin → **Apps** → open the app → **approve** the new permissions

**Check:** open the app in the store admin and call `GET /api/shop`. All four scopes should be listed.

**If the error is still there after approving**, force a new access token:

```bash
psql "$(grep DATABASE_URL .env | cut -d= -f2- | tr -d '\"')" \
  -c "DELETE FROM shops WHERE domain = 'your-store.myshopify.com';"
```

Then reload the app in the admin. `pm2 logs shopify-backend` should show
`Saved access token for … (scopes: …)`.

### Change: warranty block details saved in the backend (`metafields` column)

The Warranty admin block now saves to the store's `custom` metafield namespace, so the backend can read it. Each product has a new JSON column `metafields`:

```json
{ "warranty": { "period": "1 year", "description": "…" }, "other": { "test_field": "…" } }
```

Deploy:

```bash
cd ~/htdocs/shopifydemo.cskills.me/shopify-backend
git pull && npm ci
npx prisma migrate deploy               # adds products.metafields
npm run build
pm2 restart shopify-backend --update-env

cd ../shopify-forntend
git pull && npm ci && npm run build
```

The extension is deployed from the laptop (`issue-tracker-app`): `shopify app deploy`.
Then re-enter the warranty values in the block, click **Save**, and run **Sync from Shopify** in the app.

---

## 3. Rules for the server `.env`

- **Never** set `SHOPIFY_AUTH=off` on the server. It lets requests with no Shopify session token through, so anyone could call the API. It's only for running locally on a laptop.
- `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` must be set.
- After editing `.env`, run `pm2 restart shopify-backend --update-env`.

---

## 4. Useful commands

```bash
pm2 list                                # running apps
pm2 logs shopify-backend --lines 50     # backend logs
pm2 restart shopify-backend --update-env
pm2 save                                # after adding/removing apps

curl http://127.0.0.1:3008/api/hello    # backend alive? {"message":"Hello World"}
npx prisma migrate status               # which migrations are applied
```
