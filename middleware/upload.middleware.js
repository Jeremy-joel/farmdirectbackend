// ============================================================
// middleware/upload.middleware.js — File Upload Handler
// ============================================================
// Uses Multer to handle multipart/form-data file uploads.
// Files are kept in memory (not saved to disk) and then
// passed to Cloudinary for permanent cloud storage.
//
// Limits:
//   - Max file size: 5MB
//   - Allowed types: JPEG, PNG, WebP images only
//   - Type is checked by MIME type, not file extension
//     (prevents renaming a virus.exe to virus.jpg)
// ============================================================

const multer = require('multer');
const { err } = require('../utils/response.utils');

// Memory storage — file goes into req.file.buffer
// Not saved to disk at any point
const storage = multer.memoryStorage();

// File type validation
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true); // Accept the file
  } else {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed.'), false);
  }
};

// Base Multer config
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB in bytes
  },
});

// Single file upload — field name is 'file'
// Use for: profile photo, product image, single document
// Adds req.file to the request
const uploadSingle = upload.single('file');

// Multiple files — up to 5, all in field named 'files'
// Use for: uploading multiple product images
// Adds req.files[] to the request
const uploadMultiple = upload.array('files', 5);

// Error handler wrapper — converts Multer errors to clean API responses
// Usage: wrap uploadSingle or uploadMultiple in a route like:
//   router.post('/upload', handleUpload(uploadSingle), controller);
const handleUpload = (uploadFn) => (req, res, next) => {
  uploadFn(req, res, (error) => {
    if (!error) return next();

    if (error.code === 'LIMIT_FILE_SIZE') {
      return err(res, 'File too large. Maximum allowed size is 5MB.', 413);
    }
    if (error.message) {
      return err(res, error.message, 400);
    }
    return err(res, 'File upload failed.', 400);
  });
};

module.exports = { uploadSingle, uploadMultiple, handleUpload };