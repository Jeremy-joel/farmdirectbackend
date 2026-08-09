// ============================================================
// utils/jwt.utils.js — JSON Web Tokens
// ============================================================
// A JWT is a digitally signed token the server gives to a
// user after login. The user sends it back with every request
// inside the Authorization header:
//   Authorization: Bearer eyJhbGc...
//
// The server verifies the signature to confirm the token is
// genuine and hasn't been tampered with.
//
// Token payload (what gets encoded inside the token):
//   { userId, role, firstName }
//
// Never put sensitive data (password, email) in the payload —
// it is base64 encoded, not encrypted. Anyone can decode it.
// ============================================================

const jwt = require('jsonwebtoken');

const SECRET     = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// Sign a new token after successful login.
// payload should be: { userId, role, firstName }
const signToken = (payload) => {
  if (!SECRET) throw new Error('JWT_SECRET is not set in .env');
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
};

// Verify a token from the Authorization header.
// Returns the decoded payload, or throws if invalid/expired.
const verifyToken = (token) => {
  if (!SECRET) throw new Error('JWT_SECRET is not set in .env');
  return jwt.verify(token, SECRET);
};

module.exports = { signToken, verifyToken };