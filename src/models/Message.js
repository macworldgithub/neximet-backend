const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sequence: { type: Number, required: true },
  clientId: { type: String, required: true, maxlength: 100 },
  text: { type: String, trim: true, maxlength: 4000, default: '' },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deliveredBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  attachment: {
    name: String,
    size: Number,
    mimeType: String,
    data: { type: Buffer, select: false },
  },
}, { timestamps: true });
schema.index({ conversation: 1, sequence: 1 }, { unique: true });
schema.index({ conversation: 1, sender: 1, clientId: 1 }, { unique: true });
module.exports = mongoose.model('Message', schema);
