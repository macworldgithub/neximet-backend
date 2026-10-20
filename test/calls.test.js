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
  realtime = createRealtimeServer(express());
  await new Promise(resolve => realtime.server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  clients.forEach(client => client.disconnect());
  if (realtime) await new Promise(resolve => realtime.io.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) { const stopped = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await stopped; }
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('neximet-calls-test-')) await rm(directory, { recursive: true, force: true });
});
async function connect(index) {
  const client = io(`http://127.0.0.1:${realtime.server.address().port}`, { path: '/api/socket.io', transports: ['websocket'], auth: { token: jwt.sign({ id: users[index]._id }, process.env.JWT_SECRET) }, reconnection: false });
  clients.push(client);
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  return client;
}
const command = (client, event, payload) => client.timeout(5000).emitWithAck(event, payload);
const join = (client, conversation = group, extra = {}) => command(client, 'call:join', { conversationId: String(conversation._id), mode: 'video', microphone: true, camera: true, ...extra });
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
  const a = await join(alice, direct);
  assert.equal((await join(otherTab, direct)).success, false);
  assert.equal((await join(alice, group)).success, false);
  await join(bob, direct);
  const transferred = event(bob, 'call:updated', value => value.hostId === String(users[1]._id));
  alice.disconnect();
  assert.equal((await transferred).participants.length, 1);
  assert.equal((await command(bob, 'call:leave', { conversationId: String(direct._id), callId: a.call.id })).success, true);
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
  await command(bob, 'call:leave', { conversationId: String(direct._id), callId: a.call.id });
  const ended = event(bob, 'call:ended');
  await command(alice, 'call:leave', { conversationId: String(direct._id), callId: a.call.id });
  assert.equal((await ended).callId, a.call.id);
  assert.equal((await join(bob, direct, { callId: a.call.id })).success, false);
  alice.disconnect(); bob.disconnect();
});

test('disabled accounts lose call access on the next command', async () => {
  const client = await connect(9);
  await User.updateOne({ _id: users[9]._id }, { isActive: false });
  await assert.rejects(command(client, 'call:config', {}));
  client.disconnect();
});
