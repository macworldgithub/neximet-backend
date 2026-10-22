const mongoose = require('mongoose');
const MailAccount = require('../models/MailAccount');
const User = require('../models/User');
const notifications = require('./notifications');
const { decryptPassword } = require('./mailCrypto');
const { createMailService } = require('./mail');

function createMailNotifications({ Account = MailAccount, Users = User, service = createMailService(), notify = notifications.notify, decrypt = decryptPassword } = {}) {
  async function poll(account) {
    const filter = { _id: account._id, user: account.user, email: account.email, passwordEncrypted: account.passwordEncrypted, notificationsEnabled: true };
    try {
      if (!await Users.exists({ _id: account.user, isActive: true })) return;
      const current = await service.checkpoint({ email: account.email, password: decrypt(account.passwordEncrypted, account.user) });
      if (!Number.isSafeInteger(current.nextUid) || current.nextUid < 1 || !/^\d{1,20}$/.test(current.validity)) throw new Error('Invalid mailbox checkpoint');
      // Recheck after IMAP I/O so a disconnected/replaced mailbox cannot send a
      // late alert for the previous account or bypass its notification setting.
      if (!await Account.exists(filter) || !await Users.exists({ _id: account.user, isActive: true })) return;
      const previous = account.pushCheckpoint;
      if (previous?.validity === current.validity && current.nextUid > previous.nextUid) {
        await notify({ key: `mail:${account._id}:${current.validity}:${current.nextUid}`, users: [account.user], kind: 'mail', mailbox: account._id, mailboxEmail: account.email,
          title: 'New email in your mailbox', body: 'Open Mail to read your new messages.', url: '/mail' });
      }
      // Establish a baseline on first connection / UIDVALIDITY change. Never
      // alert for the entire historical mailbox, and persist only after enqueue.
      await Account.updateOne(filter, { $set: { pushCheckpoint: current } });
    } catch {
      // Mail provider errors may contain credentials or private IMAP responses.
      await Account.updateOne(filter, { $set: { notificationPollAt: new Date(Date.now() + 300000) } });
    }
  }
  async function flush() {
    const now = new Date(), accounts = [];
    for (let i = 0; i < 10; i++) {
      const account = await Account.findOneAndUpdate({ notificationsEnabled: true, $or: [{ notificationPollAt: { $lte: now } }, { notificationPollAt: { $exists: false } }] },
        { $set: { notificationPollAt: new Date(+now + 60000) } }, { new: true, sort: { notificationPollAt: 1 } }).select('+passwordEncrypted +pushCheckpoint.validity +pushCheckpoint.nextUid +notificationPollAt');
      if (!account) break;
      accounts.push(account);
    }
    for (let i = 0; i < accounts.length; i += 3) await Promise.all(accounts.slice(i, i + 3).map(poll));
  }
  function start() {
    let running, stopped = false;
    const tick = () => {
      if (stopped || running || mongoose.connection.readyState !== 1) return;
      running = flush().catch(() => console.warn('Mail notification scan will retry.')).finally(() => { running = null; });
    };
    tick(); const timer = setInterval(tick, 15000); timer.unref();
    return async () => { stopped = true; clearInterval(timer); await running; };
  }
  return { poll, flush, start };
}
module.exports = { createMailNotifications };
