const webpush = require('web-push');
const jwt = require('jsonwebtoken');
const PushSubscription = require('../models/PushSubscription');
const PushJob = require('../models/PushJob');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const mongoose = require('mongoose');
const { jwtSecret: secret } = require('./authSecret');
const configured = () => !!(process.env.WEB_PUSH_VAPID_PUBLIC_KEY && process.env.WEB_PUSH_VAPID_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT);

async function deliverJob(id) {
  const now = new Date();
  const job = await PushJob.findOneAndUpdate({ _id: id, status: 'pending', nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $set: { leaseUntil: new Date(Date.now() + 30000) }, $inc: { attempts: 1 } }, { new: true });
  if (!job) return;
  try {
    const [subscription, message, user] = await Promise.all([
      PushSubscription.findOne({ _id: job.subscription, user: job.user }),
      Message.findById(job.message).populate('sender', 'name'),
      User.findOne({ _id: job.user, isActive: true }),
    ]);
    const conversation = message && await Conversation.findOne({ _id: message.conversation, 'members.user': job.user });
    if (!subscription || !message || !user || !conversation || +message.createdAt < Date.now() - 86400000 || message.readBy.some((id) => String(id) === String(job.user))) {
      await PushJob.updateOne({ _id: job._id }, { $set: { status: 'sent', leaseUntil: null } }); return;
    }
    const receiptToken = jwt.sign({ purpose: 'push-delivery', messageId: String(message._id), subscriptionId: String(subscription._id) }, secret(), { audience: 'chat-push-delivery', subject: String(job.user), expiresIn: '24h' });
    const payload = { userId: String(job.user), title: conversation.kind === 'group' ? `${message.sender?.name || 'Teammate'} · ${conversation.name}` : message.sender?.name || 'New message', body: (message.text || `Sent ${message.attachments?.length > 1 ? `${message.attachments.length} attachments` : message.attachments?.[0]?.name || message.attachment?.name || 'an attachment'}`).slice(0, 180), conversationId: String(conversation._id), url: `/chat?conversation=${conversation._id}`, receiptToken };
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), {
      TTL: 86400, urgency: 'high', timeout: 5000,
      vapidDetails: { subject: process.env.WEB_PUSH_SUBJECT, publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY },
    });
    await PushJob.updateOne({ _id: job._id }, { $set: { status: 'sent', leaseUntil: null } });
  } catch (error) {
    const expired = [404, 410].includes(error.statusCode);
    if (expired) await PushSubscription.deleteOne({ _id: job.subscription });
    await PushJob.updateOne({ _id: job._id }, { $set: { status: expired || job.attempts >= 5 ? 'failed' : 'pending', leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(60000 * job.attempts, 300000)) } });
    if (!expired) console.warn('Chat notification will retry:', error.statusCode || error.code || 'push service unavailable');
  }
}
async function runJobs(jobs) {
  // Bound fanout rather than opening one connection for every device at once.
  for (let offset = 0; offset < jobs.length; offset += 5) await Promise.all(jobs.slice(offset, offset + 5).map((job) => deliverJob(job._id)));
}
async function dispatchJobs(jobs) {
  const work = runJobs(jobs).catch((error) => console.warn('Chat push outbox deferred:', error.message));
  if (process.env.VERCEL) require('@vercel/functions').waitUntil(work);
  else await work;
}
async function notifyMessage(conversation, message) {
  if (!configured()) return;
  await Promise.all([PushSubscription.init(), PushJob.init()]);
  const recipients = conversation.members.map((member) => member.user?._id || member.user).filter((id) => String(id) !== String(message.sender?._id || message.sender));
  const subscriptions = await PushSubscription.find({ user: { $in: recipients } });
  if (subscriptions.length) {
    try {
      await PushJob.bulkWrite(subscriptions.map((subscription) => ({ updateOne: { filter: { message: message._id, subscription: subscription._id }, update: { $setOnInsert: { user: subscription.user } }, upsert: true } })), { ordered: false });
    } catch (error) {
      if (error.code !== 11000 || error.writeErrors?.some((failure) => failure.code !== 11000)) throw error;
    }
  }
  await dispatchJobs(await PushJob.find({ message: message._id, status: 'pending' }));
}
async function flush(userId) {
  if (!configured()) return;
  const filter = userId ? { user: userId } : {};
  await dispatchJobs(await PushJob.find({ ...filter, status: 'pending', nextAttemptAt: { $lte: new Date() } }).limit(50));
}
function start({ intervalMs = 20000 } = {}) {
  let running, stopped = false;
  const tick = () => {
    if (stopped || running || !configured() || mongoose.connection.readyState !== 1) return;
    running = flush().catch(error => console.warn('Background chat push will retry:', error.code || 'unavailable')).finally(() => { running = null; });
  };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
module.exports = { configured, notifyMessage, flush, secret, start };
