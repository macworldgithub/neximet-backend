const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  date: {
    type: Date,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  isMandatory: {
    type: Boolean,
    default: true,
  },
  year: {
    type: Number,
    default: () => new Date().getFullYear(),
  },
}, { timestamps: true });

module.exports = mongoose.model('Holiday', holidaySchema);
