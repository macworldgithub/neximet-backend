const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  date: {
    type: String, // YYYY-MM-DD format for straightforward daily queries
    required: true,
    validate: { validator: value => require('../services/attendancePolicy').validDate(value), message: 'Attendance date must be a valid YYYY-MM-DD.' },
  },
  checkIn: {
    type: Date,
  },
  checkOut: {
    type: Date,
  },
  scheduledCheckOut: Date,
  checkOutSource: { type: String, enum: ['employee', 'shift_end'] },
  isSimulated: { type: Boolean, default: false },
  recordSource: { type: String, enum: ['employee', 'automatic', 'administrator'], default: 'employee' },
  policySnapshot: mongoose.Schema.Types.Mixed,
  wageSnapshot: Number,
  expectedCheckIn: Date,
  financialReviewRequired: { type: Boolean, default: false },
  quarantine: { reason: String, at: Date },
  deviceLockKey: String,
  override: {
    type: { type: String, enum: ['absent', 'present'] },
    snapshot: mongoose.Schema.Types.Mixed,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: Date,
  },
  auditTrail: [{
    action: { type: String, enum: ['mark_absent', 'mark_present', 'restore', 'leave_adjustment', 'repeat_adjustment', 'repair'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
    reason: String,
    previousStatus: String,
    previousState: mongoose.Schema.Types.Mixed,
  }],
  totalWorkHours: {
    type: Number,
    min: 0,
    default: 0,
  },
  status: {
    type: String,
    enum: ['present', 'late', 'half_day', 'absent', 'on_leave', 'on_holiday', 'day_off'],
    default: 'present',
  },
  isLate: {
    type: Boolean,
    default: false,
  },
  minutesLate: {
    type: Number,
    default: 0,
  },
  deductionAmount: {
    type: Number,
    min: 0,
    default: 0,
  },
  deductionPercentage: {
    type: Number,
    default: 0,
  },
  deductionReason: {
    type: String,
    default: '',
  },
  location: {
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    distanceMeters: { type: Number, default: null },
    isVerified: { type: Boolean, default: false },
    officeAddress: { type: String, default: '' },
  },
  deviceInfo: {
    deviceId: { type: String, default: '' },
    deviceType: { type: String, default: '' },
    browser: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  photo: {
    type: String, // base64 encoded check-in selfie snapshot
    default: '',
  },
  ipAddress: {
    type: String,
    default: '127.0.0.1',
  },
  notes: {
    type: String,
    default: '',
  },
}, { timestamps: true });

// Ensure one record per user per day
attendanceSchema.index({ user: 1, date: 1 }, { unique: true });
// Legacy records have no lock key; only new policy-enforced check-ins are indexed.
attendanceSchema.index({ deviceLockKey: 1 }, { unique: true, partialFilterExpression: { deviceLockKey: { $type: 'string' } } });
attendanceSchema.index({ date: -1, user: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
