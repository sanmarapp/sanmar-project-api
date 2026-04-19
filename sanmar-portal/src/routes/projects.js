'use strict';
const router = require('express').Router();
const { query } = require('../db/pool');
const { authenticate, requireAdmin, requireEmployee } = require('../middleware/auth');
const { ok, serverErr } = require('../utils/response');

router.use(authenticate);

// GET /api/v1/projects
router.get('/', requireEmployee, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.*,
        COUNT(t.id)                                              AS total_tasks,
        COUNT(t.id) FILTER (WHERE t.status='Completed')          AS done,
        COUNT(t.id) FILTER (WHERE t.status='On Going')           AS ongoing,
        COUNT(t.id) FILTER (WHERE t.is_overdue=TRUE)             AS delayed
      FROM projects p
      LEFT JOIN tasks t ON t.project_id=p.id
      WHERE p.is_active=TRUE
      GROUP BY p.id
      ORDER BY p.display_order
    `);
    return ok(res, { projects: rows });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// GET /api/v1/projects/:id/tasks
router.get('/:id/tasks', requireEmployee, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT t.*,
        (SELECT comment FROM activity_log al WHERE al.task_id=t.id ORDER BY al.created_at DESC LIMIT 1) AS latest_activity,
        COALESCE(
          (SELECT json_agg(json_build_object('email',u.email,'name',u.name,'is_primary',ta.is_primary))
           FROM task_assignees ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id), '[]'
        ) AS assignees
      FROM tasks t
      WHERE t.project_id=$1
      ORDER BY t.task_code
    `, [req.params.id]);
    return ok(res, { tasks: rows });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// GET /api/v1/projects/sop — SOP task templates
router.get('/sop/all', requireEmployee, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM sop_tasks ORDER BY display_order
    `);
    return ok(res, { sop: rows });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

module.exports = router;
