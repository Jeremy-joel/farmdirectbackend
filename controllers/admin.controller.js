// ============================================================
// controllers/admin.controller.js — v2.2
// FIXES:
//  - platform_fee column renamed to commission (matches schema)
//  - Added getAnalytics() for dashboard charts
//  - Added getAllPayments() and getAllCourierJobs()
//  - getUserDocuments() confirmed working with cloudinary_url
// ============================================================

const { db }      = require('../config/db');
const { ok, err } = require('../utils/response.utils');
const { sendSMS } = require('../config/africastalking');

const safeUser = (u) => {
  const { password_hash, ...safe } = u;
  return safe;
};

// ── GET ALL USERS ───────────────────────────────────────────
const getUsers = async (req, res) => {
  try {
    const { status, role, search, page = 1, limit = 20 } = req.query;
    const params = [];
    const wheres = [`u.role != 'admin'`];

    if (status) { params.push(status); wheres.push(`u.status = $${params.length}`); }
    if (role)   { params.push(role);   wheres.push(`u.role = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      wheres.push(`(u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }

    const where  = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countResult = await db.query(`SELECT COUNT(*) FROM users u ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit), offset);
    const usersResult = await db.query(
      `SELECT
         u.id, u.phone, u.email, u.first_name, u.last_name,
         u.role, u.status, u.otp_verified, u.created_at, u.last_login,
         fp.farm_name, fp.county AS farm_county, fp.produce, fp.certification,
         cp.vehicle_type, cp.vehicle_reg, cp.licence_number, cp.county AS courier_county,
         bp.county AS buyer_county,
         (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id) AS doc_count
       FROM users u
       LEFT JOIN farmer_profiles  fp ON fp.user_id = u.id
       LEFT JOIN courier_profiles cp ON cp.user_id = u.id
       LEFT JOIN buyer_profiles   bp ON bp.user_id = u.id
       ${where}
       ORDER BY
         CASE u.status WHEN 'pending' THEN 0 ELSE 1 END,
         u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return ok(res, {
      users:      usersResult.rows.map(safeUser),
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error('[getUsers]', error);
    return err(res, 'Could not fetch users.', 500);
  }
};

// ── GET SINGLE USER ─────────────────────────────────────────
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT
         u.*,
         fp.farm_name, fp.county AS farm_county, fp.produce,
         fp.certification, fp.farm_size, fp.farm_description,
         cp.vehicle_type, cp.vehicle_reg, cp.vehicle_color,
         cp.licence_number, cp.experience, cp.county AS courier_county,
         bp.county AS buyer_county
       FROM users u
       LEFT JOIN farmer_profiles  fp ON fp.user_id = u.id
       LEFT JOIN courier_profiles cp ON cp.user_id = u.id
       LEFT JOIN buyer_profiles   bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [id]
    );
    if (!result.rows.length) return err(res, 'User not found.', 404);
    return ok(res, safeUser(result.rows[0]));
  } catch (error) {
    console.error('[getUserById]', error);
    return err(res, 'Could not fetch user.', 500);
  }
};

// ── GET USER DOCUMENTS ──────────────────────────────────────
// Returns Cloudinary URLs for admin document viewer
const getUserDocuments = async (req, res) => {
  try {
    const { id } = req.params;

    const userCheck = await db.query(
      'SELECT id, first_name, last_name, role FROM users WHERE id = $1', [id]
    );
    if (!userCheck.rows.length) return err(res, 'User not found.', 404);
    const user = userCheck.rows[0];

    const docsResult = await db.query(
      `SELECT
         id, doc_type,
         cloudinary_url AS url,
         cloudinary_id  AS public_id,
         uploaded_at, verified
       FROM documents
       WHERE user_id = $1
       ORDER BY uploaded_at DESC`,
      [id]
    );

    const docLabels = {
      idFront: 'National ID — Front',
      idBack:  'National ID — Back',
      selfie:  'Selfie / Portrait',
      licence: 'Driving Licence',
      vehicle: 'Vehicle / Log Book',
    };

    const documents = docsResult.rows.map(doc => ({
      ...doc,
      label:    docLabels[doc.doc_type] || doc.doc_type,
      hasImage: !!doc.url,
    }));

    return ok(res, {
      userId:   id,
      userName: `${user.first_name} ${user.last_name}`,
      userRole: user.role,
      documents,
      total:    documents.length,
    });
  } catch (error) {
    console.error('[getUserDocuments]', error);
    return err(res, 'Could not fetch documents.', 500);
  }
};

// ── SET USER STATUS ─────────────────────────────────────────
const setUserStatus = async (req, res) => {
  try {
    const { id }             = req.params;
    const { status, reason } = req.body;

    const allowed = ['active','suspended','rejected','pending'];
    if (!allowed.includes(status))
      return err(res, `Status must be one of: ${allowed.join(', ')}.`);

    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!userResult.rows.length) return err(res, 'User not found.', 404);
    const user = userResult.rows[0];

    if (user.role === 'admin')
      return err(res, 'Cannot change admin account status.', 403);

    await db.query(
      `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id]
    );

    const messages = {
      active:    `Hello ${user.first_name}, your FarmDirect account has been approved! You can now log in.`,
      suspended: `Hello ${user.first_name}, your FarmDirect account has been suspended. ${reason ? 'Reason: ' + reason : ''}`,
      rejected:  `Hello ${user.first_name}, your FarmDirect application was not approved. ${reason ? 'Reason: ' + reason : ''}`,
    };
    if (messages[status]) {
      await sendSMS(user.phone, messages[status]).catch(e =>
        console.warn('[setUserStatus] SMS failed:', e.message)
      );
    }

    return ok(res, { userId: id, status },
      `Account ${status === 'active' ? 'approved' : status} successfully. SMS sent to ${user.phone}.`
    );
  } catch (error) {
    console.error('[setUserStatus]', error);
    return err(res, 'Could not update user status.', 500);
  }
};

// ── GET ALL ORDERS ──────────────────────────────────────────
const getOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const params = [];
    const wheres = [];

    if (status) { params.push(status); wheres.push(`o.status = $${params.length}`); }
    const where  = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countResult = await db.query(`SELECT COUNT(*) FROM orders o ${where}`, params);

    params.push(parseInt(limit), offset);
    const result = await db.query(
      `SELECT
         o.id, o.status, o.payment_status, o.total_amount,
         o.delivery_fee, o.delivery_address, o.created_at, o.mpesa_ref,
         buyer.first_name  || ' ' || buyer.last_name  AS buyer_name,
         buyer.phone                                   AS buyer_phone,
         farmer.first_name || ' ' || farmer.last_name AS farmer_name,
         farmer.phone                                  AS farmer_phone,
         courier.first_name || ' ' || courier.last_name AS courier_name
       FROM orders o
       JOIN users buyer          ON buyer.id   = o.buyer_id
       JOIN users farmer         ON farmer.id  = o.farmer_id
       LEFT JOIN users courier   ON courier.id = o.courier_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return ok(res, {
      orders:     result.rows,
      total:      parseInt(countResult.rows[0].count),
      page:       parseInt(page),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
    });
  } catch (error) {
    console.error('[getOrders]', error);
    return err(res, 'Could not fetch orders.', 500);
  }
};

// ── GET ALL PAYMENTS ────────────────────────────────────────
// FIX: was missing entirely — admin payments page got 404
const getAllPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countResult = await db.query('SELECT COUNT(*) FROM payments');
    const result = await db.query(
      `SELECT
         p.*,
         u.first_name || ' ' || u.last_name AS buyer_name,
         u.phone                             AS buyer_phone
       FROM payments p
       LEFT JOIN users u ON u.id = p.buyer_id
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );

    return ok(res, {
      payments:   result.rows,
      total:      parseInt(countResult.rows[0].count),
      page:       parseInt(page),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
    });
  } catch (error) {
    console.error('[getAllPayments]', error);
    return err(res, 'Could not fetch payments.', 500);
  }
};

// ── GET ALL COURIER JOBS ────────────────────────────────────
// FIX: was missing entirely — admin couriers page got 404
const getAllCourierJobs = async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE cj.status = $1`; }

    const result = await db.query(
      `SELECT
         cj.*,
         courier.first_name || ' ' || courier.last_name AS courier_name,
         courier.phone                                   AS courier_phone
       FROM courier_jobs cj
       LEFT JOIN users courier ON courier.id = cj.courier_id
       ${where}
       ORDER BY cj.created_at DESC`,
      params
    );

    return ok(res, result.rows);
  } catch (error) {
    console.error('[getAllCourierJobs]', error);
    return err(res, 'Could not fetch courier jobs.', 500);
  }
};

