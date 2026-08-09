// ============================================================
// controllers/auth.controller.js — Authentication Logic
// ============================================================
// Handles all auth operations:
//   registerBuyer    → POST /api/auth/register/buyer
//   registerFarmer   → POST /api/auth/register/farmer
//   registerCourier  → POST /api/auth/register/courier
//   verifyOTP        → POST /api/auth/verify-otp
//   resendOTP        → POST /api/auth/resend-otp
//   login            → POST /api/auth/login
//   uploadDocument   → POST /api/auth/upload-document
//   getMe            → GET  /api/auth/me
//   changePassword   → POST /api/auth/change-password
//
// APPROVAL FLOW:
//   Buyers:   pending → active  ONLY after OTP verified
//   Farmers:  pending → active  ONLY after admin approves
//   Couriers: pending → active  ONLY after admin approves
//   Admin is the ONLY gate for farmers and couriers.
// ============================================================

const { db }                        = require('../config/db');
const { ok, err }                   = require('../utils/response.utils');
const { hashPassword, comparePassword } = require('../utils/hash.utils');
const { signToken }                 = require('../utils/jwt.utils');
const { generateOTP, storeOTP, validateOTP } = require('../utils/otp.utils');
const { uploadToCloudinary }        = require('../config/cloudinary');
const { sendSMS }                   = require('../config/africastalking');

// ── Helpers ──────────────────────────────────────────────────

// Format Kenyan phone to standard 07XX format for storage
const normalizePhone = (phone) => {
  if (!phone) return null;
  const p = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (p.startsWith('+254')) return '0' + p.slice(4);
  if (p.startsWith('254'))  return '0' + p.slice(3);
  if (p.startsWith('0'))    return p;
  return null;
};

// Strip sensitive fields before sending user to frontend
const safeUser = (user) => {
  const { password_hash, ...safe } = user;
  return safe;
};

// ── Register Buyer ────────────────────────────────────────────
// Creates account with status='pending'.
// Buyer becomes active ONLY after OTP is verified.
const registerBuyer = async (req, res) => {
  try {
    const { firstName, lastName, phone, email, county, password } = req.body;

    // Basic validation
    if (!firstName || !lastName) return err(res, 'First and last name are required.');
    if (!phone)                  return err(res, 'Phone number is required.');
    if (!password)               return err(res, 'Password is required.');
    if (password.length < 8)     return err(res, 'Password must be at least 8 characters.');

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone)  return err(res, 'Invalid phone number format. Use 07XX XXX XXX.');

    // Check for duplicate phone
    const phoneCheck = await db.query(
      'SELECT id FROM users WHERE phone = $1', [normalizedPhone]
    );
    if (phoneCheck.rows.length > 0)
      return err(res, 'This phone number is already registered.', 409);

    // Check for duplicate email (if provided)
    if (email) {
      const emailCheck = await db.query(
        'SELECT id FROM users WHERE email = $1', [email.toLowerCase()]
      );
      if (emailCheck.rows.length > 0)
        return err(res, 'This email address is already in use.', 409);
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Insert user — status='pending' until OTP verified
    const userResult = await db.query(
      `INSERT INTO users
         (phone, email, password_hash, role, status, first_name, last_name)
       VALUES ($1, $2, $3, 'buyer', 'pending', $4, $5)
       RETURNING *`,
      [normalizedPhone, email?.toLowerCase() || null, passwordHash, firstName, lastName]
    );
    const user = userResult.rows[0];

    // Insert buyer profile
    await db.query(
      `INSERT INTO buyer_profiles (user_id, county) VALUES ($1, $2)`,
      [user.id, county || null]
    );

    // Generate and send OTP
    const otp = generateOTP();
    await storeOTP(normalizedPhone, otp, 'registration');

    // Send SMS (logs to console in development)
    await sendSMS(
      normalizedPhone,
      `Your FarmDirect verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`
    );

    return ok(res,
      {
        userId: user.id,
        phone:  normalizedPhone,
        role:   'buyer',
        status: 'pending',
        // In development: return OTP in response for easy testing
        // REMOVE this in production
        ...(process.env.NODE_ENV === 'development' && { devOTP: otp }),
      },
      'Registration successful. Enter the OTP sent to your phone.',
      201
    );
  } catch (error) {
    console.error('[registerBuyer]', error);
    return err(res, 'Registration failed. Please try again.', 500);
  }
};

