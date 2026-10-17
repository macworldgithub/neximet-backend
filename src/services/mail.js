const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const { attachmentPreviews } = require('./mailAttachments');

const MAX_MESSAGE_SIZE = 5 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const isEmail = value => typeof value === 'string' && value.length <= 254 && /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(value);
const addresses = list => (list || []).map(item => ({ name: item.name || '', address: item.address || '' }));
function recipients(value, required) {
  if (typeof value !== 'string' || value.length > 6000) fail('Enter valid recipient email addresses.');
  const values = value.split(/[;,]/).map(item => item.trim()).filter(Boolean);
  if ((required && !values.length) || values.length > 20 || values.some(item => !isEmail(item))) fail('Enter up to 20 valid email addresses, separated by commas.');
  return [...new Set(values)];
}
function validateMessage(body) {
  const to = recipients(body.to, true), cc = recipients(body.cc || '', false);
  if (to.length + cc.length > 20) fail('A message can have at most 20 recipients.');
  if (typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 998 || /[\r\n]/.test(body.subject)) fail('Enter a subject of up to 998 characters.');
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 100000) fail('Enter a message of up to 100,000 characters.');
  // Sender and reply headers are constructed server-side, never accepted from the browser.
  return { to, cc, subject: body.subject.trim(), text: body.text };
}
const summary = message => ({
  uid: message.uid,
  subject: message.envelope?.subject || '(No subject)',
  from: addresses(message.envelope?.from),
  to: addresses(message.envelope?.to),
  date: message.envelope?.date || message.internalDate || null,
  seen: message.flags?.has('\\Seen') || false,
});

function createMailService({ ImapClient = ImapFlow, createTransport = nodemailer.createTransport } = {}) {
  function smtp(account) {
    return createTransport({
      host: 'smtp.hostinger.com', port: 465, secure: true,
      auth: { user: account.email, pass: account.password },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    });
  }
  async function withImap(account, action) {
    const client = new ImapClient({
      host: 'imap.hostinger.com', port: 993, secure: true,
      auth: { user: account.email, pass: account.password },
      logger: false, disableAutoIdle: true,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      maxLiteralSize: MAX_MESSAGE_SIZE, maxResponseSize: MAX_MESSAGE_SIZE + 1024 * 1024,
    });
    // ImapFlow may emit socket errors in addition to rejecting the active command.
    client.on('error', () => {});
    try { await client.connect(); return await action(client); }
    finally { client.close(); }
  }
  async function folderPath(client, folder) {
    if (folder === 'inbox') return 'INBOX';
    const mailboxes = await client.list();
    return mailboxes.find(box => box.specialUse === '\\Sent')?.path || mailboxes.find(box => /^(INBOX[/.])?Sent( Items| Messages)?$/i.test(box.path))?.path || null;
  }
  return {
    async verify(account) {
      await withImap(account, client => client.status('INBOX', { messages: true }));
      const transport = smtp(account);
      try { await transport.verify(); } finally { transport.close(); }
    },
    status: account => withImap(account, async client => {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      return { unread: status.unseen || 0, total: status.messages || 0 };
    }),
    list: (account, folder, page) => withImap(account, async client => {
      const path = await folderPath(client, folder);
      if (!path) return { messages: [], total: 0, page, hasMore: false, uidValidity: '' };
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const total = client.mailbox.exists, end = total - (page - 1) * 25;
        const start = Math.max(1, end - 24), messages = [];
        if (end > 0) for await (const message of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, internalDate: true })) messages.push(summary(message));
        return { messages: messages.reverse(), total, page, hasMore: start > 1 && end > 0, uidValidity: String(client.mailbox.uidValidity) };
      } finally { lock.release(); }
    }),
    read: (account, folder, uid, uidValidity) => withImap(account, async client => {
      const path = await folderPath(client, folder);
      if (!path) fail('Message not found.', 404);
      const lock = await client.getMailboxLock(path);
      try {
        if (String(client.mailbox.uidValidity) !== uidValidity) fail('Mailbox changed. Refresh and open the message again.', 409);
        const metadata = await client.fetchOne(uid, { size: true }, { uid: true });
        if (!metadata) fail('Message not found.', 404);
        if (metadata.size > MAX_MESSAGE_SIZE) fail('This message is larger than 5 MB. Open it in Hostinger webmail.', 413);
        const message = await client.fetchOne(uid, { source: true, envelope: true, flags: true, internalDate: true }, { uid: true });
        if (!message?.source) fail('Message not found.', 404);
        const parsed = await simpleParser(message.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_MESSAGE_SIZE });
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        return { ...summary(message), seen: true, cc: addresses(parsed.cc?.value), replyTo: addresses(parsed.replyTo?.value || parsed.from?.value), text: parsed.text || '', attachments: await attachmentPreviews(parsed.attachments) };
      } finally { lock.release(); }
    }),
    async send(account, message) {
      const raw = await new MailComposer({ ...message, from: { name: account.displayName, address: account.email }, disableFileAccess: true, disableUrlAccess: true }).compile().build();
      const transport = smtp(account);
      let info;
      try { info = await transport.sendMail({ envelope: { from: account.email, to: [...message.to, ...message.cc] }, raw }); }
      finally { transport.close(); }
      // Once SMTP accepts the mail, an IMAP failure must never turn into a retryable send error.
      let sentCopySaved = false;
      try {
        sentCopySaved = await withImap(account, async client => {
          let path = await folderPath(client, 'sent');
          if (!path) { await client.mailboxCreate('Sent'); path = 'Sent'; }
          await client.append(path, raw, ['\\Seen']);
          return true;
        });
      } catch { /* The successful delivery result below remains authoritative. */ }
      return { messageId: info.messageId, sentCopySaved, rejected: (info.rejected || []).map(String) };
    },
  };
}

module.exports = { createMailService, validateMessage, isEmail, fail };
