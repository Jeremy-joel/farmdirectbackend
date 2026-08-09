// ============================================================
// controllers/product.controller.js — v2.2
// FIXES:
//  - image field: upload.single('image') → req.file works correctly
//  - image_public_id column name matches new schema
//  - freshness_days column matches new schema
//  - Categories expanded to match updated DB constraint
//  - GROUP BY aggregation removed from list query (was main
//    cause of slow marketplace loads — was doing full review
//    table scan on every product list request)
//  - Count query uses same params correctly
// ============================================================

const { db }                 = require('../config/db');
const { ok, err }            = require('../utils/response.utils');
const { uploadToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');

// Must match the DB CHECK constraint exactly
const VALID_CATEGORIES = [
  'vegetables','fruits','grains','dairy','herbs',
  'poultry','other','eggs','meat','fish',
  'honey','legumes','tubers',
];

const VALID_UNITS = [
  'kg','g','litre','ml','bunch','piece',
  'crate','bag','dozen','tray','other',
];

// ── CREATE PRODUCT ─────────────────────────────────────────
// POST /api/products
// Multer field name: 'image' (set in product.routes.js)
const createProduct = async (req, res) => {
  try {
    const farmerId = req.user.userId;

    // Verify farmer is active before accepting product
    const farmerCheck = await db.query(
      `SELECT u.status, fp.county AS farm_county
       FROM users u
       LEFT JOIN farmer_profiles fp ON fp.user_id = u.id
       WHERE u.id = $1`,
      [farmerId]
    );
    if (!farmerCheck.rows.length)
      return err(res, 'Farmer account not found.', 404);
    if (farmerCheck.rows[0].status !== 'active')
      return err(res,
        'Your account must be approved before listing products. ' +
        'Current status: ' + farmerCheck.rows[0].status, 403
      );

    const {
      name, category, price, unit,
      stock, county, description, freshnessDays,
    } = req.body;

    // Validation
    if (!name?.trim() || name.trim().length < 2)
      return err(res, 'Product name is required (at least 2 characters).');

    const normalizedCategory = (category || '').toLowerCase().trim();
    if (!VALID_CATEGORIES.includes(normalizedCategory))
      return err(res,
        `Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}.`
      );

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice <= 0)
      return err(res, 'Price must be a positive number.');

    const normalizedUnit = (unit || '').toLowerCase().trim();
    if (!VALID_UNITS.includes(normalizedUnit))
      return err(res,
        `Unit must be one of: ${VALID_UNITS.join(', ')}.`
      );

    const parsedStock = parseInt(stock, 10);
    if (isNaN(parsedStock) || parsedStock < 0)
      return err(res, 'Stock must be a non-negative whole number.');

    if (!county?.trim())
      return err(res, 'County is required.');

    // Optional image upload — product saves even if no image
    let imageUrl      = null;
    let imagePublicId = null;

    if (req.file) {
      try {
        const uploaded = await uploadToCloudinary(
          req.file.buffer,
          `farmdirect/products/${farmerId}`
        );
        imageUrl      = uploaded.url;
        imagePublicId = uploaded.publicId;
        console.log(`[createProduct] Image uploaded: ${imageUrl}`);
      } catch (uploadErr) {
        // Image failed — still save product without image
        console.error('[createProduct] Image upload failed:', uploadErr.message);
      }
    }

    const result = await db.query(
      `INSERT INTO products
         (farmer_id, name, category, price, unit, stock,
          county, description, freshness_days,
          image_url, image_public_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
       RETURNING *`,
      [
        farmerId,
        name.trim(),
        normalizedCategory,
        parsedPrice,
        normalizedUnit,
        parsedStock,
        county.trim(),
        description?.trim() || null,
        freshnessDays ? parseInt(freshnessDays, 10) : null,
        imageUrl,
        imagePublicId,
      ]
    );

    const product = result.rows[0];

    // Get farmer name for response
    const farmerResult = await db.query(
      'SELECT first_name, last_name FROM users WHERE id = $1',
      [farmerId]
    );
    const farmer = farmerResult.rows[0] || {};

    return ok(res, {
      ...product,
      // Always expose both image_url and image so frontend works
      image:       product.image_url,
      farmer_name: `${farmer.first_name || ''} ${farmer.last_name || ''}`.trim(),
    }, 'Product listed successfully.', 201);

  } catch (error) {
    console.error('[createProduct]', error);
    return err(res, `Failed to list product: ${error.message}`, 500);
  }
};

