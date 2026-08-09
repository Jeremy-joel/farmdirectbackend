// ============================================================
// utils/hash.utils.js — Password Hashing with bcrypt
// ============================================================
// bcrypt is a one-way hashing algorithm designed specifically
// for passwords. It is deliberately slow (controlled by
// BCRYPT_ROUNDS) which makes brute-force attacks impractical.
//
// IMPORTANT: bcrypt output is different every time even for
// the same password. Never compare passwords with ===.
// Always use comparePassword() which uses bcrypt.compare().
// ============================================================

const bcrypt = require('bcryptjs');

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

// Hash a plain password before storing in database.
// The result is a 60-character string — safe to store.
const hashPassword = async (plainPassword) => {
  return bcrypt.hash(plainPassword, ROUNDS);
};

// Compare a plain password attempt against a stored hash.
// Returns true if they match, false if not.
// Use this on login — never compare plain passwords directly.
const comparePassword = async (plainPassword, hash) => {
  return bcrypt.compare(plainPassword, hash);
};

module.exports = { hashPassword, comparePassword };