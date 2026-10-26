"""Run one speech model on every sentence clip of the reference transcription (Phase 0).

The model is loaded once; each clip (the same clips the user corrects in «اكتب الكلام») is transcribed and the text
written to hyp/<name>.json for bench/asr-score.mjs, with the real-time factor (seconds of work per second of audio).

    python bench/asr_run.py --engine nemo --model <file.nemo> --ffmpeg <ffmpeg> --dir <...\\النتائج\\الكتابة> [--name ...]
    python bench/asr_run.py --engine whisper --ffmpeg <ffmpeg> --dir <...>        (the draft model: a sanity check only)

Engines for the challengers (QwenCleo-ASR, Cohere Transcribe Arabic) are added here once their environments exist.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time


def wavs(ffmpeg, folder, segments):
    tmp = tempfile.mkdtemp(prefix="asr-bench-")
    files = []
    for s in segments:
        f = os.path.join(tmp, f"{s['id']:04d}.wav")
        subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", os.path.join(folder, s["clip"]), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", f], check=True)
        files.append(f)
    return tmp, files


def run_nemo(files, model_path):
    import torch
    from nemo.collections.asr.models import ASRModel
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ASRModel.restore_from(model_path, map_location=device).eval()
    out = []
    with torch.inference_mode():
        for g in range(0, len(files), 8):
            part = model.transcribe(files[g:g + 8], batch_size=4, verbose=False)
            part = part[0] if isinstance(part, tuple) else part
            out.extend([getattr(h, "text", h) for h in part])
    return out, device


def run_whisper(files):
    try:
        import torch  # noqa: F401 — the CUDA libraries for ctranslate2 on Windows
    except ImportError:
        pass
    from faster_whisper import WhisperModel
    import ctranslate2
    dev = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    model = WhisperModel("large-v3", device=dev, compute_type="float16" if dev == "cuda" else "int8")
    out = []
    for f in files:
        parts, _ = model.transcribe(f, language="ar", beam_size=5, condition_on_previous_text=False)
        out.append(" ".join(p.text.strip() for p in parts))
    return out, dev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=["nemo", "whisper"])
    ap.add_argument("--model")
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--name")
    a = ap.parse_args()
    with open(os.path.join(a.dir, "segments.json"), encoding="utf-8") as f:
        segs = json.load(f)["segments"]
    tmp, files = wavs(a.ffmpeg, a.dir, segs)
    try:
        t0 = time.time()
        texts, device = run_nemo(files, a.model) if a.engine == "nemo" else run_whisper(files)
        took = time.time() - t0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    audio = sum(s["end"] - s["start"] for s in segs)
    name = a.name or a.engine
    os.makedirs(os.path.join(a.dir, "hyp"), exist_ok=True)
    with open(os.path.join(a.dir, "hyp", f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump({"model": name, "engine": a.engine, "device": device, "rtf": round(took / max(audio, 1e-6), 3),
                   "segments": [{"id": s["id"], "text": t} for s, t in zip(segs, texts)]}, f, ensure_ascii=False, indent=1)
    print(f"{name}: {len(texts)} sentences, {took:.1f} s for {audio:.0f} s of audio on {device}")


if __name__ == "__main__":
    sys.exit(main())
