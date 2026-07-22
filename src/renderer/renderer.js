const shell = document.getElementById('coachShell');
const statusLabel = document.getElementById('statusLabel');
const listenButton = document.getElementById('listenButton');
const recognitionButton = document.getElementById('recognitionButton');
const recognitionPanel = document.getElementById('recognitionPanel');
const correctionsToggle = document.getElementById('correctionsToggle');
const recognitionSettingsPage = document.getElementById('recognitionSettingsPage');
const answerSettingsPage = document.getElementById('answerSettingsPage');
const apiFields = document.getElementById('apiFields');
const apiBaseUrl = document.getElementById('apiBaseUrl');
const apiModel = document.getElementById('apiModel');
const apiKey = document.getElementById('apiKey');
const apiKeyState = document.getElementById('apiKeyState');
const answerPrivacy = document.getElementById('answerPrivacy');
const answerSettingsStatus = document.getElementById('answerSettingsStatus');
const clearApiKey = document.getElementById('clearApiKey');
const notesButton = document.getElementById('notesButton');
const compactButton = document.getElementById('compactButton');
const closeButton = document.getElementById('closeButton');
const transcriptElement = document.getElementById('transcript');
const hintElement = document.getElementById('hint');
const hintPane = document.querySelector('.hint-pane');
const hintScrollCue = document.getElementById('hintScrollCue');
const historyPrevious = document.getElementById('historyPrevious');
const historyNext = document.getElementById('historyNext');
const historyPosition = document.getElementById('historyPosition');
const privacyNote = document.getElementById('privacyNote');

const TARGET_SAMPLE_RATE = 16000;
const SILENCE_TO_COMMIT_MS = 1050;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 35000;
const PRE_ROLL_MS = 650;
const SETTINGS_KEY = 'tencent-meeting-coach:asr-settings';
const DEFAULT_ASR_SETTINGS = { language: 'zh', precision: 'int8', corrections: true };
const DEFAULT_ANSWER_SETTINGS = {
  mode: 'local',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-terra',
  hasApiKey: false
};

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGain = null;
let listening = false;
let compact = false;
let speechActive = false;
let silenceMs = 0;
let utteranceMs = 0;
let speechBytes = 0;
let preRoll = [];
let partialTranscript = '';
let noiseFloor = 0.0015;
let asrSettings = loadAsrSettings();
let answerSettings = { ...DEFAULT_ANSWER_SETTINGS };
let savedAnswerMode = 'local';
let qaHistory = [];
let historyIndex = -1;

function loadAsrSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      language: saved.language === 'auto' ? 'auto' : 'zh',
      precision: saved.precision === 'fp32' ? 'fp32' : 'int8',
      corrections: saved.corrections !== false
    };
  } catch {
    return { ...DEFAULT_ASR_SETTINGS };
  }
}

function saveAsrSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(asrSettings));
}

