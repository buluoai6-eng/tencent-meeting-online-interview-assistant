const assert = require('node:assert/strict');
const { TurnGuard, containmentSimilarity, isStrongQuestion, looksLikeCandidateResponse } = require('../src/turn-guard');

assert.equal(isStrongQuestion('请讲一下 DCF 估值的核心步骤。'), true);
assert.equal(isStrongQuestion('净利润增长但经营现金流下降，分析背后原因和风险。'), true);
assert.equal(isStrongQuestion('收入确认的五步法以及合同负债的会计处理。'), true);
assert.equal(looksLikeCandidateResponse('我认为主要原因有三点，首先是应收账款增加。'), true);
assert.ok(containmentSimilarity('营运资本增加占用了现金', '营运资本增加会占用更多现金') > 0.4);

const guard = new TurnGuard();
assert.deepEqual(guard.evaluate('权责发生制和收付实现制的区别，各举一个例子。'), {
  allow: true,
  reason: 'first-question'
});

guard.recordAnswer(
  '权责发生制和收付实现制的区别，各举一个例子。',
  '结论：权责发生制按权利义务确认，收付实现制按现金收付确认。逻辑：收入费用确认时点不同。'
);

const candidateAnswers = [
  '我认为它们最主要的区别在于确认时点不同。',
  '首先权责发生制按权利义务确认，其次收付实现制按现金收付确认。',
  '权责发生制按权利义务确认，收付实现制按现金收付确认。'
];
for (const text of candidateAnswers) {
  assert.equal(guard.evaluate(text).allow, false, `应忽略面试者回答：${text}`);
}

const nextQuestions = [
  '为什么净利润增长，经营现金流反而下降？',
  '请继续讲一下 DCF 估值的核心步骤。',
  '净利润增长但经营现金流下降，分析背后原因和风险。',
  '收入确认的五步法以及合同负债的会计处理。'
];
for (const text of nextQuestions) {
  assert.equal(guard.evaluate(text).allow, true, `应识别新的面试题：${text}`);
}

assert.equal(guard.evaluate('权责发生制和收付实现制的区别，各举一个例子。').allow, false, '应忽略重复问题');

console.log(`turn-guard: ${candidateAnswers.length} candidate answers ignored / ${nextQuestions.length} new questions accepted`);