// ── PLATFORM STATS ──────────────────────────────────────────
// FIX: platform_fee → commission (column rename to match schema)
const getStats = async (req, res) => {
  try {
    const [users, products, orders, payments] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)                                     AS total,
          COUNT(*) FILTER (WHERE status='pending')    AS pending,
          COUNT(*) FILTER (WHERE status='active')     AS active,
          COUNT(*) FILTER (WHERE role='buyer'   AND status='active') AS buyers,
          COUNT(*) FILTER (WHERE role='farmer'  AND status='active') AS farmers,
          COUNT(*) FILTER (WHERE role='courier' AND status='active') AS couriers,
          COUNT(*) FILTER (WHERE role='farmer'  AND status='pending') AS pending_farmers,
          COUNT(*) FILTER (WHERE role='buyer'   AND status='pending') AS pending_buyers,
          COUNT(*) FILTER (WHERE role='courier' AND status='pending') AS pending_couriers
        FROM users WHERE role != 'admin'
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='active') AS total,
          COALESCE(SUM(stock),0)                  AS total_stock
        FROM products
      `),
      db.query(`
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE status='placed')        AS placed,
          COUNT(*) FILTER (WHERE status='confirmed')     AS confirmed,
          COUNT(*) FILTER (WHERE status='dispatched')    AS dispatched,
          COUNT(*) FILTER (WHERE status='delivered')     AS delivered,
          COALESCE(SUM(total_amount),0)                  AS total_value
        FROM orders
      `),
      // FIX: commission, not platform_fee
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='completed')                       AS completed,
          COALESCE(SUM(amount)     FILTER (WHERE status='completed'),0)   AS total_collected,
          COALESCE(SUM(commission) FILTER (WHERE status='completed'),0)   AS total_commission
        FROM payments
      `),
    ]);

    const u = users.rows[0];
    const pendingApprovals =
      parseInt(u.pending_farmers || 0) +
      parseInt(u.pending_buyers  || 0) +
      parseInt(u.pending_couriers|| 0);

    return ok(res, {
      users: {
        totalBuyers:     parseInt(u.buyers   || 0),
        totalFarmers:    parseInt(u.farmers  || 0),
        totalCouriers:   parseInt(u.couriers || 0),
        pendingFarmers:  parseInt(u.pending_farmers  || 0),
        pendingBuyers:   parseInt(u.pending_buyers   || 0),
        pendingCouriers: parseInt(u.pending_couriers || 0),
        pendingApprovals,
      },
      products: {
        total: parseInt(products.rows[0].total || 0),
      },
      orders: {
        total:      parseInt(orders.rows[0].total      || 0),
        placed:     parseInt(orders.rows[0].placed      || 0),
        confirmed:  parseInt(orders.rows[0].confirmed   || 0),
        dispatched: parseInt(orders.rows[0].dispatched  || 0),
        delivered:  parseInt(orders.rows[0].delivered   || 0),
      },
      payments: {
        totalRevenue:    parseFloat(payments.rows[0].total_collected   || 0),
        totalCommission: parseFloat(payments.rows[0].total_commission  || 0),
      },
    });
  } catch (error) {
    console.error('[getStats]', error);
    return err(res, 'Could not fetch stats.', 500);
  }
};

