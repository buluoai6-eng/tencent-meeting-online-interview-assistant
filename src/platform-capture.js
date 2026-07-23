const PLATFORM_DEFINITIONS = Object.freeze([
  { id: 'auto', label: '自动匹配', shortLabel: 'AUTO', patterns: [] },
  {
    id: 'tencent',
    label: '腾讯会议',
    shortLabel: '腾讯',
    patterns: [/腾讯会议/i, /tencent meeting/i, /voov meeting/i, /wemeet/i]
  },
  { id: 'zoom', label: 'Zoom', shortLabel: 'ZO', patterns: [/\bzoom\b/i] },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    shortLabel: 'TE',
    patterns: [/microsoft teams/i, /teams meeting/i, /\bteams\b/i]
  },
  { id: 'feishu', label: '飞书 / Lark', shortLabel: '飞书', patterns: [/飞书/i, /feishu/i, /\blark\b/i] },
  { id: 'dingtalk', label: '钉钉', shortLabel: '钉钉', patterns: [/钉钉/i, /dingtalk/i] },
  { id: 'webex', label: 'Webex', shortLabel: 'WX', patterns: [/webex/i] },
  {
    id: 'meet',
    label: 'Google Meet',
    shortLabel: 'GM',
    patterns: [/google meet/i, /meet\.google/i, /meet - google/i, /meet \|/i]
  },
  { id: 'custom', label: '自定义窗口', shortLabel: '窗口', patterns: [] }
]);

const PLATFORM_BY_ID = new Map(PLATFORM_DEFINITIONS.map((item) => [item.id, item]));
const EXCLUDED_WINDOW_PATTERNS = [
  /线上会议面试助手/i,
  /online meeting interview assistant/i,
  /全平台线上面试助手/i,
  /universal online interview assistant/i,
  /腾讯会议线上面试助手/i,
  /tencent meeting online interview assistant/i,
  /program manager/i,
  /windows input experience/i
];

function platformDefinition(id) {
  return PLATFORM_BY_ID.get(String(id || '').toLowerCase()) || PLATFORM_BY_ID.get('auto');
}

function platformForWindowName(name) {
  const title = String(name || '').trim();
  if (!title) return null;
  return PLATFORM_DEFINITIONS.find((item) =>
    item.patterns.length && item.patterns.some((pattern) => pattern.test(title))) || null;
}

function normalizeCaptureSelection(value = {}) {
  const platform = platformDefinition(value.platform).id;
  return {
    platform,
    sourceId: String(value.sourceId || '').slice(0, 256),
    sourceName: String(value.sourceName || '').trim().slice(0, 300)
  };
}

function sourceKind(source) {
  return String(source?.id || '').startsWith('screen:') ? 'screen' : 'window';
}

function isSelectableSource(source) {
  const name = String(source?.name || '').trim();
  if (!name || !source?.id) return false;
  if (sourceKind(source) === 'screen') return true;
  return !EXCLUDED_WINDOW_PATTERNS.some((pattern) => pattern.test(name));
}

function sanitizeCaptureSource(source) {
  const detected = platformForWindowName(source.name);
  return {
    id: String(source.id),
    name: String(source.name || '未命名窗口'),
    kind: sourceKind(source),
    displayId: String(source.display_id || ''),
    platform: detected?.id || 'custom',
    platformLabel: detected?.label || (sourceKind(source) === 'screen' ? '屏幕' : '其他窗口')
  };
}

function sortedSelectableSources(sources = []) {
  return sources
    .filter(isSelectableSource)
    .map(sanitizeCaptureSource)
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'window' ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
}

function findPrimaryScreen(sources, primaryDisplayId) {
  const screens = sources.filter((source) => source.kind === 'screen');
  return screens.find((source) => source.displayId === String(primaryDisplayId || '')) || screens[0] || null;
}

function resolveCaptureTarget(sources = [], selection = {}, primaryDisplayId = '') {
  const normalized = normalizeCaptureSelection(selection);
  const selectable = sources.filter(isSelectableSource).map(sanitizeCaptureSource);
  const requested = platformDefinition(normalized.platform);

  if (normalized.platform === 'custom') {
    const exact = selectable.find((source) => source.id === normalized.sourceId);
    const byName = selectable.find((source) =>
      normalized.sourceName && source.name.toLowerCase() === normalized.sourceName.toLowerCase());
    const source = exact || byName || null;
    return {
      source,
      platform: 'custom',
      platformLabel: source?.kind === 'screen' ? '自定义屏幕' : '自定义窗口',
      matched: Boolean(source),
      fallback: false,
      reason: source ? '' : '自定义窗口已关闭或尚未选择，请重新选择。'
    };
  }

  if (normalized.platform !== 'auto') {
    const source = selectable.find((item) => item.platform === normalized.platform) || null;
    return {
      source,
      platform: requested.id,
      platformLabel: requested.label,
      matched: Boolean(source),
      fallback: false,
      reason: source ? '' : `没有找到正在运行的${requested.label}窗口。请先进入会议，或改用“自定义窗口”。`
    };
  }

  const recognized = selectable.find((source) => source.kind === 'window' && source.platform !== 'custom');
  if (recognized) {
    return {
      source: recognized,
      platform: recognized.platform,
      platformLabel: recognized.platformLabel,
      matched: true,
      fallback: false,
      reason: ''
    };
  }

  const primary = findPrimaryScreen(selectable, primaryDisplayId);
  return {
    source: primary,
    platform: 'auto',
    platformLabel: primary ? '自动 · 主屏幕' : '自动匹配',
    matched: Boolean(primary),
    fallback: Boolean(primary),
    reason: primary ? '未识别到已知会议窗口，已使用主屏幕系统音频。' : '没有找到可捕获的窗口或屏幕。'
  };
}

function publicPlatformDefinitions() {
  return PLATFORM_DEFINITIONS.map(({ id, label, shortLabel }) => ({ id, label, shortLabel }));
}

module.exports = {
  normalizeCaptureSelection,
  platformForWindowName,
  publicPlatformDefinitions,
  resolveCaptureTarget,
  sanitizeCaptureSource,
  sortedSelectableSources
};
