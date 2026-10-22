const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, required: true },
  title: { type: String, required: true, maxlength: 160 },
  body: { type: String, default: '', maxlength: 300 },
  url: { type: String, required: true },
  announcement: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement' },
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting' },
  readAt: { type: Date, default: null },
  withdrawn: { type: Boolean, default: false },
  pushPrepared: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ key: 1, user: 1 }, { unique: true });
schema.index({ user: 1, withdrawn: 1, _id: -1 });
schema.index({ user: 1, withdrawn: 1, readAt: 1 });
schema.index({ pushPrepared: 1, createdAt: 1 });
module.exports = mongoose.model('Notification', schema);
