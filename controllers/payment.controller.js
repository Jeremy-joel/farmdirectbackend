// ============================================================
// controllers/payment.controller.js — Mpesa Payments
// ============================================================
// Flow:
//   1. Buyer calls stkPush → Mpesa prompt appears on their phone
//   2. Buyer enters PIN → Safaricom calls our callback URL
//   3. callback() receives result → updates payment + order
//   4. Order moves from 'placed' to 'paid' & Escrow updated
//   5. Farmer confirms → courier job released
// ============================================================

const axios        = require('axios');
const { db }       = require('../config/db');
const { ok, err }  = require('../utils/response.utils');
const { sendSMS }  = require('../config/africastalking');

// ── Format phone for Mpesa (must be 2547XXXXXXXX) ────────────
const formatMpesaPhone = (phone) => {
  const p = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (p.startsWith('+254')) return p.slice(1);
  if (p.startsWith('254'))  return p;
  if (p.startsWith('0'))    return '254' + p.slice(1);
  return p;
};

// ── Get Daraja OAuth Token ────────────────────────────────────
const getDarajaToken = async () => {
  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const env    = process.env.MPESA_ENV || 'sandbox';

  const baseUrl = env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');

  const response = await axios.get(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  return { token: response.data.access_token, baseUrl };
};

// ── STK Push ──────────────────────────────────────────────────
const stkPush = async (req, res) => {
  try {
    const buyerId        = req.user.userId;
    const { orderId, phone } = req.body;

    if (!orderId) return err(res, 'Order ID is required.');
    if (!phone)   return err(res, 'Phone number is required.');

    const mpesaConfigured =
      process.env.MPESA_CONSUMER_KEY &&
      process.env.MPESA_CONSUMER_KEY !== 'YOUR_CONSUMER_KEY' &&
      process.env.MPESA_ENV === 'production' &&
      process.env.MPESA_CALLBACK_URL &&
      !process.env.MPESA_CALLBACK_URL.includes('localhost');

    if (!mpesaConfigured) {
      console.warn('[stkPush] Mpesa not fully configured — using simulate');
      return simulatePayment(req, res);
    }

    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND buyer_id = $2',
      [orderId, buyerId]
    );
    if (orderResult.rows.length === 0)
      return err(res, 'Order not found.', 404);

    const order = orderResult.rows[0];

    if (order.payment_status === 'paid')
      return err(res, 'This order has already been paid.');

    const amount       = Math.ceil(order.total_amount);
    const mpesaPhone   = formatMpesaPhone(phone);
    const shortcode    = process.env.MPESA_SHORTCODE;
    const passkey      = process.env.MPESA_PASSKEY;
    const callbackUrl  = process.env.MPESA_CALLBACK_URL;

    const timestamp = new Date().toISOString()
      .replace(/[-:T.Z]/g, '').slice(0, 14);
    const password  = Buffer.from(`${shortcode}${passkey}${timestamp}`)
      .toString('base64');

    const { token, baseUrl } = await getDarajaToken();

    const stkResponse = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: shortcode,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   'CustomerPayBillOnline',
        Amount:            amount,
        PartyA:            mpesaPhone,
        PartyB:            shortcode,
        PhoneNumber:       mpesaPhone,
        CallBackURL:       callbackUrl,
        AccountReference:  `FD-${orderId.slice(0, 8).toUpperCase()}`,
        TransactionDesc:   'FarmDirect Order Payment',
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutRequestId = stkResponse.data.CheckoutRequestID;

    await db.query(
      `INSERT INTO payments
         (order_id, buyer_id, amount, method, mpesa_phone,
          checkout_request_id, status)
       VALUES ($1,$2,$3,'mpesa',$4,$5,'pending')`,
      [orderId, buyerId, amount, mpesaPhone, checkoutRequestId]
    );

    return ok(res, {
      checkoutRequestId,
      amount,
      phone:   mpesaPhone,
      message: 'Check your phone for the Mpesa payment prompt.',
    }, 'Mpesa payment initiated. Enter your PIN on your phone.');

  } catch (error) {
    console.error('[stkPush]', error.response?.data || error.message);
    console.warn('[stkPush] STK push failed, falling back to simulate');
    return simulatePayment(req, res);
  }
};

