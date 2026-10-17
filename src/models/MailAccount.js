const mongoose = require('mongoose');

// Kept separate from User so directory/profile responses never expose credentials.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, default: '' },
  passwordEncrypted: { type: String, required: true, select: false },
  notificationsEnabled: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('MailAccount', schema);
