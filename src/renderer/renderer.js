const shell = document.getElementById('coachShell');
const statusLabel = document.getElementById('statusLabel');
const listenButton = document.getElementById('listenButton');
const platformButton = document.getElementById('platformButton');
const platformPanel = document.getElementById('platformPanel');
const platformMonogram = document.getElementById('platformMonogram');
const platformLabel = document.getElementById('platformLabel');
const captureTargetCopy = document.getElementById('captureTargetCopy');
const captureTargetLabel = document.getElementById('captureTargetLabel');
const sourceSelectWrap = document.getElementById('sourceSelectWrap');
const captureSourceSelect = document.getElementById('captureSourceSelect');
const refreshSources = document.getElementById('refreshSources');
const platformNote = document.getElementById('platformNote');
const recognitionButton = document.getElementById('recognitionButton');
const recognitionPanel = document.getElementById('recognitionPanel');
const correctionsToggle = document.getElementById('correctionsToggle');
const streamingToggle = document.getElementById('streamingToggle');
const micCaptureToggle = document.getElementById('micCaptureToggle');
const recognitionSettingsPage = document.getElementById('recognitionSettingsPage');
const domainSettingsPage = document.getElementById('domainSettingsPage');
const answerSettingsPage = document.getElementById('answerSettingsPage');
const domainModuleSelect = document.getElementById('domainModuleSelect');
const domainModuleOrigin = document.getElementById('domainModuleOrigin');
const domainModuleStats = document.getElementById('domainModuleStats');
const domainModuleDescription = document.getElementById('domainModuleDescription');
const domainModuleStatus = document.getElementById('domainModuleStatus');
const openDomainGuide = document.getElementById('openDomainGuide');
const openDomainFolder = document.getElementById('openDomainFolder');
const reloadDomainModules = document.getElementById('reloadDomainModules');
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
const transcriptSpeaker = document.getElementById('transcriptSpeaker');
const partialTranscriptRow = document.getElementById('partialTranscriptRow');
const partialSpeaker = document.getElementById('partialSpeaker');
const partialTranscriptElement = document.getElementById('partialTranscript');
const selfTranscriptRow = document.getElementById('selfTranscriptRow');
const selfSpeaker = document.getElementById('selfSpeaker');
const selfTranscriptElement = document.getElementById('selfTranscript');
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
const CAPTURE_SETTINGS_KEY = 'online-interview-assistant:capture-settings';
const PLATFORM_META = {
  auto: { label: '自动匹配', shortLabel: 'A' },
  tencent: { label: '腾讯会议', shortLabel: '腾' },
  zoom: { label: 'Zoom', shortLabel: 'ZO' },
  teams: { label: 'Teams', shortLabel: 'TE' },
  feishu: { label: '飞书 / Lark', shortLabel: '飞' },
  dingtalk: { label: '钉钉', shortLabel: '钉' },
  webex: { label: 'Webex', shortLabel: 'WX' },
  meet: { label: 'Google Meet', shortLabel: 'GM' },
  custom: { label: '自定义窗口', shortLabel: '窗' }
};
const DEFAULT_ASR_SETTINGS = {
  language: 'zh',
  precision: 'int8',
  corrections: true,
  streaming: true,
  micCapture: true,
  domainModuleId: 'finance-accounting'
};
const DEFAULT_ANSWER_SETTINGS = {
  mode: 'local',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-terra',
  hasApiKey: false
};

let captureChannels = new Map();
let listening = false;
let compact = false;
let remotePartialTranscript = '';
let selfTranscriptTimer = null;
let asrSettings = loadAsrSettings();
let captureSelection = loadCaptureSelection();
let captureCatalog = null;
let activeCaptureTarget = null;
let domainModules = [];
let domainModuleErrors = [];
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
      corrections: saved.corrections !== false,
      streaming: saved.streaming !== false,
      micCapture: saved.micCapture !== false,
      domainModuleId: String(saved.domainModuleId || 'finance-accounting')
    };
  } catch {
    return { ...DEFAULT_ASR_SETTINGS };
  }
}

function saveAsrSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(asrSettings));
}

function loadCaptureSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAPTURE_SETTINGS_KEY) || '{}');
    const platform = Object.prototype.hasOwnProperty.call(PLATFORM_META, saved.platform) ? saved.platform : 'auto';
    return {
      platform,
      sourceId: String(saved.sourceId || ''),
      sourceName: String(saved.sourceName || '')
    };
  } catch {
    return { platform: 'auto', sourceId: '', sourceName: '' };
  }
}

function saveCaptureSelection() {
  localStorage.setItem(CAPTURE_SETTINGS_KEY, JSON.stringify(captureSelection));
}

