// No application .env, database, or real mail providers are used by these tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { encryptionKey, encryptPassword, decryptPassword } = require('../src/services/mailCrypto');
const { createMailService, validateMessage } = require('../src/services/mail');
const { createMailHandlers } = require('../src/controllers/mailController');
const MailAccount = require('../src/models/MailAccount');
const User = require('../src/models/User');
process.env.MAIL_ENCRYPTION_KEY = 'ab'.repeat(32);

const draft = { to: 'recipient@example.com', cc: '', subject: 'Hello', text: 'A test message.' };
const account = { email: 'owner@example.com', password: 'mailbox-secret', displayName: 'Owner' };

function fakeProvider(options = {}) {
  const calls = { imap: [], smtp: [], sent: [], flags: [], closed: 0, released: 0 };
  const rows = options.rows || [{ uid: 42, size: 100, flags: new Set(), envelope: { subject: 'Incoming', from: [{ name: 'Sender', address: 'sender@example.com' }], to: [{ address: account.email }] }, source: Buffer.from('From: sender@example.com\r\nTo: owner@example.com\r\nSubject: Incoming\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>Owner</b></p><script>alert(1)</script><img src="https://tracking.example.com/pixel">') }];
  class ImapClient extends EventEmitter {
    constructor(config) { super(); calls.imap.push(config); this.mailbox = { exists: options.total ?? rows.length, uidValidity: 123n }; }
    async connect() { if (options.connectError) throw options.connectError; }
    close() { calls.closed++; }
    async status() { return { unseen: 3, messages: rows.length }; }
    async list() { return [{ path: 'Sent', specialUse: '\\Sent' }]; }
    async getMailboxLock(path, config) { calls.lock = { path, config }; return { release: () => calls.released++ }; }
    async *fetch(range) { calls.range = range; for (const row of rows) yield row; }
    async fetchOne(uid, query, config) { calls.fetch = { uid, query, config }; return options.missing ? false : rows.find(row => String(row.uid) === String(uid)); }
    async messageFlagsAdd(...args) { calls.flags.push(args); }
    async append(...args) { calls.append = args; if (options.appendError) throw new Error('append failed'); }
    async mailboxCreate() {}
  }
  const service = createMailService({ ImapClient, createTransport(config) {
    calls.smtp.push(config);
    return { async verify() { if (options.verifyError) throw options.verifyError; }, close() {}, async sendMail(message) { calls.sent.push(message); if (options.sendError) throw options.sendError; return { messageId: 'test-id', rejected: options.rejected || [] }; } };
  } });
  return { service, calls };
}

