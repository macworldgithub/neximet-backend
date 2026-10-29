const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const { publish } = require('../services/chatEvents');
const chatMedia = require('../services/chatMedia');
const chatAttachments = require('../services/chatAttachments');
const { pipeline } = require('node:stream/promises');

const { executive, validateContacts } = require('../services/clientAccess');
const publicUser = '_id name department role isActive';
const validId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (handler) => async (req, res, next) => {
  try { await handler(req, res); } catch (error) {
    if (req.files?.length) await chatAttachments.discardUnused(req.files).catch(cleanup => console.warn('Chat attachment cleanup failed:', cleanup.message));
    next(error);
  }
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
  for (const attachment of value.attachments || []) delete attachment.fileId;
  if (!value.attachment?.name && value.attachments?.length === 1) value.attachment = value.attachments[0];
  return value;
}

exports.getPeople = wrap(async (req, res) => {
  const people = await User.find({ isActive: true, _id: { $ne: req.user._id }, ...(req.user.role === 'Client' ? { role: { $in: ['CEO', 'Super Admin'] } } : !executive(req.user) ? { role: { $ne: 'Client' } } : {}) }).select(publicUser).sort({ name: 1 }).lean();
  res.json({ success: true, people });
});

exports.listConversations = wrap(async (req, res) => {
  const conversations = await Conversation.aggregate([
    { $match: { 'members.user': req.user._id, purpose: { $ne: 'meeting' } } },
    { $sort: { lastActivityAt: -1, _id: -1 } },
    { $lookup: { from: Message.collection.name, let: { chat: '$_id' }, pipeline: [
      { $match: { readBy: { $ne: req.user._id }, $expr: { $and: [{ $eq: ['$conversation', '$$chat'] }, { $ne: ['$sender', req.user._id] }] } } },
      { $count: 'count' },
    ], as: 'unread' } },
    { $lookup: { from: Message.collection.name, let: { chat: '$_id' }, pipeline: [
      { $match: { $expr: { $eq: ['$conversation', '$$chat'] } } },
      { $sort: { sequence: -1 } }, { $limit: 1 },
      { $project: { text: 1, sender: 1, sequence: 1, createdAt: 1, 'attachment.name': 1, 'attachments.name': 1 } },
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
  await validateContacts(req.user, ids);
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
  await publish(conversation, 'chat:conversation', { conversationId: String(conversation._id) });
  res.status(201).json({ success: true, conversation });
});

exports.getConversation = wrap(async (req, res) => {
  res.json({ success: true, conversation: await populateConversation(await membership(req)) });
});

exports.addMembers = wrap(async (req, res) => {
  if (!executive(req.user)) throw fail(403, 'Only CEOs and Super Admins can add conversation members');
  const conversation = await membership(req);
  if (conversation.purpose === 'meeting') throw fail(400, 'Use meeting invitations for meeting rooms');
  const ids = req.body.participantIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 49 || ids.some(id => !validId(id))) throw fail(400, 'Choose valid members');
  const existing = conversation.members.map(member => String(member.user));
  const added = [...new Set(ids.map(id => id.toLowerCase()))].filter(id => !existing.includes(id));
  if (existing.length + added.length > 50) throw fail(400, 'Conversations support up to 50 members');
  await validateContacts(req.user, added);
  // One atomic update avoids duplicate membership under concurrent invitations.
  const updated = await Conversation.findOneAndUpdate({ _id: conversation._id, 'members.user': req.user._id, ...(added.length ? { $nor: [{ 'members.user': { $in: added } }] } : {}), $expr: { $lte: [{ $add: [{ $size: '$members' }, added.length] }, 50] } },
    { $addToSet: { members: { $each: added.map(user => ({ user, typingUntil: null })) } }, $set: { kind: 'group', name: conversation.name || 'Client conversation' }, $unset: { directKey: 1 } }, { new: true });
  if (!updated) throw fail(409, 'Conversation changed. Refresh and try again');
  await publish(updated, 'chat:conversation', { conversationId: String(updated._id) });
  res.json({ success: true, conversation: await populateConversation(updated) });
});

exports.getDeliveries = wrap(async (req, res) => {
  const ids = await Conversation.find({ 'members.user': req.user._id }).distinct('_id');
  const messages = await Message.find({ conversation: { $in: ids }, sender: { $ne: req.user._id }, deliveredBy: { $ne: req.user._id } }).sort({ _id: 1 }).limit(100).populate('sender', publicUser).lean();
  res.json({ success: true, messages: messages.map(serializeMessage) });
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

exports.authorizeUpload = async (req, res, next) => {
  try { req.chatConversation = await membership(req); next(); } catch (error) { next(error); }
};

exports.sendMessage = wrap(async (req, res) => {
  await Message.init();
  const conversation = req.chatConversation || await membership(req);
  const { text = '', clientId } = req.body;
  if (typeof text !== 'string' || text.trim().length > 4000 || (!text.trim() && !req.files?.length)) throw fail(400, 'Enter a message (up to 4,000 characters) or attach a file');
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) throw fail(400, 'Invalid message request ID');
  const key = { conversation: conversation._id, sender: req.user._id, clientId };
  let message = await Message.findOne(key);
  if (!message) {
    const attachments = (req.files || []).map(({ name, size, mimeType, fileId }) => ({ name, size, mimeType, fileId }));
    const sequence = await Conversation.findByIdAndUpdate(conversation._id, { $inc: { nextSequence: 1 } }, { new: true });
    try {
      message = await Message.create({ ...key, sequence: sequence.nextSequence, text: text.trim(), attachments, readBy: [req.user._id], deliveredBy: [req.user._id] });
    } catch (error) {
      if (error.code !== 11000) throw error;
      message = await Message.findOne(key);
      if (!message) throw error;
    }
  }
  if (req.files?.length) await chatAttachments.discardUnused(req.files);
  // Repair activity metadata on retries too, after the durable message write.
  await Conversation.updateOne({ _id: conversation._id, 'members.user': req.user._id }, { $max: { lastActivityAt: message.createdAt }, $set: { 'members.$.typingUntil': null } });
  await message.populate('sender', publicUser);
  await publish(conversation, 'chat:message', { conversationId: String(conversation._id), message: serializeMessage(message) });
  await publish(conversation, 'chat:typing', { conversationId: String(conversation._id), userId: String(req.user._id), typingUntil: null });
  // Persist the notification outbox before acknowledging. Vercel waitUntil
  // retains delivery work after the response without delaying the sent tick.
  await require('../services/chatPush').notifyMessage(conversation, message).catch((error) => console.warn('Chat push deferred:', error.message));
  res.status(201).json({ success: true, message: serializeMessage(message) });
});

async function receipt(req, res, read) {
  const conversation = await membership(req);
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100 || messageIds.some((id) => !validId(id))) throw fail(400, 'Invalid read position');
  const ids = await Message.find({ conversation: conversation._id, _id: { $in: messageIds } }).distinct('_id');
  await Message.updateMany({ _id: { $in: ids } }, { $addToSet: { deliveredBy: req.user._id, ...(read ? { readBy: req.user._id } : {}) } });
  if (ids.length) await publish(conversation, 'chat:receipt', { conversationId: String(conversation._id), messageIds: ids.map(String), userId: String(req.user._id), status: read ? 'read' : 'delivered' });
  res.json({ success: true });
}
exports.markRead = wrap((req, res) => receipt(req, res, true));
exports.markDelivered = wrap((req, res) => receipt(req, res, false));

exports.setTyping = wrap(async (req, res) => {
  const conversation = await membership(req);
  if (typeof req.body.typing !== 'boolean') throw fail(400, 'Invalid typing state');
  const typingUntil = req.body.typing ? new Date(Date.now() + 6000) : null;
  await Conversation.updateOne({ _id: req.params.id, 'members.user': req.user._id }, { $set: { 'members.$.typingUntil': typingUntil } });
  await publish(conversation, 'chat:typing', { conversationId: String(conversation._id), userId: String(req.user._id), typingUntil });
  res.json({ success: true });
});

exports.downloadAttachment = wrap(async (req, res) => {
  const conversation = await membership(req);
  if (!validId(req.params.messageId)) throw fail(400, 'Invalid message');
  const message = await Message.findOne({ _id: req.params.messageId, conversation: conversation._id }).select('+attachment.data +attachments.fileId');
  const index = req.query.index === undefined ? 0 : Number(req.query.index);
  if (!Number.isSafeInteger(index) || index < 0) throw fail(400, 'Invalid attachment');
  const attachment = message?.attachments?.length ? message.attachments[index] : index === 0 ? message?.attachment : null;
  if (!attachment || (!attachment.fileId && !attachment.data)) throw fail(404, 'Attachment not found');
  let prefix = attachment.data;
  if (attachment.fileId) {
    const stored = await chatAttachments.bucket().find({ _id: attachment.fileId }).next();
    if (!stored) throw fail(404, 'Attachment not found');
    const chunk = await require('mongoose').connection.db.collection('chatAttachments.chunks').findOne({ files_id: attachment.fileId, n: 0 });
    prefix = chunk ? Buffer.from(chunk.data.buffer) : Buffer.alloc(0);
  }
  const preview = req.query.preview === '1';
  const type = preview ? chatMedia.mediaType(prefix) : null;
  if (preview && !type) throw fail(415, 'This attachment cannot be previewed. Download it to open it on your device.');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  if (attachment.fileId) await pipeline(chatAttachments.bucket().openDownloadStream(attachment.fileId), res);
  else res.send(attachment.data);
});
