const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, safeStorage, screen, session, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { buildHintRequest, normalizeHintResponse } = require('./hint-prompt');
const {
  DEFAULT_ANSWER_SETTINGS,
  buildChatCompletionsBody,
  buildChatCompletionsUrl,
  extractChatCompletionsText,
  normalizeAnswerSettings
} = require('./answer-provider');
const { TurnGuard } = require('./turn-guard');
const { normalizeAudioSource, routeTranscript, speakerLabel } = require('./speaker-router');
const {
  bundledDomainRoot,
  discoverDomainModules,
  loadBundledDomainModule,
  moduleMetadata,
  normalizeCorrections
} = require('./domain-modules');
const {
  normalizeCaptureSelection,
  publicPlatformDefinitions,
  resolveCaptureTarget,
  sortedSelectableSources
} = require('./platform-capture');

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 248;
const COMPACT_HEIGHT = 96;
const LOCAL_ROOT = process.env.COACH_LOCAL_ROOT || 'E:\\TencentMeetingCoachLocal';
const OLLAMA_URL = process.env.COACH_OLLAMA_URL || 'http://127.0.0.1:11434';
const ASR_URL = process.env.COACH_ASR_URL || 'http://127.0.0.1:8765';
const OLLAMA_MODEL = process.env.COACH_LOCAL_LLM || 'qwen3.5:9b';
const SENSEVOICE_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const FUNASR_MODEL = process.env.COACH_FUNASR_MODEL || 'paraformer-zh-streaming';
const ANSWER_SETTINGS_FILE = 'answer-provider.json';
const LEGACY_USER_DATA_DIRS = [
  'universal-online-interview-assistant-windows',
  'Universal Online Interview Assistant',
  'tencent-meeting-finance-coach',
  'tencent-meeting-coach',
  'Tencent Meeting Online Interview Assistant'
];

let mainWindow = null;
let transcribers = new Map();
let transcriptHistory = [];
let hintAbortController = null;
let ollamaProcess = null;
let asrProcess = null;
let ollamaReadyPromise = null;
let asrReadyPromise = null;
let activeAsrUrl = ASR_URL;
let preparedCaptureTarget = null;
let activeDomainModule = null;
const turnGuard = new TurnGuard();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function positionWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const [width] = mainWindow.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  mainWindow.setPosition(x, display.workArea.y + 10, false);
}

function ensurePrepNotes() {
  const destination = path.join(app.getPath('userData'), 'prep-notes.md');
  migrateLegacyUserFile('prep-notes.md', destination);
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(path.join(app.getAppPath(), 'prep-notes.md'), destination);
  }
  return destination;
}

function migrateLegacyUserFile(fileName, destination) {
  const bundledPrep = fileName === 'prep-notes.md' ? path.join(app.getAppPath(), 'prep-notes.md') : '';
  const destinationExists = fs.existsSync(destination);
  const destinationIsTemplate = destinationExists && bundledPrep && fs.existsSync(bundledPrep)
    ? fs.readFileSync(destination).equals(fs.readFileSync(bundledPrep))
    : false;
  if (destinationExists && !destinationIsTemplate) return;
  const currentUserData = path.resolve(app.getPath('userData'));
  const candidates = LEGACY_USER_DATA_DIRS
    .map((directory) => path.join(app.getPath('appData'), directory, fileName))
    .filter((candidate) => path.resolve(path.dirname(candidate)) !== currentUserData && fs.existsSync(candidate))
    .map((candidate) => ({
      candidate,
      modified: fs.statSync(candidate).mtimeMs,
      customized: Boolean(bundledPrep) && !fs.readFileSync(candidate).equals(fs.readFileSync(bundledPrep))
    }))
    .sort((left, right) => Number(right.customized) - Number(left.customized) || right.modified - left.modified);
  if (!candidates.length) return;
  if (destinationExists && !candidates[0].customized) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(candidates[0].candidate, destination);
}

function answerSettingsPath() {
  const destination = path.join(app.getPath('userData'), ANSWER_SETTINGS_FILE);
  migrateLegacyUserFile(ANSWER_SETTINGS_FILE, destination);
  return destination;
}

function domainModulePaths() {
  const bundledRoot = bundledDomainRoot();
  const userRoot = path.join(app.getPath('userData'), 'domain-modules');
  return {
    bundledRoot,
    userRoot,
    guideSource: path.join(bundledRoot, 'README.md'),
    guide: path.join(userRoot, 'README.md'),
    templateSource: path.join(bundledRoot, '_template'),
    template: path.join(userRoot, '_template')
  };
}

