import argparse
import hashlib
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

MODEL_URL = (
    "https://modelscope.cn/api/v1/models/iic/"
    "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online/"
    "repo?Revision=master&FilePath=model.pt"
)
MODEL_SIZE = 880_716_041
MODEL_SHA256 = "4fdfb48ed4471777c9a511e96a2acae17f77cac9d709cc756634622769192a64"


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(8 * 1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def clean_stale_downloads(destination):
    destination.with_suffix(".pt.incomplete").unlink(missing_ok=True)
    for stale_part in destination.parent.glob(f"{destination.name}_*_*"):
        stale_part.unlink(missing_ok=True)


def download_part(index, start, end, part_path, progress, lock):
    expected = end - start + 1
    for attempt in range(1, 11):
        existing = part_path.stat().st_size if part_path.exists() else 0
        if existing == expected:
            return part_path
        if existing > expected:
            part_path.unlink()
            existing = 0
        try:
            with part_path.open("ab") as output:
                completed = subprocess.run(
                    [
                        "curl.exe",
                        "-L",
                        "--fail",
                        "--silent",
                        "--show-error",
                        "--connect-timeout",
                        "20",
                        "--max-time",
                        "900",
                        "--range",
                        f"{start + existing}-{end}",
                        "--user-agent",
                        "OnlineMeetingInterviewAssistant/1.0.0",
                        "--output",
                        "-",
                        MODEL_URL,
                    ],
                    stdout=output,
                    check=False,
                )
            with lock:
                progress[index] = min(part_path.stat().st_size, expected)
            if completed.returncode != 0:
                raise RuntimeError(f"curl exited with code {completed.returncode}")
            if part_path.stat().st_size == expected:
                return part_path
        except Exception as error:
            if attempt == 10:
                raise RuntimeError(f"part {index + 1} failed after 10 attempts: {error}") from error
            time.sleep(min(2 ** (attempt - 1), 20))
    raise RuntimeError(f"part {index + 1} is incomplete")


def report_progress(part_paths, total, stop_event):
    while not stop_event.wait(5):
        downloaded = sum(path.stat().st_size for path in part_paths if path.exists())
        print(f"FunASR model: {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    destination = Path(args.destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and destination.stat().st_size == MODEL_SIZE:
        if sha256_file(destination) == MODEL_SHA256:
            clean_stale_downloads(destination)
            print("FunASR streaming model already verified.", flush=True)
            return

    workers = max(1, min(args.workers, 16))
    parts_dir = destination.with_suffix(".parts")
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_size = (MODEL_SIZE + workers - 1) // workers
    jobs = []
    progress = []
    lock = threading.Lock()
    for index in range(workers):
        start = index * part_size
        end = min(MODEL_SIZE - 1, start + part_size - 1)
        part_path = parts_dir / f"part-{index:02d}"
        existing = min(part_path.stat().st_size, end - start + 1) if part_path.exists() else 0
        progress.append(existing)
        jobs.append((index, start, end, part_path))

    stop_event = threading.Event()
    reporter = threading.Thread(
        target=report_progress,
        args=([job[3] for job in jobs], MODEL_SIZE, stop_event),
        daemon=True,
    )
    reporter.start()
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [
                executor.submit(download_part, index, start, end, part_path, progress, lock)
                for index, start, end, part_path in jobs
            ]
            for future in as_completed(futures):
                future.result()
    finally:
        stop_event.set()
        reporter.join(timeout=1)

    merging = destination.with_suffix(".merging")
    digest = hashlib.sha256()
    with merging.open("wb") as output:
        for _index, _start, _end, part_path in jobs:
            with part_path.open("rb") as source:
                while True:
                    chunk = source.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    digest.update(chunk)
    if merging.stat().st_size != MODEL_SIZE:
        raise RuntimeError(f"merged model has unexpected size: {merging.stat().st_size}")
    if digest.hexdigest() != MODEL_SHA256:
        raise RuntimeError("FunASR model SHA256 mismatch")
    os.replace(merging, destination)
    shutil.rmtree(parts_dir)
    clean_stale_downloads(destination)
    print(f"FunASR model verified: {destination}", flush=True)


if __name__ == "__main__":
    main()
