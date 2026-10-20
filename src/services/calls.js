const { randomUUID, createHmac } = require('node:crypto');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

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
function createCallService(io) {
  const rooms = new Map();
  const snapshot = room => ({ id: room.id, conversationId: room.conversationId, title: room.title,
    mode: room.mode, hostId: room.hostId, startedAt: room.startedAt, participants: [...room.participants.values()] });
  const broadcast = room => io.to(`call:${room.id}`).emit('call:updated', snapshot(room));
  function leave(socket) {
    const room = rooms.get(socket.data.callConversation);
    socket.data.callConversation = null;
    if (!room || !room.participants.delete(socket.id)) return;
    socket.leave(`call:${room.id}`);
    if (!room.participants.size) {
      io.to(room.inviteUsers).emit('call:ended', { callId: room.id });
      rooms.delete(room.conversationId);
    }
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
        try {
          if (!socket.connected || Date.now() >= socket.data.expiresAt) throw new Error('Your session has expired');
          const user = await User.findById(socket.data.userId).select('name isActive');
          if (!user?.isActive) { socket.disconnect(true); throw new Error('Your account is inactive'); }
          if (!payload || typeof payload !== 'object') throw new Error('Invalid call request');
          let conversation;
          if (event !== 'call:config') {
            if (!validId(payload.conversationId)) throw new Error('Invalid conversation');
            payload.conversationId = payload.conversationId.toLowerCase();
            conversation = await Conversation.findOne({ _id: payload.conversationId, 'members.user': user._id });
            if (!conversation) throw new Error('Conversation not found');
          }
          // Database authorization awaits may race with disconnect.
          if (!socket.connected) return;
          ack({ success: true, ...await handler(payload, user, conversation) });
        } catch (error) { ack({ success: false, message: error.message || 'Call request failed' }); }
      });
    });
    command('call:config', () => iceConfiguration(socket.data.userId));
    command('call:join', (payload, user, conversation) => {
      if (!['audio', 'video'].includes(payload.mode)) throw new Error('Choose voice or video');
      if (socket.data.callConversation && socket.data.callConversation !== payload.conversationId) throw new Error('Leave your current call first');
      let room = rooms.get(payload.conversationId);
      if (payload.callId && room?.id !== payload.callId) throw new Error('This call has ended');
      const otherDevice = [...rooms.values()].some(r => [...r.participants.values()].some(p => p.userId === socket.data.userId && p.socketId !== socket.id));
      if (otherDevice) throw new Error('You are already in a call on another tab or device');
      if (room && !room.participants.has(socket.id) && room.participants.size >= MAX_PARTICIPANTS) throw new Error(`This meeting is full (${MAX_PARTICIPANTS} people)`);
      const created = !room;
      if (!room) {
        room = { id: randomUUID(), conversationId: payload.conversationId, title: conversation.name || 'Team call',
          mode: payload.mode, hostId: socket.data.userId, startedAt: new Date().toISOString(), participants: new Map(),
          inviteUsers: conversation.members.map(member => `user:${member.user}`) };
        rooms.set(payload.conversationId, room);
      }
      room.participants.set(socket.id, { socketId: socket.id, userId: socket.data.userId, name: user.name,
        microphone: payload.microphone === true, camera: payload.camera === true, sharing: false, handRaised: false });
      socket.data.callConversation = payload.conversationId;
      socket.join(`call:${room.id}`);
      broadcast(room);
      if (created) io.to(conversation.members.filter(m => String(m.user) !== socket.data.userId).map(m => `user:${m.user}`))
        .emit('call:incoming', { ...snapshot(room), callerName: user.name, expiresAt: Date.now() + 45000 });
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
    command('call:leave', payload => { joined(payload); leave(socket); return {}; });
    command('call:end', payload => {
      const room = joined(payload);
      if (room.hostId !== socket.data.userId) throw new Error('Only the host can end the meeting for everyone');
      io.to([`call:${room.id}`, ...room.inviteUsers]).emit('call:ended', { callId: room.id });
      for (const id of room.participants.keys()) {
        const client = io.sockets.sockets.get(id);
        if (client) { client.data.callConversation = null; client.leave(`call:${room.id}`); }
      }
      rooms.delete(room.conversationId); return {};
    });
    command('call:decline', (payload, user) => {
      const room = rooms.get(payload.conversationId);
      if (room?.id === payload.callId) io.to(`call:${room.id}`).emit('call:declined', { callId: room.id, name: user.name });
      return {};
    });
    socket.on('disconnect', () => leave(socket));
  }
  return { attach };
}
module.exports = { createCallService, iceConfiguration };
