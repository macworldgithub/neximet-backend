const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', default: null },
  startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  invitedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  title: { type: String, required: true },
  mode: { type: String, enum: ['audio', 'video'], required: true },
  startedAt: { type: Date, required: true },
  connectedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, required: true },
  endReason: { type: String, enum: ['host_ended', 'everyone_left', 'server_disconnected', 'declined', 'no_answer', 'participant_left'], default: null },
  attendance: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, joinedAt: { type: Date, required: true }, leftAt: { type: Date, default: null }, _id: false }],
  declinedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });
schema.index({ invitedUsers: 1, _id: -1 });
schema.index({ endedAt: 1, lastSeenAt: 1 });
module.exports = mongoose.model('CallSession', schema);
