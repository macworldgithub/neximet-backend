// Integration tests use a temporary local MongoDB and never load the application's .env.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const Conversation = require('../src/models/Conversation');
const Message = require('../src/models/Message');
const { createRealtimeServer } = require('../src/services/realtime');
const { io } = require('socket.io-client');
const webpush = require('web-push');
const PushSubscription = require('../src/models/PushSubscription');
const PushJob = require('../src/models/PushJob');

process.env.JWT_SECRET = 'isolated-chat-test-secret';
let mongo, directory, server, secondServer, realtime, secondRealtime, base, mongoUri, alice, bob, carol, inactive, direct;
const clients = [];
const tokens = new Map();
async function port() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}
async function request(user, endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { ...(user ? { Authorization: `Bearer ${tokens.get(String(user._id))}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
}
async function send(user, chat, text, clientId = `test-${crypto.randomUUID()}`) {
  return request(user, `/conversations/${chat}/messages`, { text, clientId });
}
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-chat-test-'));
  const mongoPort = await port();
  const executable = process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod');
  mongo = spawn(executable, ['--replSet', 'chatrs', '--dbpath', directory, '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let startupError;
  mongo.on('error', (error) => { startupError = error; });
  const uri = `mongodb://127.0.0.1:${mongoPort}/chat_tests`;
  const bootstrap = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 300, directConnection: true });
  mongoUri = `mongodb://127.0.0.1:${mongoPort}/chat_cold_start`;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    try { await bootstrap.connect(); break; }
    catch (error) { if (attempt === 39) throw error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  await bootstrap.db().admin().command({ replSetInitiate: { _id: 'chatrs', members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await bootstrap.db().admin().command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 99) throw new Error('Test replica set failed to elect its primary');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await bootstrap.close();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.init(), Conversation.init(), Message.init()]);
  const people = await User.create(['Alice', 'Bob', 'Carol', 'Inactive'].map((name) => ({ name, email: `${name.toLowerCase()}@example.test`, password: 'test-secret', department: 'Software Development', isActive: name !== 'Inactive', baseSalary: 999999 })));
  [alice, bob, carol, inactive] = people;
  for (const person of people) tokens.set(String(person._id), jwt.sign({ id: person._id }, process.env.JWT_SECRET));
  const app = express();
  app.use(express.json());
  app.use('/chat', require('../src/routes/chatRoutes'));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  realtime = createRealtimeServer(app);
  secondRealtime = createRealtimeServer(app);
  server = realtime.server.listen(0, '127.0.0.1');
  secondServer = secondRealtime.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  if (!secondServer.listening) await new Promise((resolve) => secondServer.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/chat`;
});
after(async () => {
  clients.forEach((client) => client.disconnect());
  if (realtime) await new Promise((resolve) => realtime.io.close(resolve));
  if (secondRealtime) await new Promise((resolve) => secondRealtime.io.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) {
    const exit = new Promise((resolve) => mongo.once('exit', resolve));
    mongo.kill(); await exit;
  }
  // The directory is generated by mkdtemp, and checked before recursive removal.
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('neximet-chat-test-')) await rm(directory, { recursive: true, force: true });
});

async function socket(user, target = server, tokenOverride) {
  const client = io(`http://127.0.0.1:${target.address().port}`, { path: '/api/socket.io', transports: ['websocket'], auth: { token: tokenOverride || tokens.get(String(user?._id)) }, reconnection: false, autoConnect: false });
  clients.push(client);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 10000);
    client.once('connect', () => { clearTimeout(timer); resolve(); });
    client.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    client.connect();
  });
  return client;
}
function event(client, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(name, receive); reject(new Error(`Missing ${name} event`)); }, 5000);
    const receive = (value) => { if (predicate(value)) { clearTimeout(timer); client.off(name, receive); resolve(value); } };
    client.on(name, receive);
  });
}

test('cold-start model registration waits for the production database connection and builds unique indexes', async () => {
  const result = await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures', 'chat-cold-start.cjs')], {
    env: { ...process.env, MONGODB_URI: mongoUri },
    windowsHide: true,
    timeout: 15000,
  });
  assert.match(result.stdout, /Cold-start initialization passed/);
});

