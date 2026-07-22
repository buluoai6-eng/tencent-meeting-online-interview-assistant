const assert = require('assert');
const {
  buildChatCompletionsBody,
  buildChatCompletionsUrl,
  extractChatCompletionsText,
  normalizeApiBaseUrl
} = require('../src/answer-provider');

assert.strictEqual(normalizeApiBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
assert.strictEqual(buildChatCompletionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
assert.strictEqual(
  buildChatCompletionsUrl('https://example.com/openai/v1/chat/completions'),
  'https://example.com/openai/v1/chat/completions'
);
assert.strictEqual(buildChatCompletionsUrl('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/chat/completions');
assert.throws(() => normalizeApiBaseUrl('http://example.com/v1'), /HTTPS/);
assert.throws(() => normalizeApiBaseUrl('https://user:pass@example.com/v1'), /不能包含/);

const body = buildChatCompletionsBody({
  messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }],
  think: false,
  keep_alive: '30m',
  options: { num_ctx: 6144 }
}, { mode: 'api', baseUrl: 'https://api.openai.com/v1', model: 'example-model' });
assert.deepStrictEqual(body, {
  model: 'example-model',
  messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }],
  stream: false
});
assert.strictEqual(extractChatCompletionsText({ choices: [{ message: { content: '回答' } }] }), '回答');
assert.strictEqual(extractChatCompletionsText({ choices: [{ message: { content: [{ type: 'text', text: '分段回答' }] } }] }), '分段回答');

console.log('answer-provider tests passed');
