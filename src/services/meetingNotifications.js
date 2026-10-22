const webpush = require('web-push');
const mongoose = require('mongoose');
const Meeting = require('../models/Meeting');
const CallSession = require('../models/CallSession');
const PushSubscription = require('../models/PushSubscription');
const MeetingPushJob = require('../models/MeetingPushJob');
const User = require('../models/User');
const { configured } = require('./chatPush');
const notifications = require('./notifications');

async function enqueue(event, users) {
  if (!configured() || !users.length) return;
  await MeetingPushJob.init();
  const subscriptions = await PushSubscription.find({ user: { $in: users } }).select('_id user');
  if (!subscriptions.length) return;
  try {
    await MeetingPushJob.bulkWrite(subscriptions.map(subscription => ({ updateOne: {
      filter: { key: event.key, subscription: subscription._id },
      update: { $setOnInsert: { ...event, subscription: subscription._id, user: subscription.user } }, upsert: true,
    } })), { ordered: false });
  } catch (error) {
    if (error.code !== 11000 || error.writeErrors?.some(item => item.code !== 11000)) throw error;
  }
}
async function notifyCall(callId, userIds, expiresAt) {
  if (!configured()) return;
  const call = await CallSession.findOne({ callId, endedAt: null });
  if (!call) return;
  await enqueue({ key: `call:${callId}`, kind: 'incoming_call', call: call._id, expiresAt: new Date(expiresAt) }, userIds);
  kick();
}
async function notifyMeeting(meeting, kind = 'meeting_invitation') {
  await require('../models/Notification').updateMany({ meeting: meeting._id, ...(kind === 'meeting_cancelled' ? {} : { user: { $nin: meeting.participants.map(person => person._id || person) } }) }, { $set: { withdrawn: true } })
    .catch(error => console.warn('Meeting inbox cleanup failed:', error.message));
  await notifications.safely({ key: `${kind}:${meeting._id}:${meeting.notificationRevision || 0}`, users: meeting.participants, actor: meeting.organizer,
    kind: 'meeting', title: { meeting_invitation: 'You are invited to a meeting', meeting_updated: 'A meeting invitation was updated', meeting_cancelled: 'A meeting was cancelled' }[kind],
    body: meeting.title, url: `/meet?conversation=${meeting.conversation}&meeting=${meeting._id}&mode=${meeting.mode}`, meeting: meeting._id, push: false });
  if (!configured()) return;
  await enqueue({ key: `${kind}:${meeting._id}:${meeting.notificationRevision || 0}`, kind, meeting: meeting._id,
    revision: meeting.notificationRevision || 0, expiresAt: new Date(Math.min(+meeting.endsAt, Date.now() + 86400000)) },
  meeting.participants.map(person => person._id || person).filter(id => String(id) !== String(meeting.organizer?._id || meeting.organizer)));
  kick();
}
async function notifyCallEnded(session) {
  const missed = session.invitedUsers.filter(id => String(id) !== String(session.startedBy) && !session.attendance.some(item => String(item.user) === String(id)) && !session.declinedBy.some(person => String(person) === String(id)));
  await notifications.safely({ key: `missed:${session.callId}`, users: missed, kind: 'call', title: `Missed ${session.mode === 'audio' ? 'voice' : 'video'} call`, body: session.title, url: '/meet?view=history', push: false });
  if (!configured()) return;
  await enqueue({ key: `ended:${session.callId}`, kind: 'call_ended', call: session._id, expiresAt: new Date(Date.now() + 300000) },
    session.invitedUsers.filter(id => String(id) !== String(session.startedBy)));
  kick();
}
async function prepareReminders(now = new Date()) {
  const meetings = await Meeting.find({ status: 'scheduled', startsAt: { $gte: new Date(+now - 120000), $lte: new Date(+now + 600000) }, endsAt: { $gt: now } });
  for (const meeting of meetings) {
    const kind = meeting.startsAt > now ? 'meeting_reminder' : 'meeting_starting';
    const declined = new Set(meeting.responses.filter(item => item.response === 'declined').map(item => String(item.user)));
    await notifications.safely({ key: `${kind}:${meeting._id}:${meeting.notificationRevision || 0}`, users: meeting.participants.filter(id => !declined.has(String(id))),
      kind: 'meeting', title: kind === 'meeting_reminder' ? 'Your meeting starts soon' : 'Your meeting starts now', body: meeting.title,
      url: `/meet?conversation=${meeting.conversation}&meeting=${meeting._id}&mode=${meeting.mode}`, meeting: meeting._id, push: false });
    await enqueue({ key: `${kind}:${meeting._id}:${meeting.notificationRevision || 0}`, kind, meeting: meeting._id,
      revision: meeting.notificationRevision || 0, expiresAt: kind === 'meeting_reminder' ? meeting.startsAt : new Date(Math.min(+meeting.endsAt, +meeting.startsAt + 120000)) },
    meeting.participants.filter(id => !declined.has(String(id))));
  }
}
async function payloadFor(job, now) {
  if (job.kind === 'call_ended') {
    const call = await CallSession.findOne({ _id: job.call, endedAt: { $ne: null }, invitedUsers: job.user });
    if (!call) return null;
    const missed = !call.attendance.some(item => String(item.user) === String(job.user)) && !call.declinedBy.some(id => String(id) === String(job.user));
    return { kind: job.kind, userId: String(job.user), callId: call.callId, expiresAt: +job.expiresAt,
      title: missed ? `Missed ${call.mode === 'audio' ? 'voice' : 'video'} call` : 'Call ended', body: call.title, url: '/meet?view=history' };
  }
  if (job.kind === 'incoming_call') {
    const call = await CallSession.findOne({ _id: job.call, endedAt: null, invitedUsers: job.user }).populate('startedBy', 'name');
    if (!call || call.attendance.some(item => String(item.user) === String(job.user)) || call.declinedBy.some(id => String(id) === String(job.user))) return null;
    return { kind: job.kind, userId: String(job.user), callId: call.callId, expiresAt: +job.expiresAt,
      title: `Incoming ${call.mode === 'audio' ? 'voice' : 'video'} call`, body: `${call.startedBy?.name || 'A teammate'} is calling · ${call.title}`,
      url: `/meet?conversation=${call.conversation}&call=${call.callId}&mode=${call.mode}${call.meeting ? `&meeting=${call.meeting}` : ''}` };
  }
  const meeting = await Meeting.findOne({ _id: job.meeting, participants: job.user }).populate('organizer', 'name');
  if (!meeting || (meeting.notificationRevision || 0) !== job.revision) return null;
  if (job.kind === 'meeting_cancelled' ? meeting.status !== 'cancelled' : meeting.status !== 'scheduled') return null;
  const reminder = ['meeting_reminder', 'meeting_starting'].includes(job.kind);
  if (reminder && meeting.responses.some(item => String(item.user) === String(job.user) && item.response === 'declined')) return null;
  if (job.kind === 'meeting_reminder' && meeting.startsAt <= now) return null;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: meeting.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(meeting.startsAt);
  const heading = { meeting_invitation: 'Meeting invitation', meeting_updated: 'Meeting updated', meeting_cancelled: 'Meeting cancelled', meeting_reminder: 'Meeting starts soon', meeting_starting: 'Meeting starts now' }[job.kind];
  return { kind: job.kind, userId: String(job.user), meetingId: String(meeting._id), expiresAt: +job.expiresAt,
    title: `${heading}: ${meeting.title}`, body: `${time} (${meeting.timezone}) · ${meeting.organizer?.name || 'Your team'}`,
    url: `/meet?conversation=${meeting.conversation}&meeting=${meeting._id}&mode=${meeting.mode}` };
}
async function deliver(id) {
  const now = new Date();
  const job = await MeetingPushJob.findOneAndUpdate({ _id: id, status: 'pending', nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(+now + 30000) }, $inc: { attempts: 1 } }, { new: true });
  if (!job) return;
  try {
    const [subscription, user] = await Promise.all([PushSubscription.findOne({ _id: job.subscription, user: job.user }), User.exists({ _id: job.user, isActive: true })]);
    const payload = job.expiresAt > now && subscription && user ? await payloadFor(job, now) : null;
    if (payload) await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), {
      TTL: Math.max(1, Math.ceil((+job.expiresAt - Date.now()) / 1000)), urgency: 'high', timeout: 5000,
      vapidDetails: { subject: process.env.WEB_PUSH_SUBJECT, publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY },
    });
    await MeetingPushJob.updateOne({ _id: job._id }, { $set: { status: 'sent', leaseUntil: null } });
  } catch (error) {
    const expired = [404, 410].includes(error.statusCode);
    if (expired) await PushSubscription.deleteOne({ _id: job.subscription });
    await MeetingPushJob.updateOne({ _id: job._id }, { $set: { status: expired || job.attempts >= 5 || job.expiresAt <= new Date() ? 'failed' : 'pending', leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + Math.min(job.kind === 'incoming_call' ? 5000 * job.attempts : 30000 * job.attempts, 120000)) } });
    if (!expired) console.warn('Meeting notification deferred:', error.statusCode || error.code || 'push unavailable');
  }
}
let running, again = false;
function flush() {
  if (mongoose.connection.readyState !== 1) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      await prepareReminders();
      if (!configured()) return;
      const jobs = await MeetingPushJob.find({ status: 'pending', nextAttemptAt: { $lte: new Date() } }).sort({ kind: 1, createdAt: 1 }).limit(100);
      for (let i = 0; i < jobs.length; i += 5) {
        await Promise.all(jobs.slice(i, i + 5).map(job => deliver(job._id)));
        if (again) break; // Recheck priority when a new incoming call is queued.
      }
    } while (again);
  })().finally(() => { running = null; });
  return running;
}
function kick() { void flush().catch(error => console.warn('Meeting notifications will retry:', error.message)); }
function start() {
  kick();
  const timer = setInterval(kick, 20000); timer.unref();
  return async () => { clearInterval(timer); await running?.catch(() => {}); };
}
module.exports = { notifyCall, notifyCallEnded, notifyMeeting, prepareReminders, flush, start };
