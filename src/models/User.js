const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please enter name'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Please enter email'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'Please enter password'],
    minlength: 6,
    select: false,
  },
  role: {
    type: String,
    enum: ['CEO', 'Super Admin', 'Project Manager', 'Team Manager', 'Team Member'],
    default: 'Team Member',
  },
  department: {
    type: String,
    enum: [
      'Executive',
      'Software Development',
      'Digital Marketing (SEO)',
      'Graphics Designing',
      'WordPress Team',
    ],
    required: true,
  },
  designation: {
    type: String,
    default: 'Specialist',
  },
  baseSalary: {
    type: Number,
    default: 120000,
  },
  dailyWage: {
    type: Number,
    default: 4000,
  },
  phone: {
    type: String,
    default: '+92 (300) 123-4567',
  },
  leaveBalances: {
    casual: { type: Number, default: 10 },
    sick: { type: Number, default: 8 },
    annual: { type: Number, default: 14 },
  },
  joinDate: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  passwordResetRequest: {
    status: {
      type: String,
      enum: ['None', 'Pending', 'Completed', 'Rejected'],
      default: 'None',
    },
    requestedAt: {
      type: Date,
    },
    resolvedAt: {
      type: Date,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
