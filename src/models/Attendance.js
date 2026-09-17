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
  },
  checkIn: {
    type: Date,
  },
  checkOut: {
    type: Date,
  },
  totalWorkHours: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['present', 'late', 'half_day', 'absent', 'on_leave'],
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

module.exports = mongoose.model('Attendance', attendanceSchema);
