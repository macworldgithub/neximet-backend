const PROVIDERS = ['openai', 'claude', 'gemini'];
const MAX_REPLY_CHARS = 48000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function providerId(value) {
  if (!PROVIDERS.includes(value)) fail('Choose GPT, Claude, or Gemini.');
  return value;
}
function validateTurn(body) {
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 12000) fail('Enter a message of up to 12,000 characters.');
  if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(body.requestId)) fail('Invalid message request. Refresh and try again.');
  return { text: body.text.trim(), requestId: body.requestId };
}
function providerError(status, { provider, error = {} } = {}) {
  const name = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini' }[provider] || 'This provider';
  const codes = [error.code, error.type, error.status].filter(value => typeof value === 'string').map(value => value.toLowerCase());
  // Only use upstream text for classification; never echo or persist it. Claude
  // reports low credit as HTTP 400/invalid_request_error, without a billing code.
  const message = typeof error.message === 'string' ? error.message : '';
  const make = (message, status, code) => Object.assign(new Error(message), { status, code });
  // Specific machine codes take precedence over a broad insufficient_quota type.
  if (codes.some(code => ['organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'billing_hard_limit_reached', 'usage_limit_exceeded'].includes(code))) {
    return make(`${name} has reached an API spending or usage limit. Check the limits in your provider's API billing settings before sending again.`, 429, 'ai_spend_limit');
  }
  if (status === 402 || codes.some(code => ['credit_balance_exhausted', 'insufficient_quota', 'insufficient_credits', 'billing_not_active', 'billing_disabled'].includes(code)) || /credit balance.*(?:low|exhausted|depleted|insufficient)|insufficient.*credits|(?:exhausted|depleted).*credits|billing.*(?:not enabled|disabled|not active)|(?:enable|set up).*billing|purchase.*credits/i.test(message)) {
    return make(`${name} API credits are insufficient or API billing is not enabled. Check your provider's API billing balance and add or enable credits before sending again.`, 402, 'ai_billing_required');
  }
  if ([401, 403].includes(status) || codes.some(code => ['authentication_error', 'permission_error', 'permission_denied', 'unauthenticated', 'invalid_api_key'].includes(code))) return make('This provider rejected the API key or model access. Check AI connections and your provider permissions.', 422, 'ai_auth_error');
  if (provider === 'gemini' && (status === 429 || codes.includes('resource_exhausted'))) return make('Gemini request or token quota has been reached. Wait for the applicable limit to reset, then send again. Check the quota for your project and selected model in Google AI Studio.', 429, 'ai_quota_exhausted');
  if (status === 429 || codes.some(code => ['rate_limit_error', 'rate_limit_exceeded', 'resource_exhausted'].includes(code))) return make('The provider limit or API credit quota has been reached. Check provider usage and billing, or wait for the rate limit to reset.', 429, 'ai_rate_limit');
  if ([400, 404].includes(status) || codes.some(code => ['invalid_request_error', 'invalid_request', 'invalid_argument', 'not_found_error', 'model_not_found', 'context_length_exceeded'].includes(code))) return make('The provider could not use this model or conversation. Refresh models in AI connections, or start a new chat with another model.', 422, 'ai_invalid_request');
  return make('The AI provider is unavailable or the response was interrupted. Please try again shortly.', 502, 'ai_provider_unavailable');
}

// Parse SSE incrementally, including UTF-8 characters and CRLF split across chunks.
async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { throw providerError(502); }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 2 * 1024 * 1024) throw providerError(502);
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parse(buffer); if (event) yield event; }
}

