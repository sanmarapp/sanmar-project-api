'use strict';
const router     = require('express').Router();
const reportSvc  = require('../services/reportService');
const { authenticate, requireElevated, requireLead } = require('../middleware/auth');
const { ok, serverErr, forbidden } = require('../utils/response');

router.use(authenticate);

// GET /api/v1/reports/summary
router.get('/summary', requireElevated, async (req, res) => {
  try {
    const summary = await reportSvc.getExecutiveSummary();
    return ok(res, { summary });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// GET /api/v1/reports/control-tower
router.get('/control-tower', requireElevated, async (req, res) => {
  try {
    const ct = await reportSvc.getControlTower();
    return ok(res, { controlTower: ct });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// GET /api/v1/reports/meeting-board
// Accessible to admin, management, and lead employees (has_meeting=true)
router.get('/meeting-board', async (req, res) => {
  const { role, hasMeeting } = req.user;
  const allowed = role === 'admin' || role === 'management' || hasMeeting;
  if (!allowed) return forbidden(res, 'Meeting Board requires lead access');
  try {
    const board = await reportSvc.getMeetingBoard();
    return ok(res, { board });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// GET /api/v1/reports/weekly-summary
router.get('/weekly-summary', requireElevated, async (req, res) => {
  try {
    const text = await reportSvc.generateWeeklySummary();
    return ok(res, { text, generatedAt: new Date().toISOString() });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

// POST /api/v1/reports/invalidate-cache
router.post('/invalidate-cache', requireElevated, async (req, res) => {
  try {
    await reportSvc.invalidateCache();
    return ok(res, { message: 'Cache cleared' });
  } catch (e) {
    return serverErr(res, e.message);
  }
});

module.exports = router;
