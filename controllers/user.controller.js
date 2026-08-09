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

module.exports = { getProfile, updateProfile };