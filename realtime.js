// Actualizaciones en tiempo real con Server-Sent Events.
// Cada navegador con un tablero abierto mantiene una conexión; cuando alguien cambia algo,
// se avisa a los demás y ellos recargan solo ese tablero.
const { db } = require('./db');

const HEARTBEAT_MS = 25000; // menor al timeout típico de proxies (nginx: 60 s)
const MAX_PER_USER = 20;
const boards = new Map(); // boardId -> Set<client>

function allowed(client, boardId) {
  if (client.exp && Date.now() / 1000 > client.exp) return false;
  const u = db.prepare('SELECT role, active, token_version FROM users WHERE id = ?').get(client.userId);
  if (!u || !u.active || u.token_version !== client.tv) return false;
  if (u.role === 'admin') return true;
  return !!db.prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, client.userId);
}

function drop(boardId, client, reason) {
  const set = boards.get(boardId);
  if (reason) client.res.write(`event: ${reason}\ndata: {}\n\n`);
  client.res.end();
  set?.delete(client);
  if (set && !set.size) boards.delete(boardId);
}

function countForUser(userId) {
  let n = 0;
  for (const set of boards.values()) for (const c of set) if (c.userId === userId) n++;
  return n;
}

/** Abre el stream de un tablero. El acceso ya fue verificado por la ruta. */
function subscribe(req, res, boardId) {
  if (countForUser(req.user.id) >= MAX_PER_USER) {
    return res.status(429).json({ error: 'Demasiadas pestañas abiertas con tableros.' });
  }
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // evita que nginx retenga los eventos
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  res.write(`event: ready\ndata: {}\n\n`);

  const client = { res, userId: req.user.id, tv: req.user.token_version, exp: req.sessionExp };
  if (!boards.has(boardId)) boards.set(boardId, new Set());
  boards.get(boardId).add(client);
  req.on('close', () => drop(boardId, client));
}

/**
 * Avisa a quienes miran el tablero. `origin` es el id de pestaña que hizo el cambio,
 * para que esa pestaña no recargue lo que ya dibujó.
 */
function publish(boardId, event, origin) {
  const set = boards.get(boardId);
  if (!set) return;
  const msg = `data: ${JSON.stringify({ ...event, origin: origin || null })}\n\n`;
  for (const client of [...set]) {
    if (!allowed(client, boardId)) { drop(boardId, client, 'revoked'); continue; }
    client.res.write(msg);
  }
}

/** Cierra todas las conexiones de un tablero eliminado. */
function closeBoard(boardId, origin) {
  const set = boards.get(boardId);
  if (!set) return;
  for (const client of [...set]) {
    client.res.write(`event: deleted\ndata: ${JSON.stringify({ origin: origin || null })}\n\n`);
    drop(boardId, client);
  }
}

setInterval(() => {
  for (const [boardId, set] of boards) {
    for (const client of [...set]) {
      if (!allowed(client, boardId)) drop(boardId, client, 'revoked');
      else client.res.write(': ping\n\n');
    }
  }
}, HEARTBEAT_MS).unref();

module.exports = { subscribe, publish, closeBoard };
