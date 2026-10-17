const mongoose = require('mongoose');

// Credentials never live on User or in conversation responses.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, enum: ['openai', 'claude', 'gemini'], required: true },
  keyEncrypted: { type: String, required: true, select: false },
  models: [{ _id: false, id: String, name: String }],
  defaultModel: { type: String, required: true },
}, { timestamps: true });
schema.index({ user: 1, provider: 1 }, { unique: true });
module.exports = mongoose.model('AIConnection', schema);
