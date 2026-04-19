'use strict';
const { query, transaction } = require('../db/pool');
const { addWorkingDays, todayBD, workingDaysDelayed } = require('../utils/dateUtils');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

// ── FETCH ────────────────────────────────────────────────────────

async function getTasksByUser(userId, role, filters = {}) {
  const isElevated = (role === 'admin' || role === 'management');
  const params = [];
  let whereClause = '';

  if (!isElevated) {
    params.push(userId);
    whereClause = `WHERE ta_check.user_id = $${params.length}`;
  }

  const { project_id, status, search, is_overdue } = filters;
  if (project_id) { params.push(project_id); whereClause += (whereClause ? ' AND' : ' WHERE') + ` t.project_id=$${params.length}`; }
  if (status)     { params.push(status);     whereClause += (whereClause ? ' AND' : ' WHERE') + ` t.status=$${params.length}::task_status`; }
  if (is_overdue) { whereClause += (whereClause ? ' AND' : ' WHERE') + ` t.is_overdue=TRUE`; }
  if (search)     { params.push(`%${search}%`); whereClause += (whereClause ? ' AND' : ' WHERE') + ` (t.name ILIKE $${params.length} OR t.task_code ILIKE $${params.length} OR t.department ILIKE $${params.length})`; }

  const sql = `
    SELECT
      t.id, t.task_code, t.name, t.department, t.lead_time,
      t.start_date, t.planned_end, t.actual_end, t.slack_note,
      t.status, t.is_critical, t.is_overdue, t.is_silent,
      t.created_at, t.updated_at,
      p.id AS project_id, p.name AS project_name, p.project_type,
      -- Latest activity entry
      (SELECT comment FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_activity,
      (SELECT al.user_label FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_activity_user,
      (SELECT al.created_at FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_activity_at,
      -- Primary assignees as JSON array
      COALESCE(
        (SELECT json_agg(json_build_object('id',u.id,'email',u.email,'name',u.name,'phone',u.phone))
         FROM task_assignees ta JOIN users u ON u.id=ta.user_id
         WHERE ta.task_id=t.id AND ta.is_primary=TRUE), '[]'
      ) AS primary_assignees,
      COALESCE(
        (SELECT json_agg(json_build_object('id',u.id,'email',u.email,'name',u.name))
         FROM task_assignees ta JOIN users u ON u.id=ta.user_id
         WHERE ta.task_id=t.id AND ta.is_primary=FALSE), '[]'
      ) AS secondary_assignees
    FROM tasks t
    JOIN projects p ON p.id=t.project_id
    ${isElevated ? '' : `JOIN task_assignees ta_check ON ta_check.task_id=t.id`}
    ${whereClause}
    ORDER BY p.display_order, t.task_code
  `;

  const { rows } = await query(sql, params);
  return rows;
}

async function getTaskById(taskId) {
  const { rows } = await query(`
    SELECT t.*, p.name AS project_name, p.project_type,
      COALESCE(
        (SELECT json_agg(al ORDER BY al.created_at DESC)
         FROM activity_log al WHERE al.task_id=t.id), '[]'
      ) AS activity_history,
      COALESCE(
        (SELECT json_agg(json_build_object('id',u.id,'email',u.email,'name',u.name,'is_primary',ta.is_primary))
         FROM task_assignees ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id), '[]'
      ) AS assignees
    FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.id=$1`, [taskId]);
  return rows[0] || null;
}

// ── CREATE ────────────────────────────────────────────────────────

