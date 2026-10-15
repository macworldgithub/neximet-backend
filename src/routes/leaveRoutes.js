const express = require('express');
const router = express.Router();
const {
  getLeaveSummary,
  applyLeave,
  getLeaveRequests,
  reviewLeaveRequest,
  getHolidays,
  createHoliday,
  getDuration,
} = require('../controllers/leaveController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/summary', getLeaveSummary);
router.get('/duration', getDuration);
router.post('/apply', applyLeave);
router.get('/requests', getLeaveRequests);
router.put('/requests/:id/review', authorize('CEO', 'Super Admin'), reviewLeaveRequest);
router.get('/holidays', getHolidays);
router.post('/holidays', authorize('CEO', 'Super Admin'), createHoliday);

module.exports = router;
