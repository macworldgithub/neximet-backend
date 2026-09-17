const express = require('express');
const router = express.Router();
const {
  getLeaveSummary,
  applyLeave,
  getLeaveRequests,
  reviewLeaveRequest,
  getHolidays,
  createHoliday,
} = require('../controllers/leaveController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);

router.get('/summary', getLeaveSummary);
router.post('/apply', applyLeave);
router.get('/requests', getLeaveRequests);
router.put('/requests/:id/review', authorize('CEO', 'Project Manager', 'Team Manager'), reviewLeaveRequest);
router.get('/holidays', getHolidays);
router.post('/holidays', authorize('CEO'), createHoliday);

module.exports = router;
