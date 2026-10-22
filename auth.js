const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET no está definido: se generó uno temporal y las sesiones se cerrarán al reiniciar.');
}

const COOKIE = 'kb_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    active: !!u.active,
  };
}

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, tv: user.token_version }, SECRET, {
    expiresIn: `${SESSION_HOURS}h`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: '/',
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user || !user.active || user.token_version !== payload.tv) {
      res.clearCookie(COOKIE, { path: '/' });
      return res.status(401).json({ error: 'Tu sesión expiró. Inicia sesión de nuevo.' });
    }
    req.user = user;
    next();
  } catch {
    res.clearCookie(COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Tu sesión expiró. Inicia sesión de nuevo.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
  }
  next();
}

// Límite simple de intentos fallidos por IP + usuario (en memoria).
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

function attemptKey(req, username) {
  return `${req.ip}|${String(username).toLowerCase()}`;
}

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Ingresa usuario y contraseña.' });
  }

  const key = attemptKey(req, username);
  const entry = attempts.get(key);
  if (entry && entry.lockedUntil > Date.now()) {
    const min = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Demasiados intentos. Prueba de nuevo en ${min} min.` });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  const ok = user && user.active && bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    const e = entry && entry.lockedUntil <= Date.now() && entry.count >= MAX_ATTEMPTS
      ? { count: 0, lockedUntil: 0 }
      : entry || { count: 0, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= MAX_ATTEMPTS) e.lockedUntil = Date.now() + LOCK_MS;
    attempts.set(key, e);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  attempts.delete(key);
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || !bcrypt.compareSync(current_password, req.user.password_hash)) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  }
  if (typeof new_password !== 'string' || new_password.length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 12), req.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  setSession(res, fresh); // invalida otras sesiones abiertas, mantiene la actual
  res.json({ ok: true });
});

module.exports = { authRouter: router, requireAuth, requireAdmin, publicUser };
