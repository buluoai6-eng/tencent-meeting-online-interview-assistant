const { likelyQuestion } = require('./question-detector');

const EXPLICIT_QUESTION = /[?？]\s*$/;
const QUESTION_WORDS = /(?:为什么|为何|如何|怎么|什么|哪些|哪个|哪种|是否|有没有|能不能|能否|可否|你觉得|你认为|what|why|how|could you|can you|would you)/i;
const REQUEST_START = /^(?:(?:好|好的|那|那么|接下来|下面|再|然后|关于)\s*)*(?:请(?:你|您)?|麻烦(?:你|您)?|可以|能否)?\s*(?:介绍|讲|谈|说|聊|解释|阐述|说明|分析|比较|对比|区分|评价|判断|列举|举例|概述|总结|拆解|计算|回答|分享)/i;
const IMPLIED_REQUEST = /(?:的(?:主要|核心|本质)?区别(?:，|,|。|、|$)|各?举.{0,8}(?:例子|案例)|意味着什么|原因(?:和|及|与)风险|影响有哪些|处理方法|会计处理(?:，|,|。|$)|核心步骤(?:，|,|。|$)|审计程序(?:，|,|。|$))/i;
const CANDIDATE_RESPONSE = /(?:^|[，。,.；;\s])(?:我|我们|本人|我的|我们当时|我当时|我负责|我参与|我认为|我的理解|在我看来|首先|其次|最后|具体来说|举个例子|例如|所以|因此|结果是|这说明)/i;
const ANSWER_EXPLANATION = /(?:是指|指的是|主要包括|可以分为|原因在于|区别在于|处理方式是|计算公式是|具体做法是)/i;

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value) {
  const normalized = normalizedText(value);
  const result = new Set();
  if (normalized.length === 1) result.add(normalized);
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function containmentSimilarity(left, right) {
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  if (!leftPairs.size || !rightPairs.size) return 0;
  let overlap = 0;
  for (const pair of leftPairs) {
    if (rightPairs.has(pair)) overlap += 1;
  }
  return overlap / Math.min(leftPairs.size, rightPairs.size);
}

function looksLikeCandidateResponse(text) {
  const normalized = String(text || '').trim();
  return CANDIDATE_RESPONSE.test(normalized) || ANSWER_EXPLANATION.test(normalized);
}

function isStrongQuestion(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (EXPLICIT_QUESTION.test(normalized) || QUESTION_WORDS.test(normalized) || REQUEST_START.test(normalized)) return true;
  return normalized.length <= 90 && !looksLikeCandidateResponse(normalized) && IMPLIED_REQUEST.test(normalized);
}

class TurnGuard {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastQuestion = '';
    this.lastHint = '';
  }

  evaluate(transcript) {
    const text = String(transcript || '').trim();
    if (!likelyQuestion(text)) return { allow: false, reason: 'not-question' };
    if (!this.lastHint) return { allow: true, reason: 'first-question' };

    const repeatedQuestion = containmentSimilarity(text, this.lastQuestion);
    if (repeatedQuestion >= 0.86) return { allow: false, reason: 'repeated-question' };

    if (isStrongQuestion(text)) return { allow: true, reason: 'strong-question' };
    if (looksLikeCandidateResponse(text)) return { allow: false, reason: 'candidate-response' };

    const answerEcho = containmentSimilarity(text, this.lastHint);
    if (answerEcho >= 0.4) return { allow: false, reason: 'answer-echo' };
    return { allow: false, reason: 'answer-protection' };
  }

  recordAnswer(question, hint) {
    this.lastQuestion = String(question || '').trim();
    this.lastHint = String(hint || '').trim();
  }
}

module.exports = {
  TurnGuard,
  containmentSimilarity,
  isStrongQuestion,
  looksLikeCandidateResponse
};
