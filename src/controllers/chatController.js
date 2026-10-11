const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');

const publicUser = '_id name department role isActive';
const validId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (handler) => async (req, res, next) => {
  try { await handler(req, res); } catch (error) { next(error); }
};
async function membership(req) {
  if (!validId(req.params.id)) throw fail(400, 'Invalid conversation');
  const conversation = await Conversation.findOne({ _id: req.params.id, 'members.user': req.user._id });
  if (!conversation) throw fail(404, 'Conversation not found');
  return conversation;
}
async function populateConversation(conversation) {
  return conversation.populate('members.user', publicUser);
}
function serializeMessage(message) {
  const value = message.toObject ? message.toObject() : message;
  if (value.attachment) delete value.attachment.data;
  return value;
}

exports.getPeople = wrap(async (req, res) => {
  const people = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select(publicUser).sort({ name: 1 }).lean();
  res.json({ success: true, people });
});

exports.listConversations = wrap(async (req, res) => {
  const conversations = await Conversation.aggregate([
    { $match: { 'members.user': req.user._id } },
    { $sort: { lastActivityAt: -1, _id: -1 } },
    { $lookup: { from: Message.collection.name, let: { chat: '$_id' }, pipeline: [
      { $match: { readBy: { $ne: req.user._id }, $expr: { $and: [{ $eq: ['$conversation', '$$chat'] }, { $ne: ['$sender', req.user._id] }] } } },
      { $count: 'count' },
    ], as: 'unread' } },
    { $lookup: { from: Message.collection.name, let: { chat: '$_id' }, pipeline: [
      { $match: { $expr: { $eq: ['$conversation', '$$chat'] } } },
      { $sort: { sequence: -1 } }, { $limit: 1 },
      { $project: { text: 1, sender: 1, sequence: 1, createdAt: 1, 'attachment.name': 1 } },
    ], as: 'latest' } },
    { $set: { unreadCount: { $ifNull: [{ $arrayElemAt: ['$unread.count', 0] }, 0] }, lastMessage: { $arrayElemAt: ['$latest', 0] } } },
    { $unset: ['myMembership', 'unread', 'latest', 'directKey'] },
  ]);
  await Conversation.populate(conversations, { path: 'members.user', select: publicUser });
  res.json({ success: true, conversations, unreadCount: conversations.reduce((sum, chat) => sum + chat.unreadCount, 0) });
});

exports.createConversation = wrap(async (req, res) => {
  await Conversation.init();
  const { kind, name, participantIds } = req.body;
  if (!['direct', 'group'].includes(kind) || !Array.isArray(participantIds) || participantIds.some((id) => !validId(id))) {
    throw fail(400, 'Choose valid participants and a conversation type');
  }
  const ids = [...new Set(participantIds.map((id) => id.toLowerCase()))].filter((id) => id !== String(req.user._id));
  if ((kind === 'direct' && ids.length !== 1) || (kind === 'group' && (ids.length < 2 || ids.length > 49))) {
    throw fail(400, kind === 'direct' ? 'Choose one teammate' : 'Choose between 2 and 49 teammates');
  }
  if (kind === 'group' && (typeof name !== 'string' || !name.trim() || name.trim().length > 80)) throw fail(400, 'Group name must be 1–80 characters');
  if (await User.countDocuments({ _id: { $in: ids }, isActive: true }) !== ids.length) throw fail(400, 'One or more teammates are unavailable');
  const allIds = [...ids, String(req.user._id)].sort();
  const data = { kind, members: allIds.map((user) => ({ user })), createdBy: req.user._id, ...(kind === 'group' ? { name: name.trim() } : { directKey: allIds.join(':') }) };
  let conversation;
  if (kind === 'direct') {
    try {
      conversation = await Conversation.findOneAndUpdate({ directKey: data.directKey }, { $setOnInsert: data }, { upsert: true, new: true, runValidators: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      conversation = await Conversation.findOne({ directKey: data.directKey });
    }
  } else conversation = await Conversation.create(data);
  await populateConversation(conversation);
  res.status(201).json({ success: true, conversation });
});

exports.getMessages = wrap(async (req, res) => {
  const conversation = await membership(req);
  const { before, after } = req.query;
  if ((before && after) || [before, after].some((value) => value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) throw fail(400, 'Invalid message cursor');
  const query = { conversation: conversation._id };
  if (before !== undefined) query.sequence = { $lt: Number(before) };
  if (after !== undefined) query.sequence = { $gt: Number(after) };
  const messages = await Message.find(query).sort({ sequence: after !== undefined ? 1 : -1 }).limit(51).populate('sender', publicUser).lean();
  const hasMore = messages.length > 50;
  if (hasMore) messages.pop();
  if (after === undefined) messages.reverse();
  await populateConversation(conversation);
  res.json({ success: true, messages: messages.map(serializeMessage), hasMore, conversation });
});

exports.sendMessage = wrap(async (req, res) => {
  await Message.init();
  const conversation = await membership(req);
  const { text = '', clientId } = req.body;
  if (typeof text !== 'string' || text.trim().length > 4000 || (!text.trim() && !req.file)) throw fail(400, 'Enter a message (up to 4,000 characters) or attach a file');
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) throw fail(400, 'Invalid message request ID');
  const key = { conversation: conversation._id, sender: req.user._id, clientId };
  let message = await Message.findOne(key);
  if (!message) {
    const sequence = await Conversation.findByIdAndUpdate(conversation._id, { $inc: { nextSequence: 1 } }, { new: true });
    const attachment = req.file ? { name: req.file.originalname.replace(/[\r\n\x00]/g, '').slice(0, 200), size: req.file.size, mimeType: req.file.mimetype, data: req.file.buffer } : undefined;
    try {
      message = await Message.create({ ...key, sequence: sequence.nextSequence, text: text.trim(), attachment, readBy: [req.user._id] });
    } catch (error) {
      if (error.code !== 11000) throw error;
      message = await Message.findOne(key);
      if (!message) throw error;
    }
  }
  // Repair activity metadata on retries too, after the durable message write.
  await Conversation.updateOne({ _id: conversation._id, 'members.user': req.user._id }, { $max: { lastActivityAt: message.createdAt }, $set: { 'members.$.typingUntil': null } });
  await message.populate('sender', publicUser);
  res.status(201).json({ success: true, message: serializeMessage(message) });
});

exports.markRead = wrap(async (req, res) => {
  await membership(req);
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100 || messageIds.some((id) => !validId(id))) throw fail(400, 'Invalid read position');
  // Mark only messages actually loaded by this reader, including out-of-order writes.
  await Message.updateMany({ conversation: req.params.id, _id: { $in: messageIds } }, { $addToSet: { readBy: req.user._id } });
  res.json({ success: true });
});

exports.setTyping = wrap(async (req, res) => {
  await membership(req);
  if (typeof req.body.typing !== 'boolean') throw fail(400, 'Invalid typing state');
  await Conversation.updateOne({ _id: req.params.id, 'members.user': req.user._id }, { $set: { 'members.$.typingUntil': req.body.typing ? new Date(Date.now() + 6000) : null } });
  res.json({ success: true });
});

exports.downloadAttachment = wrap(async (req, res) => {
  const conversation = await membership(req);
  if (!validId(req.params.messageId)) throw fail(400, 'Invalid message');
  const message = await Message.findOne({ _id: req.params.messageId, conversation: conversation._id }).select('+attachment.data');
  if (!message?.attachment?.data) throw fail(404, 'Attachment not found');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(message.attachment.name)}`);
  res.send(message.attachment.data);
});