test('authentication and teammate directory exclude inactive users and private fields', async () => {
  assert.equal((await request(null, '/people')).status, 401);
  assert.equal((await request(inactive, '/people')).status, 401);
  const result = await request(alice, '/people');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.people.map((person) => person.name), ['Bob', 'Carol']);
  assert.equal(JSON.stringify(result.body).includes('999999'), false);
  assert.equal(result.body.people[0].password, undefined);
  assert.equal(result.body.people[0].baseSalary, undefined);
  assert.equal(result.body.people[0].dailyWage, undefined);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
});
test('concurrent direct creation, reverse participants, and uppercase IDs reuse a single conversation', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => request(alice, '/conversations', { kind: 'direct', participantIds: [String(bob._id).toUpperCase()] })));
  assert.ok(results.every((result) => result.status === 201));
  direct = results[0].body.conversation._id;
  assert.ok(results.every((result) => result.body.conversation._id === direct));
  assert.equal((await request(bob, '/conversations', { kind: 'direct', participantIds: [String(alice._id)] })).body.conversation._id, direct);
  assert.equal(await Conversation.countDocuments({ kind: 'direct' }), 1);
});
test('only conversation members can list messages, send, read, type, and download', async () => {
  assert.equal((await request(carol, '/conversations')).body.conversations.length, 0);
  for (const [endpoint, body] of [
    ['messages', undefined], ['messages', { text: 'intrusion', clientId: 'outsider-request' }],
    ['read', { messageIds: [String(new mongoose.Types.ObjectId())] }], ['typing', { typing: true }],
    [`messages/${new mongoose.Types.ObjectId()}/attachment`, undefined],
  ]) assert.equal((await request(carol, `/conversations/${direct}/${endpoint}`, body)).status, 404, endpoint);
  assert.equal((await request(alice, '/conversations/not-an-id/messages')).status, 400);
});
test('validation rejects blank, oversized, malformed and unavailable participants', async () => {
  assert.equal((await send(alice, direct, '   ')).status, 400);
  assert.equal((await send(alice, direct, 'x'.repeat(4001))).status, 400);
  assert.equal((await send(alice, direct, 'valid', 'bad')).status, 400);
  for (const body of [
    { kind: 'direct', participantIds: [String(inactive._id)] },
    { kind: 'group', name: '', participantIds: [String(bob._id), String(carol._id)] },
    { kind: 'group', name: 'Team', participantIds: [String(bob._id)] },
    { kind: 'group', name: 'Team', participantIds: ['bad-id'] },
  ]) assert.equal((await request(alice, '/conversations', body)).status, 400);
  assert.equal((await request(alice, `/conversations/${direct}/messages?before=1&after=2`)).status, 400);
  assert.equal((await request(alice, `/conversations/${direct}/messages?after=-1`)).status, 400);
});
test('message persistence, concurrent retries, unread counts and exact read receipts', async () => {
  const replies = await Promise.all(Array.from({ length: 5 }, () => send(alice, direct, 'Hello Bob', 'same-client-request')));
  assert.ok(replies.every((reply) => reply.status === 201));
  const id = replies[0].body.message._id;
  assert.ok(replies.every((reply) => reply.body.message._id === id));
  assert.equal(await Message.countDocuments({ conversation: direct }), 1);
  assert.equal((await request(bob, '/conversations')).body.unreadCount, 1);
  const loaded = await request(bob, `/conversations/${direct}/messages`);
  assert.equal(loaded.body.messages[0].text, 'Hello Bob');
  assert.equal(loaded.body.messages[0].sender.baseSalary, undefined);
  assert.equal((await request(bob, `/conversations/${direct}/read`, { messageIds: [id] })).status, 200);
  assert.equal((await request(bob, '/conversations')).body.unreadCount, 0);
  assert.ok((await request(alice, `/conversations/${direct}/messages`)).body.messages[0].readBy.includes(String(bob._id)));
  await send(alice, direct, 'New unread message');
  await request(bob, `/conversations/${direct}/read`, { messageIds: [id] });
  assert.equal((await request(bob, '/conversations')).body.unreadCount, 1, 'reading an old page must not mark a new arrival as read');
});
test('group chats provide typing indicators and independent reader receipts', async () => {
  const group = (await request(alice, '/conversations', { kind: 'group', name: 'Delivery team', participantIds: [String(bob._id), String(carol._id)] })).body.conversation;
  assert.equal(group.members.length, 3);
  await request(bob, `/conversations/${group._id}/typing`, { typing: true });
  const typing = (await request(alice, `/conversations/${group._id}/messages`)).body.conversation.members.find((member) => member.user._id === String(bob._id));
  assert.ok(new Date(typing.typingUntil) > new Date());
  const sent = await send(bob, group._id, 'A group update');
  await request(alice, `/conversations/${group._id}/read`, { messageIds: [sent.body.message._id] });
  const readBy = (await request(carol, `/conversations/${group._id}/messages`)).body.messages[0].readBy;
  assert.ok(readBy.includes(String(alice._id)));
  assert.equal(readBy.includes(String(carol._id)), false);
  const afterSend = (await request(alice, `/conversations/${group._id}/messages`)).body.conversation.members.find((member) => member.user._id === String(bob._id));
  assert.equal(afterSend.typingUntil, null);
});
test('files persist privately, can be downloaded by recipients and reject unsupported or large uploads', async () => {
  const form = new FormData();
  form.append('clientId', 'attachment-request'); form.append('text', 'Notes');
  form.append('attachment', new Blob(['team notes'], { type: 'text/plain' }), 'notes.txt');
  const sent = await request(alice, `/conversations/${direct}/messages`, form);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.attachment.data, undefined);
  const id = sent.body.message._id;
  const download = await request(bob, `/conversations/${direct}/messages/${id}/attachment`);
  assert.equal(Buffer.from(download.body).toString(), 'team notes');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request(carol, `/conversations/${direct}/messages/${id}/attachment`)).status, 404);
  assert.ok((await request(bob, `/conversations/${direct}/messages`)).body.messages.every((message) => !message.attachment?.data));
  for (const [name, content] of [['script.html', 'bad'], ['huge.txt', 'x'.repeat(3 * 1024 * 1024 + 1)]]) {
    const upload = new FormData(); upload.append('clientId', 'invalid-file-test'); upload.append('attachment', new Blob([content]), name);
    assert.equal((await request(alice, `/conversations/${direct}/messages`, upload)).status, 400);
  }
});
test('history pagination and forward catchup return every message once in sequence order', async () => {
  const chat = await Conversation.create({ kind: 'group', name: 'History', members: [{ user: alice._id }, { user: bob._id }, { user: carol._id }], createdBy: alice._id, nextSequence: 125 });
  await Message.insertMany(Array.from({ length: 125 }, (_, index) => ({ conversation: chat._id, sender: alice._id, sequence: index + 1, clientId: `history-${index}`, text: `Message ${index + 1}`, readBy: [alice._id] })));
  const latest = (await request(bob, `/conversations/${chat._id}/messages`)).body;
  assert.equal(latest.messages.length, 50); assert.equal(latest.hasMore, true);
  assert.equal(latest.messages[0].sequence, 76); assert.equal(latest.messages[49].sequence, 125);
  const middle = (await request(bob, `/conversations/${chat._id}/messages?before=76`)).body;
  const first = (await request(bob, `/conversations/${chat._id}/messages?before=26`)).body;
  assert.equal(first.hasMore, false);
  assert.deepEqual([...first.messages, ...middle.messages, ...latest.messages].map((message) => message.sequence), Array.from({ length: 125 }, (_, index) => index + 1));
  const forward = (await request(bob, `/conversations/${chat._id}/messages?after=1`)).body;
  assert.equal(forward.hasMore, true); assert.equal(forward.messages[0].sequence, 2); assert.equal(forward.messages[49].sequence, 51);
});

