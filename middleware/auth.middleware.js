// ============================================================
// middleware/auth.middleware.js — JWT Route Protection
// ============================================================
// Add this middleware to any route that requires login.
//
// How it works:
//   1. Checks for Authorization: Bearer <token> header
//   2. Verifies the token signature using JWT_SECRET
//   3. Attaches decoded user data to req.user
//   4. Calls next() so the actual route handler runs
//
// If token is missing, invalid, or expired → returns 401.
// The route handler never runs in that case.
//
// Usage in a route file:
//   const { verifyToken } = require('../middleware/auth.middleware');
//   router.get('/profile', verifyToken, profileController);
// ============================================================

const { verifyToken } = require('../utils/jwt.utils');
const { err }         = require('../utils/response.utils');

const verifyTokenMiddleware = (req, res, next) => {
  // Extract token from Authorization header
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return err(res, 'Access denied. No token provided. Please log in.', 401);
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return err(res, 'Access denied. Token is empty. Please log in.', 401);
  }

  try {
    // Verify signature and expiry — throws if invalid
    const decoded = verifyToken(token);
    // Attach to request so route handlers can read it:
    // req.user.userId, req.user.role, req.user.firstName
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return err(res, 'Session expired. Please log in again.', 401);
    }
    return err(res, 'Invalid token. Please log in again.', 401);
  }
};

module.exports = { verifyToken: verifyTokenMiddleware };