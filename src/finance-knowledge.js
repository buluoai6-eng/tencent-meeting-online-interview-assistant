const knowledge = require('./knowledge/finance-accounting.json');

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreSection(section, question) {
  let score = 0;
  for (const keyword of section.keywords || []) {
    const normalized = normalize(keyword);
    if (normalized && question.includes(normalized)) score += normalized.length > 3 ? 5 : 3;
  }
  if (question.includes(normalize(section.title))) score += 8;
  return score;
}

function selectFinanceKnowledge(question, { maxSections = 3, maxChars = 4200 } = {}) {
  const normalized = normalize(question);
  const ranked = knowledge.sections
    .map((section, index) => ({ section, index, score: scoreSection(section, normalized) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = ranked.slice(0, maxSections).map((item) => item.section);
  const framework = knowledge.sections.find((section) => section.id === 'interview-framework');
  if (!selected.length) {
    selected.push(
      knowledge.sections.find((section) => section.id === 'statements-linkage'),
      knowledge.sections.find((section) => section.id === 'ratios-dupont')
    );
  }
  if (framework && !selected.some((section) => section.id === framework.id) && selected.length < maxSections) {
    selected.push(framework);
  }

  const chunks = [`[口径提醒]\n${knowledge.jurisdiction_note}`];
  for (const section of selected.filter(Boolean)) {
    const chunk = `[${section.title}]\n${section.content}`;
    if (chunks.join('\n\n').length + chunk.length > maxChars) break;
    chunks.push(chunk);
  }
  return {
    text: chunks.join('\n\n').slice(0, maxChars),
    sections: selected.filter(Boolean).map((section) => section.title),
    version: knowledge.version
  };
}

module.exports = { selectFinanceKnowledge };