// ── Register Farmer ───────────────────────────────────────────
// Creates account with status='pending'.
// Farmer stays pending until ADMIN manually approves.
// OTP only proves phone — does NOT activate the account.
const registerFarmer = async (req, res) => {
  try {
    const {
      firstName, lastName, phone, email, county,
      farmName, farmSize, certification, produce,
      farmDescription, password,
    } = req.body;

    if (!firstName || !lastName) return err(res, 'First and last name are required.');
    if (!phone)                  return err(res, 'Phone number is required.');
    if (!county)                 return err(res, 'County is required.');
    if (!farmName)               return err(res, 'Farm name is required.');
    if (!password || password.length < 8)
      return err(res, 'Password must be at least 8 characters.');

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone)  return err(res, 'Invalid phone number format.');

    const phoneCheck = await db.query(
      'SELECT id FROM users WHERE phone = $1', [normalizedPhone]
    );
    if (phoneCheck.rows.length > 0)
      return err(res, 'This phone number is already registered.', 409);

    if (email) {
      const emailCheck = await db.query(
        'SELECT id FROM users WHERE email = $1', [email.toLowerCase()]
      );
      if (emailCheck.rows.length > 0)
        return err(res, 'This email address is already in use.', 409);
    }

    const passwordHash = await hashPassword(password);

    // Farmer starts as 'pending' — admin must approve
    const userResult = await db.query(
      `INSERT INTO users
         (phone, email, password_hash, role, status, first_name, last_name)
       VALUES ($1, $2, $3, 'farmer', 'pending', $4, $5)
       RETURNING *`,
      [normalizedPhone, email?.toLowerCase() || null, passwordHash, firstName, lastName]
    );
    const user = userResult.rows[0];

    // Insert farmer profile
    await db.query(
      `INSERT INTO farmer_profiles
         (user_id, farm_name, county, farm_size, certification, produce, farm_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user.id, farmName, county,
        farmSize || null,
        certification || 'none',
        produce || null,
        farmDescription || null,
      ]
    );

    // Send OTP (proves phone is real, does NOT activate account)
    const otp = generateOTP();
    await storeOTP(normalizedPhone, otp, 'registration');
    await sendSMS(
      normalizedPhone,
      `Your FarmDirect verification code is: ${otp}. Valid for 10 minutes.`
    );

    return ok(res,
      {
        userId: user.id,
        phone:  normalizedPhone,
        role:   'farmer',
        status: 'pending',
        ...(process.env.NODE_ENV === 'development' && { devOTP: otp }),
      },
      'Application received. Verify your phone number, then wait for admin approval before logging in.',
      201
    );
  } catch (error) {
    console.error('[registerFarmer]', error);
    return err(res, 'Registration failed. Please try again.', 500);
  }
};

// ── Register Courier ──────────────────────────────────────────
// Same as farmer — stays pending until admin approves.
const registerCourier = async (req, res) => {
  try {
    const {
      firstName, lastName, phone, email, county,
      vehicleType, vehicleReg, vehicleColor,
      licenceNumber, experience, idNumber, password,
    } = req.body;

    if (!firstName || !lastName) return err(res, 'First and last name are required.');
    if (!phone)                  return err(res, 'Phone number is required.');
    if (!vehicleType)            return err(res, 'Vehicle type is required.');
    if (!vehicleReg)             return err(res, 'Vehicle registration number is required.');
    if (!licenceNumber)          return err(res, 'Driving licence number is required.');
    if (!password || password.length < 8)
      return err(res, 'Password must be at least 8 characters.');

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone)  return err(res, 'Invalid phone number format.');

    const phoneCheck = await db.query(
      'SELECT id FROM users WHERE phone = $1', [normalizedPhone]
    );
    if (phoneCheck.rows.length > 0)
      return err(res, 'This phone number is already registered.', 409);

    if (email) {
      const emailCheck = await db.query(
        'SELECT id FROM users WHERE email = $1', [email.toLowerCase()]
      );
      if (emailCheck.rows.length > 0)
        return err(res, 'This email is already in use.', 409);
    }

    const passwordHash = await hashPassword(password);

    const userResult = await db.query(
      `INSERT INTO users
         (phone, email, password_hash, role, status, first_name, last_name)
       VALUES ($1, $2, $3, 'courier', 'pending', $4, $5)
       RETURNING *`,
      [normalizedPhone, email?.toLowerCase() || null, passwordHash, firstName, lastName]
    );
    const user = userResult.rows[0];

    await db.query(
      `INSERT INTO courier_profiles
         (user_id, vehicle_type, vehicle_reg, vehicle_color,
          licence_number, experience, county, national_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id, vehicleType,
        vehicleReg?.toUpperCase() || null,
        vehicleColor || null,
        licenceNumber?.toUpperCase() || null,
        experience || null,
        county || null,
        idNumber || null,
      ]
    );

    const otp = generateOTP();
    await storeOTP(normalizedPhone, otp, 'registration');
    await sendSMS(
      normalizedPhone,
      `Your FarmDirect verification code is: ${otp}. Valid for 10 minutes.`
    );

    return ok(res,
      {
        userId: user.id,
        phone:  normalizedPhone,
        role:   'courier',
        status: 'pending',
        ...(process.env.NODE_ENV === 'development' && { devOTP: otp }),
      },
      'Application received. Verify your phone, then wait for admin approval before logging in.',
      201
    );
  } catch (error) {
    console.error('[registerCourier]', error);
    return err(res, 'Registration failed. Please try again.', 500);
  }
};

