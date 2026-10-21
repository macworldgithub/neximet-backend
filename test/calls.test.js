// Uses synthetic accounts and an isolated temporary MongoDB, never .env.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const { createHmac } = require('node:crypto');
const { createRealtimeServer } = require('../src/services/realtime');
const { iceConfiguration } = require('../src/services/calls');
const User = require('../src/models/User');
const Conversation = require('../src/models/Conversation');
const CallSession = require('../src/models/CallSession');
const Meeting = require('../src/models/Meeting');
process.env.JWT_SECRET = 'isolated-call-tests-secret';
let mongo, directory, realtime, users, group, direct;
const clients = [];
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-calls-test-'));
  const port = await freePort();
  mongo = spawn(process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod'),
    ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let failure; mongo.on('error', error => { failure = error; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failure) throw failure;
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/calls_tests`, { serverSelectionTimeoutMS: 300 }); break; }
    catch (error) { if (attempt === 49) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  users = await User.create(Array.from({ length: 11 }, (_, i) => ({ name: `Caller ${i}`, email: `call-${i}@example.test`, password: 'isolated-call-only', department: 'Software Development' })));
  group = await Conversation.create({ kind: 'group', name: 'Call test team', createdBy: users[0]._id, members: users.slice(0, 10).map(user => ({ user: user._id })) });
  direct = await Conversation.create({ kind: 'direct', createdBy: users[0]._id, members: users.slice(0, 2).map(user => ({ user: user._id })) });
  const app = express(); app.use(express.json()); app.use('/api/meetings', require('../src/routes/meetingRoutes'));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  realtime = createRealtimeServer(app);
  await new Promise(resolve => realtime.server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  clients.forEach(client => client.disconnect());
  if (realtime) await realtime.closeCalls();
  if (realtime) await new Promise(resolve => realtime.io.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) { const stopped = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await stopped; }
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('neximet-calls-test-')) await rm(directory, { recursive: true, force: true });
});
async function connect(index, instance = realtime) {
  const client = io(`http://127.0.0.1:${instance.server.address().port}`, { path: '/api/socket.io', transports: ['websocket'], auth: { token: jwt.sign({ id: users[index]._id }, process.env.JWT_SECRET) }, reconnection: false });
  clients.push(client);
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  return client;
}
const command = (client, event, payload) => client.timeout(5000).emitWithAck(event, payload);
const join = (client, conversation = group, extra = {}) => command(client, 'call:join', { conversationId: String(conversation._id), mode: 'video', microphone: true, camera: true, ...extra });
async function request(index, endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`http://127.0.0.1:${realtime.server.address().port}/api/meetings${endpoint}`, {
    method, headers: { ...(index == null ? {} : { Authorization: `Bearer ${jwt.sign({ id: users[index]._id }, process.env.JWT_SECRET)}` }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
const schedule = (minutes = 60) => ({ conversationId: String(direct._id), title: 'Delivery review', description: 'Review the release',
  startsAt: new Date(Date.now() + minutes * 60000).toISOString(), endsAt: new Date(Date.now() + (minutes + 30) * 60000).toISOString(), timezone: 'Asia/Karachi', mode: 'audio' });
function event(client, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(name, receive); reject(new Error(`Missing ${name}`)); }, 5000);
    const receive = value => { if (predicate(value)) { clearTimeout(timer); client.off(name, receive); resolve(value); } };
    client.on(name, receive);
  });
}

test('TURN credentials are temporary, user scoped, and do not expose the shared secret', () => {
  const config = iceConfiguration('alice', { CALL_TURN_URLS: 'turn:relay.test:3478, turns:relay.test:5349', CALL_TURN_SECRET: 'private-shared-secret' });
  const relay = config.iceServers[1];
  assert.equal(config.relayConfigured, true);
  assert.equal(config.maxParticipants, 8);
  assert.ok(Number(relay.username.split(':')[0]) > Date.now() / 1000 + 86000);
  assert.equal(relay.username.split(':')[1], 'alice');
  assert.equal(relay.credential, createHmac('sha1', 'private-shared-secret').update(relay.username).digest('base64'));
  assert.equal(JSON.stringify(config).includes('private-shared-secret'), false);
  assert.equal(iceConfiguration('alice', {}).relayConfigured, false);
});

test('membership, invitations, signaling isolation, media state, host end, and stale links', async () => {
  const [alice, bob, outsider] = await Promise.all([connect(0), connect(1), connect(10)]);
  assert.equal((await join(outsider)).success, false);
  assert.equal((await command(alice, 'call:join', { conversationId: 'bad', mode: 'video' })).success, false);
  const invitation = event(bob, 'call:incoming');
  const a = await join(alice);
  assert.equal(a.success, true);
  assert.equal((await invitation).id, a.call.id);
  assert.equal((await join(bob, group, { callId: 'stale-call' })).success, false);
  const b = await join(bob, group, { callId: a.call.id });
  assert.equal(b.call.participants.length, 2);
  const payload = { conversationId: String(group._id), callId: a.call.id };
  const signal = event(bob, 'call:signal');
  assert.equal((await command(alice, 'call:signal', { ...payload, to: bob.id, signal: { description: { type: 'offer', sdp: 'v=0' } } })).success, true);
  assert.equal((await signal).from, alice.id);
  assert.equal((await command(alice, 'call:signal', { ...payload, to: outsider.id, signal: { candidate: { candidate: 'candidate:test' } } })).success, false);
  assert.equal((await command(outsider, 'call:signal', { ...payload, to: bob.id, signal: { description: { type: 'offer', sdp: 'private' } } })).success, false);
  assert.equal((await command(alice, 'call:signal', { ...payload, to: bob.id, signal: { description: { type: 'answer', sdp: 'x'.repeat(14500) } } })).success, false);
  assert.equal((await command(alice, 'call:signal', { ...payload, to: bob.id, signal: { description: { type: 'invalid', sdp: 'v=0' }, candidate: { candidate: 'candidate:test' } } })).success, false);
  const updated = event(alice, 'call:updated', value => value.participants.some(p => p.userId === String(users[1]._id) && p.sharing));
  await command(bob, 'call:state', { ...payload, microphone: false, sharing: true, handRaised: true });
  assert.equal((await updated).participants.find(p => p.socketId === bob.id).microphone, false);
  assert.equal((await command(bob, 'call:end', payload)).success, false);
  const ended = event(bob, 'call:ended');
  assert.equal((await command(alice, 'call:end', payload)).success, true);
  assert.equal((await ended).callId, a.call.id);
  assert.equal((await join(bob, group, { callId: a.call.id })).success, false);
  alice.disconnect(); bob.disconnect(); outsider.disconnect();
});

test('one call per user/device, disconnect cleanup, host transfer, and fresh meeting IDs', async () => {
  const [alice, otherTab, bob] = await Promise.all([connect(0), connect(0), connect(1)]);
  const a = await join(alice, group);
  assert.equal((await join(otherTab, group)).success, false);
  assert.equal((await join(alice, direct)).success, false);
  await join(bob, group);
  const transferred = event(bob, 'call:updated', value => value.hostId === String(users[1]._id));
  alice.disconnect();
  assert.equal((await transferred).participants.length, 1);
  assert.equal((await command(bob, 'call:leave', { conversationId: String(group._id), callId: a.call.id })).success, true);
  const next = await join(otherTab, direct);
  assert.notEqual(next.call.id, a.call.id);
  await command(otherTab, 'call:leave', { conversationId: String(direct._id), callId: next.call.id });
  otherTab.disconnect(); bob.disconnect();
});

test('mesh participant cap remains enforced under concurrent joins', async () => {
  const people = await Promise.all(Array.from({ length: 10 }, (_, i) => connect(i)));
  const responses = await Promise.all(people.map(person => join(person)));
  assert.equal(responses.filter(response => response.success).length, 8);
  assert.equal(responses.filter(response => !response.success).length, 2);
  // End using the host identified in the actual snapshot, not join completion order.
  const call = responses.find(response => response.success).call;
  const host = people[users.findIndex(user => String(user._id) === call.hostId)];
  assert.equal((await command(host, 'call:end', { conversationId: String(group._id), callId: call.id })).success, true);
  people.forEach(person => person.disconnect());
});

test('leaving the last participant clears pending invitations and uppercase IDs reuse the same room', async () => {
  const [alice, bob] = await Promise.all([connect(0), connect(1)]);
  const invitation = event(bob, 'call:incoming');
  const a = await join(alice, direct, { conversationId: String(direct._id).toUpperCase() });
  await invitation;
  const b = await join(bob, direct);
  assert.equal(b.call.id, a.call.id);
  const ended = event(bob, 'call:ended');
  await command(alice, 'call:leave', { conversationId: String(direct._id), callId: a.call.id });
  assert.equal((await ended).reason, 'participant_left');
  assert.equal((await join(bob, direct, { callId: a.call.id })).success, false);
  alice.disconnect(); bob.disconnect();
});

test('disabled accounts lose call access on the next command', async () => {
  const client = await connect(9);
  await User.updateOne({ _id: users[9]._id }, { isActive: false });
  await assert.rejects(command(client, 'call:config', {}));
  client.disconnect();
});

test('calendar invitations are persistent, private, validated, and editable only by the organizer', async () => {
  assert.equal((await request(null, '/upcoming')).status, 401);
  assert.equal((await request(10, '', schedule())).status, 404);
  for (const body of [{ ...schedule(), timezone: 'Invalid/Zone' }, { ...schedule(), startsAt: new Date(Date.now() - 3600000).toISOString() }, { ...schedule(), title: '' }]) {
    assert.equal((await request(0, '', body)).status, 400);
  }
  const created = await request(0, '', { ...schedule(), participants: [String(users[10]._id)] });
  assert.equal(created.status, 201);
  const meeting = created.body.meeting, id = meeting._id;
  assert.equal(meeting.participants.length, 2);
  assert.deepEqual(meeting.participants.map(person => person.name).sort(), ['Caller 0', 'Caller 1']);
  assert.equal(meeting.participants[0].email, undefined);
  assert.equal((await request(10, `/${id}`)).status, 404);
  const calendar = await request(1, `?from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`);
  assert.equal(calendar.cache, 'private, no-store');
  assert.ok(calendar.body.meetings.some(item => item._id === id));
  assert.equal((await request(1, `/${id}/rsvp`, { response: 'accepted' })).body.meeting.responses.length, 2);
  assert.equal((await request(1, `/${id}`, schedule(), 'PATCH')).status, 403);
  const edited = await request(0, `/${id}`, { ...schedule(90), title: 'Updated review' }, 'PATCH');
  assert.equal(edited.body.meeting.title, 'Updated review'); assert.equal(edited.body.meeting.responses.length, 1);
  assert.equal((await request(1, `/${id}/cancel`, {})).status, 403);
  assert.equal((await request(0, `/${id}/cancel`, {})).body.meeting.status, 'cancelled');
  const client = await connect(0);
  assert.equal((await join(client, direct, { meetingId: id })).success, false); client.disconnect();
});

test('scheduled calls enforce join windows and record actual attendance and missed/declined outcomes', async () => {
  const id = (await request(0, '', schedule(60))).body.meeting._id;
  const [alice, bob, carol] = await Promise.all([connect(0), connect(1), connect(2)]);
  assert.equal((await join(alice, direct, { meetingId: id })).success, false);
  await request(0, `/${id}`, schedule(10), 'PATCH');
  const started = await join(alice, direct, { meetingId: id, mode: 'audio', camera: false });
  assert.equal(started.success, true); assert.equal(started.call.meetingId, id);
  assert.equal((await request(0, `/${id}`)).body.meeting.status, 'in_progress');
  assert.equal((await request(0, `/${id}/cancel`, {})).status, 409);
  const payload = { conversationId: String(direct._id), callId: started.call.id };
  await command(bob, 'call:decline', payload);
  let history = (await request(1, '/history')).body.history.find(item => item.callId === started.call.id);
  assert.equal(history.outcome, 'declined');
  await join(bob, direct, { meetingId: id });
  assert.equal((await join(carol, direct, { meetingId: id })).success, false);
  await command(alice, 'call:end', payload);
  const stored = await CallSession.findOne({ callId: started.call.id }).lean();
  assert.equal(stored.attendance.length, 2); assert.ok(stored.attendance.every(item => item.leftAt)); assert.equal(stored.endReason, 'host_ended');
  history = (await request(1, '/history')).body.history.find(item => item.callId === started.call.id);
  assert.equal(history.outcome, 'attended'); assert.equal(history.meeting, id); assert.equal(history.attendance.length, 2);
  assert.equal((await request(0, `/${id}`)).body.meeting.status, 'completed');
  assert.equal((await join(alice, direct, { meetingId: id })).success, false);
  alice.disconnect(); bob.disconnect(); carol.disconnect();
});

test('unanswered invitations and interrupted server sessions remain in personal history', async () => {
  const alice = await connect(0);
  const started = await join(alice, group);
  await command(alice, 'call:end', { conversationId: String(group._id), callId: started.call.id });
  assert.equal((await request(0, '/history')).body.history.find(item => item.callId === started.call.id).outcome, 'unanswered');
  assert.equal((await request(2, '/history')).body.history.find(item => item.callId === started.call.id).outcome, 'missed');
  assert.equal((await request(10, '/history')).body.history.length, 0);
  const meeting = await Meeting.create({ ...schedule(10), conversation: direct._id, organizer: users[0]._id, participants: [users[0]._id], status: 'in_progress', activeCallId: 'interrupted-test' });
  const lastSeenAt = new Date(Date.now() - 300000);
  await CallSession.create({ callId: 'interrupted-test', conversation: direct._id, meeting: meeting._id, startedBy: users[0]._id, invitedUsers: [users[0]._id], title: 'Interrupted call', mode: 'audio', startedAt: new Date(+lastSeenAt - 65000), lastSeenAt, attendance: [{ user: users[0]._id, joinedAt: new Date(+lastSeenAt - 65000) }] });
  const interrupted = (await request(0, '/history')).body.history.find(item => item.callId === 'interrupted-test');
  assert.equal(interrupted.endReason, 'server_disconnected'); assert.equal(interrupted.durationSeconds, 65); assert.equal(interrupted.attendanceSeconds, 65);
  assert.equal((await Meeting.findById(meeting._id)).status, 'completed');
  alice.disconnect();
});

test('history pagination is private and returns older records without duplicates', async () => {
  await CallSession.insertMany(Array.from({ length: 25 }, (_, index) => ({ callId: `pagination-${index}`, conversation: direct._id, startedBy: users[0]._id, invitedUsers: [users[0]._id], title: `Past meeting ${index}`, mode: 'audio', startedAt: new Date(Date.now() - 60000), lastSeenAt: new Date(), endedAt: new Date(), attendance: [] })));
  const first = await request(0, '/history'); assert.equal(first.body.history.length, 20); assert.equal(first.body.hasMore, true);
  const next = await request(0, `/history?before=${first.body.history[19]._id}`);
  assert.ok(next.body.history.length > 0); assert.ok(!next.body.history.some(item => first.body.history.some(previous => previous._id === item._id)));
  assert.equal((await request(0, '/history?before=invalid')).status, 400);
  const searched = await request(0, '/history?q=Past%20meeting%2024');
  assert.equal(searched.body.history.length, 1); assert.equal(searched.body.history[0].title, 'Past meeting 24');
  assert.equal((await request(0, '/history?q=%5B')).status, 200);
  assert.equal((await request(0, '/history?q[x]=object')).status, 400);
});

test('standalone meetings invite users without existing chats and hosts can add live guests', async () => {
  assert.equal((await request(null, '/rooms', { participantIds: [] })).status, 401);
  for (const participantIds of [[], [String(users[0]._id)], 'invalid', ['bad'], users.slice(1, 10).map(user => String(user._id))]) assert.equal((await request(0, '/rooms', { participantIds })).status, 400);
  const created = await request(0, '/rooms', { title: 'Open team voice meeting', participantIds: [String(users[10]._id)] });
  assert.equal(created.status, 201); assert.equal(created.body.room.purpose, 'meeting');
  const room = created.body.room;
  assert.equal((await request(10, `/rooms/${room._id}`)).status, 200);
  assert.equal((await request(2, `/rooms/${room._id}`)).status, 404);
  const [host, invited, extra] = await Promise.all([connect(0), connect(10), connect(2)]);
  const ringing = event(invited, 'call:incoming');
  const started = await join(host, room, { mode: 'audio', camera: false });
  assert.equal((await ringing).mode, 'audio'); assert.equal(started.call.participants[0].camera, false);
  assert.equal((await join(invited, room, { mode: 'audio', camera: false })).success, true);
  const payload = { conversationId: room._id, callId: started.call.id };
  assert.equal((await command(invited, 'call:invite', { ...payload, participantIds: [String(users[2]._id)] })).success, false);
  const additionalRing = event(extra, 'call:incoming');
  assert.equal((await command(host, 'call:invite', { ...payload, participantIds: [String(users[2]._id)] })).success, true);
  assert.equal((await additionalRing).id, started.call.id);
  assert.equal((await request(2, `/rooms/${room._id}`)).status, 200);
  assert.equal((await join(extra, room, { mode: 'audio', camera: false })).success, true);
  await command(host, 'call:end', payload);
  const stored = await CallSession.findOne({ callId: started.call.id });
  assert.equal(stored.invitedUsers.length, 3); assert.equal(stored.attendance.length, 3);
  for (const client of [host, invited, extra]) client.disconnect();
});

test('chat-call guests can join only the active invitation without acquiring chat membership', async () => {
  const [host, guest] = await Promise.all([connect(0), connect(10)]);
  const started = await join(host, direct, { mode: 'audio', camera: false });
  const payload = { conversationId: String(direct._id), callId: started.call.id };
  const ringing = event(guest, 'call:incoming');
  assert.equal((await command(host, 'call:invite', { ...payload, participantIds: [String(users[10]._id)] })).success, true);
  await ringing;
  assert.equal((await request(10, `/rooms/${direct._id}`)).status, 200);
  assert.equal((await join(guest, direct, { callId: started.call.id, mode: 'audio', camera: false })).success, true);
  assert.equal((await Conversation.findById(direct._id)).members.length, 2);
  await command(host, 'call:end', payload);
  assert.equal((await join(guest, direct)).success, false);
  assert.equal((await request(10, `/rooms/${direct._id}`)).status, 404);
  host.disconnect(); guest.disconnect();
});

test('multi-user schedules persist selected guests, allow edits, and enforce the window without a meeting ID', async () => {
  const data = { ...schedule(60), conversationId: undefined, participantIds: [String(users[10]._id), String(users[2]._id)] };
  const created = await request(0, '', data); assert.equal(created.status, 201);
  const meeting = created.body.meeting; assert.equal(meeting.participants.length, 3);
  assert.equal((await request(10, `/${meeting._id}`)).status, 200);
  assert.equal((await request(1, `/${meeting._id}`)).status, 404);
  const host = await connect(0); const room = { _id: meeting.conversation };
  assert.equal((await join(host, room)).success, false);
  const edited = await request(0, `/${meeting._id}`, { ...data, participantIds: [String(users[1]._id)] }, 'PATCH');
  assert.equal(edited.status, 200); assert.equal(edited.body.meeting.conversation, meeting.conversation);
  assert.equal((await request(10, `/${meeting._id}`)).status, 404);
  assert.equal((await request(10, `/rooms/${meeting.conversation}`)).status, 404);
  assert.equal((await request(1, `/${meeting._id}`)).status, 200);
  assert.equal((await request(10, `/${meeting._id}`, data, 'PATCH')).status, 404);
  const inactive = users[3]; await User.updateOne({ _id: inactive._id }, { isActive: false });
  assert.equal((await request(0, '/rooms', { participantIds: [String(inactive._id)] })).status, 400);
  await User.updateOne({ _id: inactive._id }, { isActive: true });
  assert.equal((await request(0, `/${meeting._id}/cancel`, {})).status, 200);
  assert.equal((await join(host, room)).success, false);
  host.disconnect();
});

test('call push reaches offline invitees, deduplicates, and replaces ringing with call-ended status', async () => {
  const webpush = require('web-push'), notifications = require('../src/services/meetingNotifications');
  const Subscription = require('../src/models/PushSubscription'), Job = require('../src/models/MeetingPushJob');
  const keys = webpush.generateVAPIDKeys(), original = webpush.sendNotification;
  const names = ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_SUBJECT'];
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, { WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: 'https://example.test' });
  const sent = []; webpush.sendNotification = async (subscription, payload, options) => { sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload), options }); };
  const host = await connect(0);
  try {
    await Subscription.create({ user: users[10]._id, endpoint: 'https://fcm.googleapis.com/call-test-offline', keys: { p256dh: 'fixture', auth: 'fixture' } });
    const room = (await request(0, '/rooms', { participantIds: [String(users[10]._id)] })).body.room;
    const started = await join(host, room, { mode: 'audio', camera: false }); assert.equal(started.success, true);
    await notifications.flush();
    let alerts = sent.filter(item => item.callId === started.call.id && item.kind === 'incoming_call');
    assert.equal(alerts.length, 1); assert.equal(alerts[0].userId, String(users[10]._id));
    assert.equal(alerts[0].options.urgency, 'high'); assert.ok(alerts[0].options.TTL <= 45);
    assert.ok(alerts[0].url.includes('mode=audio')); assert.equal(alerts[0].receiptToken, undefined);
    await notifications.notifyCall(started.call.id, [users[10]._id], Date.now() + 45000); await notifications.flush();
    assert.equal(sent.filter(item => item.callId === started.call.id && item.kind === 'incoming_call').length, 1);
    const payload = { conversationId: room._id, callId: started.call.id };
    await command(host, 'call:end', payload); await notifications.flush();
    alerts = sent.filter(item => item.callId === started.call.id && item.kind === 'call_ended');
    assert.equal(alerts.length, 1); assert.equal(alerts[0].title, 'Missed voice call');
    assert.equal(await Job.countDocuments({ key: `call:${started.call.id}`, status: 'sent' }), 1);
  } finally {
    host.disconnect(); await notifications.flush(); await Subscription.deleteMany({});
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    webpush.sendNotification = original;
  }
});

