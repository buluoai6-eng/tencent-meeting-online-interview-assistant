const fs = require('fs');
const path = require('path');

const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_JSON_BYTES = 512 * 1024;

function requiredText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function optionalText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function readJson(file, label) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${label}不是文件`);
  if (stat.size > MAX_JSON_BYTES) throw new Error(`${label}超过 512 KB`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function resolveModuleFile(moduleDir, relativeFile, label) {
  if (!relativeFile) return '';
  const relative = requiredText(relativeFile, label, 160);
  if (path.extname(relative).toLowerCase() !== '.json') throw new Error(`${label}必须指向 JSON 文件`);
  const resolved = path.resolve(moduleDir, relative);
  const owned = path.relative(path.resolve(moduleDir), resolved);
  if (!owned || owned.startsWith('..') || path.isAbsolute(owned)) throw new Error(`${label}不能指向模块目录之外`);
  if (!fs.existsSync(resolved)) throw new Error(`${label}不存在：${relative}`);
  return resolved;
}

function normalizeCorrections(value = {}) {
  const replacements = Array.isArray(value) ? value : value.replacements;
  if (replacements === undefined) return [];
  if (!Array.isArray(replacements)) throw new Error('corrections.json 的 replacements 必须是数组');
  if (replacements.length > 500) throw new Error('术语纠错规则不能超过 500 条');
  return replacements.map((item, index) => {
    const canonical = requiredText(item?.canonical, `第 ${index + 1} 条 canonical`, 80);
    if (!Array.isArray(item?.aliases) || !item.aliases.length) {
      throw new Error(`第 ${index + 1} 条 aliases 必须是非空数组`);
    }
    if (item.aliases.length > 20) throw new Error(`第 ${index + 1} 条 aliases 不能超过 20 个`);
    const aliases = [...new Set(item.aliases.map((alias) => requiredText(alias, `第 ${index + 1} 条 alias`, 80)))]
      .filter((alias) => alias !== canonical);
    if (!aliases.length) throw new Error(`第 ${index + 1} 条没有可用的 alias`);
    return { canonical, aliases };
  });
}

function normalizeIdList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label}必须是最多 20 项的数组`);
  return [...new Set(value.map((item) => requiredText(item, label, 64)))];
}

function normalizeKnowledge(value = {}) {
  const sections = value.sections === undefined ? [] : value.sections;
  if (!Array.isArray(sections)) throw new Error('knowledge.json 的 sections 必须是数组');
  if (sections.length > 100) throw new Error('知识条目不能超过 100 条');
  const normalizedSections = sections.map((section, index) => {
    const id = requiredText(section?.id, `第 ${index + 1} 个知识条目 id`, 64);
    if (!MODULE_ID_PATTERN.test(id)) throw new Error(`知识条目 id 格式无效：${id}`);
    const title = requiredText(section?.title, `第 ${index + 1} 个知识条目标题`, 100);
    if (!Array.isArray(section?.keywords) || !section.keywords.length || section.keywords.length > 50) {
      throw new Error(`知识条目“${title}”的 keywords 必须包含 1–50 项`);
    }
    const keywords = [...new Set(section.keywords.map((keyword) => requiredText(keyword, `知识条目“${title}”关键词`, 80)))];
    const content = requiredText(section?.content, `知识条目“${title}”内容`, 8000);
    return { id, title, keywords, content };
  });
  const ids = new Set(normalizedSections.map((section) => section.id));
  if (ids.size !== normalizedSections.length) throw new Error('knowledge.json 中存在重复的知识条目 id');
  const fallbackSectionIds = normalizeIdList(value.fallback_section_ids, 'fallback_section_ids');
  const alwaysIncludeSectionIds = normalizeIdList(value.always_include_section_ids, 'always_include_section_ids');
  for (const id of [...fallbackSectionIds, ...alwaysIncludeSectionIds]) {
    if (!ids.has(id)) throw new Error(`知识条目引用不存在：${id}`);
  }
  return {
    version: optionalText(value.version, 'knowledge version', 40),
    contextNote: optionalText(value.context_note || value.jurisdiction_note, 'context_note', 3000),
    fallbackSectionIds,
    alwaysIncludeSectionIds,
    sections: normalizedSections,
    sources: Array.isArray(value.sources)
      ? value.sources.slice(0, 50).map((source) => optionalText(source, 'knowledge source', 500)).filter(Boolean)
      : []
  };
}