async function createTask(payload, actorUser) {
  const {
    task_code, project_id, name, department, lead_time,
    start_date, primary_assignee_ids = [], secondary_assignee_ids = [],
    sop_task_id,
  } = payload;

  if (!task_code || !project_id || !name || !start_date)
    throw new Error('task_code, project_id, name, and start_date are required');
  if (!primary_assignee_ids.length)
    throw new Error('At least one primary assignee is required');

  const planned_end = lead_time ? addWorkingDays(start_date, lead_time) : null;

  return transaction(async (client) => {
    // Insert task
    const { rows: [task] } = await client.query(`
      INSERT INTO tasks (task_code, project_id, name, department, lead_time, start_date, planned_end, sop_task_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [task_code, project_id, name, department, lead_time, start_date, planned_end, sop_task_id || null, actorUser.id]
    );

    // Insert assignees
    for (const uid of primary_assignee_ids) {
      await client.query(
        'INSERT INTO task_assignees (task_id, user_id, is_primary) VALUES ($1,$2,TRUE) ON CONFLICT DO NOTHING',
        [task.id, uid]
      );
    }
    for (const uid of secondary_assignee_ids) {
      await client.query(
        'INSERT INTO task_assignees (task_id, user_id, is_primary) VALUES ($1,$2,FALSE) ON CONFLICT DO NOTHING',
        [task.id, uid]
      );
    }

    // Activity log
    await client.query(
      `INSERT INTO activity_log (task_id, user_id, user_label, comment, field_changed, new_value)
       VALUES ($1,$2,$3,$4,'status','Not Started')`,
      [task.id, actorUser.id, actorUser.email.split('@')[0], 'Task assigned']
    );

    // Notify assignees
    notificationService.notifyTaskAssigned(task, primary_assignee_ids, secondary_assignee_ids, actorUser)
      .catch(e => logger.warn('Notification error on task create', { error: e.message }));

    return task;
  });
}

// ── UPDATE ────────────────────────────────────────────────────────

async function updateTask(taskId, payload, actorUser) {
  const task = await getTaskById(taskId);
  if (!task) throw new Error('Task not found');

  const {
    status, actual_end, comment, slack_note,
    start_date, lead_time,
    primary_assignee_ids, secondary_assignee_ids,
  } = payload;

  return transaction(async (client) => {
    const updates = [];
    const params  = [];
    const logEntries = [];

    const addField = (col, newVal, display) => {
      const oldVal = task[col];
      if (newVal !== undefined && String(newVal || '') !== String(oldVal || '')) {
        params.push(newVal);
        updates.push(`${col}=$${params.length}`);
        logEntries.push({ field: display || col, old: oldVal, new: newVal });
      }
    };

    if (status) addField('status', status, 'status');
    if (actual_end !== undefined) addField('actual_end', actual_end || null, 'actual_end');
    if (slack_note !== undefined) addField('slack_note', slack_note, 'slack_note');

    // Admin-only fields
    if (actorUser.role === 'admin') {
      if (start_date) addField('start_date', start_date, 'start_date');
      if (lead_time)  addField('lead_time',  lead_time,  'lead_time');
      if ((start_date || lead_time)) {
        const newStart = start_date || task.start_date;
        const newLead  = lead_time  || task.lead_time;
        if (newStart && newLead) {
          const planned = addWorkingDays(
            newStart instanceof Date ? newStart.toISOString().split('T')[0] : String(newStart),
            parseInt(newLead, 10)
          );
          params.push(planned);
          updates.push(`planned_end=$${params.length}`);
        }
      }
    }

    // Auto-set actual_end when completing
    if (status === 'Completed' && !task.actual_end && !actual_end) {
      const today = todayBD();
      params.push(today);
      updates.push(`actual_end=$${params.length}`);
      logEntries.push({ field:'actual_end', old:null, new:today });
    }

    // Recalculate overdue
    const newStatus = status || task.status;
    const newPlannedEnd = updates.find(u => u.startsWith('planned_end')) || task.planned_end;
    if (newStatus !== 'Completed') {
      const today = todayBD();
      const planEnd = typeof newPlannedEnd === 'string' ? newPlannedEnd :
                      (newPlannedEnd instanceof Date ? newPlannedEnd.toISOString().split('T')[0] : null);
      const isOverdue = planEnd && planEnd < today;
      params.push(isOverdue);
      updates.push(`is_overdue=$${params.length}`);
    } else {
      params.push(false);
      updates.push(`is_overdue=$${params.length}`);
    }

    // If updating status to On Going, mark not silent
    if (status === 'On Going' || comment) {
      params.push(false);
      updates.push(`is_silent=$${params.length}`);
    }

    if (updates.length) {
      params.push(taskId);
      await client.query(
        `UPDATE tasks SET ${updates.join(',')} WHERE id=$${params.length}`,
        params
      );
    }

    // Activity log — structured entries for field changes
    for (const entry of logEntries) {
      await client.query(
        `INSERT INTO activity_log (task_id, user_id, user_label, comment, field_changed, old_value, new_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [taskId, actorUser.id, actorUser.email.split('@')[0],
         `Changed ${entry.field}`, entry.field, String(entry.old || ''), String(entry.new || '')]
      );
    }

    // Freeform comment
    if (comment && comment.trim()) {
      await client.query(
        `INSERT INTO activity_log (task_id, user_id, user_label, comment)
         VALUES ($1,$2,$3,$4)`,
        [taskId, actorUser.id, actorUser.email.split('@')[0], comment.trim()]
      );
    }

    // Update assignees (admin only)
    if (actorUser.role === 'admin') {
      if (primary_assignee_ids !== undefined) {
        await client.query('DELETE FROM task_assignees WHERE task_id=$1', [taskId]);
        for (const uid of (primary_assignee_ids || [])) {
          await client.query(
            'INSERT INTO task_assignees (task_id, user_id, is_primary) VALUES ($1,$2,TRUE) ON CONFLICT DO NOTHING',
            [taskId, uid]
          );
        }
        for (const uid of (secondary_assignee_ids || [])) {
          await client.query(
            'INSERT INTO task_assignees (task_id, user_id, is_primary) VALUES ($1,$2,FALSE) ON CONFLICT DO NOTHING',
            [taskId, uid]
          );
        }
      }
    }

    // Notify on status change
    if (status && status !== task.status) {
      const { rows: assigneeRows } = await client.query(
        'SELECT user_id FROM task_assignees WHERE task_id=$1',
        [taskId]
      );
      notificationService.notifyTaskUpdate(
        { ...task, status },
        assigneeRows.map(r => r.user_id),
        actorUser
      ).catch(e => logger.warn('Notification error on task update', { error: e.message }));
    }

    return await getTaskById(taskId);
  });
}