// ── Verify OTP ────────────────────────────────────────────────
// After OTP is correct:
//   Buyers  → account becomes 'active', token issued, can log in
//   Farmers → account stays 'pending', no token, wait for admin
//   Couriers→ account stays 'pending', no token, wait for admin
const verifyOTPHandler = async (req, res) => {
  try {
    const { phone, otp, purpose = 'registration' } = req.body;

    if (!phone) return err(res, 'Phone number is required.');
    if (!otp)   return err(res, 'OTP code is required.');

    const normalizedPhone = normalizePhone(phone);
    const result          = await validateOTP(normalizedPhone, otp, purpose);

    if (!result.valid)
      return err(res, result.message, 400);

    // Mark phone as verified in users table
    await db.query(
      `UPDATE users SET otp_verified = TRUE, updated_at = NOW()
       WHERE phone = $1`,
      [normalizedPhone]
    );

    // Get user record
    const userResult = await db.query(
      'SELECT * FROM users WHERE phone = $1', [normalizedPhone]
    );
    if (userResult.rows.length === 0)
      return err(res, 'User not found.', 404);

    const user = userResult.rows[0];

    // Buyers become active immediately after OTP
    if (user.role === 'buyer' && user.status === 'pending') {
      await db.query(
        `UPDATE users SET status = 'active', updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      );

      // Issue JWT so buyer can log in immediately
      const token = signToken({
        userId:    user.id,
        role:      user.role,
        firstName: user.first_name,
      });

      return ok(res, {
        verified: true,
        token,
        user: safeUser({ ...user, status: 'active' }),
        redirect: '/buyer/marketplace.html',
      }, 'Phone verified. Welcome to FarmDirect!');
    }

    // Farmers and couriers: phone verified but account still pending admin
    return ok(res, {
      verified:        true,
      status:          'pending',
      awaitingApproval: true,
    }, 'Phone verified. Your account is now pending admin review. You will be notified once approved.');

  } catch (error) {
    console.error('[verifyOTP]', error);
    return err(res, 'OTP verification failed. Please try again.', 500);
  }
};

// ── Resend OTP ────────────────────────────────────────────────
const resendOTPHandler = async (req, res) => {
  try {
    const { phone, purpose = 'registration' } = req.body;
    if (!phone) return err(res, 'Phone number is required.');

    const normalizedPhone = normalizePhone(phone);

    const userCheck = await db.query(
      'SELECT id FROM users WHERE phone = $1', [normalizedPhone]
    );
    if (userCheck.rows.length === 0)
      return err(res, 'No account found with this phone number.', 404);

    const otp = generateOTP();
    await storeOTP(normalizedPhone, otp, purpose);
    await sendSMS(
      normalizedPhone,
      `Your new FarmDirect verification code is: ${otp}. Valid for 10 minutes.`
    );

    return ok(res,
      { ...(process.env.NODE_ENV === 'development' && { devOTP: otp }) },
      'A new OTP has been sent to your phone.'
    );
  } catch (error) {
    console.error('[resendOTP]', error);
    return err(res, 'Could not resend OTP. Please try again.', 500);
  }
};

// ── Login ─────────────────────────────────────────────────────
// Blocks pending and suspended users with clear messages.
const loginHandler = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier) return err(res, 'Phone number or email is required.');
    if (!password)   return err(res, 'Password is required.');

    const normalizedPhone = normalizePhone(identifier);

    // Find by phone OR email
    const userResult = await db.query(
      `SELECT * FROM users
       WHERE phone = $1 OR email = $2
       LIMIT 1`,
      [normalizedPhone || '', identifier.toLowerCase()]
    );

    // Use generic message — never reveal whether phone/email exists
    if (userResult.rows.length === 0)
      return err(res, 'Invalid credentials. Check your phone number and password.', 401);

    const user = userResult.rows[0];

    // Check account status BEFORE password (better UX)
    if (user.status === 'pending') {
      return err(res,
        'Your account is awaiting admin approval. You will receive an SMS once approved.',
        403
      );
    }
    if (user.status === 'suspended') {
      return err(res,
        'Your account has been suspended. Contact admin@farmdirect.co.ke for help.',
        403
      );
    }
    if (user.status === 'rejected') {
      return err(res,
        'Your application was not approved. Contact admin@farmdirect.co.ke for details.',
        403
      );
    }

    // Verify password
    const passwordMatch = await comparePassword(password, user.password_hash);
    if (!passwordMatch)
      return err(res, 'Invalid credentials. Check your phone number and password.', 401);

    // Update last login timestamp
    await db.query(
      `UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]
    );

    // Sign JWT
    const token = signToken({
      userId:    user.id,
      role:      user.role,
      firstName: user.first_name,
    });

    // Determine where to redirect after login
    const redirectMap = {
      buyer:   '/buyer/marketplace.html',
      farmer:  '/farmer/dashboard.html',
      courier: '/courier/courier-dashboard.html',
      admin:   '/admin/admin.html',
    };

    return ok(res, {
      token,
      user:     safeUser(user),
      redirect: redirectMap[user.role] || '/',
    }, `Welcome back, ${user.first_name}!`);

  } catch (error) {
    console.error('[login]', error);
    return err(res, 'Login failed. Please try again.', 500);
  }
};

