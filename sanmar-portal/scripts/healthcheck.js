'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const logger   = require('../src/utils/logger');

async function healthcheck() {
  const checks = { db: false, env: false, jwt: false };

  // ENV check
  const required = ['DATABASE_URL','JWT_SECRET','JWT_REFRESH_SECRET'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error('Missing env vars', { missing });
  } else {
    checks.env = true;
    logger.info('ENV check passed');
  }

  // JWT check
  try {
    const jwt = require('jsonwebtoken');
    const tok = jwt.sign({ sub: 'test' }, process.env.JWT_SECRET, { expiresIn: '1m' });
    jwt.verify(tok, process.env.JWT_SECRET);
    checks.jwt = true;
    logger.info('JWT check passed');
  } catch (e) {
    logger.error('JWT check failed', { error: e.message });
  }

  // DB check
  const needsSsl = (process.env.DATABASE_URL || '').includes('sslmode=require');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...(needsSsl ? { ssl:{ rejectUnauthorized:false } } : {}) });
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)    AS users,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM sop_tasks) AS sop_tasks,
        (SELECT COUNT(*) FROM tasks)    AS tasks
    `);
    logger.info('DB check passed', rows[0]);
    checks.db = true;
  } catch (e) {
    logger.error('DB check failed', { error: e.message });
  } finally {
    await pool.end();
  }

  const allPassed = Object.values(checks).every(Boolean);
  logger.info('Healthcheck complete', { checks, allPassed });
  process.exit(allPassed ? 0 : 1);
}

healthcheck();