function renderAsrSettings() {
  document.querySelectorAll('[data-language]').forEach((button) => {
    const active = button.dataset.language === asrSettings.language;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-precision]').forEach((button) => {
    const active = button.dataset.precision === asrSettings.precision;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  correctionsToggle.checked = asrSettings.corrections;
  recognitionButton.textContent = `${asrSettings.language === 'zh' ? '中' : '自'}·${asrSettings.precision === 'fp32' ? '32' : '8'}`;
}

function setAnswerSettingsMessage(message, state = '') {
  answerSettingsStatus.textContent = message;
  answerSettingsStatus.classList.toggle('error-message', state === 'error');
  answerSettingsStatus.classList.toggle('success-message', state === 'success');
}

function renderAnswerSettings() {
  document.querySelectorAll('[data-answer-mode]').forEach((button) => {
    const active = button.dataset.answerMode === answerSettings.mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const apiMode = answerSettings.mode === 'api';
  apiFields.hidden = !apiMode;
  answerSettingsPage.classList.toggle('api-active', apiMode);
  answerPrivacy.textContent = apiMode
    ? '题目、知识和准备信息会发送；音频不上传'
    : '本地模式不上传回答文本';
  apiBaseUrl.value = answerSettings.baseUrl;
  apiModel.value = answerSettings.model;
  apiKeyState.textContent = answerSettings.hasApiKey ? '已加密保存' : '未保存';
  apiKeyState.classList.toggle('saved', answerSettings.hasApiKey);
  clearApiKey.disabled = !answerSettings.hasApiKey || listening;
  privacyNote.textContent = savedAnswerMode === 'api'
    ? '本地识别 · API 回答 · 不保存音频'
    : '完全本地 · 不保存音频 · 获准后使用';
}

async function loadAnswerSettings() {
  try {
    answerSettings = await window.coach.getAnswerSettings();
    savedAnswerMode = answerSettings.mode;
    renderAnswerSettings();
  } catch (error) {
    setAnswerSettingsMessage(error.message || String(error), 'error');
  }
}

function setSettingsDisabled(disabled) {
  recognitionPanel.querySelectorAll('button, input').forEach((control) => { control.disabled = disabled; });
  recognitionButton.disabled = disabled;
  clearApiKey.disabled = disabled || !answerSettings.hasApiKey;
}

function closeRecognitionPanel() {
  recognitionPanel.hidden = true;
  recognitionButton.setAttribute('aria-expanded', 'false');
}

recognitionButton.addEventListener('click', (event) => {
  event.stopPropagation();
  recognitionPanel.hidden = !recognitionPanel.hidden;
  recognitionButton.setAttribute('aria-expanded', String(!recognitionPanel.hidden));
});

recognitionPanel.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', closeRecognitionPanel);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeRecognitionPanel();
});

document.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const answerTab = button.dataset.settingsTab === 'answer';
    recognitionSettingsPage.hidden = answerTab;
    answerSettingsPage.hidden = !answerTab;
    document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('selected', active);
      tab.setAttribute('aria-selected', String(active));
    });
  });
});

document.querySelectorAll('[data-answer-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    answerSettings.mode = button.dataset.answerMode;
    renderAnswerSettings();
    setAnswerSettingsMessage('点击“保存设置”后生效');
  });
});

answerSettingsPage.addEventListener('submit', async (event) => {
  event.preventDefault();
  setAnswerSettingsMessage('正在安全保存…');
  try {
    answerSettings = await window.coach.saveAnswerSettings({
      mode: answerSettings.mode,
      baseUrl: apiBaseUrl.value,
      model: apiModel.value,
      apiKey: apiKey.value
    });
    apiKey.value = '';
    savedAnswerMode = answerSettings.mode;
    renderAnswerSettings();
    setAnswerSettingsMessage(answerSettings.mode === 'api' ? 'API 回答已启用' : '本地回答已启用', 'success');
  } catch (error) {
    setAnswerSettingsMessage(error.message || String(error), 'error');
  }
});

clearApiKey.addEventListener('click', async () => {
  try {
    answerSettings = await window.coach.saveAnswerSettings({
      mode: 'local',
      baseUrl: apiBaseUrl.value,
      model: apiModel.value,
      clearApiKey: true
    });
    apiKey.value = '';
    savedAnswerMode = 'local';
    renderAnswerSettings();
    setAnswerSettingsMessage('Key 已清除，并已切回本地回答', 'success');
  } catch (error) {
    setAnswerSettingsMessage(error.message || String(error), 'error');
  }
});

document.querySelectorAll('[data-language]').forEach((button) => {
  button.addEventListener('click', () => {
    asrSettings.language = button.dataset.language;
    saveAsrSettings();
    renderAsrSettings();
  });
});

document.querySelectorAll('[data-precision]').forEach((button) => {
  button.addEventListener('click', () => {
    asrSettings.precision = button.dataset.precision;
    saveAsrSettings();
    renderAsrSettings();
  });
});

correctionsToggle.addEventListener('change', () => {
  asrSettings.corrections = correctionsToggle.checked;
  saveAsrSettings();
});

renderAsrSettings();
renderAnswerSettings();
loadAnswerSettings();

function updateHintOverflow() {
  const overflowing = hintElement.scrollHeight > hintElement.clientHeight + 1;
  const atBottom = hintElement.scrollTop + hintElement.clientHeight >= hintElement.scrollHeight - 2;
  hintScrollCue.classList.toggle('visible', overflowing);
  hintScrollCue.textContent = atBottom ? '已到底 ↑' : '滚轮查看 ↓';
}

