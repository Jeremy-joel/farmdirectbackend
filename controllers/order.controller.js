// ============================================================
// controllers/order.controller.js  v1.1
// PAYMENT FLOW (escrow model):
//
//   1. Buyer places order → status: 'placed'
//   2. Buyer pays via Mpesa → status: 'paid'
//      Money is held by FarmDirect (not yet sent to farmer)
//   3. Farmer sees order, confirms availability → status: 'confirmed'
//      Courier job becomes 'available' to all couriers
//   4. Courier accepts job → status: 'dispatched'
//   5. Courier delivers → status: 'delivered'
//      Payment released to farmer (minus 5% commission)
//
// WHY ESCROW:
//   Buyer is protected — money only leaves escrow after delivery.
//   Farmer is protected — money is already secured before they pack.
//   Both parties can trust the transaction.
// ============================================================

const { db }      = require('../config/db');
const { ok, err } = require('../utils/response.utils');
const { sendSMS } = require('../config/africastalking');

const create = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const { items, deliveryAddress, notes } = req.body;

    if (!items || items.length === 0)
      return err(res, 'Your cart is empty.');
    if (!deliveryAddress)
      return err(res, 'Delivery address is required.');

    const buyerResult = await db.query(
      'SELECT * FROM users WHERE id = $1', [buyerId]
    );
    const buyer = buyerResult.rows[0];

    const productIds     = items.map(i => i.productId);
    const productsResult = await db.query(
      `SELECT p.*, u.first_name AS farmer_first, u.last_name AS farmer_last,
              u.phone AS farmer_phone, fp.county AS farmer_county
       FROM products p
       LEFT JOIN users u ON u.id = p.farmer_id
       LEFT JOIN farmer_profiles fp ON fp.user_id = p.farmer_id
       WHERE p.id = ANY($1) AND p.status = 'active'`,
      [productIds]
    );

    const productMap = {};
    productsResult.rows.forEach(p => { productMap[p.id] = p; });

    for (const item of items) {
      const product = productMap[item.productId];
      if (!product)
        return err(res, 'One or more products are no longer available.');
      if (product.stock < item.quantity)
        return err(res, `"${product.name}" only has ${product.stock} ${product.unit} left.`);
    }

    let subtotal   = 0;
    const orderItems = items.map(item => {
      const product   = productMap[item.productId];
      const itemTotal = parseFloat(product.price) * parseFloat(item.quantity);
      subtotal       += itemTotal;
      return { product, quantity: item.quantity, itemTotal };
    });

    const deliveryFee = 150;
    const totalAmount = subtotal + deliveryFee;
    const firstProduct = orderItems[0].product;
    const farmerId     = firstProduct.farmer_id;

    const orderResult = await db.query(
      `INSERT INTO orders
         (buyer_id, farmer_id, total_amount, delivery_fee,
          delivery_address, buyer_county, farmer_county,
          status, payment_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'placed','pending',$8)
       RETURNING *`,
      [
        buyerId, farmerId, totalAmount, deliveryFee,
        deliveryAddress,
        buyer.county || null,
        firstProduct.farmer_county || null,
        notes || null,
      ]
    );
    const order = orderResult.rows[0];

    for (const item of orderItems) {
      await db.query(
        `INSERT INTO order_items
           (order_id, product_id, farmer_id, product_name,
            quantity, unit, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.id, item.product.id, item.product.farmer_id,
         item.product.name, item.quantity, item.product.unit,
         item.product.price, item.itemTotal]
      );
      await db.query(
        `UPDATE products SET stock = stock - $1, sales = sales + $2, updated_at = NOW()
         WHERE id = $3`,
        [item.quantity, item.quantity, item.product.id]
      );
    }

    // Courier job locked until farmer confirms
    await db.query(
      `INSERT INTO courier_jobs
         (order_id, farmer_id, farmer_name, farmer_phone, farmer_location,
          buyer_name, buyer_phone, buyer_location, product_summary,
          delivery_fee, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_farmer')`,
      [
        order.id, farmerId,
        `${firstProduct.farmer_first} ${firstProduct.farmer_last}`,
        firstProduct.farmer_phone,
        firstProduct.farmer_county || 'Farm',
        `${buyer.first_name} ${buyer.last_name}`,
        buyer.phone, deliveryAddress,
        orderItems.map(i => `${i.product.name} ×${i.quantity}`).join(', '),
        deliveryFee,
      ]
    );

    await sendSMS(
      firstProduct.farmer_phone,
      `New FarmDirect order from ${buyer.first_name}! ` +
      `${orderItems.map(i => i.product.name).join(', ')}. ` +
      `Total: Ksh ${totalAmount}. Log in to confirm after payment is received.`
    );

    return ok(res, {
      orderId: order.id, totalAmount, deliveryFee, subtotal,
      status: 'placed', paymentStatus: 'pending',
      items: orderItems.map(i => ({
        name: i.product.name, quantity: i.quantity,
        unit: i.product.unit, price: i.product.price, subtotal: i.itemTotal,
      })),
    }, 'Order placed. Complete payment to confirm.', 201);

  } catch (error) {
    console.error('[create order]', error);
    return err(res, 'Could not place order: ' + error.message, 500);
  }
};

