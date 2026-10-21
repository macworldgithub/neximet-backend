const { randomUUID, createHmac } = require('node:crypto');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Meeting = require('../models/Meeting');
const CallSession = require('../models/CallSession');
const records = require('./meetingRecords');
const { invitees } = require('./meetingInvites');
const notifications = require('./meetingNotifications');
const notifyCall = (room, users, expiresAt) => notifications.notifyCall(room.id, users.map(id => id.replace(/^user:/, '')), expiresAt)
  .catch(error => console.warn('Call push deferred:', error.message));

const MAX_PARTICIPANTS = 8;
const validId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);

function iceConfiguration(userId, env = process.env) {
  const iceServers = [{ urls: env.CALL_STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (env.CALL_TURN_URLS && env.CALL_TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
    iceServers.push({ urls: env.CALL_TURN_URLS.split(',').map(url => url.trim()).filter(Boolean), username,
      credential: createHmac('sha1', env.CALL_TURN_SECRET).update(username).digest('base64') });
  }
  return { iceServers, relayConfigured: iceServers.length > 1, maxParticipants: MAX_PARTICIPANTS };
}

// Calls are ephemeral and owned by the existing single VPS WebSocket process.
// Never persist SDP/ICE: it contains private network information.
function createCallService(io, { ringTimeoutMs = 45000 } = {}) {
  const rooms = new Map();
  const pending = new Map();
  const joiningUsers = new Map();
  const serialize = (key, task) => {
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    pending.set(key, next);
    const done = () => { if (pending.get(key) === next) pending.delete(key); };
    void next.then(done, done); return next;
  };
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || !rooms.size) return;
    heartbeatBusy = true;
    void CallSession.updateMany({ callId: { $in: [...rooms.values()].map(room => room.id) }, endedAt: null }, { $set: { lastSeenAt: new Date() } })
      .catch(error => console.warn('Meeting heartbeat failed:', error.message)).finally(() => { heartbeatBusy = false; });
  }, 30000);
  heartbeat.unref();
  const snapshot = room => ({ id: room.id, conversationId: room.conversationId, title: room.title,
    meetingId: room.meetingId || undefined, mode: room.mode, hostId: room.hostId, startedAt: room.startedAt, connectedAt: room.connectedAt,
    phase: room.participants.size >= 2 ? 'connected' : room.connectedAt || room.meetingId ? 'waiting' : 'ringing',
    oneToOne: room.oneToOne, ringUntil: room.ringUntil, participants: [...room.participants.values()], invitedUserIds: room.inviteUsers.map(id => id.slice(5)), invitedPeople: room.invitedPeople });
  const broadcast = room => io.to(`call:${room.id}`).emit('call:updated', snapshot(room));
  async function endRoom(room, reason) {
    if (rooms.get(room.conversationId) !== room) return;
    clearTimeout(room.ringTimer);
    try { await records.finish(room.id, reason); }
    finally {
      rooms.delete(room.conversationId);
      io.to([`call:${room.id}`, ...room.inviteUsers]).emit('call:ended', { callId: room.id, reason });
      for (const id of room.participants.keys()) {
        const client = io.sockets.sockets.get(id);
        if (client) { client.data.callConversation = null; client.leave(`call:${room.id}`); }
      }
    }
  }
  function ringTimeout(room) {
    clearTimeout(room.ringTimer);
    if (room.connectedAt || room.meetingId) return;
    room.ringUntil = Date.now() + ringTimeoutMs;
    room.ringTimer = setTimeout(() => {
      void serialize(room.conversationId, () => room.participants.size < 2 ? endRoom(room, 'no_answer') : undefined)
        .catch(error => console.warn('Call timeout cleanup failed:', error.message));
    }, ringTimeoutMs);
    room.ringTimer.unref();
  }
  async function leave(socket) {
    const room = rooms.get(socket.data.callConversation);
    socket.data.callConversation = null;
    if (!room || !room.participants.delete(socket.id)) return;
    socket.leave(`call:${room.id}`);
    const leftAt = new Date();
    try {
      await CallSession.updateOne({ callId: room.id }, { $set: { 'attendance.$[mine].leftAt': leftAt } },
        { arrayFilters: [{ 'mine.user': socket.data.userId, 'mine.leftAt': null }] });
    } catch (error) { console.warn('Meeting attendance cleanup deferred:', error.message); }
    if (!room.participants.size || room.oneToOne && room.connectedAt) await endRoom(room, room.participants.size ? 'participant_left' : 'everyone_left');
    else {
      if (![...room.participants.values()].some(p => p.userId === room.hostId)) room.hostId = room.participants.values().next().value.userId;
      broadcast(room);
    }
  }
  function attach(socket) {
    // Serialize commands per socket so concurrent joins cannot bypass limits.
    let queue = Promise.resolve(), windowStart = Date.now(), requests = 0;
    const command = (event, handler) => socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - windowStart > 10000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 250) return ack({ success: false, message: 'Too many call requests. Try again shortly.' });
      queue = queue.then(async () => {
        const previousCall = socket.data.callConversation;
        try {
          if (closing) throw new Error('The server is restarting. Please rejoin shortly.');
          if (!socket.connected || Date.now() >= socket.data.expiresAt) throw new Error('Your session has expired');
          const user = await User.findById(socket.data.userId).select('name isActive');
          if (!user?.isActive) { socket.disconnect(true); throw new Error('Your account is inactive'); }
          if (!payload || typeof payload !== 'object') throw new Error('Invalid call request');
          let conversation;
          if (event !== 'call:config') {
            if (!validId(payload.conversationId)) throw new Error('Invalid conversation');
            payload.conversationId = payload.conversationId.toLowerCase();
            conversation = await Conversation.findById(payload.conversationId);
            const invited = rooms.get(payload.conversationId)?.inviteUsers.includes(`user:${user._id}`);
            if (!conversation || !invited && !conversation.members.some(member => String(member.user) === String(user._id))) throw new Error('Conversation not found');
          }
          // Database authorization awaits may race with disconnect.
          if (!socket.connected) return;
          const work = () => serialize(payload.conversationId || socket.id, () => {
            if (closing) throw new Error('The server is restarting. Please rejoin shortly.');
            if (!socket.connected) throw new Error('The call disconnected');
            if (conversation && !conversation.members.some(member => String(member.user) === String(user._id)) && !rooms.get(payload.conversationId)?.inviteUsers.includes(`user:${user._id}`)) throw new Error('This invitation is no longer active');
            return handler(payload, user, conversation);
          });
          let result;
          if (event === 'call:join') {
            const previous = joiningUsers.get(socket.data.userId) || Promise.resolve();
            // Serialize call entry globally too: simultaneous calls in different
            // rooms must not place either user into two calls or bypass busy checks.
            const next = previous.catch(() => {}).then(() => serialize('__call_join__', work)); joiningUsers.set(socket.data.userId, next);
            try { result = await next; } finally { if (joiningUsers.get(socket.data.userId) === next) joiningUsers.delete(socket.data.userId); }
          } else result = await work();
          ack({ success: true, ...result });
        } catch (error) {
          if (event === 'call:join' && !previousCall && socket.data.callConversation) {
            await serialize(socket.data.callConversation, () => leave(socket)).catch(cleanupError => console.warn('Failed call cleanup deferred:', cleanupError.message));
          }
          ack({ success: false, message: error.message || 'Call request failed' });
        }
      });
    });
    command('call:config', () => iceConfiguration(socket.data.userId));
    command('call:join', async (payload, user, conversation) => {
      if (!['audio', 'video'].includes(payload.mode)) throw new Error('Choose voice or video');
      if (socket.data.callConversation && socket.data.callConversation !== payload.conversationId) throw new Error('Leave your current call first');
      let room = rooms.get(payload.conversationId);
      if (payload.callId && room?.id !== payload.callId) throw new Error('This call has ended');
      if (payload.meetingId && (!validId(payload.meetingId) || room && room.meetingId !== payload.meetingId)) throw new Error('A different meeting is already running in this conversation');
      const scheduledRoom = !room && !payload.meetingId && conversation.purpose === 'meeting' ? await Meeting.findOne({ conversation: conversation._id }).select('_id') : null;
      const meetingId = room?.meetingId || payload.meetingId || (scheduledRoom ? String(scheduledRoom._id) : null);
      let meeting;
      if (meetingId) {
        meeting = await Meeting.findOne({ _id: meetingId, conversation: conversation._id, participants: user._id });
        if (!meeting || ['cancelled', 'completed'].includes(meeting.status)) throw new Error('This meeting is unavailable or has ended');
        if (!room && (meeting.startsAt > new Date(Date.now() + 900000) || meeting.endsAt < new Date())) throw new Error('You can join from 15 minutes before the scheduled start until the scheduled end');
      }
      if (room?.participants.has(socket.id)) return { call: snapshot(room) };
      const otherDevice = [...rooms.values()].some(r => [...r.participants.values()].some(p => p.userId === socket.data.userId && p.socketId !== socket.id));
      if (otherDevice) throw new Error('You are already in a call on another tab or device');
      if (room && !room.participants.has(socket.id) && room.participants.size >= MAX_PARTICIPANTS) throw new Error(`This meeting is full (${MAX_PARTICIPANTS} people)`);
      const created = !room;
      const now = new Date();
      socket.data.callConversation = payload.conversationId;
      if (!room) {
        const activeUsers = await User.find({ _id: { $in: meeting?.participants || conversation.members.map(member => member.user) }, isActive: true }).select('_id name').lean();
        const invited = activeUsers.map(person => person._id);
        if (invited.length < 2) { socket.data.callConversation = null; throw new Error('Add at least one active participant before calling'); }
        const oneToOne = !meeting && invited.length === 2;
        if (oneToOne && [...rooms.values()].some(active => [...active.participants.values()].some(person => person.userId !== socket.data.userId && invited.some(id => String(id) === person.userId)))) {
          socket.data.callConversation = null; throw new Error('This person is already in another call. Try again later.');
        }
        room = { id: randomUUID(), conversationId: payload.conversationId, title: conversation.name || 'Team call',
          mode: payload.mode, hostId: socket.data.userId, startedAt: new Date().toISOString(), participants: new Map(),
          oneToOne, connectedAt: null, ringUntil: null, declined: new Set(),
          invitedPeople: activeUsers.map(person => ({ id: String(person._id), name: person.name })),
          meetingId: meeting ? String(meeting._id) : null,
          inviteUsers: invited.map(id => `user:${id}`) };
        if (meeting) {
          room.title = meeting.title;
          const reserved = await Meeting.updateOne({ _id: meeting._id, status: 'scheduled' }, { $set: { status: 'in_progress', activeCallId: room.id }, $inc: { __v: 1 } });
          if (!reserved.modifiedCount) { socket.data.callConversation = null; throw new Error('This meeting is already running or its invitation changed. Refresh and try again.'); }
        }
        try {
          await CallSession.create({ callId: room.id, conversation: conversation._id, meeting: meeting?._id,
            startedBy: user._id, invitedUsers: invited,
            title: room.title, mode: room.mode, startedAt: now, lastSeenAt: now, attendance: [{ user: user._id, joinedAt: now }] });
        } catch (error) {
          socket.data.callConversation = null;
          if (meeting) await Meeting.updateOne({ _id: meeting._id, activeCallId: room.id }, { $set: { status: 'scheduled', activeCallId: null }, $inc: { __v: 1 } });
          throw error;
        }
        rooms.set(payload.conversationId, room);
      } else await CallSession.updateOne({ callId: room.id, endedAt: null }, { $push: { attendance: { user: user._id, joinedAt: now } }, $set: { lastSeenAt: now } });
      room.participants.set(socket.id, { socketId: socket.id, userId: socket.data.userId, name: user.name,
        microphone: payload.microphone === true, camera: payload.camera === true, sharing: false, handRaised: false });
      if (!room.connectedAt && room.participants.size >= 2) {
        room.connectedAt = new Date().toISOString(); clearTimeout(room.ringTimer); room.ringUntil = null;
        await CallSession.updateOne({ callId: room.id }, { $set: { connectedAt: new Date(room.connectedAt) } });
      }
      if (created) ringTimeout(room);
      socket.data.callConversation = payload.conversationId;
      socket.join(`call:${room.id}`);
      broadcast(room);
      if (created) {
        const users = room.inviteUsers.filter(id => id !== `user:${socket.data.userId}`), expiresAt = Date.now() + 45000;
        io.to(users).emit('call:incoming', { ...snapshot(room), callerName: user.name, expiresAt });
        await notifyCall(room, users, expiresAt);
      }
      io.to(`user:${socket.data.userId}`).emit('call:dismissed', { callId: room.id });
      return { call: snapshot(room) };
    });
    const joined = payload => {
      const room = rooms.get(payload.conversationId);
      if (!room || room.id !== payload.callId || !room.participants.has(socket.id)) throw new Error('Join this call first');
      return room;
    };
    command('call:signal', payload => {
      const room = joined(payload);
      if (!room.participants.has(payload.to) || payload.to === socket.id) throw new Error('Participant is unavailable');
      const signal = payload.signal;
      const description = signal?.description;
      const candidate = signal?.candidate;
      const validDescription = description && ['offer', 'answer'].includes(description.type) && typeof description.sdp === 'string';
      const validCandidate = candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 4000 &&
        (candidate.sdpMid == null || typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 256) &&
        (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 10);
      if (!signal || JSON.stringify(signal).length > 14000 || !(validDescription && !candidate || validCandidate && !description)) throw new Error('Invalid call signal');
      io.to(payload.to).emit('call:signal', { callId: room.id, from: socket.id, signal });
      return {};
    });
    command('call:state', payload => {
      const room = joined(payload), participant = room.participants.get(socket.id);
      for (const key of ['microphone', 'camera', 'sharing', 'handRaised']) if (typeof payload[key] === 'boolean') participant[key] = payload[key];
      broadcast(room); return {};
    });
    command('call:invite', async (payload, user, conversation) => {
      const room = joined(payload);
      if (room.hostId !== socket.data.userId) throw new Error('Only the host can invite people');
      const selected = await invitees(payload.participantIds, user._id);
      const added = selected.filter(id => !room.inviteUsers.includes(`user:${id}`));
      if (room.inviteUsers.length + added.length > MAX_PARTICIPANTS) throw new Error('Meetings support up to 8 invited people');
      if (!added.length) return {};
      await CallSession.updateOne({ callId: room.id, endedAt: null }, { $addToSet: { invitedUsers: { $each: added } } });
      if (room.meetingId) await Meeting.updateOne({ _id: room.meetingId, activeCallId: room.id }, { $addToSet: { participants: { $each: added } }, $inc: { __v: 1 } });
      if (conversation.purpose === 'meeting') await Conversation.updateOne({ _id: conversation._id }, { $addToSet: { members: { $each: added.map(id => ({ user: id })) } } });
      const destinations = added.map(id => `user:${id}`);
      const people = (await User.find({ _id: { $in: added } }).select('_id name').lean()).map(person => ({ id: String(person._id), name: person.name }));
      room.inviteUsers.push(...destinations);
      room.invitedPeople.push(...people);
      room.oneToOne = false; ringTimeout(room);
      broadcast(room);
      const expiresAt = Date.now() + 45000;
      io.to(destinations).emit('call:incoming', { ...snapshot(room), callerName: user.name, expiresAt });
      await notifyCall(room, destinations, expiresAt);
      return {};
    });
    command('call:leave', async payload => { joined(payload); await leave(socket); return {}; });
    command('call:end', async payload => {
      const room = joined(payload);
      if (room.hostId !== socket.data.userId) throw new Error('Only the host can end the meeting for everyone');
      await endRoom(room, 'host_ended'); return {};
    });
    command('call:decline', async (payload, user) => {
      const room = rooms.get(payload.conversationId);
      if (room?.id === payload.callId) {
        if ([...room.participants.values()].some(person => person.userId === socket.data.userId)) return {};
        await CallSession.updateOne({ callId: room.id }, { $addToSet: { declinedBy: user._id } });
        room.declined.add(socket.data.userId);
        io.to(`call:${room.id}`).emit('call:declined', { callId: room.id, name: user.name });
        io.to(`user:${socket.data.userId}`).emit('call:dismissed', { callId: room.id });
        if (!room.meetingId && !room.connectedAt && room.inviteUsers.every(id => id === `user:${room.hostId}` || room.declined.has(id.slice(5)))) await endRoom(room, 'declined');
      }
      return {};
    });
    socket.on('disconnect', () => {
      void serialize(socket.data.callConversation || socket.id, () => leave(socket)).catch(error => console.warn('Meeting disconnect cleanup failed:', error.message));
    });
  }
  let closing;
  const close = () => {
    if (!closing) closing = (async () => {
      clearInterval(heartbeat);
      await Promise.allSettled([...joiningUsers.values(), ...pending.values()]);
      for (const room of rooms.values()) clearTimeout(room.ringTimer);
      await Promise.all([...rooms.values()].map(room => records.finish(room.id, 'server_disconnected')));
      rooms.clear();
    })();
    return closing;
  };
  return { attach, close };
}
module.exports = { createCallService, iceConfiguration };
