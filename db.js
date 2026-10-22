const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'kanban.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  active        INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS columns (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id  INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  wip_limit INTEGER
);

CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id   INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',
  due_date    TEXT,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_columns_board ON columns(board_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_column  ON cards(column_id, position);
CREATE INDEX IF NOT EXISTS idx_members_user  ON board_members(user_id);
`);

// ---------- migraciones (PRAGMA user_version) ----------
// Cada entrada se aplica una sola vez, en orden. Así una base existente se actualiza al arrancar.
const migrations = [
  // 1: origen de la cuenta (local o directorio), comentarios e historial de tarjetas
  () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('auth_source')) {
      db.exec(`ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local','ldap'))`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_comments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS card_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        type       TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_comments_card ON card_comments(card_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_card   ON card_events(card_id, id);
    `);
  },
];

const current = db.pragma('user_version', { simple: true });
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    migrations[v]();
    db.pragma(`user_version = ${v + 1}`);
  })();
  console.log(`Migración aplicada: v${v + 1}`);
}

/** Crea el primer administrador si la base está vacía. */
function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      'No hay usuarios y ADMIN_PASSWORD no está definido (mínimo 8 caracteres). ' +
      'Defínelo en .env para crear el administrador inicial.'
    );
    process.exit(1);
  }
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')`
  ).run(username, 'Administrador', bcrypt.hashSync(password, 12));
  console.log(`Administrador inicial creado: ${username}`);
}

module.exports = { db, seedAdmin, DB_PATH, DATA_DIR };
