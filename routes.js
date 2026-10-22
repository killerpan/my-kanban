const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { requireAdmin, publicUser } = require('./auth');

const router = express.Router();

// ---------- utilidades ----------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function text(value, { field, max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw httpError(400, `Falta el campo "${field}".`);
    return undefined;
  }
  if (typeof value !== 'string') throw httpError(400, `"${field}" debe ser texto.`);
  const v = value.trim();
  if (required && !v) throw httpError(400, `"${field}" no puede quedar vacío.`);
  if (v.length > max) throw httpError(400, `"${field}" admite hasta ${max} caracteres.`);
  return v;
}

function intParam(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `"${field}" no es válido.`);
  return n;
}

const LEVEL = { viewer: 1, editor: 2, owner: 3 };
const CARD_COLORS = ['', 'blue', 'green', 'yellow', 'red', 'purple', 'gray'];

/** Rol efectivo del usuario en un tablero. Los administradores actúan como dueños. */
function boardRole(user, boardId) {
  if (user.role === 'admin') return 'owner';
  const m = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, user.id);
  return m ? m.role : null;
}

/** Verifica acceso mínimo; responde 404 si no es miembro para no revelar tableros ajenos. */
function requireBoard(user, boardId, min) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  const role = board && boardRole(user, boardId);
  if (!board || !role) throw httpError(404, 'Tablero no encontrado.');
  if (LEVEL[role] < LEVEL[min]) throw httpError(403, 'Tu rol en este tablero no permite esta acción.');
  return { board, role };
}

function getColumn(id) {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  if (!col) throw httpError(404, 'Columna no encontrada.');
  return col;
}

function getCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) throw httpError(404, 'Tarjeta no encontrada.');
  return card;
}

function lastAdminGuard(targetId, { demoting, deactivating }) {
  if (!demoting && !deactivating) return;
  const target = db.prepare('SELECT role, active FROM users WHERE id = ?').get(targetId);
  if (target.role !== 'admin' || !target.active) return;
  const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get().n;
  if (admins <= 1) throw httpError(400, 'Debe quedar al menos un administrador activo.');
}

// ---------- usuarios ----------

// Directorio para asignar tarjetas y agregar miembros (cualquier usuario autenticado).
router.get('/users/directory', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, display_name FROM users WHERE active = 1 ORDER BY display_name COLLATE NOCASE'
  ).all();
  res.json({ users });
});

router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all();
  res.json({ users: users.map((u) => ({ ...publicUser(u), created_at: u.created_at })) });
});

router.post('/users', requireAdmin, (req, res) => {
  const username = text(req.body.username, { field: 'usuario', max: 50, required: true });
  const display_name = text(req.body.display_name, { field: 'nombre', max: 100, required: true });
  const password = req.body.password;
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) {
    throw httpError(400, 'El usuario solo puede tener letras, números, punto, guion y guion bajo (3 a 50).');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw httpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw httpError(409, `Ya existe el usuario "${username}".`);
  }
  const info = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(username, display_name, bcrypt.hashSync(password, 12), role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ user: publicUser(user) });
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw httpError(404, 'Usuario no encontrado.');

  const display_name = text(req.body.display_name, { field: 'nombre', max: 100 });
  const role = req.body.role;
  const active = req.body.active;
  const password = req.body.password;

  if (role !== undefined && !['admin', 'user'].includes(role)) throw httpError(400, 'Rol no válido.');
  if (active !== undefined && typeof active !== 'boolean') throw httpError(400, '"activo" no es válido.');
  if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
    throw httpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  }

  lastAdminGuard(id, {
    demoting: role === 'user' && target.role === 'admin',
    deactivating: active === false && target.active,
  });

  const tx = db.transaction(() => {
    if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, id);
    if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (active !== undefined) {
      // Desactivar cierra sus sesiones abiertas.
      db.prepare('UPDATE users SET active = ?, token_version = token_version + ? WHERE id = ?')
        .run(active ? 1 : 0, active ? 0 : 1, id);
    }
    if (password) {
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
        .run(bcrypt.hashSync(password, 12), id);
    }
  });
  tx();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ user: publicUser(user) });
});

// ---------- tableros ----------

router.get('/boards', (req, res) => {
  const base = `
    SELECT b.*,
      (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id) AS card_count,
      (SELECT COUNT(*) FROM board_members m WHERE m.board_id = b.id) AS member_count`;
  let boards;
  if (req.user.role === 'admin') {
    boards = db.prepare(`${base},
      COALESCE((SELECT role FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?), 'owner') AS my_role
      FROM boards b ORDER BY b.name COLLATE NOCASE`).all(req.user.id);
  } else {
    boards = db.prepare(`${base}, bm.role AS my_role
      FROM boards b JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = ?
      ORDER BY b.name COLLATE NOCASE`).all(req.user.id);
  }
  res.json({ boards });
});

