const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectDomainKnowledge } = require('../src/domain-knowledge');
const { buildHintRequest } = require('../src/hint-prompt');
const {
  discoverDomainModules,
  loadBundledDomainModule,
  loadDomainModule
} = require('../src/domain-modules');

const finance = loadBundledDomainModule('finance-accounting');
const general = loadBundledDomainModule('general');
assert.deepStrictEqual(finance.stats, { correctionRules: 19, aliases: 52, knowledgeSections: 14 });
assert.deepStrictEqual(general.stats, { correctionRules: 0, aliases: 0, knowledgeSections: 0 });

const selected = selectDomainKnowledge('请解释 DCF 的步骤以及 WACC 的计算。', finance);
assert(selected.sections.includes('DCF、相对估值与企业价值'));
assert(selected.sections.includes('WACC、CAPM、资本结构与投资决策'));
assert(selected.sections.includes('金融会计面试回答框架'));

const generalRequest = buildHintRequest({
  transcript: '请介绍一次团队协作经历。',
  domainModule: general
});
assert.match(generalRequest.request.messages[0].content, /当前领域模块：通用/);
assert.match(generalRequest.request.messages[1].content, /当前模块没有召回领域知识/);

const discovered = discoverDomainModules({
  bundledRoot: path.join(__dirname, '..', 'src', 'domain-modules'),
  userRoot: ''
});
assert.deepStrictEqual(discovered.modules.map((module) => module.id), ['general', 'finance-accounting']);
assert.deepStrictEqual(discovered.errors, []);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-module-test-'));
try {
  const userRoot = path.join(temporaryRoot, 'user');
  const validDir = path.join(userRoot, 'legal-interview');
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(path.join(validDir, 'module.json'), JSON.stringify({
    schema_version: 1,
    id: 'legal-interview',
    name: '法律面试',
    version: '1.0',
    description: '测试用户模块',
    corrections_file: 'corrections.json',
    knowledge_file: 'knowledge.json'
  }));
  fs.writeFileSync(path.join(validDir, 'corrections.json'), JSON.stringify({
    replacements: [{ canonical: '尽职调查', aliases: ['进职调查'] }]
  }));
  fs.writeFileSync(path.join(validDir, 'knowledge.json'), JSON.stringify({
    sections: [{ id: 'due-diligence', title: '尽职调查', keywords: ['尽调'], content: '先明确范围和风险。' }]
  }));
  const withUserModule = discoverDomainModules({
    bundledRoot: path.join(__dirname, '..', 'src', 'domain-modules'),
    userRoot
  });
  const userModule = withUserModule.modules.find((module) => module.id === 'legal-interview');
  assert(userModule);
  assert.strictEqual(userModule.source, 'user');
  assert.deepStrictEqual(userModule.stats, { correctionRules: 1, aliases: 1, knowledgeSections: 1 });

  const moduleDir = path.join(temporaryRoot, 'unsafe');
  fs.mkdirSync(moduleDir);
  fs.writeFileSync(path.join(temporaryRoot, 'outside.json'), JSON.stringify({ sections: [] }));
  fs.writeFileSync(path.join(moduleDir, 'module.json'), JSON.stringify({
    schema_version: 1,
    id: 'unsafe-module',
    name: '不安全模块',
    version: '1.0',
    knowledge_file: '../outside.json'
  }));
  assert.throws(() => loadDomainModule(moduleDir), /不能指向模块目录之外/);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Domain module validation, discovery, retrieval, and isolation checks passed.');
