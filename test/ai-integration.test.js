// Real HTTP/auth/MongoDB, isolated local storage, and entirely mocked AI providers.
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
const User = require('../src/models/User');
const Connection = require('../src/models/AIConnection');
const Conversation = require('../src/models/AIConversation');
const { createAIRouter } = require('../src/routes/aiRoutes');
const { providerError } = require('../src/services/ai');

process.env.JWT_SECRET = 'isolated-ai-test-secret';
process.env.AI_ENCRYPTION_KEY = 'c1'.repeat(32);
let directory, mongo, server, base, alice, bob, chat, generate;
const tokens = new Map();
async function request(user, endpoint, body, method = body ? 'POST' : 'GET', signal) {
  return fetch(`${base}${endpoint}`, { method, signal, headers: { ...(user ? { Authorization: `Bearer ${tokens.get(String(user._id))}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-ai-test-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const executable = process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod');
  mongo = spawn(executable, ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let startupError;
  mongo.on('error', error => startupError = error);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ai_tests`, { serverSelectionTimeoutMS: 300 }); break; }
    catch (error) { if (attempt === 39) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  await Promise.all([User.init(), Connection.init(), Conversation.init()]);
  [alice, bob] = await User.create(['Alice', 'Bob'].map(name => ({ name, email: `${name.toLowerCase()}@ai.example.test`, password: 'isolated-test-password', department: 'Software Development' })));
  for (const user of [alice, bob]) tokens.set(String(user._id), jwt.sign({ id: user._id }, process.env.JWT_SECRET));
  generate = async ({ onText }) => { onText('Saved answer'); return { limited: false }; };
  const app = express(); app.use(express.json());
  app.use('/ai', createAIRouter({ service: { async models() { return [{ id: 'gpt-test', name: 'Test GPT' }]; }, async generate(options) { return generate(options); } } }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/ai`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) { const exited = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await exited; }
  // Resolve and check the generated absolute path before removing only this test's storage.
  const target = directory && path.resolve(directory), root = path.resolve(os.tmpdir());
  if (target && path.dirname(target) === root && path.basename(target).startsWith('neximet-ai-test-')) await rm(target, { recursive: true, force: true });
});

test('all production AI routes reject unauthenticated requests', async () => {
  for (const [method, endpoint] of [['GET', '/connections'], ['PUT', '/connections/openai'], ['DELETE', '/connections/openai'], ['GET', '/conversations'], ['POST', '/conversations'], ['GET', '/conversations/' + 'ab'.repeat(12)], ['PATCH', '/conversations/' + 'ab'.repeat(12)], ['DELETE', '/conversations/' + 'ab'.repeat(12)], ['POST', '/conversations/' + 'ab'.repeat(12) + '/messages']]) {
    const response = await request(null, endpoint, undefined, method); assert.equal(response.status, 401); await response.body.cancel();
  }
});
test('actual MongoDB connections encrypt and hide keys, enforce the unique owner/provider index, and create owned chats', async () => {
  const response = await request(alice, '/connections/openai', { apiKey: 'private-provider-api-key' }, 'PUT');
  assert.equal(response.status, 200); const saved = await response.json(); assert.ok(!JSON.stringify(saved).includes('private-provider-api-key')); assert.ok(!JSON.stringify(saved).includes('keyEncrypted'));
  const connection = await Connection.findOne({ user: alice._id }); assert.equal(connection.keyEncrypted, undefined);
  await assert.rejects(Connection.create({ user: alice._id, provider: 'openai', keyEncrypted: 'test', defaultModel: 'gpt-test' }), error => error.code === 11000);
  const created = await request(alice, '/conversations', { provider: 'openai' }); assert.equal(created.status, 201); chat = (await created.json()).conversation;
  const own = await request(alice, `/conversations/${chat._id}`); assert.equal(own.status, 200); await own.body.cancel();
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const other = await request(bob, `/conversations/${chat._id}`, method === 'PATCH' ? { title: 'stolen' } : undefined, method); assert.ok(other.status >= 400); await other.body.cancel();
  }
  assert.equal((await (await request(bob, '/conversations')).json()).conversations.length, 0);
});
test('real positional array updates save streamed replies and duplicate requests cannot buy another generation', async () => {
  const body = { text: 'Explain the plan', requestId: crypto.randomUUID() };
  const response = await request(alice, `/conversations/${chat._id}/messages`, body);
  assert.equal(response.status, 200); assert.match(await response.text(), /"type":"done"/);
  const saved = await Conversation.findById(chat._id);
  assert.equal(saved.messages.length, 2); assert.equal(saved.messages[1].content, 'Saved answer'); assert.equal(saved.messages[1].status, 'complete'); assert.ok(!saved.activeRequest?.requestId);
  const duplicate = await request(alice, `/conversations/${chat._id}/messages`, body); assert.equal(duplicate.status, 409); await duplicate.body.cancel();
});
test('concurrent HTTP sends respect the MongoDB lease and stale pending replies recover', async () => {
  let release, begun;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => begun = resolve);
  generate = async ({ onText }) => { begun(); await gate; onText('Concurrent answer'); return { limited: false }; };
  const pending = request(alice, `/conversations/${chat._id}/messages`, { text: 'First concurrent send', requestId: crypto.randomUUID() });
  await ready;
  const second = await request(alice, `/conversations/${chat._id}/messages`, { text: 'Second concurrent send', requestId: crypto.randomUUID() });
  assert.equal(second.status, 409); await second.body.cancel();
  release(); const first = await pending; assert.match(await first.text(), /"type":"done"/);
  await Conversation.updateOne({ _id: chat._id }, { $set: { activeRequest: { requestId: 'expired', expiresAt: new Date(Date.now() - 1000) } }, $push: { messages: { id: crypto.randomUUID(), requestId: crypto.randomUUID(), role: 'assistant', status: 'pending', content: '' } } });
  const recovered = await (await request(alice, `/conversations/${chat._id}`)).json();
  assert.equal(recovered.conversation.generating, false); assert.equal(recovered.conversation.messages.at(-1).status, 'stopped');
});
test('a billing failure persists its safe cause through MongoDB and a subsequent HTTP read', async () => {
  generate = async () => { throw providerError(400, { provider: 'claude', error: { type: 'invalid_request_error', message: 'Your credit balance is too low. private-provider-api-key' } }); };
  const response = await request(alice, `/conversations/${chat._id}/messages`, { text: 'Billing test', requestId: crypto.randomUUID() });
  const stream = await response.text(); assert.match(stream, /ai_billing_required/); assert.ok(!stream.includes('private-provider-api-key'));
  const saved = await (await request(alice, `/conversations/${chat._id}`)).json();
  assert.equal(saved.conversation.messages.at(-1).errorCode, 'ai_billing_required');
  assert.match(saved.conversation.messages.at(-1).errorMessage, /Claude API credits/);
});
