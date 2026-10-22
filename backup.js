// Respaldo en caliente y consistente (funciona con la app corriendo, incluso en modo WAL).
// Uso: node src/backup.js [ruta_destino]
const path = require('path');
const { db, DATA_DIR } = require('./db');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = process.argv[2] || path.join(DATA_DIR, 'backups', `kanban-${stamp}.db`);

require('fs').mkdirSync(path.dirname(dest), { recursive: true });
db.backup(dest)
  .then(() => { console.log(`Respaldo creado: ${dest}`); process.exit(0); })
  .catch((err) => { console.error('Falló el respaldo:', err.message); process.exit(1); });
