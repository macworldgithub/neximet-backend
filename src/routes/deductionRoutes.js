const express = require('express');
const router = express.Router();
const {
  getActiveRule,
  updateRule,
  simulateCalculation,
  getMonthlyReport,
} = require('../controllers/deductionController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);

router.get('/rules', getActiveRule);
router.put('/rules', authorize('CEO'), updateRule);
router.post('/simulate', simulateCalculation);
router.get('/monthly-report', authorize('CEO', 'Project Manager'), getMonthlyReport);

module.exports = router;
