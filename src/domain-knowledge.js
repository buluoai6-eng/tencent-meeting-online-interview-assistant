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

function selectDomainKnowledge(question, domainModule, { maxSections = 3, maxChars = 4200 } = {}) {
  const knowledge = domainModule?.knowledge || { sections: [] };
  const normalized = normalize(question);
  const ranked = (knowledge.sections || [])
    .map((section, index) => ({ section, index, score: scoreSection(section, normalized) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = ranked.slice(0, maxSections).map((item) => item.section);
  if (!selected.length) {
    for (const id of knowledge.fallbackSectionIds || []) {
      const section = knowledge.sections.find((item) => item.id === id);
      if (section && selected.length < maxSections) selected.push(section);
    }
  }
  for (const id of knowledge.alwaysIncludeSectionIds || []) {
    const section = knowledge.sections.find((item) => item.id === id);
    if (section && !selected.some((item) => item.id === id) && selected.length < maxSections) selected.push(section);
  }

  const chunks = [];
  if (knowledge.contextNote) chunks.push(`[领域说明]\n${knowledge.contextNote}`);
  for (const section of selected.filter(Boolean)) {
    const chunk = `[${section.title}]\n${section.content}`;
    if (chunks.join('\n\n').length + chunk.length > maxChars) break;
    chunks.push(chunk);
  }
  return {
    text: chunks.length ? chunks.join('\n\n').slice(0, maxChars) : '当前模块没有召回领域知识。',
    sections: selected.filter(Boolean).map((section) => section.title),
    version: knowledge.version || domainModule?.version || '',
    moduleId: domainModule?.id || 'general',
    moduleName: domainModule?.name || '通用'
  };
}

module.exports = { selectDomainKnowledge };
