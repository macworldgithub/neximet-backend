const express = require('express');
const router = express.Router();
const {
  login,
  getMe,
  getAllUsers,
  createEmployee,
  requestForgotPassword,
  resetCeoPassword,
  getPasswordResetRequests,
  adminResetPassword,
  updateUser,
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

// Public auth routes
router.post('/login', login);
router.post('/forgot-password', requestForgotPassword);
router.post('/ceo-reset-password', resetCeoPassword);

// Authenticated user routes
router.get('/me', protect, getMe);
router.get('/users', protect, getAllUsers);

// Super Admin / CEO protected routes
router.post('/users', protect, authorize('CEO', 'Super Admin'), createEmployee);
router.put('/users/:id', protect, authorize('CEO', 'Super Admin'), updateUser);
router.get('/password-requests', protect, authorize('CEO', 'Super Admin'), getPasswordResetRequests);
router.post('/admin-reset-password', protect, authorize('CEO', 'Super Admin'), adminResetPassword);

module.exports = router;