test('meeting pushes and durable reminders respect RSVP, edits, retries, cancellation and device ownership', async () => {
  const webpush = require('web-push'), notifications = require('../src/services/meetingNotifications');
  const Subscription = require('../src/models/PushSubscription'), Job = require('../src/models/MeetingPushJob');
  const keys = webpush.generateVAPIDKeys(), original = webpush.sendNotification;
  const names = ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_SUBJECT'], previous = names.map(name => process.env[name]);
  Object.assign(process.env, { WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: 'https://example.test' });
  const sent = []; let failing = false;
  webpush.sendNotification = async (target, data) => { if (failing && target.endpoint.endsWith('device-1')) throw Object.assign(new Error('Retry'), { statusCode: 503 }); sent.push(JSON.parse(data)); };
  try {
    for (const index of [0, 1, 2]) await Subscription.create({ user: users[index]._id, endpoint: `https://fcm.googleapis.com/device-${index}`, keys: { p256dh: 'fixture', auth: 'fixture' } });
    const created = await request(0, '', { ...schedule(30), conversationId: undefined, participantIds: [String(users[1]._id), String(users[2]._id)] });
    assert.equal(created.status, 201); const id = created.body.meeting._id;
    await notifications.flush();
    assert.equal(sent.filter(item => item.meetingId === id && item.kind === 'meeting_invitation').length, 2);
    await request(2, `/${id}/rsvp`, { response: 'declined' });
    await Meeting.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() + 540000) } });
    await notifications.flush(); await notifications.flush();
    let reminders = sent.filter(item => item.meetingId === id && item.kind === 'meeting_reminder');
    assert.equal(reminders.length, 2); assert.ok(!reminders.some(item => item.userId === String(users[2]._id)));
    await Meeting.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() - 1000) } }); await notifications.flush();
    assert.equal(sent.filter(item => item.meetingId === id && item.kind === 'meeting_starting').length, 2);
    await request(0, `/${id}/cancel`, {}); await notifications.flush();
    assert.equal(sent.filter(item => item.meetingId === id && item.kind === 'meeting_cancelled').length, 2);
    const count = sent.filter(item => item.meetingId === id).length; await notifications.flush();
    assert.equal(sent.filter(item => item.meetingId === id).length, count);
    failing = true;
    const retry = (await request(0, '', { ...schedule(60), conversationId: undefined, participantIds: [String(users[1]._id)] })).body.meeting;
    await notifications.flush();
    const job = await Job.findOne({ meeting: retry._id, kind: 'meeting_invitation' });
    assert.equal(job.status, 'pending'); assert.equal(job.attempts, 1);
    await notifications.flush(); assert.equal((await Job.findById(job._id)).attempts, 1);
    failing = false; await Job.updateOne({ _id: job._id }, { nextAttemptAt: new Date(0) });
    await Promise.all([notifications.flush(), notifications.flush()]);
    assert.equal(sent.filter(item => item.meetingId === retry._id).length, 1);
    failing = true;
    await request(0, `/${retry._id}`, { ...schedule(90), participantIds: [String(users[1]._id)], title: 'Changed meeting' }, 'PATCH'); await notifications.flush();
    const update = await Job.findOne({ meeting: retry._id, kind: 'meeting_updated' }); assert.equal(update.status, 'pending');
    await Subscription.updateOne({ user: users[1]._id }, { user: users[10]._id }); failing = false;
    await Job.updateOne({ _id: update._id }, { nextAttemptAt: new Date(0) }); await notifications.flush();
    assert.equal(sent.some(item => item.meetingId === retry._id && item.kind === 'meeting_updated'), false);
    // Outdated jobs are not delivered after a reschedule, even when retried later.
    await Job.updateOne({ _id: job._id }, { status: 'pending', nextAttemptAt: new Date(0) }); await notifications.flush();
    assert.equal(sent.filter(item => item.meetingId === retry._id && item.kind === 'meeting_invitation').length, 1);
  } finally {
    failing = false; await notifications.flush(); await Subscription.deleteMany({});
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    webpush.sendNotification = original;
  }
});