router.post('/boards', (req, res) => {
  const name = text(req.body.name, { field: 'nombre', max: 100, required: true });
  const description = text(req.body.description, { field: 'descripción', max: 500 }) || '';

  const id = db.transaction(() => {
    const info = db.prepare('INSERT INTO boards (name, description, created_by) VALUES (?, ?, ?)')
      .run(name, description, req.user.id);
    const boardId = info.lastInsertRowid;
    db.prepare(`INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, 'owner')`).run(boardId, req.user.id);
    const insCol = db.prepare('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)');
    ['Por hacer', 'En curso', 'Hecho'].forEach((n, i) => insCol.run(boardId, n, i));
    return boardId;
  })();

  res.status(201).json({ board: db.prepare('SELECT * FROM boards WHERE id = ?').get(id) });
});

router.get('/boards/:id', (req, res) => {
  const id = intParam(req.params.id, 'id');
  const { board, role } = requireBoard(req.user, id, 'viewer');
  const columns = db.prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position, id').all(id);
  const cards = db.prepare(`
    SELECT c.*, u.display_name AS assignee_name
    FROM cards c LEFT JOIN users u ON u.id = c.assignee_id
    WHERE c.board_id = ? ORDER BY c.column_id, c.position, c.id`).all(id);
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, m.role
    FROM board_members m JOIN users u ON u.id = m.user_id
    WHERE m.board_id = ? ORDER BY u.display_name COLLATE NOCASE`).all(id);
  res.json({ board, columns, cards, members, my_role: role });
});

router.patch('/boards/:id', (req, res) => {
  const id = intParam(req.params.id, 'id');
  requireBoard(req.user, id, 'owner');
  const name = text(req.body.name, { field: 'nombre', max: 100 });
  const description = text(req.body.description, { field: 'descripción', max: 500 });
  if (req.body.name !== undefined && !name) throw httpError(400, 'El nombre no puede quedar vacío.');
  if (name) db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, id);
  if (description !== undefined) db.prepare('UPDATE boards SET description = ? WHERE id = ?').run(description, id);
  res.json({ board: db.prepare('SELECT * FROM boards WHERE id = ?').get(id) });
});

router.delete('/boards/:id', (req, res) => {
  const id = intParam(req.params.id, 'id');
  requireBoard(req.user, id, 'owner');
  db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  res.status(204).end();
});

// ---------- miembros ----------

router.put('/boards/:id/members/:userId', (req, res) => {
  const id = intParam(req.params.id, 'id');
  const userId = intParam(req.params.userId, 'usuario');
  requireBoard(req.user, id, 'owner');
  const role = req.body.role;
  if (!LEVEL[role]) throw httpError(400, 'Rol no válido.');
  const user = db.prepare('SELECT id, active FROM users WHERE id = ?').get(userId);
  if (!user || !user.active) throw httpError(404, 'Usuario no encontrado o inactivo.');

  const current = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(id, userId);
  if (current?.role === 'owner' && role !== 'owner') {
    const owners = db.prepare(`SELECT COUNT(*) AS n FROM board_members WHERE board_id = ? AND role = 'owner'`).get(id).n;
    if (owners <= 1) throw httpError(400, 'El tablero debe tener al menos un dueño.');
  }
  db.prepare(`
    INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(board_id, user_id) DO UPDATE SET role = excluded.role`).run(id, userId, role);
  res.json({ ok: true });
});

router.delete('/boards/:id/members/:userId', (req, res) => {
  const id = intParam(req.params.id, 'id');
  const userId = intParam(req.params.userId, 'usuario');
  requireBoard(req.user, id, 'owner');
  const current = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(id, userId);
  if (!current) throw httpError(404, 'Esa persona no es miembro del tablero.');
  if (current.role === 'owner') {
    const owners = db.prepare(`SELECT COUNT(*) AS n FROM board_members WHERE board_id = ? AND role = 'owner'`).get(id).n;
    if (owners <= 1) throw httpError(400, 'El tablero debe tener al menos un dueño.');
  }
  db.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(id, userId);
  res.status(204).end();
});

// ---------- columnas ----------

router.post('/boards/:id/columns', (req, res) => {
  const id = intParam(req.params.id, 'id');
  requireBoard(req.user, id, 'editor');
  const name = text(req.body.name, { field: 'nombre', max: 60, required: true });
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM columns WHERE board_id = ?').get(id).p;
  const info = db.prepare('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)').run(id, name, pos);
  res.status(201).json({ column: db.prepare('SELECT * FROM columns WHERE id = ?').get(info.lastInsertRowid) });
});

router.post('/boards/:id/columns/reorder', (req, res) => {
  const id = intParam(req.params.id, 'id');
  requireBoard(req.user, id, 'editor');
  const ids = req.body.ids;
  const existing = db.prepare('SELECT id FROM columns WHERE board_id = ?').all(id).map((r) => r.id);
  if (!Array.isArray(ids) || ids.length !== existing.length || !ids.every((x) => existing.includes(x))) {
    throw httpError(400, 'El orden de columnas no coincide con el tablero.');
  }
  const upd = db.prepare('UPDATE columns SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((cid, i) => upd.run(i, cid)))();
  res.json({ ok: true });
});

router.patch('/columns/:id', (req, res) => {
  const col = getColumn(intParam(req.params.id, 'id'));
  requireBoard(req.user, col.board_id, 'editor');
  const name = text(req.body.name, { field: 'nombre', max: 60 });
  if (req.body.name !== undefined && !name) throw httpError(400, 'El nombre no puede quedar vacío.');
  if (name) db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(name, col.id);
  if (req.body.wip_limit !== undefined) {
    const w = req.body.wip_limit;
    if (w !== null && (!Number.isInteger(w) || w < 1 || w > 999)) {
      throw httpError(400, 'El límite debe ser un número entre 1 y 999, o vacío.');
    }
    db.prepare('UPDATE columns SET wip_limit = ? WHERE id = ?').run(w, col.id);
  }
  res.json({ column: db.prepare('SELECT * FROM columns WHERE id = ?').get(col.id) });
});

router.delete('/columns/:id', (req, res) => {
  const col = getColumn(intParam(req.params.id, 'id'));
  requireBoard(req.user, col.board_id, 'editor');
  const n = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE column_id = ?').get(col.id).n;
  if (n > 0) throw httpError(409, 'Mueve o elimina las tarjetas de esta columna antes de borrarla.');
  db.prepare('DELETE FROM columns WHERE id = ?').run(col.id);
  res.status(204).end();
});

// ---------- tarjetas ----------

function cardFields(body) {
  const out = {};
  if (body.title !== undefined) {
    out.title = text(body.title, { field: 'título', max: 200, required: true });
  }
  if (body.description !== undefined) {
    out.description = text(body.description, { field: 'descripción', max: 5000 }) ?? '';
  }
  if (body.color !== undefined) {
    if (!CARD_COLORS.includes(body.color)) throw httpError(400, 'Color no válido.');
    out.color = body.color;
  }
  if (body.due_date !== undefined) {
    if (body.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      throw httpError(400, 'La fecha debe tener formato AAAA-MM-DD.');
    }
    out.due_date = body.due_date || null;
  }
  if (body.assignee_id !== undefined) {
    if (body.assignee_id !== null) {
      const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(body.assignee_id);
      if (!u) throw httpError(400, 'La persona asignada no existe o está inactiva.');
    }
    out.assignee_id = body.assignee_id;
  }
  return out;
}

function cardWithAssignee(id) {
  return db.prepare(`
    SELECT c.*, u.display_name AS assignee_name
    FROM cards c LEFT JOIN users u ON u.id = c.assignee_id WHERE c.id = ?`).get(id);
}

router.post('/columns/:id/cards', (req, res) => {
  const col = getColumn(intParam(req.params.id, 'id'));
  requireBoard(req.user, col.board_id, 'editor');
  if (req.body.title === undefined) throw httpError(400, 'Falta el título.');
  const f = cardFields(req.body);
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cards WHERE column_id = ?').get(col.id).p;
  const info = db.prepare(`
    INSERT INTO cards (board_id, column_id, title, description, color, due_date, assignee_id, position, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    col.board_id, col.id, f.title, f.description ?? '', f.color ?? '', f.due_date ?? null,
    f.assignee_id ?? null, pos, req.user.id
  );
  res.status(201).json({ card: cardWithAssignee(info.lastInsertRowid) });
});

