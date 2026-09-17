const DeductionRule = require('../models/DeductionRule');
const Attendance = require('../models/Attendance');
const User = require('../models/User');

// @desc    Get active deduction configuration
// @route   GET /api/deductions/rules
exports.getActiveRule = async (req, res) => {
  try {
    let rule = await DeductionRule.findOne({ isActive: true });
    if (!rule) {
      rule = await DeductionRule.create({
        title: 'Neximet Standard Attendance & Deduction Policy',
        shiftStartTime: '09:00',
        shiftEndTime: '18:00',
        gracePeriodMinutes: 15,
        lateThresholdMinutes: 30,
        deductionType: 'percentage',
        percentageDeductionRate: 5,
        fixedDeductionAmount: 1000,
        halfDayThresholdMinutes: 60,
        consecutiveLateThreshold: 3,
        consecutivePenaltyMultiplier: 1.5,
        currencySymbol: 'PKR',
      });
    }
    res.json({ success: true, rule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update deduction configuration (CEO only)
// @route   PUT /api/deductions/rules
exports.updateRule = async (req, res) => {
  try {
    let rule = await DeductionRule.findOne({ isActive: true });
    if (!rule) {
      rule = new DeductionRule(req.body);
    } else {
      Object.assign(rule, req.body);
    }
    rule.updatedBy = req.user.id;
    await rule.save();

    res.json({ success: true, message: 'Deduction rules updated successfully', rule });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Simulate deduction calculation for interactive what-if scenarios
// @route   POST /api/deductions/simulate
exports.simulateCalculation = async (req, res) => {
  try {
    const { minutesLate, dailyWage, ruleOverrides } = req.body;
    const rule = ruleOverrides || (await DeductionRule.findOne({ isActive: true })) || {
      gracePeriodMinutes: 15,
      lateThresholdMinutes: 30,
      deductionType: 'percentage',
      percentageDeductionRate: 5,
      fixedDeductionAmount: 1000,
      halfDayThresholdMinutes: 60,
      consecutiveLateThreshold: 3,
      consecutivePenaltyMultiplier: 1.5,
      currencySymbol: 'PKR',
    };

    const wage = Number(dailyWage) || 4000;
    const lateMins = Number(minutesLate) || 0;

    let deduction = 0;
    let deductionPercentage = 0;
    let status = 'present';
    let explanation = '';

    if (lateMins <= rule.gracePeriodMinutes) {
      status = 'present';
      explanation = `Within grace period of ${rule.gracePeriodMinutes} mins. 0 PKR deducted.`;
    } else if (lateMins >= rule.halfDayThresholdMinutes) {
      status = 'half_day';
      deductionPercentage = 50;
      deduction = Math.round(wage * 0.5);
      explanation = `Late by ${lateMins} mins (exceeds ${rule.halfDayThresholdMinutes}m). Half-day penalty (50% of daily wage) = PKR ${deduction}`;
    } else {
      status = 'late';
      if (rule.deductionType === 'percentage') {
        deductionPercentage = rule.percentageDeductionRate;
        deduction = Math.round((wage * rule.percentageDeductionRate) / 100);
        explanation = `Late by ${lateMins} mins. Deducts ${rule.percentageDeductionRate}% of daily wage (PKR ${wage}) = PKR ${deduction}`;
      } else {
        deduction = rule.fixedDeductionAmount;
        deductionPercentage = Math.round((rule.fixedDeductionAmount / wage) * 100);
        explanation = `Late by ${lateMins} mins. Flat penalty = PKR ${deduction}`;
      }
    }

    res.json({
      success: true,
      simulation: {
        minutesLate: lateMins,
        dailyWage: wage,
        status,
        deduction,
        deductionPercentage,
        explanation,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Monthly deductions ledger and summary per employee
// @route   GET /api/deductions/monthly-report
exports.getMonthlyReport = async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().substring(0, 7); // e.g. "2026-09"
    const records = await Attendance.find({
      date: { $regex: `^${month}` },
      deductionAmount: { $gt: 0 },
    }).populate('user', 'name email department designation baseSalary dailyWage');

    // Aggregate by employee
    const summaryByUser = {};
    records.forEach((r) => {
      if (!r.user) return;
      const uId = r.user._id.toString();
      if (!summaryByUser[uId]) {
        summaryByUser[uId] = {
          user: r.user,
          totalLateIncidents: 0,
          totalMinutesLate: 0,
          totalDeductions: 0,
          incidents: [],
        };
      }
      summaryByUser[uId].totalLateIncidents += 1;
      summaryByUser[uId].totalMinutesLate += r.minutesLate || 0;
      summaryByUser[uId].totalDeductions += r.deductionAmount || 0;
      summaryByUser[uId].incidents.push({
        date: r.date,
        checkIn: r.checkIn,
        minutesLate: r.minutesLate,
        deductionAmount: r.deductionAmount,
        reason: r.deductionReason,
      });
    });

    const report = Object.values(summaryByUser);
    const grandTotalDeductions = report.reduce((sum, item) => sum + item.totalDeductions, 0);

    res.json({
      success: true,
      month,
      grandTotalDeductions,
      employeesPenalizedCount: report.length,
      report,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
