const Attendance = require('../models/Attendance');
const DeductionRule = require('../models/DeductionRule');
const User = require('../models/User');

const getTodayString = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper: Calculate late minutes and deduction
const calculateLateAndDeductions = async (checkInDate, user, customRule = null) => {
  const rule = customRule || (await DeductionRule.findOne({ isActive: true })) || {
    shiftStartTime: '09:00',
    gracePeriodMinutes: 15,
    lateThresholdMinutes: 30,
    deductionType: 'percentage',
    percentageDeductionRate: 5,
    fixedDeductionAmount: 1000,
    halfDayThresholdMinutes: 60,
    consecutiveLateThreshold: 3,
    consecutivePenaltyMultiplier: 1.5,
  };

  const [shiftHour, shiftMinute] = (rule.shiftStartTime || '09:00').split(':').map(Number);
  const shiftStartDate = new Date(checkInDate);
  shiftStartDate.setHours(shiftHour, shiftMinute, 0, 0);

  const diffMs = checkInDate.getTime() - shiftStartDate.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  let isLate = false;
  let minutesLate = 0;
  let status = 'present';
  let deductionAmount = 0;
  let deductionPercentage = 0;
  let deductionReason = '';

  const dailyWage = user.dailyWage || (user.baseSalary ? Math.round(user.baseSalary / 30) : 4000);

  if (diffMinutes <= 0) {
    // On-time or early
    status = 'present';
    isLate = false;
    minutesLate = 0;
  } else if (diffMinutes <= rule.gracePeriodMinutes) {
    // Within grace period
    status = 'present';
    isLate = false;
    minutesLate = diffMinutes;
    deductionReason = `Arrival within ${rule.gracePeriodMinutes} mins grace window (${diffMinutes}m). No deduction applied.`;
  } else {
    // Late arrival
    isLate = true;
    minutesLate = diffMinutes;

    if (diffMinutes >= rule.halfDayThresholdMinutes) {
      status = 'half_day';
      deductionPercentage = 50;
      deductionAmount = Math.round(dailyWage * 0.5);
      deductionReason = `Late by ${diffMinutes} mins (exceeded ${rule.halfDayThresholdMinutes}m threshold -> Half-Day 50% wage deduction)`;
    } else {
      status = 'late';
      if (rule.deductionType === 'percentage') {
        deductionPercentage = rule.percentageDeductionRate;
        deductionAmount = Math.round((dailyWage * rule.percentageDeductionRate) / 100);
        deductionReason = `Late by ${diffMinutes} mins (exceeded ${rule.gracePeriodMinutes}m grace -> ${rule.percentageDeductionRate}% daily wage deduction)`;
      } else {
        deductionAmount = rule.fixedDeductionAmount;
        deductionPercentage = Math.round((rule.fixedDeductionAmount / dailyWage) * 100);
        deductionReason = `Late by ${diffMinutes} mins (exceeded ${rule.gracePeriodMinutes}m grace -> Fixed deduction of PKR ${rule.fixedDeductionAmount})`;
      }
    }

    // Check consecutive late count in current month for this user
    const currentMonthPrefix = getTodayString(checkInDate).substring(0, 7); // YYYY-MM
    const lateCountThisMonth = await Attendance.countDocuments({
      user: user._id,
      date: { $regex: `^${currentMonthPrefix}` },
      isLate: true,
    });

    if (lateCountThisMonth >= (rule.consecutiveLateThreshold || 3)) {
      const multiplier = rule.consecutivePenaltyMultiplier || 1.5;
      deductionAmount = Math.round(deductionAmount * multiplier);
      deductionPercentage = Math.round(deductionPercentage * multiplier);
      deductionReason += ` [Warning: ${lateCountThisMonth + 1}th late arrival this month. Applied ${multiplier}x repeat penalty]`;
    }
  }

  return {
    isLate,
    minutesLate,
    status,
    deductionAmount,
    deductionPercentage,
    deductionReason,
  };
};

