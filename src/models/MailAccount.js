const mongoose = require('mongoose');

// Kept separate from User so directory/profile responses never expose credentials.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, default: '' },
  passwordEncrypted: { type: String, required: true, select: false },
  notificationsEnabled: { type: Boolean, default: true },
  pushCheckpoint: { validity: { type: String, select: false }, nextUid: { type: Number, select: false } },
  notificationPollAt: { type: Date, default: Date.now, select: false, index: true },
}, { timestamps: true });

module.exports = mongoose.model('MailAccount', schema);
