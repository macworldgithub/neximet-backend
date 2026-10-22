const notifications = require('../services/notifications');
const activity = require('../services/activityNotifications');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const mongoose = require('mongoose');
const { jwtSecret } = require('../services/authSecret');
const { fail } = require('../services/attendancePolicy');
const { dailyWage: salaryDailyWage } = require('../services/attendancePolicy');
const { protectPayroll } = require('../services/payrollPrivacy');
function salaryPermissions(req) {
  if (req.user.role !== 'CEO' && ['baseSalary', 'dailyWage', 'expectedPay'].some(key => req.body[key] !== undefined)) fail('Only the CEO can view or change employee compensation.', 403);
  if (req.user.role !== 'CEO' && req.body.role === 'CEO') fail('Only the CEO can assign the CEO role.', 403);
}
const finiteAmount = (value, label, nullable = false) => {
  if (nullable && (value == null || value === '')) return null;
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) || Number(value) < 0) fail(`${label} must be a finite, non-negative number.`);
  return Number(value);
};
const balancesFrom = (input, previous = { casual: 10, sick: 8, annual: 14 }) => {
  if (typeof input !== 'object' || !input || Array.isArray(input)) fail('Leave balances must be an object.');
  return Object.fromEntries(['casual', 'sick', 'annual'].map(key => [key, input[key] === undefined ? previous[key] : finiteAmount(input[key], `${key} leave balance`)]));
};

