const DEFAULT_ANSWER_SETTINGS = Object.freeze({
  mode: 'local',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-terra'
});

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]';
}

function normalizeApiBaseUrl(value) {
  const input = String(value || DEFAULT_ANSWER_SETTINGS.baseUrl).trim();
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('API 地址格式不正确，请填写例如 https://api.openai.com/v1');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址不能包含账号、密码、查询参数或锚点。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('远程 API 必须使用 HTTPS；仅本机 localhost 可使用 HTTP。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function normalizeModel(value) {
  const model = String(value || '').trim();
  if (!model) throw new Error('请填写 API 模型名。');
  if (model.length > 160) throw new Error('API 模型名过长。');
  return model;
}

function normalizeAnswerSettings(value = {}) {
  return {
    mode: value.mode === 'api' ? 'api' : 'local',
    baseUrl: normalizeApiBaseUrl(value.baseUrl),
    model: normalizeModel(value.model || DEFAULT_ANSWER_SETTINGS.model)
  };
}

function buildChatCompletionsUrl(baseUrl) {
  const normalized = normalizeApiBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(new URL(normalized).pathname)) return normalized;
  return `${normalized}/chat/completions`;
}

function buildChatCompletionsBody(hintRequest, settings) {
  const normalized = normalizeAnswerSettings(settings);
  const messages = Array.isArray(hintRequest?.messages)
    ? hintRequest.messages
        .filter((message) => message && ['system', 'user', 'assistant'].includes(message.role))
        .map((message) => ({ role: message.role, content: String(message.content || '') }))
    : [];
  if (!messages.length) throw new Error('没有可发送给回答模型的消息。');
  return { model: normalized.model, messages, stream: false };
}

function extractChatCompletionsText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

module.exports = {
  DEFAULT_ANSWER_SETTINGS,
  buildChatCompletionsBody,
  buildChatCompletionsUrl,
  extractChatCompletionsText,
  normalizeAnswerSettings,
  normalizeApiBaseUrl
};
