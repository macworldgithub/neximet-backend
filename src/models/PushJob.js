const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'PushSubscription', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  leaseUntil: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, expires: 604800 },
});
schema.index({ message: 1, subscription: 1 }, { unique: true });
module.exports = mongoose.model('PushJob', schema);
