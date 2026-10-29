const User = require('../models/User');
const executive = user => ['CEO', 'Super Admin'].includes(user?.role);
const fail = (status, message) => Object.assign(new Error(message), { status });
// Clients initiate contact with executives. Staff may only introduce clients
// into conversations when an executive explicitly selects them.
async function validateContacts(actor, participantIds) {
  const people = await User.find({ _id: { $in: participantIds }, isActive: true }).select('_id role');
  if (people.length !== participantIds.length) throw fail(400, 'One or more selected people are unavailable');
  if (actor.role === 'Client' && people.some(person => !executive(person))) throw fail(403, 'Clients can invite CEOs and Super Admins. Ask an administrator to add other members.');
  if (!executive(actor) && actor.role !== 'Client' && people.some(person => person.role === 'Client')) throw fail(403, 'Only CEOs and Super Admins can invite clients.');
  return people;
}
module.exports = { executive, validateContacts };
