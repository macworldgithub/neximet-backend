// Fresh process reproduces server.js: begin connecting, then register routes/models.
// The parent test supplies only a temporary local database, never production .env.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const connectDB = require('../../src/config/db');

async function main() {
  assert.match(process.env.MONGODB_URI, /^mongodb:\/\/127\.0\.0\.1:\d+\/chat_cold_start$/);
  const connecting = connectDB();
  assert.equal(mongoose.connection.readyState, 2);
  assert.equal(mongoose.connection.db, undefined, 'registration must happen before the driver database exists');
  require('../../src/routes/chatRoutes');
  const Conversation = require('../../src/models/Conversation');
  const Message = require('../../src/models/Message');
  const User = require('../../src/models/User');

  const connection = await connecting;
  await Promise.all([Conversation.init(), Message.init(), User.init()]);
  assert.equal(await connectDB(), connection, 'warm requests should reuse the connection');
  const conversationIndexes = await Conversation.collection.indexes();
  const messageIndexes = await Message.collection.indexes();
  assert.ok(conversationIndexes.some((index) => index.unique && index.key.directKey === 1));
  assert.ok(messageIndexes.some((index) => index.unique && index.key.conversation === 1 && index.key.clientId === 1 && index.key.sender === 1));
  console.log('Cold-start initialization passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
