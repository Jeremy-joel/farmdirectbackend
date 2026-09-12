const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/user.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/profile',               controller.getProfile);
router.put('/profile',               controller.updateProfile);

// Wallet routes
router.get('/wallet',                controller.getWallet);
router.get('/wallet/transactions',   controller.getWalletTransactions);
router.post('/wallet/withdraw',      controller.requestWithdrawal);

module.exports = router;