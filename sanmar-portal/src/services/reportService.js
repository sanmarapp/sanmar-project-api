'use strict';
const { query }    = require('../db/pool');
const { todayBD }  = require('../utils/dateUtils');
const logger       = require('../utils/logger');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── SIMPLE DB-BACKED CACHE ───────────────────────────────────────
async function getCached(key) {
  const { rows } = await query(
    `SELECT payload FROM report_cache WHERE cache_key=$1 AND expires_at > NOW()`,
    [key]
  );
  return rows[0] ? rows[0].payload : null;
}

async function setCache(key, payload) {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  await query(
    `INSERT INTO report_cache (cache_key, payload, expires_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (cache_key) DO UPDATE SET payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at, created_at=NOW()`,
    [key, JSON.stringify(payload), expiresAt]
  );
}

async function invalidateCache() {
  await query(`DELETE FROM report_cache`);
  logger.info('Report cache invalidated');
}

// ── EXECUTIVE SUMMARY ─────────────────────────────────────────────
async function getExecutiveSummary() {
  const cached = await getCached('exec_summary');
  if (cached) return cached;

  const today = todayBD();

  // Portfolio totals
  const { rows: totals } = await query(`
    SELECT
      COUNT(*)                                                    AS total,
      COUNT(*) FILTER (WHERE status='Completed')                  AS completed,
      COUNT(*) FILTER (WHERE status='On Going')                   AS ongoing,
      COUNT(*) FILTER (WHERE status='Not Started')                AS not_started,
      COUNT(*) FILTER (WHERE is_overdue=TRUE)                     AS delayed,
      COUNT(*) FILTER (WHERE is_critical=TRUE AND status!='Completed') AS critical,
      COUNT(*) FILTER (WHERE is_silent=TRUE)                      AS silent
    FROM tasks
  `);

  // By project
  const { rows: byProject } = await query(`
    SELECT
      p.name   AS project,
      p.project_type,
      COUNT(t.id)                                              AS total,
      COUNT(*) FILTER (WHERE t.status='Completed')             AS done,
      COUNT(*) FILTER (WHERE t.status='On Going')              AS ongoing,
      COUNT(*) FILTER (WHERE t.status='Not Started')           AS not_started,
      COUNT(*) FILTER (WHERE t.is_overdue=TRUE)                AS delayed,
      ROUND(COUNT(*) FILTER (WHERE t.status='Completed')::NUMERIC / NULLIF(COUNT(*),0)*100,1) AS pct_complete
    FROM projects p
    LEFT JOIN tasks t ON t.project_id=p.id
    WHERE p.is_active=TRUE
    GROUP BY p.id, p.name, p.project_type, p.display_order
    ORDER BY p.display_order
  `);

  // Delay projections — tasks that are overdue and have downstream dependencies
  const { rows: delayProjections } = await query(`
    SELECT
      t.id, t.task_code, t.name, t.planned_end, t.status,
      p.name AS project_name,
      CURRENT_DATE - t.planned_end AS days_overdue,
      st.dependency_code
    FROM tasks t
    JOIN projects p ON p.id=t.project_id
    LEFT JOIN sop_tasks st ON st.task_code=t.task_code
    WHERE t.is_overdue=TRUE
    ORDER BY (CURRENT_DATE - t.planned_end) DESC
    LIMIT 20
  `);

  // Performance
  const { rows: performance } = await query(`SELECT * FROM v_employee_performance ORDER BY total_tasks DESC`);

  // Urgent: due today or tomorrow
  const { rows: urgent } = await query(`
    SELECT t.id, t.task_code, t.name, t.planned_end, t.status,
           p.name AS project_name,
           (SELECT json_agg(u.email) FROM task_assignees ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id AND ta.is_primary=TRUE) AS primary_emails
    FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status != 'Completed'
      AND t.planned_end IS NOT NULL
      AND t.planned_end BETWEEN $1 AND ($1::date + INTERVAL '1 day')::date
    ORDER BY t.planned_end, p.display_order
  `, [today]);

  const summary = {
    generatedAt:     new Date().toISOString(),
    ...totals[0],
    byProject,
    delayProjections,
    performance,
    urgent,
  };

  await setCache('exec_summary', summary);
  return summary;
}

