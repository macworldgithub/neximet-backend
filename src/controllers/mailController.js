const crypto = require('node:crypto');
const MailAccount = require('../models/MailAccount');
const MailSubmission = require('../models/MailSubmission');
const { createMailService, validateMessage, isEmail, fail } = require('../services/mail');
const { encryptionKey, encryptPassword, decryptPassword } = require('../services/mailCrypto');

function createMailHandlers({ Account = MailAccount, Submission = MailSubmission, service = createMailService() } = {}) {
  const publicSettings = account => ({ connected: !!account, email: account?.email || '', displayName: account?.displayName || '', notificationsEnabled: account?.notificationsEnabled ?? true });
  async function accountFor(req) {
    const saved = await Account.findOne({ user: req.user._id }).select('+passwordEncrypted');
    if (!saved) fail('Connect your Hostinger mailbox in Mail settings first.', 409);
    return { email: saved.email, displayName: saved.displayName, password: decryptPassword(saved.passwordEncrypted, req.user._id), notificationsEnabled: saved.notificationsEnabled };
  }
  function endpoint(handler) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { await handler(req, res); }
      catch (error) {
        // Provider errors can contain usernames, raw responses, and credentials. Never echo/log them.
        const authFailed = error.authenticationFailed || error.code === 'EAUTH';
        res.status(error.status || (authFailed ? 422 : 502)).json({ success: false, safeToEdit: error.status === 400, message: error.status ? error.message : authFailed ? 'Hostinger could not authenticate this mailbox. Check the email address and mailbox password in Mail settings.' : 'Unable to connect to Hostinger Mail. Please try again shortly.' });
      }
    };
  }
  function location(req) {
    const folder = req.query.folder || 'inbox';
    if (!['inbox', 'sent'].includes(folder)) fail('Invalid mail folder.');
    return folder;
  }
  return {
    settings: endpoint(async (req, res) => {
      const account = await Account.findOne({ user: req.user._id });
      let serverConfigured = true;
      try { encryptionKey(); } catch { serverConfigured = false; }
      res.json({ success: true, settings: { ...publicSettings(account), serverConfigured } });
    }),
    save: endpoint(async (req, res) => {
      encryptionKey();
      const { email, password, displayName = '', notificationsEnabled = true } = req.body;
      if (!isEmail(email) || email !== email.trim()) fail('Enter your full Hostinger email address.');
      if (typeof displayName !== 'string' || displayName.length > 100 || /[\r\n]/.test(displayName)) fail('Enter a display name of up to 100 characters.');
      if (typeof notificationsEnabled !== 'boolean') fail('Choose whether mail notifications are enabled.');
      const existing = await Account.findOne({ user: req.user._id }).select('+passwordEncrypted');
      const normalizedEmail = email.toLowerCase();
      if (password !== undefined && typeof password !== 'string') fail('Enter a valid mailbox password.');
      let secret = password;
      if (!secret && existing?.email === normalizedEmail) secret = decryptPassword(existing.passwordEncrypted, req.user._id);
      if (!secret || secret.length > 1024) fail('Enter the password for this Hostinger mailbox.');
      const account = { email: normalizedEmail, displayName: displayName.trim(), password: secret, notificationsEnabled };
      // Verify receiving AND sending before replacing a working configuration. No email is sent.
      await service.verify(account);
      await Account.findOneAndUpdate({ user: req.user._id }, { $set: { email: account.email, displayName: account.displayName, notificationsEnabled, passwordEncrypted: encryptPassword(secret, req.user._id) } }, { upsert: true, runValidators: true });
      res.json({ success: true, settings: { ...publicSettings(account), serverConfigured: true } });
    }),
    disconnect: endpoint(async (req, res) => {
      await Account.deleteOne({ user: req.user._id });
      res.json({ success: true });
    }),
    status: endpoint(async (req, res) => {
      const saved = await Account.findOne({ user: req.user._id });
      if (!saved) return res.json({ success: true, connected: false, unread: 0 });
      const account = await accountFor(req);
      res.json({ success: true, connected: true, notificationsEnabled: account.notificationsEnabled, ...await service.status(account) });
    }),
    list: endpoint(async (req, res) => {
      const folder = location(req), page = Number(req.query.page || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000) fail('Invalid mail page.');
      res.json({ success: true, ...await service.list(await accountFor(req), folder, page) });
    }),
    read: endpoint(async (req, res) => {
      const folder = location(req), uid = req.params.uid, validity = req.query.uidValidity;
      if (!/^[1-9]\d{0,9}$/.test(uid) || Number(uid) > 4294967295 || typeof validity !== 'string' || !/^\d{1,20}$/.test(validity)) fail('Invalid message identifier. Refresh the mailbox.');
      res.json({ success: true, emailMessage: await service.read(await accountFor(req), folder, uid, validity) });
    }),
    send: endpoint(async (req, res) => {
      const message = validateMessage(req.body);
      const requestId = req.body.requestId;
      if (typeof requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(requestId)) fail('Invalid send request. Reopen the composer.');
      const account = await accountFor(req);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ email: account.email, ...message })).digest('hex');
      const filter = { user: req.user._id, requestId };
      try { await Submission.create({ ...filter, fingerprint }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const previous = await Submission.findOne(filter);
        if (previous?.fingerprint === fingerprint && previous.status === 'sent') return res.json({ success: true, ...previous.result });
        fail('This send request is already being processed or its outcome is uncertain. Check Sent or Hostinger webmail before sending again.', 409);
      }
      let result;
      try { result = await service.send(account, message); }
      catch {
        await Submission.updateOne(filter, { $set: { status: 'uncertain' } });
        fail('Hostinger did not confirm this send. Check Sent or Hostinger webmail before sending again to avoid duplicates.', 502);
      }
      // The SMTP operation succeeded even if persisting the receipt fails.
      try { await Submission.updateOne(filter, { $set: { status: 'sent', result } }); } catch { /* Existing sending record still prevents retries. */ }
      res.json({ success: true, ...result });
    }),
  };
}

module.exports = { createMailHandlers };