function createAIService({ fetchImpl = fetch } = {}) {
  const headers = (provider, key) => provider === 'openai'
    ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : provider === 'claude'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
      : { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
  async function request(url, provider, key, options = {}) {
    // Hosts/paths are application-owned; keys are headers, never URL parameters.
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', headers: headers(provider, key) }); }
    catch (error) { if (options.signal?.aborted) throw error; throw providerError(502, { provider }); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw providerError(response.status, { provider, error: payload?.error || {} });
    }
    return response;
  }
  return {
    async models(provider, key) {
      providerId(provider);
      const signal = AbortSignal.timeout(20000);
      const models = [];
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const url = provider === 'openai' ? 'https://api.openai.com/v1/models'
          : provider === 'claude' ? `https://api.anthropic.com/v1/models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}`
            : `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`;
        const response = await request(url, provider, key, { signal });
        let result;
        try { result = await response.json(); } catch { throw providerError(502); }
        for (const model of result.data || result.models || []) {
          const id = provider === 'gemini' ? model.name?.replace(/^models\//, '') : model.id;
          if (typeof id !== 'string' || !/^[\w.-]{1,150}$/.test(id)) continue;
          if (provider === 'openai' && (!/^gpt-/.test(id) || /audio|realtime|image|transcribe|search|tts|codex/.test(id))) continue;
          // Older GPT-3.5/GPT-4 chat-completion-only models cannot use Responses.
          if (provider === 'openai' && /^gpt-(?:3\.|4(?:-|$))/.test(id)) continue;
          if (provider === 'gemini' && (!/^gemini-/.test(id) || !model.supportedGenerationMethods?.includes('generateContent') || /image|tts|live|robotics/.test(id))) continue;
          models.push({ id, name: model.display_name || model.displayName || id });
        }
        cursor = provider === 'claude' && result.has_more ? result.last_id : provider === 'gemini' ? result.nextPageToken : '';
        if (!cursor) break;
      }
      const unique = [...new Map(models.map(model => [model.id, model])).values()].sort((a, b) => a.name.localeCompare(b.name));
      if (!unique.length) fail('No supported chat models are available for this API key. Check your provider permissions.', 422);
      return unique;
    },
    async generate({ provider, key, model, messages, signal, onText }) {
      providerId(provider);
      if (!/^[\w.-]{1,150}$/.test(model)) fail('Invalid model.');
      let url, body;
      if (provider === 'openai') {
        url = 'https://api.openai.com/v1/responses';
        body = { model, input: messages.map(({ role, content }) => ({ role, content })), store: false, stream: true, max_output_tokens: 4096 };
      } else if (provider === 'claude') {
        url = 'https://api.anthropic.com/v1/messages';
        // Consecutive user turns can follow a failed/cancelled assistant turn.
        const merged = [];
        for (const { role, content } of messages) {
          if (merged.at(-1)?.role === role) merged.at(-1).content += `\n\n${content}`;
          else merged.push({ role, content });
        }
        body = { model, messages: merged, stream: true, max_tokens: 4096 };
      } else {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        body = { contents: messages.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] })), generationConfig: { maxOutputTokens: 4096 } };
      }
      const response = await request(url, provider, key, { method: 'POST', body: JSON.stringify(body), signal });
      if (!response.body) throw providerError(502);
      let complete = false, limited = false, size = 0;
      for await (const event of readEvents(response.body)) {
        if (signal.aborted) throw signal.reason;
        // OpenAI can return HTTP 200, then an `error` with top-level `code`,
        // followed by response.failed with the cause nested at response.error.
        if (event.error || ['error', 'response.failed'].includes(event.type)) {
          const error = event.error || event.response?.error || event;
          throw providerError(typeof error.code === 'number' ? error.code : 502, { provider, error });
        }
        let text = '';
        if (provider === 'openai') {
          if (event.type === 'response.output_text.delta') text = event.delta || '';
          if (event.type === 'response.refusal.delta') text = event.delta || '';
          if (['response.completed', 'response.incomplete'].includes(event.type)) { complete = true; limited = event.type === 'response.incomplete'; }
        } else if (provider === 'claude') {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text = event.delta.text || '';
          if (event.type === 'message_delta') limited = event.delta?.stop_reason === 'max_tokens';
          if (event.type === 'message_stop') complete = true;
        } else {
          const candidate = event.candidates?.[0];
          if (event.promptFeedback?.blockReason || candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) fail('The provider could not return this response. Try rephrasing your message.', 422);
          text = (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');
          if (candidate?.finishReason) { complete = true; limited = candidate.finishReason === 'MAX_TOKENS'; }
        }
        if (typeof text !== 'string') throw providerError(502);
        if (text) {
          const remaining = MAX_REPLY_CHARS - size;
          const next = text.slice(0, remaining);
          size += next.length;
          onText(next);
          if (size >= MAX_REPLY_CHARS) return { limited: true };
        }
      }
      if (!complete) throw providerError(502);
      if (!size) fail('The model returned no text. Try another model or rephrase your message.', 422);
      return { limited };
    },
  };
}
module.exports = { PROVIDERS, MAX_REPLY_CHARS, fail, providerId, validateTurn, providerError, readEvents, createAIService };
