const fs = require('fs');
const path = require('path');

const root = process.env.COACH_LOCAL_ROOT || 'E:\\TencentMeetingCoachLocal';
const ollamaUrl = process.env.COACH_OLLAMA_URL || 'http://127.0.0.1:11434';
const asrUrl = process.env.COACH_ASR_URL || 'http://127.0.0.1:8765';
const model = process.env.COACH_LOCAL_LLM || 'qwen3.5:9b';

function wavData(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Invalid WAV file.');
  let offset = 12;
  let sampleRate = 16000;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = buffer.readUInt32LE(offset + 12);
    if (id === 'data') return { sampleRate, pcm: buffer.subarray(offset + 8, offset + 8 + size) };
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV data chunk not found.');
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function main() {
  const senseDir = path.join(root, 'models', 'sensevoice', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17');
  const wav = wavData(fs.readFileSync(path.join(senseDir, 'test_wavs', 'zh.wav')));
  const health = await json(`${asrUrl}/health`);
  const configured = await json(`${asrUrl}/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ precision: 'int8', language: 'zh', corrections: true })
  });
  const asr = await json(`${asrUrl}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(wav.sampleRate) },
    body: wav.pcm
  });
  if (!asr.text.includes('时间') || asr.text.length < 8) throw new Error(`Unexpected ASR result: ${asr.text}`);
  if (!health.vad || !configured.corrections) throw new Error('ASR upgrade is not active.');
  const llm = await json(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '只回复：本地模型正常' }],
      stream: false,
      think: false,
      keep_alive: '30m',
      options: { temperature: 0, num_predict: 16 }
    })
  });
  const answer = String(llm.message?.content || '').trim();
  if (!answer) throw new Error('Ollama returned no text.');
  console.log(`SenseVoice: ${asr.text} (VAD ${asr.vad_ms} ms + ASR ${asr.inference_ms} ms)`);
  console.log(`Ollama ${model}: ${answer}`);
  console.log(`ASR health: ${health.status}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
