# Build a Shopify Custom App from Scratch: Code, Linux VM, PostgreSQL, PM2 & Install

**Guide: Deploy Our Shopify App on a CloudPanel VM (v2)**

Build the app (NestJS backend + React frontend + PostgreSQL), deploy it on CloudPanel, and connect it to Shopify.

> Source: [Episode - Build a Shopify Custom App from Scratch: Deploying on a CloudPanel VM](https://shreyeshkolhe.blogspot.com/2026/11/episode-build-shopify-custom-app-from_060945564.html) (published November 15, 2026, updated November 17, 2026).

## Contents

- [Before you start: what you need](#before-you-start-what-you-need)
- [Steps at a glance](#steps-at-a-glance)
- [Placeholders used in this guide](#placeholders-used-in-this-guide)
- [Words used](#words-used)

1. [Create the Frontend and Backend Apps](#step-1--create-the-frontend-and-backend-apps)
2. [Get the Linux VM and Connect to It](#step-2--get-the-linux-vm-and-connect-to-it)
3. [Clone the Repos, Set .env, Run with PM2](#step-3--clone-the-repos-set-env-run-with-pm2)
4. [Add the App to Shopify](#step-4--add-the-app-to-shopify)
5. [Auto-Start After a Server Reboot](#step-5--auto-start-after-a-server-reboot)
6. [Update the App Later](#step-6--update-the-app-later)
7. [Security Checklist](#step-7--security-checklist)
8. [Logs and Backups](#step-8--logs-and-backups)
9. [Troubleshooting](#step-9--troubleshooting)
10. [Sync Products with Shopify (Two-Way CRUD)](#step-10--sync-products-with-shopify-two-way-crud)
11. [Recreate the App with Shopify CLI (settings in one file)](#step-11--recreate-the-app-with-shopify-cli-settings-in-one-file)
12. [Documentation Links](#documentation-links)

---

## Before you start: what you need

- A laptop with **Node.js 20+**, **Git** and a code editor (VS Code).
- A **GitHub** account.
- A **Shopify Partner / Dev Dashboard** account (free, at `dev.shopify.com`) and a **dev store** to test on (create one there: **Stores → Create store**).
- A **Linux VM with CloudPanel** and its login details (usually from your senior/admin, see Step 2).

## Steps at a glance

| Step | What | Who | Where |
| --- | --- | --- | --- |
| 1 | Build the frontend + backend + database | You | Laptop |
| 2 | Get the VM and connect with PuTTY | Senior creates it, you connect | Server |
| 3 | Clone, set `.env`, run with PM2 | You | Server |
| 4 | Vhost + add the app to Shopify | Senior (Vhost), you (Shopify) | CloudPanel, Shopify |
| 5 | Auto-start after reboot | You | Server |
| 6 | Update the app later | You | Laptop + server |
| 7 | Security checklist | You + senior | Server |
| 8 | Logs and backups | You | Server |
| 9 | Troubleshooting | — | — |
| 10 | Two-way product sync with Shopify | You | Backend + Shopify |
| 11 | Recreate the app with Shopify CLI (settings in one file) | You | Laptop + Shopify + server |

## Placeholders used in this guide

| Placeholder | Replace with |
| --- | --- |
| `203.0.113.25` | Your VM's IP |
| `demo.yourdomain.com` | Your app's domain |
| `demo-user` | Your site user (SSH login) |
| `your-store.myshopify.com` | Your Shopify store |
| `YOUR-USERNAME` | Your GitHub username |
| `YOUR_CLIENT_ID` | The app's Client ID from Shopify (Step 4.2) |
| `<password>` | The real password. **Never write real passwords in docs or GitHub.** |

## Words used

| Word | Meaning |
| --- | --- |
| VM | A Linux server in the cloud where the app runs |
| PuTTY | Windows program to log in to the server and type commands |
| CloudPanel | A web panel on the server that manages Nginx, SSL and the firewall |
| Nginx / Vhost | The web server in front of our app; the Vhost is its config for our domain |
| PM2 | Keeps the backend running (restarts it if it crashes) |
| `.env` | A file with settings and secrets (ports, passwords). Never in GitHub |
| Embedded app | Our website shown inside the Shopify admin (in an iframe) |
| App Bridge | Shopify's script that connects our app to the Shopify admin |
| Scope | A permission the app asks for, e.g. `read_products` |
| Session token | Proof (from App Bridge) of which store/user is calling our backend |
| Access token | Lets our backend call Shopify's API for a store |
| Webhook | Shopify calling our backend when something changes (e.g. a product is edited) |

---

## Step 1 — Create the Frontend and Backend Apps

```
   React (shopify-forntend)  ──▶  NestJS (shopify-backend, port 3008)  ──▶  PostgreSQL
```

### 1.1 Database

- Install PostgreSQL on your laptop (installer or Docker).
- Create a database: `shopify_app_db`.

### 1.2 Backend (NestJS)

- Install the Nest CLI once: `npm i -g @nestjs/cli`
- Create the project: `nest new shopify-backend`
- Install: `@nestjs/config`, `class-validator`, `class-transformer`, `@nestjs/mapped-types`, and for the database **Prisma**: `npm i @prisma/client @prisma/adapter-pg pg` and `npm i -D prisma`.
- Set up Prisma: `npx prisma init`, describe the tables in `prisma/schema.prisma`, then create them with a migration: `npx prisma migrate dev --name init`. Add `"postinstall": "prisma generate"` and `"build": "prisma generate && nest build"` to `package.json`.
- Set a global prefix `/api`, enable CORS, and use a `PrismaService` (Prisma client) in the services.
- Add the features:
  - **Products**: list, add, edit, delete (title, price, stock).
  - **Orders**: create (lowers stock), list, change status.
  - **Health check**: `GET /api/hello`.
- `.env`:

  ```env
  PORT=3008
  CORS_ORIGIN=http://localhost:5173
  DATABASE_URL=postgresql://postgres:<password>@localhost:5432/shopify_app_db
  SHOPIFY_API_KEY=YOUR_CLIENT_ID
  SHOPIFY_API_SECRET=<client secret>
  SHOPIFY_AUTH=off      # laptop only: lets requests without a Shopify session token through
  ```

- Run: `npm run start:dev` → test `http://localhost:3008/api/hello`
- Changed `schema.prisma`? Run `npx prisma migrate dev --name what-changed` and commit the new folder in `prisma/migrations`.

### 1.3 Frontend (React + Vite)

- Create the project: `npm create vite@latest shopify-forntend -- --template react-ts`
- Stack (follows our `react-template-vita` template): TypeScript, Tailwind + shadcn/ui, `react-router-dom`, Redux Toolkit (thunks call the API), `axios`, `react-hook-form` + `zod`, `sonner` toasts, `lucide-react` icons.
- Add two pages: **Products** and **Orders**, calling the backend API through Redux thunks.
- One axios instance (`src/lib/axios.ts`) with interceptors: the request interceptor adds the Shopify session token (`Authorization: Bearer ...`, from App Bridge), the response interceptor turns API errors into readable messages.
- `.env`:

  ```env
  VITE_API_URL=http://localhost:3008/api
  VITE_SHOPIFY_API_KEY=YOUR_CLIENT_ID
  ```

- Run: `npm run dev` → open `http://localhost:5173`

### 1.4 Check

- Add a product, create an order, check the stock goes down.

### 1.5 Push to GitHub

- On GitHub, create 2 empty repos: `shopify-backend` and `shopify-forntend`.
- Add `.env` to `.gitignore` in both apps.
- In each app folder: commit, add the GitHub repo as `origin`, push to `main`. (The frontend needs `git init` first; `nest new` already did it for the backend.)
- Check on GitHub: code is there, **no `.env`**.

✅ **Step 1 done.**

---

## Step 2 — Get the Linux VM and Connect to It

In our case, **the senior created the VM** and gave us the login details, with Node.js, PM2, Git and **CloudPanel** already installed. CloudPanel manages Nginx, the firewall and SSL certificates, so we didn't have to.

### 2.0 How the VM is created (done by the senior / admin)

For reference, if you ever need to do it yourself:

1. **Buy a VM** from a provider (DigitalOcean, AWS, Hetzner, Hostinger...): **Ubuntu 24.04**, at least 2 GB RAM. You get an IP and a root password.
2. **Install CloudPanel:** log in as root and run the installer command from the CloudPanel docs (`cloudpanel.io/docs` → Getting Started).
3. **Open CloudPanel** at `https://IP:8443` and create the admin account.
4. **Point the domain:** at the domain provider, add an **A record** → the VM's IP.
5. **Create the site:** CloudPanel → Sites → Add Site → **Create a Node.js Site** → domain, Node.js version, app port (ours: **3008**), site user + password. This installs Node.js for that user and sets up Nginx.
6. **SSL:** the site → SSL/TLS → Actions → **New Let's Encrypt Certificate**.
7. **Firewall:** Admin Area → Security → keep only 22, 80, 443 (and 8443 for the panel) open.
8. **PostgreSQL** (as root, CloudPanel doesn't manage it): `apt install -y postgresql`, then create the database `shopify_app_db` and a user with a password.
9. **PM2:** log in as the site user and run `npm install -g pm2`.
10. **Share with the developer:** IP, SSH port, site user, password, domain, database connection string.

After this, the developer only needs SSH access. Everything below starts from there.

### 2.1 What you get

| Detail | Example | Used for |
| --- | --- | --- |
| IP | `203.0.113.25` | The server's address |
| Port | `22` | SSH login (PuTTY) |
| Username | `demo-user` | Your login on the server |
| Password | `<password>` | Your login on the server |
| Domain | `demo.yourdomain.com` | The URL of your app (already points to the IP) |

> Keep these private. Never put them in GitHub.

### 2.2 Install PuTTY

- Download from `putty.org` and install it (Windows).

### 2.3 Connect

1. Open PuTTY → **Host Name**: the IP → **Port**: the port → **SSH**.
2. **Saved Sessions**: type a name (e.g. `my-vm`) → **Save**. Next time just double-click it.
3. **Open** → click **Accept** (first time only).
4. **login as:** type the username → Enter.
5. **Password:** type or right-click to paste. **Nothing shows while typing**, that's normal → Enter.

Connected when you see: `demo-user@my-vm:~$`

### 2.4 Check the server

- Login message says **"Welcome to CloudPanel"** → the server uses CloudPanel (Nginx, SSL, firewall are managed there).
- Your app folder: `cd ~/htdocs/demo.yourdomain.com`
- Check tools: `node -v`, `git --version`
- `sudo` doesn't work? Normal. Your user has no admin rights. Ask the admin for system tasks.

**PuTTY tips:** right-click = paste · select text = copy · `exit` = log out.

✅ **Step 2 done.**

---

## Step 3 — Clone the Repos, Set .env, Run with PM2

Log in with PuTTY first. The PostgreSQL database on the server is created by the admin (we just need its connection string).

### 3.1 Clone

```bash
cd ~/htdocs/demo.yourdomain.com
git clone https://github.com/YOUR-USERNAME/shopify-backend.git
git clone https://github.com/YOUR-USERNAME/shopify-forntend.git
```

Private repo? Use a GitHub **personal access token** as the password.

### 3.2 Check the PostgreSQL connection

Before setting up the backend, make sure the database login works:

```bash
psql "postgresql://postgres:<password>@localhost:5432/shopify_app_db" -c "SELECT current_user, current_database();"
```

You should see the user and the database name. If not:

| Error | Fix |
| --- | --- |
| `password authentication failed` | Wrong password. If it has `@ # : / %`, URL-encode them (e.g. `@` → `%40`). |
| `database "shopify_app_db" does not exist` | Ask the admin to create it. |
| `Connection refused` | PostgreSQL isn't running. Ask the admin. |
| `psql: command not found` | Skip this check; the backend start (next step) will show the same errors in `pm2 logs`. |

Use this same connection string as `DATABASE_URL` below.

### 3.3 Backend: .env + PM2

Go to the backend folder and create `.env` (`nano .env`, paste, Ctrl+O, Enter, Ctrl+X):

```bash
cd ~/htdocs/demo.yourdomain.com/shopify-backend
nano .env
```

```env
PORT=3008
CORS_ORIGIN=https://demo.yourdomain.com
DATABASE_URL=postgresql://postgres:<password>@localhost:5432/shopify_app_db
SHOPIFY_API_KEY=YOUR_CLIENT_ID
SHOPIFY_API_SECRET=<client secret>
# SHOPIFY_API_VERSION=2026-10   (optional, this is the default)
# Never set SHOPIFY_AUTH=off on the server.
```

Install, create the tables, build, start:

```bash
npm ci                                      # also runs "prisma generate"
npx prisma migrate deploy                   # creates / updates the tables from prisma/migrations
npm run build
pm2 delete shopify-backend 2>/dev/null      # only if an old copy is running
pm2 start dist/main.js --name shopify-backend
pm2 logs shopify-backend --lines 20         # look for "Nest application successfully started"
curl http://127.0.0.1:3008/api/hello        # {"message":"Hello World"}
```

No `dist/main.js`? Check `ls dist/src/main.js` and use that path.

Check the tables were created:

```bash
psql "postgresql://postgres:<password>@localhost:5432/shopify_app_db" -c "\dt"
# should list: products, orders, order_items, shops, _prisma_migrations
```

Save the PM2 list so it survives a reboot (Step 5):

```bash
pm2 save
```

Prisma error **"engine not found"** / blocked install scripts? Run `npm install-scripts approve prisma @prisma/engines`, then `npm ci` again.

### 3.4 Frontend: .env + build

```bash
cd ~/htdocs/demo.yourdomain.com/shopify-forntend
nano .env
```

```env
VITE_API_URL=https://demo.yourdomain.com/api
VITE_SHOPIFY_API_KEY=YOUR_CLIENT_ID
```

```bash
npm ci
npm run build                               # type-checks (tsc), then creates dist/
grep shopify-api-key dist/index.html        # should show your real Client ID
```

**The frontend doesn't need PM2.** It's just files in `dist/`; Nginx serves them (see Step 4.1).

### Remember

- `.env` changed in the backend → `pm2 restart shopify-backend --update-env`
- `.env` changed in the frontend → `npm run build` again
- Useful: `pm2 list` · `pm2 logs shopify-backend`

✅ **Step 3 done.**

---

## Step 4 — Add the App to Shopify

**How it works:** Shopify doesn't copy our code. It opens our URL (`https://demo.yourdomain.com`) inside a window (iframe) in the Shopify admin, under **Apps**.

```
   Shopify admin → Apps → Our App
   ┌────────────┬──────────────────────────────┐
   │ Home       │                              │
   │ Orders     │   our React app, loaded from │
   │ Products   │   https://demo.yourdomain.com│
   │ Apps  ◀──  │                              │
   └────────────┴──────────────────────────────┘
```

### 4.1 Before you start: the Vhost (senior does this in CloudPanel)

Ask the senior to update the site's Vhost in **CloudPanel → Sites → domain → Vhost** so that:

- `/api/` → goes to the backend (port 3008). No `/` after the port in `proxy_pass`.
- Everything else → serves `shopify-forntend/dist` (with `try_files $uri $uri/ /index.html;`).
- Shopify is allowed to show our site in an iframe (add this line inside `server { }`):

  ```nginx
  add_header Content-Security-Policy "frame-ancestors https://your-store.myshopify.com https://admin.shopify.com;" always;
  ```

Also ask the senior to confirm the site's **App Port is 3008**.

**Check:** `https://demo.yourdomain.com` opens the React app, and `https://demo.yourdomain.com/api/hello` returns JSON.

- Still `Cannot GET /`? The Vhost isn't updated yet.
- `403 Forbidden`? Nginx can't read `dist/`. Check permissions: `namei -l ~/htdocs/demo.yourdomain.com/shopify-forntend/dist/index.html`.
- **Senior can't change the Vhost?** Plan B: let NestJS serve `dist/` itself with `@nestjs/serve-static` (exclude `/api`), and set the same `Content-Security-Policy` header in `main.ts`.

### 4.2 Create the app in Shopify

1. Open `dev.shopify.com/dashboard` (or store admin → **Settings → Apps → Develop apps → Build apps in Dev Dashboard**).
2. **Apps → Create app** → name it → **Create**.
3. **Versions** tab → new version:
   - **App URL:** `https://demo.yourdomain.com`
   - **Embed app in Shopify admin:** ✅
   - **Use legacy install flow:** ❌ off (Shopify installs the app itself; our backend has no OAuth callback route, so the redirect URL is never used).
   - **Scopes:** only what you need. For the product sync in Step 10: `write_products`, `write_inventory`, `read_inventory`, `read_locations`.
   - **Webhooks:** see [10.6](#106-shopify--our-app-webhooks-).
4. Click **Release**.
5. **Settings** → copy the **Client ID** and **Client secret**. The secret stays private.

Prefer one settings file instead of clicking? Create the app with Shopify CLI instead ([Step 11](#step-11--recreate-the-app-with-shopify-cli-settings-in-one-file)).

### 4.3 Add App Bridge to the frontend

In `shopify-forntend/index.html`, at the **top of `<head>`**:

```html
<meta name="shopify-api-key" content="%VITE_SHOPIFY_API_KEY%" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
```

Vite replaces `%VITE_SHOPIFY_API_KEY%` with the Client ID from `.env` at build time, so the real ID ends up in the raw HTML (Shopify's checker doesn't run JavaScript). The Client ID is public; the **Client secret never goes in the frontend**.

Commit, push, then on the server: `git pull` → `npm run build`.

### 4.4 Install the app on the store

- **Our own (dev) store:** Dev Dashboard → the app → **Install app** → pick the store.
- **Client's store:** the app → **Distribution → Custom distribution** → enter the store domain → **Generate link** → open it while logged in to the store → **Install**.

Open the store admin → **Apps** → our app. 🎉

### 4.5 Protect the backend ✅ Done

- **Frontend:** the axios request interceptor asks App Bridge for a fresh session token (`shopify.idToken()`) and sends it as `Authorization: Bearer ...` on every call.
- **Backend:** `ShopifySessionGuard` (`src/auth/shopify-session.guard.ts`, no extra library) checks the token: HS256 signature with `SHOPIFY_API_SECRET`, `aud` = `SHOPIFY_API_KEY`, not expired, `iss`/`dest` = the same `*.myshopify.com` store. Otherwise → 401.
- **Protected:** `/api/products`, `/api/orders`, `/api/shop`, `/api/shopify/*`. **Public:** `/`, `/api/hello`, `/api/test-records`, and `/api/webhooks/shopify` (checked by HMAC instead, 10.6).
- **Laptop only:** `SHOPIFY_AUTH=off` lets requests without a token through (a token that is sent is still checked). Never on the server.
- To call Shopify's own API, the backend swaps the session token for an access token (10.2).

### If it doesn't load

| Problem | Fix |
| --- | --- |
| Blank box / "refused to connect" | The `Content-Security-Policy` line is missing or has the wrong store name |
| `shopify is not defined` | App Bridge lines missing or not first in `<head>`; rebuild |
| "App can't be installed" | Click **Release** on a version, or use custom distribution |
| App loads but API calls fail | Check `/api/hello` works and `VITE_API_URL` ends with `/api` |

**Changed the domain later?** Update the App URL, create a new version and click **Release** again.

✅ **Step 4 done.**

---

## Step 5 — Auto-Start After a Server Reboot

`pm2 startup` needs sudo (we don't have it), so we use a cron job instead.

1. Run `echo $PATH` and copy the output.
2. Run `crontab -e` (choose `nano` if asked).
3. Add these 2 lines at the bottom (paste your PATH after `PATH=`), then save:

   ```cron
   PATH=/home/demo-user/.nvm/versions/node/v22.x.x/bin:/usr/local/bin:/usr/bin:/bin
   @reboot pm2 resurrect &> /dev/null
   ```

4. Check with `crontab -l`.

- Always run `pm2 save` after adding or removing an app.
- If the Node.js version changes, update the `PATH=` line.

✅ **Step 5 done.**

---

## Step 6 — Update the App Later

Push your changes to GitHub first, then on the server:

```bash
# Backend
cd ~/htdocs/demo.yourdomain.com/shopify-backend
pg_dump "postgresql://postgres:<password>@localhost:5432/shopify_app_db" > ~/backups/db-$(date +%F).sql   # backup first
git pull && npm ci && npx prisma migrate deploy && npm run build
pm2 restart shopify-backend --update-env

# Frontend (no restart needed)
cd ~/htdocs/demo.yourdomain.com/shopify-forntend
git pull && npm ci && npm run build
```

- New table or column? Create the migration on your laptop (`npx prisma migrate dev --name ...`), commit it, and `npx prisma migrate deploy` applies it on the server (it's in the command above). **Never use `prisma db push` on the server.**
- Changed scopes or App URL in Shopify? Create a new version and **Release**.

✅ **Step 6 done.**

---

## Step 7 — Security Checklist

- [ ] Database changes only through Prisma migrations (`migrate deploy`), never `db push` on the server.
- [ ] `SHOPIFY_AUTH=off` is **not** set on the server.
- [ ] The `shops` table holds each store's access token: keep database backups private (consider encrypting the token).
- [ ] `chmod 600 .env` in both folders. `.env` never in GitHub.
- [ ] Use a separate database user (not `postgres`) for the app. Ask the admin.
- [ ] Client secret only in the backend `.env`, never in the frontend.
- [ ] Session token check in the backend (Step 4.5) ✅ built.
- [ ] Webhooks verified by HMAC signature (10.6).
- [ ] Filter every database query by shop if more than one store uses the app.
- [ ] Firewall (admin): only 22, 80, 443 open. Ports 3008 and 5432 closed.
- [ ] Request only the Shopify scopes you need.

✅ **Step 7 done.**

---

## Step 8 — Logs and Backups

- **Logs:** `pm2 logs shopify-backend` (live) · `pm2 list` (status, restarts, memory).
- **Stop logs filling the disk:** `pm2 install pm2-logrotate` (once).
- **Database backup** (CloudPanel's backups don't include PostgreSQL):

  ```bash
  mkdir -p ~/backups
  pg_dump "postgresql://postgres:<password>@localhost:5432/shopify_app_db" > ~/backups/db-$(date +%F).sql
  ```

- Run the backup before every big update. Copy important backups off the server (e.g. with WinSCP).

✅ **Step 8 done.**

---

## Step 9 — Troubleshooting

| Problem | Fix |
| --- | --- |
| `sudo`: "not allowed" | Normal for the site user. Ask the admin. |
| Domain shows `Cannot GET /` | Vhost not updated yet (Step 4.1). |
| `502 Bad Gateway` | Backend down or wrong port: `pm2 list`, `pm2 logs`, check `PORT=3008` and App Port. |
| `/api/...` gives 404 | `/` after the port in `proxy_pass`, or `VITE_API_URL` missing `/api` (rebuild). |
| `403 Forbidden` | Nginx can't read `dist/`. Check with `namei -l`. |
| Page refresh gives 404 | Missing `try_files ... /index.html` in the Vhost. |
| CORS error | `CORS_ORIGIN` must be the domain; restart with `--update-env`. |
| Database errors in `pm2 logs` | Recheck Step 3.2. |
| `.env` change does nothing | Backend: `pm2 restart ... --update-env`. Frontend: rebuild. |
| App gone after reboot | Redo Step 5, then `pm2 save`. |
| Blank box in Shopify | CSP line missing or wrong store name (Step 4.1). |
| `shopify is not defined` | App Bridge lines missing or not first (Step 4.3); rebuild. |
| "Port already in use" | Shared server: use only your own port (3008). |
| Every API call gets 401 "Missing Shopify session token" | App opened outside the Shopify admin (no App Bridge token). Open it from the store admin → **Apps**. On the laptop, set `SHOPIFY_AUTH=off`. |
| Prisma "engine not found" / client missing | Install scripts were blocked: `npm install-scripts approve prisma @prisma/engines`, then `npm ci`. |
| "Shopify token exchange failed" | Wrong `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`, or the app isn't installed on that store (10.2). |
| 502 "...missing access scope..." | The message names the scope. Add it in the Dev Dashboard, **Release**, open the app in the store and approve (10.1). |
| Product shows "Not synced" | The last push to Shopify failed (see `pm2 logs`), or it was saved without a Shopify session. Save the product again to push it. |
| Shopify API calls fail with 401/403 | No access token for the store, or a missing scope. Redo token exchange (10.2), add the scope and approve it (10.1). |
| Sync/import says a scope is missing | The installed app version lacks a scope (e.g. `read_locations`). Create a new version with all 4 scopes, **Release**, approve in the store (10.1). Check with `GET /api/shop`. |
| Webhooks never arrive | Version with the subscriptions not released, wrong URL, or `/api/webhooks/shopify` not reachable from the internet. |
| Every webhook gets 401 | Wrong `SHOPIFY_API_SECRET`, the HMAC is checked on the parsed JSON instead of the raw body (10.6), or the proxy changes the body on the way. |
| Webhooks arrive (200) but nothing changes | The store never opened the app, so there's no token in `shops`; or the product has several variants (skipped, see `pm2 logs`); or it was our own change (loop guard). |
| "Sync from Shopify" skips products | Several variants, custom options, `UNLISTED`, long or clashing SKU. The toast lists them with the reason. |
| Product keeps updating itself | Loop guard missing (10.7). |
| Stock change fails | Missing `write_inventory` / `read_locations`, or wrong inventory item / location ID (10.5). |

✅ **Step 9 done.**

---

## Step 10 — Sync Products with Shopify (Two-Way CRUD)

**The idea:** Shopify stays the source of truth. Our backend keeps a copy in PostgreSQL: import everything once, push our own changes to Shopify, and Shopify webhooks bring Shopify-side changes back. The React app keeps reading `/api/products` as before.

```
Shopify store ──(1) one-time import via Admin GraphQL API──► Nest backend ──► Postgres
     │                                                           ▲
     └──(2) webhooks: products/create, update, delete ───────────┘
                                                                 │
React app (inside the Shopify admin) ──► /api/products ──────────┘   (no change)
```

### Where we are

| Direction | What | Status |
| --- | --- | --- |
| Our app → Shopify | Create, edit, delete, stock changes (10.5) | ✅ Built (test on a real store) |
| Shopify → our app | First import (10.4), webhooks (10.6), "Sync from Shopify" button (10.8) | ✅ Built (test on a real store; subscribe the webhooks in the Dev Dashboard) |

Backend code: `src/shopify/` (token exchange, Admin API client, product mapper, product sync, webhooks), `src/auth/` (session guard). Shopify Admin GraphQL API version **2026-10**.

### How it works: the 7 flows

| # | Flow | What happens | Code |
| --- | --- | --- | --- |
| 1 | **Authentication** (every request) | React gets a session token (JWT) from App Bridge; axios sends it as `Authorization: Bearer`. `ShopifySessionGuard` verifies it and puts `{ shop, token }` on the request. | `lib/axios.ts` → `shopify-session.guard.ts` |
| 2 | **Token exchange** (backend → Shopify) | The session token is swapped once for an offline access token, saved in `shops` and reused. On a 401 from Shopify, get a fresh token and retry once. Test: `GET /api/shop`. | `shopify-auth.service.ts` → `shopify-admin.service.ts` → `shop.controller.ts` |
| 3 | **Import** ("Sync from Shopify") | `POST /api/shopify/sync` → `importAll` reads every product page by page; `upsert` updates the linked product, links one with the same SKU, or creates a new one. Single-variant products only. | `productsSlice.ts` → `shopify-sync.controller.ts` → `product-import.service.ts` → `product-mapper.ts` |
| 4 | **Product create / update / delete** (app → Shopify → Postgres) | Shopify first (`productSet` / `productDelete`), then the database. If the database save fails, undo it in Shopify or mark the product "out of sync". | `products.controller.ts` → `products.service.ts` → `product-sync.service.ts` |
| 5 | **Orders and stock** (app → Postgres → Shopify) | An order changes stock inside a database transaction; the new stock is then pushed with `inventorySetQuantities`. | `orders.service.ts` → `syncStock` in `product-sync.service.ts` |
| 6 | **Webhooks** (Shopify → Postgres, live) | All topics arrive at `POST /api/webhooks/shopify`: verify HMAC, answer 200 at once, drop duplicates, then process. `products/create\|update` → re-read + upsert (same as Flow 3). `products/delete` → delete, or unlink if on an order. `inventory_levels/update` → copy stock. `app/uninstalled` → delete the token. | `shopify-webhooks.controller.ts` → `shopify-webhook.service.ts` |
| 7 | **Loop guard** (links 4, 5, 6) | Our own pushes come back as webhooks. The backend remembers what it pushed (`pushedProducts`, `pushedStock`, `shopifySyncedAt`) and ignores those echoes. | `product-sync.service.ts` |

```
   React (App Bridge) ──(1 session token)──► NestJS ──► Postgres
                                               │  ▲
              (2 token exchange,               │  │  (3 import once,
               4 products, 5 stock pushed)     │  │   6 webhooks live)
                                               ▼  │
                                         Shopify Admin API

   7 loop guard: NestJS ignores webhooks that are echoes of its own pushes (4, 5)
```

The product list and detail pages just read Postgres through Flow 1, so they aren't a separate flow.

### 10.0 Decisions

- **Data flow: both ways.** Our app edits Shopify, and Shopify edits come back to us. So we need a loop guard (10.7).
- **One row per product (single variant).** A `Product` row = one Shopify product + its first variant. Products with several variants (sizes, colours) are skipped by the import and webhooks: saving them back with one variant would delete the others in Shopify.
- **Our own local products:** every product created or edited in our app is pushed to Shopify, so they become Shopify products too.
- **Orders too?** Not synced yet. Needs `read_orders`. Customer name and email are protected customer data: request access in the Dev Dashboard first.
- **More than one store?** Not supported yet: `Product` has no `shop` column. Add one and filter every query by it before a second store uses the app.

### 10.1 Permissions (scopes)

- `write_products`: create, edit, delete products (includes reading them).
- `write_inventory` + `read_inventory`: change and read stock.
- `read_locations`: find the store's primary location (where the stock is set).
- Missing a scope? The backend answers 502 with a message naming the scope to add. It's a Shopify setting, not a code bug.

How to add the scopes:

1. Dev Dashboard → our app → **Versions** → **Create version**. (A released version can't be edited.)
2. Under **Access scopes**, add all four: `write_products, write_inventory, read_inventory, read_locations`.
3. Click **Release**.
4. Store admin → **Apps** → open our app → Shopify asks to approve the new permissions → approve.

**Check:** with the app open in the admin, call `GET /api/shop`. It lists the scopes the store has actually granted. All four must be there.

### 10.2 Backend access token (token exchange) ✅

- The guard (Step 4.5) checks the session token. To call Shopify, the backend also needs an **offline access token**.
- `ShopifyAuthService` (`src/shopify/shopify-auth.service.ts`) does the exchange with a plain `fetch` (no library): session token + Client ID + secret → `POST https://<shop>/admin/oauth/access_token` (grant type `token-exchange`, requested type `offline-access-token`).
- The token is saved in the `shops` table (`domain`, `accessToken`, `scope`) and reused. If Shopify rejects it (401), the backend exchanges again once.
- **Test it:** open the app in the store and call `GET /api/shop` → store name, plan, currency and granted scopes.

### 10.3 Link our products to Shopify's ✅

- `Product` (in `prisma/schema.prisma`) has `shopifyProductId`, `shopifyVariantId`, `shopifyInventoryItemId` (Shopify GIDs, unique) and `shopifySyncedAt` (Shopify's `updatedAt` of the last sync, used by the loop guard; empty = not synced).
- Plus the Shopify product fields: status, image, product type, vendor, tags, price, compare-at price, cost, taxable, barcode, track inventory, continue selling when out of stock, stock, requires shipping, weight. Each field has a comment with its Shopify name (`product.*` / `variant.*` / `inventoryItem.*`).
- The location ID is not stored: the backend looks up the store's primary location and keeps it in memory.

### 10.4 First import ✅

- `POST /api/shopify/sync` (needs a Shopify session): reads `products(first: 25, after: ..., sortKey: ID)` page by page, with the first variant, its inventory item and the stock (`available`) at the primary location. 25 per page because each product costs about 17 query points and one query may cost at most 1,000.
- Throttled by Shopify (`THROTTLED` / HTTP 429)? The backend waits as long as Shopify says and retries (up to 5 times).
- Matches each product: same `shopifyProductId` → update; else an unlinked local product with the same SKU → link it; else create. Running it again never duplicates.
- **Shopify wins:** local changes that never reached Shopify ("Not synced") are overwritten.
- **Skipped and listed:** products with several variants, single-variant products with custom options, status `UNLISTED`, SKUs longer than 64 characters, and a SKU already used by a product linked to another Shopify product.
- Returns `{ created, updated, linked, skipped: [{ title, reason }], total }`.
- Code: `src/shopify/product-import.service.ts`, `shopify-sync.controller.ts`; Shopify → our fields in `product-mapper.ts` (`fromShopifyProduct`).
- Very large store? Use bulk operations instead.

### 10.5 Our app → Shopify (CRUD) ✅

| In our app | Shopify call (Admin GraphQL 2026-10) | Then |
| --- | --- | --- |
| Create product | `productSet` (synchronous), no IDs | Save the returned product / variant / inventory item IDs and Shopify's `updatedAt` |
| Edit product (any field, incl. price and stock) | `productSet` with the product and variant IDs | Save Shopify's `updatedAt` as `shopifySyncedAt`. A product not linked yet (or deleted in Shopify) is created and linked. |
| Order changes stock | `inventorySetQuantities` (`@idempotent` key, `changeFromQuantity: null`) | Best effort: on failure the product is marked "Not synced" |
| Delete product | `productDelete` ("not found" counts as done) | Then delete locally. Products used in orders can't be deleted (409). |

- **Shopify first:** for create / edit / delete the backend calls Shopify first. If Shopify refuses (`userErrors` → 422) or can't be reached (502), nothing is saved locally and the error is shown as a toast. If the local save fails after Shopify created the product, the backend deletes it again in Shopify.
- Local checks (e.g. duplicate SKU → 409) run before calling Shopify.
- No Shopify session (laptop with `SHOPIFY_AUTH=off`): saved locally only, shown as "Not synced".
- Code: `src/shopify/product-mapper.ts` (our fields ↔ Shopify fields) and `src/shopify/product-sync.service.ts`.

### 10.6 Shopify → our app (webhooks) ✅

Code: `src/shopify/shopify-webhooks.controller.ts` (route + HMAC) and `shopify-webhook.service.ts` (handling). Webhooks are only processed for stores that have opened the app at least once (a row in `shops`), because the backend re-reads the product with that store's saved token.

1. **Keep the raw body** (the signature check needs it), in `main.ts`:

   ```ts
   const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
   app.useBodyParser('json', { limit: '5mb' });   // product payloads can be bigger than the 100 kb default
   ```

2. **Add the endpoint** `POST /api/webhooks/shopify`:
   - No session-token guard here (Shopify doesn't send one).
   - Check the `X-Shopify-Hmac-Sha256` header: HMAC-SHA256 of the raw body with `SHOPIFY_API_SECRET`, base64. Compare with `crypto.timingSafeEqual`. Doesn't match → 401.
   - Read the topic from the `X-Shopify-Topic` header, and the store from `X-Shopify-Shop-Domain`.
   - **Skip duplicates:** Shopify can send the same event twice. Remember `X-Shopify-Webhook-Id` and ignore repeats.

3. **Handle each event:**

   | Topic | What we do |
   | --- | --- |
   | `products/create`, `products/update` | Loop guard first (10.7). Then read the product again from the Admin API (with the store's saved token from `shops`) and upsert it by `shopifyProductId`, using the same mapping as the import. Several variants → skipped. |
   | `products/delete` | Delete the product, or unlink it (clear the Shopify IDs) if orders use it. |
   | `inventory_levels/update` | Set our stock to Shopify's `available` when it's for the product's inventory item at the primary location. Needs `read_inventory`. |
   | `app/uninstalled` | Delete the store's row in `shops`. |
   | `customers/data_request`, `customers/redact`, `shop/redact` | Compliance webhooks: only required for App Store apps. Answered with 200. |
   | Anything else | 200, ignored. |

4. **Subscribe to the topics.** In the Dev Dashboard (new version → webhooks), or, if you manage the app with Shopify CLI, in `shopify.app.toml`:

   ```toml
   [webhooks]
   api_version = "2026-10"

   [[webhooks.subscriptions]]
   topics = ["products/create", "products/update", "products/delete", "inventory_levels/update", "app/uninstalled"]
   uri = "https://demo.yourdomain.com/api/webhooks/shopify"
   ```

   Then **Release** the new version (CLI: `shopify app deploy`). Webhooks only start after the release.

5. **Reply fast:** return 200 right away, do the database work after. Shopify retries failed deliveries and removes webhooks that keep failing.

### 10.7 Loop guard

```
   our app ──productSet─────► Shopify ──products/update webhook──► our app
      ▲                                                               │
      └──────────── without a guard: updates itself again ◄───────────┘
```

- When our app updates Shopify, save **Shopify's** `updatedAt` (from the `productSet` response) as `shopifySyncedAt` (10.5). Not our server's clock: the two clocks can differ.
- When a webhook arrives: if its `updated_at` is not newer than `shopifySyncedAt`, it's our own change → ignore it.
- **Never call Shopify write APIs from inside the webhook handler** (reading the product is fine).
- Stock pushes from orders don't change the product's `updatedAt`, so they leave `shopifySyncedAt` as it is. Instead the pushed quantities are remembered for 10 minutes, so their `inventory_levels/update` echo is ignored.
- Imports and webhooks never overwrite a row whose `shopifySyncedAt` is newer than the version just read from Shopify.
- **One server only:** the duplicate-webhook memory (6 hours), the loop-guard memory and the location cache live in memory. Fine with one PM2 process; with several, move them to the database or Redis.

### 10.8 Frontend

- "Synced" / "Not synced" badge in the products table (Shopify column) and the last sync time in **View details** ✅.
- **"Sync from Shopify"** button next to "Add product" (spins while running) → Redux thunk `syncFromShopify` → `POST /api/shopify/sync` → reload the list. Toast: "Synced from Shopify: 3 new, 5 updated, 1 linked", plus a warning toast listing up to 5 skipped products ✅.
- Errors from Shopify (422 / 502, missing scope) appear as toasts through the axios interceptor.

### Test checklist

- [ ] Create / edit / delete in our app → visible in Shopify admin.
- [ ] Create / edit / delete in Shopify admin → visible in our app (within seconds).
- [ ] Edit in our app → only one update, no loop (check `pm2 logs`).
- [ ] Fake webhook with a wrong signature → 401.
- [ ] Uninstall the app → store's row removed from `shops`.
- [ ] "Sync from Shopify" → Shopify's products appear; products with several variants are listed as skipped.
- [ ] Change stock in Shopify admin → our stock updates (`inventory_levels/update`).
- [ ] Place an order in our app → stock goes down in Shopify too.
- [ ] Remove a scope → saving a product shows the "missing scope" message.

✅ **Step 10 done.**

---

## Step 11 — Recreate the App with Shopify CLI (settings in one file)

**Why:** with Shopify CLI, the App URL, scopes and webhooks live in one file (`shopify.app.toml`). One command (`shopify app deploy`) sets them all, so there's no clicking in the Dev Dashboard and nothing gets forgotten. Here we delete the old app and create a new one from the CLI.

### 11.1 Delete the old app

- Dev Dashboard → old app → **Settings** → **Delete app**.
- This uninstalls it from the store. Products in Postgres stay, and their Shopify product IDs still work (they belong to the store, not the app).

### 11.2 Create the new app from the CLI

- Needs Shopify CLI (`npm i -g @shopify/cli`) and a login: `shopify auth login`.
- On your laptop, make an empty folder `shopify-app-config` with a small `package.json`: `{"name":"shopify-app-config","private":true}`
- In that folder run `shopify app config link` and answer: your organization → **Create a new app: Yes** → name (e.g. `Our App v2`).
- This creates the app in the Dev Dashboard and writes `shopify.app.toml` with the new `client_id`.

### 11.3 Edit shopify.app.toml

Keep the `client_id` the CLI wrote; make the rest look like this:

```toml
client_id = "KEEP-THE-ONE-CLI-WROTE"
name = "Our App v2"
application_url = "https://demo.yourdomain.com"
embedded = true

[access_scopes]
scopes = "write_products,write_inventory,read_inventory,read_locations"

[auth]
redirect_urls = [ "https://demo.yourdomain.com/api/auth/callback" ]

[webhooks]
api_version = "2026-10"

  [[webhooks.subscriptions]]
  topics = [ "products/create", "products/update", "products/delete", "inventory_levels/update", "app/uninstalled" ]
  uri = "https://demo.yourdomain.com/api/webhooks/shopify"

[build]
include_config_on_deploy = true
automatically_update_urls_on_dev = false
```

- `redirect_urls` is required in the file, but our backend doesn't use it (Shopify installs the app itself, Step 4.2).
- `automatically_update_urls_on_dev = false`: `shopify app dev` won't replace our real App URL with a tunnel URL.
- Commit this folder to GitHub (no secrets in it).

### 11.4 Deploy (creates and releases the version)

- Run `shopify app deploy`.
- Check: Dev Dashboard → new app → **Versions**. The new version shows the scopes, App URL and webhook topics.
- Later changes (new scope, new topic): edit the toml → `shopify app deploy` again.

### 11.5 Put the new credentials in the apps

Dev Dashboard → new app → **Settings** → copy the **Client ID** and **Client secret**.

| File | Variable | Value |
| --- | --- | --- |
| `shopify-backend/.env` (server and laptop) | `SHOPIFY_API_KEY` | Client ID |
| | `SHOPIFY_API_SECRET` | Client secret (also used to verify webhooks) |
| `shopify-forntend/.env` | `VITE_SHOPIFY_API_KEY` | Client ID |

Then on the server:

- Frontend: `npm run build` (Vite bakes the key in at build time).
- Backend: `pm2 restart shopify-backend --update-env`

### 11.6 Clear the old app's token

The token saved in Postgres belongs to the deleted app:

```bash
psql "postgresql://postgres:<password>@localhost:5432/shopify_app_db" -c "DELETE FROM shops;"
```

Without this, webhooks would try the dead token first. (Requests from the app would recover by themselves: 401 → new token exchange.)

### 11.7 Install the app and open it once

1. Dev Dashboard → new app → **Overview** → **Install app** → pick your dev store → approve the scopes.
2. Store admin → **Apps** → open the app → the products page loads. This runs the token exchange, and a new row appears in `shops`. **Webhooks need this row.**

### 11.8 Test the webhooks

1. Edit a product's title or price in the Shopify admin and save.
2. On the server, `pm2 logs shopify-backend` shows: `products/update "…" (gid://shopify/Product/…) → local product N updated`
3. Dev Dashboard → new app → **Logs** shows each delivery and our 200 response.

| What you see | Cause |
| --- | --- |
| Nothing in Logs | Version not released (11.4), or wrong webhook URL |
| 401 in Logs | `SHOPIFY_API_SECRET` on the server is still the old one (11.5) |
| 200, but the log says "no saved access token" | The app wasn't opened in the store yet (11.7, point 2) |
| 200, but "ignored: our own change" | Normal for changes made from our app (loop guard, 10.7) |

✅ **Step 11 done.**

✅ **All done.**

---

## Documentation Links

| Step | Topic | Link |
| --- | --- | --- |
| 1 | NestJS | [docs.nestjs.com](https://docs.nestjs.com/) |
| 1 | NestJS + Prisma (database) | [NestJS: Prisma](https://docs.nestjs.com/recipes/prisma) |
| 1 | NestJS `.env` config | [NestJS: Configuration](https://docs.nestjs.com/techniques/configuration) |
| 1, 3, 6 | Prisma (schema, migrations, `migrate deploy`) | [prisma.io/docs](https://www.prisma.io/docs) · [Prisma: Migrate in production](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production) |
| 1 | Vite (React) | [Vite: Getting Started](https://vite.dev/guide/) |
| 1, 3 | Vite `.env` variables | [Vite: Env Variables](https://vite.dev/guide/env-and-mode) |
| 1 | React Router | [reactrouter.com](https://reactrouter.com/) |
| 1 | PostgreSQL download | [postgresql.org/download](https://www.postgresql.org/download/) |
| 2 | CloudPanel docs | [CloudPanel: Introduction](https://www.cloudpanel.io/docs/v2/introduction/) |
| 2 | Install CloudPanel | [CloudPanel: Installation](https://www.cloudpanel.io/docs/v2/getting-started/other/) |
| 2 | Add a site | [CloudPanel: Add Site](https://www.cloudpanel.io/docs/v2/frontend-area/add-site/) |
| 2 | Firewall / security | [CloudPanel: Security](https://www.cloudpanel.io/docs/v2/admin-area/security/) |
| 4 | Vhost editor | [CloudPanel: Vhost](https://www.cloudpanel.io/docs/v2/frontend-area/vhost/) |
| 3, 5 | PM2 on CloudPanel (incl. reboot cron) | [CloudPanel: PM2](https://www.cloudpanel.io/docs/v2/nodejs/deployment/pm2/) |
| 2 | PuTTY | [putty.org](https://www.putty.org/) |
| 3 | GitHub access token (private repos) | [GitHub: Personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) |
| 3, 8 | PM2 basics / logs | [PM2: Quick Start](https://pm2.keymetrics.io/docs/usage/quick-start/) · [PM2: Logs](https://pm2.keymetrics.io/docs/usage/log-management/) |
| 4 | Nginx `proxy_pass` | [Nginx: proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) |
| 4 | Shopify Dev Dashboard | [Shopify: Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard) |
| 4 | App Bridge | [Shopify: App Bridge](https://shopify.dev/docs/api/app-bridge) |
| 4 | Iframe protection (CSP header) | [Shopify: Iframe protection](https://shopify.dev/docs/apps/build/security/set-up-iframe-protection) |
| 4 | Install / custom distribution | [Shopify: Distribution](https://shopify.dev/docs/apps/launch/distribution) |
| 4.5 | Session tokens | [Shopify: Session tokens](https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens) |
| 4.5 | Token exchange | [Shopify: Token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange) |
| 1 | Redux Toolkit (thunks) | [Redux Toolkit: createAsyncThunk](https://redux-toolkit.js.org/api/createAsyncThunk) |
| 1 | Forms + validation | [react-hook-form](https://react-hook-form.com/) · [zod](https://zod.dev/) |
| 1 | axios interceptors | [axios: Interceptors](https://axios-http.com/docs/interceptors) |
| 4.1 | NestJS serve static (Plan B) | [NestJS: Serve Static](https://docs.nestjs.com/recipes/serve-static) |
| 8 | Database backup (`pg_dump`) | [PostgreSQL: pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) |
| 10.1 | Access scopes | [Shopify: Access scopes](https://shopify.dev/docs/api/usage/access-scopes) |
| 10.3 | Product variants | [Shopify: ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant) |
| 10.4 | `products` query | [Shopify: products](https://shopify.dev/docs/api/admin-graphql/latest/queries/products) |
| 10.4 | Bulk operations (large stores) | [Shopify: Bulk operations](https://shopify.dev/docs/api/usage/bulk-operations/queries) |
| 10.5 | Create / edit product | [Shopify: productSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productSet) |
| 10.5 | Change stock | [Shopify: inventorySetQuantities](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventorySetQuantities) |
| 10.5 | Delete product | [Shopify: productDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productDelete) |
| 10.5 | Primary location | [Shopify: location](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/location) |
| 10.6 | Webhooks overview | [Shopify: Webhooks](https://shopify.dev/docs/apps/build/webhooks) |
| 10.6 | Subscribe + verify HMAC (HTTPS) | [Shopify: HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https) |
| 10.6 | Webhook topics + payloads | [Shopify: Webhook topics](https://shopify.dev/docs/api/webhooks) |
| 10.6 | Webhook topic list (2026-10) | [Shopify: WebhookSubscriptionTopic](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic) |
| 10.6 | NestJS raw body | [NestJS: Raw body](https://docs.nestjs.com/faq/raw-body) |
| 10.0 | Protected customer data (orders) | [Shopify: Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) |
