const User = require('../models/User');
const Conversation = require('../models/Conversation');
const fail = message => Object.assign(new Error(message), { status: 400 });
async function invitees(participantIds, organizer) {
  if (!Array.isArray(participantIds) || participantIds.length > 7 || participantIds.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) {
    throw fail('Choose up to 7 participants (8 people including you)');
  }
  const ids = [...new Set([String(organizer), ...participantIds.map(id => id.toLowerCase())])];
  if (ids.length > 8) throw fail('Meetings support up to 8 people');
  const active = await User.find({ _id: { $in: ids }, isActive: true }).distinct('_id');
  if (active.length !== ids.length) throw fail('One or more selected users are unavailable');
  return active;
}
async function createRoom(organizer, participants, title = 'Team meeting') {
  return Conversation.create({ kind: 'group', purpose: 'meeting', name: title.slice(0, 80), createdBy: organizer,
    members: participants.map(user => ({ user })) });
}
module.exports = { invitees, createRoom };