// ── CONTROL TOWER (admin-only deeper view) ────────────────────────
async function getControlTower() {
  const cached = await getCached('control_tower');
  if (cached) return cached;

  const today = todayBD();

  const { rows: urgent } = await query(`
    SELECT t.id, t.task_code, t.name, t.planned_end, t.status, t.is_overdue,
           p.name AS project_name, p.id AS project_id,
           (SELECT json_agg(json_build_object('email',u.email,'phone',u.phone))
            FROM task_assignees ta JOIN users u ON u.id=ta.user_id
            WHERE ta.task_id=t.id AND ta.is_primary=TRUE) AS primary_assignees
    FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status != 'Completed'
      AND t.planned_end BETWEEN $1 AND ($1::date + INTERVAL '1 day')::date
    ORDER BY t.planned_end
  `, [today]);

  const { rows: silent } = await query(`
    SELECT t.id, t.task_code, t.name, t.status, t.updated_at,
           p.name AS project_name,
           NOW() - t.updated_at AS silent_for,
           (SELECT json_agg(json_build_object('email',u.email))
            FROM task_assignees ta JOIN users u ON u.id=ta.user_id
            WHERE ta.task_id=t.id AND ta.is_primary=TRUE) AS primary_assignees
    FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.is_silent=TRUE AND t.status='On Going'
    ORDER BY t.updated_at ASC
  `);

  const { rows: critical } = await query(`
    SELECT t.id, t.task_code, t.name, t.planned_end, t.status, t.is_overdue,
           p.name AS project_name,
           (SELECT json_agg(json_build_object('email',u.email))
            FROM task_assignees ta JOIN users u ON u.id=ta.user_id
            WHERE ta.task_id=t.id AND ta.is_primary=TRUE) AS primary_assignees
    FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE (t.is_critical=TRUE OR t.is_overdue=TRUE) AND t.status != 'Completed'
    ORDER BY t.is_overdue DESC, t.planned_end ASC
  `);

  const { rows: performance } = await query(
    `SELECT * FROM v_employee_performance ORDER BY delayed DESC, total_tasks DESC`
  );

  const ct = { generatedAt: new Date().toISOString(), urgent, silent, critical, performance };
  await setCache('control_tower', ct);
  return ct;
}

// ── MEETING BOARD ─────────────────────────────────────────────────
async function getMeetingBoard() {
  const today = todayBD();
  const { rows } = await query(`
    SELECT
      t.id, t.task_code, t.name, t.department,
      t.status, t.planned_end, t.is_overdue, t.is_silent,
      p.name AS project_name, p.id AS project_id,
      -- latest activity
      (SELECT al.comment FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_activity,
      (SELECT al.user_label FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_user,
      (SELECT al.created_at FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_at,
      -- assignees
      (SELECT json_agg(json_build_object('email',u.email,'name',u.name,'is_primary',ta.is_primary))
       FROM task_assignees ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id) AS assignees,
      -- dependency
      st.dependency_code
    FROM tasks t
    JOIN projects p ON p.id=t.project_id
    LEFT JOIN sop_tasks st ON st.task_code=t.task_code
    WHERE t.status IN ('On Going','Not Started')
      AND (t.planned_end IS NULL OR t.planned_end >= $1)
    ORDER BY p.display_order, t.task_code
  `, [today]);
  return rows;
}

// ── WEEKLY TEXT SUMMARY ───────────────────────────────────────────
async function generateWeeklySummary() {
  const s = await getExecutiveSummary();
  const lines = [
    'SANMAR PROJECT PORTAL — WEEKLY SUMMARY',
    `Generated: ${new Date().toLocaleString('en-BD', { timeZone:'Asia/Dhaka' })}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'PORTFOLIO OVERVIEW',
    `Total Tasks  : ${s.total}`,
    `Completed    : ${s.completed}`,
    `On Going     : ${s.ongoing}`,
    `Not Started  : ${s.not_started}`,
    `Delayed      : ${s.delayed}`,
    `Critical     : ${s.critical}`,
    `Silent (48h+): ${s.silent}`,
    '',
    'PROJECT BREAKDOWN',
    ...s.byProject.map(p =>
      `${p.project.padEnd(34)} Total:${String(p.total).padStart(4)}  Done:${String(p.done).padStart(4)}  Ongoing:${String(p.ongoing).padStart(4)}  Delayed:${String(p.delayed).padStart(4)}  ${p.pct_complete}%`
    ),
  ];
  if (s.delayProjections.length) {
    lines.push('', 'DELAY PROJECTIONS (Top overdue tasks)');
    s.delayProjections.slice(0, 10).forEach(d =>
      lines.push(`  [${d.task_code}] ${d.name} — ${d.days_overdue} working day(s) overdue | ${d.project_name}`)
    );
  }
  if (s.urgent.length) {
    lines.push('', 'URGENT (Due today/tomorrow)');
    s.urgent.forEach(t =>
      lines.push(`  [${t.task_code}] ${t.name} | Due: ${t.planned_end} | ${t.project_name}`)
    );
  }
  return lines.join('\n');
}

module.exports = {
  getExecutiveSummary, getControlTower, getMeetingBoard,
  generateWeeklySummary, invalidateCache,
};
