'use strict';
/**
 * ONE-TIME MIGRATION: Google Sheets → PostgreSQL
 *
 * This script reads the existing Sanmar Project Portal spreadsheet
 * and imports all tasks + activity history into the new PostgreSQL DB.
 *
 * Prerequisites:
 *   1. Run: node scripts/migrate.js
 *   2. Run: node scripts/seed.js  (creates users + projects + SOP)
 *   3. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_B64 in .env
 *   4. Run: node scripts/importFromSheets.js
 *
 * Safe to re-run — uses ON CONFLICT DO UPDATE for tasks.
 */
require('dotenv').config();
const { Pool }    = require('pg');
const { addWorkingDays, workingDaysDelayed } = require('../src/utils/dateUtils');
const logger      = require('../src/utils/logger');

const needsSsl = (process.env.DATABASE_URL || '').includes('sslmode=require');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// ── EXCEL SERIAL DATE → ISO string ────────────────────────────────
function excelDateToISO(val) {
  if (!val || typeof val === 'string') return val || null;
  const num = parseFloat(val);
  if (isNaN(num) || num < 40000) return null; // sanity check
  // Excel epoch is 1900-01-01, JS epoch is 1970-01-01
  const date = new Date(Math.round((num - 25569) * 86400 * 1000));
  return date.toISOString().split('T')[0];
}

// ── PARSE ACTIVITY ENTRIES FROM CELL TEXT ─────────────────────────
function parseActivityEntry(raw) {
  if (!raw || raw === 'TBC') return null;
  const s = String(raw).trim();
  // New format: "11-Apr-2026 14:07 [user]: comment"
  let m = s.match(/^(\d{1,2}-\w{3}-\d{4})\s+(\d{2}:\d{2})\s+\[([^\]]+)\]:\s*([\s\S]+)$/);
  if (m) return { timestamp: `${m[1]} ${m[2]}`, user: m[3], comment: m[4].trim() };
  // Old format: "09-Mar 13:08: comment"
  m = s.match(/^(\d{1,2}-\w{3})\s+(\d{2}:\d{2}):\s*([\s\S]+)$/);
  if (m) return { timestamp: `${m[1]}-${new Date().getFullYear()} ${m[2]}`, user: 'legacy', comment: m[3].trim() };
  // Plain text — no timestamp
  return { timestamp: null, user: 'legacy', comment: s };
}