function copyDomainWorkspaceFile(source, destination) {
  if (fs.existsSync(destination) || !fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function migrateLegacyDomainModules(destination) {
  const currentUserData = path.resolve(app.getPath('userData'));
  const hasCustomModule = fs.existsSync(destination) && fs.readdirSync(destination, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && entry.name !== '_template');
  if (hasCustomModule) return;
  const candidates = LEGACY_USER_DATA_DIRS
    .map((directory) => path.join(app.getPath('appData'), directory, 'domain-modules'))
    .filter((candidate) => path.resolve(path.dirname(candidate)) !== currentUserData && fs.existsSync(candidate))
    .map((candidate) => ({ candidate, modified: fs.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  if (!candidates.length) return;
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(candidates[0].candidate, destination, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

function ensureDomainModuleWorkspace() {
  const paths = domainModulePaths();
  migrateLegacyDomainModules(paths.userRoot);
  fs.mkdirSync(paths.userRoot, { recursive: true });
  copyDomainWorkspaceFile(paths.guideSource, paths.guide);
  for (const file of ['module.json', 'corrections.json', 'knowledge.json']) {
    copyDomainWorkspaceFile(path.join(paths.templateSource, file), path.join(paths.template, file));
  }
  migrateLegacyFinanceCorrections(paths);
  return paths;
}

function migrateLegacyFinanceCorrections(paths) {
  const legacy = path.join(LOCAL_ROOT, 'config', 'finance-asr-corrections.json');
  const destination = path.join(paths.userRoot, 'finance-accounting-local');
  if (!fs.existsSync(legacy) || fs.existsSync(destination)) return;
  try {
    const builtinDir = path.join(paths.bundledRoot, 'finance-accounting');
    const legacyRules = normalizeCorrections(JSON.parse(fs.readFileSync(legacy, 'utf8')));
    const builtinRules = normalizeCorrections(JSON.parse(fs.readFileSync(path.join(builtinDir, 'corrections.json'), 'utf8')));
    if (JSON.stringify(legacyRules) === JSON.stringify(builtinRules)) return;
    const builtinModule = loadBundledDomainModule('finance-accounting');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'module.json'), JSON.stringify({
      schema_version: 1,
      id: 'finance-accounting-local',
      name: '金融与会计（旧词表）',
      version: 'migrated-1',
      description: '从旧版本 E 盘自定义财会纠错表自动迁移。',
      corrections_file: 'corrections.json',
      knowledge_file: 'knowledge.json',
      answer_instructions: builtinModule.answerInstructions
    }, null, 2));
    fs.copyFileSync(legacy, path.join(destination, 'corrections.json'));
    fs.copyFileSync(path.join(builtinDir, 'knowledge.json'), path.join(destination, 'knowledge.json'));
  } catch {
    // Keep an invalid legacy file untouched; users can copy its rules into a new module manually.
  }
}

function domainModuleCatalog() {
  const paths = ensureDomainModuleWorkspace();
  const catalog = discoverDomainModules({ bundledRoot: paths.bundledRoot, userRoot: paths.userRoot });
  return { ...catalog, paths };
}

function publicDomainModuleCatalog() {
  const catalog = domainModuleCatalog();
  return {
    modules: catalog.modules.map(moduleMetadata),
    errors: catalog.errors,
    userDirectory: catalog.paths.userRoot
  };
}

function resolveDomainModule(id = 'finance-accounting') {
  const requested = String(id || 'finance-accounting');
  const catalog = domainModuleCatalog();
  const selected = catalog.modules.find((module) => module.id === requested);
  if (selected) return selected;
  if (requested === 'finance-accounting') return loadBundledDomainModule('finance-accounting');
  const error = catalog.errors.find((item) => item.folder === requested);
  throw new Error(error
    ? `领域模块“${requested}”无效：${error.error}`
    : `找不到领域模块“${requested}”，请在设置中重新选择。`);
}

function readAnswerRecord() {
  try {
    return JSON.parse(fs.readFileSync(answerSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function readAnswerSettings() {
  const record = readAnswerRecord();
  try {
    return { ...normalizeAnswerSettings(record), encryptedApiKey: String(record.encryptedApiKey || '') };
  } catch {
    return { ...DEFAULT_ANSWER_SETTINGS, encryptedApiKey: '' };
  }
}

function publicAnswerSettings(settings = readAnswerSettings()) {
  return {
    mode: settings.mode,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.encryptedApiKey)
  };
}

function decryptApiKey(settings = readAnswerSettings()) {
  if (!settings.encryptedApiKey) throw new Error('尚未保存 API Key，请在“设置 → 回答”中填写并保存。');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，无法读取 API Key。');
  try {
    return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64'));
  } catch {
    throw new Error('API Key 无法解密，请清除后重新保存。');
  }
}

function saveAnswerSettings(input = {}) {
  const current = readAnswerSettings();
  const normalized = normalizeAnswerSettings(input);
  let encryptedApiKey = input.clearApiKey === true ? '' : current.encryptedApiKey;
  const apiKey = String(input.apiKey || '').trim();
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，不能安全保存 API Key。');
    encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
  }
  if (normalized.mode === 'api' && !encryptedApiKey) throw new Error('选择 API 回答时必须先填写 API Key。');
  fs.writeFileSync(answerSettingsPath(), JSON.stringify({ ...normalized, encryptedApiKey }, null, 2), 'utf8');
  return publicAnswerSettings({ ...normalized, encryptedApiKey });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#00000000',
    title: '线上会议面试助手 · Windows',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.once('did-finish-load', async () => {
    positionWindow();
    mainWindow.show();
    if (process.env.COACH_SMOKE_LOCAL === '1') {
      send('coach:status', { state: 'connecting', label: '正在验证本地模型' });
      try {
        const financeModule = resolveDomainModule('finance-accounting');
        const [financeAsr] = await Promise.all([ensureAsr({}, financeModule), ensureOllama()]);
        if (process.env.COACH_SMOKE_DOMAIN_SWITCH === '1') {
          const generalModule = resolveDomainModule('general');
          const generalAsr = await ensureAsr({}, generalModule);
          if (financeAsr.correction_rules !== 19 || generalAsr.correction_rules !== 0) {
            throw new Error('领域模块没有正确切换 ASR 纠错规则。');
          }
          await ensureAsr({}, financeModule);
          send('coach:status', { state: 'ready', label: '领域模块切换验证通过 · 19 ↔ 0 条纠错' });
        } else {
          send('coach:status', { state: 'ready', label: '本地模型验证通过' });
        }
      } catch (error) {
        send('coach:error', error.message);
      }
    }
    if (process.env.COACH_SMOKE_HINT) {
      send('coach:hint', {
        transcript: '净利润增长但经营现金流下降，分析背后原因和风险。',
        hint: process.env.COACH_SMOKE_HINT,
        model: OLLAMA_MODEL,
        knowledgeSections: ['三大报表与勾稽关系', '经营现金流、自由现金流与营运资本']
      });
      if (process.env.COACH_SMOKE_HISTORY === '1') {
        send('coach:hint', {
          transcript: '请讲一下 DCF 估值的核心步骤。',
          hint: '结论：DCF 用未来自由现金流折现得到企业价值。\n逻辑：预测自由现金流、计算 WACC、估计终值、折现并调整净债务。\n注意：增长率和折现率需要做敏感性分析。',
          model: OLLAMA_MODEL,
          knowledgeSections: ['DCF 与 WACC']
        });
        await mainWindow.webContents.executeJavaScript("document.getElementById('historyPrevious').click()");
      }
    }
    if (process.env.COACH_SMOKE_SETTINGS === '1') {
      await mainWindow.webContents.executeJavaScript("document.getElementById('recognitionButton').click()");
    }
    if (process.env.COACH_SMOKE_ANSWER_SETTINGS === '1') {
      await mainWindow.webContents.executeJavaScript(`
        document.getElementById('recognitionButton').click();
        document.querySelector('[data-settings-tab="answer"]').click();
        document.querySelector('[data-answer-mode="api"]').click();
      `);
    }
    if (process.env.COACH_SMOKE_DOMAIN === '1') {
      await mainWindow.webContents.executeJavaScript(`
        document.getElementById('recognitionButton').click();
        document.querySelector('[data-settings-tab="domain"]').click();
      `);
    }
    if (process.env.COACH_SMOKE_PLATFORM) {
      const smokePlatform = ['auto', 'tencent', 'zoom', 'teams', 'feishu', 'dingtalk', 'webex', 'meet', 'custom']
        .includes(process.env.COACH_SMOKE_PLATFORM)
        ? process.env.COACH_SMOKE_PLATFORM
        : '';
      await mainWindow.webContents.executeJavaScript(`
        document.getElementById('platformButton').click();
        ${smokePlatform
          ? `document.querySelector('[data-platform="${smokePlatform}"]').click();`
          : ''}
      `);
    }
    if (process.env.COACH_SMOKE_CAPTURE === '1') {
      try {
        const capture = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const target = await window.coach.prepareCaptureTarget({ platform: 'auto' });
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            const result = {
              target: target.platformLabel,
              audioTracks: stream.getAudioTracks().length,
              videoTracks: stream.getVideoTracks().length
            };
            stream.getTracks().forEach((track) => track.stop());
            return result;
          })()
        `);
        if (!capture.audioTracks) throw new Error('系统回环没有返回音频轨道。');
        send('coach:status', { state: 'ready', label: `平台捕获验证通过 · ${capture.target}` });
      } catch (error) {
        send('coach:error', `平台捕获验证失败：${error.message}`);
      }
    }
    if (process.env.COACH_SMOKE_DUAL_AUDIO === '1') {
      send('coach:transcript', {
        speaker: 'remote',
        transcript: '请分析利润增长但经营现金流下降的原因。'
      });
      send('coach:transcript-delta', {
        speaker: 'remote',
        partial: '另外，请结合营运资本变化说明潜在风险…',
        final: false
      });
      send('coach:transcript', {
        speaker: 'local',
        transcript: '我会先拆解应收账款、存货和应付账款。'
      });
    }
    const screenshotPath = process.env.COACH_SMOKE_SCREENSHOT;
    if (screenshotPath) {
      setTimeout(async () => {
        try {
          fs.writeFileSync(screenshotPath, (await mainWindow.capturePage()).toPNG());
        } finally {
          stopLocalServices();
          app.exit(0);
        }
      }, 1200);
    }
  });
}

async function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await getCaptureSources();
      let target = preparedCaptureTarget;
      let source = target?.sourceId ? sources.find((item) => item.id === target.sourceId) : null;
      if (!source) {
        const automatic = resolveCaptureTarget(sources, { platform: 'auto' }, screen.getPrimaryDisplay().id);
        source = sources.find((item) => item.id === automatic.source?.id);
        target = publicCaptureTarget(automatic);
        preparedCaptureTarget = target;
      }
      if (!source) throw new Error('没有找到可用的系统音频源。');
      callback({ video: source, audio: 'loopback' });
    } catch (error) {
      send('coach:error', error.message);
      callback({});
    }
  });
}

async function getCaptureSources() {
  return desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
}

function publicCaptureTarget(resolution) {
  if (!resolution?.source) return null;
  return {
    sourceId: resolution.source.id,
    sourceName: resolution.source.name,
    sourceKind: resolution.source.kind,
    platform: resolution.platform,
    platformLabel: resolution.platformLabel,
    fallback: Boolean(resolution.fallback),
    reason: resolution.reason || ''
  };
}

function activeMeetingLabel() {
  return preparedCaptureTarget?.platformLabel || '会议音频';
}

async function captureCatalog(selection = {}) {
  const sources = await getCaptureSources();
  const normalized = normalizeCaptureSelection(selection);
  const resolution = resolveCaptureTarget(sources, normalized, screen.getPrimaryDisplay().id);
  return {
    platforms: publicPlatformDefinitions(),
    sources: sortedSelectableSources(sources),
    selection: normalized,
    suggestion: publicCaptureTarget(resolution),
    message: resolution.reason || ''
  };
}

async function prepareCaptureTarget(selection = {}) {
  const sources = await getCaptureSources();
  const resolution = resolveCaptureTarget(sources, selection, screen.getPrimaryDisplay().id);
  if (!resolution.source) throw new Error(resolution.reason || '没有找到可捕获的会议窗口。');
  preparedCaptureTarget = publicCaptureTarget(resolution);
  return preparedCaptureTarget;
}

function localPaths() {
  const modelDir = path.join(LOCAL_ROOT, 'models', 'sensevoice', SENSEVOICE_NAME);
  const python311 = path.join(LOCAL_ROOT, 'runtime', 'python311', 'python.exe');
  const scriptsPython = path.join(LOCAL_ROOT, 'runtime', 'python', 'Scripts', 'python.exe');
  const rootPython = path.join(LOCAL_ROOT, 'runtime', 'python', 'python.exe');
  const backendRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'local-backend')
    : path.join(app.getAppPath(), 'local-backend');
  return {
    python: fs.existsSync(python311) ? python311 : (fs.existsSync(scriptsPython) ? scriptsPython : rootPython),
    ollama: path.join(LOCAL_ROOT, 'ollama', 'ollama.exe'),
    ollamaModels: path.join(LOCAL_ROOT, 'models', 'ollama'),
    modelDir,
    funasrCache: path.join(LOCAL_ROOT, 'models', 'funasr'),
    torchCache: path.join(LOCAL_ROOT, 'models', 'torch'),
    vadModel: path.join(LOCAL_ROOT, 'models', 'vad', 'silero_vad.onnx'),
    asrScript: path.join(backendRoot, 'asr_server.py'),
    logs: path.join(LOCAL_ROOT, 'logs')
  };
}

function assertFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label}不存在：${file}`);
}

function findFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: options.signal || controller.signal });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!response.ok) {
      const reason = data.error?.message || data.error || data.message || `${response.status} ${response.statusText}`;
      throw new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForService(url, label, timeoutMs = 60000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchJson(url, {}, 2500);
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${label}启动超时：${lastError}`);
}

function spawnService(executable, args, name, env = {}) {
  const paths = localPaths();
  fs.mkdirSync(paths.logs, { recursive: true });
  const stdout = fs.openSync(path.join(paths.logs, `${name}.out.log`), 'a');
  const stderr = fs.openSync(path.join(paths.logs, `${name}.err.log`), 'a');
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
    env: { ...process.env, ...env }
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  child.on('error', (error) => send('coach:error', `${name} 启动失败：${error.message}`));
  return child;
}

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    });
  } else if (!child.killed) {
    child.kill('SIGTERM');
  }
}

function stopLocalServices() {
  stopProcessTree(asrProcess);
  stopProcessTree(ollamaProcess);
  asrProcess = null;
  ollamaProcess = null;
  asrReadyPromise = null;
  ollamaReadyPromise = null;
}

async function ensureOllama() {
  if (ollamaReadyPromise) return ollamaReadyPromise;
  ollamaReadyPromise = (async () => {
    const paths = localPaths();
    try {
      await fetchJson(`${OLLAMA_URL}/api/version`, {}, 1200);
    } catch {
      assertFile(paths.ollama, 'Ollama');
      ollamaProcess = spawnService(paths.ollama, ['serve'], 'ollama', {
        OLLAMA_HOST: '127.0.0.1:11434',
        OLLAMA_MODELS: paths.ollamaModels,
        OLLAMA_KEEP_ALIVE: '30m'
      });
      await waitForService(`${OLLAMA_URL}/api/version`, 'Ollama');
    }

    const tags = await fetchJson(`${OLLAMA_URL}/api/tags`, {}, 5000);
    const available = (tags.models || []).some((model) => model.name === OLLAMA_MODEL || model.model === OLLAMA_MODEL);
    if (!available) throw new Error(`本地模型 ${OLLAMA_MODEL} 尚未下载。请运行 E:\\TencentMeetingCoachLocal\\ollama\\ollama.exe pull ${OLLAMA_MODEL}`);

    send('coach:status', { state: 'connecting', label: '正在预热本地 Qwen' });
    await fetchJson(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: '只回复：就绪' }],
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { temperature: 0, num_predict: 8, num_ctx: 2048 }
      })
    }, 120000);
    return true;
  })().catch((error) => {
    stopProcessTree(ollamaProcess);
    ollamaProcess = null;
    ollamaReadyPromise = null;
    throw error;
  });
  return ollamaReadyPromise;
}

function normalizeAsrSettings(options = {}) {
  return {
    precision: options.asrPrecision === 'fp32' ? 'fp32' : 'int8',
    language: options.asrLanguage === 'auto' ? 'auto' : 'zh',
    corrections: options.asrCorrections !== false
  };
}

async function ensureAsr(options = {}, domainModule = loadBundledDomainModule('finance-accounting')) {
  const settings = normalizeAsrSettings(options);
  if (!asrReadyPromise) {
    asrReadyPromise = (async () => {
      const paths = localPaths();
      let existingService = null;
      try {
        existingService = await fetchJson(`${activeAsrUrl}/health`, {}, 1200);
      } catch {}
      if (
        existingService?.vad === true &&
        Number.isFinite(existingService.correction_rules) &&
        Object.prototype.hasOwnProperty.call(existingService, 'streaming') &&
        Object.prototype.hasOwnProperty.call(existingService, 'domain_module')
      ) {
        return existingService;
      }
      if (existingService && process.env.COACH_ASR_URL) {
        throw new Error(`COACH_ASR_URL 指向旧版识别服务，请先关闭它：${activeAsrUrl}`);
      }
      if (existingService) {
        const freePort = await findFreeLocalPort();
        activeAsrUrl = `http://127.0.0.1:${freePort}`;
        send('coach:status', { state: 'connecting', label: '检测到旧版识别服务 · 正在无缝升级' });
      }
      try {
        assertFile(paths.python, '本地 Python');
        assertFile(paths.asrScript, 'SenseVoice 服务脚本');
        assertFile(paths.vadModel, 'Silero VAD 模型');
        assertFile(path.join(paths.modelDir, 'model.int8.onnx'), 'SenseVoice INT8 模型');
        assertFile(path.join(paths.modelDir, 'model.onnx'), 'SenseVoice FP32 模型');
        assertFile(path.join(paths.modelDir, 'tokens.txt'), 'SenseVoice 词表');
        send('coach:status', { state: 'connecting', label: '正在加载 SenseVoice 与流式 FunASR' });
        const port = new URL(activeAsrUrl).port || '8765';
        asrProcess = spawnService(paths.python, [
          paths.asrScript,
          '--model-dir', paths.modelDir,
          '--vad-model', paths.vadModel,
          '--stream-model', FUNASR_MODEL,
          '--stream-device', process.env.COACH_FUNASR_DEVICE || 'cpu',
          '--port', port
        ], 'asr', {
          MODELSCOPE_CACHE: paths.funasrCache,
          MODELSCOPE_DOWNLOAD_PARALLEL_WORKERS: '8',
          MODELSCOPE_DOWNLOAD_MAX_RETRIES: '10',
          MODELSCOPE_DOWNLOAD_TIMEOUT: '120',
          TORCH_HOME: paths.torchCache,
          HF_HOME: path.join(paths.funasrCache, 'huggingface')
        });
        return waitForService(`${activeAsrUrl}/health`, '本地语音识别', 10 * 60 * 1000);
      } catch (error) {
        throw error;
      }
    })().catch((error) => {
      stopProcessTree(asrProcess);
      asrProcess = null;
      asrReadyPromise = null;
      throw error;
    });
  }
  await asrReadyPromise;
  send('coach:status', { state: 'connecting', label: settings.precision === 'fp32' ? '正在切换高精度识别' : '正在配置中文识别' });
  return fetchJson(`${activeAsrUrl}/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...settings,
      correction_rules: domainModule.corrections,
      domain_module: domainModule.id
    })
  }, 60000);
}

function readPrepNotes() {
  try {
    return fs.readFileSync(ensurePrepNotes(), 'utf8').slice(0, 8000);
  } catch {
    return '未提供个人准备信息。';
  }
}

async function generateHint(transcript) {
  const decision = turnGuard.evaluate(transcript);
  if (!decision.allow) {
    send('coach:idle', { transcript, reason: decision.reason });
    return;
  }
  transcriptHistory.push(`对方：${transcript}`);
  transcriptHistory = transcriptHistory.slice(-12);
  if (hintAbortController) hintAbortController.abort();
  hintAbortController = new AbortController();
  send('coach:hint-start', { transcript });

  const answerSettings = readAnswerSettings();
  const model = answerSettings.mode === 'api' ? answerSettings.model : OLLAMA_MODEL;
  const { request: body, knowledgeSections, domainModule } = buildHintRequest({
    transcript,
    context: transcriptHistory.slice(-5).join('\n'),
    prepNotes: readPrepNotes(),
    model,
    domainModule: activeDomainModule || loadBundledDomainModule('finance-accounting')
  });

  let rawHint = '';
  if (answerSettings.mode === 'api') {
    const apiKey = decryptApiKey(answerSettings);
    const data = await fetchJson(buildChatCompletionsUrl(answerSettings.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(buildChatCompletionsBody(body, answerSettings)),
      signal: hintAbortController.signal
    }, 120000);
    rawHint = extractChatCompletionsText(data);
    if (!rawHint) throw new Error('API 返回成功，但没有找到回答文本。请检查模型是否兼容 Chat Completions。');
  } else {
    const data = await fetchJson(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: hintAbortController.signal
    }, 120000);
    rawHint = data.message?.content;
  }
  const hint = normalizeHintResponse(rawHint, transcript);
  if (!hint || hint === 'NO_HINT') send('coach:idle', { transcript });
  else {
    turnGuard.recordAnswer(transcript, hint);
    send('coach:hint', { transcript, hint, model, provider: answerSettings.mode, knowledgeSections, domainModule });
  }
}

class LocalTranscriber {
  constructor(source, sampleRate = 16000, asrLabel = '中文 INT8 · VAD', answerLabel = '本地 Qwen', streaming = false) {
    this.source = normalizeAudioSource(source);
    this.sampleRate = Number(sampleRate) || 16000;
    this.asrLabel = asrLabel;
    this.answerLabel = answerLabel;
    this.chunks = [];
    this.bytes = 0;
    this.queue = Promise.resolve();
    this.streamQueue = Promise.resolve();
    this.streaming = Boolean(streaming);
    this.streamSequence = 0;
    this.streamSession = this.nextStreamSession();
    this.streamPartial = '';
    this.streamWarningSent = false;
    this.closed = false;
  }

  nextStreamSession() {
    this.streamSequence += 1;
    return `${this.source}:${Date.now()}:${this.streamSequence}`;
  }

  append(base64Audio) {
    if (this.closed || !base64Audio) return;
    const chunk = Buffer.from(base64Audio, 'base64');
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.streaming) {
      const sessionId = this.streamSession;
      this.streamQueue = this.streamQueue
        .then(() => this.postStream(chunk, false, sessionId))
        .catch((error) => this.disableStreaming(error));
    }
  }

  commit() {
    if (this.closed || this.bytes < this.sampleRate * 2 * 0.1) {
      this.chunks = [];
      this.bytes = 0;
      return;
    }
    const audio = Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    const sessionId = this.streamSession;
    this.streamSession = this.nextStreamSession();
    const streamFlush = this.streaming
      ? this.streamQueue
        .then(() => this.postStream(Buffer.alloc(0), true, sessionId))
        .catch((error) => this.disableStreaming(error))
      : Promise.resolve();
    this.streamQueue = streamFlush;
    this.queue = this.queue
      .then(() => streamFlush)
      .then(() => this.transcribe(audio))
      .catch((error) => send('coach:error', error.message));
  }

  async postStream(audio, final, sessionId) {
    if (this.closed || !this.streaming) return;
    const result = await fetchJson(`${activeAsrUrl}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Sample-Rate': String(this.sampleRate),
        'X-Stream-Id': sessionId,
        'X-Stream-Final': final ? '1' : '0'
      },
      body: audio
    }, 30000);
    if (result.available === false) {
      this.disableStreaming(new Error(result.error || 'FunASR streaming is unavailable'));
      return;
    }
    const partial = final ? '' : String(result.text || '').trim();
    if (partial !== this.streamPartial || final) {
      this.streamPartial = partial;
      send('coach:transcript-delta', {
        speaker: this.source,
        partial,
        final: Boolean(final),
        inferenceMs: result.inference_ms
      });
    }
  }

  disableStreaming(error) {
    this.streaming = false;
    this.streamPartial = '';
    if (!this.streamWarningSent) {
      this.streamWarningSent = true;
      send('coach:transcript-delta', { speaker: this.source, partial: '', final: true });
      send('coach:status', {
        state: 'ready',
        label: `流式字幕不可用 · 已回退完整句识别（${error.message}）`
      });
    }
  }

  async transcribe(audio) {
    if (this.closed) return;
    if (this.source === 'remote') {
      send('coach:status', { state: 'listening', label: `正在识别${speakerLabel(this.source)}的语音 · ${activeMeetingLabel()}` });
    }
    const result = await fetchJson(`${activeAsrUrl}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Sample-Rate': String(this.sampleRate)
      },
      body: audio
    }, 60000);
    const transcript = String(result.text || '').trim();
    if (!transcript || this.closed) {
      if (this.source === 'remote') {
        send('coach:status', { state: 'ready', label: `监听 ${activeMeetingLabel()} · ${this.asrLabel} · ${this.answerLabel}` });
      }
      return;
    }
    const routed = routeTranscript(this.source, transcript);
    send('coach:transcript', {
      transcript: routed.text,
      speaker: routed.speaker,
      label: routed.label,
      local: true,
      inferenceMs: result.inference_ms
    });
    if (routed.shouldAnswer) {
      await generateHint(routed.text);
    } else {
      transcriptHistory.push(`我：${routed.text}`);
      transcriptHistory = transcriptHistory.slice(-12);
    }
  }

  close() {
    this.closed = true;
    this.chunks = [];
    this.bytes = 0;
    this.streaming = false;
  }
}

function closeTranscribers() {
  for (const transcriber of transcribers.values()) transcriber.close();
  transcribers = new Map();
}

app.whenReady().then(async () => {
  await configureDisplayCapture();
  createWindow();
  ensurePrepNotes();
  ensureDomainModuleWorkspace();
  globalShortcut.register('Control+Alt+M', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      positionWindow();
      mainWindow.show();
    }
  });
  screen.on('display-metrics-changed', positionWindow);
});

ipcMain.handle('coach:start', async (_event, options = {}) => {
  closeTranscribers();
  turnGuard.reset();
  activeDomainModule = resolveDomainModule(options.domainModuleId);
  const answerSettings = readAnswerSettings();
  const answerLabel = answerSettings.mode === 'api' ? `API ${answerSettings.model}` : '本地 Qwen';
  send('coach:status', {
    state: 'connecting',
    label: answerSettings.mode === 'api' ? '正在启动本地识别' : '正在启动本地识别与回答模型'
  });
  if (answerSettings.mode === 'api') decryptApiKey(answerSettings);
  const [asr] = await Promise.all([
    ensureAsr(options, activeDomainModule),
    answerSettings.mode === 'local' ? ensureOllama() : Promise.resolve(true)
  ]);
  const streaming = options.asrStreaming !== false && asr.streaming === true;
  const asrLabel = `${activeDomainModule.name} · ${asr.language === 'zh' ? '中文' : '自动'} ${asr.precision.toUpperCase()} · ${streaming ? 'FunASR 流式 + SenseVoice 定稿' : 'SenseVoice 整句'}`;
  transcribers.set('remote', new LocalTranscriber('remote', options.sampleRate, asrLabel, answerLabel, streaming));
  if (options.micEnabled !== false) {
    transcribers.set('local', new LocalTranscriber('local', options.sampleRate, asrLabel, answerLabel, streaming));
  }
  send('coach:status', { state: 'ready', label: `监听 ${activeMeetingLabel()} · ${asrLabel} · ${answerLabel}` });
  return {
    asr: asr.engine,
    model: answerSettings.mode === 'api' ? answerSettings.model : OLLAMA_MODEL,
    provider: answerSettings.mode,
    local: answerSettings.mode === 'local',
    streaming,
    streamingError: asr.streaming_error || '',
    micEnabled: transcribers.has('local'),
    captureTarget: preparedCaptureTarget,
    domainModule: moduleMetadata(activeDomainModule),
    settings: asr
  };
});

ipcMain.handle('coach:list-capture-sources', (_event, selection = {}) => captureCatalog(selection));

ipcMain.handle('coach:prepare-capture-target', (_event, selection = {}) => prepareCaptureTarget(selection));

ipcMain.handle('coach:list-domain-modules', () => publicDomainModuleCatalog());

ipcMain.handle('coach:open-domain-module-folder', async () => {
  const paths = ensureDomainModuleWorkspace();
  const error = await shell.openPath(paths.userRoot);
  if (error) throw new Error(error);
  return paths.userRoot;
});

ipcMain.handle('coach:open-domain-module-guide', async () => {
  const paths = ensureDomainModuleWorkspace();
  const error = await shell.openPath(paths.guide);
  if (error) throw new Error(error);
  return paths.guide;
});

ipcMain.handle('coach:get-answer-settings', () => publicAnswerSettings());

ipcMain.handle('coach:save-answer-settings', (_event, settings) => saveAnswerSettings(settings));

ipcMain.on('coach:audio', (_event, source, base64Audio) => {
  transcribers.get(normalizeAudioSource(source))?.append(base64Audio);
});
ipcMain.on('coach:commit', (_event, source) => {
  transcribers.get(normalizeAudioSource(source))?.commit();
});

ipcMain.handle('coach:stop', () => {
  closeTranscribers();
  return true;
});

ipcMain.handle('coach:open-prep', async () => {
  const file = ensurePrepNotes();
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
  return file;
});

ipcMain.handle('coach:set-compact', (_event, compact) => {
  if (!mainWindow) return false;
  mainWindow.setSize(WINDOW_WIDTH, compact ? COMPACT_HEIGHT : WINDOW_HEIGHT, true);
  positionWindow();
  return true;
});

ipcMain.on('coach:close', () => mainWindow?.close());

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  closeTranscribers();
  hintAbortController?.abort();
  stopLocalServices();
});

app.on('window-all-closed', () => app.quit());
