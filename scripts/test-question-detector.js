const assert = require('node:assert/strict');
const { likelyQuestion } = require('../src/question-detector');

const shouldTrigger = [
  '请解释权责发生制和收付实现制的区别，并各举一个例子。',
  '解释权责发生制和收付实现制的区别并各举一个例子',
  '权责发生制和收付实现制的区别，各举一个例子。',
  '一家公司的净利润持续增长，但经营现金流不断下降，你会如何分析',
  '净利润增长但经营现金流下降，分析背后原因和风险。',
  '收入确认的五步法以及合同负债的会计处理',
  'Walk me through the three financial statements.'
];

const shouldIgnore = [
  '今天的面试大约持续四十分钟。',
  '我们公司主要采用权责发生制进行日常核算。',
  '公司今年收入增长了百分之二十。',
  '好的，我知道了。'
];

for (const text of shouldTrigger) assert.equal(likelyQuestion(text), true, `应触发：${text}`);
for (const text of shouldIgnore) assert.equal(likelyQuestion(text), false, `不应触发：${text}`);

console.log(`question-detector: ${shouldTrigger.length} positive / ${shouldIgnore.length} negative cases passed`);
