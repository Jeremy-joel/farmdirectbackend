const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/payment.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// Public — called by Safaricom servers (no auth)
router.post('/mpesa/callback', controller.mpesaCallback);

// Protected
router.post('/mpesa/stk-push', verifyToken, requireRole('buyer'), controller.stkPush);
router.post('/mpesa/simulate', verifyToken, requireRole('buyer'), controller.simulatePayment);
router.get('/order/:orderId',  verifyToken, controller.getByOrder);

module.exports = router;