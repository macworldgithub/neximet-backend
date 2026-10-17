const { createServer } = require('node:http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./authSecret');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const ChatEvent = require('../models/ChatEvent');
const { corsOptions, originAllowed, runtimeConfig } = require('../config/runtime');

function createRealtimeServer(app, { pollInterval = 1000, config = runtimeConfig() } = {}) {
  const server = createServer(app);
  const io = new Server(server, {
    path: '/api/socket.io',
    transports: ['websocket'],
    maxHttpBufferSize: 16000,
    cors: corsOptions(config),
    allowRequest: (req, callback) => callback(null, originAllowed(req.headers.origin, config)),
    pingInterval: 20000,
    pingTimeout: 20000,
  });
  let startup, stream, pollTimer, closed = false;
  const received = new Map();
  let fanout = Promise.resolve();
  const dispatch = (event) => {
    const id = String(event._id);
    if (received.has(id)) return;
    received.set(id, Date.now());
    for (const [key, timestamp] of received) if (timestamp < Date.now() - 300000) received.delete(key);
    // Preserve event order and recheck active accounts before emitting private
    // content to long-lived sockets whose account may have been disabled.
    fanout = fanout.then(async () => {
      if (closed) return;
      const users = await User.find({ _id: { $in: event.users }, isActive: true }).distinct('_id');
      const active = new Set(users.map(String));
      for (const user of event.users) if (!active.has(String(user))) io.in(`user:${user}`).disconnectSockets(true);
      if (users.length) io.local.to(users.map((id) => `user:${id}`)).emit(event.name, event.data);
    }).catch((error) => {
      received.delete(id); startPolling();
      console.warn('Chat event fanout failed; retrying from the outbox:', error.message);
    });
  };
  const startPolling = () => {
    if (pollTimer || closed) return;
    let busy = false;
    const poll = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const events = await ChatEvent.find({ createdAt: { $gte: new Date(Date.now() - 300000) } }).sort({ _id: 1 }).lean();
        events.forEach(dispatch);
      } catch (error) { console.warn('Chat event sync failed:', error.message); }
      finally { busy = false; }
    };
    pollTimer = setInterval(poll, pollInterval);
    pollTimer.unref();
  };
  const startEvents = async () => {
    await connectDB();
    await ChatEvent.init();
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      if (process.env.VERCEL) throw new Error('Realtime chat requires MongoDB Atlas or a MongoDB replica set');
      startPolling(); // Standalone MongoDB is supported for local development.
      return;
    }
    stream = ChatEvent.watch([{ $match: { operationType: 'insert' } }], {
      ...(hello.operationTime ? { startAtOperationTime: hello.operationTime } : {}),
    });
    stream.on('change', (change) => dispatch(change.fullDocument));
    stream.on('error', (error) => {
      console.warn('Chat change stream interrupted; using durable event catchup:', error.message);
      startPolling();
    });
  };
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') throw new Error('Sign in to connect to chat');
      const decoded = jwt.verify(token, jwtSecret());
      await connectDB();
      const user = await User.findById(decoded.id);
      if (!user?.isActive) throw new Error('User is inactive');
      if (!startup) startup = startEvents().catch((error) => { startup = null; throw error; });
      await startup;
      socket.data.userId = String(user._id);
      socket.data.expiresAt = decoded.exp ? decoded.exp * 1000 : Infinity;
      await socket.join(`user:${user._id}`);
      next();
    } catch (error) { next(new Error(error.message || 'Chat connection failed')); }
  });
  io.on('connection', (socket) => {
    let windowStart = Date.now(), requests = 0;
    const expires = Number.isFinite(socket.data.expiresAt) ? setTimeout(() => socket.disconnect(true), Math.min(socket.data.expiresAt - Date.now(), 2147483647)) : null;
    expires?.unref();
    // No client-controlled room joins or broadcasts. Reuse the same membership,
    // validation, persistence, and idempotency checks as the authenticated API.
    const commands = { 'chat:send': 'sendMessage', 'chat:read': 'markRead', 'chat:delivered': 'markDelivered', 'chat:typing': 'setTyping' };
    for (const [event, handler] of Object.entries(commands)) socket.on(event, async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        if (Date.now() - windowStart > 10000) { windowStart = Date.now(); requests = 0; }
        if (++requests > 100) throw new Error('Too many chat requests. Please wait a moment.');
        if (!payload || typeof payload !== 'object' || typeof payload.conversationId !== 'string') throw new Error('Invalid chat request');
        if (Date.now() >= socket.data.expiresAt) throw new Error('Your session has expired');
        await connectDB();
        const user = await User.findById(socket.data.userId);
        if (!user?.isActive) { socket.disconnect(true); throw new Error('Your account is inactive'); }
        const response = { status() { return this; }, json(result) { acknowledge(result); } };
        await require('../controllers/chatController')[handler]({ user, params: { id: payload.conversationId }, body: payload }, response,
          (error) => acknowledge({ success: false, message: error.message || 'Chat request failed' }));
      } catch (error) { acknowledge({ success: false, message: error.message || 'Chat request failed' }); }
    });
    socket.on('disconnect', () => { if (expires) clearTimeout(expires); });
  });
  server.on('close', () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (stream) void stream.close().catch(() => {});
  });
  return { server, io };
}
module.exports = { createRealtimeServer };
