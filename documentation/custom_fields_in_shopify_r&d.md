# Guide: Warranty Details App (Shopify Admin Block)

A Shopify app that adds a **Warranty** box to the product page in the Shopify admin. The values are saved on the product as **metafields**. No server needed.

```
   Shopify admin → Products → a saved product
   ┌──────────────────────────────────────────┐
   │  Product details ...                     │
   │  ┌────────────────────────────────────┐  │
   │  │ Warranty  (our block)              │  │
   │  │  Warranty period      [ 2 years ]  │  │
   │  │  Warranty description [ ...     ]  │  │
   │  └────────────────────────────────────┘  │
   └──────────────────────────────────────────┘
            │ save
            ▼
   Product metafields ($app namespace), stored by Shopify
```

### ⚠ Important: where can your app add things to a product?

|                         | Shopify's **Add product** form | Shopify's **Edit product** page | **Your own app page**     |
| ----------------------- | ------------------------------------ | ------------------------------------- | ------------------------------- |
| Add your custom section | ❌ Not possible                      | ✅ Admin block (bottom)               | ✅ Anywhere                     |
| Your full React UI      | ❌                                   | ❌ (only Shopify components)          | ✅                              |
| URL                     | `/products/new`                    | `/products/123`                     | `/apps/your-app/products/new` |

Why:

- **Add product form:** Shopify doesn't let apps add anything to it. The product doesn't exist yet (no ID), so there's nothing to save metafields on. That's why our block only appears **after** the product is saved.
- **Edit product page:** apps can add an **admin block**, but it runs inside Shopify and can only use Shopify's own UI components (`<s-text-field>`, `<s-banner>`...), not your React components or CSS.
- **Your own app page:** an embedded app page (under **Apps** in the admin) is your own website in an iframe, so you can build any React UI there, e.g. a custom "Add product" form that also fills the warranty.

**So:** warranty fields on Shopify's product page → admin block (this guide). A fully custom form → your own app page (see the v2 deployment guide).

### Steps at a glance

| Step | What                                                |
| ---- | --------------------------------------------------- |
| 1    | Shopify account, dev store, install the CLI, log in |
| 2    | Create the app and link it to your account          |
| 3    | Set the permission (scope)                          |
| 4    | Generate the warranty block                         |
| 5    | What the block does                                 |
| 6    | Run it on the dev store                             |
| 7    | Deploy                                              |
| 8    | Troubleshooting                                     |
| 9    | Next steps                                          |

### Our setup

| Item          | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| App name      | `warranty-details`                                          |
| App folder    | `issue-tracker-app` (folder name differs from the app name) |
| Dev store     | `your-dev-store.myshopify.com` (replace with yours)         |
| Template      | `shopify-app-template-extension-only`                       |
| Our extension | `warranty-block`                                            |
| Tools we used | Node.js v24, npm v11, Git, Shopify CLI (latest)               |

### Words used

| Word               | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| Dev Dashboard      | Shopify's website for developers, where your apps and dev stores live  |
| Dev store          | A free test store to try your app on                                   |
| Shopify CLI        | The `shopify` command in the terminal to create, run and deploy apps |
| Admin block        | A small box our app adds to a page in the Shopify admin                |
| Extension          | A piece of the app that runs inside Shopify (no server of our own)     |
| Metafield          | An extra field saved on a Shopify object, e.g. a product               |
| `$app` namespace | Metafields that belong to our app only                                 |
| Scope              | A permission the app asks for, e.g. `write_products`                 |
| App version        | A released snapshot of the app's config and extensions                 |

---

## Step 1 — Account, Dev Store, CLI, Log In

### 1.1 Create a Shopify developer account

- Go to `dev.shopify.com` → **Sign up** (free).
- Log in with your email (or Google), and create or join an **organization** (your company/team).

### 1.2 Create a dev store

- Dev Dashboard → **Dev stores** → **Create store**.
- Give it a name. You get `your-dev-store.myshopify.com`.
- Add 1–2 test products in the store (**Products → Add product → Save**). The block only shows on **saved** products.

### 1.3 Install the tools

- Install **Node.js** (LTS) and **Git**. Check: `node -v`, `npm -v`, `git --version`.
- Install the Shopify CLI, then close and reopen the terminal:

```cmd
npm install -g @shopify/cli@latest
shopify version
```

- "`shopify` is not recognized"? Add the folder printed by `npm prefix -g` to your PATH.

### 1.4 Log in (authenticate) with your account

```cmd
shopify auth login
```

- The CLI opens your browser (or prints a link and a code).
- Log in with the **same account** as the Dev Dashboard and click **Confirm**.
- Back in the terminal you see that you're logged in. The CLI remembers it.
- If you skip this, the first command that needs your account (e.g. `shopify app config link`) asks you to log in the same way.
- Wrong account? `shopify auth logout`, then log in again.