function setHintText(value) {
  hintElement.textContent = value;
  hintElement.scrollTop = 0;
  requestAnimationFrame(updateHintOverflow);
}

function updateHistoryNavigation() {
  const total = qaHistory.length;
  historyPosition.textContent = total ? `${historyIndex + 1} / ${total}` : '0 / 0';
  historyPrevious.disabled = historyIndex <= 0;
  historyNext.disabled = historyIndex < 0 || historyIndex >= total - 1;
}

function renderHistoryEntry(index) {
  if (index < 0 || index >= qaHistory.length) return;
  historyIndex = index;
  const entry = qaHistory[historyIndex];
  transcriptElement.textContent = entry.transcript;
  setHintText(entry.hint);
  updateHistoryNavigation();
  statusLabel.textContent = historyIndex === qaHistory.length - 1
    ? '提示已就绪'
    : `查看历史问答 ${historyIndex + 1} / ${qaHistory.length}`;
}

function addHistoryEntry(transcript, hint) {
  const previous = qaHistory.at(-1);
  if (previous?.transcript === transcript) {
    previous.hint = hint;
  } else {
    qaHistory.push({ transcript, hint });
  }
  historyIndex = qaHistory.length - 1;
  renderHistoryEntry(historyIndex);
}

historyPrevious.addEventListener('click', () => renderHistoryEntry(historyIndex - 1));
historyNext.addEventListener('click', () => renderHistoryEntry(historyIndex + 1));
updateHistoryNavigation();

hintPane.addEventListener('wheel', (event) => {
  if (hintElement.scrollHeight <= hintElement.clientHeight + 1) return;
  hintElement.scrollTop += event.deltaY;
  event.preventDefault();
}, { passive: false });

hintElement.addEventListener('scroll', updateHintOverflow);
new ResizeObserver(updateHintOverflow).observe(hintElement);

function setVisualState(state, label) {
  shell.classList.remove('listening', 'connecting', 'error');
  if (state === 'ready' || state === 'listening') shell.classList.add('listening');
  if (state === 'connecting') shell.classList.add('connecting');
  if (state === 'error') shell.classList.add('error');
  if (label) statusLabel.textContent = label;
}

function floatToPcm16(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < float32.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32[index]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, int16, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

function calculateRms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / samples.length);
}

function resetUtterance() {
  speechActive = false;
  silenceMs = 0;
  utteranceMs = 0;
  speechBytes = 0;
  preRoll = [];
}

function commitUtterance() {
  if (speechBytes >= TARGET_SAMPLE_RATE * 2 * 0.1) window.coach.commitAudio();
  resetUtterance();
}

function processAudio(event) {
  if (!listening) return;
  const samples = event.inputBuffer.getChannelData(0);
  const pcm = floatToPcm16(samples);
  const rms = calculateRms(samples);
  const chunkMs = (samples.length / audioContext.sampleRate) * 1000;
  const base64 = toBase64(pcm);
  const startThreshold = Math.max(0.0028, Math.min(0.012, noiseFloor * 3.2));
  const stopThreshold = Math.max(0.0023, Math.min(0.009, noiseFloor * 2.0));

  if (!speechActive) {
    preRoll.push({ base64, bytes: pcm.byteLength, duration: chunkMs });
    let total = preRoll.reduce((sum, chunk) => sum + chunk.duration, 0);
    while (total > PRE_ROLL_MS && preRoll.length > 1) {
      total -= preRoll.shift().duration;
    }

    if (rms >= startThreshold) {
      speechActive = true;
      for (const chunk of preRoll) {
        window.coach.sendAudio(chunk.base64);
        speechBytes += chunk.bytes;
        utteranceMs += chunk.duration;
      }
      preRoll = [];
    } else {
      noiseFloor = noiseFloor * 0.97 + Math.min(rms, 0.012) * 0.03;
    }
    return;
  }

  window.coach.sendAudio(base64);
  speechBytes += pcm.byteLength;
  utteranceMs += chunkMs;
  silenceMs = rms < stopThreshold ? silenceMs + chunkMs : 0;

  if ((silenceMs >= SILENCE_TO_COMMIT_MS && utteranceMs >= MIN_UTTERANCE_MS) || utteranceMs >= MAX_UTTERANCE_MS) {
    commitUtterance();
  }
}

