const LeaveRequest = require('../models/LeaveRequest');
const Holiday = require('../models/Holiday');
const User = require('../models/User');
const mongoose = require('mongoose');
const { fail, companyDate } = require('../services/attendancePolicy');
const { activeRule } = require('../services/attendanceRecords');
const { leaveDuration } = require('../services/leavePolicy');
const { reconcileLeave } = require('../services/attendanceAdjustments');

exports.getDuration = async (req, res) => {
  try { res.json({ success: true, duration: await leaveDuration(req.query, await activeRule()) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};

// @desc    Get leave summary and remaining holiday balance
// @route   GET /api/leaves/summary
exports.getLeaveSummary = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const pendingRequests = await LeaveRequest.find({ user: req.user.id, status: 'pending' });
    const approvedRequests = await LeaveRequest.find({ user: req.user.id, status: 'approved' });
    const currentYear = Number(companyDate().slice(0, 4));
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
    const { leaveType, reason } = req.body;
    if (!['casual', 'sick', 'annual', 'unpaid'].includes(leaveType)) fail('Invalid leave category.');
    const duration = await leaveDuration(req.body, await activeRule());
    const user = await User.findById(req.user.id);

    if (leaveType !== 'unpaid') {
      const currentBalance = user.leaveBalances ? user.leaveBalances[leaveType] : 0;
      if (currentBalance < duration.totalDays) {
        return res.status(400).json({
          success: false,
          message: `Insufficient ${leaveType} leave balance. Available: ${currentBalance} days, requested: ${duration.totalDays} days.`,
        });
      }
    }

    const leaveRequest = new LeaveRequest({
      user: req.user.id,
      leaveType,
      ...duration,
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
    if (!['approved', 'rejected'].includes(status)) fail('Review must approve or reject the request.');
    const leaveRequest = await mongoose.connection.transaction(async transaction => {
      const leave = await LeaveRequest.findById(req.params.id).session(transaction);
      if (!leave) fail('Leave request not found.', 404);
      if (leave.status !== 'pending') fail(`Request is already ${leave.status}.`, 409);
      const rule = await activeRule(transaction);
      if (status === 'approved') {
        const duration = await leaveDuration({ startDate: companyDate(leave.startDate), endDate: companyDate(leave.endDate), session: leave.totalDays === 0.5 && leave.session === 'full' ? 'morning' : leave.session, totalDays: leave.totalDays }, rule, transaction);
        Object.assign(leave, duration);
        // Write the applicant before overlap checks, serializing simultaneous approvals/check-ins.
        const balanceKey = 'leaveBalances.' + leave.leaveType;
        const applicant = await User.findOneAndUpdate({ _id: leave.user, isActive: true, ...(leave.leaveType !== 'unpaid' ? { [balanceKey]: { $gte: leave.totalDays } } : {}) },
          { $inc: { attendanceVersion: 1, ...(leave.leaveType !== 'unpaid' ? { [balanceKey]: -leave.totalDays } : {}) } }, { new: true, session: transaction });
        if (!applicant) fail('Employee is inactive or no longer has enough leave balance. Reload before approving.', 409);
        const approved = await LeaveRequest.find({ user: leave.user, status: 'approved', startDate: { $lte: leave.endDate }, endDate: { $gte: leave.startDate } }).session(transaction);
        for (const other of approved) {
          const dates = other.workingDates?.length ? other.workingDates : duration.workingDates.filter(date => date >= companyDate(other.startDate) && date <= companyDate(other.endDate));
          const otherSession = other.totalDays === 0.5 && (!other.session || other.session === 'full') ? 'morning' : other.session || 'full';
          if (dates.some(date => leave.workingDates.includes(date)) && (leave.session === 'full' || otherSession === 'full' || leave.session === otherSession)) fail('Approved leave already covers this date/session.', 409);
        }
      }
      leave.status = status; leave.reviewedBy = req.user.id; leave.reviewComments = typeof reviewComments === 'string' ? reviewComments.slice(0, 1000) : '';
      await leave.save({ session: transaction });
      if (status === 'approved') await reconcileLeave(leave, req.user.id, rule, transaction);
      return leave.toObject();
    });

    res.json({
      success: true,
      message: `Leave request has been ${status}`,
      leaveRequest,
    });
  } catch (error) {
    res.status(error.status || (error.code === 20 ? 503 : 400)).json({ success: false, message: error.code === 20 ? 'Leave approvals require a MongoDB replica set (including MongoDB Atlas) for atomic balance updates.' : error.message });
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
    const { validDate, atCompanyTime } = require('../services/attendancePolicy');
    if (!validDate(req.body.date)) fail('Holiday date must be YYYY-MM-DD.');
    const holiday = new Holiday({ ...req.body, date: atCompanyTime(req.body.date, '00:00'), year: Number(req.body.date.slice(0, 4)) });
    await holiday.save();
    res.status(201).json({ success: true, holiday });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
