# Sanmar Portal — Railway Deployment Guide

Everything runs on Railway: the Node.js backend **and** the PostgreSQL
database. No external database service needed.

---

## Step 1 — Create the Railway Project

1. Go to [railway.com/dashboard](https://railway.com/dashboard) → **New Project**
2. Choose **Deploy from GitHub repo** → connect your repo
3. Railway detects Node.js automatically via Railpack

---

## Step 2 — Add PostgreSQL (inside the same project)

1. In the project canvas, click **+ Add Service → Database → PostgreSQL**
2. Railway spins up Postgres and **auto-injects `DATABASE_URL`** into every
   service in the project via the private network  
   (`postgresql://postgres:PASSWORD@postgres.railway.internal:5432/railway`)
3. No SSL config required — it's a private VPC connection

---

## Step 3 — Set Environment Variables

In your **backend service → Variables tab**, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | *(64-char random hex)* |
| `JWT_REFRESH_SECRET` | *(different 64-char hex)* |
| `JWT_ACCESS_EXPIRES` | `15m` |
| `JWT_REFRESH_EXPIRES` | `7d` |
| `APP_URL` | `https://your-domain.up.railway.app` |
| `ALLOWED_ORIGINS` | `https://your-domain.up.railway.app` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `projects.sanmar@gmail.com` |
| `SMTP_PASS` | *(Gmail App Password)* |
| `SMTP_FROM` | `Sanmar Portal <projects.sanmar@gmail.com>` |
| `WHAPI_TOKEN` | `sVYvyvoFD5bnCwKy2w5SNXnMjrisQQU1` |
| `WHAPI_CHANNEL` | `GAMORA-KPCU9#` |
| `WHAPI_ENDPOINT` | `https://gate.whapi.cloud/messages/text` |
| `TZ` | `Asia/Dhaka` |

> **`DATABASE_URL` is already set automatically — do not add it manually.**

Generate JWT secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Step 4 — Run Migrations & Seed

Open a **Railway shell** (service → ··· → Connect → Shell), or use the
Railway CLI:

```bash
# Install CLI
npm i -g @railway/cli
railway login
railway link   # select your project

# Run in order:
railway run node scripts/migrate.js   # creates all tables
railway run node scripts/seed.js      # inserts employees, projects, SOP tasks
```

---

## Step 5 — Import Existing Data from Google Sheets (optional)

```bash
railway run node scripts/importFromSheets.js
```

Requires `GOOGLE_SERVICE_ACCOUNT_B64` and `GOOGLE_SHEET_ID` env vars.

---

## Step 6 — Generate Public Domain

In your backend service → **Settings → Networking → Generate Domain**  
You'll get: `https://sanmar-portal-production.up.railway.app`

---

## Step 7 — Custom Domain via Cloudflare (optional)

1. In Railway: **Settings → Networking → Custom Domain** → enter `portal.mysanmar.com`
2. Railway shows you a `CNAME` target
3. In Cloudflare DNS: add `CNAME portal → <railway-target>` (proxy **off** initially, enable after verified)

---

## Architecture on Railway

```
Railway Project: sanmar-portal
├── Service: backend          (Node.js / Express)
│   ├── Reads DATABASE_URL from private network
│   ├── Serves frontend HTML from /public
│   └── Runs cron jobs (overdue scanner, reminders)
│
└── Service: postgres         (Railway managed PostgreSQL)
    └── Private URL: postgres.railway.internal:5432
```

---

## Useful Commands

```bash
# View live logs
railway logs

# Run healthcheck
railway run node scripts/healthcheck.js

# Open DB with psql
railway connect postgres
```
