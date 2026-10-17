const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createAIService, readEvents, validateTurn } = require('../src/services/ai');
const { encryptKey, decryptKey, encryptionKey } = require('../src/services/aiCrypto');
const { createAIHandlers } = require('../src/controllers/aiController');
const ConnectionModel = require('../src/models/AIConnection');

process.env.AI_ENCRYPTION_KEY = 'a1'.repeat(32);
const encoder = new TextEncoder();
const clone = value => value == null ? value : structuredClone(value);
const chatId = 'ab'.repeat(12);
const turn = text => ({ text, requestId: randomUUID() });
function sse(events, crlf = false) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + ': heartbeat\n\n';
  const bytes = encoder.encode(crlf ? text.replace(/\n/g, '\r\n') : text);
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
}
function fakeResponse(body, status = 200) { return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } }); }

test('API key encryption is random, authenticated, and bound to the user and provider', () => {
  const first = encryptKey('private-key', 'alice', 'openai');
  assert.notEqual(first, encryptKey('private-key', 'alice', 'openai'));
  assert.equal(decryptKey(first, 'alice', 'openai'), 'private-key');
  assert.throws(() => decryptKey(first, 'bob', 'openai'), /Reconnect/);
  assert.throws(() => decryptKey(first, 'alice', 'claude'), /Reconnect/);
  assert.throws(() => decryptKey(first.replace(/.$/, 'x'), 'alice', 'openai'), /Reconnect/);
  assert.equal(ConnectionModel.schema.path('keyEncrypted').options.select, false);
});
test('missing encryption fails closed and existing mail encryption can be reused with AI domain separation', () => {
  const previous = process.env.AI_ENCRYPTION_KEY, mail = process.env.MAIL_ENCRYPTION_KEY;
  try {
    delete process.env.AI_ENCRYPTION_KEY; delete process.env.MAIL_ENCRYPTION_KEY;
    assert.throws(encryptionKey, /server encryption key/);
    process.env.MAIL_ENCRYPTION_KEY = 'b1'.repeat(32);
    assert.equal(encryptionKey().length, 32);
  } finally { process.env.AI_ENCRYPTION_KEY = previous; if (mail === undefined) delete process.env.MAIL_ENCRYPTION_KEY; else process.env.MAIL_ENCRYPTION_KEY = mail; }
});
test('message validation rejects blank, oversized, and replay-unsafe requests', () => {
  for (const input of [{ text: ' ', requestId: randomUUID() }, { text: 'a'.repeat(12001), requestId: randomUUID() }, { text: {}, requestId: randomUUID() }, { text: 'hello', requestId: 'bad' }]) assert.throws(() => validateTurn(input));
  assert.equal(validateTurn(turn(' hello ')).text, 'hello');
});
test('SSE parser handles split UTF-8, split CRLF, comments, and final data without a blank line', async () => {
  const events = [];
  for await (const event of readEvents(sse([{ text: 'Hello 🌎' }, { text: 'next' }], true))) events.push(event);
  assert.deepEqual(events, [{ text: 'Hello 🌎' }, { text: 'next' }]);
  const final = [];
  for await (const event of readEvents(new Response('data: {"text":"last"}').body)) final.push(event);
  assert.deepEqual(final, [{ text: 'last' }]);
});