// ============================================================
// PASTE THIS FUNCTION INTO YOUR auth.controller.js
const uploadDocument = async (req, res) => {
  try {
    const userId  = req.user.userId;
    const docType = req.body.docType;

    // Validate doc type
    const validDocTypes = ['idFront','idBack','selfie','licence','vehicle'];
    if (!docType || !validDocTypes.includes(docType)) {
      return err(res,
        `Invalid document type "${docType}". Must be one of: ${validDocTypes.join(', ')}.`
      );
    }

    // Must have a file attached
    if (!req.file) {
      return err(res, 'No file uploaded. Please select a document image.');
    }

    // Upload buffer to Cloudinary
    const { uploadToCloudinary } = require('../config/cloudinary');
    const uploaded = await uploadToCloudinary(
      req.file.buffer,
      `farmdirect/documents/${userId}`
    );

    console.log(`[uploadDocument] Saved to Cloudinary: ${uploaded.url}`);

    // Save URL to database
    // ON CONFLICT: if this doc type already exists for this user, update it
    await db.query(
      `INSERT INTO documents
         (user_id, doc_type, cloudinary_url, cloudinary_id, uploaded_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, doc_type)
       DO UPDATE SET
         cloudinary_url = EXCLUDED.cloudinary_url,
         cloudinary_id  = EXCLUDED.cloudinary_id,
         uploaded_at    = NOW()`,
      [userId, docType, uploaded.url, uploaded.publicId]
    );

    return ok(res, {
      docType,
      url:      uploaded.url,
      publicId: uploaded.publicId,
    }, 'Document uploaded successfully.');

  } catch (error) {
    console.error('[uploadDocument]', error);
    return err(res, 'Document upload failed: ' + error.message, 500);
  }
};
// ── Get Current User ──────────────────────────────────────────
// Returns the logged-in user's full profile.
const getMe = async (req, res) => {
  try {
    const userId = req.user.userId;

    const userResult = await db.query(
      'SELECT * FROM users WHERE id = $1', [userId]
    );
    if (userResult.rows.length === 0)
      return err(res, 'User not found.', 404);

    const user = userResult.rows[0];

    // Get role-specific profile
    let profile = null;
    if (user.role === 'buyer') {
      const r = await db.query(
        'SELECT * FROM buyer_profiles WHERE user_id = $1', [userId]
      );
      profile = r.rows[0] || null;
    } else if (user.role === 'farmer') {
      const r = await db.query(
        'SELECT * FROM farmer_profiles WHERE user_id = $1', [userId]
      );
      profile = r.rows[0] || null;
    } else if (user.role === 'courier') {
      const r = await db.query(
        'SELECT * FROM courier_profiles WHERE user_id = $1', [userId]
      );
      profile = r.rows[0] || null;
    }

    return ok(res, { ...safeUser(user), profile });
  } catch (error) {
    console.error('[getMe]', error);
    return err(res, 'Could not fetch profile.', 500);
  }
};

// ── Change Password ───────────────────────────────────────────
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword) return err(res, 'Current password is required.');
    if (!newPassword)      return err(res, 'New password is required.');
    if (newPassword.length < 8)
      return err(res, 'New password must be at least 8 characters.');
    if (newPassword !== confirmPassword)
      return err(res, 'New passwords do not match.');

    const userResult = await db.query(
      'SELECT * FROM users WHERE id = $1', [userId]
    );
    if (userResult.rows.length === 0)
      return err(res, 'User not found.', 404);

    const user = userResult.rows[0];
    const match = await comparePassword(currentPassword, user.password_hash);
    if (!match)
      return err(res, 'Current password is incorrect.', 401);

    const newHash = await hashPassword(newPassword);
    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, userId]
    );

    return ok(res, null, 'Password changed successfully.');
  } catch (error) {
    console.error('[changePassword]', error);
    return err(res, 'Password change failed. Please try again.', 500);
  }
};

module.exports = {
  registerBuyer,
  registerFarmer,
  registerCourier,
  verifyOTP:       verifyOTPHandler,
  resendOTP:       resendOTPHandler,
  login:           loginHandler,
  uploadDocument,
  getMe,
  changePassword,
};