// ── GET MARKETPLACE (public) ───────────────────────────────
// GET /api/products?county=&category=&search=&page=&limit=&sort=
// SPEED FIX: removed GROUP BY aggregation from list query.
// Average ratings are now calculated per-product only on
// the single product detail page, not on every list load.
const getProducts = async (req, res) => {
  try {
    const {
      county, category, search,
      page  = 1,
      limit = 20,
      sort  = 'newest',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const wheres = [`p.status = 'active'`, `p.stock > 0`];

    if (county) {
      params.push(`%${county}%`);
      wheres.push(`p.county ILIKE $${params.length}`);
    }
    if (category) {
      params.push(category.toLowerCase().trim());
      wheres.push(`p.category = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      wheres.push(
        `(p.name        ILIKE $${params.length}
          OR p.description ILIKE $${params.length}
          OR p.county      ILIKE $${params.length})`
      );
    }

    const whereClause = wheres.length
      ? `WHERE ${wheres.join(' AND ')}`
      : '';

    const orderClause = {
      newest:     'p.created_at DESC',
      freshest:   'p.created_at DESC',
      price_asc:  'p.price ASC',
      price_desc: 'p.price DESC',
      rating:     'p.rating DESC',
    }[sort] || 'p.created_at DESC';

    // COUNT — same where params (no limit/offset)
    const countParams = [...params];
    const countResult = await db.query(
      `SELECT COUNT(*) FROM products p ${whereClause}`,
      countParams
    );
    const total = parseInt(countResult.rows[0].count);

    // PRODUCTS — add limit and offset at the end
    params.push(parseInt(limit), offset);

    const productsResult = await db.query(
      `SELECT
         p.id, p.name, p.category, p.price, p.unit,
         p.stock, p.county, p.description,
         p.image_url, p.image_public_id,
         p.freshness_days, p.rating, p.review_count,
         p.views, p.sales, p.created_at, p.updated_at,
         p.farmer_id,
         u.first_name || ' ' || u.last_name AS farmer_name,
         u.phone                             AS farmer_phone,
         fp.farm_name,
         fp.county                           AS farm_county,
         fp.certification
       FROM products p
       JOIN  users           u  ON u.id          = p.farmer_id
       LEFT JOIN farmer_profiles fp ON fp.user_id = p.farmer_id
       ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params
    );

    const products = productsResult.rows.map(p => ({
      ...p,
      image: p.image_url || null,
    }));

    return ok(res, {
      products,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });

  } catch (error) {
    console.error('[getProducts]', error);
    return err(res, 'Could not load products.', 500);
  }
};

// ── GET SINGLE PRODUCT (public) ────────────────────────────
// GET /api/products/:id
// Reviews aggregated here only — not on list pages
const getProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT
         p.*,
         u.first_name || ' ' || u.last_name AS farmer_name,
         u.phone                             AS farmer_phone,
         fp.farm_name,
         fp.county                           AS farm_county,
         fp.certification,
         fp.farm_description,
         COALESCE(AVG(r.rating), 0)          AS avg_rating,
         COUNT(DISTINCT r.id)                AS review_count_live
       FROM products p
       JOIN  users           u  ON u.id          = p.farmer_id
       LEFT JOIN farmer_profiles fp ON fp.user_id = p.farmer_id
       LEFT JOIN reviews      r  ON r.product_id  = p.id
       WHERE p.id = $1
       GROUP BY p.id, u.first_name, u.last_name, u.phone,
                fp.farm_name, fp.county, fp.certification,
                fp.farm_description`,
      [id]
    );

    if (!result.rows.length)
      return err(res, 'Product not found.', 404);

    // Increment view count (non-blocking)
    db.query('UPDATE products SET views = views + 1 WHERE id = $1', [id])
      .catch(() => {});

    const p = result.rows[0];
    return ok(res, {
      ...p,
      image:      p.image_url || null,
      avg_rating: parseFloat(p.avg_rating).toFixed(1),
    });

  } catch (error) {
    console.error('[getProduct]', error);
    return err(res, 'Could not load product.', 500);
  }
};

// ── GET FARMER'S OWN PRODUCTS ──────────────────────────────
// GET /api/products/my  (farmer auth required)
const getMyProducts = async (req, res) => {
  try {
    const farmerId = req.user.userId;

    const result = await db.query(
      `SELECT
         p.*,
         p.image_url AS image
       FROM products p
       WHERE p.farmer_id = $1
       ORDER BY p.created_at DESC`,
      [farmerId]
    );

    const products = result.rows.map(p => ({
      ...p,
      image: p.image_url || null,
    }));

    return ok(res, { products, total: products.length });

  } catch (error) {
    console.error('[getMyProducts]', error);
    return err(res, 'Could not load your products.', 500);
  }
};

// ── UPDATE PRODUCT ─────────────────────────────────────────
// PATCH /api/products/:id  (farmer only, must own product)
const updateProduct = async (req, res) => {
  try {
    const farmerId = req.user.userId;
    const { id }   = req.params;

    const existing = await db.query(
      'SELECT * FROM products WHERE id = $1 AND farmer_id = $2',
      [id, farmerId]
    );
    if (!existing.rows.length)
      return err(res, 'Product not found or permission denied.', 404);

    const {
      name, category, price, unit,
      stock, county, description, freshnessDays,
    } = req.body;

    const updates = [];
    const values  = [];

    if (name)     { values.push(name.trim());                   updates.push(`name = $${values.length}`); }
    if (category) { values.push(category.toLowerCase().trim()); updates.push(`category = $${values.length}`); }
    if (price)    { values.push(parseFloat(price));             updates.push(`price = $${values.length}`); }
    if (unit)     { values.push(unit.toLowerCase().trim());     updates.push(`unit = $${values.length}`); }
    if (stock !== undefined) {
      values.push(parseInt(stock, 10));
      updates.push(`stock = $${values.length}`);
    }
    if (county)      { values.push(county.trim());                updates.push(`county = $${values.length}`); }
    if (description) { values.push(description.trim());           updates.push(`description = $${values.length}`); }
    if (freshnessDays) {
      values.push(parseInt(freshnessDays, 10));
      updates.push(`freshness_days = $${values.length}`);
    }

    // Handle new image upload
    if (req.file) {
      try {
        // Delete old image from Cloudinary if exists
        if (existing.rows[0].image_public_id) {
          await deleteFromCloudinary(existing.rows[0].image_public_id);
        }
        const uploaded = await uploadToCloudinary(
          req.file.buffer,
          `farmdirect/products/${farmerId}`
        );
        values.push(uploaded.url);       updates.push(`image_url = $${values.length}`);
        values.push(uploaded.publicId);  updates.push(`image_public_id = $${values.length}`);
      } catch (uploadErr) {
        console.error('[updateProduct] Image upload failed:', uploadErr.message);
      }
    }

    if (!updates.length)
      return err(res, 'No fields provided to update.');

    values.push(id);
    const result = await db.query(
      `UPDATE products
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    const p = result.rows[0];
    return ok(res, { ...p, image: p.image_url || null }, 'Product updated.');

  } catch (error) {
    console.error('[updateProduct]', error);
    return err(res, 'Could not update product.', 500);
  }
};

