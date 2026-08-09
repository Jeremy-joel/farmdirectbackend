// ============================================================
// middleware/role.middleware.js — Role-Based Access Control
// ============================================================
// Restricts routes to specific user roles.
// Must be used AFTER verifyToken (needs req.user to be set).
//
// Usage:
//   const { requireRole } = require('../middleware/role.middleware');
//
//   // Only farmers can access this route:
//   router.post('/products', verifyToken, requireRole('farmer'), handler);
//
//   // Farmers and admins can access this route:
//   router.delete('/products/:id', verifyToken, requireRole('farmer','admin'), handler);
// ============================================================

const { err } = require('../utils/response.utils');

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    // verifyToken must run first — if req.user is missing something is wrong
    if (!req.user || !req.user.role) {
      return err(res, 'Authentication required.', 401);
    }

    if (!allowedRoles.includes(req.user.role)) {
      return err(
        res,
        `Access denied. This action requires one of these roles: ${allowedRoles.join(', ')}. Your role is: ${req.user.role}.`,
        403
      );
    }

    next();
  };
};

module.exports = { requireRole };