function handlersHarness(service = {}) {
  const records = new Map(), receipts = new Map();
  const key = filter => String(filter.user);
  const query = value => ({ then: (resolve, reject) => Promise.resolve(value).then(resolve, reject), select() { return Promise.resolve(value); } });
  const Account = {
    findOne(filter) { return query(records.get(key(filter)) || null); },
    async findOneAndUpdate(filter, update) { records.set(key(filter), { ...records.get(key(filter)), ...update.$set }); },
    async deleteOne(filter) { records.delete(key(filter)); },
  };
  const receiptKey = filter => `${filter.user}:${filter.requestId}`;
  const Submission = {
    async create(record) { if (receipts.has(receiptKey(record))) throw Object.assign(new Error('duplicate'), { code: 11000 }); receipts.set(receiptKey(record), { status: 'sending', ...record }); },
    async findOne(filter) { return receipts.get(receiptKey(filter)); },
    async updateOne(filter, update) { Object.assign(receipts.get(receiptKey(filter)), update.$set); },
  };
  const handlers = createMailHandlers({ Account, Submission, service });
  return { records, receipts, async call(action, { user = 'alice', body = {}, query = {}, params = {} } = {}) {
    const res = { code: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers[action]({ user: { _id: user }, body, query, params }, res);
    return res;
  } };
}
function connected(harness, user = 'alice') {
  harness.records.set(user, { email: account.email, displayName: 'Owner', notificationsEnabled: true, passwordEncrypted: encryptPassword(account.password, user) });
}

test('passwords use randomized authenticated encryption bound to the owning user', () => {
  const one = encryptPassword('secret-password', 'alice'), two = encryptPassword('secret-password', 'alice');
  assert.notEqual(one, two); assert.ok(!one.includes('secret-password'));
  assert.equal(decryptPassword(one, 'alice'), 'secret-password');
  assert.throws(() => decryptPassword(one, 'bob'), /Unable to unlock/);
  assert.throws(() => decryptPassword(one.slice(0, -4) + 'AAAA', 'alice'), /Unable to unlock/);
});

test('mail encryption fails closed without a valid independent key', () => {
  const previous = process.env.MAIL_ENCRYPTION_KEY;
  try { process.env.MAIL_ENCRYPTION_KEY = ''; assert.throws(encryptionKey, /not configured/); }
  finally { process.env.MAIL_ENCRYPTION_KEY = previous; }
});

test('credentials are excluded by the model and kept out of user profiles', () => {
  assert.equal(MailAccount.schema.path('passwordEncrypted').options.select, false);
  assert.equal(User.schema.path('passwordEncrypted'), undefined);
  assert.equal(User.schema.path('mailAccount'), undefined);
});

test('recipient and header validation rejects injection, missing bodies and excess recipients', () => {
  for (const body of [{ to: 'bad' }, { to: 'victim@example.com\r\nBcc: attacker@example.com' }, { subject: 'hello\r\nBcc: attacker@example.com' }, { text: '' }, { text: 'x'.repeat(100001) }, { to: Array.from({ length: 21 }, (_, i) => `r${i}@example.com`).join(',') }]) assert.throws(() => validateMessage({ ...draft, ...body }));
  assert.deepEqual(validateMessage({ ...draft, to: 'a@example.com; b@example.com', from: 'spoof@example.com', html: '<script>bad</script>' }), { ...draft, to: ['a@example.com', 'b@example.com'], cc: [] });
});

test('verification checks IMAP and SMTP using secure fixed hosts without sending', async () => {
  const { service, calls } = fakeProvider();
  await service.verify(account);
  assert.equal(calls.imap[0].host, 'imap.hostinger.com'); assert.equal(calls.imap[0].port, 993); assert.equal(calls.imap[0].secure, true); assert.equal(calls.imap[0].logger, false);
  assert.equal(calls.smtp[0].host, 'smtp.hostinger.com'); assert.equal(calls.smtp[0].port, 465); assert.equal(calls.smtp[0].secure, true);
  assert.equal(calls.sent.length, 0); assert.equal(calls.closed, 1);
});

test('inbox paging reads newest bounded sequences without fetching bodies or marking read', async () => {
  const { service, calls } = fakeProvider({ total: 70 });
  const result = await service.list(account, 'inbox', 2);
  assert.equal(calls.range, '21:45'); assert.equal(result.hasMore, true); assert.equal(result.uidValidity, '123');
  assert.equal(calls.lock.config.readOnly, true); assert.equal(calls.flags.length, 0); assert.equal(calls.released, 1);
  assert.equal(result.messages[0].source, undefined);
});

test('empty mailboxes avoid the IMAP 1:* range', async () => {
  const { service, calls } = fakeProvider({ total: 0 });
  assert.deepEqual((await service.list(account, 'inbox', 1)).messages, []); assert.equal(calls.range, undefined);
});

test('reading uses stable UID validity, produces text, and explicitly marks read', async () => {
  const { service, calls } = fakeProvider();
  const result = await service.read(account, 'inbox', '42', '123');
  assert.match(result.text, /Hello/); assert.equal(result.html, undefined); assert.equal(result.source, undefined); assert.equal(result.seen, true);
  assert.equal(calls.fetch.config.uid, true); assert.deepEqual(calls.flags[0], ['42', ['\\Seen'], { uid: true }]);
  await assert.rejects(service.read(account, 'inbox', '42', '999'), error => error.status === 409);
});

test('large and missing messages fail without marking read, releasing the mailbox', async () => {
  const { service, calls } = fakeProvider({ rows: [{ uid: 42, size: 6 * 1024 * 1024 }] });
  await assert.rejects(service.read(account, 'inbox', '42', '123'), error => error.status === 413);
  assert.equal(calls.flags.length, 0); assert.equal(calls.released, 1);
  await assert.rejects(fakeProvider({ missing: true }).service.read(account, 'inbox', '42', '123'), error => error.status === 404);
});

test('SMTP sender comes from the connected account and delivery survives Sent-copy failure', async () => {
  const { service, calls } = fakeProvider({ appendError: true, rejected: ['reject@example.com'] });
  const result = await service.send(account, validateMessage(draft));
  assert.equal(calls.sent[0].envelope.from, account.email);
  assert.match(calls.sent[0].raw.toString(), /From: Owner <owner@example.com>/);
  assert.equal(result.sentCopySaved, false); assert.deepEqual(result.rejected, ['reject@example.com']); assert.equal(calls.sent.length, 1);
});

test('settings never expose credentials; all mailbox operations scope to authenticated owner', async () => {
  const called = [];
  const harness = handlersHarness({ status: async account => { called.push(account.email); return { unread: 2 }; } }); connected(harness);
  const settings = await harness.call('settings');
  assert.equal(settings.headers['Cache-Control'], 'no-store'); assert.ok(!JSON.stringify(settings.body).includes('password')); assert.ok(!JSON.stringify(settings.body).includes('v1.'));
  const other = await harness.call('status', { user: 'bob', query: { userId: 'alice' } });
  assert.equal(other.body.connected, false); assert.equal(called.length, 0);
  await harness.call('disconnect', { user: 'bob', body: { userId: 'alice' } }); assert.ok(harness.records.has('alice'));
  const status = await harness.call('status'); assert.equal(status.body.unread, 2); assert.deepEqual(called, [account.email]);
});

test('invalid mailbox changes do not overwrite a working connection or leak provider errors', async () => {
  const harness = handlersHarness({ verify: async () => { throw Object.assign(new Error('mailbox-secret raw provider response'), { code: 'EAUTH' }); } }); connected(harness);
  const original = harness.records.get('alice');
  const result = await harness.call('save', { body: { email: 'new@example.com', password: 'bad' } });
  assert.equal(result.code, 422); assert.ok(!JSON.stringify(result.body).includes('mailbox-secret')); assert.equal(harness.records.get('alice'), original);
  assert.equal((await harness.call('save', { body: { email: 'new@example.com' } })).code, 400);
});

test('saving preserves a blank password only for the same mailbox and returns public settings', async () => {
  let verified;
  const harness = handlersHarness({ verify: async account => { verified = account; } }); connected(harness);
  const result = await harness.call('save', { body: { email: account.email, password: '', displayName: 'New Name', notificationsEnabled: false } });
  assert.equal(result.code, 200); assert.equal(verified.password, account.password); assert.equal(result.body.settings.notificationsEnabled, false);
  assert.equal(decryptPassword(harness.records.get('alice').passwordEncrypted, 'alice'), account.password); assert.ok(!JSON.stringify(result.body).includes('password'));
});

test('send retries return the receipt without sending twice and cannot cross users', async () => {
  let sends = 0;
  const harness = handlersHarness({ send: async () => { sends++; return { messageId: 'sent', sentCopySaved: true }; } }); connected(harness);
  const body = { ...draft, requestId: '11111111-1111-4111-8111-111111111111' };
  assert.equal((await harness.call('send', { body })).body.success, true);
  assert.equal((await harness.call('send', { body })).body.success, true); assert.equal(sends, 1);
  assert.equal((await harness.call('send', { body: { ...body, subject: 'Changed' } })).code, 409); assert.equal(sends, 1);
  assert.equal((await harness.call('send', { user: 'bob', body })).code, 409);
});

test('uncertain sends block duplicate retries and invalid input never reserves a send', async () => {
  let sends = 0;
  const harness = handlersHarness({ send: async () => { sends++; throw new Error('lost acknowledgement'); } }); connected(harness);
  const body = { ...draft, requestId: '22222222-2222-4222-8222-222222222222' };
  const bad = await harness.call('send', { body: { ...body, to: 'bad' } });
  assert.equal(bad.code, 400); assert.equal(bad.body.safeToEdit, true); assert.equal(harness.receipts.size, 0);
  assert.equal((await harness.call('send', { body })).code, 502);
  assert.equal((await harness.call('send', { body })).code, 409); assert.equal(sends, 1);
});

test('message endpoints reject folder, page, and stale/invalid identifiers', async () => {
  const harness = handlersHarness(); connected(harness);
  for (const query of [{ folder: '../other' }, { page: '-1' }, { page: 'NaN' }]) assert.equal((await harness.call('list', { query })).code, 400);
  assert.equal((await harness.call('read', { params: { uid: '0' }, query: { uidValidity: '123' } })).code, 400);
  assert.equal((await harness.call('read', { params: { uid: '42' }, query: {} })).code, 400);
});

test('every real mail route rejects unauthenticated HTTP requests before touching a mailbox', async () => {
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/mail', require('../src/routes/mailRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const [method, path] of [['GET', '/settings'], ['PUT', '/settings'], ['DELETE', '/settings'], ['GET', '/status'], ['GET', '/messages'], ['GET', '/messages/42'], ['POST', '/send']]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mail${path}`, { method });
      assert.equal(response.status, 401); assert.equal((await response.json()).success, false);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
