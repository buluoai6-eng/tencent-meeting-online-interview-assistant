const { selectDomainKnowledge } = require('./domain-knowledge');
const { loadBundledDomainModule } = require('./domain-modules');

const BEHAVIORAL_MARKERS = [
  '自我介绍', '为什么选择', '为什么离职', '职业规划', '优势', '缺点', '弱点',
  '经历', '举例', '冲突', '失败', '挑战', '团队', '领导力', '压力', 'star',
  'tell me about', 'describe a time', 'strength', 'weakness'
];

function isBehavioralQuestion(transcript) {
  const normalized = String(transcript || '').toLowerCase();
  return BEHAVIORAL_MARKERS.some((marker) => normalized.includes(marker));
}

function normalizeHintResponse(content, transcript) {
  const behavioral = isBehavioralQuestion(transcript);
  let text = String(content || '').trim().replace(/^[-*]\s*/gm, '');
  if (!behavioral) {
    text = text
      .replace(/核心[：:]/g, '结论：')
      .replace(/结构[：:]/g, '逻辑：')
      .replace(/落点[：:]/g, '注意：');
  }
  const labels = behavioral ? ['核心：', '结构：', '落点：'] : ['结论：', '逻辑：', '注意：'];
  for (const label of labels) {
    text = text.replace(new RegExp(`(?!^)${label}`, 'g'), `\n${label}`);
  }
  return text.replace(/\n{2,}/g, '\n').trim();
}

function buildHintRequest({ transcript, context = '', prepNotes = '', model = 'qwen3.5:9b', domainModule = null }) {
  const activeModule = domainModule || loadBundledDomainModule('finance-accounting');
  const selected = selectDomainKnowledge(transcript, activeModule);
  const behavioral = isBehavioralQuestion(transcript);
  const formatInstruction = behavioral
    ? '本题已由程序判定为行为题：只输出三行，依次以“核心：”“结构：”“落点：”开头。'
    : '本题已由程序判定为技术题：只输出三行，依次以“结论：”“逻辑：”“注意：”开头。';
  return {
    request: {
      model,
      messages: [
        {
          role: 'system',
          content: [
            `你是一个经许可使用的实时线上面试辅助工具。当前领域模块：${activeModule.name}。`,
            '只提供快速回答抓手，不代替候选人完成长篇回答，不虚构经历、数字、准则条文或实时市场数据。',
            formatInstruction,
            '每行短而具体，总长度尽量控制在180个汉字以内；不要合并成一段，不展示思维过程，不使用Markdown标题或项目符号。',
            ...activeModule.answerInstructions,
            '如果输入不是问题，只输出 NO_HINT。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `最近对话：\n${String(context).slice(-1600)}`,
            `刚听到的问题：\n${transcript}`,
            `召回的“${activeModule.name}”领域知识：\n${selected.text}`,
            `候选人准备信息：\n${String(prepNotes).slice(0, 5000)}`
          ].join('\n\n')
        }
      ],
      stream: false,
      think: false,
      keep_alive: '30m',
      options: { temperature: 0.15, num_predict: 180, num_ctx: 6144 }
    },
    knowledgeSections: selected.sections,
    knowledgeVersion: selected.version,
    domainModule: { id: activeModule.id, name: activeModule.name, version: activeModule.version }
  };
}

module.exports = { buildHintRequest, isBehavioralQuestion, normalizeHintResponse };
