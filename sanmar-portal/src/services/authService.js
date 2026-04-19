'use strict';
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { query, transaction } = require('../db/pool');
const logger = require('../utils/logger');

const ACCESS_EXPIRES  = process.env.JWT_ACCESS_EXPIRES  || '15m';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES || '7d';

function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
}

function issueRefreshToken(user) {
  const raw   = crypto.randomBytes(48).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

async function login(email, password) {
  const { rows } = await query(
    `SELECT id, name, email, password_hash, role, has_meeting, is_active, department, phone
     FROM users WHERE email = LOWER($1)`,
    [email.trim()]
  );
  const user = rows[0];
  if (!user)                 return { success:false, message:'Invalid credentials' };
  if (!user.is_active)       return { success:false, message:'Account is inactive' };

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match)                return { success:false, message:'Invalid credentials' };

  const accessToken          = issueAccessToken(user);
  const { raw, hashed }      = issueRefreshToken(user);

  // Store hashed refresh token (expires in 7 days)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [user.id, hashed, expiresAt]
  );

  // Update last_login
  await query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);

  logger.info('User logged in', { email: user.email, role: user.role });

  return {
    success:      true,
    accessToken,
    refreshToken: raw,
    user: {
      id:         user.id,
      name:       user.name,
      email:      user.email,
      role:       user.role,
      hasMeeting: user.has_meeting,
      department: user.department,
    },
  };
}

async function refreshTokens(rawRefreshToken) {
  const hashed = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
  const { rows } = await query(
    `SELECT rt.id, rt.user_id, rt.expires_at, u.email, u.role, u.has_meeting, u.is_active
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [hashed]
  );
  const token = rows[0];
  if (!token)                        return { success:false, message:'Invalid refresh token' };
  if (!token.is_active)              return { success:false, message:'Account inactive' };
  if (new Date(token.expires_at) < new Date()) {
    await query('DELETE FROM refresh_tokens WHERE id=$1', [token.id]);
    return { success:false, message:'Refresh token expired. Please log in again.' };
  }

  // Rotate: delete old, issue new
  await query('DELETE FROM refresh_tokens WHERE id=$1', [token.id]);
  const user = { id: token.user_id, email: token.email, role: token.role };
  const accessToken             = issueAccessToken(user);
  const { raw: newRaw, hashed: newHashed } = issueRefreshToken(user);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [user.id, newHashed, expiresAt]
  );

  return { success:true, accessToken, refreshToken: newRaw };
}

async function logout(rawRefreshToken) {
  if (!rawRefreshToken) return;
  const hashed = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
  await query('DELETE FROM refresh_tokens WHERE token_hash=$1', [hashed]);
}

async function cleanExpiredTokens() {
  const { rowCount } = await query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
  if (rowCount > 0) logger.info(`Cleaned ${rowCount} expired refresh tokens`);
}

module.exports = { login, refreshTokens, logout, cleanExpiredTokens };
