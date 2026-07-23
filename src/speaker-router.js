const AUDIO_SOURCES = new Set(['remote', 'local']);

function normalizeAudioSource(value) {
  return AUDIO_SOURCES.has(value) ? value : 'remote';
}

function speakerLabel(source) {
  return normalizeAudioSource(source) === 'local' ? '我' : '对方';
}

function routeTranscript(source, transcript) {
  const speaker = normalizeAudioSource(source);
  const text = String(transcript || '').trim();
  return {
    speaker,
    text,
    label: speakerLabel(speaker),
    shouldDisplay: Boolean(text),
    shouldAnswer: speaker === 'remote' && Boolean(text)
  };
}

module.exports = {
  normalizeAudioSource,
  routeTranscript,
  speakerLabel
};