function renderPlatformButton(target = captureCatalog?.suggestion) {
  const selected = PLATFORM_META[captureSelection.platform] || PLATFORM_META.auto;
  const detected = target?.platform && PLATFORM_META[target.platform] ? PLATFORM_META[target.platform] : selected;
  platformMonogram.textContent = detected.shortLabel;
  platformLabel.textContent = captureSelection.platform === 'auto' && target?.platform !== 'auto'
    ? `自动 · ${detected.label}`
    : selected.label;
  platformButton.title = target?.sourceName
    ? `${platformLabel.textContent}：${target.sourceName}`
    : '选择会议平台或窗口';
}

function renderPlatformSelection() {
  document.querySelectorAll('[data-platform]').forEach((button) => {
    const active = button.dataset.platform === captureSelection.platform;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function populateCaptureSources(sources = []) {
  captureSourceSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选择一个窗口或屏幕…';
  captureSourceSelect.appendChild(placeholder);

  for (const source of sources) {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = `${source.kind === 'screen' ? '屏幕' : source.platformLabel} · ${source.name}`;
    option.dataset.sourceName = source.name;
    captureSourceSelect.appendChild(option);
  }

  const exact = sources.find((source) => source.id === captureSelection.sourceId);
  const byName = sources.find((source) => captureSelection.sourceName && source.name === captureSelection.sourceName);
  const selected = exact || byName;
  captureSourceSelect.value = selected?.id || '';
  if (selected && selected.id !== captureSelection.sourceId) {
    captureSelection.sourceId = selected.id;
    captureSelection.sourceName = selected.name;
    saveCaptureSelection();
  }
}

function renderCaptureCatalog(catalog) {
  captureCatalog = catalog;
  renderPlatformSelection();
  const custom = captureSelection.platform === 'custom';
  captureTargetCopy.hidden = custom;
  sourceSelectWrap.hidden = !custom;
  platformNote.classList.remove('warning');

  if (custom) {
    populateCaptureSources(catalog.sources);
    const selected = catalog.sources.find((source) => source.id === captureSourceSelect.value);
    platformNote.textContent = selected
      ? '窗口用于目标匹配；Windows 回环仍会捕获系统正在播放的声音。'
      : '请选择正在面试的窗口或屏幕，关闭的窗口需要重新选择。';
    platformNote.classList.toggle('warning', !selected);
  } else if (catalog.suggestion) {
    captureTargetLabel.textContent = catalog.suggestion.sourceName;
    platformNote.textContent = catalog.suggestion.fallback
      ? catalog.suggestion.reason
      : '已匹配窗口；Windows 回环会捕获系统正在播放的声音。';
    platformNote.classList.toggle('warning', Boolean(catalog.suggestion.fallback));
  } else {
    captureTargetLabel.textContent = '没有找到匹配窗口';
    platformNote.textContent = catalog.message || '请先进入会议，或选择“自定义窗口”。';
    platformNote.classList.add('warning');
  }
  renderPlatformButton(catalog.suggestion);
}

async function refreshCaptureCatalog() {
  refreshSources.disabled = true;
  if (captureSelection.platform !== 'custom') captureTargetLabel.textContent = '正在扫描会议窗口…';
  platformNote.classList.remove('warning');
  try {
    const catalog = await window.coach.listCaptureSources(captureSelection);
    renderCaptureCatalog(catalog);
    return catalog;
  } catch (error) {
    platformNote.textContent = error.message || String(error);
    platformNote.classList.add('warning');
    return null;
  } finally {
    refreshSources.disabled = false;
  }
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
  streamingToggle.checked = asrSettings.streaming;
  micCaptureToggle.checked = asrSettings.micCapture;
  recognitionButton.textContent = `${asrSettings.language === 'zh' ? '中' : '自'}·${asrSettings.precision === 'fp32' ? '32' : '8'}`;
}

function setDomainModuleMessage(message, error = false) {
  domainModuleStatus.textContent = message;
  domainModuleStatus.classList.toggle('error-message', error);
}

function renderDomainModules() {
  domainModuleSelect.replaceChildren();
  for (const module of domainModules) {
    const option = document.createElement('option');
    option.value = module.id;
    option.textContent = `${module.name} · ${module.version}${module.source === 'user' ? '（用户）' : ''}`;
    domainModuleSelect.appendChild(option);
  }
  let selected = domainModules.find((module) => module.id === asrSettings.domainModuleId);
  if (!selected) {
    selected = domainModules.find((module) => module.id === 'finance-accounting')
      || domainModules.find((module) => module.id === 'general')
      || domainModules[0];
    if (selected) {
      asrSettings.domainModuleId = selected.id;
      saveAsrSettings();
    }
  }
  domainModuleSelect.value = selected?.id || '';
  domainModuleSelect.disabled = listening || !selected;
  domainModuleOrigin.textContent = selected?.source === 'user' ? '用户模块' : '内置模块';
  domainModuleOrigin.classList.toggle('user-module', selected?.source === 'user');
  domainModuleDescription.textContent = selected?.description || '没有可用的领域模块。';
  const stats = selected?.stats || {};
  domainModuleStats.textContent = `${stats.correctionRules || 0} 条纠错 · ${stats.knowledgeSections || 0} 个知识专题`;
  if (domainModuleErrors.length) {
    const first = domainModuleErrors[0];
    setDomainModuleMessage(`${first.folder}：${first.error}`, true);
  } else {
    setDomainModuleMessage('选择将在下次监听时生效');
  }
}

async function loadDomainModules() {
  reloadDomainModules.disabled = true;
  setDomainModuleMessage('正在扫描模块…');
  try {
    const result = await window.coach.listDomainModules();
    domainModules = result.modules || [];
    domainModuleErrors = result.errors || [];
    renderDomainModules();
  } catch (error) {
    domainModules = [];
    domainModuleErrors = [];
    domainModuleDescription.textContent = '无法读取领域模块。';
    setDomainModuleMessage(error.message || String(error), true);
  } finally {
    reloadDomainModules.disabled = listening;
  }
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
    ? 'Windows 双通道 · API 回答 · 不保存音频'
    : 'Windows 双通道 · 完全本地 · 不保存音频';
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
  recognitionPanel.querySelectorAll('button, input, select').forEach((control) => { control.disabled = disabled; });
  platformPanel.querySelectorAll('button, select').forEach((control) => { control.disabled = disabled; });
  recognitionButton.disabled = disabled;
  platformButton.disabled = disabled;
  clearApiKey.disabled = disabled || !answerSettings.hasApiKey;
}

function closeRecognitionPanel() {
  recognitionPanel.hidden = true;
  recognitionButton.setAttribute('aria-expanded', 'false');
}

function closePlatformPanel() {
  platformPanel.hidden = true;
  platformButton.setAttribute('aria-expanded', 'false');
}

platformButton.addEventListener('click', async (event) => {
  event.stopPropagation();
  const opening = platformPanel.hidden;
  closeRecognitionPanel();
  platformPanel.hidden = !opening;
  platformButton.setAttribute('aria-expanded', String(opening));
  if (opening) await refreshCaptureCatalog();
});

recognitionButton.addEventListener('click', (event) => {
  event.stopPropagation();
  closePlatformPanel();
  recognitionPanel.hidden = !recognitionPanel.hidden;
  recognitionButton.setAttribute('aria-expanded', String(!recognitionPanel.hidden));
});

platformPanel.addEventListener('click', (event) => event.stopPropagation());
recognitionPanel.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => {
  closeRecognitionPanel();
  closePlatformPanel();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeRecognitionPanel();
    closePlatformPanel();
  }
});

document.querySelectorAll('[data-platform]').forEach((button) => {
  button.addEventListener('click', async () => {
    captureSelection.platform = button.dataset.platform;
    saveCaptureSelection();
    renderPlatformSelection();
    await refreshCaptureCatalog();
  });
});

captureSourceSelect.addEventListener('change', () => {
  const selected = captureCatalog?.sources.find((source) => source.id === captureSourceSelect.value);
  captureSelection.sourceId = selected?.id || '';
  captureSelection.sourceName = selected?.name || '';
  saveCaptureSelection();
  platformNote.textContent = selected
    ? '窗口用于目标匹配；Windows 回环仍会捕获系统正在播放的声音。'
    : '请选择正在面试的窗口或屏幕，关闭的窗口需要重新选择。';
  platformNote.classList.toggle('warning', !selected);
  renderPlatformButton(selected ? {
    platform: selected.platform,
    sourceName: selected.name
  } : null);
});

refreshSources.addEventListener('click', refreshCaptureCatalog);

document.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const page = button.dataset.settingsTab;
    recognitionSettingsPage.hidden = page !== 'recognition';
    domainSettingsPage.hidden = page !== 'domain';
    answerSettingsPage.hidden = page !== 'answer';
    document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('selected', active);
      tab.setAttribute('aria-selected', String(active));
    });
  });
});

