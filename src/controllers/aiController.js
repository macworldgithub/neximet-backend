const crypto = require('node:crypto');
const ConnectionModel = require('../models/AIConnection');
const ConversationModel = require('../models/AIConversation');
const { encryptionKey, encryptKey, decryptKey } = require('../services/aiCrypto');
const { PROVIDERS, fail, providerId, validateTurn, createAIService } = require('../services/ai');

const validId = id => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const publicConnection = connection => ({ provider: connection.provider, connected: true, defaultModel: connection.defaultModel, models: connection.models, updatedAt: connection.updatedAt });
const publicConversation = conversation => ({ _id: conversation._id, title: conversation.title, provider: conversation.provider, model: conversation.model, messages: conversation.messages, updatedAt: conversation.updatedAt, generating: !!conversation.activeRequest?.requestId });

function createAIHandlers({ Connection = ConnectionModel, Conversation = ConversationModel, service = createAIService(), timeoutMs = 100000 } = {}) {
  const owned = req => {
    if (!validId(req.params.id)) fail('Conversation not found.', 404);
    return { _id: req.params.id, user: req.user._id };
  };
  async function recover(filter) {
    // A crashed/timed-out server must not leave a chat permanently locked.
    await Conversation.updateOne({ ...filter, 'activeRequest.expiresAt': { $lte: new Date() } }, {
      $set: { 'messages.$[pending].status': 'stopped' }, $unset: { activeRequest: 1 },
    }, { arrayFilters: [{ 'pending.status': 'pending' }] });
  }
  async function account(req, provider) {
    const connection = await Connection.findOne({ user: req.user._id, provider }).select('+keyEncrypted');
    if (!connection) fail('Connect this provider in AI connections first.', 409);
    return connection;
  }
  const endpoint = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      // Raw provider/DB errors can contain credentials or private prompts.
      if (!res.headersSent) res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Unable to complete this AI request. Please try again.', code: /^ai_[a-z_]+$/.test(error.code || '') ? error.code : undefined });
      else if (!res.writableEnded) res.end();
    }
  };
  return {
    settings: endpoint(async (req, res) => {
      const connections = await Connection.find({ user: req.user._id });
      let serverConfigured = true;
      try { encryptionKey(); } catch { serverConfigured = false; }
      res.json({ success: true, serverConfigured, connections: PROVIDERS.map(provider => {
        const saved = connections.find(item => item.provider === provider);
        return saved ? publicConnection(saved) : { provider, connected: false, models: [], defaultModel: '' };
      }) });
    }),
    connect: endpoint(async (req, res) => {
      const provider = providerId(req.params.provider);
      encryptionKey();
      const { apiKey, defaultModel } = req.body;
      if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 1024 || /\s/.test(apiKey))) fail('Enter a valid API key without spaces.');
      const existing = await Connection.findOne({ user: req.user._id, provider }).select('+keyEncrypted');
      const key = apiKey || (existing && decryptKey(existing.keyEncrypted, req.user._id, provider));
      if (!key || key.length < 10) fail('Enter your provider API key.');
      const models = await service.models(provider, key);
      const preferred = defaultModel || (models.some(item => item.id === existing?.defaultModel) ? existing.defaultModel : models[0].id);
      if (typeof preferred !== 'string' || !models.some(item => item.id === preferred)) fail('Choose an available model.');
      const connection = await Connection.findOneAndUpdate({ user: req.user._id, provider }, { $set: { keyEncrypted: encryptKey(key, req.user._id, provider), models, defaultModel: preferred } }, { upsert: true, new: true, runValidators: true });
      res.json({ success: true, connection: publicConnection(connection) });
    }),
    disconnect: endpoint(async (req, res) => {
      const provider = providerId(req.params.provider);
      await Connection.deleteOne({ user: req.user._id, provider });
      res.json({ success: true });
    }),
    list: endpoint(async (req, res) => {
      const page = Number(req.query.page || 1), search = req.query.q || '';
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || typeof search !== 'string' || search.length > 100) fail('Invalid conversation search.');
      const filter = { user: req.user._id };
      if (search.trim()) filter.title = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const rows = await Conversation.find(filter).select('_id title provider model updatedAt').sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * 50).limit(51).lean();
      res.json({ success: true, conversations: rows.slice(0, 50), hasMore: rows.length > 50 });
    }),
    create: endpoint(async (req, res) => {
      const provider = providerId(req.body.provider), connection = await account(req, provider);
      const model = req.body.model || connection.defaultModel;
      if (typeof model !== 'string' || !connection.models.some(item => item.id === model)) fail('Choose an available model in AI connections.');
      const conversation = await Conversation.create({ user: req.user._id, provider, model });
      res.status(201).json({ success: true, conversation: publicConversation(conversation) });
    }),
    read: endpoint(async (req, res) => {
      const filter = owned(req);
      await recover(filter);
      const conversation = await Conversation.findOne(filter);
      if (!conversation) fail('Conversation not found.', 404);
      res.json({ success: true, conversation: publicConversation(conversation) });
    }),
    rename: endpoint(async (req, res) => {
      const { title } = req.body;
      if (typeof title !== 'string' || !title.trim() || title.length > 100) fail('Enter a title of up to 100 characters.');
      const conversation = await Conversation.findOneAndUpdate(owned(req), { $set: { title: title.trim() } }, { new: true });
      if (!conversation) fail('Conversation not found.', 404);
      res.json({ success: true, conversation: publicConversation(conversation) });
    }),
    remove: endpoint(async (req, res) => {
      const filter = owned(req);
      await recover(filter);
      const result = await Conversation.deleteOne({ ...filter, 'activeRequest.requestId': { $exists: false } });
      if (!result.deletedCount) fail('Conversation not found or a reply is still being generated.', 409);
      res.json({ success: true });
    }),
    send: endpoint(async (req, res) => {
      const filter = owned(req), { text, requestId } = validateTurn(req.body);
      await recover(filter);
      const conversation = await Conversation.findOne(filter);
      if (!conversation) fail('Conversation not found.', 404);
      // A repeated request never purchases a second generation, even after a disconnect.
      if (conversation.messages.some(item => item.requestId === requestId)) fail('This message was already submitted. Reopen the conversation to see its latest status.', 409);
      if (conversation.messages.length >= 100 || conversation.messages.reduce((size, item) => size + item.content.length, 0) + text.length > 160000) fail('This conversation is full. Start a new chat to continue.', 409);
      const connection = await account(req, conversation.provider);
      if (!connection.models.some(item => item.id === conversation.model)) fail('This model is no longer available. Start a new chat with an available model.', 409);
      const key = decryptKey(connection.keyEncrypted, req.user._id, conversation.provider);
      const userMessage = { id: crypto.randomUUID(), requestId, role: 'user', content: text, status: 'complete', createdAt: new Date() };
      const assistant = { id: crypto.randomUUID(), requestId, role: 'assistant', content: '', status: 'pending', createdAt: new Date() };
      const title = conversation.messages.length ? conversation.title : text.replace(/\s+/g, ' ').slice(0, 80);
      const locked = await Conversation.updateOne({ ...filter, 'activeRequest.requestId': { $exists: false }, 'messages.requestId': { $ne: requestId }, $expr: { $eq: [{ $size: '$messages' }, conversation.messages.length] } }, {
        $set: { title, activeRequest: { requestId, expiresAt: new Date(Date.now() + timeoutMs + 30000) } },
        $push: { messages: { $each: [userMessage, assistant] } },
      });
      if (!locked.modifiedCount) fail('A reply is already in progress. Wait for it to finish, then try again.', 409);

      const abort = new AbortController();
      let timedOut = false, content = '', status = 'complete', errorMessage = '', errorCode = '';
      const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
      const disconnect = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', disconnect);
      res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const emit = (type, data) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
      emit('start', { conversationId: String(conversation._id), title, userMessage, assistantMessage: assistant });
      const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
      try {
        const result = await service.generate({ provider: conversation.provider, key, model: conversation.model, signal: abort.signal,
          messages: [...conversation.messages.filter(item => item.content && item.status !== 'pending' && item.status !== 'error'), userMessage].map(({ role, content }) => ({ role, content })),
          onText: text => { content += text; emit('delta', { text }); },
        });
        status = result.limited ? 'limited' : 'complete';
      } catch (error) {
        status = abort.signal.aborted ? 'stopped' : 'error';
        errorMessage = timedOut ? 'This reply reached the time limit. You can ask the model to continue.' : abort.signal.aborted ? '' : error.status ? error.message : 'The reply was interrupted. Please try again.';
        errorCode = !abort.signal.aborted && /^ai_[a-z_]+$/.test(error.code || '') ? error.code : '';
      } finally {
        clearTimeout(timer); clearInterval(heartbeat); res.off('close', disconnect);
        try {
          const saved = await Conversation.updateOne({ ...filter, 'activeRequest.requestId': requestId }, {
            $set: { 'messages.$[reply].content': content, 'messages.$[reply].status': status, 'messages.$[reply].errorMessage': errorMessage, 'messages.$[reply].errorCode': errorCode }, $unset: { activeRequest: 1 },
          }, { arrayFilters: [{ 'reply.id': assistant.id }] });
          if (!saved.modifiedCount) throw new Error();
          if (errorMessage) emit('error', { message: errorMessage, code: errorCode });
          emit('done', { message: { ...assistant, content, status, errorMessage, errorCode } });
        } catch {
          emit('error', { message: 'The reply could not be saved. Copy it before leaving this page.' });
        }
        if (!res.writableEnded) res.end();
      }
    }),
  };
}
module.exports = { createAIHandlers, validId };
