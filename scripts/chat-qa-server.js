// Local UI verification: temporary database, synthetic users, real chat routes.
// Never loads .env or connects to the application's database.
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const Conversation = require('../src/models/Conversation');
const Message = require('../src/models/Message');
const { protect } = require('../src/middleware/auth');
process.env.JWT_SECRET = 'temporary-chat-qa-secret';
let mongo, directory, server, realtime;
async function cleanup() {
  if (realtime) await new Promise((resolve) => realtime.io.close(resolve));
  else if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) {
    const stopped = new Promise((resolve) => mongo.once('exit', resolve)); mongo.kill(); await stopped;
  }
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('neximet-chat-qa-')) await rm(directory, { recursive: true, force: true });
}
async function main() {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-chat-qa-'));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const mongoPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const executable = process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod');
  mongo = spawn(executable, ['--dbpath', directory, '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let startupError;
  mongo.on('error', (error) => { startupError = error; });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    try { await mongoose.connect(`mongodb://127.0.0.1:${mongoPort}/chat_qa`, { serverSelectionTimeoutMS: 300 }); break; }
    catch (error) { if (attempt === 39) throw error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  await Promise.all([User.init(), Conversation.init(), Message.init()]);
  const [alice, bob, carol] = await User.create(['Alex Morgan', 'Sam Rivera', 'Jordan Lee'].map((name, index) => ({ name, email: `chat-qa-${index}@example.test`, password: 'chat-qa-only', department: 'Software Development', role: 'Team Member' })));
  const direct = await Conversation.create({ kind: 'direct', directKey: [String(alice._id), String(bob._id)].sort().join(':'), members: [{ user: alice._id }, { user: bob._id }], createdBy: alice._id, nextSequence: 62 });
  await Message.insertMany(Array.from({ length: 62 }, (_, index) => ({ conversation: direct._id, sender: index % 2 ? alice._id : bob._id, sequence: index + 1, clientId: `qa-seed-${index}`, text: index === 61 ? 'The release checklist is ready. Can you review it today?' : `Project update ${index + 1}: the team is making good progress.`, readBy: [bob._id], createdAt: new Date(Date.now() - (62 - index) * 60000) })));
  const group = await Conversation.create({ kind: 'group', name: 'Product delivery', members: [alice, bob, carol].map((person) => ({ user: person._id })), createdBy: alice._id, nextSequence: 1 });
  await Message.create({ conversation: group._id, sender: carol._id, sequence: 1, clientId: 'qa-group-message', text: 'Welcome to our delivery team chat. Share updates here.', readBy: [carol._id] });
  const app = express();
  app.use(cors({ origin: process.env.QA_ORIGIN || 'http://127.0.0.1:3001' })); app.use(express.json());
  const profile = (person) => ({ id: String(person._id), name: person.name, role: person.role, email: person.email, department: person.department, designation: 'QA Fixture' });
  app.post('/api/auth/login', (req, res) => {
    const person = [alice, bob, carol].find(user => user.email === req.body.email);
    if (!person || req.body.password !== 'chat-qa-only') return res.status(401).json({ success: false, message: 'Invalid QA credentials' });
    res.json({ success: true, token: jwt.sign({ id: person._id }, process.env.JWT_SECRET), user: profile(person) });
  });
  app.get('/api/auth/me', protect, (req, res) => res.json({ success: true, user: profile(req.user) }));
  app.get('/api/auth/users', (req, res) => res.json({ success: true, users: [alice, bob, carol].map(profile) }));
  app.get('/api/projects', (req, res) => res.json({ success: true, projects: [] }));
  app.get('/api/attendance/today', (req, res) => res.json({ success: true, attendance: null }));
  app.get('/api/leaves/summary', (req, res) => res.json({ success: true, totalHolidaysLeft: 32 }));
  app.use('/api/chat', require('../src/routes/chatRoutes'));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  realtime = require('../src/services/realtime').createRealtimeServer(app, { pollInterval: 100 });
  server = realtime.server.listen(Number(process.env.QA_PORT || 4011), '127.0.0.1', () => console.log(`Temporary chat QA API on port ${server.address().port}. Synthetic accounts only.`));
  process.on('SIGINT', () => void cleanup().then(() => process.exit()));
  process.on('SIGTERM', () => void cleanup().then(() => process.exit()));
}
main().catch(async (error) => { console.error(error.message); await cleanup(); process.exitCode = 1; });
