const jwt = require('jsonwebtoken');
const User = require('../models/User');

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'neximet_super_secret_jwt_key_2026_enterprise_portal', {
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
    res.status(500).json({ success: false, message: error.message });
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

    const salary = (baseSalary !== undefined && baseSalary !== null && baseSalary !== '') ? Number(baseSalary) : null;
    const wage = (dailyWage !== undefined && dailyWage !== null && dailyWage !== '') ? Number(dailyWage) : (salary ? Math.round(salary / 30) : null);
    const leaves = leaveBalances || { casual: 10, sick: 8, annual: 14 };

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
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update employee profile & salary (CEO / Super Admin only)
// @route   PUT /api/auth/users/:id
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

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

    if (name) user.name = name.trim();
    if (role) user.role = role;
    if (department) user.department = department;
    if (designation) user.designation = designation.trim();
    if (phone) user.phone = phone.trim();
    if (typeof isActive === 'boolean') user.isActive = isActive;

    if (baseSalary !== undefined) {
      user.baseSalary = (baseSalary === null || baseSalary === '') ? null : Number(baseSalary);
    }

    if (dailyWage !== undefined) {
      user.dailyWage = (dailyWage === null || dailyWage === '') ? null : Number(dailyWage);
    } else if (user.baseSalary && !user.dailyWage) {
      user.dailyWage = Math.round(user.baseSalary / 30);
    }

    if (leaveBalances) {
      user.leaveBalances = {
        casual: Number(leaveBalances.casual) >= 0 ? Number(leaveBalances.casual) : (user.leaveBalances?.casual ?? 10),
        sick: Number(leaveBalances.sick) >= 0 ? Number(leaveBalances.sick) : (user.leaveBalances?.sick ?? 8),
        annual: Number(leaveBalances.annual) >= 0 ? Number(leaveBalances.annual) : (user.leaveBalances?.annual ?? 14),
      };
    }

    if (reportsTo !== undefined) {
      user.reportsTo = reportsTo || null;
    }

    await user.save();

    const updatedUser = await User.findById(id)
      .select('-password')
      .populate('reportsTo', 'name email role designation');

    res.json({
      success: true,
      message: 'Employee updated successfully.',
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

    // For all other roles: Notify admin via user.passwordResetRequest
    user.passwordResetRequest = {
      status: 'Pending',
      requestedAt: new Date(),
    };
    await user.save();

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

    const validKey = process.env.CEO_MASTER_KEY || 'NEXIMET-CEO-2026-RECOVERY';
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

    user.password = newPassword;
    user.passwordResetRequest = {
      status: 'Completed',
      resolvedAt: new Date(),
      resolvedBy: req.user.id,
    };
    await user.save();

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