test('empty calls are rejected and direct calls ring, connect on answer, and end on decline or departure', async () => {
  const alone = await Conversation.create({ kind: 'group', purpose: 'meeting', name: 'No invitees', createdBy: users[0]._id, members: [{ user: users[0]._id }] });
  const [host, recipient] = await Promise.all([connect(0), connect(1)]);
  assert.equal((await join(host, alone)).success, false);
  assert.equal(await CallSession.countDocuments({ conversation: alone._id }), 0);
  assert.equal((await request(0, '', { ...schedule(), participantIds: [] })).status, 400);
  const first = await join(host, direct, { mode: 'audio', camera: false });
  assert.equal(first.call.phase, 'ringing'); assert.equal(first.call.oneToOne, true); assert.equal(first.call.connectedAt, null);
  const declined = event(host, 'call:ended');
  await command(recipient, 'call:decline', { conversationId: String(direct._id), callId: first.call.id });
  assert.equal((await declined).reason, 'declined');
  const history = (await request(0, '/history')).body.history.find(item => item.callId === first.call.id);
  assert.equal(history.outcome, 'declined');
  const second = await join(host, direct, { mode: 'audio', camera: false });
  const answered = await join(recipient, direct, { callId: second.call.id, mode: 'audio', camera: false });
  assert.equal(answered.call.phase, 'connected'); assert.ok(answered.call.connectedAt);
  const departed = event(host, 'call:ended');
  await command(recipient, 'call:leave', { conversationId: String(direct._id), callId: second.call.id });
  assert.equal((await departed).reason, 'participant_left');
  assert.equal((await join(host, direct, { callId: second.call.id })).success, false);
  host.disconnect(); recipient.disconnect();
});

