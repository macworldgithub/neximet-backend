const ChatEvent = require('../models/ChatEvent');

async function publish(conversation, name, data) {
  // Await persistence before acknowledging a mutation. An HTTP invocation need
  // not stay alive to finish an in-memory broadcast on another instance.
  await ChatEvent.create({
    users: conversation.members.map((member) => member.user?._id || member.user),
    name,
    data,
  });
}
module.exports = { publish };
