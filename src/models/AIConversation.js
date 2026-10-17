const mongoose = require('mongoose');

const message = new mongoose.Schema({
  id: { type: String, required: true },
  requestId: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, default: '' },
  status: { type: String, enum: ['complete', 'pending', 'stopped', 'error', 'limited'], default: 'complete' },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New conversation', maxlength: 100 },
  provider: { type: String, enum: ['openai', 'claude', 'gemini'], required: true },
  model: { type: String, required: true },
  messages: { type: [message], default: [] },
  activeRequest: { requestId: String, expiresAt: Date },
}, { timestamps: true });
schema.index({ user: 1, updatedAt: -1, _id: -1 });
module.exports = mongoose.model('AIConversation', schema);
