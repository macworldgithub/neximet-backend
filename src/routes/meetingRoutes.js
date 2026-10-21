const router = require('express').Router();
const { protect } = require('../middleware/auth');
const Meeting = require('../models/Meeting');
const CallSession = require('../models/CallSession');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const { reconcile } = require('../services/meetingRecords');
const { invitees, createRoom } = require('../services/meetingInvites');
const notifications = require('../services/meetingNotifications');
const notify = (meeting, kind) => notifications.notifyMeeting(meeting, kind).catch(error => console.warn('Meeting invitation notification deferred:', error.message));
const validId = id => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = handler => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error.name === 'VersionError' ? fail(409, 'The meeting changed. Refresh and try again.') : error); } };
router.use(protect, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const populate = meeting => meeting.populate([{ path: 'organizer', select: 'name' }, { path: 'participants', select: 'name' }]);
async function findMeeting(req) {
  if (!validId(req.params.id)) throw fail(400, 'Invalid meeting');
  const meeting = await Meeting.findOne({ _id: req.params.id, participants: req.user._id });
  if (!meeting) throw fail(404, 'Meeting not found');
  return meeting;
}
function fields(body) {
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) throw fail(400, 'Enter a title of 1–120 characters');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 4000)) throw fail(400, 'Description must be at most 4,000 characters');
  if (!['audio', 'video'].includes(body.mode)) throw fail(400, 'Choose voice or video');
  try { if (typeof body.timezone !== 'string' || body.timezone.length > 100) throw Error(); new Intl.DateTimeFormat('en', { timeZone: body.timezone }); }
  catch { throw fail(400, 'Choose a valid time zone'); }
  const parse = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? new Date(value) : new Date(NaN);
  const startsAt = parse(body.startsAt), endsAt = parse(body.endsAt);
  if (!Number.isFinite(+startsAt) || !Number.isFinite(+endsAt) || +endsAt <= +startsAt || +endsAt - +startsAt > 86400000) throw fail(400, 'Choose valid start/end times, at most 24 hours apart');
  if (+startsAt < Date.now() - 60000) throw fail(400, 'Choose a future start time');
  return { title: body.title.trim(), description: body.description || '', startsAt, endsAt, timezone: body.timezone, mode: body.mode };
}
router.post('/rooms', wrap(async (req, res) => {
  const participants = await invitees(req.body.participantIds, req.user._id);
  if (req.body.title !== undefined && (typeof req.body.title !== 'string' || req.body.title.trim().length > 120)) throw fail(400, 'Enter a title of at most 120 characters');
  const room = await createRoom(req.user._id, participants, req.body.title?.trim() || 'Team meeting');
  res.status(201).json({ success: true, room: await room.populate('members.user', 'name') });
}));
router.get('/rooms/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, 'Invalid meeting room');
  const room = await Conversation.findById(req.params.id).populate('members.user', 'name');
  if (!room) throw fail(404, 'Meeting room not found');
  const member = room.members.some(item => String(item.user?._id) === String(req.user._id));
  if (!member && !await CallSession.exists({ conversation: room._id, endedAt: null, invitedUsers: req.user._id, lastSeenAt: { $gte: new Date(Date.now() - 120000) } })) throw fail(404, 'Meeting room not found');
  res.json({ success: true, room });
}));
router.get('/history', wrap(async (req, res) => {
  await reconcile();
  const query = { invitedUsers: req.user._id };
  if (req.query.q !== undefined) {
    if (typeof req.query.q !== 'string' || req.query.q.length > 120) throw fail(400, 'Search must be at most 120 characters');
    query.title = { $regex: req.query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }
  if (req.query.before) {
    if (!validId(req.query.before)) throw fail(400, 'Invalid history cursor');
    query._id = { $lt: req.query.before };
  }
  const sessions = await CallSession.find(query).sort({ _id: -1 }).limit(21)
    .populate('startedBy', 'name').populate('invitedUsers', 'name').populate('attendance.user', 'name').lean();
  const hasMore = sessions.length > 20; if (hasMore) sessions.pop();
  const history = sessions.map(session => {
    const mine = session.attendance.filter(item => String(item.user?._id) === String(req.user._id));
    const attended = new Set(session.attendance.map(item => String(item.user?._id)));
    const seconds = (start, end) => Math.max(0, Math.floor((+new Date(end || Date.now()) - +new Date(start)) / 1000));
    return { ...session, durationSeconds: seconds(session.startedAt, session.endedAt),
      attendanceSeconds: mine.reduce((sum, item) => sum + seconds(item.joinedAt, item.leftAt || session.endedAt), 0),
      outcome: mine.length ? session.endedAt ? session.endReason === 'declined' ? 'declined' : attended.size === 1 && String(session.startedBy?._id) === String(req.user._id) && session.invitedUsers.length > 1 ? 'unanswered' : 'attended' : session.connectedAt || attended.size > 1 ? 'in_progress' : 'ringing'
        : session.declinedBy.some(id => String(id) === String(req.user._id)) ? 'declined' : session.endedAt ? 'missed' : 'invited' };
  });
  res.json({ success: true, history, hasMore });
}));
router.get('/upcoming', wrap(async (req, res) => {
  await reconcile();
  const meetings = await Meeting.find({ participants: req.user._id, status: { $in: ['scheduled', 'in_progress'] }, endsAt: { $gte: new Date() } })
    .sort({ startsAt: 1 }).limit(20).populate('organizer', 'name').populate('participants', 'name').lean();
  res.json({ success: true, meetings });
}));
router.get('/', wrap(async (req, res) => {
  await reconcile();
  const from = new Date(typeof req.query.from === 'string' ? req.query.from : NaN);
  const to = new Date(typeof req.query.to === 'string' ? req.query.to : NaN);
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || to <= from || +to - +from > 366 * 86400000) throw fail(400, 'Choose a calendar range of at most one year');
  const meetings = await Meeting.find({ participants: req.user._id, startsAt: { $lt: to }, endsAt: { $gt: from } })
    .sort({ startsAt: 1 }).limit(501).populate('organizer', 'name').populate('participants', 'name').lean();
  const hasMore = meetings.length > 500; if (hasMore) meetings.pop();
  res.json({ success: true, meetings, hasMore });
}));
router.post('/', wrap(async (req, res) => {
  const data = fields(req.body);
  let conversation, participants;
  if (req.body.participantIds !== undefined) {
    participants = await invitees(req.body.participantIds, req.user._id);
    conversation = await createRoom(req.user._id, participants, data.title);
  } else {
    if (!validId(req.body.conversationId)) throw fail(400, 'Choose participants or a conversation');
    conversation = await Conversation.findOne({ _id: req.body.conversationId, 'members.user': req.user._id });
    if (!conversation) throw fail(404, 'Conversation not found');
    participants = await User.find({ _id: { $in: conversation.members.map(member => member.user) }, isActive: true }).distinct('_id');
    if (participants.length < 2) throw fail(400, 'Add at least one active participant');
  }
  const meeting = await Meeting.create({ ...data, conversation: conversation._id, organizer: req.user._id, participants,
    responses: [{ user: req.user._id, response: 'accepted' }] });
  await notify(meeting, 'meeting_invitation');
  res.status(201).json({ success: true, meeting: await populate(meeting) });
}));
router.get('/:id', wrap(async (req, res) => res.json({ success: true, meeting: await populate(await findMeeting(req)) })));
router.patch('/:id', wrap(async (req, res) => {
  const meeting = await findMeeting(req);
  if (String(meeting.organizer) !== String(req.user._id)) throw fail(403, 'Only the organizer can edit this meeting');
  if (meeting.status !== 'scheduled') throw fail(409, 'Only scheduled meetings can be edited');
  Object.assign(meeting, fields(req.body));
  let managedRoom;
  if (req.body.participantIds !== undefined) {
    const participants = await invitees(req.body.participantIds, req.user._id);
    managedRoom = await Conversation.findOne({ _id: meeting.conversation, purpose: 'meeting' });
    // Legacy conversation invitations become a private room without changing a chat.
    if (!managedRoom) managedRoom = await createRoom(req.user._id, participants, meeting.title);
    meeting.conversation = managedRoom._id; meeting.participants = participants;
  }
  // Changes to the invitation require attendees to confirm again.
  meeting.responses = [{ user: req.user._id, response: 'accepted' }];
  meeting.notificationRevision = (meeting.notificationRevision || 0) + 1;
  await meeting.save();
  if (managedRoom) await Conversation.updateOne({ _id: managedRoom._id }, { $set: { name: meeting.title.slice(0, 80), members: meeting.participants.map(user => ({ user })) } });
  await notify(meeting, 'meeting_updated');
  res.json({ success: true, meeting: await populate(meeting) });
}));
router.post('/:id/cancel', wrap(async (req, res) => {
  const meeting = await findMeeting(req);
  if (String(meeting.organizer) !== String(req.user._id)) throw fail(403, 'Only the organizer can cancel this meeting');
  if (meeting.status !== 'scheduled') throw fail(409, 'Only scheduled meetings can be cancelled');
  meeting.status = 'cancelled'; meeting.notificationRevision = (meeting.notificationRevision || 0) + 1; await meeting.save();
  await notify(meeting, 'meeting_cancelled');
  res.json({ success: true, meeting: await populate(meeting) });
}));
router.post('/:id/rsvp', wrap(async (req, res) => {
  const meeting = await findMeeting(req);
  if (meeting.status !== 'scheduled') throw fail(409, 'This invitation is no longer open');
  if (!['accepted', 'declined', 'tentative'].includes(req.body.response)) throw fail(400, 'Choose a valid RSVP');
  meeting.responses = meeting.responses.filter(item => String(item.user) !== String(req.user._id));
  meeting.responses.push({ user: req.user._id, response: req.body.response });
  await meeting.save(); res.json({ success: true, meeting: await populate(meeting) });
}));
module.exports = router;
