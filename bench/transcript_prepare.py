"""Prepare the reference-transcription page (Phase 0 of PLAN_editor_and_graphics.md).

Whisper large-v3 (local, offline) splits each file into sentences and writes a first draft the user corrects —
correcting is much faster than typing from nothing. Whisper is NOT one of the compared models, so the draft does not
favour any contender. Every sentence becomes a short clip; the page plays them one by one.

    python bench/transcript_prepare.py --ffmpeg <ffmpeg.exe> --out <folder> <media> [<media> ...]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("media", nargs="+")
    a = ap.parse_args()
    clips = os.path.join(a.out, "clips")
    os.makedirs(clips, exist_ok=True)
    try:
        import torch  # noqa: F401 — its lib folder holds the CUDA libraries (cublas) ctranslate2 needs on Windows
    except ImportError:
        pass
    from faster_whisper import WhisperModel
    import ctranslate2
    dev = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    model = WhisperModel("large-v3", device=dev, compute_type="float16" if dev == "cuda" else "int8")
    segs, n = [], 0
    for mi, media in enumerate(a.media):
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            subprocess.run([a.ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", media, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
            parts, _ = model.transcribe(wav, language="ar", beam_size=5, vad_filter=True,
                                        vad_parameters={"min_silence_duration_ms": 400}, condition_on_previous_text=False)
            for p in parts:
                if p.end - p.start < 0.4:
                    continue
                n += 1
                clip = f"{n:04d}.mp3"
                s0, s1 = max(0.0, p.start - 0.15), p.end + 0.15
                subprocess.run([a.ffmpeg, "-hide_banner", "-v", "error", "-y", "-ss", f"{s0:.2f}", "-to", f"{s1:.2f}", "-i", wav,
                                "-ac", "1", "-b:a", "64k", os.path.join(clips, clip)], check=True)
                segs.append({"id": n, "media": os.path.basename(media), "mediaIndex": mi, "start": round(s0, 2), "end": round(s1, 2),
                             "clip": f"clips/{clip}", "draft": p.text.strip()})
                print(f"{n}\t{p.start:.1f}\t{p.text.strip()[:60]}", flush=True)
        finally:
            os.remove(wav)
    data = {"schema": "montaj-bench.transcript/1", "id": os.path.basename(os.path.normpath(a.out)), "media": a.media, "segments": segs,
            "minutes": round(sum(s["end"] - s["start"] for s in segs) / 60, 1)}
    with open(os.path.join(a.out, "segments.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    # The page reads its data from a script (a JSON fetch is blocked on file:// pages).
    with open(os.path.join(a.out, "data.js"), "w", encoding="utf-8") as f:
        f.write("window.TRANSCRIPT = " + json.dumps(data, ensure_ascii=False) + ";\n")
    print("segments", len(segs), "minutes", data["minutes"])


if __name__ == "__main__":
    sys.exit(main())
