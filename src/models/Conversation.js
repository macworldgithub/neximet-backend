const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  typingUntil: { type: Date, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  kind: { type: String, enum: ['direct', 'group'], required: true },
  name: { type: String, trim: true, maxlength: 80 },
  // A canonical pair prevents duplicate direct chats, including concurrent creation.
  directKey: { type: String },
  members: { type: [memberSchema], required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nextSequence: { type: Number, default: 0 },
  lastActivityAt: { type: Date, default: Date.now },
}, { timestamps: true });
schema.index({ directKey: 1 }, { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } });
schema.index({ 'members.user': 1, lastActivityAt: -1 });
module.exports = mongoose.model('Conversation', schema);
