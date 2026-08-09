// ============================================================
// server.js — FarmDirect Backend Entry Point  v1.1
// ============================================================
require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const { testConnection } = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security ─────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_URL
    : '*',
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Logging ──────────────────────────────────────────────────
app.use(morgan('dev'));

// ── Body parsers ─────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ─────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { success: false, error: 'Too many requests. Try again in 15 minutes.', code: 429 },
}));

// ── Health check ─────────────────────────────────────────────
// Open http://localhost:5000/health to confirm server is running
app.get('/health', (req, res) => {
  res.json({
    success:     true,
    message:     '🌱 FarmDirect API is running',
    environment: process.env.NODE_ENV,
    timestamp:   new Date().toISOString(),
  });
});

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth.routes'));
app.use('/api/products', require('./routes/product.routes'));
app.use('/api/orders',   require('./routes/order.routes'));
app.use('/api/payments', require('./routes/payment.routes'));
app.use('/api/courier',  require('./routes/courier.routes'));
app.use('/api/admin',    require('./routes/admin.routes'));
app.use('/api/users',    require('./routes/user.routes'));

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   `Route not found: ${req.method} ${req.originalUrl}`,
    code:    404,
  });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);

  if (err.code === '23505')
    return res.status(409).json({ success: false, error: 'Record already exists.', code: 409 });
  if (err.code === '23503')
    return res.status(400).json({ success: false, error: 'Related record not found.', code: 400 });
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ success: false, error: 'File too large. Max 5MB.', code: 413 });
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')
    return res.status(401).json({ success: false, error: 'Session expired. Please log in again.', code: 401 });

  res.status(err.status || 500).json({
    success: false,
    error:   process.env.NODE_ENV === 'production'
      ? 'Something went wrong. Please try again.'
      : err.message,
    code:    err.status || 500,
  });
});

// ── Start server ─────────────────────────────────────────────
const startServer = async () => {
  const dbConnected = await testConnection();

  if (!dbConnected) {
    if (process.env.NODE_ENV === 'production') {
      // In production: refuse to start without a database
      console.error('⛔ Production server cannot start without database. Exiting.');
      process.exit(1);
    } else {
      // In development: start anyway so you can test routes
      // Database-dependent routes will fail with a clear error
      console.warn('⚠️  Starting WITHOUT database connection.');
      console.warn('⚠️  Fix DATABASE_URL in .env or resume your Supabase project.');
      console.warn('⚠️  Routes that need the database will return errors until fixed.');
    }
  }

  app.listen(PORT, () => {
    console.log('');
    console.log('🌱 ==============================');
    console.log(`🌱  FarmDirect API`);
    console.log(`🌱  http://localhost:${PORT}`);
    console.log(`🌱  Mode: ${process.env.NODE_ENV}`);
    console.log('🌱 ==============================');
    console.log('');
    console.log(`🔗  Health check: http://localhost:${PORT}/health`);
    console.log(`🔗  Auth:         http://localhost:${PORT}/api/auth`);
    console.log(`🔗  Products:     http://localhost:${PORT}/api/products`);
    console.log('');
  });
};

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down gracefully...');
  process.exit(0);
});

startServer();