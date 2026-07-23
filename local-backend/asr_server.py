import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import sherpa_onnx


STREAM_CHUNK_SIZE = [0, 10, 5]
STREAM_CHUNK_SAMPLES = STREAM_CHUNK_SIZE[1] * 960
STREAM_ENCODER_LOOK_BACK = 4
STREAM_DECODER_LOOK_BACK = 1


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


class CorrectionEngine:
    def __init__(self, source=None, replacements=None):
        self.source = str(source or "")
        self.rules = []
        if replacements is None:
            if not source:
                return
            path = Path(source)
            if not path.is_file():
                return
            replacements = json.loads(path.read_text(encoding="utf-8")).get("replacements", [])
        if not isinstance(replacements, list) or len(replacements) > 500:
            raise ValueError("correction_rules must be an array with at most 500 entries")
        for item in replacements:
            if not isinstance(item, dict):
                raise ValueError("each correction rule must be an object")
            canonical = str(item.get("canonical", "")).strip()
            aliases = sorted(
                {str(value).strip() for value in item.get("aliases", []) if str(value).strip()},
                key=len,
                reverse=True,
            )
            if canonical and aliases:
                self.rules.append((canonical, aliases))

    def apply(self, text):
        corrected = str(text or "").strip()
        changes = []
        for canonical, aliases in self.rules:
            for alias in aliases:
                flags = re.IGNORECASE if alias.isascii() else 0
                pattern = re.compile(re.escape(alias), flags)
                corrected, count = pattern.subn(canonical, corrected)
                if count:
                    changes.append({"from": alias, "to": canonical, "count": count})
        return corrected, changes


class StreamingFunAsr:
    """Stateful Paraformer online decoding for gray, non-authoritative subtitles."""

    def __init__(self, model_name, device="cpu"):
        from funasr import AutoModel

        self.model_name = str(model_name or "paraformer-zh-streaming")
        self.device = str(device or "cpu")
        self.lock = threading.RLock()
        self.sessions = {}
        started = time.perf_counter()
        self.model = AutoModel(
            model=self.model_name,
            disable_update=True,
            disable_pbar=True,
            device=self.device,
        )
        self.model.generate(
            input=np.zeros(STREAM_CHUNK_SAMPLES, dtype=np.float32),
            cache={},
            is_final=True,
            chunk_size=STREAM_CHUNK_SIZE,
            encoder_chunk_look_back=STREAM_ENCODER_LOOK_BACK,
            decoder_chunk_look_back=STREAM_DECODER_LOOK_BACK,
        )
        self.load_ms = round((time.perf_counter() - started) * 1000, 1)

    @staticmethod
    def _result_text(result):
        if result and isinstance(result, list) and isinstance(result[0], dict):
            return str(result[0].get("text") or "").strip()
        return ""

    def _decode(self, samples, cache, is_final):
        started = time.perf_counter()
        result = self.model.generate(
            input=samples,
            cache=cache,
            is_final=is_final,
            chunk_size=STREAM_CHUNK_SIZE,
            encoder_chunk_look_back=STREAM_ENCODER_LOOK_BACK,
            decoder_chunk_look_back=STREAM_DECODER_LOOK_BACK,
        )
        return self._result_text(result), round((time.perf_counter() - started) * 1000, 1)

    def accept(self, session_id, pcm, sample_rate, is_final=False):
        if sample_rate != 16000:
            raise ValueError("FunASR streaming requires 16000 Hz PCM")
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,96}", session_id or ""):
            raise ValueError("invalid stream session id")
        if len(pcm) % 2:
            pcm = pcm[:-1]
        incoming = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0

        with self.lock:
            now = time.monotonic()
            stale = [key for key, value in self.sessions.items() if now - value["updated"] > 120]
            for key in stale:
                self.sessions.pop(key, None)

            state = self.sessions.setdefault(
                session_id,
                {
                    "cache": {},
                    "buffer": np.zeros(0, dtype=np.float32),
                    "text": "",
                    "updated": now,
                },
            )
            if incoming.size:
                state["buffer"] = np.concatenate([state["buffer"], incoming])
            state["updated"] = now
            inference_ms = 0.0

            while state["buffer"].size >= STREAM_CHUNK_SAMPLES:
                block = state["buffer"][:STREAM_CHUNK_SAMPLES]
                state["buffer"] = state["buffer"][STREAM_CHUNK_SAMPLES:]
                incremental, elapsed = self._decode(block, state["cache"], False)
                inference_ms += elapsed
                if incremental:
                    state["text"] += incremental

            if is_final:
                tail = state["buffer"] if state["buffer"].size else np.zeros(960, dtype=np.float32)
                incremental, elapsed = self._decode(tail, state["cache"], True)
                inference_ms += elapsed
                if incremental:
                    state["text"] += incremental

            text = state["text"].strip()
            if is_final:
                self.sessions.pop(session_id, None)
            return {
                "text": text,
                "final": bool(is_final),
                "inference_ms": round(inference_ms, 1),
                "engine": f"FunASR {self.model_name}",
            }


