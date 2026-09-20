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

// Helper: Calculate Haversine distance in meters between two GPS coordinates
const calculateDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth's radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
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
exports.checkIn = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const { customTime, notes, latitude, longitude, bypassGeofence, deviceId, deviceType, browser, photo } = req.body;

    const checkInDate = customTime ? new Date(customTime) : new Date();
    const todayStr = getTodayString(checkInDate);

    // 1. Check if already checked in today
    let record = await Attendance.findOne({ user: user._id, date: todayStr });
    if (record && record.checkIn) {
      return res.status(400).json({
        success: false,
        message: `Already checked in today at ${new Date(record.checkIn).toLocaleTimeString()}`,
        attendance: record,
      });
    }

    // 2. Fetch active policy, office location rules, and anti-proxy settings
    const rule = (await DeductionRule.findOne({ isActive: true })) || {
      shiftStartTime: '09:00',
      gracePeriodMinutes: 15,
      lateThresholdMinutes: 30,
      officeLocation: {
        officeAddress: 'Neximet Head Office, Karachi',
        latitude: 24.8607,
        longitude: 67.0011,
        radiusMeters: 200,
        enforceLocation: true,
      },
      antiProxySettings: {
        enforceSingleDevicePerDay: true,
        requireSelfieVerification: true,
      },
    };

    const antiProxy = rule.antiProxySettings || {
      enforceSingleDevicePerDay: true,
      requireSelfieVerification: true,
    };

    // 3. Anti-Proxy Verification: Device Fingerprint Lockout
    // Prevents an employee who arrives early from clocking in for their peers from the same physical device/browser
    if (antiProxy.enforceSingleDevicePerDay && deviceId) {
      const conflictingAttendance = await Attendance.findOne({
        date: todayStr,
        'deviceInfo.deviceId': deviceId,
        user: { $ne: user._id },
      }).populate('user', 'name email');

      if (conflictingAttendance) {
        return res.status(403).json({
          success: false,
          message: `Anti-Proxy Security Alert: This physical device has already been used to clock in for another employee (${conflictingAttendance.user?.name || 'Another User'}) today. Multiple employee check-ins from the same device are strictly prohibited to prevent buddy-punching.`,
          isProxyBlocked: true,
          conflictingUser: conflictingAttendance.user?.name,
        });
      }
    }

    // 4. Anti-Proxy Verification: Live Selfie Photo
    if (antiProxy.requireSelfieVerification && !photo) {
      return res.status(400).json({
        success: false,
        message: 'Selfie verification required: A live webcam photo snapshot must be captured to verify your physical presence and identity.',
        requireSelfie: true,
      });
    }

    const officeLoc = rule.officeLocation || {
      officeAddress: 'Neximet Head Office, Karachi',
      latitude: 24.8607,
      longitude: 67.0011,
      radiusMeters: 200,
      enforceLocation: true,
    };

    let locationData = {
      latitude: latitude !== undefined && latitude !== null ? Number(latitude) : null,
      longitude: longitude !== undefined && longitude !== null ? Number(longitude) : null,
      distanceMeters: null,
      isVerified: false,
      officeAddress: officeLoc.officeAddress || 'Neximet Head Office',
    };

    // 5. Geofence Verification (Ensure employee is physically at the office)
    if (officeLoc.enforceLocation && !bypassGeofence) {
      if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
        return res.status(400).json({
          success: false,
          message: 'Location verification required: Please enable device location/GPS to check in from the office premises.',
          officeLocation: officeLoc,
        });
      }

      const userLat = Number(latitude);
      const userLng = Number(longitude);

      if (isNaN(userLat) || isNaN(userLng)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid GPS coordinates received for location verification.',
        });
      }

      const distanceMeters = calculateDistanceMeters(
        userLat,
        userLng,
        officeLoc.latitude,
        officeLoc.longitude
      );

      locationData.distanceMeters = distanceMeters;

      if (distanceMeters > officeLoc.radiusMeters) {
        return res.status(403).json({
          success: false,
          message: `Check-in rejected: You are ${distanceMeters}m away from the office (${officeLoc.officeAddress}). Check-in is only allowed within ${officeLoc.radiusMeters}m radius of the office.`,
          distanceMeters,
          allowedRadius: officeLoc.radiusMeters,
          officeAddress: officeLoc.officeAddress,
          isOutOfOffice: true,
        });
      }

      locationData.isVerified = true;
    } else {
      locationData.isVerified = true;
    }

    const lateCalc = await calculateLateAndDeductions(checkInDate, user, rule);

    const deviceInfoData = {
      deviceId: deviceId || '',
      deviceType: deviceType || 'Desktop/Browser',
      browser: browser || '',
      userAgent: req.headers['user-agent'] || '',
    };

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
        location: locationData,
        deviceInfo: deviceInfoData,
        photo: photo || '',
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
      record.location = locationData;
      record.deviceInfo = deviceInfoData;
      if (photo) record.photo = photo;
      if (notes) record.notes = notes;
    }

    await record.save();

    res.status(201).json({
      success: true,
      message: record.isLate
        ? `Checked in with late mark (${record.minutesLate} mins late) [Office Location & Anti-Proxy Verified]`
        : 'Checked in on time! [Office Location & Anti-Proxy Verified]',
      attendance: record,
      distanceFromOffice: locationData.distanceMeters,
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
    const rule = await DeductionRule.findOne({ isActive: true });

    const officeLocation = rule?.officeLocation || {
      officeAddress: 'Neximet Head Office, Karachi',
      latitude: 24.8607,
      longitude: 67.0011,
      radiusMeters: 200,
      enforceLocation: true,
    };

    const antiProxySettings = rule?.antiProxySettings || {
      enforceSingleDevicePerDay: true,
      requireSelfieVerification: true,
    };

    res.json({
      success: true,
      attendance: record,
      officeLocation,
      antiProxySettings,
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

    // Non-CEO/Super Admin can only view their own
    const isExecutive = ['CEO', 'Super Admin'].includes(req.user.role);
    if (!isExecutive) {
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
        photo: rec ? rec.photo : '',
        deviceInfo: rec ? rec.deviceInfo : null,
        location: rec ? rec.location : null,
        notes: rec ? rec.notes : '',
      };
    });

    res.json({ success: true, date: dateStr, roster });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
