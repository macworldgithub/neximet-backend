const mongoose = require('mongoose');

const deductionRuleSchema = new mongoose.Schema({
  title: {
    type: String,
    default: 'Standard Company Attendance Policy',
  },
  shiftStartTime: {
    type: String,
    default: '09:00', // HH:mm format
  },
  shiftEndTime: {
    type: String,
    default: '18:00',
  },
  gracePeriodMinutes: {
    type: Number,
    default: 15, // up to 15 mins late -> Grace, no deduction
  },
  lateThresholdMinutes: {
    type: Number,
    default: 30, // 16 - 30 mins late -> Tier 1 deduction
  },
  deductionType: {
    type: String,
    enum: ['percentage', 'fixed'],
    default: 'percentage', // percentage of dailyWage or flat fixed amount
  },
  fixedDeductionAmount: {
    type: Number,
    default: 1000, // 1000 PKR per late incident
  },
  percentageDeductionRate: {
    type: Number,
    default: 5, // 5% of dailyWage
  },
  halfDayThresholdMinutes: {
    type: Number,
    default: 60, // >= 60 mins late -> Half day deduction (50% of day's wage)
  },
  fullDayAbsentThresholdMinutes: {
    type: Number,
    default: 180, // >= 3 hours late -> Treated as absent / 100% deduction
  },
  consecutiveLateThreshold: {
    type: Number,
    default: 3, // 3 late marks in a month triggers additional penalty
  },
  consecutivePenaltyMultiplier: {
    type: Number,
    default: 1.5,
  },
  currencySymbol: {
    type: String,
    default: 'PKR',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });

module.exports = mongoose.model('DeductionRule', deductionRuleSchema);