function loadDomainModule(moduleDir, source = 'user') {
  const manifestPath = path.join(moduleDir, 'module.json');
  if (!fs.existsSync(manifestPath)) throw new Error('缺少 module.json');
  const manifest = readJson(manifestPath, 'module.json');
  if (manifest.schema_version !== 1) throw new Error('仅支持 schema_version: 1');
  const id = requiredText(manifest.id, '模块 id', 64);
  if (!MODULE_ID_PATTERN.test(id)) throw new Error(`模块 id 格式无效：${id}`);
  const name = requiredText(manifest.name, '模块名称', 80);
  const version = requiredText(manifest.version, '模块版本', 40);
  const description = optionalText(manifest.description, '模块描述', 300);
  const instructions = manifest.answer_instructions === undefined ? [] : manifest.answer_instructions;
  if (!Array.isArray(instructions) || instructions.length > 12) {
    throw new Error('answer_instructions 必须是最多 12 项的数组');
  }
  const answerInstructions = instructions
    .map((item) => optionalText(item, 'answer_instructions', 500))
    .filter(Boolean);
  const correctionsPath = resolveModuleFile(moduleDir, manifest.corrections_file, 'corrections_file');
  const knowledgePath = resolveModuleFile(moduleDir, manifest.knowledge_file, 'knowledge_file');
  const corrections = correctionsPath ? normalizeCorrections(readJson(correctionsPath, 'corrections.json')) : [];
  const knowledge = knowledgePath ? normalizeKnowledge(readJson(knowledgePath, 'knowledge.json')) : normalizeKnowledge();
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description,
    source,
    moduleDir,
    answerInstructions,
    corrections,
    knowledge,
    stats: {
      correctionRules: corrections.length,
      aliases: corrections.reduce((total, rule) => total + rule.aliases.length, 0),
      knowledgeSections: knowledge.sections.length
    }
  };
}

function moduleMetadata(module) {
  return {
    id: module.id,
    name: module.name,
    version: module.version,
    description: module.description,
    source: module.source,
    stats: module.stats
  };
}

function moduleDirectories(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => path.join(root, entry.name));
}

function discoverDomainModules({ bundledRoot, userRoot } = {}) {
  const modules = [];
  const errors = [];
  const seen = new Map();
  for (const [root, source] of [[bundledRoot, 'builtin'], [userRoot, 'user']]) {
    for (const moduleDir of moduleDirectories(root)) {
      try {
        const module = loadDomainModule(moduleDir, source);
        if (seen.has(module.id)) {
          throw new Error(`模块 id“${module.id}”已由 ${seen.get(module.id)} 使用`);
        }
        seen.set(module.id, source === 'builtin' ? '内置模块' : '用户模块');
        modules.push(module);
      } catch (error) {
        errors.push({ folder: path.basename(moduleDir), source, error: error.message });
      }
    }
  }
  modules.sort((left, right) => {
    if (left.id === 'general') return -1;
    if (right.id === 'general') return 1;
    if (left.source !== right.source) return left.source === 'builtin' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN');
  });
  return { modules, errors };
}

function bundledDomainRoot() {
  return path.join(__dirname, 'domain-modules');
}

function loadBundledDomainModule(id = 'finance-accounting') {
  return loadDomainModule(path.join(bundledDomainRoot(), id), 'builtin');
}

module.exports = {
  bundledDomainRoot,
  discoverDomainModules,
  loadBundledDomainModule,
  loadDomainModule,
  moduleMetadata,
  normalizeCorrections,
  normalizeKnowledge
};