// @desc    Mark Check-In
// @route   POST /api/attendance/check-in
exports.checkIn = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const { customTime, notes } = req.body; // allows testing simulated check-in time

    const checkInDate = customTime ? new Date(customTime) : new Date();
    const todayStr = getTodayString(checkInDate);

    // Check if already checked in today
    let record = await Attendance.findOne({ user: user._id, date: todayStr });
    if (record && record.checkIn) {
      return res.status(400).json({
        success: false,
        message: `Already checked in today at ${new Date(record.checkIn).toLocaleTimeString()}`,
        attendance: record,
      });
    }

    const lateCalc = await calculateLateAndDeductions(checkInDate, user);

    if (!record) {
      record = new Attendance({
        user: user._id,
        date: todayStr,
        checkIn: checkInDate,
        status: lateCalc.status,
        isLate: lateCalc.isLate,
        minutesLate: lateCalc.minutesLate,
        deductionAmount: lateCalc.deductionAmount,
        deductionPercentage: lateCalc.deductionPercentage,
        deductionReason: lateCalc.deductionReason,
        notes: notes || '',
        ipAddress: req.ip || '127.0.0.1',
      });
    } else {
      record.checkIn = checkInDate;
      record.status = lateCalc.status;
      record.isLate = lateCalc.isLate;
      record.minutesLate = lateCalc.minutesLate;
      record.deductionAmount = lateCalc.deductionAmount;
      record.deductionPercentage = lateCalc.deductionPercentage;
      record.deductionReason = lateCalc.deductionReason;
      if (notes) record.notes = notes;
    }

    await record.save();

    res.status(201).json({
      success: true,
      message: record.isLate ? `Checked in with late mark (${record.minutesLate} mins late)` : 'Checked in on time!',
      attendance: record,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Mark Check-Out
// @route   POST /api/attendance/check-out
exports.checkOut = async (req, res) => {
  try {
    const todayStr = getTodayString();
    const record = await Attendance.findOne({ user: req.user.id, date: todayStr });

    if (!record || !record.checkIn) {
      return res.status(400).json({ success: false, message: 'No check-in record found for today' });
    }

    const checkOutDate = new Date();
    record.checkOut = checkOutDate;

    // Calculate total hours worked
    const diffMs = checkOutDate.getTime() - new Date(record.checkIn).getTime();
    record.totalWorkHours = Number((diffMs / (1000 * 60 * 60)).toFixed(2));

    await record.save();

    res.json({
      success: true,
      message: `Checked out successfully. Total hours: ${record.totalWorkHours}h`,
      attendance: record,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current user's today attendance status
// @route   GET /api/attendance/today
exports.getTodayStatus = async (req, res) => {
  try {
    const todayStr = getTodayString();
    const record = await Attendance.findOne({ user: req.user.id, date: todayStr });
    const user = await User.findById(req.user.id);

    res.json({
      success: true,
      attendance: record,
      leaveBalances: user ? user.leaveBalances : { casual: 0, sick: 0, annual: 0 },
      dailyWage: user ? user.dailyWage : 4000,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get attendance history (self or all if CEO/Manager)
// @route   GET /api/attendance/history
exports.getHistory = async (req, res) => {
  try {
    const { userId, month, department, status } = req.query;
    const filter = {};

    // Non-CEO/Manager can only view their own
    if (req.user.role === 'Team Member') {
      filter.user = req.user.id;
    } else if (userId && userId !== 'all') {
      filter.user = userId;
    }

    if (month) {
      filter.date = { $regex: `^${month}` }; // e.g. "2026-09"
    }

    if (status && status !== 'All') {
      filter.status = status;
    }

    const records = await Attendance.find(filter)
      .populate('user', 'name email department designation dailyWage')
      .sort({ date: -1, checkIn: -1 })
      .limit(100);

    // If department filter requested, filter populated user
    let filteredRecords = records;
    if (department && department !== 'All') {
      filteredRecords = records.filter((r) => r.user && r.user.department === department);
    }

    // Summary stats
    const totalRecords = filteredRecords.length;
    const lateRecords = filteredRecords.filter((r) => r.isLate).length;
    const totalDeductions = filteredRecords.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);

    res.json({
      success: true,
      count: totalRecords,
      lateCount: lateRecords,
      totalDeductions,
      records: filteredRecords,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get daily roster for all employees
// @route   GET /api/attendance/roster
exports.getDailyRoster = async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayString();
    const users = await User.find({ isActive: true }).select('name email department designation dailyWage');
    const records = await Attendance.find({ date: dateStr });

    const recordMap = {};
    records.forEach((r) => {
      recordMap[r.user.toString()] = r;
    });

    const roster = users.map((u) => {
      const rec = recordMap[u._id.toString()];
      return {
        user: u,
        date: dateStr,
        checkedIn: !!(rec && rec.checkIn),
        checkIn: rec ? rec.checkIn : null,
        checkOut: rec ? rec.checkOut : null,
        status: rec ? rec.status : 'not_checked_in',
        isLate: rec ? rec.isLate : false,
        minutesLate: rec ? rec.minutesLate : 0,
        deductionAmount: rec ? rec.deductionAmount : 0,
        totalWorkHours: rec ? rec.totalWorkHours : 0,
        notes: rec ? rec.notes : '',
      };
    });

    res.json({ success: true, date: dateStr, roster });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
