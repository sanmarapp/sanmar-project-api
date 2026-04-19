'use strict';
const router   = require('express').Router();
const { body, param, query: qv, validationResult } = require('express-validator');
const taskSvc  = require('../services/taskService');
const reportSvc = require('../services/reportService');
const { authenticate, requireAdmin, requireEmployee } = require('../middleware/auth');
const { ok, err, serverErr, notFound } = require('../utils/response');

// All task routes require auth
router.use(authenticate);

// ── GET /api/v1/tasks ─────────────────────────────────────────────
router.get('/', requireEmployee, async (req, res) => {
  try {
    const filters = {
      project_id: req.query.project_id,
      status:     req.query.status,
      search:     req.query.search,
      is_overdue: req.query.is_overdue === 'true',
    };
    const tasks = await taskSvc.getTasksByUser(req.user.id, req.user.role, filters);
    return ok(res, { tasks, count: tasks.length });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// ── GET /api/v1/tasks/:id ─────────────────────────────────────────
router.get('/:id',
  param('id').isUUID(),
  requireEmployee,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, 'Invalid task ID');
    const task = await taskSvc.getTaskById(req.params.id);
    if (!task) return notFound(res, 'Task not found');
    // Employee: confirm assigned
    if (req.user.role === 'employee') {
      const isAssigned = (task.assignees || []).some(a => a.id === req.user.id);
      if (!isAssigned) return err(res, 'Access denied', 403);
    }
    return ok(res, { task });
  }
);

// ── POST /api/v1/tasks ────────────────────────────────────────────
router.post('/',
  requireAdmin,
  body('task_code').notEmpty().trim(),
  body('project_id').isUUID(),
  body('name').notEmpty().trim(),
  body('start_date').isISO8601(),
  body('primary_assignee_ids').isArray({ min: 1 }).withMessage('At least one primary assignee required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, errors.array()[0].msg);
    try {
      const task = await taskSvc.createTask(req.body, req.user);
      await reportSvc.invalidateCache();
      return ok(res, { task, message: 'Task created successfully' }, 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

// ── PATCH /api/v1/tasks/:id ───────────────────────────────────────
router.patch('/:id',
  param('id').isUUID(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, 'Invalid task ID');
    // Employees can only update tasks assigned to them
    if (req.user.role === 'employee') {
      const task = await taskSvc.getTaskById(req.params.id);
      if (!task) return notFound(res);
      const isAssigned = (task.assignees || []).some(a => a.id === req.user.id);
      if (!isAssigned) return err(res, 'Not assigned to this task', 403);
    }
    try {
      const updated = await taskSvc.updateTask(req.params.id, req.body, req.user);
      await reportSvc.invalidateCache();
      return ok(res, { task: updated, message: 'Task updated successfully' });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

// ── DELETE /api/v1/tasks/:id ──────────────────────────────────────
router.delete('/:id',
  param('id').isUUID(),
  requireAdmin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, 'Invalid task ID');
    try {
      await taskSvc.deleteTask(req.params.id, req.user);
      await reportSvc.invalidateCache();
      return ok(res, { message: 'Task deleted' });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

// ── POST /api/v1/tasks/bulk-status ────────────────────────────────
router.post('/bulk-status',
  requireAdmin,
  body('task_ids').isArray({ min: 1 }),
  body('status').isIn(['Not Started', 'On Going', 'Completed']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, errors.array()[0].msg);
    try {
      const result = await taskSvc.bulkUpdateStatus(req.body.task_ids, req.body.status, req.user);
      await reportSvc.invalidateCache();
      return ok(res, result);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

module.exports = router;