domainModuleSelect.addEventListener('change', () => {
  asrSettings.domainModuleId = domainModuleSelect.value;
  saveAsrSettings();
  renderDomainModules();
  setDomainModuleMessage('领域模块已选择，下次监听时生效');
});

reloadDomainModules.addEventListener('click', loadDomainModules);

openDomainFolder.addEventListener('click', async () => {
  try {
    await window.coach.openDomainModuleFolder();
    setDomainModuleMessage('模块目录已打开；修改后点击“重新扫描”');
  } catch (error) {
    setDomainModuleMessage(error.message || String(error), true);
  }
});

openDomainGuide.addEventListener('click', async () => {
  try {
    await window.coach.openDomainModuleGuide();
    setDomainModuleMessage('领域模块编写说明已打开');
  } catch (error) {
    setDomainModuleMessage(error.message || String(error), true);
  }
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

streamingToggle.addEventListener('change', () => {
  asrSettings.streaming = streamingToggle.checked;
  saveAsrSettings();
});

micCaptureToggle.addEventListener('change', () => {
  asrSettings.micCapture = micCaptureToggle.checked;
  saveAsrSettings();
});

renderAsrSettings();
renderPlatformSelection();
renderPlatformButton();
renderAnswerSettings();
loadAnswerSettings();
loadDomainModules();
refreshCaptureCatalog();

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

function setRemoteTranscript(value) {
  transcriptSpeaker.textContent = '对方';
  transcriptElement.textContent = value;
}

function setRemotePartial(value) {
  remotePartialTranscript = String(value || '').trim();
  partialSpeaker.textContent = '对方 · 实时';
  partialTranscriptElement.textContent = remotePartialTranscript;
  partialTranscriptRow.hidden = !remotePartialTranscript;
}

function setSelfTranscript(value, live = false) {
  const text = String(value || '').trim();
  if (selfTranscriptTimer) clearTimeout(selfTranscriptTimer);
  selfSpeaker.textContent = live ? '我 · 实时' : '我';
  selfTranscriptElement.textContent = text;
  selfTranscriptRow.hidden = !text;
  if (text && !live) {
    selfTranscriptTimer = setTimeout(() => {
      selfTranscriptRow.hidden = true;
      selfTranscriptElement.textContent = '';
    }, 6000);
  }
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
  setRemoteTranscript(entry.transcript);
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

function resetUtterance(channel) {
  channel.speechActive = false;
  channel.silenceMs = 0;
  channel.utteranceMs = 0;
  channel.speechBytes = 0;
  channel.preRoll = [];
}

function commitUtterance(channel) {
  if (channel.speechBytes >= TARGET_SAMPLE_RATE * 2 * 0.1) window.coach.commitAudio(channel.source);
  resetUtterance(channel);
}

function processAudio(channel, event) {
  if (!listening) return;
  const samples = event.inputBuffer.getChannelData(0);
  const pcm = floatToPcm16(samples);
  const rms = calculateRms(samples);
  const chunkMs = (samples.length / channel.audioContext.sampleRate) * 1000;
  const base64 = toBase64(pcm);
  const startThreshold = Math.max(0.0028, Math.min(0.012, channel.noiseFloor * 3.2));
  const stopThreshold = Math.max(0.0023, Math.min(0.009, channel.noiseFloor * 2.0));

  if (!channel.speechActive) {
    channel.preRoll.push({ base64, bytes: pcm.byteLength, duration: chunkMs });
    let total = channel.preRoll.reduce((sum, chunk) => sum + chunk.duration, 0);
    while (total > PRE_ROLL_MS && channel.preRoll.length > 1) {
      total -= channel.preRoll.shift().duration;
    }

    if (rms >= startThreshold) {
      channel.speechActive = true;
      for (const chunk of channel.preRoll) {
        window.coach.sendAudio(channel.source, chunk.base64);
        channel.speechBytes += chunk.bytes;
        channel.utteranceMs += chunk.duration;
      }
      channel.preRoll = [];
    } else {
      channel.noiseFloor = channel.noiseFloor * 0.97 + Math.min(rms, 0.012) * 0.03;
    }
    return;
  }

  window.coach.sendAudio(channel.source, base64);
  channel.speechBytes += pcm.byteLength;
  channel.utteranceMs += chunkMs;
  channel.silenceMs = rms < stopThreshold ? channel.silenceMs + chunkMs : 0;

  if (
    (channel.silenceMs >= SILENCE_TO_COMMIT_MS && channel.utteranceMs >= MIN_UTTERANCE_MS) ||
    channel.utteranceMs >= MAX_UTTERANCE_MS
  ) {
    commitUtterance(channel);
  }
}

async function setupAudioGraph(stream, source) {
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error(source === 'remote'
      ? '没有捕获到系统音频。请确认 Windows 正在播放会议声音。'
      : '没有捕获到麦克风音频。');
  }
  stream.getVideoTracks().forEach((track) => track.stop());

  const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
  const audioOnlyStream = new MediaStream(audioTracks);
  const sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  const channel = {
    source,
    stream,
    audioContext,
    sourceNode,
    processorNode,
    silentGain,
    speechActive: false,
    silenceMs: 0,
    utteranceMs: 0,
    speechBytes: 0,
    preRoll: [],
    noiseFloor: source === 'local' ? 0.002 : 0.0015
  };
  processorNode.onaudioprocess = (event) => processAudio(channel, event);
  sourceNode.connect(processorNode);
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);
  await audioContext.resume();
  captureChannels.set(source, channel);
  return channel;
}

async function closeCaptureChannel(channel) {
  channel.processorNode.onaudioprocess = null;
  channel.processorNode.disconnect();
  channel.sourceNode.disconnect();
  channel.silentGain.disconnect();
  channel.stream.getTracks().forEach((track) => track.stop());
  await channel.audioContext.close().catch(() => {});
}

async function startListening() {
  closeRecognitionPanel();
  closePlatformPanel();
  setSettingsDisabled(true);
  listenButton.disabled = true;
  setVisualState('connecting', '正在匹配会议窗口');
  try {
    activeCaptureTarget = await window.coach.prepareCaptureTarget(captureSelection);
    renderPlatformButton(activeCaptureTarget);
    setVisualState('connecting', `已匹配 ${activeCaptureTarget.platformLabel} · 正在请求系统音频`);
    const systemStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const remoteChannel = await setupAudioGraph(systemStream, 'remote');
    let micError = '';
    if (asrSettings.micCapture) {
      setVisualState('connecting', '正在请求麦克风 · 用于区分“我”');
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });
        await setupAudioGraph(micStream, 'local');
      } catch (error) {
        micError = error.message || String(error);
      }
    }
    const result = await window.coach.start({
      sampleRate: remoteChannel.audioContext.sampleRate,
      asrLanguage: asrSettings.language,
      asrPrecision: asrSettings.precision,
      asrCorrections: asrSettings.corrections,
      asrStreaming: asrSettings.streaming,
      micEnabled: captureChannels.has('local'),
      domainModuleId: asrSettings.domainModuleId
    });
    listening = true;
    listenButton.disabled = false;
    listenButton.textContent = '停止监听';
    listenButton.classList.add('active');
    const answerLabel = result.provider === 'api' ? `API ${result.model}` : '本地 Qwen';
    const streamLabel = result.streaming ? 'FunASR 流式' : '整句字幕';
    const speakerLabel = captureChannels.has('local') ? '对方/我已分离' : '仅对方音频';
    const meetingLabel = result.captureTarget?.platformLabel || activeCaptureTarget.platformLabel;
    const domainLabel = result.domainModule?.name || '通用';
    setVisualState(
      'ready',
      micError
        ? `监听 ${meetingLabel} · ${domainLabel} · 麦克风不可用`
        : `监听 ${meetingLabel} · ${domainLabel} · ${streamLabel} · ${speakerLabel} · ${answerLabel}`
    );
    setHintText('先给结论，再用真实经历展开。');
  } catch (error) {
    await stopListening();
    setVisualState('error', '无法开始监听');
    setHintText(error.message || String(error));
  }
}

