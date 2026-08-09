const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/courier.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

router.use(verifyToken, requireRole('courier','admin'));

router.get('/jobs/available',       controller.getAvailableJobs);
router.get('/jobs/my',              controller.getMyCourierJobs);
router.post('/jobs/:jobId/accept',  controller.acceptJob);
router.patch('/jobs/:jobId/deliver',controller.markDelivered);

module.exports = router;