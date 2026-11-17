# shopify-nest

NestJS + Prisma + PostgreSQL API for products and orders. Used by `../react-app`.

## Setup

1. Create the database: `createdb -U postgres shop` (or `CREATE DATABASE shop;` in psql).
2. Copy `.env.example` to `.env` and set `DATABASE_URL` (`postgresql://USER:PASSWORD@HOST:PORT/DATABASE`).
3. `npm install` (this also runs `prisma generate`).
4. Create the tables: `npm run db:push` for quick local work, or `npm run db:migrate` to create a migration.
5. `npm run start:dev` → http://localhost:3000/api

The app starts even if the database is down. Prisma connects on the first query, so `/` and
`/api/test-records` keep working and only the products/orders routes fail.

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
| GET | /api/test-records | 5 static test records, no database |
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

Status values: `pending`, `paid`, `shipped`, `delivered`, `cancelled`.

## Shopify product sync

Every product write is pushed to the Shopify store of the request's session (Admin GraphQL,
`SHOPIFY_API_VERSION`, default `2026-10`). Mapping: `src/shopify/product-mapper.ts`; calls:
`src/shopify/product-sync.service.ts`.

| Our action | Shopify | On failure |
| --- | --- | --- |
| Create / update product | [`productSet`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productSet) (synchronous) first, then the local save with the returned IDs and `shopifySyncedAt = now()` | Shopify userErrors → 422, Shopify unreachable / denied → 502, nothing saved locally. If the local save fails after Shopify created the product, the Shopify product is deleted again (`productDelete`). |
| Update a product not linked yet | `productSet` creates it in Shopify and links it | as above |
| Delete product | 409 if it's on an order; else [`productDelete`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productDelete) (already gone in Shopify is fine), then local delete | Shopify error → 422/502, nothing deleted locally |
| Order create / update / cancel / delete | After the transaction commits: [`inventorySetQuantities`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventorySetQuantities) ("available" = our `stock`) for each affected tracked + linked product | Best effort: the order stays saved; the product gets `shopifySyncedAt = null` (shown as "Not synced"). Saving the product again pushes it. |

- Inventory is set at the store's primary location ([`location`](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/location) with no id), looked up once per shop and cached in memory.
- Only one image (`imageUrl`) is sent, as `files`, and only when it changed (productSet replaces the product's files with what is sent).
- Clearing the vendor locally leaves Shopify's vendor as is (Shopify fills in the shop name).
- No session (local dev with `SHOPIFY_AUTH=off` and no token): writes are local only, `shopifySyncedAt` is set to null and a warning is logged.
- Required access scopes: `write_products`, `write_inventory`, `read_inventory`, `read_locations` (Dev Dashboard → app → Versions → Access scopes; release the version and reopen the app in the store). A missing scope returns a 502 that names the scope to add.

## Stock rules

- An order reserves stock for its items unless it is `cancelled`. Creating an order with more than the available stock returns 400.
- Changing items, cancelling, un-cancelling or deleting an order adjusts stock in the same transaction. Product rows are locked (`SELECT ... FOR UPDATE`), so two orders at once can't oversell.
- Each line stores `unitPrice` at order time. Changing a product's price later does not change existing orders. The order total is calculated on the server.