for (const provider of ['openai', 'claude', 'gemini']) {
  test(`${provider}: stream adapters preserve context, use fixed hosts/header auth, and detect completion`, async () => {
    let request;
    const events = provider === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Hello 🌎' }, { type: 'response.completed' }]
      : provider === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello 🌎' } }, { type: 'message_stop' }]
        : [{ candidates: [{ content: { parts: [{ text: 'private', thought: true }, { text: 'Hello 🌎' }] }, finishReason: 'STOP' }] }];
    const service = createAIService({ fetchImpl: async (url, options) => { request = { url, ...options }; return fakeResponse(sse(events)); } });
    let text = '';
    const result = await service.generate({ provider, key: 'secret-api-key', model: 'test-model', messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'followup' }], signal: new AbortController().signal, onText: chunk => text += chunk });
    assert.equal(text, 'Hello 🌎'); assert.equal(result.limited, false);
    assert.ok(!request.url.includes('secret-api-key')); assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body);
    if (provider === 'openai') { assert.equal(body.store, false); assert.equal(body.input[2].content, 'followup'); assert.equal(request.headers.Authorization, 'Bearer secret-api-key'); }
    if (provider === 'claude') { assert.equal(body.messages[1].role, 'assistant'); assert.equal(request.headers['x-api-key'], 'secret-api-key'); }
    if (provider === 'gemini') { assert.equal(body.contents[1].role, 'model'); assert.equal(request.headers['x-goog-api-key'], 'secret-api-key'); }
  });
}
test('adapters flag limited replies and reject a stream ending without a completion event', async () => {
  let events = [{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.incomplete' }];
  const service = createAIService({ fetchImpl: async () => fakeResponse(sse(events)) });
  const options = { provider: 'openai', key: 'secret', model: 'gpt-test', messages: [], signal: new AbortController().signal, onText() {} };
  assert.equal((await service.generate(options)).limited, true);
  events = [{ type: 'response.output_text.delta', delta: 'partial' }];
  await assert.rejects(service.generate(options), /interrupted/);
});
test('upstream credentials and raw errors are never reflected; quota failures remain actionable', async () => {
  const service = createAIService({ fetchImpl: async () => new Response('secret-api-key and private prompt', { status: 429 }) });
  await assert.rejects(service.models('openai', 'secret-api-key'), error => error.status === 429 && !error.message.includes('secret-api-key') && /credit/.test(error.message));
});
test('model discovery filters unsupported models, paginates Gemini, and does not generate a paid reply', async () => {
  const requests = [];
  const service = createAIService({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.includes('pageToken=')) return Response.json({ models: [{ name: 'models/gemini-test-pro', displayName: 'Test Pro', supportedGenerationMethods: ['generateContent'] }] });
    return Response.json({ models: [{ name: 'models/gemini-test-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-test-image', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next-page' });
  } });
  assert.equal((await service.models('gemini', 'secret-api-key')).length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => !request.options.body && !request.url.includes('secret-api-key')));
});

// An isolated document store exercises the actual controller filters and atomic
// update contract without application .env, MongoDB, or provider charges.
function harness(service = { async models() { return [{ id: 'gpt-test', name: 'Test GPT' }]; }, async generate({ onText }) { onText('Hello'); return { limited: false }; } }, timeoutMs) {
  const accounts = new Map(), chats = new Map();
  const query = value => ({ select() { return this; }, then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); } });
  const matches = (record, filter) => {
    if (!record || record.user !== filter.user || filter._id && record._id !== filter._id) return false;
    if (filter['activeRequest.expiresAt'] && !(record.activeRequest?.expiresAt <= filter['activeRequest.expiresAt'].$lte)) return false;
    if (filter['activeRequest.requestId']?.$exists === false && record.activeRequest?.requestId) return false;
    if (typeof filter['activeRequest.requestId'] === 'string' && record.activeRequest?.requestId !== filter['activeRequest.requestId']) return false;
    if (filter['messages.requestId'] && record.messages.some(item => item.requestId === filter['messages.requestId'].$ne)) return false;
    if (filter.$expr && record.messages.length !== filter.$expr.$eq[1]) return false;
    return true;
  };
  function update(record, change, options = {}) {
    for (const [key, value] of Object.entries(change.$set || {})) {
      if (key.startsWith('messages.$[')) {
        const field = key.split('.').at(-1), matcher = options.arrayFilters[0], [path, expected] = Object.entries(matcher)[0];
        for (const message of record.messages) if (message[path.split('.')[1]] === expected) message[field] = value;
      } else record[key] = value;
    }
    for (const key of Object.keys(change.$unset || {})) delete record[key];
    if (change.$push) record.messages.push(...clone(change.$push.messages.$each));
    record.updatedAt = new Date();
  }
  const Connection = {
    findOne: filter => query(accounts.get(`${filter.user}:${filter.provider}`)),
    find: filter => query([...accounts.values()].filter(item => item.user === filter.user)),
    async findOneAndUpdate(filter, change) { const record = { ...filter, ...change.$set, updatedAt: new Date() }; accounts.set(`${filter.user}:${filter.provider}`, record); return clone(record); },
    async deleteOne(filter) { accounts.delete(`${filter.user}:${filter.provider}`); return { deletedCount: 1 }; },
  };
  const Conversation = {
    findOne: filter => query(matches(chats.get(filter._id), filter) ? chats.get(filter._id) : null),
    async create(record) { const saved = { ...record, _id: chatId, title: 'New conversation', messages: [], updatedAt: new Date() }; chats.set(chatId, saved); return clone(saved); },
    async updateOne(filter, change, options) { const record = chats.get(filter._id); if (!matches(record, filter)) return { modifiedCount: 0 }; update(record, change, options); return { modifiedCount: 1 }; },
    async findOneAndUpdate(filter, change) { const record = chats.get(filter._id); if (!matches(record, filter)) return null; update(record, change); return clone(record); },
    async deleteOne(filter) { if (!matches(chats.get(filter._id), filter)) return { deletedCount: 0 }; chats.delete(filter._id); return { deletedCount: 1 }; },
    find(filter) {
      let records = [...chats.values()].filter(record => record.user === filter.user && (!filter.title || new RegExp(filter.title.$regex, 'i').test(record.title)));
      const result = { select() { return this; }, sort() { return this; }, skip(count) { records = records.slice(count); return this; }, limit(count) { records = records.slice(0, count); return this; }, async lean() { return records.map(({ _id, title, provider, model, updatedAt }) => ({ _id, title, provider, model, updatedAt })); } };
      return result;
    },
  };
  const handlers = createAIHandlers({ Connection, Conversation, service, timeoutMs });
  const response = () => Object.assign(new EventEmitter(), {
    code: 200, headers: {}, body: null, output: '', headersSent: false, writableEnded: false, destroyed: false,
    set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
    flushHeaders() { this.headersSent = true; }, write(text) { this.output += text; return true; }, end() { this.writableEnded = true; },
  });
  return { accounts, chats, response, async call(action, { user = 'alice', body = {}, params = { id: chatId }, query = {}, res = response() } = {}) { await handlers[action]({ user: { _id: user }, params, body, query }, res); return res; } };
}
async function setup(h) {
  const result = await h.call('connect', { params: { provider: 'openai' }, body: { apiKey: 'private-api-key' } });
  assert.equal(result.code, 200);
  const created = await h.call('create', { body: { provider: 'openai' } });
  assert.equal(created.code, 201);
}

test('connections verify before saving, return no key, and isolate settings/disconnect by owner', async () => {
  const h = harness(); await setup(h);
  const result = await h.call('settings');
  assert.equal(result.body.connections[0].connected, true);
  assert.ok(!JSON.stringify(result.body).includes('private-api-key'));
  assert.ok(!JSON.stringify(result.body).includes('keyEncrypted'));
  assert.equal((await h.call('settings', { user: 'bob' })).body.connections[0].connected, false);
  await h.call('disconnect', { user: 'bob', params: { provider: 'openai' } });
  assert.equal(h.accounts.size, 1);
  assert.ok(!h.accounts.get('alice:openai').keyEncrypted.includes('private-api-key'));
});
test('failed verification preserves an existing working connection', async () => {
  let broken = false;
  const h = harness({ async models() { if (broken) throw new Error('secret-api-key'); return [{ id: 'gpt-test', name: 'Test' }]; } });
  await setup(h); const before = clone(h.accounts.get('alice:openai')); broken = true;
  const result = await h.call('connect', { params: { provider: 'openai' }, body: { apiKey: 'replacement-key' } });
  assert.equal(result.body.success, false); assert.ok(!result.body.message.includes('secret-api-key'));
  assert.deepEqual(h.accounts.get('alice:openai'), before);
});
test('read, rename, delete, list, and send cannot access another user’s conversations', async () => {
  const h = harness(); await setup(h);
  for (const action of ['read', 'rename', 'remove', 'send']) {
    const result = await h.call(action, { user: 'bob', body: { ...turn('steal'), title: 'stolen' } });
    assert.equal(result.body.success, false); assert.ok(result.code >= 400);
  }
  assert.equal((await h.call('list', { user: 'bob' })).body.conversations.length, 0);
  assert.equal(h.chats.get(chatId).title, 'New conversation');
});
test('a stream saves the reply, emits lifecycle events, and request replay never generates twice', async () => {
  let generations = 0;
  const h = harness({ async models() { return [{ id: 'gpt-test', name: 'Test' }]; }, async generate({ onText }) { generations++; onText('Hello 🌎'); return { limited: false }; } });
  await setup(h); const body = turn('Explain streaming');
  const result = await h.call('send', { body });
  assert.match(result.output, /"type":"start"/); assert.match(result.output, /"type":"delta"/); assert.match(result.output, /"type":"done"/);
  const saved = h.chats.get(chatId); assert.equal(saved.messages[1].content, 'Hello 🌎'); assert.equal(saved.messages[1].status, 'complete'); assert.ok(!saved.activeRequest);
  assert.equal((await h.call('send', { body })).code, 409); assert.equal(generations, 1);
});
test('atomic lease serializes concurrent requests and prevents deletion during generation', async () => {
  let release, begun;
  const ready = new Promise(resolve => begun = resolve), gate = new Promise(resolve => release = resolve);
  const h = harness({ async models() { return [{ id: 'gpt-test', name: 'Test' }]; }, async generate({ onText }) { begun(); await gate; onText('done'); return { limited: false }; } });
  await setup(h);
  const pending = h.call('send', { body: turn('first') }); await ready;
  assert.equal((await h.call('send', { body: turn('second') })).code, 409);
  assert.equal((await h.call('remove')).code, 409);
  release(); await pending; assert.equal(h.chats.get(chatId).messages.length, 2);
});
test('provider failures preserve partial text, clear leases, and do not leak raw errors', async () => {
  const h = harness({ async models() { return [{ id: 'gpt-test', name: 'Test' }]; }, async generate({ onText }) { onText('partial reply'); throw new Error('private-api-key'); } });
  await setup(h); const result = await h.call('send', { body: turn('hello') });
  assert.equal(h.chats.get(chatId).messages[1].content, 'partial reply'); assert.equal(h.chats.get(chatId).messages[1].status, 'error');
  assert.ok(!h.chats.get(chatId).activeRequest); assert.ok(!result.output.includes('private-api-key')); assert.match(result.output, /"type":"error"/);
});
test('Stop/disconnect aborts upstream generation and persists a partial reply', async () => {
  let begun;
  const ready = new Promise(resolve => begun = resolve);
  const h = harness({ async models() { return [{ id: 'gpt-test', name: 'Test' }]; }, async generate({ onText, signal }) { onText('partial'); begun(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  await setup(h); const res = h.response(), pending = h.call('send', { body: turn('hello'), res });
  await ready; res.emit('close'); await pending;
  assert.equal(h.chats.get(chatId).messages[1].status, 'stopped'); assert.equal(h.chats.get(chatId).messages[1].content, 'partial');
});
test('expired generations recover on reload instead of permanently locking the conversation', async () => {
  const h = harness(); await setup(h);
  h.chats.get(chatId).activeRequest = { requestId: randomUUID(), expiresAt: new Date(Date.now() - 1000) };
  h.chats.get(chatId).messages = [{ id: randomUUID(), requestId: randomUUID(), role: 'assistant', status: 'pending', content: '' }];
  const result = await h.call('read'); assert.equal(result.body.conversation.generating, false); assert.equal(result.body.conversation.messages[0].status, 'stopped');
});
test('search escapes regular expression syntax and full conversations reject before provider calls', async () => {
  const h = harness(); await setup(h);
  h.chats.get(chatId).title = 'Work [draft]';
  assert.equal((await h.call('list', { query: { q: '[draft]' } })).body.conversations.length, 1);
  assert.equal((await h.call('list', { query: { q: '.*' } })).body.conversations.length, 0);
  h.chats.get(chatId).messages = Array.from({ length: 100 }, () => ({ content: 'previous', requestId: randomUUID() }));
  assert.equal((await h.call('send', { body: turn('hello') })).code, 409);
});
