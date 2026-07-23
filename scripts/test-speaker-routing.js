const assert = require('assert');
const { normalizeAudioSource, routeTranscript, speakerLabel } = require('../src/speaker-router');

const remote = routeTranscript('remote', '请分析经营现金流下降的原因。');
assert.strictEqual(remote.speaker, 'remote');
assert.strictEqual(remote.label, '对方');
assert.strictEqual(remote.shouldAnswer, true);

const local = routeTranscript('local', '我会先从营运资本变化开始分析。');
assert.strictEqual(local.speaker, 'local');
assert.strictEqual(local.label, '我');
assert.strictEqual(local.shouldAnswer, false, 'mic transcripts must never trigger an answer');

assert.strictEqual(routeTranscript('local', '   ').shouldDisplay, false);
assert.strictEqual(normalizeAudioSource('unexpected'), 'remote');
assert.strictEqual(speakerLabel('local'), '我');

console.log('Speaker routing checks passed.');
