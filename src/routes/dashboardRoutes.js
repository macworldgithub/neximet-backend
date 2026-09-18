const express = require('express');
const router = express.Router();
const { getStats, getAdminNotifications } = require('../controllers/dashboardController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);
router.get('/stats', getStats);
router.get('/admin-notifications', authorize('CEO', 'Super Admin'), getAdminNotifications);

module.exports = router;
