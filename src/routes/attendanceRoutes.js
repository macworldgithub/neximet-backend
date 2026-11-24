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
  editAttendance,
  getPhoto,
  repairRecord,
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
router.post('/records/:id/repair', authorize('CEO', 'Super Admin'), repairRecord);
router.get('/roster', authorize('CEO', 'Super Admin'), getDailyRoster);
router.post('/mark-absent', authorize('CEO', 'Super Admin'), markAbsent);
router.post('/mark-present', authorize('CEO', 'Super Admin'), markPresent);
router.post('/edit', authorize('CEO', 'Super Admin'), editAttendance);
router.put('/records/:id', authorize('CEO', 'Super Admin'), editAttendance);

module.exports = router;
