// routes/admin.routes.js — v2.2
const router = require('express').Router();
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  getUsers, getUserById, getUserDocuments,
  setUserStatus, getOrders, getStats,
  getPublicStats, getAnalytics,
  getAllPayments, getAllCourierJobs,
  deleteUser
} = require('../controllers/admin.controller');

// Unprotected public endpoint
router.get('/public-stats', getPublicStats);

// Protect all routes below with Admin authentication
router.use(verifyToken, requireRole('admin'));

// Admin protected endpoints
router.get('/stats',               getStats);
router.get('/analytics',           getAnalytics);
router.get('/users',               getUsers);
router.get('/users/:id',           getUserById);
router.get('/users/:id/documents', getUserDocuments);
router.patch('/users/:id/status',  setUserStatus);
router.delete('/users/:id',         deleteUser);
router.get('/orders',              getOrders);
router.get('/payments',            getAllPayments);
router.get('/courier-jobs',        getAllCourierJobs);

module.exports = router;