const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { buildHintRequest, normalizeHintResponse } = require('./hint-prompt');
const { likelyQuestion } = require('./question-detector');

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 248;
const COMPACT_HEIGHT = 96;
const LOCAL_ROOT = process.env.COACH_LOCAL_ROOT || 'E:\\TencentMeetingCoachLocal';
const OLLAMA_URL = process.env.COACH_OLLAMA_URL || 'http://127.0.0.1:11434';
const ASR_URL = process.env.COACH_ASR_URL || 'http://127.0.0.1:8765';
const OLLAMA_MODEL = process.env.COACH_LOCAL_LLM || 'qwen3.5:9b';
const SENSEVOICE_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

let mainWindow = null;
let transcriber = null;
let transcriptHistory = [];
let hintAbortController = null;
let ollamaProcess = null;
let asrProcess = null;
let ollamaReadyPromise = null;
let asrReadyPromise = null;
let activeAsrUrl = ASR_URL;

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
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(path.join(app.getAppPath(), 'prep-notes.md'), destination);
  }
  return destination;
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
    title: 'Tencent Meeting Coach Local',
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
        await Promise.all([ensureAsr(), ensureOllama()]);
        send('coach:status', { state: 'ready', label: '本地模型验证通过' });
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
    }
    if (process.env.COACH_SMOKE_SETTINGS === '1') {
      await mainWindow.webContents.executeJavaScript("document.getElementById('recognitionButton').click()");
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
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primaryId) || sources[0];
      if (!source) throw new Error('没有找到可用的系统音频源。');
      callback({ video: source, audio: 'loopback' });
    } catch (error) {
      send('coach:error', error.message);
      callback({});
    }
  });
}

function localPaths() {
  const modelDir = path.join(LOCAL_ROOT, 'models', 'sensevoice', SENSEVOICE_NAME);
  const scriptsPython = path.join(LOCAL_ROOT, 'runtime', 'python', 'Scripts', 'python.exe');
  const rootPython = path.join(LOCAL_ROOT, 'runtime', 'python', 'python.exe');
  const backendRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'local-backend')
    : path.join(app.getAppPath(), 'local-backend');
  return {
    python: fs.existsSync(scriptsPython) ? scriptsPython : rootPython,
    ollama: path.join(LOCAL_ROOT, 'ollama', 'ollama.exe'),
    ollamaModels: path.join(LOCAL_ROOT, 'models', 'ollama'),
    modelDir,
    vadModel: path.join(LOCAL_ROOT, 'models', 'vad', 'silero_vad.onnx'),
    asrScript: path.join(backendRoot, 'asr_server.py'),
    bundledCorrections: path.join(backendRoot, 'finance-asr-corrections.json'),
    corrections: path.join(LOCAL_ROOT, 'config', 'finance-asr-corrections.json'),
    logs: path.join(LOCAL_ROOT, 'logs')
  };
}

function ensureCorrections() {
  const paths = localPaths();
  assertFile(paths.bundledCorrections, '财会术语纠错表');
  fs.mkdirSync(path.dirname(paths.corrections), { recursive: true });
  if (!fs.existsSync(paths.corrections)) fs.copyFileSync(paths.bundledCorrections, paths.corrections);
  return paths.corrections;
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
    if (!response.ok) throw new Error(data.error || data.message || `${response.status} ${response.statusText}`);
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

async function ensureAsr(options = {}) {
  const settings = normalizeAsrSettings(options);
  if (!asrReadyPromise) {
    asrReadyPromise = (async () => {
      const paths = localPaths();
      let existingService = null;
      try {
        existingService = await fetchJson(`${activeAsrUrl}/health`, {}, 1200);
      } catch {}
      if (existingService?.vad === true && Number.isFinite(existingService.correction_rules)) {
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
        const corrections = ensureCorrections();
        send('coach:status', { state: 'connecting', label: '正在加载中文识别与 Silero VAD' });
        const port = new URL(activeAsrUrl).port || '8765';
        asrProcess = spawnService(paths.python, [
          paths.asrScript,
          '--model-dir', paths.modelDir,
          '--vad-model', paths.vadModel,
          '--corrections', corrections,
          '--port', port
        ], 'sensevoice');
        return waitForService(`${activeAsrUrl}/health`, 'SenseVoice');
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
    body: JSON.stringify(settings)
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
  if (!likelyQuestion(transcript)) {
    send('coach:idle', { transcript });
    return;
  }
  if (hintAbortController) hintAbortController.abort();
  hintAbortController = new AbortController();
  send('coach:hint-start', { transcript });

  const { request: body, knowledgeSections } = buildHintRequest({
    transcript,
    context: transcriptHistory.slice(-5).join('\n'),
    prepNotes: readPrepNotes(),
    model: OLLAMA_MODEL
  });

  const data = await fetchJson(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: hintAbortController.signal
  }, 120000);
  const hint = normalizeHintResponse(data.message?.content, transcript);
  if (!hint || hint === 'NO_HINT') send('coach:idle', { transcript });
  else send('coach:hint', { transcript, hint, model: OLLAMA_MODEL, knowledgeSections });
}

class LocalTranscriber {
  constructor(sampleRate = 16000, asrLabel = '中文 INT8 · VAD') {
    this.sampleRate = Number(sampleRate) || 16000;
    this.asrLabel = asrLabel;
    this.chunks = [];
    this.bytes = 0;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  append(base64Audio) {
    if (this.closed || !base64Audio) return;
    const chunk = Buffer.from(base64Audio, 'base64');
    this.chunks.push(chunk);
    this.bytes += chunk.length;
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
    this.queue = this.queue.then(() => this.transcribe(audio)).catch((error) => send('coach:error', error.message));
  }

  async transcribe(audio) {
    if (this.closed) return;
    send('coach:status', { state: 'listening', label: '正在本地识别' });
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
      send('coach:status', { state: 'ready', label: `监听中 · ${this.asrLabel}` });
      return;
    }
    transcriptHistory.push(transcript);
    transcriptHistory = transcriptHistory.slice(-12);
    send('coach:transcript', { transcript, local: true, inferenceMs: result.inference_ms });
    await generateHint(transcript);
  }

  close() {
    this.closed = true;
    this.chunks = [];
    this.bytes = 0;
  }
}

app.whenReady().then(async () => {
  await configureDisplayCapture();
  createWindow();
  ensurePrepNotes();
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
  transcriber?.close();
  send('coach:status', { state: 'connecting', label: '正在启动本地模型' });
  const [asr] = await Promise.all([ensureAsr(options), ensureOllama()]);
  const asrLabel = `${asr.language === 'zh' ? '中文' : '自动'} ${asr.precision.toUpperCase()} · VAD`;
  transcriber = new LocalTranscriber(options.sampleRate, asrLabel);
  send('coach:status', { state: 'ready', label: `监听中 · ${asrLabel}` });
  return { asr: asr.engine, model: OLLAMA_MODEL, local: true, settings: asr };
});

ipcMain.on('coach:audio', (_event, base64Audio) => transcriber?.append(base64Audio));
ipcMain.on('coach:commit', () => transcriber?.commit());

ipcMain.handle('coach:stop', () => {
  transcriber?.close();
  transcriber = null;
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
  transcriber?.close();
  hintAbortController?.abort();
  stopLocalServices();
});

app.on('window-all-closed', () => app.quit());
