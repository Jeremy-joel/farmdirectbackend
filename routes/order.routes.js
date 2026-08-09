const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/order.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

router.post('/',           verifyToken, requireRole('buyer'),                    controller.create);
router.get('/my/buyer',    verifyToken, requireRole('buyer'),                    controller.getMyOrders);
router.get('/my/farmer',   verifyToken, requireRole('farmer'),                   controller.getFarmerOrders);
router.get('/:id',         verifyToken,                                          controller.getById);
router.patch('/:id/status',verifyToken, requireRole('farmer','courier','admin'), controller.updateStatus);

module.exports = router;