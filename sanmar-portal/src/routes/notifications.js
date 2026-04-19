'use strict';
const router   = require('express').Router();
const notifSvc = require('../services/notificationService');
const { authenticate } = require('../middleware/auth');
const { ok, serverErr } = require('../utils/response');

router.use(authenticate);

// GET /api/v1/notifications
router.get('/', async (req, res) => {
  try {
    const notifications = await notifSvc.getUnreadNotifications(req.user.id);
    return ok(res, { notifications, count: notifications.length });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// POST /api/v1/notifications/mark-read
router.post('/mark-read', async (req, res) => {
  try {
    await notifSvc.markAllRead(req.user.id);
    return ok(res, { message: 'All notifications marked as read' });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

module.exports = router;
