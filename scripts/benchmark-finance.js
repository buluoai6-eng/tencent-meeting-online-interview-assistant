const { performance } = require('perf_hooks');
const { buildHintRequest, normalizeHintResponse } = require('../src/hint-prompt');
const { loadBundledDomainModule } = require('../src/domain-modules');

const ollamaUrl = process.env.COACH_OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.COACH_LOCAL_LLM || 'qwen3.5:9b';
const domainModule = loadBundledDomainModule('finance-accounting');
const questions = [
  '请解释为什么一家公司的净利润增长，但经营现金流可能下降？',
  '请讲一下DCF估值的核心步骤，以及WACC应该如何计算？',
  '如果应收账款周转天数持续上升，你会如何分析原因和风险？',
  '收入确认的五步法是什么，合同负债应该如何理解？',
  '审计中如何把财务报表认定映射到具体审计程序？'
];

async function ask(question) {
  const built = buildHintRequest({
    transcript: question,
    prepNotes: '目标岗位：金融分析/财务。回答要先给结论，再解释驱动因素和风险。',
    model,
    domainModule
  });
  const started = performance.now();
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(built.request)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return {
    question,
    answer: normalizeHintResponse(data.message?.content, question),
    sections: built.knowledgeSections,
    milliseconds: performance.now() - started,
    evalCount: data.eval_count || 0,
    promptEvalCount: data.prompt_eval_count || 0
  };
}

async function main() {
  await ask('什么是资产负债表？');
  const results = [];
  for (const question of questions) {
    const result = await ask(question);
    results.push(result);
    console.log(`\n${result.question}`);
    console.log(`模块：${domainModule.name} · 知识：${result.sections.join(' / ')}`);
    console.log(`耗时：${result.milliseconds.toFixed(0)} ms`);
    console.log(result.answer);
  }
  const times = results.map((item) => item.milliseconds).sort((a, b) => a - b);
  const average = times.reduce((sum, value) => sum + value, 0) / times.length;
  console.log(`\nSUMMARY average=${average.toFixed(0)}ms median=${times[Math.floor(times.length / 2)].toFixed(0)}ms min=${times[0].toFixed(0)}ms max=${times.at(-1).toFixed(0)}ms`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
