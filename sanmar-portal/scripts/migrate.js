'use strict';
/**
 * Database migration — run once against Railway PostgreSQL
 * Usage: node scripts/migrate.js
 *
 * Creates all tables, indexes, and constraints for the Sanmar Portal.
 * Idempotent: safe to run multiple times (IF NOT EXISTS on all objects).
 */
require('dotenv').config();
const { Pool } = require('pg');
const logger   = require('../src/utils/logger');

const needsSsl = (process.env.DATABASE_URL || '').includes('sslmode=require');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

const SCHEMA = `
-- ═══════════════════════════════════════════════
-- SANMAR PORTAL — PostgreSQL Schema v2.0
-- Database: Railway PostgreSQL
-- ═══════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for fast text search

-- ── ENUMS ────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'management', 'lead', 'employee', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('Not Started', 'On Going', 'Completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notif_status AS ENUM ('Unread', 'Read');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notif_channel AS ENUM ('in_app', 'email', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_type AS ENUM ('SPP', 'Non SPP', 'Large Scale', 'Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── USERS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(80)  NOT NULL,
  role          user_role    NOT NULL DEFAULT 'employee',
  phone         VARCHAR(20),                         -- WhatsApp number, e.g. "8801755644548"
  department    VARCHAR(60),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  has_meeting   BOOLEAN      NOT NULL DEFAULT FALSE, -- Meeting Board access
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active  ON users(is_active);

-- ── REFRESH TOKENS ───────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user    ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ── PROJECTS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(120) NOT NULL UNIQUE,
  project_type  project_type NOT NULL DEFAULT 'SPP',
  authority     VARCHAR(60),                -- CDA, RAJUK, COXDA etc.
  lo_profile    TEXT,                       -- Land Owner profile
  commencement  DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_name      ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_is_active ON projects(is_active);

-- ── SOP TEMPLATES ────────────────────────────
-- Master list of 70 standard tasks (same for every project)
CREATE TABLE IF NOT EXISTS sop_tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_code       VARCHAR(10)  NOT NULL UNIQUE, -- T-01, T-02 …
  name            TEXT         NOT NULL,
  department      VARCHAR(80)  NOT NULL,
  lead_time_spp   INT,
  lead_time_nonspp INT,
  lead_time_large INT,
  dependency_code VARCHAR(10), -- task_code of prerequisite task (self-ref by code)
  display_order   INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sop_task_code ON sop_tasks(task_code);

-- ── TASKS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_code       VARCHAR(10)  NOT NULL,         -- T-01…T-70
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  department      VARCHAR(80),
  lead_time       INT,
  start_date      DATE,
  planned_end     DATE,
  actual_end      DATE,
  slack_note      TEXT,
  status          task_status NOT NULL DEFAULT 'Not Started',
  is_critical     BOOLEAN NOT NULL DEFAULT FALSE,
  is_overdue      BOOLEAN NOT NULL DEFAULT FALSE, -- computed, updated by cron
  is_silent       BOOLEAN NOT NULL DEFAULT FALSE, -- no update in 48h+
  sop_task_id     UUID REFERENCES sop_tasks(id),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, task_code)
);
CREATE INDEX IF NOT EXISTS idx_tasks_project       ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status        ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_planned_end   ON tasks(planned_end);
CREATE INDEX IF NOT EXISTS idx_tasks_is_overdue    ON tasks(is_overdue);
CREATE INDEX IF NOT EXISTS idx_tasks_is_silent     ON tasks(is_silent);
-- Full-text search across task name
CREATE INDEX IF NOT EXISTS idx_tasks_name_trgm     ON tasks USING gin(name gin_trgm_ops);

-- ── TASK ASSIGNEES ─────────────────────────────
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignees_task    ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_assignees_user    ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_assignees_primary ON task_assignees(task_id, is_primary);

-- ── ACTIVITY LOG ─────────────────────────────
-- Unlimited history — replaces the 5-slot text column approach
CREATE TABLE IF NOT EXISTS activity_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id),
  user_label VARCHAR(60),          -- email prefix, kept for display
  comment    TEXT NOT NULL,
  -- change tracking
  field_changed   VARCHAR(40),     -- 'status', 'actual_end', 'assignee' etc.
  old_value        TEXT,
  new_value        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_task       ON activity_log(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_created    ON activity_log(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user       ON activity_log(user_id);

-- ── NOTIFICATIONS ────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  message     TEXT NOT NULL,
  channel     notif_channel NOT NULL DEFAULT 'in_app',
  status      notif_status  NOT NULL DEFAULT 'Unread',
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, status) WHERE status = 'Unread';
CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications(user_id, created_at DESC);

-- ── REPORT CACHE ─────────────────────────────
-- Stores pre-computed report results, invalidated on task update
CREATE TABLE IF NOT EXISTS report_cache (
  cache_key  VARCHAR(80) PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON report_cache(expires_at);

-- ── UPDATED_AT TRIGGER ───────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ language 'plpgsql';

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── OVERDUE VIEW ─────────────────────────────
CREATE OR REPLACE VIEW v_overdue_tasks AS
SELECT
  t.id,
  t.task_code,
  t.name,
  t.department,
  t.planned_end,
  t.status,
  p.name AS project_name,
  CURRENT_DATE - t.planned_end AS days_overdue
FROM tasks t
JOIN projects p ON p.id = t.project_id
WHERE t.status != 'Completed'
  AND t.planned_end IS NOT NULL
  AND t.planned_end < CURRENT_DATE;

-- ── EMPLOYEE PERFORMANCE VIEW ─────────────────
CREATE OR REPLACE VIEW v_employee_performance AS
SELECT
  u.id   AS user_id,
  u.name,
  u.email,
  u.department,
  COUNT(ta.task_id)                                             AS total_tasks,
  COUNT(ta.task_id) FILTER (WHERE t.status = 'Completed')      AS completed,
  COUNT(ta.task_id) FILTER (
    WHERE t.status = 'Completed'
    AND t.actual_end IS NOT NULL
    AND t.planned_end IS NOT NULL
    AND t.actual_end <= t.planned_end)                         AS on_time,
  COUNT(ta.task_id) FILTER (WHERE t.is_overdue = TRUE)         AS delayed
FROM users u
LEFT JOIN task_assignees ta ON ta.user_id = u.id AND ta.is_primary = TRUE
LEFT JOIN tasks t ON t.id = ta.task_id
WHERE u.is_active = TRUE
GROUP BY u.id, u.name, u.email, u.department;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    logger.info('Running database migration...');
    await client.query(SCHEMA);
    logger.info('Migration complete — all tables, indexes and views created.');
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
