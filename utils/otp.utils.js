// ============================================================
// utils/otp.utils.js — One-Time Password (OTP) System
// ============================================================
// OTP flow:
//   1. generateOTP()     → creates a random 6-digit code
//   2. storeOTP()        → HASHES the code and saves to DB
//                          (plain code is NEVER stored)
//   3. SMS is sent with the plain code to the user's phone
//   4. User types the code into the form
//   5. validateOTP()     → finds the hash in DB, compares
//                          using bcrypt, tracks failed attempts
//
// Security rules enforced:
//   - OTP expires in OTP_EXPIRES_MINUTES (default 10 min)
//   - Maximum 3 wrong attempts then OTP is invalidated
//   - Each new OTP invalidates all previous OTPs for that phone
// ============================================================

const bcrypt = require('bcryptjs');
const { db } = require('../config/db');

const EXPIRES_MINUTES = parseInt(process.env.OTP_EXPIRES_MINUTES) || 10;
const MAX_ATTEMPTS    = parseInt(process.env.OTP_MAX_ATTEMPTS)    || 3;

// Generate a random 6-digit OTP as a string e.g. "047823"
const generateOTP = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

// Store a new OTP for a phone number.
// Invalidates any existing OTPs for the same phone + purpose.
// The plain OTP is hashed — never stored as plain text.
const storeOTP = async (phone, plainOTP, purpose = 'registration') => {
  // Invalidate all previous OTPs for this phone + purpose
  await db.query(
    `UPDATE otps SET used = TRUE
     WHERE phone = $1 AND purpose = $2 AND used = FALSE`,
    [phone, purpose]
  );

  // Hash the OTP before storing
  const otpHash  = await bcrypt.hash(plainOTP, 10); // 10 rounds is fine for OTP
  const expiresAt = new Date(Date.now() + EXPIRES_MINUTES * 60 * 1000);

  await db.query(
    `INSERT INTO otps (phone, otp_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [phone, otpHash, purpose, expiresAt]
  );
};

// Validate an OTP submitted by the user.
// Returns { valid: true } on success.
// Returns { valid: false, message: "..." } on failure.
const validateOTP = async (phone, submittedOTP, purpose = 'registration') => {
  // Find the latest unused, non-expired OTP for this phone
  const result = await db.query(
    `SELECT * FROM otps
     WHERE phone = $1
       AND purpose = $2
       AND used = FALSE
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [phone, purpose]
  );

  if (result.rows.length === 0) {
    return { valid: false, message: 'OTP not found or expired. Request a new one.' };
  }

  const otpRecord = result.rows[0];

  // Check attempt count
  if (otpRecord.attempts >= MAX_ATTEMPTS) {
    // Invalidate this OTP
    await db.query(`UPDATE otps SET used = TRUE WHERE id = $1`, [otpRecord.id]);
    return {
      valid:   false,
      message: `Too many incorrect attempts. Request a new OTP.`,
    };
  }

  // Increment attempt count first
  await db.query(
    `UPDATE otps SET attempts = attempts + 1 WHERE id = $1`,
    [otpRecord.id]
  );

  // Compare submitted OTP against stored hash
  const isMatch = await bcrypt.compare(String(submittedOTP), otpRecord.otp_hash);

  if (!isMatch) {
    const attemptsLeft = MAX_ATTEMPTS - (otpRecord.attempts + 1);
    return {
      valid:   false,
      message: attemptsLeft > 0
        ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} left.`
        : `Too many incorrect attempts. Request a new OTP.`,
    };
  }

  // Mark OTP as used so it cannot be reused
  await db.query(`UPDATE otps SET used = TRUE WHERE id = $1`, [otpRecord.id]);
  return { valid: true };
};

module.exports = { generateOTP, storeOTP, validateOTP };