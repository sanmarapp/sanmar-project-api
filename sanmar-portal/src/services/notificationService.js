'use strict';
const nodemailer = require('nodemailer');
const { query }  = require('../db/pool');
const logger     = require('../utils/logger');

// ── EMAIL TRANSPORT ───────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── WHATSAPP VIA WHAPI ────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  if (!process.env.WHAPI_TOKEN || !phone) return;
  try {
    const res = await fetch(process.env.WHAPI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHAPI_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        channel_id: process.env.WHAPI_CHANNEL,
        to:   String(phone).replace(/\.0$/, ''), // strip Excel float suffix
        body: message,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn('WhatsApp send failed', { phone, status: res.status, body: text.slice(0, 200) });
    }
  } catch (err) {
    logger.warn('WhatsApp send error', { phone, error: err.message });
  }
}

// ── EMAIL ─────────────────────────────────────────────────────────
async function sendEmail(to, subject, html, text) {
  if (!process.env.SMTP_USER || !to) return;
  try {
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: `[SANMAR] ${subject}`,
      html,
      text,
    });
  } catch (err) {
    logger.warn('Email send error', { to, error: err.message });
  }
}

// ── IN-APP NOTIFICATION ───────────────────────────────────────────
async function createInAppNotif(userId, taskId, projectId, message) {
  try {
    await query(
      `INSERT INTO notifications (user_id, task_id, project_id, message, channel)
       VALUES ($1,$2,$3,$4,'in_app')`,
      [userId, taskId, projectId, message]
    );
  } catch (err) {
    logger.warn('In-app notif DB error', { error: err.message });
  }
}

// ── LOOKUP USERS BY IDS ───────────────────────────────────────────
async function getUsersById(userIds) {
  if (!userIds || !userIds.length) return [];
  const { rows } = await query(
    `SELECT id, name, email, phone FROM users WHERE id = ANY($1::uuid[]) AND is_active=TRUE`,
    [userIds]
  );
  return rows;
}

// ── EMAIL HTML TEMPLATE ───────────────────────────────────────────
function buildEmailHtml(subject, taskName, projectName, taskCode, rows, signInLink) {
  const brandColor = '#897059';
  const rowsHtml = rows.map(([label, value]) =>
    `<tr><td style="padding:8px 14px;border:1px solid #e5e5e5;background:#fafafa;font-weight:600;color:#555;width:140px">${label}</td>
         <td style="padding:8px 14px;border:1px solid #e5e5e5">${value || '—'}</td></tr>`
  ).join('');
  return `
<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden">
  <div style="background:${brandColor};padding:20px 28px;text-align:center">
    <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:2px">SANMAR</div>
    <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">Project Management Portal</div>
  </div>
  <div style="padding:24px 28px">
    <div style="font-size:16px;font-weight:700;color:#333;margin-bottom:6px">${subject}</div>
    <p style="color:#666;font-size:14px;margin:0 0 18px">${taskCode ? '[' + taskCode + '] ' : ''}${taskName}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${rowsHtml}</table>
    ${signInLink ? `<div style="text-align:center;margin:24px 0">
      <a href="${signInLink}" style="display:inline-block;background:${brandColor};color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-weight:700;font-size:14px">Open Portal →</a>
    </div>` : ''}
  </div>
  <div style="background:#f9f9f9;padding:14px 28px;border-top:1px solid #eee;text-align:center">
    <p style="color:#aaa;font-size:12px;margin:0">Automated notification — SANMAR Project Portal</p>
  </div>
</div>`;
}

// ── PUBLIC NOTIFICATION EVENTS ────────────────────────────────────

async function notifyTaskAssigned(task, primaryIds, secondaryIds, actor) {
  const allIds   = [...new Set([...primaryIds, ...secondaryIds])];
  const users    = await getUsersById(allIds);
  const primaryUsers = await getUsersById(primaryIds);

  const portalUrl = process.env.APP_URL || 'https://portal.mysanmar.com';
  const subject   = 'New Task Assigned';
  const html      = buildEmailHtml(subject, task.name, task.project_name, task.task_code, [
    ['Project',     task.project_name],
    ['Task ID',     task.task_code],
    ['Department',  task.department],
    ['Start Date',  task.start_date],
    ['Planned End', task.planned_end],
    ['Status',      task.status],
  ], portalUrl);
  const waText = `📋 *SANMAR Portal — New Task Assigned*\n[${task.task_code}] ${task.name}\nProject: ${task.project_name}\nStart: ${task.start_date}  |  Due: ${task.planned_end}\n\n${portalUrl}`;

  for (const user of users) {
    await createInAppNotif(user.id, task.id, task.project_id,
      `New task assigned: [${task.task_code}] ${task.name} — ${task.project_name}`);
  }
  // Email + WA only to primary assignees + always-notify
  const alwaysNotify = await query(
    `SELECT id, email, phone FROM users WHERE email='andalib.rahman@mysanmar.com' AND is_active=TRUE`
  ).then(r => r.rows[0]).catch(() => null);

  const pushUsers = alwaysNotify
    ? [...primaryUsers, ...(alwaysNotify ? [alwaysNotify] : [])]
    : primaryUsers;
  const seen = new Set();
  for (const user of pushUsers) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    await sendEmail(user.email, subject, html, waText);
    if (user.phone) await sendWhatsApp(user.phone, waText);
  }
  logger.info('Notifications sent: task assigned', { taskCode: task.task_code, recipients: pushUsers.length });
}

