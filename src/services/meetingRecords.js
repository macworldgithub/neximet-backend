const Meeting = require('../models/Meeting');
const CallSession = require('../models/CallSession');

async function finish(callId, reason = 'everyone_left', at = new Date()) {
  const session = await CallSession.findOneAndUpdate({ callId, endedAt: null }, {
    $set: { endedAt: at, lastSeenAt: at, endReason: reason, 'attendance.$[open].leftAt': at },
  }, { arrayFilters: [{ 'open.leftAt': null }], new: true });
  if (session?.meeting) await Meeting.updateOne({ _id: session.meeting, activeCallId: callId }, {
    $set: { status: 'completed', activeCallId: null },
  });
  if (session) await require('./meetingNotifications').notifyCallEnded(session).catch(error => console.warn('Call-ended notification deferred:', error.message));
}
async function reconcile() {
  const stale = await CallSession.find({ endedAt: null, lastSeenAt: { $lt: new Date(Date.now() - 120000) } }).select('callId lastSeenAt').limit(100).lean();
  for (const session of stale) await finish(session.callId, 'server_disconnected', session.lastSeenAt);
}
module.exports = { finish, reconcile };