class AsrApplication:
    def __init__(self, model_dir, vad_model=None, corrections=None, stream_model=None, stream_device="cpu"):
        self.model_dir = Path(model_dir)
        self.tokens = self.model_dir / "tokens.txt"
        if not self.tokens.is_file():
            raise FileNotFoundError(f"SenseVoice tokens are missing under {self.model_dir}")

        self.lock = threading.RLock()
        self.recognizer = None
        self.precision = ""
        self.language = ""
        self.load_ms = 0.0
        self.corrections_enabled = True
        self.correction_engine = CorrectionEngine(corrections)
        self.domain_module = "legacy" if corrections else "general"
        self.vad = self._create_vad(vad_model)
        self.streamer = None
        self.streaming_error = ""
        if stream_model:
            try:
                self.streamer = StreamingFunAsr(stream_model, stream_device)
            except Exception as error:
                self.streaming_error = str(error)
        self.configure(precision="int8", language="zh", corrections=True)

    @staticmethod
    def _create_vad(vad_model):
        if not vad_model or not Path(vad_model).is_file():
            return None
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(vad_model)
        config.silero_vad.threshold = 0.20
        config.silero_vad.min_silence_duration = 0.35
        config.silero_vad.min_speech_duration = 0.15
        config.silero_vad.max_speech_duration = 35.0
        config.sample_rate = 16000
        config.num_threads = 2
        config.provider = "cpu"
        return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=45)

    def configure(
        self,
        precision="int8",
        language="zh",
        corrections=True,
        correction_rules=None,
        domain_module=None,
    ):
        precision = "fp32" if str(precision).lower() == "fp32" else "int8"
        language = "auto" if str(language).lower() == "auto" else "zh"
        corrections = bool(corrections)
        with self.lock:
            if correction_rules is not None:
                self.correction_engine = CorrectionEngine(replacements=correction_rules)
            if domain_module is not None:
                normalized_module = str(domain_module or "general").strip()
                if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,63}", normalized_module):
                    raise ValueError("invalid domain_module id")
                self.domain_module = normalized_module
            reloaded = self.recognizer is None or precision != self.precision or language != self.language
            if reloaded:
                model_name = "model.onnx" if precision == "fp32" else "model.int8.onnx"
                model = self.model_dir / model_name
                if not model.is_file():
                    raise FileNotFoundError(f"SenseVoice model is missing: {model}")
                started = time.perf_counter()
                recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                    model=str(model),
                    tokens=str(self.tokens),
                    num_threads=6,
                    sample_rate=16000,
                    provider="cpu",
                    language=language,
                    use_itn=True,
                )
                self.recognizer = recognizer
                self.precision = precision
                self.language = language
                self.load_ms = round((time.perf_counter() - started) * 1000, 1)
            self.corrections_enabled = corrections
            return {
                "status": "ready",
                "engine": self.engine_label,
                "precision": self.precision,
                "language": self.language,
                "corrections": self.corrections_enabled,
                "correction_rules": len(self.correction_engine.rules),
                "domain_module": self.domain_module,
                "vad": self.vad is not None,
                "streaming": self.streamer is not None,
                "stream_engine": self.streamer.model_name if self.streamer else "",
                "stream_load_ms": self.streamer.load_ms if self.streamer else 0,
                "streaming_error": self.streaming_error,
                "reloaded": reloaded,
                "load_ms": self.load_ms,
            }

    @property
    def engine_label(self):
        language = "中文" if self.language == "zh" else "自动语言"
        return f"SenseVoice {self.precision.upper()} · {language} · Silero VAD"

    def health(self):
        with self.lock:
            return {
                "status": "ready",
                "engine": self.engine_label,
                "precision": self.precision,
                "language": self.language,
                "corrections": self.corrections_enabled,
                "correction_rules": len(self.correction_engine.rules),
                "domain_module": self.domain_module,
                "vad": self.vad is not None,
                "streaming": self.streamer is not None,
                "stream_engine": self.streamer.model_name if self.streamer else "",
                "stream_load_ms": self.streamer.load_ms if self.streamer else 0,
                "streaming_error": self.streaming_error,
                "load_ms": self.load_ms,
            }

    def stream(self, session_id, pcm, sample_rate, is_final=False):
        if self.streamer is None:
            return {
                "text": "",
                "final": bool(is_final),
                "available": False,
                "error": self.streaming_error or "FunASR streaming is not installed",
            }
        result = self.streamer.accept(session_id, pcm, sample_rate, is_final)
        if self.corrections_enabled and result["text"]:
            result["text"], result["corrections"] = self.correction_engine.apply(result["text"])
        result["available"] = True
        return result

    def _speech_only(self, samples, sample_rate):
        if self.vad is None or sample_rate != 16000:
            return samples, 0.0, 1 if samples.size else 0
        started = time.perf_counter()
        self.vad.reset()
        window_size = self.vad.config.silero_vad.window_size
        for offset in range(0, samples.size, window_size):
            chunk = samples[offset : offset + window_size]
            if chunk.size < window_size:
                chunk = np.pad(chunk, (0, window_size - chunk.size))
            self.vad.accept_waveform(chunk)
        self.vad.flush()
        segments = []
        while not self.vad.empty():
            segment = np.asarray(self.vad.front.samples, dtype=np.float32)
            if segment.size:
                segments.append(segment.copy())
            self.vad.pop()
        self.vad.reset()
        vad_ms = round((time.perf_counter() - started) * 1000, 1)
        if not segments:
            return np.empty(0, dtype=np.float32), vad_ms, 0
        if len(segments) == 1:
            return segments[0], vad_ms, 1
        gap = np.zeros(round(sample_rate * 0.12), dtype=np.float32)
        joined = []
        for index, segment in enumerate(segments):
            if index:
                joined.append(gap)
            joined.append(segment)
        return np.concatenate(joined), vad_ms, len(segments)

    def transcribe(self, pcm, sample_rate):
        if len(pcm) % 2:
            pcm = pcm[:-1]
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        audio_ms = round(samples.size * 1000 / sample_rate, 1)
        if samples.size < max(1600, sample_rate // 10):
            return {"text": "", "raw_text": "", "inference_ms": 0, "vad_ms": 0, "audio_ms": audio_ms}

        with self.lock:
            speech, vad_ms, segments = self._speech_only(samples, sample_rate)
            speech_ms = round(speech.size * 1000 / sample_rate, 1)
            if speech.size < max(1600, sample_rate // 10):
                return {
                    "text": "",
                    "raw_text": "",
                    "inference_ms": 0,
                    "vad_ms": vad_ms,
                    "audio_ms": audio_ms,
                    "speech_ms": speech_ms,
                    "segments": segments,
                    "precision": self.precision,
                    "language": self.language,
                    "corrections": [],
                }
            stream = self.recognizer.create_stream()
            stream.accept_waveform(sample_rate, speech)
            started = time.perf_counter()
            self.recognizer.decode_stream(stream)
            inference_ms = round((time.perf_counter() - started) * 1000, 1)
            raw_text = stream.result.text.strip()
            if self.corrections_enabled:
                text, changes = self.correction_engine.apply(raw_text)
            else:
                text, changes = raw_text, []
            return {
                "text": text,
                "raw_text": raw_text,
                "inference_ms": inference_ms,
                "vad_ms": vad_ms,
                "audio_ms": audio_ms,
                "speech_ms": speech_ms,
                "segments": segments,
                "precision": self.precision,
                "language": self.language,
                "corrections": changes,
            }


class Handler(BaseHTTPRequestHandler):
    server_version = "OnlineMeetingInterviewAssistantASR/1.0.0"

    def send_json(self, status, value):
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self, limit=65536):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > limit:
            raise ValueError("invalid JSON payload length")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(200, self.server.asr_app.health())

    def do_POST(self):
        try:
            if self.path == "/configure":
                payload = self.read_json(limit=512 * 1024)
                result = self.server.asr_app.configure(
                    precision=payload.get("precision", "int8"),
                    language=payload.get("language", "zh"),
                    corrections=payload.get("corrections", True),
                    correction_rules=payload.get("correction_rules") if "correction_rules" in payload else None,
                    domain_module=payload.get("domain_module") if "domain_module" in payload else None,
                )
                self.send_json(200, result)
                return
            if self.path == "/stream":
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 1024 * 1024:
                    self.send_json(400, {"error": "invalid streaming PCM payload length"})
                    return
                sample_rate = int(self.headers.get("X-Sample-Rate", "16000"))
                session_id = self.headers.get("X-Stream-Id", "")
                is_final = self.headers.get("X-Stream-Final", "0") == "1"
                result = self.server.asr_app.stream(
                    session_id,
                    self.rfile.read(length) if length else b"",
                    sample_rate,
                    is_final,
                )
                self.send_json(200, result)
                return
            if self.path != "/transcribe":
                self.send_json(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4 * 1024 * 1024:
                self.send_json(400, {"error": "invalid PCM payload length"})
                return
            sample_rate = int(self.headers.get("X-Sample-Rate", "16000"))
            if sample_rate < 8000 or sample_rate > 48000:
                self.send_json(400, {"error": "invalid sample rate"})
                return
            self.send_json(200, self.server.asr_app.transcribe(self.rfile.read(length), sample_rate))
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def log_message(self, format, *args):
        return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--vad-model")
    parser.add_argument("--corrections")
    parser.add_argument("--stream-model", default="")
    parser.add_argument("--stream-device", default="cpu")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    application = AsrApplication(
        args.model_dir,
        args.vad_model,
        args.corrections,
        args.stream_model,
        args.stream_device,
    )
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.asr_app = application
    print(json.dumps(application.health(), ensure_ascii=False), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
