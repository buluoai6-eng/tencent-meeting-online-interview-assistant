import argparse
import json
import time
import urllib.request
import wave
from pathlib import Path


def request_json(url, method="GET", body=None, headers=None, timeout=120):
    payload = body
    if isinstance(body, dict):
        payload = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", **(headers or {})}
    request = urllib.request.Request(url, data=payload, headers=headers or {}, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def read_wav(path):
    with wave.open(str(path), "rb") as source:
        assert source.getnchannels() == 1
        assert source.getsampwidth() == 2
        return source.getframerate(), source.readframes(source.getnframes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8766")
    parser.add_argument("--wav", required=True)
    args = parser.parse_args()

    module_corrections = Path(__file__).resolve().parents[1] / "src" / "domain-modules" / "finance-accounting" / "corrections.json"
    correction_rules = json.loads(module_corrections.read_text(encoding="utf-8"))["replacements"]

    sample_rate, pcm = read_wav(Path(args.wav))
    silence = b"\0\0" * round(sample_rate * 0.8)
    padded_pcm = silence + pcm + silence
    runs = []
    for precision, language in (("int8", "zh"), ("int8", "auto"), ("fp32", "zh")):
        config = request_json(
            f"{args.url}/configure",
            method="POST",
            body={
                "precision": precision,
                "language": language,
                "corrections": True,
                "domain_module": "finance-accounting",
                "correction_rules": correction_rules,
            },
        )
        started = time.perf_counter()
        result = request_json(
            f"{args.url}/transcribe",
            method="POST",
            body=padded_pcm,
            headers={"Content-Type": "application/octet-stream", "X-Sample-Rate": str(sample_rate)},
        )
        wall_ms = round((time.perf_counter() - started) * 1000, 1)
        assert result["text"], f"empty transcript for {precision}/{language}"
        assert result["speech_ms"] < result["audio_ms"], "VAD did not trim padded silence"
        runs.append({
            "precision": precision,
            "language": language,
            "raw_text": result["raw_text"],
            "text": result["text"],
            "corrections": result["corrections"],
            "load_ms": config["load_ms"],
            "vad_ms": result["vad_ms"],
            "inference_ms": result["inference_ms"],
            "wall_ms": wall_ms,
            "audio_ms": result["audio_ms"],
            "speech_ms": result["speech_ms"],
        })

    general_config = request_json(
        f"{args.url}/configure",
        method="POST",
        body={
            "precision": "int8",
            "language": "zh",
            "corrections": True,
            "domain_module": "general",
            "correction_rules": [],
        },
    )
    assert general_config["domain_module"] == "general"
    assert general_config["correction_rules"] == 0

    finance_config = request_json(
        f"{args.url}/configure",
        method="POST",
        body={
            "precision": "int8",
            "language": "zh",
            "corrections": True,
            "domain_module": "finance-accounting",
            "correction_rules": correction_rules,
        },
    )
    assert finance_config["domain_module"] == "finance-accounting"
    assert finance_config["correction_rules"] == len(correction_rules)

    silent_result = request_json(
        f"{args.url}/transcribe",
        method="POST",
        body=b"\0\0" * sample_rate,
        headers={"Content-Type": "application/octet-stream", "X-Sample-Rate": str(sample_rate)},
    )
    assert silent_result["text"] == ""
    assert silent_result["segments"] == 0

    print(json.dumps({
        "runs": runs,
        "silence_filtered": True,
        "domain_switch": {"general": 0, "finance-accounting": len(correction_rules)},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
