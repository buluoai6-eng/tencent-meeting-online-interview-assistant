const assert = require('assert');
const {
  normalizeCaptureSelection,
  platformForWindowName,
  resolveCaptureTarget,
  sortedSelectableSources
} = require('../src/platform-capture');

const sources = [
  { id: 'screen:0:0', name: 'Entire Screen', display_id: '1' },
  { id: 'screen:1:0', name: 'Screen 2', display_id: '2' },
  { id: 'window:10:0', name: '腾讯会议 - 产品经理面试' },
  { id: 'window:11:0', name: 'Weekly Sync | Microsoft Teams' },
  { id: 'window:12:0', name: 'Budget.xlsx - Excel' },
  { id: 'window:13:0', name: '线上会议面试助手' }
];

assert.strictEqual(platformForWindowName('腾讯会议 - 产品经理面试').id, 'tencent');
assert.strictEqual(platformForWindowName('Weekly Sync | Microsoft Teams').id, 'teams');
assert.strictEqual(platformForWindowName('Interview - Google Meet - Google Chrome').id, 'meet');
assert.strictEqual(platformForWindowName('Budget.xlsx - Excel'), null);

assert.deepStrictEqual(normalizeCaptureSelection({ platform: 'unknown' }), {
  platform: 'auto',
  sourceId: '',
  sourceName: ''
});

const selectable = sortedSelectableSources(sources);
assert(!selectable.some((source) => source.name === '线上会议面试助手'));

const automatic = resolveCaptureTarget(sources, { platform: 'auto' }, '1');
assert.strictEqual(automatic.source.id, 'window:10:0');
assert.strictEqual(automatic.platform, 'tencent');
assert.strictEqual(automatic.fallback, false);

const teams = resolveCaptureTarget(sources, { platform: 'teams' }, '1');
assert.strictEqual(teams.source.id, 'window:11:0');
assert.strictEqual(teams.platformLabel, 'Microsoft Teams');

const custom = resolveCaptureTarget(sources, {
  platform: 'custom',
  sourceId: 'window:12:0',
  sourceName: 'Budget.xlsx - Excel'
}, '1');
assert.strictEqual(custom.source.id, 'window:12:0');

const staleCustom = resolveCaptureTarget(sources, {
  platform: 'custom',
  sourceId: 'window:999:0',
  sourceName: 'Closed meeting'
}, '1');
assert.strictEqual(staleCustom.source, null);
assert.match(staleCustom.reason, /重新选择/);

const missingZoom = resolveCaptureTarget(sources, { platform: 'zoom' }, '1');
assert.strictEqual(missingZoom.source, null);
assert.match(missingZoom.reason, /Zoom/);

const fallback = resolveCaptureTarget(
  sources.filter((source) => !String(source.id).startsWith('window:')),
  { platform: 'auto' },
  '2'
);
assert.strictEqual(fallback.source.id, 'screen:1:0');
assert.strictEqual(fallback.fallback, true);

console.log('Platform capture matching checks passed.');