async function notifyTaskUpdate(task, assigneeIds, actor) {
  const users   = await getUsersById(assigneeIds);
  const portalUrl = process.env.APP_URL || 'https://portal.mysanmar.com';
  const subject   = `Task Updated — ${task.status}`;
  const html      = buildEmailHtml(subject, task.name, task.project_name, task.task_code, [
    ['Project', task.project_name],
    ['Task ID', task.task_code],
    ['Status',  task.status],
    ['Updated by', actor.email],
  ], null);
  const waText = `📋 *SANMAR Portal — Task Updated*\n[${task.task_code}] ${task.name}\nStatus: ${task.status}\nProject: ${task.project_name}\nBy: ${actor.email.split('@')[0]}\n\n${portalUrl}`;

  for (const user of users) {
    await createInAppNotif(user.id, task.id, task.project_id,
      `[${task.task_code}] ${task.name} updated to ${task.status}`);
    await sendEmail(user.email, subject, html, waText);
    if (user.phone) await sendWhatsApp(user.phone, waText);
  }
}

async function notifyOverdueTasks(overdueTasks) {
  if (!overdueTasks.length) return;
  const portalUrl = process.env.APP_URL || 'https://portal.mysanmar.com';
  for (const task of overdueTasks) {
    const { rows: assigneeRows } = await query(
      `SELECT u.id, u.email, u.phone FROM task_assignees ta
       JOIN users u ON u.id=ta.user_id WHERE ta.task_id=$1 AND ta.is_primary=TRUE AND u.is_active=TRUE`,
      [task.id]
    );
    const days = task.days_overdue || 1;
    const waText = `⚠️ *SANMAR Portal — Overdue Task*\n[${task.task_code}] ${task.name}\nProject: ${task.project_name}\nOverdue by: ${days} working day(s)\nPlanned End: ${task.planned_end}\n\nPlease update your task status: ${portalUrl}`;
    for (const user of assigneeRows) {
      await createInAppNotif(user.id, task.id, task.project_id,
        `OVERDUE (${days}d): [${task.task_code}] ${task.name} — ${task.project_name}`);
      if (user.phone) await sendWhatsApp(user.phone, waText);
    }
  }
  logger.info(`Overdue notifications sent for ${overdueTasks.length} tasks`);
}

async function notifySilentTasks(silentTasks) {
  if (!silentTasks.length) return;
  const portalUrl = process.env.APP_URL || 'https://portal.mysanmar.com';
  for (const task of silentTasks) {
    const { rows: assigneeRows } = await query(
      `SELECT u.id, u.email, u.phone FROM task_assignees ta
       JOIN users u ON u.id=ta.user_id WHERE ta.task_id=$1 AND ta.is_primary=TRUE AND u.is_active=TRUE`,
      [task.id]
    );
    const waText = `🔔 *SANMAR Portal — Task Needs Update*\n[${task.task_code}] ${task.name}\nProject: ${task.project_name}\nNo update in 48+ hours.\n\nPlease post an activity update: ${portalUrl}`;
    for (const user of assigneeRows) {
      await createInAppNotif(user.id, task.id, task.project_id,
        `No update in 48h+: [${task.task_code}] ${task.name}`);
      if (user.phone) await sendWhatsApp(user.phone, waText);
    }
  }
}

async function getUnreadNotifications(userId) {
  const { rows } = await query(
    `SELECT n.id, n.message, n.created_at,
            t.task_code, t.name AS task_name,
            p.name AS project_name
     FROM notifications n
     LEFT JOIN tasks    t ON t.id=n.task_id
     LEFT JOIN projects p ON p.id=n.project_id
     WHERE n.user_id=$1 AND n.status='Unread' AND n.channel='in_app'
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return rows;
}

async function markAllRead(userId) {
  await query(
    `UPDATE notifications SET status='Read' WHERE user_id=$1 AND status='Unread'`,
    [userId]
  );
}

module.exports = {
  notifyTaskAssigned, notifyTaskUpdate,
  notifyOverdueTasks, notifySilentTasks,
  getUnreadNotifications, markAllRead,
  sendWhatsApp, sendEmail,
};