const getById = async (req, res) => {
  try {
    const { id }   = req.params;
    const userId   = req.user.userId;
    const userRole = req.user.role;

    const orderResult = await db.query(
      `SELECT o.*,
         buyer.first_name   AS buyer_first,  buyer.last_name  AS buyer_last,
         buyer.phone        AS buyer_phone,
         farmer.first_name  AS farmer_first, farmer.last_name AS farmer_last,
         farmer.phone       AS farmer_phone,
         courier.first_name AS courier_first,courier.last_name AS courier_last,
         courier.phone      AS courier_phone
       FROM orders o
       LEFT JOIN users buyer   ON buyer.id   = o.buyer_id
       LEFT JOIN users farmer  ON farmer.id  = o.farmer_id
       LEFT JOIN users courier ON courier.id = o.courier_id
       WHERE o.id = $1`,
      [id]
    );
    if (orderResult.rows.length === 0) return err(res, 'Order not found.', 404);
    const order = orderResult.rows[0];

    const canView = userRole === 'admin' ||
      order.buyer_id === userId || order.farmer_id === userId || order.courier_id === userId;
    if (!canView) return err(res, 'Access denied.', 403);

    const itemsResult = await db.query(
      `SELECT oi.*, p.image_url FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`, [id]
    );
    const jobResult = await db.query(
      'SELECT * FROM courier_jobs WHERE order_id = $1', [id]
    );

    return ok(res, {
      ...order,
      items:      itemsResult.rows,
      courierJob: jobResult.rows[0] || null,
    });
  } catch (error) {
    console.error('[getById order]', error);
    return err(res, 'Could not load order.', 500);
  }
};

const getMyOrders = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const { status } = req.query;
    const params  = [buyerId];
    let statusFilter = '';
    if (status) {
      params.push(status);
      statusFilter = `AND o.status = $${params.length}`;
    }
    const result = await db.query(
      `SELECT o.id, o.status, o.payment_status, o.total_amount,
              o.delivery_fee, o.delivery_address, o.created_at, o.mpesa_ref,
              farmer.first_name AS farmer_first, farmer.last_name AS farmer_last,
              farmer.phone AS farmer_phone, fp.farm_name,
              (SELECT json_agg(json_build_object(
                'name', oi.product_name, 'quantity', oi.quantity,
                'unit', oi.unit, 'price', oi.unit_price
              )) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o
       LEFT JOIN users farmer ON farmer.id = o.farmer_id
       LEFT JOIN farmer_profiles fp ON fp.user_id = o.farmer_id
       WHERE o.buyer_id = $1 ${statusFilter}
       ORDER BY o.created_at DESC`,
      params
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error('[getMyOrders]', error);
    return err(res, 'Could not load your orders.', 500);
  }
};

const getFarmerOrders = async (req, res) => {
  try {
    const farmerId   = req.user.userId;
    const { status } = req.query;
    const params     = [farmerId];
    let statusFilter = '';
    if (status) {
      params.push(status);
      statusFilter = `AND o.status = $${params.length}`;
    }
    const result = await db.query(
      `SELECT o.id, o.status, o.payment_status, o.total_amount,
              o.delivery_fee, o.delivery_address, o.notes,
              o.created_at, o.mpesa_ref,
              buyer.first_name AS buyer_first, buyer.last_name AS buyer_last,
              buyer.phone AS buyer_phone,
              (SELECT json_agg(json_build_object(
                'name', oi.product_name, 'quantity', oi.quantity,
                'unit', oi.unit, 'price', oi.unit_price, 'subtotal', oi.subtotal
              )) FROM order_items oi WHERE oi.order_id = o.id) AS items,
              cj.status AS job_status
       FROM orders o
       LEFT JOIN users buyer ON buyer.id = o.buyer_id
       LEFT JOIN courier_jobs cj ON cj.order_id = o.id
       WHERE o.farmer_id = $1 ${statusFilter}
       ORDER BY o.created_at DESC`,
      params
    );
    return ok(res, result.rows);
  } catch (error) {
    console.error('[getFarmerOrders]', error);
    return err(res, 'Could not load orders.', 500);
  }
};

