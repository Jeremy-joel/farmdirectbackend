// ============================================================
// controllers/courier.controller.js — Courier Jobs
// ============================================================
const { db }      = require('../config/db');
const { ok, err } = require('../utils/response.utils');
const { sendSMS } = require('../config/africastalking');

// Get all available jobs (courier sees these to accept)
const getAvailableJobs = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT cj.*
       FROM courier_jobs cj
       WHERE cj.status = 'available'
       ORDER BY cj.created_at DESC`
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error('[getAvailableJobs]', error);
    return err(res, 'Could not load available jobs.', 500);
  }
};

// Get jobs assigned to this courier
const getMyCourierJobs = async (req, res) => {
  try {
    const courierId = req.user.userId;
    const result = await db.query(
      `SELECT cj.*, o.total_amount, o.status AS order_status
       FROM courier_jobs cj
       LEFT JOIN orders o ON o.id = cj.order_id
       WHERE cj.courier_id = $1
       ORDER BY cj.created_at DESC`,
      [courierId]
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error('[getMyCourierJobs]', error);
    return err(res, 'Could not load your jobs.', 500);
  }
};

// Courier accepts an available job
const acceptJob = async (req, res) => {
  try {
    const courierId   = req.user.userId;
    const courierName = req.user.firstName;
    const { jobId }   = req.params;

    // Verify courier is active
    const courierCheck = await db.query(
      'SELECT status FROM users WHERE id = $1', [courierId]
    );
    if (courierCheck.rows[0]?.status !== 'active')
      return err(res, 'Your account must be active to accept jobs.', 403);

    // Check job is still available
    const jobResult = await db.query(
      'SELECT * FROM courier_jobs WHERE id = $1', [jobId]
    );
    if (jobResult.rows.length === 0)
      return err(res, 'Job not found.', 404);
    if (jobResult.rows[0].status !== 'available')
      return err(res, 'This job is no longer available.', 409);

    const job = jobResult.rows[0];

    // Assign courier to job
    await db.query(
      `UPDATE courier_jobs
       SET courier_id = $1, status = 'accepted', accepted_at = NOW()
       WHERE id = $2`,
      [courierId, jobId]
    );

    // Update order status
    await db.query(
      `UPDATE orders
       SET courier_id = $1, status = 'dispatched', updated_at = NOW()
       WHERE id = $2`,
      [courierId, job.order_id]
    );

    // Notify buyer
    await sendSMS(
      job.buyer_phone,
      `Your FarmDirect order is on the way! ${courierName} is delivering your order. Track it in the app.`
    );

    return ok(res, { jobId, status: 'accepted' }, 'Job accepted. Head to the farm for pickup.');
  } catch (error) {
    console.error('[acceptJob]', error);
    return err(res, 'Could not accept job.', 500);
  }
};

// Courier marks job as delivered
const markDelivered = async (req, res) => {
  try {
    const courierId = req.user.userId;
    const { jobId } = req.params;

    const jobResult = await db.query(
      'SELECT * FROM courier_jobs WHERE id = $1 AND courier_id = $2',
      [jobId, courierId]
    );
    if (jobResult.rows.length === 0)
      return err(res, 'Job not found or not assigned to you.', 404);

    await db.query(
      `UPDATE courier_jobs
       SET status = 'delivered', delivered_at = NOW()
       WHERE id = $1`,
      [jobId]
    );

    await db.query(
      `UPDATE orders SET status = 'delivered', updated_at = NOW()
       WHERE id = $1`,
      [jobResult.rows[0].order_id]
    );

    await db.query(
      `UPDATE courier_profiles
       SET total_trips = total_trips + 1 WHERE user_id = $1`,
      [courierId]
    );

    // Notify buyer
    await sendSMS(
      jobResult.rows[0].buyer_phone,
      `Your FarmDirect order has been delivered! Thank you for shopping with us. Please rate your experience in the app.`
    );

    return ok(res, { jobId, status: 'delivered' }, 'Order marked as delivered.');
  } catch (error) {
    console.error('[markDelivered]', error);
    return err(res, 'Could not update job status.', 500);
  }
};

module.exports = { getAvailableJobs, getMyCourierJobs, acceptJob, markDelivered };