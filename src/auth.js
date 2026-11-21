'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createSession(db, operatorId) {
  const token = randomToken(32);
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  db.prepare('INSERT INTO sessions (token, operator_id, expires_at) VALUES (?, ?, ?)').run(token, operatorId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function requireAuth(db) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const row = db.prepare(
      `SELECT o.* FROM sessions s JOIN operators o ON o.id = s.operator_id
       WHERE s.token = ? AND s.expires_at > ?`
    ).get(token, Date.now());
    if (!row) return res.status(401).json({ error: 'Sessão expirada' });
    req.operator = row;
    req.sessionToken = token;
    next();
  };
}

module.exports = { hashPassword, verifyPassword, randomToken, createSession, parseCookies, requireAuth };
