// ============================================================
// routes/admin.routes.js — v2.1
// ============================================================

const router = require('express').Router();
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  getUsers,
  getUserById,
  getUserDocuments,
  setUserStatus,
  getOrders,
  getStats,
  getPublicStats,
} = require('../controllers/admin.controller');

// ── Public (no auth) ─────────────────────────────────────────
router.get('/public-stats', getPublicStats);

// ── All routes below require admin login ─────────────────────
router.use(verifyToken, requireRole('admin'));

router.get('/stats',                    getStats);
router.get('/users',                    getUsers);
router.get('/users/:id',                getUserById);
router.get('/users/:id/documents',      getUserDocuments);   // ← fetch docs with Cloudinary URLs
router.patch('/users/:id/status',       setUserStatus);
router.get('/orders',                   getOrders);

module.exports = router;