async function stopListening() {
  for (const channel of captureChannels.values()) {
    if (channel.speechActive) commitUtterance(channel);
  }
  listening = false;
  await Promise.all([...captureChannels.values()].map(closeCaptureChannel));
  captureChannels = new Map();
  await window.coach.stop().catch(() => {});
  listenButton.textContent = '开始监听';
  listenButton.disabled = false;
  listenButton.classList.remove('active');
  setSettingsDisabled(false);
  setRemotePartial('');
  setSelfTranscript('');
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

window.coach.onDelta(({ speaker = 'remote', partial, delta, final = false }) => {
  const next = partial !== undefined
    ? String(partial || '')
    : `${speaker === 'remote' ? remotePartialTranscript : selfTranscriptElement.textContent}${delta || ''}`;
  if (speaker === 'local') {
    setSelfTranscript(final ? '' : next, !final);
    return;
  }
  setRemotePartial(final ? '' : next);
});

window.coach.onTranscript(({ transcript, speaker = 'remote' }) => {
  if (speaker === 'local') {
    setSelfTranscript(transcript, false);
    return;
  }
  setRemotePartial('');
  setRemoteTranscript(transcript);
});

window.coach.onHintStart(({ transcript }) => {
  shell.classList.add('thinking');
  setRemotePartial('');
  setRemoteTranscript(transcript);
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
