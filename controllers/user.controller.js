// ============================================================
// controllers/user.controller.js — User Profile
// ============================================================
const { db }      = require('../config/db');
const { ok, err } = require('../utils/response.utils');

const getProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await db.query(
      `SELECT u.id, u.phone, u.email, u.role, u.status,
              u.first_name, u.last_name, u.created_at,
              fp.farm_name, fp.county AS farm_county, fp.certification,
              fp.produce, fp.farm_description, fp.rating AS farmer_rating,
              cp.vehicle_type, cp.vehicle_reg, cp.county AS courier_county,
              cp.rating AS courier_rating, cp.total_trips,
              bp.county AS buyer_county, bp.delivery_area
       FROM users u
       LEFT JOIN farmer_profiles  fp ON fp.user_id = u.id
       LEFT JOIN courier_profiles cp ON cp.user_id = u.id
       LEFT JOIN buyer_profiles   bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    if (result.rows.length === 0) return err(res, 'User not found.', 404);
    return ok(res, result.rows[0]);
  } catch (error) {
    console.error('[getProfile]', error);
    return err(res, 'Could not load profile.', 500);
  }
};

const updateProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role   = req.user.role;
    const { firstName, lastName, email, county, deliveryArea,
            farmName, farmDescription, produce } = req.body;

    if (firstName || lastName || email) {
      await db.query(
        `UPDATE users SET
           first_name = COALESCE($1, first_name),
           last_name  = COALESCE($2, last_name),
           email      = COALESCE($3, email),
           updated_at = NOW()
         WHERE id = $4`,
        [firstName || null, lastName || null, email || null, userId]
      );
    }

    if (role === 'buyer' && (county || deliveryArea)) {
      await db.query(
        `UPDATE buyer_profiles SET
           county = COALESCE($1, county),
           delivery_area = COALESCE($2, delivery_area)
         WHERE user_id = $3`,
        [county || null, deliveryArea || null, userId]
      );
    }

    if (role === 'farmer' && (farmName || county || farmDescription || produce)) {
      await db.query(
        `UPDATE farmer_profiles SET
           farm_name        = COALESCE($1, farm_name),
           county           = COALESCE($2, county),
           farm_description = COALESCE($3, farm_description),
           produce          = COALESCE($4, produce)
         WHERE user_id = $5`,
        [farmName||null, county||null, farmDescription||null, produce||null, userId]
      );
    }

    return ok(res, null, 'Profile updated successfully.');
  } catch (error) {
    console.error('[updateProfile]', error);
    return err(res, 'Could not update profile.', 500);
  }
};


// ── GET WALLET BALANCE ────────────────────────────────────────
const getWallet = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role   = req.user.role;

    if (role === 'farmer') {
      const result = await db.query(
        `SELECT available_balance, locked_in_escrow, total_earned
         FROM farmer_wallets WHERE farmer_id = $1`,
        [userId]
      );
      const wallet = result.rows[0] || { available_balance:0, locked_in_escrow:0, total_earned:0 };
      return ok(res, {
        availableBalance: parseFloat(wallet.available_balance || 0),
        lockedInEscrow:   parseFloat(wallet.locked_in_escrow  || 0),
        totalEarned:      parseFloat(wallet.total_earned      || 0),
        role: 'farmer',
      });
    }

    if (role === 'courier') {
      const result = await db.query(
        `SELECT available_balance, total_earned
         FROM courier_wallets WHERE courier_id = $1`,
        [userId]
      );
      const wallet = result.rows[0] || { available_balance:0, total_earned:0 };
      return ok(res, {
        availableBalance: parseFloat(wallet.available_balance || 0),
        totalEarned:      parseFloat(wallet.total_earned      || 0),
        role: 'courier',
      });
    }

    return err(res, 'Wallet not available for this role.', 403);
  } catch (error) {
    console.error('[getWallet]', error.message);
    return err(res, 'Could not load wallet.', 500);
  }
};

// ── GET WALLET TRANSACTIONS ────────────────────────────────────
const getWalletTransactions = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { period } = req.query; // 'week' | 'month' | 'all'

    let dateFilter = '';
    if (period === 'week')
      dateFilter = `AND created_at >= NOW() - INTERVAL '7 days'`;
    else if (period === 'month')
      dateFilter = `AND created_at >= NOW() - INTERVAL '30 days'`;

    const result = await db.query(
      `SELECT id, type, amount, order_id, description, status, created_at
       FROM wallet_transactions
       WHERE user_id = $1 ${dateFilter}
       ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );

    const txns  = result.rows;
    const total = txns.reduce((s,t) => s + parseFloat(t.amount||0), 0);

    return ok(res, { transactions: txns, total, count: txns.length });
  } catch (error) {
    console.error('[getWalletTransactions]', error.message);
    return err(res, 'Could not load transactions.', 500);
  }
};

// ── REQUEST WITHDRAWAL ────────────────────────────────────────
const requestWithdrawal = async (req, res) => {
  try {
    const userId     = req.user.userId;
    const role       = req.user.role;
    const { amount, mpesaPhone } = req.body;

    if (!amount || amount <= 0)  return err(res, 'Invalid withdrawal amount.', 400);
    if (!mpesaPhone)             return err(res, 'Mpesa phone number is required.', 400);
    if (!['farmer','courier'].includes(role))
      return err(res, 'Withdrawal not available for this role.', 403);

    // Check sufficient balance
    const walletTable = role === 'farmer' ? 'farmer_wallets' : 'courier_wallets';
    const walletKey   = role === 'farmer' ? 'farmer_id'      : 'courier_id';
    const balResult   = await db.query(
      `SELECT available_balance FROM ${walletTable} WHERE ${walletKey} = $1`,
      [userId]
    );
    const balance = parseFloat(balResult.rows[0]?.available_balance || 0);
    if (amount > balance)
      return err(res, `Insufficient balance. Available: Ksh ${balance.toLocaleString()}.`, 400);

    // Deduct from available balance immediately (pending payout)
    await db.query(
      `UPDATE ${walletTable} SET
         available_balance = available_balance - $1,
         updated_at        = NOW()
       WHERE ${walletKey} = $2`,
      [amount, userId]
    );

    // Create withdrawal request for admin to process
    await db.query(
      `INSERT INTO withdrawal_requests (user_id, role, amount, mpesa_phone, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [userId, role, amount, mpesaPhone]
    );

    // Log transaction
    await db.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'withdrawal_requested', $2, 'Withdrawal requested via Mpesa', 'pending')`,
      [userId, amount]
    );

    return ok(res, { amount, mpesaPhone, status: 'pending' },
      `Withdrawal of Ksh ${amount} requested. Admin will process within 24 hours.`);
  } catch (error) {
    console.error('[requestWithdrawal]', error.message);
    return err(res, 'Could not process withdrawal.', 500);
  }
};

module.exports = { getProfile, updateProfile, getWallet, getWalletTransactions, requestWithdrawal };