const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const ldap = require('./ldap');

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
    auth_source: u.auth_source,
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
    req.sessionExp = payload.exp;
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

// Hash ficticio para que un usuario inexistente tarde lo mismo que uno real.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

function loginError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Devuelve el usuario local tras validar credenciales, o lanza un error con status. */
async function verifyCredentials(rawUsername, password) {
  const typed = rawUsername.trim();
  const local = db.prepare('SELECT * FROM users WHERE username = ?').get(typed);

  // Las cuentas locales (como el admin inicial) siempre se validan aquí: son el acceso de respaldo
  // si el directorio no responde.
  if (local && local.auth_source === 'local') {
    if (local.active && bcrypt.compareSync(password, local.password_hash)) return local;
    throw loginError(401, 'Usuario o contraseña incorrectos.');
  }

  if (!ldap.enabled) {
    bcrypt.compareSync(password, DUMMY_HASH);
    throw loginError(401, 'Usuario o contraseña incorrectos.');
  }

  let profile;
  try {
    profile = await ldap.authenticate(typed, password);
  } catch (err) {
    console.error('Error consultando el directorio:', err.message);
    throw loginError(503, 'No se pudo contactar al directorio de la empresa. Intenta de nuevo en unos minutos o avisa a TI.');
  }
  if (!profile) throw loginError(401, 'Usuario o contraseña incorrectos.');

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(profile.username);
  if (existing && existing.auth_source === 'local') {
    console.warn(`Conflicto: "${profile.username}" existe como cuenta local y en el directorio.`);
    throw loginError(409, 'Ya existe una cuenta local con ese nombre. Pide a un administrador que la revise.');
  }
  if (existing && !existing.active) throw loginError(403, 'Tu cuenta está desactivada en el tablero.');
  if (!existing && !ldap.autoCreate) {
    throw loginError(403, 'Tu cuenta de red aún no tiene acceso al tablero. Pídeselo a un administrador.');
  }

  // Sincroniza nombre y, si hay grupo de administradores configurado, el rol.
  const role = profile.isAdmin === null ? (existing?.role || 'user') : (profile.isAdmin ? 'admin' : 'user');
  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, role = ? WHERE id = ?').run(profile.displayName, role, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const info = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, auth_source) VALUES (?, ?, '!', ?, 'ldap')`
  ).run(profile.username, profile.displayName, role);
  console.log(`Cuenta de directorio creada: ${profile.username}`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

router.get('/config', (req, res) => {
  res.json({ ldap: ldap.enabled });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Ingresa usuario y contraseña.' });
  }

  const key = attemptKey(req, ldap.normalizeUsername(username));
  const entry = attempts.get(key);
  if (entry && entry.lockedUntil > Date.now()) {
    const min = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Demasiados intentos. Prueba de nuevo en ${min} min.` });
  }

  try {
    const user = await verifyCredentials(username, password);
    attempts.delete(key);
    setSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    if (err.status === 401) {
      const e = entry && entry.lockedUntil && entry.lockedUntil <= Date.now() ? { count: 0, lockedUntil: 0 } : entry || { count: 0, lockedUntil: 0 };
      e.count += 1;
      if (e.count >= MAX_ATTEMPTS) e.lockedUntil = Date.now() + LOCK_MS;
      attempts.set(key, e);
    }
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servidor.' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/password', requireAuth, (req, res) => {
  if (req.user.auth_source === 'ldap') {
    return res.status(400).json({ error: 'Tu contraseña es la de tu cuenta de red; cámbiala por los canales de TI.' });
  }
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

module.exports = { authRouter: router, requireAuth, requireAdmin, publicUser, COOKIE, SECRET };
