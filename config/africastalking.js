// ============================================================
// config/africastalking.js — SMS Service (OTP Delivery)
// ============================================================
// Africa's Talking sends real SMS to Kenyan phone numbers.
// In sandbox mode (development): SMS go to the AT simulator,
// not real phones. Good for testing without spending money.
// In production: top up your AT account (approx Ksh 1/SMS).
//
// Usage:
//   const { sendSMS } = require('../config/africastalking');
//   await sendSMS('0712345678', 'Your FarmDirect code is 123456');
// ============================================================

const AfricasTalking = require('africastalking');

// Initialise with credentials from .env
const AT = AfricasTalking({
  apiKey:   process.env.AT_API_KEY,
  username: process.env.AT_USERNAME, // 'sandbox' for dev, real username for prod
});

const smsService = AT.SMS;

// ── Send SMS helper ───────────────────────────────────────────
// Formats the Kenyan phone number and sends the message.
// Returns true on success, false on failure (never crashes the app).
const sendSMS = async (phone, message) => {
  // Convert local format (07XX) to international (2547XX)
  const formatted = phone.startsWith('0')
    ? '+254' + phone.slice(1)
    : phone.startsWith('254')
    ? '+' + phone
    : phone;

  // In development: just log to console instead of sending SMS
  // This saves your AT credits during development
  if (process.env.NODE_ENV === 'development') {
    console.log(`%c[SMS → ${formatted}] ${message}`, 'color:purple;font-weight:bold');
    console.log(`[SMS DEV] To: ${formatted} | Message: ${message}`);
    return true;
  }

  // In production: send the real SMS via Africa's Talking
  try {
    const result = await smsService.send({
      to:      [formatted],
      message: message,
      from:    process.env.AT_SENDER_ID || 'FarmDirect',
    });

    const recipient = result.SMSMessageData?.Recipients?.[0];
    if (recipient?.status === 'Success') {
      console.log(`[SMS] Sent to ${formatted}`);
      return true;
    } else {
      console.error('[SMS] Failed:', recipient?.status);
      return false;
    }
  } catch (error) {
    console.error('[SMS] Error:', error.message);
    return false; // Don't crash the server if SMS fails
  }
};

module.exports = { sendSMS };