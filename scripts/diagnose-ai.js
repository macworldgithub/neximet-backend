// Read-only diagnostics. No keys, user identifiers, prompts, or replies are printed.
// --check verifies model-list access without generating a paid response.
// --generate performs one tiny (at most 32 output tokens) diagnostic generation
// per saved connection. It uses a fixed "Reply only OK" prompt, never user history.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const connect = require('../src/config/db');
const Connection = require('../src/models/AIConnection');
const Conversation = require('../src/models/AIConversation');
const { decryptKey } = require('../src/services/aiCrypto');
const { createAIService, readEvents } = require('../src/services/ai');

async function main() {
  try {
    await connect();
    const connections = await Connection.find({}).select('+keyEncrypted').sort({ updatedAt: -1 }).limit(12);
    const stats = await Conversation.aggregate([
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'assistant' } },
      { $group: { _id: { provider: '$provider', model: '$model', status: '$messages.status' }, count: { $sum: 1 } } },
    ]);
    console.log(JSON.stringify({ connections: connections.length, replies: stats }));
    const service = createAIService({ fetchImpl: async (url, options) => {
      if (options.method === 'POST' && process.argv.includes('--generate')) {
        const body = JSON.parse(options.body);
        if (url.includes('/responses')) body.max_output_tokens = 32;
        else if (url.includes('/messages')) body.max_tokens = 32;
        else body.generationConfig.maxOutputTokens = 32;
        options = { ...options, body: JSON.stringify(body) };
      }
      try {
        const response = await fetch(url, options);
        if (options.method === 'POST') {
          const diagnostic = { generationHTTP: response.status, contentType: response.headers.get('content-type') };
          if (!response.ok) {
            const body = await response.clone().json().catch(() => null);
            // Codes/types are machine fields. Never print the upstream message.
            const code = body?.error?.code || body?.error?.type || body?.error?.status;
            diagnostic.errorCode = typeof code === 'string' && /^[a-zA-Z_]{1,60}$/.test(code) ? code : 'unclassified';
            diagnostic.creditIssue = /credit balance|insufficient.*(?:credit|quota)|billing|payment|purchase.*credits/i.test(body?.error?.message || '');
          }
          if (response.ok && diagnostic.contentType?.includes('text/event-stream')) {
            const events = {}, codes = new Set();
            for await (const event of readEvents(response.clone().body)) {
              const type = typeof event.type === 'string' && /^[\w.]{1,60}$/.test(event.type) ? event.type : 'unknown';
              events[type] = (events[type] || 0) + 1;
              const code = event.code || event.error?.code || event.error?.type || event.response?.error?.code;
              if (typeof code === 'string' && /^[a-zA-Z_]{1,60}$/.test(code)) codes.add(code);
            }
            diagnostic.events = events; diagnostic.errorCodes = [...codes];
          }
          console.log(JSON.stringify(diagnostic));
        }
        return response;
      } catch (error) {
        console.log(JSON.stringify({ transportFailure: true, code: error.cause?.code || error.code || error.name }));
        throw error;
      }
    } });
    for (const connection of connections) {
      const result = { provider: connection.provider, model: connection.defaultModel };
      try {
        const key = decryptKey(connection.keyEncrypted, connection.user, connection.provider);
        result.canDecrypt = true;
        if (process.argv.includes('--check')) {
          const models = await service.models(connection.provider, key);
          result.modelAccess = true;
          result.selectedModelListed = models.some(model => model.id === connection.defaultModel);
        }
        if (process.argv.includes('--generate')) {
          let characters = 0;
          const reply = await service.generate({ provider: connection.provider, key, model: connection.defaultModel, messages: [{ role: 'user', content: 'Reply only OK.' }], signal: AbortSignal.timeout(30000), onText: text => characters += text.length });
          result.generation = { success: true, characters, limited: reply.limited };
        }
      } catch (error) {
        result.canDecrypt ??= false;
        result.failed = true;
        result.status = error.status || 500;
        result.code = error.code || 'unclassified';
      }
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.log(JSON.stringify({ diagnosticFailed: true, code: error.code || error.name }));
    process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
void main();