const generateToken = (id) => {
  return jwt.sign({ id }, jwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};



// @desc    Auth user & get token
// @route   POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide an email and password' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = generateToken(user._id);
    req.user = user;
    protectPayroll(req, res);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        designation: user.designation,
        baseSalary: user.baseSalary,
        dailyWage: user.dailyWage,
        leaveBalances: user.leaveBalances,
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        designation: user.designation,
        baseSalary: user.baseSalary,
        dailyWage: user.dailyWage,
        leaveBalances: user.leaveBalances,
        phone: user.phone,
        joinDate: user.joinDate,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all users (for assignment & team directory)
// @route   GET /api/auth/users
exports.getAllUsers = async (req, res) => {
  try {
    const { department, role } = req.query;
    const filter = {};
    if (department && department !== 'All') filter.department = department;
    if (role && role !== 'All') filter.role = role;

    const users = await User.find(filter)
      .select('-password')
      .populate('reportsTo', 'name email role designation')
      .sort({ name: 1 });
    res.json({ success: true, count: users.length, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new employee (Super Admin / CEO only)
// @route   POST /api/auth/users
exports.createEmployee = async (req, res) => {
  try {
    salaryPermissions(req);
    const {
      name,
      email,
      password,
      role,
      department,
      designation,
      baseSalary,
      dailyWage,
      phone,
      joinDate,
      leaveBalances,
      reportsTo,
    } = req.body;

    if (!name || !email || !password || !department) {
      return res.status(400).json({
        success: false,
        message: 'Name, corporate email, password, and department are required.',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long.',
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'An employee with this corporate email already exists in the system.',
      });
    }

    const salary = finiteAmount(baseSalary, 'Base salary', true);
    const wage = salary === null ? null : salaryDailyWage({ baseSalary: salary });
    if (dailyWage != null && dailyWage !== '' && Math.abs(finiteAmount(dailyWage, 'Daily wage') - (wage || 0)) > 0.001) fail('Daily wage must equal base salary divided by 22.');
    const leaves = leaveBalances === undefined ? { casual: 10, sick: 8, annual: 14 } : balancesFrom(leaveBalances);

    const newUser = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      role: role || 'Team Member',
      department,
      designation: designation || 'Specialist',
      baseSalary: salary,
      dailyWage: wage,
      phone: phone || '+92 (300) 123-4567',
      joinDate: joinDate ? new Date(joinDate) : new Date(),
      leaveBalances: leaves,
      reportsTo: reportsTo || null,
    });

    const userObj = newUser.toObject();
    delete userObj.password;

    res.status(201).json({
      success: true,
      message: 'Employee created successfully.',
      user: userObj,
    });
  } catch (error) {
    res.status(error.status || (['ValidationError', 'CastError'].includes(error.name) ? 400 : 500)).json({ success: false, message: error.message });
  }
};

// @desc    Update employee profile & salary (CEO / Super Admin only)
// @route   PUT /api/auth/users/:id
exports.updateUser = async (req, res) => {
  try {
    salaryPermissions(req);
    const { id } = req.params;
    const updatedUser = await mongoose.connection.transaction(async transaction => {
      const user = await User.findOneAndUpdate({ _id: id }, { $inc: { attendanceVersion: 1 } }, { new: true, session: transaction }).select('+employmentGaps +attendanceTrackingFrom');

      if (!user) {
        fail('Employee not found.', 404);
      }
      if (req.user.role !== 'CEO' && user.role === 'CEO') fail('Only a CEO can modify a CEO account.', 403);

      const {
        name,
        role,
        department,
        designation,
        baseSalary,
        dailyWage,
        phone,
        leaveBalances,
        reportsTo,
        isActive,
      } = req.body;

      const snapshot = value => value === '' || value == null ? null : Number.isFinite(Number(value)) ? Number(value) : String(value);
      for (const key of ['baseSalary', 'dailyWage']) if (req.body.expectedPay?.[key] !== undefined && snapshot(key === 'dailyWage' ? user.baseSalary == null ? null : salaryDailyWage(user) : user[key]) !== snapshot(req.body.expectedPay[key])) fail('Employee pay changed since this form opened. Reload before saving.', 409);
      for (const key of ['casual', 'sick', 'annual']) if (req.body.expectedLeaveBalances?.[key] !== undefined && snapshot(user.leaveBalances?.[key]) !== snapshot(req.body.expectedLeaveBalances[key])) fail('Leave balance changed since this form opened. Reload before saving.', 409);

      if (name) user.name = name.trim();
      if (role) user.role = role;
      if (department) user.department = department;
      if (designation) user.designation = designation.trim();
      if (phone) user.phone = phone.trim();
      if (typeof isActive === 'boolean') {
        if (!isActive && user.isActive) user.deactivatedAt = new Date();
        if (isActive && !user.isActive) {
          if (user.deactivatedAt) user.employmentGaps = [...(user.employmentGaps || []), { start: user.deactivatedAt, end: new Date() }];
          else user.attendanceTrackingFrom = new Date();
          user.deactivatedAt = undefined;
        }
        user.isActive = isActive;
      }

      if (baseSalary !== undefined) {
        user.baseSalary = finiteAmount(baseSalary, 'Base salary', true);
      }

      const derivedWage = user.baseSalary == null ? null : salaryDailyWage(user);
      if (dailyWage != null && dailyWage !== '' && Math.abs(finiteAmount(dailyWage, 'Daily wage') - (derivedWage || 0)) > 0.001) fail('Daily wage must equal base salary divided by 22.');
      user.dailyWage = derivedWage;

      if (leaveBalances !== undefined) user.leaveBalances = balancesFrom(leaveBalances, user.leaveBalances || { casual: 10, sick: 8, annual: 14 });

      if (reportsTo !== undefined) {
        user.reportsTo = reportsTo || null;
      }

      await user.save({ session: transaction });

      return User.findById(id).session(transaction)
        .select('-password')
        .populate('reportsTo', 'name email role designation');
    });

    await notifications.safely({ key: `account:${updatedUser._id}:${updatedUser.updatedAt?.getTime()}`, users: [updatedUser._id], actor: req.user.id, kind: 'account', title: 'Your employee account was updated', body: 'Your administrator updated your account details. Review your profile or contact your administrator.', url: '/dashboard' });
    res.json({
      success: true,
      message: 'Employee updated successfully.',
      user: updatedUser,
    });
  } catch (error) {
    res.status(error.status || (error.code === 20 ? 503 : ['ValidationError', 'CastError'].includes(error.name) ? 400 : 500)).json({ success: false, message: error.code === 20 ? 'Employee compensation updates require MongoDB Atlas or a replica set.' : error.message });
  }
};

// @desc    Request password reset (notification to Admin if not CEO)
// @route   POST /api/auth/forgot-password
exports.requestForgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Please provide your corporate email address.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No employee account found with this corporate email address.',
      });
    }

    // If CEO, provide master recovery directive
    if (user.role === 'CEO') {
      return res.json({
        success: true,
        isCeo: true,
        message: 'CEO master account identified. Please verify using your Master Recovery Passphrase.',
      });
    }

    if (user.passwordResetRequest?.status === 'Pending') return res.json({ success: true, isCeo: false, message: 'Your password reset request is already awaiting administrator review.' });
    // For all other roles: Notify admin via user.passwordResetRequest
    user.passwordResetRequest = {
      status: 'Pending',
      requestedAt: new Date(),
    };
    await user.save();

    await activity.executiveEvent({ key: `password-request:${user._id}:${user.passwordResetRequest.requestedAt.getTime()}`, title: 'Password reset request awaiting review', body: 'An employee requested help signing in. Open the employee directory to review requests.', url: '/employees' });
    res.json({
      success: true,
      isCeo: false,
      message: 'A password reset request has been forwarded to the Super Admin. Your administrator will reset your credentials and provide them to you.',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    CEO Master Emergency Password Reset
// @route   POST /api/auth/ceo-reset-password
exports.resetCeoPassword = async (req, res) => {
  try {
    const { email, masterKey, newPassword } = req.body;

    if (!email || !masterKey || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, Master Recovery Key, and new password are required.',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long.',
      });
    }

    const validKey = process.env.CEO_MASTER_KEY;
    if (!validKey) return res.status(503).json({ success: false, message: 'CEO password recovery is not configured. Contact your system administrator.' });
    if (masterKey !== validKey) {
      return res.status(401).json({
        success: false,
        message: 'Invalid Master Recovery Key. Verification failed.',
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim(), role: 'CEO' });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'CEO account not found with this email.',
      });
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'CEO password has been successfully reset. You may now sign in.',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get password reset requests (Super Admin / CEO only)
// @route   GET /api/auth/password-requests
exports.getPasswordResetRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {
      'passwordResetRequest.status': status || 'Pending',
      ...(req.user.role !== 'CEO' ? { role: { $ne: 'CEO' } } : {}),
    };

    const users = await User.find(filter)
      .select('name email role department designation phone passwordResetRequest')
      .sort({ 'passwordResetRequest.requestedAt': -1 });

    const requests = users.map((u) => ({
      _id: u._id,
      userId: u._id,
      user: {
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        department: u.department,
        designation: u.designation,
        phone: u.phone,
      },
      name: u.name,
      email: u.email,
      role: u.role,
      department: u.department,
      status: u.passwordResetRequest?.status || 'Pending',
      requestedAt: u.passwordResetRequest?.requestedAt || new Date(),
    }));

    const pendingCount = await User.countDocuments({
      'passwordResetRequest.status': 'Pending',
    });

    res.json({
      success: true,
      pendingCount,
      count: requests.length,
      requests,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Admin reset employee password & mark request resolved
// @route   POST /api/auth/admin-reset-password
exports.adminResetPassword = async (req, res) => {
  try {
    const { userId, newPassword } = req.body;

    if (!userId || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'User ID and new password are required.',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long.',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found.',
      });
    }
    if (req.user.role !== 'CEO' && user.role === 'CEO') return res.status(403).json({ success: false, message: 'Only a CEO can reset another CEO account.' });

    user.password = newPassword;
    user.passwordResetRequest = {
      status: 'Completed',
      resolvedAt: new Date(),
      resolvedBy: req.user.id,
    };
    await user.save();

    await notifications.safely({ key: `password-reset:${user._id}:${user.passwordResetRequest.resolvedAt.getTime()}`, users: [user._id], actor: req.user.id, kind: 'account', title: 'Your password was reset by an administrator', body: 'Contact your administrator if you did not request this change. Passwords are never included in notifications.', url: '/dashboard' });
    res.json({
      success: true,
      message: `Password for ${user.name} has been successfully updated.`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update self profile (phone and password)
// @route   PUT /api/auth/profile
exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    const { phone, currentPassword, newPassword } = req.body;

    if (phone !== undefined) {
      user.phone = phone.trim();
    }

    if (newPassword) {
      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 6 characters long.',
        });
      }

      if (currentPassword) {
        const isMatch = await user.matchPassword(currentPassword);
        if (!isMatch) {
          return res.status(400).json({
            success: false,
            message: 'Current password is incorrect.',
          });
        }
      }

      user.password = newPassword;

      if (user.passwordResetRequest && user.passwordResetRequest.status === 'Pending') {
        user.passwordResetRequest = {
          status: 'Completed',
          resolvedAt: new Date(),
          resolvedBy: user._id,
        };
      }
    }

    await user.save();

    const updatedUser = await User.findById(user._id)
      .select('-password')
      .populate('reportsTo', 'name email role designation');

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        department: updatedUser.department,
        designation: updatedUser.designation,
        baseSalary: updatedUser.baseSalary,
        dailyWage: updatedUser.dailyWage,
        leaveBalances: updatedUser.leaveBalances,
        phone: updatedUser.phone,
        joinDate: updatedUser.joinDate,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
