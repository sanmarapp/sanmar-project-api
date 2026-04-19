'use strict';
const router  = require('express').Router();
const { body, validationResult } = require('express-validator');
const authSvc = require('../services/authService');
const { authenticate } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { ok, err }      = require('../utils/response');

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
};

// POST /api/v1/auth/login
router.post('/login',
  loginLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 4 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return err(res, 'Invalid email or password');

    const result = await authSvc.login(req.body.email, req.body.password);
    if (!result.success) return err(res, result.message, 401);

    // httpOnly cookie for access token (short-lived)
    res.cookie('access_token',  result.accessToken,  { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
    // httpOnly cookie for refresh token (long-lived)
    res.cookie('refresh_token', result.refreshToken, { ...COOKIE_OPTS, path: '/api/v1/auth/refresh' });

    return ok(res, {
      user:        result.user,
      accessToken: result.accessToken, // also in body for mobile clients
    });
  }
);

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res) => {
  const raw = req.cookies?.refresh_token || req.body?.refresh_token;
  if (!raw) return err(res, 'No refresh token', 401);

  const result = await authSvc.refreshTokens(raw);
  if (!result.success) {
    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
    return err(res, result.message, 401);
  }

  res.cookie('access_token',  result.accessToken,  { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', result.refreshToken, { ...COOKIE_OPTS, path: '/api/v1/auth/refresh' });

  return ok(res, { accessToken: result.accessToken });
});

// POST /api/v1/auth/logout
router.post('/logout', async (req, res) => {
  const raw = req.cookies?.refresh_token || req.body?.refresh_token;
  await authSvc.logout(raw).catch(() => {});
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
  return ok(res, { message: 'Logged out' });
});

// GET /api/v1/auth/me
router.get('/me', authenticate, (req, res) => ok(res, { user: req.user }));

module.exports = router;
