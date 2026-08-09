const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/user.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/profile',  controller.getProfile);
router.put('/profile',  controller.updateProfile);

module.exports = router;