// ── DELETE ────────────────────────────────────────────────────────

async function deleteTask(taskId, actorUser) {
  if (actorUser.role !== 'admin') throw new Error('Only admin can delete tasks');
  const task = await getTaskById(taskId);
  if (!task) throw new Error('Task not found');
  await query('DELETE FROM tasks WHERE id=$1', [taskId]);
  logger.info('Task deleted', { taskId, by: actorUser.email });
  return { deleted: true };
}

// ── BULK STATUS UPDATE ────────────────────────────────────────────

async function bulkUpdateStatus(taskIds, newStatus, actorUser) {
  if (actorUser.role !== 'admin') throw new Error('Only admin can bulk update');
  return transaction(async (client) => {
    for (const id of taskIds) {
      await client.query(
        `UPDATE tasks SET status=$1, is_overdue=CASE WHEN $1='Completed' THEN FALSE ELSE is_overdue END WHERE id=$2`,
        [newStatus, id]
      );
      await client.query(
        `INSERT INTO activity_log (task_id, user_id, user_label, comment, field_changed, new_value)
         VALUES ($1,$2,$3,$4,'status',$5)`,
        [id, actorUser.id, actorUser.email.split('@')[0], `Bulk status update to ${newStatus}`, newStatus]
      );
    }
    return { updated: taskIds.length };
  });
}

module.exports = { getTasksByUser, getTaskById, createTask, updateTask, deleteTask, bulkUpdateStatus };
