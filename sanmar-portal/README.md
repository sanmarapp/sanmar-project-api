# Sanmar Project Management Portal v2.0

Production-grade project management system for Sanmar Real Estate, Bangladesh.

## Stack
- **Runtime**: Node.js 20 + Express.js
- **Database**: PostgreSQL 16 on Railway (private network)
- **Hosting**: Railway (auto-deploy from GitHub)
- **Auth**: JWT (httpOnly cookies) + refresh token rotation
- **Notifications**: WhatsApp (Whapi.Cloud) + Gmail SMTP + in-app
- **Background jobs**: node-cron (overdue scanner, silent detector, daily reminders)

## Quick Start (Local)

```bash
cp .env.example .env   # fill in your values
npm install
node scripts/migrate.js
node scripts/seed.js
npm run dev
# → http://localhost:3000
```

## Deploy to Railway
See **RAILWAY_DEPLOY.md** for full step-by-step instructions.

## Architecture
```
client (browser/mobile)
       │
       ▼
Railway (Node.js/Express)
  ├── /api/v1/auth        — JWT login/refresh/logout
  ├── /api/v1/tasks       — CRUD + bulk update + activity log
  ├── /api/v1/projects    — Project list + SOP templates
  ├── /api/v1/reports     — Executive summary, control tower, meeting board
  ├── /api/v1/notifications — In-app + WA + email
  └── /api/v1/users       — User management (admin)
       │
       ▼
Railway PostgreSQL (private VPC)
  tables: users, projects, sop_tasks, tasks,
          task_assignees, activity_log,
          notifications, refresh_tokens, report_cache
```

## Key Improvements over Google Apps Script
| Issue | Old | New |
|---|---|---|
| Load time | 8–15s (reads all sheets) | <300ms (DB query) |
| Security | Plaintext passwords in code | bcrypt + JWT httpOnly |
| WhatsApp | Broken (empty phone map) | Working (phones in DB) |
| Activity history | 5 slots (oldest deleted) | Unlimited (DB table) |
| Concurrent writes | Sheets race conditions | PostgreSQL ACID |
| Offline | None | PWA (mobile) |
| Notifications | Row-by-row API calls | Batch DB inserts |

## Scripts
```bash
npm run migrate        # Create DB schema
npm run seed           # Insert employees + projects + SOP tasks
npm run import-sheets  # One-time migration from Google Sheets
npm test               # Healthcheck (env + JWT + DB)
```

## Credentials (change after first login)
- Admin: `projects.sanmar@gmail.com` / `sanmar123`
- Admin2: `admin2.sanmar@gmail.com` / `sanmar_admin2`
- Mgmt1: `management1.sanmar@gmail.com` / `mgmt_view_2024`
- Mgmt2: `management2.sanmar@gmail.com` / `mgmt_view_2025`

See `scripts/seed.js` for all 32 employee credentials.
