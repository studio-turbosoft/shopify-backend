# shopify-nest

NestJS + Prisma + PostgreSQL API for products and orders. Used by `../react-app`.

## Setup

1. Create the database: `createdb -U postgres shop` (or `CREATE DATABASE shop;` in psql).
2. Copy `.env.example` to `.env` and set `DATABASE_URL` (`postgresql://USER:PASSWORD@HOST:PORT/DATABASE`).
3. `npm install` (this also runs `prisma generate`).
4. Create the tables: `npm run db:push` for quick local work, or `npm run db:migrate` to create a migration.
5. `npm run start:dev` → http://localhost:3000/api

The app starts even if the database is down. Prisma connects on the first query, so `/` and
`/api/hello` keep working and only the products/orders routes fail.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies, then run `prisma generate` (postinstall) |
| `npm run build` | `prisma generate` + `nest build` into `dist/` |
| `npm run start` | Start the API once |
| `npm run start:dev` | Start with watch mode (restarts on changes) |
| `npm run start:prod` | Run the built app (`node dist/main`, run `npm run build` first) |
| `npm audit` / `npm audit fix` | List / fix known vulnerabilities in dependencies |

Database commands are in [Prisma](#prisma) below.

### Windows: folder name with `&`

On Windows, npm runs scripts through `cmd.exe`, which treats `&` as a command separator. With a
parent folder like `shopify-r&d`, every script that calls `prisma` or `nest` fails with
`'d\...\node_modules\.bin\' is not recognized` or `Cannot find module 'C:\...\prisma\build\index.js'`
(the install itself succeeds; only `postinstall` fails).

Fix: rename the folder so it has no `&` (e.g. `shopify-rnd`) and run `npm install` again.

Until then, run the tools with `node` directly:

| Instead of | Run |
| --- | --- |
| `prisma generate` (postinstall) | `node node_modules/prisma/build/index.js generate` |
| `npm run build` | `node node_modules/prisma/build/index.js generate` then `node node_modules/@nestjs/cli/bin/nest.js build` |
| `npm run start` | `node node_modules/@nestjs/cli/bin/nest.js start` |
| `npm run start:dev` | `node node_modules/@nestjs/cli/bin/nest.js start --watch` |
| `npm run start:prod` | works as is (`node dist/main`) |
| `npm run db:push` | `node node_modules/prisma/build/index.js db push` |
| `npm run db:migrate` | `node node_modules/prisma/build/index.js migrate dev` |
| `npm run db:deploy` | `node node_modules/prisma/build/index.js migrate deploy` |
| `npm run db:studio` | `node node_modules/prisma/build/index.js studio` |

## Prisma

| Command | What it does |
| --- | --- |
| `npm run db:push` | Sync the tables to `prisma/schema.prisma` without migration files (local dev) |
| `npm run db:migrate` | Create and apply a migration in `prisma/migrations` (dev) |
| `npm run db:deploy` | Apply existing migrations (production/server) |
| `npm run db:studio` | Browse the data in Prisma Studio |

- Schema: `prisma/schema.prisma`. Connection settings: `prisma.config.ts` (reads `DATABASE_URL`
  from `.env.<NODE_ENV>` or `.env`).
- The generated client goes to `src/generated/prisma` (git-ignored). `npm run build` regenerates it.
- Table, column and enum names match the old TypeORM tables, so an existing database keeps working.

## Endpoints

| Method | Path | Body |
| --- | --- | --- |
| GET | / | returns `Server is running` |
| GET | /api/products | |
| GET | /api/products/:id | |
| POST | /api/products | `{ name, sku, description?, price, stock }` |
| PATCH | /api/products/:id | any subset of the above |
| DELETE | /api/products/:id | 409 if the product is on an order |
| GET | /api/orders | |
| GET | /api/orders/:id | |
| POST | /api/orders | `{ customerName, customerEmail, status?, items: [{ productId, quantity }] }` |
| PATCH | /api/orders/:id | any subset of the above |
| DELETE | /api/orders/:id | returns reserved stock |
| POST | /api/shopify/sync | import products from Shopify (session required) |
| POST | /api/webhooks/shopify | Shopify webhooks (HMAC-verified, no session) |

Status values: `pending`, `paid`, `shipped`, `delivered`, `cancelled`.

## Shopify product sync

Every product write is pushed to the Shopify store of the request's session (Admin GraphQL,
`SHOPIFY_API_VERSION`, default `2026-10`). Mapping: `src/shopify/product-mapper.ts`; calls:
`src/shopify/product-sync.service.ts`.

