// ============================================================
// routes/auth.routes.js — v2.1
// ============================================================

const router  = require('express').Router();
const multer  = require('multer');
const { verifyToken } = require('../middleware/auth.middleware');
const { verifyDocument } = require('../middleware/documentAI.middleware');
const {
  registerBuyer,
  registerFarmer,
  registerCourier,
  verifyOTP,
  resendOTP,
  login,
  uploadDocument,
  getMe,
  changePassword,
} = require('../controllers/auth.controller');

// ── Multer for document uploads (memory storage → Cloudinary) ─
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },   // 10 MB for documents
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP, HEIC images and PDF files are allowed.'), false);
    }
  },
});

// ── Public routes ─────────────────────────────────────────────
router.post('/register/buyer',   registerBuyer);
router.post('/register/farmer',  registerFarmer);
router.post('/register/courier', registerCourier);
router.post('/verify-otp',       verifyOTP);
router.post('/resend-otp',       resendOTP);
router.post('/login',            login);

// ── Protected routes (must be logged in) ──────────────────────
router.get('/me',              verifyToken, getMe);
router.post('/change-password', verifyToken, changePassword);

// Document upload — accepts single file in field named 'file'
// Also requires docType in the form body
router.post('/upload-document', verifyToken, docUpload.single('file'), verifyDocument, uploadDocument);

// ── Multer error handler ──────────────────────────────────────
router.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE')
      return res.status(400).json({ success: false, error: 'File must be under 10MB.' });
  }
  if (error.message)
    return res.status(400).json({ success: false, error: error.message });
  res.status(500).json({ success: false, error: 'File upload error.' });
});

module.exports = router;