test('WebSocket authentication rejects invalid tokens and inactive accounts', async () => {
  await assert.rejects(socket(null, server, 'invalid-token'));
  await assert.rejects(socket(inactive), /inactive/);
});

test('separate socket instances broadcast private persisted messages, delivery, seen and typing', async () => {
  const sender = await socket(alice), recipient = await socket(bob, secondServer), outsider = await socket(carol);
  assert.equal(sender.io.engine.transport.name, 'websocket');
  const chat = (await request(alice, '/conversations', { kind: 'direct', participantIds: [String(bob._id)] })).body.conversation._id;
  let leaked = false;
  outsider.on('chat:message', () => { leaked = true; });
  const typing = event(sender, 'chat:typing', (value) => value.userId === String(bob._id) && value.typingUntil);
  assert.equal((await recipient.timeout(5000).emitWithAck('chat:typing', { conversationId: chat, typing: true })).success, true);
  assert.ok(new Date((await typing).typingUntil) > new Date());
  const incoming = event(recipient, 'chat:message', (value) => value.message.clientId === 'socket-live-message');
  const sent = await sender.timeout(10000).emitWithAck('chat:send', { conversationId: chat, text: 'Socket cross-instance message', clientId: 'socket-live-message' });
  assert.equal(sent.success, true);
  assert.equal((await incoming).message._id, sent.message._id);
  assert.equal(sent.message.deliveredBy.includes(String(bob._id)), false);
  const delivered = event(sender, 'chat:receipt', (value) => value.status === 'delivered' && value.messageIds.includes(sent.message._id));
  await recipient.timeout(5000).emitWithAck('chat:delivered', { conversationId: chat, messageIds: [sent.message._id] });
  await delivered;
  let stored = await Message.findById(sent.message._id);
  assert.ok(stored.deliveredBy.some((id) => String(id) === String(bob._id)));
  assert.equal(stored.readBy.some((id) => String(id) === String(bob._id)), false);
  const seen = event(sender, 'chat:receipt', (value) => value.status === 'read' && value.messageIds.includes(sent.message._id));
  await recipient.timeout(5000).emitWithAck('chat:read', { conversationId: chat, messageIds: [sent.message._id] });
  await seen;
  stored = await Message.findById(sent.message._id);
  assert.ok(stored.readBy.some((id) => String(id) === String(bob._id)));
  for (const name of ['chat:send', 'chat:read', 'chat:delivered', 'chat:typing']) {
    const response = await outsider.timeout(5000).emitWithAck(name, { conversationId: chat, text: 'Not allowed', clientId: 'outsider-socket', messageIds: [sent.message._id], typing: true });
    assert.equal(response.success, false, name);
  }
  assert.equal(leaked, false);
  const retry = await sender.timeout(10000).emitWithAck('chat:send', { conversationId: chat, text: 'Socket cross-instance message', clientId: 'socket-live-message' });
  assert.equal(retry.message._id, sent.message._id);
  const disconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Disabled socket retained access')), 5000);
    sender.once('disconnect', () => { clearTimeout(timer); resolve(); });
  });
  await User.updateOne({ _id: alice._id }, { isActive: false });
  try {
    await recipient.timeout(10000).emitWithAck('chat:send', { conversationId: chat, text: 'Account-access check', clientId: 'socket-inactive-recipient' });
    await disconnected;
  } finally { await User.updateOne({ _id: alice._id }, { isActive: true }); }
  sender.disconnect(); recipient.disconnect(); outsider.disconnect();
});