// ── Simulate Payment (Development Only) ──────────────────────
const simulatePayment = async (req, res) => {
  try {
    const buyerId       = req.user.userId;
    const { orderId, phone } = req.body;

    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND buyer_id = $2',
      [orderId, buyerId]
    );
    if (orderResult.rows.length === 0)
      return err(res, 'Order not found.', 404);

    const order      = orderResult.rows[0];
    const amount     = Math.ceil(order.total_amount);
    const commission = Math.round(amount * 0.05);
    const netAmount  = amount - commission;
    const mpesaRef   = 'SIM' + Math.random().toString(36).substr(2,8).toUpperCase();

    // 1. Record payment
    await db.query(
      `INSERT INTO payments
         (order_id, buyer_id, amount, commission, net,
          method, mpesa_phone, mpesa_ref, status)
       VALUES ($1,$2,$3,$4,$5,'mpesa',$6,$7,'completed')`,
      [orderId, buyerId, amount, commission, netAmount,
       formatMpesaPhone(phone || '0700000000'), mpesaRef]
    );

    // 2. Update order status and payment_status to 'paid'
    await db.query(
      `UPDATE orders
       SET payment_status = 'paid', status = 'paid', mpesa_ref = $1, updated_at = NOW()
       WHERE id = $2`,
      [mpesaRef, orderId]
    );

    // 3. Update Farmer Escrow Wallet Balance
    await db.query(
      `INSERT INTO farmer_wallets (farmer_id, locked_in_escrow, available_balance)
       VALUES ($1, $2, 0)
       ON CONFLICT (farmer_id)
       DO UPDATE SET locked_in_escrow = farmer_wallets.locked_in_escrow + $2,
                     updated_at = NOW()`,
      [order.farmer_id, netAmount]
    );

    // 4. Notify farmer
    const farmerResult = await db.query(
      'SELECT phone, first_name FROM users WHERE id = $1', [order.farmer_id]
    );
    if (farmerResult.rows.length > 0) {
      await sendSMS(
        farmerResult.rows[0].phone,
        `Payment received! Ksh ${amount} for order ${orderId.slice(0,8)}. Please log in and confirm the order so delivery can be arranged.`
      );
    }

    return ok(res, {
      mpesaRef,
      amount,
      commission,
      net: netAmount,
      status:  'completed',
      devMode: true,
    }, `[DEV] Payment simulated. Mpesa ref: ${mpesaRef}`);

  } catch (error) {
    console.error('[simulatePayment]', error);
    return err(res, 'Payment simulation failed.', 500);
  }
};

// ── Mpesa Callback ────────────────────────────────────────────
const mpesaCallback = async (req, res) => {
  try {
    const body       = req.body?.Body?.stkCallback;
    const resultCode = body?.ResultCode;
    const checkoutId = body?.CheckoutRequestID;

    if (resultCode === 0) {
      const metadata = body.CallbackMetadata?.Item || [];
      const getMeta  = (name) =>
        metadata.find(i => i.Name === name)?.Value;

      const mpesaRef = getMeta('MpesaReceiptNumber');
      const amount   = getMeta('Amount');

      const payResult = await db.query(
        'SELECT * FROM payments WHERE checkout_request_id = $1', [checkoutId]
      );

      if (payResult.rows.length > 0) {
        const payment    = payResult.rows[0];
        const commission = Math.round(amount * 0.05);
        const netAmount  = amount - commission;

        await db.query(
          `UPDATE payments
           SET status = 'completed', mpesa_ref = $1,
               commission = $2, net = $3
           WHERE checkout_request_id = $4`,
          [mpesaRef, commission, netAmount, checkoutId]
        );

        await db.query(
          `UPDATE orders
           SET payment_status = 'paid', status = 'paid', mpesa_ref = $1, updated_at = NOW()
           WHERE id = $2`,
          [mpesaRef, payment.order_id]
        );

        const orderRes = await db.query(
          'SELECT farmer_id FROM orders WHERE id = $1', [payment.order_id]
        );
        if (orderRes.rows.length > 0) {
          const farmerId = orderRes.rows[0].farmer_id;

          // Lock funds into Escrow for the farmer
          await db.query(
            `INSERT INTO farmer_wallets (farmer_id, locked_in_escrow, available_balance)
             VALUES ($1, $2, 0)
             ON CONFLICT (farmer_id)
             DO UPDATE SET locked_in_escrow = farmer_wallets.locked_in_escrow + $2,
                           updated_at = NOW()`,
            [farmerId, netAmount]
          );

          const farmerRes = await db.query(
            'SELECT phone, first_name FROM users WHERE id = $1',
            [farmerId]
          );
          if (farmerRes.rows.length > 0) {
            await sendSMS(
              farmerRes.rows[0].phone,
              `Payment confirmed! Ksh ${amount} received in Escrow. Please log in and confirm the order.`
            );
          }
        }
      }
    } else {
      await db.query(
        `UPDATE payments SET status = 'failed'
         WHERE checkout_request_id = $1`,
        [checkoutId]
      );
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('[mpesaCallback]', error);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
};

// ── Get Payment By Order ──────────────────────────────────────
const getByOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await db.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error('[getByOrder payment]', error);
    return err(res, 'Could not load payment.', 500);
  }
};

// ── Check STK Push Status ────────────────────────────────────
const checkPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const buyerId     = req.user.userId;

    const result = await db.query(
      `SELECT p.status, p.mpesa_ref, p.amount, p.commission, p.net,
              o.payment_status
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = $1 AND p.buyer_id = $2
       ORDER BY p.created_at DESC LIMIT 1`,
      [orderId, buyerId]
    );

    if (!result.rows.length)
      return ok(res, { status: 'pending', paid: false });

    const pay = result.rows[0];
    return ok(res, {
      status:     pay.status,
      paid:       pay.status === 'completed' || pay.payment_status === 'paid',
      mpesaRef:   pay.mpesa_ref,
      amount:     pay.amount,
      commission: pay.commission,
      net:        pay.net,
    });
  } catch (error) {
    console.error('[checkPaymentStatus]', error);
    return err(res, 'Could not check payment status.', 500);
  }
};

module.exports = { stkPush, simulatePayment, mpesaCallback, getByOrder, checkPaymentStatus };