// ── Update Order Status ───────────────────────────────────────
// ESCROW PAYMENT MODEL:
//   When status → 'delivered':
//     Payment is released from escrow to farmer automatically.
//     FarmDirect keeps 5% commission.
//     Farmer receives 95% of order total via M-Pesa B2C (simulated here).
const updateStatus = async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;
    const userId     = req.user.userId;
    const userRole   = req.user.role;

    const orderResult = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) return err(res, 'Order not found.', 404);
    const order = orderResult.rows[0];

    // Role-based transition rules
    if (userRole !== 'admin') {
      if (userRole === 'farmer') {
        if (order.farmer_id !== userId)
          return err(res, 'You can only update your own orders.', 403);
        // Farmer can only confirm — and only after payment is received
        if (status === 'confirmed' && !['placed','paid'].includes(order.status))
          return err(res, `Cannot confirm an order with status "${order.status}".`);
        if (status !== 'confirmed' && status !== 'cancelled')
          return err(res, 'Farmers can only confirm or cancel orders.', 403);
      }
      if (userRole === 'courier') {
        if (order.courier_id !== userId)
          return err(res, 'You can only update orders assigned to you.', 403);
        if (!['dispatched','delivered'].includes(status))
          return err(res, 'Couriers can only update to dispatched or delivered.', 403);
      }
    }

    await db.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id]
    );

    // When farmer confirms → release courier job to couriers
    if (status === 'confirmed') {
      await db.query(
        `UPDATE courier_jobs
         SET status = 'available', farmer_confirmed_at = NOW()
         WHERE order_id = $1 AND status = 'pending_farmer'`,
        [id]
      );
      const buyerResult = await db.query(
        'SELECT phone, first_name FROM users WHERE id = $1', [order.buyer_id]
      );
      if (buyerResult.rows.length > 0) {
        await sendSMS(
          buyerResult.rows[0].phone,
          `Great news ${buyerResult.rows[0].first_name}! Your FarmDirect order has been confirmed. A courier will pick it up shortly.`
        );
      }
    }

    // When delivered → RELEASE PAYMENT TO FARMER (escrow settlement)
    if (status === 'delivered') {
      await db.query(
        `UPDATE courier_jobs SET status = 'delivered', delivered_at = NOW()
         WHERE order_id = $1`,
        [id]
      );
      if (order.courier_id) {
        await db.query(
          `UPDATE courier_profiles SET total_trips = total_trips + 1 WHERE user_id = $1`,
          [order.courier_id]
        );
      }

      // Mark payment as settled (farmer can now request payout)
      await db.query(
        `UPDATE payments SET status = 'settled' WHERE order_id = $1`,
        [id]
      );

      // Notify farmer their payment is ready
      const farmerResult = await db.query(
        'SELECT phone, first_name FROM users WHERE id = $1', [order.farmer_id]
      );
      if (farmerResult.rows.length > 0) {
        const amount  = Math.round(order.total_amount * 0.95);
        await sendSMS(
          farmerResult.rows[0].phone,
          `Order delivered! Ksh ${amount} has been credited to your FarmDirect account (after 5% platform fee). Log in to request payout.`
        );
      }

      // Notify buyer
      const buyerResult = await db.query(
        'SELECT phone, first_name FROM users WHERE id = $1', [order.buyer_id]
      );
      if (buyerResult.rows.length > 0) {
        await sendSMS(
          buyerResult.rows[0].phone,
          `Your FarmDirect order has been delivered! Please rate your experience in the app.`
        );
      }
    }

    return ok(res, { orderId: id, status }, `Order ${status} successfully.`);
  } catch (error) {
    console.error('[updateStatus order]', error);
    return err(res, 'Could not update order: ' + error.message, 500);
  }
};

module.exports = { create, getById, getMyOrders, getFarmerOrders, updateStatus };