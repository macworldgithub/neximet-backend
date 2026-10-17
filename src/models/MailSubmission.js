const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestId: { type: String, required: true },
  fingerprint: { type: String, required: true },
  status: { type: String, enum: ['sending', 'sent', 'uncertain'], default: 'sending' },
  result: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ user: 1, requestId: 1 }, { unique: true });
// No message content or mailbox password is stored here. Retain deduplication for 7 days.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
module.exports = mongoose.model('MailSubmission', schema);