test('reconnect delivery catchup covers unread conversations without marking seen', async () => {
  const chat = (await request(alice, '/conversations', { kind: 'direct', participantIds: [String(carol._id)] })).body.conversation._id;
  const sent = (await send(alice, chat, 'Arrived while offline')).body.message;
  let received = false, pages = 0;
  while (pages++ < 10) {
    const catchup = (await request(carol, '/deliveries')).body.messages;
    if (!catchup.length) break;
    received ||= catchup.some((message) => message._id === sent._id);
    const groups = new Map();
    for (const message of catchup) groups.set(message.conversation, [...(groups.get(message.conversation) || []), message._id]);
    for (const [conversationId, messageIds] of groups) await request(carol, `/conversations/${conversationId}/delivered`, { messageIds });
  }
  assert.ok(received);
  assert.ok(pages > 2, 'delivery catchup must page through other unread conversations');
  const stored = await Message.findById(sent._id);
  assert.ok(stored.deliveredBy.some((id) => String(id) === String(carol._id)));
  assert.equal(stored.readBy.some((id) => String(id) === String(carol._id)), false);
  assert.equal((await request(carol, '/deliveries')).body.messages.some((message) => message._id === sent._id), false);
});

test('push subscriptions are private, retry-safe and delivery tokens never mark seen', async () => {
  const keys = webpush.generateVAPIDKeys();
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.WEB_PUSH_SUBJECT = 'https://neximet.test';
  const p256dh = require('node:crypto').createECDH('prime256v1').generateKeys().toString('base64url');
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/isolated-test-device', keys: { p256dh, auth: Buffer.alloc(16, 7).toString('base64url') } };
  assert.equal((await request(bob, '/push/subscriptions', { ...subscription, endpoint: 'http://127.0.0.1/private' })).status, 400);
  assert.equal((await request(bob, '/push/subscriptions', subscription)).status, 200);
  assert.equal((await request(alice, '/push/subscriptions', { endpoint: subscription.endpoint }, 'DELETE')).status, 200);
  assert.equal(await PushSubscription.countDocuments({ user: bob._id }), 1);
  const original = webpush.sendNotification;
  const notifications = [];
  webpush.sendNotification = async (target, payload) => { notifications.push(JSON.parse(payload)); return { statusCode: 201 }; };
  try {
    const chat = (await request(alice, '/conversations', { kind: 'direct', participantIds: [String(bob._id)] })).body.conversation._id;
    const sent = (await send(alice, chat, 'Background push message', 'push-idempotent-message')).body.message;
    await send(alice, chat, 'Background push message', 'push-idempotent-message');
    assert.equal(notifications.length, 1);
    const payload = notifications[0];
    assert.equal(payload.userId, String(bob._id));
    assert.equal(payload.url, `/chat?conversation=${chat}`);
    assert.equal((await request(null, '/push/delivered', { receiptToken: tokens.get(String(bob._id)) })).status, 401);
    assert.equal((await request(null, '/push/delivered', { receiptToken: payload.receiptToken })).status, 200);
    const stored = await Message.findById(sent._id);
    assert.ok(stored.deliveredBy.some((id) => String(id) === String(bob._id)));
    assert.equal(stored.readBy.some((id) => String(id) === String(bob._id)), false);
    await assert.rejects(socket(null, server, payload.receiptToken));
    let attempts = 0;
    webpush.sendNotification = async () => { attempts++; throw Object.assign(new Error('Temporary push outage'), { statusCode: 503 }); };
    const deferred = (await send(alice, chat, 'Push should retry', 'retryable-push-message')).body.message;
    await send(alice, chat, 'Push should retry', 'retryable-push-message');
    assert.equal(attempts, 1, 'message retries must respect notification backoff');
    const job = await PushJob.findOne({ message: deferred._id });
    assert.equal(job.status, 'pending');
    await PushJob.updateOne({ _id: job._id }, { nextAttemptAt: new Date(0) });
    webpush.sendNotification = async (target, value) => { notifications.push(JSON.parse(value)); return { statusCode: 201 }; };
    await Promise.all([request(alice, '/push/flush', {}), request(carol, '/push/flush', {})]);
    assert.equal(notifications.length, 2, 'concurrent outbox flushes must not duplicate a delivery');
    assert.equal((await PushJob.findById(job._id)).status, 'sent');
    webpush.sendNotification = async () => { throw Object.assign(new Error('Expired device'), { statusCode: 410 }); };
    assert.equal((await send(alice, chat, 'Expired subscription')).status, 201);
    assert.equal(await PushSubscription.countDocuments({ endpoint: subscription.endpoint }), 0);
    assert.ok(await PushJob.exists({ status: 'failed' }));
    assert.equal((await request(null, '/push/delivered', { receiptToken: payload.receiptToken })).status, 401);
  } finally {
    webpush.sendNotification = original;
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY; delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY; delete process.env.WEB_PUSH_SUBJECT;
  }
});