async function importFromSheets() {
  // Try to load Google Sheets via service account
  let sheets;
  try {
    const { google } = require('googleapis');
    const creds = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    );
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    logger.info('Google Sheets API connected');
  } catch (e) {
    logger.error('Cannot connect to Google Sheets API', { error: e.message });
    logger.info('Install googleapis: npm install googleapis');
    process.exit(1);
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const client  = await pool.connect();

  try {
    // Get all sheet names
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const projectSheets = meta.data.sheets
      .map(s => s.properties.title)
      .filter(n => !['SOP','Notifications','_Backup','WhatsApp','Projects'].includes(n));

    logger.info(`Found ${projectSheets.length} project sheets to import`);

    // Build user email → id map
    const { rows: users } = await client.query('SELECT id, email FROM users');
    const userMap = Object.fromEntries(users.map(u => [u.email.toLowerCase().trim(), u.id]));

    // Build project name → id map
    const { rows: projects } = await client.query('SELECT id, name, project_type FROM projects');
    const projectMap = Object.fromEntries(projects.map(p => [p.name.trim(), { id: p.id, type: p.project_type }]));

    // Build SOP task_code → id map
    const { rows: sopTasks } = await client.query('SELECT id, task_code FROM sop_tasks');
    const sopMap = Object.fromEntries(sopTasks.map(s => [s.task_code, s.id]));

    let totalTasks = 0, totalActivities = 0;

    await client.query('BEGIN');

    for (const sheetName of projectSheets) {
      const project = projectMap[sheetName];
      if (!project) {
        logger.warn(`Project not found in DB: "${sheetName}" — skipping`);
        continue;
      }

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${sheetName}'!A7:R500`,
      });
      const rows = response.data.values || [];
      logger.info(`  ${sheetName}: ${rows.length} data rows`);

      for (const row of rows) {
        const taskCode = String(row[0] || '').trim();
        if (!taskCode.match(/^T-\d+/)) continue;

        const rawStatus = String(row[8] || '').trim();
        const status = rawStatus === 'Running' ? 'On Going'
                     : ['Completed','On Going','Not Started'].includes(rawStatus) ? rawStatus
                     : 'Not Started';

        const startDate  = excelDateToISO(row[4]);
        const plannedEnd = excelDateToISO(row[5]) || (startDate && row[3] ? addWorkingDays(startDate, parseInt(row[3], 10)) : null);
        const actualEnd  = excelDateToISO(row[6]);
        const today      = new Date().toISOString().split('T')[0];
        const isOverdue  = !!(plannedEnd && status !== 'Completed' && plannedEnd < today);

        // Parse assignees (CSV in col Q, index 16)
        const assigneeRaw  = String(row[16] || '');
        const assigneeEmails = assigneeRaw.split(/[,;\n]/)
          .map(e => e.trim().toLowerCase())
          .filter(e => e.includes('@'));

        // In the old system, all assignees were in one column
        // We treat the first as primary, rest as secondary
        const primaryEmail    = assigneeEmails[0] || null;
        const secondaryEmails = assigneeEmails.slice(1);

        // Insert / upsert task
        const { rows: [task] } = await client.query(`
          INSERT INTO tasks (
            task_code, project_id, name, department, lead_time,
            start_date, planned_end, actual_end, slack_note, status,
            is_critical, is_overdue, sop_task_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::task_status,$11,$12,$13)
          ON CONFLICT (project_id, task_code) DO UPDATE SET
            name        = EXCLUDED.name,
            status      = EXCLUDED.status,
            start_date  = EXCLUDED.start_date,
            planned_end = EXCLUDED.planned_end,
            actual_end  = EXCLUDED.actual_end,
            slack_note  = EXCLUDED.slack_note,
            is_overdue  = EXCLUDED.is_overdue,
            lead_time   = EXCLUDED.lead_time
          RETURNING id
        `, [
          taskCode,
          project.id,
          String(row[1] || '').trim(),
          String(row[2] || '').trim(),
          row[3] ? parseInt(row[3], 10) : null,
          startDate,
          plannedEnd,
          actualEnd,
          String(row[7] || '').trim() || null,
          status,
          false,
          isOverdue,
          sopMap[taskCode] || null,
        ]);
        const taskId = task.id;

        // Insert assignees
        await client.query('DELETE FROM task_assignees WHERE task_id=$1', [taskId]);
        if (primaryEmail && userMap[primaryEmail]) {
          await client.query(
            'INSERT INTO task_assignees (task_id, user_id, is_primary) VALUES ($1,$2,TRUE) ON CONFLICT DO NOTHING',
            [taskId, userMap[primaryEmail]]
          );
        }
        for (const secEmail of secondaryEmails) {
          if (userMap[secEmail]) {
            await client.query(
              'INSERT INTO task_assignees (task_id, user_id, is_primary) VALUES ($1,$2,FALSE) ON CONFLICT DO NOTHING',
              [taskId, userMap[secEmail]]
            );
          }
        }

        // Import activity history (cols K-O, indices 10-14)
        // Clear old activity
        await client.query('DELETE FROM activity_log WHERE task_id=$1', [taskId]);
        // Import newest first (col K is newest)
        for (let i = 10; i <= 14; i++) {
          const raw   = String(row[i] || '').trim();
          if (!raw) continue;
          const entry = parseActivityEntry(raw);
          if (!entry) continue;
          // Find user by label
          const userLabel = entry.user;
          let userId = null;
          if (userLabel && userLabel !== 'legacy') {
            const match = Object.keys(userMap).find(e => e.startsWith(userLabel + '@'));
            if (match) userId = userMap[match];
          }
          // Parse timestamp
          let createdAt = new Date();
          if (entry.timestamp) {
            const d = new Date(entry.timestamp.replace(/(\d+)-(\w+)-(\d+)/, '$3 $2 $1'));
            if (!isNaN(d.getTime())) createdAt = d;
          }
          await client.query(`
            INSERT INTO activity_log (task_id, user_id, user_label, comment, created_at)
            VALUES ($1,$2,$3,$4,$5)
          `, [taskId, userId, userLabel, entry.comment, createdAt]);
          totalActivities++;
        }
        totalTasks++;
      }
    }

    await client.query('COMMIT');
    logger.info(`Import complete: ${totalTasks} tasks, ${totalActivities} activity entries`);

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Import failed', { error: err.message, stack: err.stack });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

importFromSheets();
