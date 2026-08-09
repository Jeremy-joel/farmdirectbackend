// ============================================================
// config/cloudinary.js — v2.1
// Cloudinary setup + uploadToCloudinary helper.
// Takes a buffer (from multer memoryStorage) and uploads it.
// Returns { url, publicId } on success, throws on failure.
// ============================================================

const cloudinary = require('cloudinary').v2;

// Configure using env variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,  // always use https URLs
});

// ── Test connection on startup ────────────────────────────────
const testCloudinary = async () => {
  try {
    await cloudinary.api.ping();
    console.log('✅ Cloudinary connected —', process.env.CLOUDINARY_CLOUD_NAME);
  } catch (error) {
    console.warn('⚠️  Cloudinary connection failed:', error.message);
    console.warn('   Images will not upload until Cloudinary is configured correctly.');
  }
};

// Run test when module loads (non-blocking)
testCloudinary();

// ── Upload helper ─────────────────────────────────────────────
// buffer  — file buffer from multer memoryStorage
// folder  — Cloudinary folder path e.g. 'farmdirect/products/userId'
// options — optional Cloudinary upload options to merge
//
// Returns: { url: string, publicId: string }
const uploadToCloudinary = (buffer, folder, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      transformation: [
        { quality: 'auto:good' },  // auto compress
        { fetch_format: 'auto' },  // serve webp where supported
      ],
      ...options,
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error('[Cloudinary upload error]', error.message);
          return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        }
        resolve({
          url:      result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    // Write buffer to the upload stream
    const { Readable } = require('stream');
    const readableStream = new Readable();
    readableStream.push(buffer);
    readableStream.push(null);
    readableStream.pipe(uploadStream);
  });
};

// ── Delete helper (for cleanup when product/doc is removed) ──
const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    console.log(`[Cloudinary] Deleted: ${publicId}`);
  } catch (error) {
    console.error('[Cloudinary delete error]', error.message);
    // Don't throw — deletion failure is non-critical
  }
};

module.exports = { uploadToCloudinary, deleteFromCloudinary };