// ── ANALYTICS FOR CHARTS ────────────────────────────────────
// FIX: was completely missing — dashboard charts had nothing to call
const getAnalytics = async (req, res) => {
  try {
    const [
      ordersByStatus, revenueByDay, usersByDay,
      productsByCategory, ordersByDay,
    ] = await Promise.all([
      db.query(`SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC`),
      db.query(`
        SELECT DATE(created_at) AS day, SUM(amount) AS revenue, COUNT(*) AS transactions
        FROM payments
        WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY day ASC
      `),
      db.query(`
        SELECT DATE(created_at) AS day, role, COUNT(*) AS count
        FROM users
        WHERE created_at >= NOW() - INTERVAL '30 days' AND role != 'admin'
        GROUP BY DATE(created_at), role ORDER BY day ASC
      `),
      db.query(`
        SELECT category, COUNT(*) AS count FROM products
        WHERE status = 'active' GROUP BY category ORDER BY count DESC
      `),
      db.query(`
        SELECT DATE(created_at) AS day, COUNT(*) AS count, SUM(total_amount) AS value
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '14 days'
        GROUP BY DATE(created_at) ORDER BY day ASC
      `),
    ]);

    return ok(res, {
      ordersByStatus:     ordersByStatus.rows,
      revenueByDay:       revenueByDay.rows,
      usersByDay:         usersByDay.rows,
      productsByCategory: productsByCategory.rows,
      ordersByDay:        ordersByDay.rows,
    });
  } catch (error) {
    console.error('[getAnalytics]', error);
    return err(res, 'Could not load analytics.', 500);
  }
};

// ── PUBLIC STATS (homepage, no auth) ────────────────────────
const getPublicStats = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='farmer'  AND status='active') AS farmers,
        (SELECT COUNT(*) FROM products WHERE status='active')                  AS listings,
        (SELECT COUNT(*) FROM orders)                                           AS orders,
        (SELECT COUNT(*) FROM users WHERE role='buyer'   AND status='active') AS buyers,
        (SELECT COUNT(*) FROM users WHERE role='courier' AND status='active') AS couriers
    `);
    return ok(res, result.rows[0]);
  } catch (error) {
    console.error('[getPublicStats]', error);
    return err(res, 'Could not fetch stats.', 500);
  }
};

module.exports = {
  getUsers,
  getUserById,
  getUserDocuments,
  setUserStatus,
  getOrders,
  getAllPayments,
  getAllCourierJobs,
  getStats,
  getAnalytics,
  getPublicStats,
};