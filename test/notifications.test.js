// Synthetic accounts and temporary MongoDB only; never loads application .env.
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
const Announcement = require('../src/models/Announcement');
const Notification = require('../src/models/Notification');
const PushJob = require('../src/models/NotificationPushJob');
const Subscription = require('../src/models/PushSubscription');
const notifications = require('../src/services/notifications');
process.env.JWT_SECRET = 'isolated-notifications-test-secret';
let mongo, directory, server, users;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-notifications-test-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  mongo = spawn(process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod'),
    ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let failure; mongo.on('error', error => { failure = error; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failure) throw failure;
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/notification_tests`, { serverSelectionTimeoutMS: 300 }); break; }
    catch (error) { if (attempt === 49) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  users = await User.create(['CEO', 'Super Admin', 'Team Member', 'Team Manager', 'Team Member'].map((role, index) => ({
    name: `Notification user ${index}`, email: `notification-${index}@example.test`, password: 'isolated-only', role,
    department: index === 4 ? 'Graphics Designing' : 'Software Development',
  })));
  const app = express(); app.use(express.json());
  for (const [url, file] of [['announcements', 'announcement'], ['notifications', 'notification'], ['tasks', 'task'], ['projects', 'project'], ['leaves', 'leave'], ['auth', 'auth']]) app.use(`/api/${url}`, require(`../src/routes/${file}Routes`));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
});
after(async () => {
  await notifications.flush();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) { const stopped = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await stopped; }
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('neximet-notifications-test-')) await rm(directory, { recursive: true, force: true });
});
async function request(index, endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${endpoint}`, { method,
    headers: { ...(index == null ? {} : { Authorization: `Bearer ${jwt.sign({ id: users[index]._id }, process.env.JWT_SECRET)}` }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
const draft = extra => ({ title: 'Company update', body: 'A useful announcement.\n<script>plain text only</script>', ...extra });

test('publishing is restricted to CEOs and Super Admins, even with forged author/recipients', async () => {
  assert.equal((await request(null, '/announcements', draft())).status, 401);
  for (const index of [2, 3]) assert.equal((await request(index, '/announcements', draft())).status, 403);
  const result = await request(1, '/announcements', draft({ author: users[2]._id, recipients: [users[4]._id] }));
  assert.equal(result.status, 201);
  const record = await Announcement.findById(result.body.announcement._id);
  assert.equal(String(record.author), String(users[1]._id)); assert.equal(record.recipients.length, 5);
  assert.equal(record.body.includes('<script>'), true); // React renders this as text.
});

test('targeted announcements and their notification previews are private to their audience', async () => {
  const result = await request(0, '/announcements', draft({ title: 'Design update', audience: 'department', department: 'Graphics Designing', priority: 'important' }));
  const id = result.body.announcement._id;
  assert.equal(result.body.recipientCount, 1);
  assert.equal((await request(4, `/announcements/${id}`)).status, 200);
  assert.equal((await request(2, `/announcements/${id}`)).status, 404);
  assert.equal((await request(1, `/announcements/${id}`)).status, 200);
  const inbox = await request(4, '/notifications');
  assert.equal(inbox.cache, 'private, no-store');
  const item = inbox.body.notifications.find(item => item.body === 'Design update');
  assert.ok(item); assert.equal(item.title, 'Important announcement'); assert.equal(item.url, `/announcements?id=${id}`);
  assert.equal((await request(2, '/notifications')).body.notifications.some(item => item.body === 'Design update'), false);
  const list = (await request(4, '/announcements')).body.announcements;
  assert.equal('recipients' in list[0], false);
  assert.equal((await request(2, `/notifications/${item._id}/read`, {})).status, 404);
  assert.equal((await request(4, `/notifications/${item._id}/read`, {})).status, 200);
});

test('selected-user audiences validate inputs and exclude inactive users', async () => {
  for (const extra of [{ title: ' ' }, { body: '' }, { audience: 'unknown' }, { audience: 'users', userIds: [] }, { audience: 'users', userIds: [{}] }, { audience: 'department', department: 'Invalid' }, { title: 'x'.repeat(161) }]) {
    assert.equal((await request(0, '/announcements', draft(extra))).status, 400);
  }
  await User.updateOne({ _id: users[4]._id }, { $set: { isActive: false } });
  assert.equal((await request(0, '/announcements', draft({ audience: 'users', userIds: [String(users[4]._id)] }))).status, 400);
  await User.updateOne({ _id: users[4]._id }, { $set: { isActive: true } });
  const result = await request(0, '/announcements', draft({ audience: 'users', userIds: [String(users[2]._id), String(users[2]._id)] }));
  assert.equal(result.status, 201); assert.equal(result.body.recipientCount, 1);
  assert.equal((await request(3, `/announcements/${result.body.announcement._id}`)).status, 404);
});

test('archiving withdraws inbox items and denies subsequent reads', async () => {
  const published = await request(0, '/announcements', draft({ title: 'To archive' })); const id = published.body.announcement._id;
  assert.equal((await request(2, `/announcements/${id}/archive`, {})).status, 403);
  assert.equal((await request(1, `/announcements/${id}/archive`, {})).status, 200);
  assert.equal((await request(2, `/announcements/${id}`)).status, 404);
  assert.equal((await request(2, '/notifications')).body.notifications.some(item => item.body === 'To archive'), false);
});

test('announcement fanout recovers after restart without VAPID and is idempotent', async () => {
  const announcement = await Announcement.create({ ...draft(), audience: 'users', author: users[0]._id, recipients: [users[2]._id] });
  await notifications.flush(); await notifications.announcementPublished(announcement); await notifications.flush();
  assert.equal(await Notification.countDocuments({ key: `announcement:${announcement._id}`, user: users[2]._id }), 1);
  assert.equal((await Announcement.findById(announcement._id)).notificationsPrepared, true);
});

test('read-all is user scoped and bounded to items actually seen; cursor pagination is stable', async () => {
  for (let i = 0; i < 33; i++) await notifications.notify({ key: `pagination:${i}`, users: [users[3]._id], kind: 'test', title: `Notice ${i}`, url: '/notifications', push: false });
  const first = (await request(3, '/notifications')).body; assert.equal(first.notifications.length, 30); assert.ok(first.nextCursor);
  const second = (await request(3, `/notifications?before=${first.nextCursor}`)).body;
  assert.equal(second.notifications.some(item => first.notifications.some(old => old._id === item._id)), false);
  await notifications.notify({ key: 'after-seen', users: [users[3]._id], kind: 'test', title: 'Just arrived', url: '/notifications', push: false });
  assert.equal((await request(3, '/notifications/read-all', { through: first.notifications[0]._id })).status, 200);
  const final = (await request(3, '/notifications')).body;
  assert.equal(final.unreadCount, 1); assert.equal(final.notifications[0].title, 'Just arrived');
  assert.equal((await request(3, '/notifications?before=bad')).status, 400);
});

test('task assignments, comments, status and project resource updates notify only relevant users', async () => {
  const created = await request(0, '/projects', { title: 'Notification project', code: 'NOTIFY', clientName: 'Synthetic client', deadline: '2027-01-01', department: 'Software Development', projectManager: users[1]._id, assignedMembers: [{ user: users[2]._id }] });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const project = created.body.project;
  const taskResult = await request(0, '/tasks', { project: project._id, title: 'Private task title', assignedTo: users[2]._id });
  assert.equal(taskResult.status, 201, JSON.stringify(taskResult.body)); const task = taskResult.body.task;
  const assigned = (await request(2, '/notifications')).body.notifications.find(item => item.title === 'A task was assigned');
  assert.ok(assigned); assert.equal(assigned.url, `/projects/${project._id}`); assert.equal(assigned.body.includes('Private task'), false);
  const beforeNoop = await Notification.countDocuments({ kind: 'task' });
  await request(0, `/tasks/${task._id}`, { assignedTo: users[2]._id }, 'PUT');
  assert.equal(await Notification.countDocuments({ kind: 'task' }), beforeNoop);
  assert.equal((await request(4, '/notifications')).body.notifications.some(item => item.kind === 'task'), false);
  assert.equal((await request(2, `/tasks/${task._id}/comments`, { text: 'Confidential comment' })).status, 200);
  assert.ok((await request(1, '/notifications')).body.notifications.some(item => item.title === 'New task comment'));
  assert.equal((await request(2, `/tasks/${task._id}/status`, { status: 'done' }, 'PATCH')).status, 200);
  const count = await Notification.countDocuments({ title: 'Task status changed' });
  await request(2, `/tasks/${task._id}/status`, { status: 'done', order: 2 }, 'PATCH');
  assert.equal(await Notification.countDocuments({ title: 'Task status changed' }), count);
  await request(0, `/projects/${project._id}/resources`, { assignedMembers: [{ user: users[3]._id }] }, 'PUT');
  assert.ok((await request(3, '/notifications')).body.notifications.some(item => item.kind === 'project'));
});

test('password requests notify executives once without exposing credentials', async () => {
  const response = await request(null, '/auth/forgot-password', { email: users[2].email }); assert.equal(response.status, 200);
  const count = await Notification.countDocuments({ title: 'Password reset request awaiting review' }); assert.equal(count, 2);
  await request(null, '/auth/forgot-password', { email: users[2].email });
  assert.equal(await Notification.countDocuments({ title: 'Password reset request awaiting review' }), count);
  const requests = await Notification.find({ title: 'Password reset request awaiting review' });
  assert.deepEqual(requests.map(item => String(item.user)).sort(), [String(users[0]._id), String(users[1]._id)].sort());
  assert.equal(JSON.stringify(requests).includes('isolated-only'), false);
});

test('push delivery retries, revalidates device ownership, skips read/withdrawn items and removes expired subscriptions', async () => {
  await notifications.flush();
  const webpush = require('web-push'); const original = webpush.sendNotification;
  const keys = webpush.generateVAPIDKeys(); process.env.WEB_PUSH_VAPID_PUBLIC_KEY = keys.publicKey; process.env.WEB_PUSH_VAPID_PRIVATE_KEY = keys.privateKey; process.env.WEB_PUSH_SUBJECT = 'https://example.test';
  const deliveries = []; webpush.sendNotification = async (subscription, payload) => { deliveries.push({ subscription, payload: JSON.parse(payload) }); };
  try {
    // Clear old inbox fanout before installing this synthetic device.
    await Notification.updateMany({}, { $set: { pushPrepared: true } });
    const subscription = await Subscription.create({ user: users[2]._id, endpoint: 'https://fcm.googleapis.com/test-device', keys: { p256dh: 'test', auth: 'test' } });
    await notifications.notify({ key: 'push-success', users: [users[2]._id], kind: 'test', title: 'Device update', url: '/notifications' }); await notifications.flush();
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].payload.kind, 'platform_notification'); assert.equal(deliveries[0].payload.userId, String(users[2]._id));
    const record = await Notification.findOne({ key: 'push-success' });
    assert.equal(await PushJob.countDocuments({ notification: record._id, status: 'sent' }), 1);
    const retry = await Notification.create({ key: 'push-retry', user: users[2]._id, kind: 'test', title: 'Retry', url: '/notifications', pushPrepared: true });
    const job = await PushJob.create({ notification: retry._id, subscription: subscription._id, user: users[2]._id });
    webpush.sendNotification = async () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    await notifications.flush(); assert.equal((await PushJob.findById(job._id)).status, 'pending');
    await Notification.updateOne({ _id: retry._id }, { $set: { readAt: new Date() } }); await PushJob.updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(0) } });
    await notifications.flush(); assert.equal((await PushJob.findById(job._id)).status, 'sent');
    const stale = await Notification.create({ key: 'push-stale', user: users[2]._id, kind: 'test', title: 'Stale', url: '/notifications', pushPrepared: true });
    await PushJob.create({ notification: stale._id, subscription: subscription._id, user: users[2]._id });
    await Subscription.updateOne({ _id: subscription._id }, { $set: { user: users[4]._id } });
    await notifications.flush(); assert.equal(deliveries.length, 1);
    await Subscription.updateOne({ _id: subscription._id }, { $set: { user: users[2]._id } });
    const expired = await Notification.create({ key: 'push-expired', user: users[2]._id, kind: 'test', title: 'Expired', url: '/notifications', pushPrepared: true });
    const expiredJob = await PushJob.create({ notification: expired._id, subscription: subscription._id, user: users[2]._id });
    webpush.sendNotification = async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); };
    await notifications.flush(); assert.equal(await Subscription.exists({ _id: subscription._id }), null); assert.equal((await PushJob.findById(expiredJob._id)).status, 'failed');
  } finally { webpush.sendNotification = original; delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY; delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY; delete process.env.WEB_PUSH_SUBJECT; }
});
