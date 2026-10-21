const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true },
  kind: { type: String, enum: ['incoming_call', 'call_ended', 'meeting_invitation', 'meeting_updated', 'meeting_cancelled', 'meeting_reminder', 'meeting_starting'], required: true },
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting' },
  call: { type: mongoose.Schema.Types.ObjectId, ref: 'CallSession' },
  revision: { type: Number, default: 0 },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'PushSubscription', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  leaseUntil: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, expires: 604800 },
});
schema.index({ key: 1, subscription: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
module.exports = mongoose.model('MeetingPushJob', schema);
