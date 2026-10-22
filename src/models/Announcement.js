const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  body: { type: String, required: true, trim: true, maxlength: 10000 },
  priority: { type: String, enum: ['normal', 'important'], default: 'normal' },
  audience: { type: String, enum: ['everyone', 'department', 'users'], required: true },
  department: String,
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  archivedAt: { type: Date, default: null },
  notificationsPrepared: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ recipients: 1, createdAt: -1 });
schema.index({ notificationsPrepared: 1, archivedAt: 1 });
module.exports = mongoose.model('Announcement', schema);
