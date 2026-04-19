'use strict';
const jwt    = require('jsonwebtoken');
const { query } = require('../db/pool');
const { forbidden } = require('../utils/response');

const ROLE_HIERARCHY = { admin:4, management:3, lead:2, employee:1, viewer:0 };

/**
 * Verify JWT from httpOnly cookie or Authorization header.
 * Attaches req.user = { id, email, role, hasMeeting } on success.
 */
async function authenticate(req, res, next) {
  try {
    const token =
      (req.cookies && req.cookies.access_token) ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);

    if (!token) return forbidden(res, 'Authentication required');

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      if (e.name === 'TokenExpiredError') return res.status(401).json({ success:false, expired:true, message:'Token expired' });
      return forbidden(res, 'Invalid token');
    }

    // Light DB check: confirm user still active (catches deactivated accounts mid-session)
    const { rows } = await query(
      'SELECT id, email, role, has_meeting, is_active FROM users WHERE id=$1',
      [payload.sub]
    );
    if (!rows.length || !rows[0].is_active) return forbidden(res, 'Account not found or inactive');

    req.user = {
      id:         rows[0].id,
      email:      rows[0].email,
      role:       rows[0].role,
      hasMeeting: rows[0].has_meeting,
    };
    next();
  } catch (err) {
    return forbidden(res, 'Authentication failed');
  }
}

/**
 * Role-based access control factory.
 * Usage: requireRole('admin') or requireRole('management', 'admin')
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return forbidden(res, 'Not authenticated');
    const userLevel    = ROLE_HIERARCHY[req.user.role] ?? -1;
    const minRequired  = Math.min(...allowedRoles.map(r => ROLE_HIERARCHY[r] ?? 99));
    if (userLevel >= minRequired) return next();
    return forbidden(res, `Requires role: ${allowedRoles.join(' or ')}`);
  };
}

/** Shorthand guards */
const requireAdmin      = requireRole('admin');
const requireElevated   = requireRole('admin', 'management');
const requireLead       = requireRole('admin', 'management', 'lead');
const requireEmployee   = requireRole('admin', 'management', 'lead', 'employee');

/** Allow access if admin/management OR if task is assigned to this user */
async function requireTaskAccess(req, res, next) {
  if (!req.user) return forbidden(res);
  const { admin, management } = { admin:'admin', management:'management' };
  if (req.user.role === admin || req.user.role === management) return next();
  const taskId = req.params.id || req.body.task_id;
  if (!taskId) return forbidden(res, 'Task ID required');
  const { rows } = await query(
    'SELECT 1 FROM task_assignees WHERE task_id=$1 AND user_id=$2',
    [taskId, req.user.id]
  );
  if (!rows.length) return forbidden(res, 'Not assigned to this task');
  next();
}

module.exports = { authenticate, requireRole, requireAdmin, requireElevated, requireLead, requireEmployee, requireTaskAccess };
