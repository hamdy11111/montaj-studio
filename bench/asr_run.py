"""Run one speech model on every sentence clip of the reference transcription (Phase 0).

The model is loaded once; each clip (the same clips the user corrects in «اكتب الكلام») is transcribed and the text
written to hyp/<name>.json for bench/asr-score.mjs, with the real-time factor (seconds of transcription per second of
audio, model loading not counted), the loading time and the peak GPU memory the run added.

    python bench/asr_run.py --engine <name> --ffmpeg <ffmpeg> --dir <...\\النتائج\\الكتابة> [--model <file|folder>] [--name ...] [--limit N]

Engines (bench/asr_engines.py ENGINES; each runs with its own runtime\\<env> Python — bench/asr_all.py picks it):
    nemo      the app's Egyptian NeMo model (--model <file.nemo>)          runtime\\asr
    whisper   faster-whisper large-v3, the draft model: a sanity check     runtime\\dub
    qwencleo  QwenCleo-ASR                                                 runtime\\asr-qwen
    qwen3     Qwen3-ASR-1.7B, QwenCleo's base (rejected in the plan; the control)
    cohere    Cohere Transcribe Arabic 07-2026, NAMAA-Space int8 build     runtime\\asr-hf
    jais      IFM Jais-ASR (--model <folder>, default runtime\\models\\asr-ab\\Jais-ASR)
    voxtral   Mistral Voxtral Mini 4B Realtime Arabic (not in the plan; already in the cache)
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asr_engines import ENGINES, make  # noqa: E402

RUNTIME = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime")


def wavs(ffmpeg, folder, segments):
    tmp = tempfile.mkdtemp(prefix="asr-bench-")
    files = []
    for s in segments:
        f = os.path.join(tmp, f"{s['id']:04d}.wav")
        subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", os.path.join(folder, s["clip"]), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", f], check=True)
        files.append(f)
    return tmp, files


def gpu_used_mb():
    """Memory in use on the GPU right now (all processes; None without nvidia-smi)."""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        return int(r.stdout.strip().splitlines()[0])
    except Exception:
        return None


class PeakGpu:
    """Samples the GPU's used memory twice a second; peak − the value before loading = what this run added. Covers
    every library (ctranslate2 too), unlike torch's own counter, which is recorded beside it when torch is loaded."""

    def __init__(self):
        self.base = gpu_used_mb()
        self.peak = self.base
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._loop, daemon=True)

    def _loop(self):
        while not self._stop.wait(0.5):
            v = gpu_used_mb()
            if v is not None and (self.peak is None or v > self.peak):
                self.peak = v

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._t.join(timeout=5)

    def added(self):
        return None if self.base is None or self.peak is None else max(0, self.peak - self.base)


def torch_peak_mb():
    try:
        import torch
        return round(torch.cuda.max_memory_reserved() / 2 ** 20) if torch.cuda.is_available() else None
    except Exception:
        return None


def source(engine, model):
    """Where the weights came from: the cache snapshot (repo@commit), a local file or folder."""
    e = ENGINES[engine]
    if e.get("repo"):
        try:
            from asr_engines import snapshot_dir
            return f"{e['repo']}@{os.path.basename(snapshot_dir(e['repo']))}"
        except Exception:
            return e["repo"]
    if engine == "whisper":
        return "Systran/faster-whisper-large-v3"
    return os.path.abspath(model or os.path.join(RUNTIME, e.get("dir", "")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=sorted(ENGINES))
    ap.add_argument("--model")
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--name")
    ap.add_argument("--limit", type=int, help="first N clips only (a smoke test; not written to hyp/ unless --name is given)")
    a = ap.parse_args()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")          # weights come from the local cache only
    with open(os.path.join(a.dir, "segments.json"), encoding="utf-8") as f:
        segs = json.load(f)["segments"]
    if a.limit:
        segs = segs[: a.limit]
    tmp, files = wavs(os.path.abspath(a.ffmpeg), a.dir, segs)
    try:
        eng = make(a.engine, RUNTIME, a.model)
        with PeakGpu() as gpu:
            t0 = time.time()
            eng.load()
            t1 = time.time()
            texts = eng.transcribe(files)
            t2 = time.time()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    audio = sum(s["end"] - s["start"] for s in segs)
    name = a.name or (a.engine if not a.limit else f"_smoke-{a.engine}")
    out = {"model": name, "engine": a.engine, "label": ENGINES[a.engine]["label"], "plan": ENGINES[a.engine]["plan"],
           "source": source(a.engine, a.model), "device": getattr(eng, "device", None),
           "rtf": round((t2 - t1) / max(audio, 1e-6), 3), "loadSeconds": round(t1 - t0, 1), "audioSeconds": round(audio, 1),
           "vramMB": gpu.added(), "torchPeakMB": torch_peak_mb(), "ranAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "segments": [{"id": s["id"], "text": t} for s, t in zip(segs, texts)]}
    folder = os.path.join(a.dir, "hyp") if not a.limit or a.name else tempfile.gettempdir()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"{name}: {len(texts)} sentences, {t2 - t1:.1f} s for {audio:.0f} s of audio on {out['device']} "
          f"(load {t1 - t0:.0f} s, +{out['vramMB']} MB GPU) → {path}")


if __name__ == "__main__":
    sys.exit(main())
