'use strict';
const { Pool } = require('pg');
const logger   = require('../utils/logger');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Railway internal DATABASE_URL uses a private VPC — no SSL config needed.
// If the public URL is used (contains sslmode=require) we accept it with
// rejectUnauthorized:false (Railway's cert is self-signed but trusted internally).
const needsSsl = process.env.DATABASE_URL.includes('sslmode=require');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle DB client', { error: err.message });
});

// Graceful shutdown
process.on('SIGTERM', () => pool.end());
process.on('SIGINT',  () => pool.end());

/**
 * Execute a query with automatic client acquisition and release.
 * @param {string} text   - SQL query
 * @param {Array}  params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn('Slow query detected', { text: text.substring(0, 80), duration });
    }
    return result;
  } catch (err) {
    logger.error('DB query error', { text: text.substring(0, 80), error: err.message });
    throw err;
  }
}

/**
 * Execute multiple queries in a single transaction.
 * @param {Function} callback - async fn(client) => result
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function testConnection() {
  try {
    const { rows } = await query('SELECT NOW() AS now, version() AS version');
    logger.info('PostgreSQL connected', { time: rows[0].now, version: rows[0].version.split(' ')[1] });
    return true;
  } catch (err) {
    logger.error('PostgreSQL connection failed', { error: err.message });
    return false;
  }
}

module.exports = { query, transaction, testConnection, pool };
