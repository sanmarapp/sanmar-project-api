'use strict';
const cron    = require('node-cron');
const { query } = require('../db/pool');
const { todayBD, workingDaysDelayed } = require('../utils/dateUtils');
const notifSvc  = require('../services/notificationService');
const reportSvc = require('../services/reportService');
const authSvc   = require('../services/authService');
const logger    = require('../utils/logger');

// ── JOB 1: OVERDUE SCANNER ────────────────────────────────────────
// Runs every 6 hours. Marks tasks overdue and sends WA alerts.
async function runOverdueScanner() {
  logger.info('[JOB] Running overdue scanner...');
  const today = todayBD();
  try {
    // Update is_overdue flag for all tasks
    const { rowCount } = await query(`
      UPDATE tasks
      SET is_overdue = TRUE
      WHERE status != 'Completed'
        AND planned_end IS NOT NULL
        AND planned_end < $1
        AND is_overdue = FALSE
    `, [today]);
    if (rowCount > 0) logger.info(`[JOB] Marked ${rowCount} tasks as overdue`);

    // Clear overdue flag for completed tasks
    await query(`
      UPDATE tasks SET is_overdue=FALSE WHERE status='Completed' AND is_overdue=TRUE
    `);

    // Fetch newly overdue for notifications
    const { rows: overdueTasks } = await query(`
      SELECT t.id, t.task_code, t.name, t.planned_end, t.status, t.project_id,
             p.name AS project_name,
             CURRENT_DATE - t.planned_end AS days_overdue
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.is_overdue=TRUE AND t.status='On Going'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.task_id=t.id
            AND n.message LIKE 'OVERDUE%'
            AND n.created_at > NOW() - INTERVAL '6 hours'
        )
    `);

    if (overdueTasks.length) await notifSvc.notifyOverdueTasks(overdueTasks);
    logger.info(`[JOB] Overdue scanner complete. ${overdueTasks.length} notifications sent.`);
  } catch (err) {
    logger.error('[JOB] Overdue scanner error', { error: err.message });
  }
}

// ── JOB 2: SILENT TASK DETECTOR ───────────────────────────────────
// Runs every 6 hours. Marks tasks silent if no activity in 48h.
async function runSilentDetector() {
  logger.info('[JOB] Running silent task detector...');
  try {
    // Mark tasks as silent if On Going and no activity_log in 48h
    const { rowCount } = await query(`
      UPDATE tasks t
      SET is_silent = TRUE
      WHERE t.status = 'On Going'
        AND t.is_silent = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM activity_log al
          WHERE al.task_id = t.id
            AND al.created_at > NOW() - INTERVAL '48 hours'
        )
    `);
    if (rowCount > 0) logger.info(`[JOB] Marked ${rowCount} tasks as silent`);

    // Clear silent on recently updated tasks
    await query(`
      UPDATE tasks t
      SET is_silent = FALSE
      WHERE t.is_silent = TRUE
        AND EXISTS (
          SELECT 1 FROM activity_log al
          WHERE al.task_id = t.id
            AND al.created_at > NOW() - INTERVAL '48 hours'
        )
    `);

    // Notify about silent tasks (once per 24h per task)
    const { rows: silentTasks } = await query(`
      SELECT t.id, t.task_code, t.name, t.status, t.project_id,
             p.name AS project_name
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.is_silent=TRUE AND t.status='On Going'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.task_id=t.id
            AND n.message LIKE 'No update%'
            AND n.created_at > NOW() - INTERVAL '24 hours'
        )
    `);
    if (silentTasks.length) await notifSvc.notifySilentTasks(silentTasks);
    logger.info(`[JOB] Silent detector complete. ${silentTasks.length} notifications sent.`);
  } catch (err) {
    logger.error('[JOB] Silent detector error', { error: err.message });
  }
}

// ── JOB 3: DAILY REMINDER (09:00 Bangladesh time) ────────────────
async function runDailyReminder() {
  logger.info('[JOB] Running daily reminder...');
  const today    = todayBD();
  const tomorrow = (() => { const d = new Date(today); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })();
  try {
    const { rows: dueSoon } = await query(`
      SELECT t.id, t.task_code, t.name, t.planned_end, t.status, t.project_id,
             p.name AS project_name
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.status != 'Completed'
        AND t.planned_end IN ($1,$2)
    `, [today, tomorrow]);

    for (const task of dueSoon) {
      const { rows: assignees } = await query(`
        SELECT u.id, u.email, u.phone FROM task_assignees ta
        JOIN users u ON u.id=ta.user_id WHERE ta.task_id=$1 AND ta.is_primary=TRUE AND u.is_active=TRUE
      `, [task.id]);
      const label = task.planned_end === today ? 'TODAY' : 'TOMORROW';
      const msg   = `⏰ Due ${label}: [${task.task_code}] ${task.name} | ${task.project_name}`;
      for (const u of assignees) {
        await notifSvc.createInAppNotif?.(u.id, task.id, task.project_id, msg);
        if (u.phone) await notifSvc.sendWhatsApp(u.phone,
          `📋 *SANMAR Portal — Task Due ${label}*\n${msg}\n\n${process.env.APP_URL || 'https://portal.mysanmar.com'}`);
      }
    }
    logger.info(`[JOB] Daily reminder sent for ${dueSoon.length} tasks.`);
  } catch (err) {
    logger.error('[JOB] Daily reminder error', { error: err.message });
  }
}

// ── JOB 4: CACHE + TOKEN CLEANUP (daily midnight) ────────────────
async function runCleanup() {
  logger.info('[JOB] Running daily cleanup...');
  try {
    await authSvc.cleanExpiredTokens();
    await query(`DELETE FROM report_cache WHERE expires_at < NOW()`);
    // Keep notifications for 90 days only
    const { rowCount } = await query(
      `DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    logger.info(`[JOB] Cleanup complete. Removed ${rowCount} old notifications.`);
  } catch (err) {
    logger.error('[JOB] Cleanup error', { error: err.message });
  }
}

// ── JOB 5: REPORT CACHE WARMER (every 10 min) ────────────────────
async function warmReportCache() {
  try {
    await reportSvc.getExecutiveSummary();
  } catch (err) {
    logger.warn('[JOB] Cache warmer error', { error: err.message });
  }
}

// ── SCHEDULER INIT ────────────────────────────────────────────────
function startScheduler() {
  // Overdue scanner — every 6 hours
  cron.schedule('0 */6 * * *', runOverdueScanner, { timezone: 'Asia/Dhaka' });

  // Silent detector — every 6 hours (offset by 3h)
  cron.schedule('0 3,9,15,21 * * *', runSilentDetector, { timezone: 'Asia/Dhaka' });

  // Daily reminder — 09:00 Bangladesh time (UTC+6 = 03:00 UTC)
  cron.schedule('0 3 * * *', runDailyReminder, { timezone: 'Asia/Dhaka' });

  // Midnight cleanup — 00:05 Bangladesh time
  cron.schedule('5 0 * * *', runCleanup, { timezone: 'Asia/Dhaka' });

  // Report cache warmer — every 10 minutes
  cron.schedule('*/10 * * * *', warmReportCache, { timezone: 'Asia/Dhaka' });

  logger.info('Scheduler started: overdue/silent/reminder/cleanup/cache-warmer');

  // Run scanner immediately on startup
  setTimeout(runOverdueScanner, 5000);
  setTimeout(runSilentDetector, 8000);
}

module.exports = { startScheduler, runOverdueScanner, runSilentDetector, runDailyReminder };
