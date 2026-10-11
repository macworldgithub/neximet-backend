const mongoose = require('mongoose');

// Durable fan-out between WebSocket instances; MongoDB Atlas change streams
// deliver inserts to every instance, including across Vercel deployments.
const schema = new mongoose.Schema({
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  name: { type: String, enum: ['chat:message', 'chat:receipt', 'chat:typing', 'chat:conversation'], required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 },
});
module.exports = mongoose.model('ChatEvent', schema);
