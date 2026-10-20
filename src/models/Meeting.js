const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  organizer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 4000 },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  timezone: { type: String, required: true },
  mode: { type: String, enum: ['audio', 'video'], default: 'video' },
  status: { type: String, enum: ['scheduled', 'in_progress', 'completed', 'cancelled'], default: 'scheduled' },
  activeCallId: { type: String, default: null },
  responses: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, response: { type: String, enum: ['accepted', 'declined', 'tentative'] }, _id: false }],
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ participants: 1, startsAt: 1 });
module.exports = mongoose.model('Meeting', schema);
