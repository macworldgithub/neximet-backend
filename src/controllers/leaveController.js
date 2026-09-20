const LeaveRequest = require('../models/LeaveRequest');
const Holiday = require('../models/Holiday');
const User = require('../models/User');

// @desc    Get leave summary and remaining holiday balance
// @route   GET /api/leaves/summary
exports.getLeaveSummary = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const pendingRequests = await LeaveRequest.find({ user: req.user.id, status: 'pending' });
    const approvedRequests = await LeaveRequest.find({ user: req.user.id, status: 'approved' });
    const currentYear = new Date().getFullYear();
    const holidays = await Holiday.find({ year: currentYear }).sort({ date: 1 });

    const totalApprovedDays = approvedRequests.reduce((sum, r) => sum + r.totalDays, 0);

    const balances = user.leaveBalances || { casual: 10, sick: 8, annual: 14 };
    const totalRemaining = (balances.casual || 0) + (balances.sick || 0) + (balances.annual || 0);

    res.json({
      success: true,
      leaveBalances: balances,
      totalRemainingHolidays: totalRemaining,
      totalApprovedDays,
      pendingCount: pendingRequests.length,
      upcomingHolidays: holidays,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Apply for leave
// @route   POST /api/leaves/apply
exports.applyLeave = async (req, res) => {
  try {
    const { leaveType, startDate, endDate, totalDays, reason } = req.body;
    const user = await User.findById(req.user.id);

    if (leaveType !== 'unpaid') {
      const currentBalance = user.leaveBalances ? user.leaveBalances[leaveType] : 0;
      if (currentBalance < Number(totalDays)) {
        return res.status(400).json({
          success: false,
          message: `Insufficient ${leaveType} leave balance. Available: ${currentBalance} days, requested: ${totalDays} days.`,
        });
      }
    }

    const leaveRequest = new LeaveRequest({
      user: req.user.id,
      leaveType,
      startDate,
      endDate,
      totalDays: Number(totalDays),
      reason,
      status: 'pending',
    });

    await leaveRequest.save();

    res.status(201).json({
      success: true,
      message: 'Leave application submitted successfully for manager approval',
      leaveRequest,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get leave requests (role-based)
// @route   GET /api/leaves/requests
exports.getLeaveRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};

    const isExecutive = ['CEO', 'Super Admin'].includes(req.user.role);
    if (!isExecutive) {
      filter.user = req.user.id;
    }

    if (status && status !== 'All') {
      filter.status = status;
    }

    const requests = await LeaveRequest.find(filter)
      .populate('user', 'name email department designation leaveBalances')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: requests.length, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Review leave request (Approve/Reject)
// @route   PUT /api/leaves/requests/:id/review
exports.reviewLeaveRequest = async (req, res) => {
  try {
    const { status, reviewComments } = req.body;
    const leaveRequest = await LeaveRequest.findById(req.params.id);

    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Request is already ${leaveRequest.status}` });
    }

    leaveRequest.status = status;
    leaveRequest.reviewedBy = req.user.id;
    leaveRequest.reviewComments = reviewComments || '';

    if (status === 'approved' && leaveRequest.leaveType !== 'unpaid') {
      const applicant = await User.findById(leaveRequest.user);
      if (applicant && applicant.leaveBalances) {
        applicant.leaveBalances[leaveRequest.leaveType] = Math.max(
          0,
          applicant.leaveBalances[leaveRequest.leaveType] - leaveRequest.totalDays
        );
        await applicant.save();
      }
    }

    await leaveRequest.save();

    res.json({
      success: true,
      message: `Leave request has been ${status}`,
      leaveRequest,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get holidays
// @route   GET /api/leaves/holidays
exports.getHolidays = async (req, res) => {
  try {
    const holidays = await Holiday.find().sort({ date: 1 });
    res.json({ success: true, holidays });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Add holiday (CEO only)
// @route   POST /api/leaves/holidays
exports.createHoliday = async (req, res) => {
  try {
    const holiday = new Holiday(req.body);
    await holiday.save();
    res.status(201).json({ success: true, holiday });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
