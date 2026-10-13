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
  getPhoto,
} = require('../controllers/attendanceController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.get('/today', getTodayStatus);
router.get('/history', getHistory);
router.get('/records/:id/photo', getPhoto);
router.get('/roster', authorize('CEO', 'Super Admin'), getDailyRoster);
router.post('/mark-absent', authorize('CEO', 'Super Admin'), markAbsent);
router.post('/mark-present', authorize('CEO', 'Super Admin'), markPresent);

module.exports = router;
