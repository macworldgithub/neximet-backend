const express = require('express');
const router = express.Router();
const {
  checkIn,
  checkOut,
  getTodayStatus,
  getHistory,
  getDailyRoster,
  markAbsent,
  markPresent,
} = require('../controllers/attendanceController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);

router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.get('/today', getTodayStatus);
router.get('/history', getHistory);
router.get('/roster', authorize('CEO', 'Super Admin'), getDailyRoster);
router.post('/mark-absent', authorize('CEO', 'Super Admin'), markAbsent);
router.post('/mark-present', authorize('CEO', 'Super Admin'), markPresent);

module.exports = router;
