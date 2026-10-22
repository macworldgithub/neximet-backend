// No application .env, database, or real mail providers are used by these tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { encryptionKey, encryptPassword, decryptPassword } = require('../src/services/mailCrypto');
const { createMailService, validateMessage } = require('../src/services/mail');
const { createMailHandlers } = require('../src/controllers/mailController');
const MailAccount = require('../src/models/MailAccount');
const User = require('../src/models/User');
const sharp = require('sharp');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const { attachmentPreviews } = require('../src/services/mailAttachments');
const { formatMailBody, plainTextHtml } = require('../src/services/mailHtml');
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
  assert.match(result.text, /Hello/); assert.match(result.html, /Hello <b>Owner<\/b>/); assert.doesNotMatch(result.html, /<script/i); assert.equal(result.source, undefined); assert.equal(result.seen, true);
  assert.equal(calls.fetch.config.uid, true); assert.deepEqual(calls.flags[0], ['42', ['\\Seen'], { uid: true }]);
  await assert.rejects(service.read(account, 'inbox', '42', '999'), error => error.status === 409);
});

test('reading multipart email includes visible previews for attachments and embedded CID images', async () => {
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#5470f4' } }).png().toBuffer();
  const source = await new MailComposer({
    from: 'sender@example.com', to: account.email, subject: 'Images',
    html: '<p>See the photo</p><img src="cid:embedded-photo"><img src="https://tracking.example.com/pixel">',
    attachments: [
      { filename: 'photo.png', content: png, contentType: 'image/png' },
      { filename: 'embedded.png', content: png, contentType: 'image/png', cid: 'embedded-photo' },
      { filename: 'notes.pdf', content: Buffer.from('%PDF-test'), contentType: 'application/pdf' },
    ],
  }).compile().build();
  const { service, calls } = fakeProvider({ rows: [{ uid: 42, size: source.length, source, flags: new Set() }] });
  const result = await service.read(account, 'inbox', '42', '123');
  assert.equal(result.attachments.length, 3);
  for (const filename of ['photo.png', 'embedded.png']) {
    const item = result.attachments.find(attachment => attachment.filename === filename);
    assert.equal(item.isImage, true);
    assert.match(item.preview.dataUrl, /^data:image\/webp;base64,/);
    const decoded = await sharp(Buffer.from(item.preview.dataUrl.split(',')[1], 'base64')).metadata();
    assert.equal(decoded.format, 'webp'); assert.equal(decoded.width, 32); assert.equal(decoded.height, 24);
    assert.equal(item.content, undefined);
  }
  assert.equal(result.attachments.find(item => item.filename === 'embedded.png').inline, true);
  assert.equal(result.attachments.find(item => item.filename === 'notes.pdf').preview, undefined);
  assert.match(result.html, /src="data:image\/webp;base64,/); assert.equal(result.hasRemoteImages, true); assert.equal(result.source, undefined);
  assert.equal(result.attachments.find(item => item.filename === 'embedded.png').renderedInline, true);
  assert.equal(result.attachments.find(item => item.filename === 'photo.png').renderedInline, false);
  assert.ok(!JSON.stringify(result.attachments).includes('https://tracking.example.com'));
  assert.equal(calls.flags.length, 1);
});

test('previews orient and resize photos and do not trust attachment MIME types', async () => {
  const jpeg = await sharp({ create: { width: 1800, height: 900, channels: 3, background: '#123456' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const [result] = await attachmentPreviews([{ filename: 'photo.bin', contentType: 'application/octet-stream', size: jpeg.length, content: jpeg }]);
  assert.equal(result.isImage, true); assert.equal(result.preview.width, 600); assert.equal(result.preview.height, 1200);
  const decoded = await sharp(Buffer.from(result.preview.dataUrl.split(',')[1], 'base64')).metadata();
  assert.equal(decoded.orientation, undefined); assert.equal(decoded.exif, undefined);
});

test('corrupt images and SVG disguised as PNG do not prevent viewing other attachments', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await attachmentPreviews([
    { filename: 'evil.png', contentType: 'image/png', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    { filename: 'broken.png', contentType: 'image/png', content: Buffer.from('89504e470d0a1a0a0000000000000000', 'hex') },
    { filename: 'real.png', contentType: 'image/png', size: png.length, content: png },
  ]);
  assert.equal(result[0].preview, undefined); assert.equal(result[1].preview, undefined);
  assert.ok(result[2].preview); assert.ok(!JSON.stringify(result).includes('<script>'));
});

test('image preview work is bounded for emails with many image parts', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await attachmentPreviews(Array.from({ length: 22 }, (_, index) => ({ filename: `${index}.png`, content: png, size: png.length, contentType: 'image/png' })));
  assert.equal(result.length, 22); assert.equal(result.filter(item => item.preview).length, 20);
  assert.equal(result[20].isImage, true); assert.equal(result[20].preview, undefined);
});

test('complex photos get smaller previews and total preview bytes stay bounded', async () => {
  const png = await sharp(require('node:crypto').randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } }).png().toBuffer();
  const attachments = Array.from({ length: 6 }, (_, index) => ({ filename: `photo${index}.png`, content: png, size: png.length, contentType: 'image/png' }));
  const result = await attachmentPreviews(attachments);
  assert.ok(result[0].preview); assert.equal(result[0].preview.width, 600);
  let total = 0;
  for (const item of result) if (item.preview) {
    const size = Buffer.from(item.preview.dataUrl.split(',')[1], 'base64').length;
    assert.ok(size <= 256 * 1024); total += size;
  }
  assert.ok(total <= 1024 * 1024);
});

test('HTML email retains sender formatting and quoted replies instead of generated greater-than markers', () => {
  const html = '<style>.original{margin-bottom:24px;font-family:Arial}</style><div class="original" style="color:#111;font-size:16px"><p>Appreciate that, thanks Morgan</p><p>On Friday, Morgan wrote:</p><blockquote><p>Me again,</p><p>My brain hurts</p><ul><li>These messages will <strong>only continue</strong> if:</li></ul><a href="mailto:sender@example.com">Sender</a><table cellpadding="4"><tr><td>Original table</td></tr></table></blockquote></div>';
  const result = formatMailBody({ html, text: 'Appreciate that\n> Me again,\n> My brain hurts' });
  assert.match(result.html, /<blockquote>/); assert.match(result.html, /<strong>only continue<\/strong>/);
  assert.match(result.html, /<style>\.original/); assert.match(result.html, /font-size:16px/); assert.match(result.html, /<table cellpadding="4">/);
  assert.match(result.html, /href="mailto:sender@example.com"/); assert.match(result.html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(result.html, /&gt; Me again|&gt; My brain hurts/);
});

test('plain-text quote markers become nested visual quotes without changing real greater-than comparisons', () => {
  const result = formatMailBody({ text: 'New reply\n\n> Earlier reply\n> > Oldest reply\n3 > 2 and <script>alert(1)</script>\n>\n> Back to earlier' });
  assert.equal((result.html.match(/<blockquote/g) || []).length, 3);
  assert.match(result.html, /3 &gt; 2 and &lt;script&gt;/);
  assert.doesNotMatch(result.html, /&gt; Earlier|&gt; Oldest/);
  assert.doesNotMatch(result.html, /<script>/);
});

test('email HTML removes active content, unsafe links and browser navigation directives', () => {
  const html = '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><link rel="stylesheet" href="https://evil.test/style.css"><script>alert(document.cookie)</script><iframe srcdoc="bad">hidden</iframe><object data="bad">hidden</object><form action="https://evil.test"><input name="password"></form><svg onload="bad()"><script>bad()</script></svg><p onclick="bad()">Safe</p><a href="javascript:alert(1)" ping="https://evil.test" target="_top">Click</a><img src="data:image/svg+xml,<svg onload=bad()>"><img src="//evil.test/tracker"><img src="/api/auth/me">';
  const result = formatMailBody({ html });
  assert.match(result.html, /<p>Safe<\/p>/);
  assert.doesNotMatch(result.html, /<(?:script|iframe|object|form|input|svg|base|meta|link)\b|\bonclick=|\bonload=|\bping=|javascript:|image\/svg|target="_top"/i);
  assert.doesNotMatch(result.html, /<img/);
});

test('only valid attached CID previews are inserted at their original position', () => {
  const attachments = [
    { filename: 'logo.png', contentId: '<logo@example.test>', preview: { dataUrl: 'data:image/webp;base64,UklGRg==', width: 10, height: 10 } },
    { filename: 'unused.png', contentId: 'unused', preview: { dataUrl: 'data:image/webp;base64,UklGRg==', width: 10, height: 10 } },
    { filename: 'broken.png', contentId: 'broken' },
  ];
  const result = formatMailBody({ html: '<p>Before</p><img src="cid:logo%40example.test"><p>After</p><img src="cid:missing"><img src="cid:broken">' }, attachments);
  assert.match(result.html, /Before<\/p><img src="data:image\/webp;base64,UklGRg==" \/><p>After/);
  assert.equal(result.attachments[0].renderedInline, true); assert.equal(result.attachments[1].renderedInline, false); assert.equal(result.attachments[2].renderedInline, false);
  assert.doesNotMatch(result.html, /cid:/);
});

test('sent plain-text replies also contain an HTML alternative with formatted quotes', async () => {
  const { service, calls } = fakeProvider();
  await service.send(account, validateMessage({ ...draft, text: 'Thanks\n\n> Earlier reply\n>> Older reply' }));
  const parsed = await require('mailparser').simpleParser(calls.sent[0].raw);
  assert.match(parsed.html, /<blockquote/); assert.doesNotMatch(parsed.html, /&gt; Earlier reply/);
  assert.match(parsed.text, /> Earlier reply/);
  assert.doesNotMatch(plainTextHtml('Hello <b>literal</b>'), /<b>/);
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

const forwardSource = { folder: 'inbox', uid: '42', uidValidity: '123', includeAttachments: true };
test('forward validation permits an optional note, validates source identity, and ignores client attachments/HTML', () => {
  const result = validateMessage({ ...draft, text: '', forward: forwardSource, html: '<script>unsafe</script>', attachments: [{ path: 'C:/private.txt' }] });
  assert.equal(result.text, ''); assert.deepEqual(result.forward, forwardSource); assert.equal('html' in result, false); assert.equal('attachments' in result, false);
  for (const forward of [null, {}, { ...forwardSource, folder: '../mailbox' }, { ...forwardSource, uid: '0' }, { ...forwardSource, uid: '4294967296' }, { ...forwardSource, uidValidity: '' }, { ...forwardSource, includeAttachments: 'true' }]) {
    assert.throws(() => validateMessage({ ...draft, forward }), /forwarded message is invalid/);
  }
});
test('forwarding preserves formatted content, original attachment bytes and embedded images while using only new recipients', async () => {
  const pdf = Buffer.from('original attachment bytes'), image = Buffer.from('original inline image bytes');
  const original = await new MailComposer({ from: 'Original Sender <original@example.com>', to: 'owner@example.com', cc: 'old-copy@example.com', bcc: 'private-copy@example.com',
    subject: 'Source subject', text: 'Original body', html: '<p><b>Original body</b></p><img src="cid:original-image"/><script>bad()</script>',
    attachments: [{ filename: 'report.pdf', content: pdf, contentType: 'application/pdf' }, { filename: 'photo.png', content: image, cid: 'original-image', contentType: 'image/png' }],
  }).compile().build();
  const { service, calls } = fakeProvider({ rows: [{ uid: 42, size: original.length, source: original }] });
  const message = await service.prepareForward(account, validateMessage({ ...draft, to: 'new@example.com;second@example.com', cc: 'new-copy@example.com', subject: 'Fwd: Source subject', text: 'Please review.', forward: forwardSource }));
  assert.match(message.html, /<b>Original body<\/b>/); assert.match(message.html, /cid:original-image/); assert.doesNotMatch(message.html, /script|bad\(\)/);
  assert.match(message.text, /Forwarded message/); assert.match(message.text, /Original Sender/); assert.match(message.text, /Please review/); assert.doesNotMatch(message.text, /private-copy/);
  assert.equal(calls.flags.length, 0); assert.equal(calls.lock.config.readOnly, true); assert.equal(calls.released, 1);
  await service.send(account, message);
  assert.deepEqual(calls.sent[0].envelope.to, ['new@example.com', 'second@example.com', 'new-copy@example.com']);
  const forwarded = await simpleParser(calls.sent[0].raw);
  assert.equal(forwarded.from.value[0].address, account.email); assert.equal(forwarded.subject, 'Fwd: Source subject'); assert.equal(forwarded.attachments.length, 2);
  assert.deepEqual(forwarded.attachments.find(item => item.filename === 'report.pdf').content, pdf);
  assert.deepEqual(forwarded.attachments.find(item => item.filename === 'photo.png').content, image);
});
test('forwarding can omit attachments and rejects stale, missing or oversized originals before SMTP', async () => {
  const original = await new MailComposer({ from: 'sender@example.com', subject: 'Original', html: '<p>Body</p><img src="cid:photo"/>', attachments: [{ filename: 'photo.png', content: Buffer.from('picture'), cid: 'photo' }] }).compile().build();
  const { service, calls } = fakeProvider({ rows: [{ uid: 42, size: original.length, source: original }] });
  const message = await service.prepareForward(account, validateMessage({ ...draft, forward: { ...forwardSource, folder: 'sent', includeAttachments: false } }));
  assert.equal(message.attachments.length, 0); assert.doesNotMatch(message.html, /cid:photo/); assert.equal(calls.lock.path, 'Sent');
  await assert.rejects(service.prepareForward(account, { ...validateMessage(draft), forward: { ...forwardSource, uidValidity: '456' } }), error => error.status === 409);
  await assert.rejects(fakeProvider({ missing: true }).service.prepareForward(account, { ...validateMessage(draft), forward: forwardSource }), error => error.status === 404);
  const large = fakeProvider({ rows: [{ uid: 42, size: 6 * 1024 * 1024 }] });
  await assert.rejects(large.service.prepareForward(account, { ...validateMessage(draft), forward: forwardSource }), error => error.status === 413);
  assert.equal(calls.sent.length, 0); assert.equal(large.calls.sent.length, 0);
});
test('forward receipts are retry safe and source failures leave the unsent draft editable', async () => {
  let prepared = 0, sent = 0, owner;
  const harness = handlersHarness({ prepareForward: async (account, message) => { prepared++; owner = account.email; return { ...message, text: 'Original plus note' }; }, send: async () => { sent++; return { messageId: 'forwarded', sentCopySaved: true }; } }); connected(harness);
  const body = { ...draft, text: '', forward: forwardSource, userId: 'other-user', requestId: '33333333-3333-4333-8333-333333333333' };
  assert.equal((await harness.call('send', { body })).body.success, true); assert.equal(owner, account.email);
  assert.equal((await harness.call('send', { body })).body.success, true); assert.equal(prepared, 1); assert.equal(sent, 1);
  assert.equal((await harness.call('send', { body: { ...body, forward: { ...forwardSource, includeAttachments: false } } })).code, 409);
  const missing = handlersHarness({ prepareForward: async () => { throw Object.assign(Error('Original message not found.'), { status: 404 }); } }); connected(missing);
  const failed = await missing.call('send', { body }); assert.equal(failed.code, 404); assert.equal(failed.body.safeToEdit, true); assert.equal(missing.receipts.size, 0);
});