async function setupAudioGraph(stream) {
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) throw new Error('没有捕获到系统音频。请确认 Windows 正在播放腾讯会议声音。');
  stream.getVideoTracks().forEach((track) => track.stop());

  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
  const audioOnlyStream = new MediaStream(audioTracks);
  sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processorNode.onaudioprocess = processAudio;
  sourceNode.connect(processorNode);
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);
  await audioContext.resume();
}

async function startListening() {
  closeRecognitionPanel();
  setSettingsDisabled(true);
  setVisualState('connecting', '正在请求系统音频');
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    await setupAudioGraph(mediaStream);
    const result = await window.coach.start({
      sampleRate: audioContext.sampleRate,
      asrLanguage: asrSettings.language,
      asrPrecision: asrSettings.precision,
      asrCorrections: asrSettings.corrections
    });
    listening = true;
    listenButton.textContent = '停止监听';
    listenButton.classList.add('active');
    const answerLabel = result.provider === 'api' ? `API ${result.model}` : '本地 Qwen';
    setVisualState('ready', `监听中 · ${result.settings.language === 'zh' ? '中文' : '自动'} ${result.settings.precision.toUpperCase()} · VAD · ${answerLabel}`);
    setHintText('先给结论，再用真实经历展开。');
  } catch (error) {
    await stopListening();
    setVisualState('error', '无法开始监听');
    setHintText(error.message || String(error));
  }
}

async function stopListening() {
  if (speechActive) commitUtterance();
  listening = false;
  processorNode?.disconnect();
  sourceNode?.disconnect();
  silentGain?.disconnect();
  processorNode = null;
  sourceNode = null;
  silentGain = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  if (audioContext) await audioContext.close().catch(() => {});
  audioContext = null;
  await window.coach.stop().catch(() => {});
  listenButton.textContent = '开始监听';
  listenButton.classList.remove('active');
  setSettingsDisabled(false);
  resetUtterance();
  setVisualState('stopped', '监听已停止');
}

listenButton.addEventListener('click', () => {
  if (listening) stopListening();
  else startListening();
});

notesButton.addEventListener('click', async () => {
  try {
    await window.coach.openPrepNotes();
    statusLabel.textContent = '准备信息已打开，保存后自动生效';
  } catch (error) {
    setVisualState('error', '无法打开准备信息');
    setHintText(error.message || String(error));
  }
});

compactButton.addEventListener('click', async () => {
  compact = !compact;
  shell.classList.toggle('compact', compact);
  compactButton.textContent = compact ? '+' : '−';
  compactButton.title = compact ? '展开' : '折叠';
  await window.coach.setCompact(compact);
});

closeButton.addEventListener('click', async () => {
  await stopListening();
  window.coach.close();
});

window.coach.onStatus(({ state, label }) => setVisualState(state, label));

window.coach.onDelta(({ delta }) => {
  partialTranscript += delta;
  if (!qaHistory.length) transcriptElement.textContent = partialTranscript || '正在识别…';
});

window.coach.onTranscript(({ transcript }) => {
  partialTranscript = '';
  if (!qaHistory.length) transcriptElement.textContent = transcript;
});

window.coach.onHintStart(({ transcript }) => {
  shell.classList.add('thinking');
  transcriptElement.textContent = transcript;
  setHintText('正在提炼回答抓手…');
  statusLabel.textContent = '识别到问题 · 正在整理';
});

window.coach.onHint(({ transcript, hint }) => {
  shell.classList.remove('thinking');
  addHistoryEntry(transcript, hint);
});

window.coach.onIdle(({ reason } = {}) => {
  shell.classList.remove('thinking');
  if (qaHistory.length) {
    renderHistoryEntry(historyIndex);
    statusLabel.textContent = reason === 'candidate-response' || reason === 'answer-echo' || reason === 'answer-protection'
      ? '已忽略疑似面试者回答'
      : '监听中 · 等待新问题';
  } else {
    setHintText('这段更像陈述，继续等待问题。');
    statusLabel.textContent = '监听中 · 等待问题';
  }
});

window.coach.onError((message) => {
  shell.classList.remove('thinking');
  setVisualState('error', '发生错误');
  setHintText(message);
});
