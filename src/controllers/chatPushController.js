const jwt = require('jsonwebtoken');
const PushSubscription = require('../models/PushSubscription');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const push = require('../services/chatPush');
const { publish } = require('../services/chatEvents');
const wrap = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
const fail = (status, message) => Object.assign(new Error(message), { status });
function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    // Restrict outbound requests to the browser push services, never arbitrary URLs.
    const allowed = url.hostname === 'fcm.googleapis.com' || url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.services.mozilla.com') || url.hostname.endsWith('.notify.windows.com');
    if (!allowed || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || value.endpoint.length > 2048) return false;
    if (![value.keys?.p256dh, value.keys?.auth].every((key) => typeof key === 'string' && /^[A-Za-z\d_-]+={0,2}$/.test(key))) return false;
    const publicKey = Buffer.from(value.keys.p256dh, 'base64url');
    return publicKey.length === 65 && publicKey[0] === 4 && Buffer.from(value.keys.auth, 'base64url').length === 16;
  } catch { return false; }
}
exports.config = wrap(async (req, res) => res.json({ success: true, configured: push.configured(), publicKey: push.configured() ? process.env.WEB_PUSH_VAPID_PUBLIC_KEY : null }));
exports.subscribe = wrap(async (req, res) => {
  if (!push.configured()) throw fail(503, 'Push notifications need server configuration');
  if (!validSubscription(req.body)) throw fail(400, 'Invalid browser push subscription');
  await PushSubscription.init();
  if (await PushSubscription.countDocuments({ user: req.user._id }) >= 10 && !await PushSubscription.exists({ endpoint: req.body.endpoint, user: req.user._id })) throw fail(400, 'Device limit reached. Disable notifications on an older device first.');
  await PushSubscription.findOneAndUpdate({ endpoint: req.body.endpoint }, { user: req.user._id, keys: { p256dh: req.body.keys.p256dh, auth: req.body.keys.auth } }, { upsert: true, runValidators: true });
  res.json({ success: true });
});
exports.unsubscribe = wrap(async (req, res) => {
  if (typeof req.body.endpoint !== 'string') throw fail(400, 'Invalid subscription');
  await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.user._id });
  res.json({ success: true });
});
exports.flush = wrap(async (req, res) => { await push.flush(); res.json({ success: true }); });
exports.delivered = wrap(async (req, res) => {
  let decoded;
  try { decoded = jwt.verify(req.body.receiptToken, push.secret(), { audience: 'chat-push-delivery' }); }
  catch { throw fail(401, 'Invalid delivery receipt'); }
  if (decoded.purpose !== 'push-delivery' || ![decoded.sub, decoded.messageId, decoded.subscriptionId].every((id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id))) throw fail(401, 'Invalid delivery receipt');
  const subscription = await PushSubscription.exists({ _id: decoded.subscriptionId, user: decoded.sub });
  if (!subscription || !await User.exists({ _id: decoded.sub, isActive: true })) throw fail(401, 'Subscription no longer active');
  const message = await Message.findById(decoded.messageId);
  const conversation = message && await Conversation.findOne({ _id: message.conversation, 'members.user': decoded.sub });
  if (!conversation) throw fail(404, 'Message not found');
  await Message.updateOne({ _id: message._id }, { $addToSet: { deliveredBy: decoded.sub } });
  await publish(conversation, 'chat:receipt', { conversationId: String(conversation._id), messageIds: [String(message._id)], userId: decoded.sub, status: 'delivered' });
  res.json({ success: true });
});