router.patch('/cards/:id', (req, res) => {
  const card = getCard(intParam(req.params.id, 'id'));
  requireBoard(req.user, card.board_id, 'editor');
  const f = cardFields(req.body);
  const keys = Object.keys(f);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE cards SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id: card.id });
  }
  res.json({ card: cardWithAssignee(card.id) });
});

const moveCard = db.transaction((card, toColumnId, toIndex) => {
  const ids = (colId, excludeId) =>
    db.prepare('SELECT id FROM cards WHERE column_id = ? AND id <> ? ORDER BY position, id').all(colId, excludeId).map((r) => r.id);
  const setPos = db.prepare('UPDATE cards SET position = ? WHERE id = ?');

  const source = ids(card.column_id, card.id);
  const target = toColumnId === card.column_id ? source : ids(toColumnId, card.id);
  const idx = Math.max(0, Math.min(toIndex, target.length));
  target.splice(idx, 0, card.id);

  if (toColumnId !== card.column_id) source.forEach((id, i) => setPos.run(i, id));
  db.prepare(`UPDATE cards SET column_id = ?, updated_at = datetime('now') WHERE id = ?`).run(toColumnId, card.id);
  target.forEach((id, i) => setPos.run(i, id));
});

router.post('/cards/:id/move', (req, res) => {
  const card = getCard(intParam(req.params.id, 'id'));
  requireBoard(req.user, card.board_id, 'editor');
  const toColumnId = intParam(req.body.column_id, 'columna');
  const toIndex = Number.isInteger(req.body.position) ? req.body.position : Number.MAX_SAFE_INTEGER;
  const col = getColumn(toColumnId);
  if (col.board_id !== card.board_id) throw httpError(400, 'La columna destino es de otro tablero.');
  moveCard(card, toColumnId, toIndex);
  res.json({ card: cardWithAssignee(card.id) });
});

router.delete('/cards/:id', (req, res) => {
  const card = getCard(intParam(req.params.id, 'id'));
  requireBoard(req.user, card.board_id, 'editor');
  db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
  res.status(204).end();
});

module.exports = router;