| Our action | Shopify | On failure |
| --- | --- | --- |
| Create / update product | [`productSet`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productSet) (synchronous) first, then the local save with the returned IDs and `shopifySyncedAt` = Shopify's `product.updatedAt` from the response | Shopify userErrors → 422, Shopify unreachable / denied → 502, nothing saved locally. If the local save fails after Shopify created the product, the Shopify product is deleted again (`productDelete`). |
| Update a product not linked yet | `productSet` creates it in Shopify and links it | as above |
| Delete product | 409 if it's on an order; else [`productDelete`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productDelete) (already gone in Shopify is fine), then local delete | Shopify error → 422/502, nothing deleted locally |
| Order create / update / cancel / delete | After the transaction commits: [`inventorySetQuantities`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventorySetQuantities) ("available" = our `stock`) for each affected tracked + linked product. `shopifySyncedAt` is left as is on success (stock changes don't bump `product.updatedAt`). | Best effort: the order stays saved; the product gets `shopifySyncedAt = null` (shown as "Not synced"). Saving the product again pushes it. |

- Inventory is set at the store's primary location ([`location`](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/location) with no id), looked up once per shop and cached in memory.
- Only one image (`imageUrl`) is sent, as `files`, and only when it changed (productSet replaces the product's files with what is sent).
- Clearing the vendor locally leaves Shopify's vendor as is (Shopify fills in the shop name).
- No session (local dev with `SHOPIFY_AUTH=off` and no token): writes are local only, `shopifySyncedAt` is set to null and a warning is logged.
- Required access scopes: `write_products`, `write_inventory`, `read_inventory`, `read_locations` (Dev Dashboard → app → Versions → Access scopes; release the version and reopen the app in the store). A missing scope returns a 502 that names the scope to add.

## Shopify → app (import and webhooks)

Mapping: `fromShopifyProduct()` in `src/shopify/product-mapper.ts`; upsert:
`src/shopify/product-import.service.ts`; webhooks: `src/shopify/shopify-webhook.service.ts`. Nothing on
this side ever writes to Shopify.

**`POST /api/shopify/sync`** ("Sync from Shopify" on the Products page). Needs a real session (401 with
`SHOPIFY_AUTH=off` and no token). Reads every product with the
[`products`](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/products) query, 25 per page
(each product costs ~17 query points with the nested variant / inventory fields; one query may cost at
most 1,000). Throttled requests (`THROTTLED`, HTTP 429) are retried after the wait that
`extensions.cost.throttleStatus` implies. For each product:

1. a local product linked to it (`shopifyProductId`) → updated;
2. else an unlinked local product with the same SKU → linked and updated;
3. else created.

Returns `{ created, updated, linked, skipped: [{ title, reason }], total }`. Skipped (never written):
products with several variants or with custom options (our model is single-variant, and pushing one back
with `productSet` would delete the other variants), status `UNLISTED`, SKUs over 64 characters, a SKU
already used by a product linked to another Shopify product, and linked products that were pushed from
here after Shopify was read (their `shopifySyncedAt` is newer).

Stock is "available" at the primary location, the same quantity the push sets. Shopify wins on import:
local changes that never reached Shopify (`shopifySyncedAt = null`) are overwritten. An image that is
still processing in Shopify (no URL yet) leaves `imageUrl` as is; otherwise `imageUrl` becomes the
Shopify CDN URL of the featured image.

**`POST /api/webhooks/shopify`**: one URL for all topics. No session guard: the raw body is verified
against `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 with `SHOPIFY_API_SECRET`, constant-time compare);
missing / wrong → 401. Valid deliveries get 200 at once and are processed afterwards (errors are
logged). Duplicate `X-Shopify-Webhook-Id`s are ignored. Only shops with a saved token in `shops` (they
opened the app) are synced; webhooks re-read products with that saved offline token.

| Topic | What happens |
| --- | --- |
| `products/create`, `products/update` | Loop guard (below); otherwise the product is re-read with the same fields as the import and upserted the same way. Multi-variant → skipped (logged). |
| `products/delete` | Local product deleted; if it is on orders it is kept and unlinked (Shopify IDs and `shopifySyncedAt` cleared). |
| `inventory_levels/update` | Linked product + primary location → local `stock = available` (no order logic, nothing pushed back). Echoes of our own stock pushes are ignored. |
| `app/uninstalled` | The shop's row in `shops` (access token) is deleted; products stay. |
| `customers/data_request`, `customers/redact`, `shop/redact` | 200, nothing to do (no Shopify customer data is stored). Mandatory only for App Store apps. |
| anything else | 200, ignored. |

**Loop guard.** `shopifySyncedAt` stores Shopify's `product.updatedAt` (from the `productSet` response,
the import or a webhook), not our clock. A `products/create|update` webhook whose `updated_at` is at or
before it is our own change coming back and is ignored. The same check runs in memory for the moment
between `productSet` and the local save. Stock pushes are remembered for a few minutes so their
`inventory_levels/update` echo is not applied (it could otherwise undo a newer order).

**Single instance.** The webhook-id dedupe, the loop-guard memory and the location cache are in memory.
With several server instances, move them to a shared store (Redis / a table).

### Webhook subscriptions (Dev Dashboard)

Shopify Dev Dashboard → your app → **Versions** → **Create a version** →
**Webhooks**: API version **2026-10**, then add a subscription with URL
`https://shopifydemo.cskills.me/api/webhooks/shopify` for each topic:
`products/create`, `products/update`, `products/delete`, `inventory_levels/update`, `app/uninstalled`.
Keep the access scopes above (products topics need `read_products`, which `write_products` includes;
`inventory_levels/update` needs `read_inventory`; `app/uninstalled` needs none). **Release** the
version. Compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are only
required for App Store apps; if you add them, use the same URL.
Docs: [HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https),
[topics and payloads](https://shopify.dev/docs/api/webhooks/2026-10),
[topic scopes](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic).

## Stock rules

- An order reserves stock for its items unless it is `cancelled`. Creating an order with more than the available stock returns 400.
- Changing items, cancelling, un-cancelling or deleting an order adjusts stock in the same transaction. Product rows are locked (`SELECT ... FOR UPDATE`), so two orders at once can't oversell.
- Each line stores `unitPrice` at order time. Changing a product's price later does not change existing orders. The order total is calculated on the server.
