// ============================================================
// config/db.js — PostgreSQL Connection  v1.3
// Stable connection for Supabase free tier with keepalive
// ============================================================
const { Pool } = require('pg');

// Parse the connection string carefully
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl:                     { rejectUnauthorized: false },
  max:                     2,    // small pool for free tier
  min:                     0,
  idleTimeoutMillis:       120000,  // 2 min idle timeout
  connectionTimeoutMillis: 20000,   // 20s to get a connection
  allowExitOnIdle:         false,
});

pool.on('error', (err) => {
  // Log but never crash — pool errors are recoverable
  console.error('[DB Pool] Idle client error:', err.message);
});

// ── Keepalive ping every 4 minutes ───────────────────────────
// Supabase free tier drops connections after ~5 min of silence.
// This keeps at least one connection alive at all times.
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    // Silent — this is just a heartbeat
  }
}, 4 * 60 * 1000); // every 4 minutes

// ── Smart query wrapper with auto-retry ──────────────────────
const db = {
  query: async (text, params, attempt = 1) => {
    try {
      return await pool.query(text, params);
    } catch (error) {
      const isConnectionDrop =
        error.message.includes('Connection terminated') ||
        error.message.includes('connection timeout') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('terminating connection');

      if (isConnectionDrop && attempt === 1) {
        console.warn('[DB] Connection dropped — retrying in 1s...');
        await new Promise(r => setTimeout(r, 1000));
        return db.query(text, params, 2); // one retry
      }
      throw error;
    }
  },
};

// ── Startup connection test ───────────────────────────────────
const testConnection = async (retries = 4) => {
  for (let i = 1; i <= retries; i++) {
    try {
      const result = await pool.query('SELECT NOW()');
      console.log(`✅ Database connected — Supabase PostgreSQL (${result.rows[0].now})`);
      return true;
    } catch (error) {
      console.error(`❌ Database attempt ${i}/${retries} failed: ${error.message}`);
      if (i < retries) {
        console.log(`   Retrying in 3 seconds...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  console.error('Check your DATABASE_URL in .env and that your Supabase project is running.');
  return false;
};

module.exports = { db, testConnection };