// ── DELETE PRODUCT ─────────────────────────────────────────
// DELETE /api/products/:id  (farmer only)
const deleteProduct = async (req, res) => {
  try {
    const farmerId = req.user.userId;
    const { id }   = req.params;

    // Soft delete — mark as deleted, keep record
    const result = await db.query(
      `UPDATE products
       SET status = 'deleted', updated_at = NOW()
       WHERE id = $1 AND farmer_id = $2
       RETURNING id`,
      [id, farmerId]
    );

    if (!result.rows.length)
      return err(res, 'Product not found or permission denied.', 404);

    return ok(res, { id }, 'Product removed.');

  } catch (error) {
    console.error('[deleteProduct]', error);
    return err(res, 'Could not delete product.', 500);
  }
};

// ── TOGGLE STOCK STATUS ────────────────────────────────────
// PATCH /api/products/:id/stock
const toggleStock = async (req, res) => {
  try {
    const farmerId   = req.user.userId;
    const { id }     = req.params;
    const { status, stock } = req.body;

    const updates = [];
    const values  = [];

    // Can pass stock=0 OR status='out_of_stock' OR both
    if (stock !== undefined) {
      values.push(parseInt(stock, 10));
      updates.push(`stock = $${values.length}`);
    }
    if (status) {
      const allowed = ['active','inactive'];
      if (!allowed.includes(status))
        return err(res, `Status must be one of: ${allowed.join(', ')}.`);
      values.push(status);
      updates.push(`status = $${values.length}`);
    }

    // Default: mark stock as 0 if nothing passed
    if (!updates.length) {
      values.push(0);
      updates.push(`stock = $${values.length}`);
    }

    values.push(id, farmerId);
    const result = await db.query(
      `UPDATE products
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length - 1}
         AND farmer_id = $${values.length}
       RETURNING id, stock, status`,
      values
    );

    if (!result.rows.length)
      return err(res, 'Product not found or permission denied.', 404);

    return ok(res, result.rows[0], 'Product stock updated.');

  } catch (error) {
    console.error('[toggleStock]', error);
    return err(res, 'Could not update stock.', 500);
  }
};

module.exports = {
  createProduct,
  getProducts,
  getProduct,
  getMyProducts,
  updateProduct,
  deleteProduct,
  toggleStock,
};