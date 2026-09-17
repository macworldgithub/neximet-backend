const mongoose = require('mongoose');

const timeLogSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
  },
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  date: {
    type: Date,
    default: Date.now,
  },
  hours: {
    type: Number,
    required: [true, 'Please provide logged hours'],
    min: 0.1,
    max: 24,
  },
  description: {
    type: String,
    required: [true, 'Please provide description of work'],
  },
  billable: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('TimeLog', timeLogSchema);