📖 Docs: [Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard) · [Dev stores](https://shopify.dev/docs/apps/build/dev-dashboard/development-stores) · [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) · [auth login](https://shopify.dev/docs/api/shopify-cli/general-commands/auth-login) · [auth logout](https://shopify.dev/docs/api/shopify-cli/general-commands/auth-logout)

✅ Step 1 done.

---

## Step 2 — Create the App and Link It

### 2.1 Get the template

```cmd
git clone --depth 1 https://github.com/Shopify/shopify-app-template-extension-only issue-tracker-app
cd issue-tracker-app
npm install
```

Normally `shopify app init` does this. It couldn't download the template on our network, so we cloned it by hand.

### 2.2 Link it to your Shopify account

```cmd
shopify app config link
```

Answer the questions:

- Pick your **organization**.
- Choose to **create a new app** (or pick an existing one).
- Name it: `warranty-details`.
- This creates the app in the Dev Dashboard and writes `shopify.app.toml` (with the app's `client_id`).
- Check: Dev Dashboard → **Apps** → `warranty-details` is there.

📖 Docs: [Extension-only template](https://github.com/Shopify/shopify-app-template-extension-only) · [app config link](https://shopify.dev/docs/api/shopify-cli/app/app-config-link) · [App configuration](https://shopify.dev/docs/apps/build/app-configuration)

✅ Step 2 done.

---

## Step 3 — Set the Permission (Scope)

The block saves product metafields, so the app needs `write_products`. In `shopify.app.toml`:

```toml
[access_scopes]
scopes = "write_products"
```

When you run the app (Step 6), the store asks you to approve this permission once.

📖 Docs: [Access scopes](https://shopify.dev/docs/api/usage/access-scopes)

✅ Step 3 done.

---

## Step 4 — Generate the Warranty Block

From the app folder:

```cmd
shopify app generate extension --template admin_block --name warranty-block --flavor preact
```

> Use `preact`. `react` isn't supported for admin blocks.

```
extensions/warranty-block/
├── shopify.extension.toml   # type, target, API version
├── locales/en.default.json  # "name": "Warranty" = the block heading
└── src/BlockExtension.jsx   # the block UI and logic
```

The block shows on a **saved** product's page (target `admin.product-details.block.render`).

📖 Docs: [app generate extension](https://shopify.dev/docs/api/shopify-cli/app/app-generate-extension) · [Build an admin block](https://shopify.dev/docs/apps/build/admin/actions-blocks/build-admin-block) · [Admin extensions](https://shopify.dev/docs/api/admin-extensions)

✅ Step 4 done.

---

## Step 5 — What the Block Does

### 5.1 The fields

| Label                | Metafield key            | Type             |
| -------------------- | ------------------------ | ---------------- |
| Warranty period      | `warranty_period`      | single line text |
| Warranty description | `warranty_description` | multi line text  |
| Test field           | `test_field`           | single line text |

All saved under the `$app` namespace (only our app owns them).

### 5.2 How it works

- **Open a product:** the block reads its 3 metafields.
- **Save:** writes them with `metafieldsSet`; the admin save bar waits until done.
- **Discard:** puts back the last saved values.
- **Error:** shows a red message.
- It talks to Shopify directly from the admin, using the store's login. So **no backend and no API keys** are needed.

### 5.3 Adding another field

In `BlockExtension.jsx`, a field is used in 7 places: the query, its state, the saved values, loading, saving, reset, and the form input. Copy an existing field and update all 7.

📖 Docs: [Metafields](https://shopify.dev/docs/apps/build/custom-data) · [App-owned metafields](https://shopify.dev/docs/apps/build/custom-data/ownership) · [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet)

✅ Step 5 done.

---

## Step 6 — Run It on the Dev Store

```cmd
shopify app dev --use-localhost
```

First run:

1. The CLI asks which **store** to use → pick your dev store.
2. Press **p** (or use the link) to open the app in the store.
3. Shopify asks to **install** the app and approve `write_products` → **Install**.
4. Go to **Products** → open a **saved** product → the **Warranty** block is there.
5. Type a value → **Save** → refresh: the value stays.

- `--use-localhost` skips the Cloudflare tunnel (it couldn't download on our network).
- The **Dev Console** at the bottom of the admin lists the extensions. `app-home` and `app-tools` are template demos; ignore them.
- Use another store? `shopify app dev --reset` asks again.
- Stop with **Ctrl + C**.

📖 Docs: [app dev](https://shopify.dev/docs/api/shopify-cli/app/app-dev) · [Tunnel / localhost](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)

✅ Step 6 done.

---

## Step 7 — Deploy

```cmd
# stop dev first (Ctrl + C)
shopify app deploy
```

- Creates a new **app version** and releases it to every store that has the app.
- Upload without releasing: `shopify app deploy --no-release` (release later in the Dev Dashboard).
- After deploying, click **Clean dev preview** in the Dev Console, so the store shows the deployed version.
- **Rollback:** Dev Dashboard → the app → **Versions** → release an older one.
- **Client's store:** Dev Dashboard → the app → **Distribution** → **Custom distribution** → enter the store → **Generate link** → open it while logged in to that store → **Install**.
- No server, so `application_url` can stay as the placeholder.

📖 Docs: [app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy) · [Deploy app versions](https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions) · [Distribution](https://shopify.dev/docs/apps/launch/distribution)

✅ Step 7 done.

---

## Step 8 — Troubleshooting

| Problem                                                         | Fix                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `shopify is not recognized`                                   | Install the CLI, reopen the terminal. Still failing? Add the folder from `npm prefix -g` to PATH. |
| Logged in with the wrong account / app not in your organization | `shopify auth logout`, then `shopify auth login` with the right account.                        |
| Wrong store                                                     | `shopify app dev --reset` and pick again.                                                         |
| `Connection was reset` during `app init`                    | Retry, or `git config --global http.version HTTP/1.1`, or clone the template by hand (Step 2).    |
| `Invalid extension flavor`                                    | Use `--flavor preact`.                                                                            |
| `app dev` frozen; window title starts with **"Select"** | You clicked in the window. Press **Esc**, or use the VS Code terminal.                        |
| `dev` hangs on `cloudflared`                                | Use `shopify app dev --use-localhost`.                                                            |
| `An extensions_summary is required`                           | Add the `[sidekick]` section below to `shopify.app.toml`.                                       |
| Block not visible                                               | Open a **saved** product, not "Add product". Check the app is installed on this store.        |
| Save fails with an access/permission error                      | `write_products` missing (Step 3), or not approved yet. Rerun `shopify app dev` and approve.    |

```toml
[sidekick]
extensions_summary = "View and edit warranty details for products"
```

Stuck? `shopify app dev --verbose` shows where.

📖 Docs: [Sidekick](https://shopify.dev/docs/apps/build/sidekick) · [CLI for apps](https://shopify.dev/docs/apps/build/cli-for-apps)

✅ Step 8 done.

---

## Step 9 — Next Steps

- [ ] Remove the test field if not needed.
- [ ] Rename "Dummy" / "Test" labels to final names.
- [ ] Remove the template demos (`app-home`, `app-tools`).
- [ ] Show the warranty on the store's website with a [theme app extension](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions).

✅ All done.

---

## All Documentation Links

| Step | Topic                   | Link                                                                                                                                                                     |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Dev Dashboard           | [Shopify: Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard)                                                                                               |
| 1    | Dev stores              | [Shopify: Dev stores](https://shopify.dev/docs/apps/build/dev-dashboard/development-stores)                                                                               |
| 1    | Shopify CLI             | [Shopify: CLI](https://shopify.dev/docs/api/shopify-cli)                                                                                                                  |
| 1    | Log in / log out        | [auth login](https://shopify.dev/docs/api/shopify-cli/general-commands/auth-login) · [auth logout](https://shopify.dev/docs/api/shopify-cli/general-commands/auth-logout) |
| 2    | Extension-only template | [GitHub: template](https://github.com/Shopify/shopify-app-template-extension-only)                                                                                        |
| 2    | Link the app            | [Shopify: app config link](https://shopify.dev/docs/api/shopify-cli/app/app-config-link)                                                                                  |
| 2    | `shopify.app.toml`    | [Shopify: App configuration](https://shopify.dev/docs/apps/build/app-configuration)                                                                                       |
| 3    | Access scopes           | [Shopify: Access scopes](https://shopify.dev/docs/api/usage/access-scopes)                                                                                                |
| 4    | Generate an extension   | [Shopify: app generate extension](https://shopify.dev/docs/api/shopify-cli/app/app-generate-extension)                                                                    |
| 4    | Build an admin block    | [Shopify: Build an admin block](https://shopify.dev/docs/apps/build/admin/actions-blocks/build-admin-block)                                                               |
| 4, 5 | Admin extensions        | [Shopify: Admin extensions](https://shopify.dev/docs/api/admin-extensions)                                                                                                |
| 5    | Metafields              | [Shopify: Custom data](https://shopify.dev/docs/apps/build/custom-data)                                                                                                   |
| 5    | App-owned metafields    | [Shopify: Ownership](https://shopify.dev/docs/apps/build/custom-data/ownership)                                                                                           |
| 5    | `metafieldsSet`       | [Shopify: metafieldsSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet)                                                                       |
| 6    | Run the app             | [Shopify: app dev](https://shopify.dev/docs/api/shopify-cli/app/app-dev)                                                                                                  |
| 6    | Tunnel / localhost      | [Shopify: Networking options](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)                                                                        |
| 7    | Deploy                  | [app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy) · [App versions](https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions)               |
| 7    | Distribution            | [Shopify: Distribution](https://shopify.dev/docs/apps/launch/distribution)                                                                                                |
| 8    | Sidekick                | [Shopify: Sidekick](https://shopify.dev/docs/apps/build/sidekick)                                                                                                         |
| 9    | Theme app extensions    | [Shopify: Theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions)                                                                    |
