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

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Cria a sessão: o banco guarda só o hash; o token vai para o cookie. */
async function createSession(db, userId) {
  const token = randomToken(32);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS],
  );
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

/** Carrega req.user e req.org a partir do cookie de sessão. */
function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie).sid;
      if (!token) return res.status(401).json({ error: 'Não autenticado' });
      const row = await db.one(
        `SELECT u.id AS user_id, u.name AS user_name, u.email, u.role, o.*
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.org_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256(token)],
      );
      if (!row) return res.status(401).json({ error: 'Sessão expirada' });
      const { user_id, user_name, email, role, ...org } = row;
      req.user = { id: user_id, name: user_name, email, role };
      req.org = org;
      req.sessionHash = sha256(token);
      next();
    } catch (e) {
      next(e);
    }
  };
}

function requireOwner(req, res, next) {
  if (req.user?.role !== 'dono') return res.status(403).json({ error: 'Apenas o dono da conta pode fazer isso.' });
  next();
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, createSession, parseCookies, requireAuth, requireOwner };
