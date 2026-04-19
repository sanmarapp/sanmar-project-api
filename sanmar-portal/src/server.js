'use strict';
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const path         = require('path');

const logger          = require('./utils/logger');
const { testConnection } = require('./db/pool');
const { apiLimiter }  = require('./middleware/rateLimiter');
const { startScheduler } = require('./jobs/scheduler');

// ── Routes ────────────────────────────────────────────────────────
const authRoutes    = require('./routes/auth');
const taskRoutes    = require('./routes/tasks');
const projectRoutes = require('./routes/projects');
const reportRoutes  = require('./routes/reports');
const notifRoutes   = require('./routes/notifications');
const userRoutes    = require('./routes/users');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY & PARSING MIDDLEWARE ──────────────────────────────────
app.set('trust proxy', 1); // Railway sits behind a proxy

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com', 'fonts.googleapis.com', 'data:'],
      imgSrc:      ["'self'", 'data:', 'drive.google.com', '*.googleusercontent.com'],
      connectSrc:  ["'self'"],
    },
  },
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── STATIC FILES ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// ── HEALTH CHECK (unauthenticated, used by Railway) ───────────────
app.get('/health', async (req, res) => {
  const dbOk = await testConnection().catch(() => false);
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status:    dbOk ? 'healthy' : 'degraded',
    db:        dbOk ? 'connected' : 'disconnected',
    version:   process.env.npm_package_version || '2.0.0',
    env:       process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/api/v1',          apiLimiter);
app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/tasks',    taskRoutes);
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/reports',  reportRoutes);
app.use('/api/v1/notifications', notifRoutes);
app.use('/api/v1/users',    userRoutes);

// ── SPA FALLBACK ──────────────────────────────────────────────────
// Serve desktop.html for all non-API GET requests
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: 'API route not found' });
  }
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const page = req.query.page || (isMobile ? 'mobile' : 'desktop');
  const file = page === 'mobile' ? 'mobile.html' : 'desktop.html';
  res.sendFile(path.join(__dirname, '..', 'public', 'views', file), (sendErr) => {
    if (sendErr) res.status(500).send('Portal loading error — please try again.');
  });
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── BOOT ──────────────────────────────────────────────────────────
async function boot() {
  // Verify DB connection before accepting traffic
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Cannot start — database connection failed. Check DATABASE_URL.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Sanmar Portal running on port ${PORT}`, {
      env:  process.env.NODE_ENV,
      port: PORT,
      url:  process.env.APP_URL || `http://localhost:${PORT}`,
    });
  });

  // Start background jobs only in production or if explicitly enabled
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_JOBS === 'true') {
    startScheduler();
  }
}

boot().catch(err => {
  logger.error('Boot failed', { error: err.message });
  process.exit(1);
});

module.exports = app; // for testing
