const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', required: true },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'PushSubscription', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  leaseUntil: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, expires: 604800 },
});
schema.index({ notification: 1, subscription: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
module.exports = mongoose.model('NotificationPushJob', schema);
