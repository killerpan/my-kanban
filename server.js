const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { seedAdmin } = require('./db');
const { authRouter, requireAuth } = require('./auth');
const apiRouter = require('./routes');

seedAdmin();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Defensa CSRF: toda escritura debe venir con una cabecera que un formulario externo no puede enviar.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'kanban') {
    return res.status(403).json({ error: 'Solicitud rechazada.' });
  }
  next();
});

app.use('/api/auth', authRouter);
app.use('/api', requireAuth, apiRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido.' });
  if (!err.expose) console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Error interno del servidor.' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Kanban escuchando en http://0.0.0.0:${PORT}`));