test('adding someone promotes a direct call to a group and the late guest can join after host handoff', async () => {
  const [host, recipient, guest] = await Promise.all([connect(0), connect(1), connect(2)]);
  const created = (await request(0, '/rooms', { participantIds: [String(users[1]._id)] })).body.room;
  const started = await join(host, created);
  await join(recipient, created, { callId: started.call.id });
  const invited = event(guest, 'call:incoming');
  await command(host, 'call:invite', { conversationId: created._id, callId: started.call.id, participantIds: [String(users[2]._id)] });
  const invitation = await invited; assert.equal(invitation.oneToOne, false);
  await command(host, 'call:leave', { conversationId: created._id, callId: started.call.id });
  const joined = await join(guest, created, { callId: started.call.id });
  assert.equal(joined.success, true); assert.equal(joined.call.participants.length, 2); assert.equal(joined.call.hostId, String(users[1]._id));
  await command(recipient, 'call:end', { conversationId: created._id, callId: started.call.id });
  for (const client of [host, recipient, guest]) client.disconnect();
});

test('concurrent rooms cannot double-connect a user and a busy person is not called twice', async () => {
  const rooms = await Promise.all([1, 2].map(index => request(0, '/rooms', { participantIds: [String(users[index]._id)] })));
  const [first, second, bob] = await Promise.all([connect(0), connect(0), connect(1)]);
  const joined = await Promise.all([join(first, rooms[0].body.room), join(second, rooms[1].body.room)]);
  assert.equal(joined.filter(result => result.success).length, 1);
  const index = joined.findIndex(result => result.success), call = joined[index].call;
  const busyRoom = (await request(1, '/rooms', { participantIds: [String(users[0]._id)] })).body.room;
  const busy = await join(bob, busyRoom); assert.equal(busy.success, false); assert.match(busy.message, /another call/);
  await command([first, second][index], 'call:end', { conversationId: call.conversationId, callId: call.id });
  for (const client of [first, second, bob]) client.disconnect();
});

test('an unanswered direct call expires on the server and cannot be answered afterwards', async () => {
  const instance = createRealtimeServer(express(), { callRingTimeoutMs: 150 });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const host = await connect(0, instance);
  try {
    const timeout = event(host, 'call:ended');
    const started = await join(host, direct);
    assert.equal(started.call.phase, 'ringing');
    assert.equal((await timeout).reason, 'no_answer');
    assert.equal((await join(host, direct, { callId: started.call.id })).success, false);
    await instance.closeCalls();
    const saved = await CallSession.findOne({ callId: started.call.id });
    assert.equal(saved.endReason, 'no_answer'); assert.equal(saved.connectedAt, null);
  } finally { host.disconnect(); await instance.closeCalls(); await new Promise(resolve => instance.io.close(resolve)); }
});

test('graceful shutdown closes attendance before the database disconnects', async () => {
  const alice = await connect(0);
  const started = await join(alice, direct);
  await realtime.closeCalls();
  const session = await CallSession.findOne({ callId: started.call.id }).lean();
  assert.equal(session.endReason, 'server_disconnected');
  assert.ok(session.endedAt); assert.ok(session.attendance[0].leftAt);
  assert.equal((await join(alice, direct)).success, false);
  alice.disconnect();
});
