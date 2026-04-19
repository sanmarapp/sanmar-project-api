'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requireAdmin, requireEmployee } = require('../middleware/auth');
const { ok, err, serverErr, notFound } = require('../utils/response');

router.use(authenticate);

// GET /api/v1/users  — all active users (for assignee dropdowns)
router.get('/', requireEmployee, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, name, email, role, department, has_meeting, is_active, phone
      FROM users WHERE is_active=TRUE
      ORDER BY name
    `);
    return ok(res, { users: rows });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// GET /api/v1/users/:id
router.get('/:id', requireEmployee, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, department, has_meeting, is_active, last_login, created_at
       FROM users WHERE id=$1`, [req.params.id]
    );
    if (!rows.length) return notFound(res);
    return ok(res, { user: rows[0] });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// PATCH /api/v1/users/:id — admin: update user details
router.patch('/:id',
  requireAdmin,
  body('role').optional().isIn(['admin','management','lead','employee','viewer']),
  body('is_active').optional().isBoolean(),
  body('has_meeting').optional().isBoolean(),
  body('phone').optional().isMobilePhone('any'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, errors.array()[0].msg);
    try {
      const allowed = ['name','role','department','phone','is_active','has_meeting'];
      const updates = [];
      const params  = [];
      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          params.push(req.body[field]);
          updates.push(`${field}=$${params.length}`);
        }
      }
      if (!updates.length) return err(res, 'No valid fields to update');
      params.push(req.params.id);
      await query(`UPDATE users SET ${updates.join(',')} WHERE id=$${params.length}`, params);
      return ok(res, { message: 'User updated' });
    } catch (e) {
      return serverErr(res, e.message);
    }
  }
);

// POST /api/v1/users/:id/reset-password — admin only
router.post('/:id/reset-password',
  requireAdmin,
  body('new_password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, 'Password must be at least 6 characters');
    try {
      const hash = await bcrypt.hash(req.body.new_password, 12);
      await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
      return ok(res, { message: 'Password reset successfully' });
    } catch (e) {
      return serverErr(res, e.message);
    }
  }
);

// GET /api/v1/users/me/tasks — tasks assigned to current user
router.get('/me/tasks', requireEmployee, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT t.id, t.task_code, t.name, t.status, t.planned_end, t.is_overdue, t.is_silent,
             p.name AS project_name
      FROM task_assignees ta
      JOIN tasks    t ON t.id = ta.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE ta.user_id = $1
      ORDER BY t.planned_end ASC NULLS LAST
    `, [req.user.id]);
    return ok(res, { tasks: rows });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

module.exports = router;
