// ============================================================
// config/africastalking.js — SMS Service (OTP Delivery)
// ============================================================

const AfricasTalking = require('africastalking');

const AT = AfricasTalking({
  apiKey:   process.env.AT_API_KEY,
  username: process.env.AT_USERNAME, // 'sandbox' for dev, real username for prod
});

const smsService = AT.SMS;

/**
 * Sends SMS via Africa's Talking
 * @param {string} phone - Recipient phone number
 * @param {string} message - Message body
 */
const sendSMS = async (phone, message) => {
  if (!phone) {
    console.error('[SMS] Failed: No phone number provided.');
    return false;
  }

  // Ensure standard international format (+2547XXXXXXXX)
  let formatted = phone.trim().replace(/\s+/g, '');
  if (formatted.startsWith('0')) {
    formatted = '+254' + formatted.slice(1);
  } else if (formatted.startsWith('254')) {
    formatted = '+' + formatted;
  } else if (!formatted.startsWith('+')) {
    formatted = '+' + formatted;
  }

  // In development mode: log to console for debugging
  if (process.env.NODE_ENV === 'development') {
    console.log(`[SMS DEV LOG] To: ${formatted} | Message: ${message}`);
    return true;
  }

  // In production mode: send live SMS
  try {
    const payload = {
      to: [formatted],
      message: message,
    };

    // Only set 'from' if AT_SENDER_ID is explicitly set AND you are not in sandbox mode.
    // Unapproved custom sender IDs cause Africa's Talking requests to fail.
    if (process.env.AT_SENDER_ID && process.env.AT_USERNAME !== 'sandbox') {
      payload.from = process.env.AT_SENDER_ID;
    }

    const result = await smsService.send(payload);
    console.log('[SMS Response]', JSON.stringify(result));

    const recipient = result.SMSMessageData?.Recipients?.[0];
    const status = recipient?.status;

    // Status 101 or 'Success' indicates accepted for delivery
    if (status === 'Success' || recipient?.statusCode === 101) {
      console.log(`[SMS] Successfully queued/sent to ${formatted}`);
      return true;
    } else {
      console.error(`[SMS] Failed delivery to ${formatted}. Reason:`, status);
      return false;
    }
  } catch (error) {
    console.error('[SMS] Critical Error:', error.message || error);
    return false;
  }
};

module.exports = { sendSMS };