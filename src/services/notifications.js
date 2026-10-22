const mongoose = require('mongoose');
const webpush = require('web-push');
const Notification = require('../models/Notification');
const Job = require('../models/NotificationPushJob');
const Subscription = require('../models/PushSubscription');
const User = require('../models/User');
const Announcement = require('../models/Announcement');
const { configured } = require('./chatPush');
const idOf = value => String(value?._id || value || '');

async function notify({ key, users, actor, kind, title, body = '', url, announcement, meeting, mailbox, mailboxEmail, push = true }) {
  const ids = [...new Set((users || []).map(idOf))].filter(id => mongoose.isValidObjectId(id) && id !== idOf(actor));
  if (!ids.length) return;
  const active = await User.find({ _id: { $in: ids }, isActive: true }).distinct('_id');
  if (!active.length) return;
  await Notification.init();
  try { await Notification.bulkWrite(active.map(user => ({ updateOne: {
    filter: { key, user }, update: { $setOnInsert: { key, user, kind, title, body: body.slice(0, 300), url, pushPrepared: !push, ...(announcement ? { announcement } : {}), ...(meeting ? { meeting } : {}), ...(mailbox ? { mailbox, mailboxEmail } : {}) } }, upsert: true,
  } })), { ordered: false }); } catch (error) {
    if (error.code !== 11000 || error.writeErrors?.some(item => item.code !== 11000)) throw error;
  }
  kick();
}
// Business changes have already committed. A notification failure must not make
// a successful operation appear to have failed and cause users to repeat it.
async function safely(event) {
  try { await notify(event); } catch (error) { console.error('Notification persistence failed:', error.message); }
}
async function executives() { return User.find({ isActive: true, role: { $in: ['CEO', 'Super Admin'] } }).distinct('_id'); }
async function everyone() { return User.find({ isActive: true }).distinct('_id'); }
async function announcementPublished(announcement) {
  await notify({ key: `announcement:${announcement._id}`, users: announcement.recipients, actor: announcement.author, kind: 'announcement',
    title: announcement.priority === 'important' ? 'Important announcement' : 'New announcement', body: announcement.title,
    url: `/announcements?id=${announcement._id}`, announcement: announcement._id });
  await Announcement.updateOne({ _id: announcement._id }, { $set: { notificationsPrepared: true } });
}
async function prepare() {
  await Job.init();
  const pending = await Notification.find({ pushPrepared: false }).sort({ createdAt: 1 }).limit(100);
  for (const notification of pending) {
    if (!notification.withdrawn && !notification.readAt && +notification.createdAt > Date.now() - 86400000) {
      const subscriptions = await Subscription.find({ user: notification.user }).select('_id');
      if (subscriptions.length) await Job.bulkWrite(subscriptions.map(subscription => ({ updateOne: {
        filter: { notification: notification._id, subscription: subscription._id },
        update: { $setOnInsert: { notification: notification._id, subscription: subscription._id, user: notification.user } }, upsert: true,
      } })), { ordered: false });
    }
    await Notification.updateOne({ _id: notification._id }, { $set: { pushPrepared: true } });
  }
  return pending.length === 100;
}
async function deliver(id) {
  const now = new Date();
  const job = await Job.findOneAndUpdate({ _id: id, status: 'pending', nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(+now + 30000) }, $inc: { attempts: 1 } }, { new: true });
  if (!job) return;
  try {
    const [notification, subscription, active] = await Promise.all([
      Notification.findOne({ _id: job.notification, user: job.user, readAt: null, withdrawn: false }).select('+mailboxEmail'),
      Subscription.findOne({ _id: job.subscription, user: job.user }), User.exists({ _id: job.user, isActive: true }),
    ]);
    const mailboxAllowed = !notification?.mailbox || await require('../models/MailAccount').exists({ _id: notification.mailbox, user: job.user, email: notification.mailboxEmail, notificationsEnabled: true });
    if (notification && subscription && active && mailboxAllowed && +notification.createdAt > +now - 86400000) {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify({
        kind: 'platform_notification', userId: idOf(job.user), notificationId: idOf(notification),
        title: notification.title, body: notification.body, url: notification.url,
      }), { TTL: Math.max(1, Math.floor((+notification.createdAt + 86400000 - Date.now()) / 1000)), urgency: 'normal', timeout: 5000,
        vapidDetails: { subject: process.env.WEB_PUSH_SUBJECT, publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY } });
    }
    await Job.updateOne({ _id: id }, { $set: { status: 'sent', leaseUntil: null } });
  } catch (error) {
    const expired = [404, 410].includes(error.statusCode);
    if (expired) await Subscription.deleteOne({ _id: job.subscription, user: job.user });
    await Job.updateOne({ _id: id }, { $set: { status: expired || job.attempts >= 5 ? 'failed' : 'pending', leaseUntil: null, nextAttemptAt: new Date(Date.now() + 30000 * job.attempts) } });
  }
}
let running, again = false;
function flush() {
  if (mongoose.connection.readyState !== 1) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      // Recover interrupted announcement fanout after a process restart, even
      // when device push is disabled. Inbox delivery does not need VAPID keys.
      const announcements = await Announcement.find({ notificationsPrepared: false, archivedAt: null }).limit(20);
      for (const announcement of announcements) await announcementPublished(announcement);
      if (!configured()) { if (announcements.length === 20) { again = true; continue; } return; }
      if (await prepare()) again = true;
      const now = new Date();
      const jobs = await Job.find({ status: 'pending', nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }).sort({ createdAt: 1 }).limit(100);
      for (let i = 0; i < jobs.length; i += 5) await Promise.all(jobs.slice(i, i + 5).map(job => deliver(job._id)));
      if (jobs.length === 100) again = true;
    } while (again);
  })().finally(() => { running = null; });
  return running;
}
function kick() { void flush().catch(error => console.warn('Platform push will retry:', error.message)); }
function start() { kick(); const timer = setInterval(kick, 15000); timer.unref(); return async () => { clearInterval(timer); await running?.catch(() => {}); }; }
module.exports = { notify, safely, executives, everyone, idOf, start, flush, announcementPublished };
