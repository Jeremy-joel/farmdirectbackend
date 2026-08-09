// ============================================================
// middleware/rateLimit.middleware.js — Rate Limiting
// ============================================================
// Prevents brute-force attacks on login and OTP endpoints.
//
// authLimiter:    Max 5 login attempts per 15 min per IP
// otpLimiter:     Max 3 OTP requests per 10 min per IP
// generalLimiter: Max 100 requests per 15 min per IP (global)
// ============================================================

const rateLimit = require('express-rate-limit');

// Applied to: POST /api/auth/login, POST /api/auth/register/*
// Blocks brute-force password attacks
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 minutes
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    error:   'Too many attempts. Please try again in 15 minutes.',
    code:    429,
  },
  // Skip rate limiting in development so testing is not blocked
  skip: () => process.env.NODE_ENV === 'development',
});

// Applied to: POST /api/auth/verify-otp, POST /api/auth/resend-otp
// Prevents OTP spam
const otpLimiter = rateLimit({
  windowMs:        10 * 60 * 1000, // 10 minutes
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    error:   'Too many OTP requests. Please wait 10 minutes.',
    code:    429,
  },
  skip: () => process.env.NODE_ENV === 'development',
});

module.exports = { authLimiter, otpLimiter };