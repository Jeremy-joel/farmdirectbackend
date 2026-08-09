// ============================================================
// routes/product.routes.js — v2.1
// All product endpoints.
// Image upload uses multer (memory storage) → Cloudinary.
// ============================================================

const router  = require('express').Router();
const multer  = require('multer');

const { verifyToken }   = require('../middleware/auth.middleware');
const { requireRole }   = require('../middleware/role.middleware');
const {
  createProduct,
  getProducts,
  getProduct,
  getMyProducts,
  updateProduct,
  deleteProduct,
  toggleStock,
} = require('../controllers/product.controller');

// ── Multer — memory storage (file goes straight to Cloudinary) ─
// Max 5MB, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },  // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP and GIF images are allowed.'), false);
    }
  },
});

// ── Public routes (no auth required) ─────────────────────────
router.get('/',    getProducts);   // Marketplace — all active products
router.get('/my',  verifyToken, requireRole('farmer'), getMyProducts); // must be before /:id
router.get('/:id', getProduct);    // Single product detail

// ── Farmer routes (auth + farmer role required) ───────────────
router.post(
  '/',
  verifyToken,
  requireRole('farmer'),
  upload.single('image'),          // 'image' is the form field name
  createProduct
);

router.patch(
  '/:id',
  verifyToken,
  requireRole('farmer'),
  upload.single('image'),
  updateProduct
);

router.delete(
  '/:id',
  verifyToken,
  requireRole('farmer'),
  deleteProduct
);

router.patch(
  '/:id/stock',
  verifyToken,
  requireRole('farmer'),
  toggleStock
);

// ── Multer error handler ──────────────────────────────────────
router.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE')
      return res.status(400).json({ success: false, error: 'Image must be under 5MB.' });
  }
  if (error.message)
    return res.status(400).json({ success: false, error: error.message });
  res.status(500).json({ success: false, error: 'File upload error.' });
});

module.exports = router;