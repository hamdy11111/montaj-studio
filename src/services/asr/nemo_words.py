# Word-level transcription with the Egyptian Arabic NeMo model (models/asr-egyptian-nemo-v2.0.nemo), the speech
# engine Montaj Studio ships with. Offline only: the model file lives next to this script and nothing is downloaded.
# The audio (16 kHz mono 16-bit WAV, extracted by the app) is split into pieces of at most ~30 s at the quietest
# point near each cut, so long videos fit in memory and no word is cut in half; word times are shifted back to the
# whole file. Prints one JSON object on stdout, the same shape as faster_whisper_words.py:
#   {"language", "duration", "device", "segments": [{start, end, text, words: [{start, end, word, p}]}]}
import argparse
import json
import os
import sys
import tempfile
import wave

MAX_PIECE_S = 30.0   # longest piece given to the model
MIN_PIECE_S = 18.0   # the cut is searched between MIN and MAX at the quietest 200 ms
FRAME_S = 0.01
SENTENCE_GAP_S = 0.6  # a silence this long between words starts a new segment
MAX_SEGMENT_WORDS = 14


def read_wav(file):
    with wave.open(file, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("expected 16-bit mono WAV")
        return w.getframerate(), w.readframes(w.getnframes())


def pieces(rate, pcm):
    """[(start_sample, end_sample)] covering the audio, each cut at the quietest 200 ms between MIN and MAX."""
    import numpy as np
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    n = len(x)
    hop = int(rate * FRAME_S)
    if n <= rate * MAX_PIECE_S:
        return [(0, n)]
    frames = n // hop
    env = np.sqrt(np.mean(x[: frames * hop].reshape(frames, hop) ** 2, axis=1))
    smooth = np.convolve(env, np.ones(20) / 20, mode="same")  # 200 ms: a pause, not a gap between two syllables
    out, start = [], 0
    while n - start > rate * MAX_PIECE_S:
        lo = (start + int(rate * MIN_PIECE_S)) // hop
        hi = min(frames - 1, (start + int(rate * MAX_PIECE_S)) // hop)
        cut = (lo + int(np.argmin(smooth[lo:hi]))) * hop if hi > lo else start + int(rate * MAX_PIECE_S)
        out.append((start, cut))
        start = cut
    out.append((start, n))
    return out


def segments_of(words):
    segs, cur = [], []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > SENTENCE_GAP_S or len(cur) >= MAX_SEGMENT_WORDS or cur[-1]["word"][-1:] in ".!?؟"):
            segs.append(cur)
            cur = []
        cur.append(w)
    if cur:
        segs.append(cur)
    return [{"start": s[0]["start"], "end": s[-1]["end"], "text": " ".join(w["word"] for w in s), "words": s} for s in segs]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "asr-egyptian-nemo-v2.0.nemo"))
    ap.add_argument("--device", default="auto")
    ap.add_argument("--check", action="store_true", help="only report whether the runtime and the model are usable")
    args = ap.parse_args()
    out = sys.stdout
    out.reconfigure(encoding="utf-8")
    sys.stdout = sys.stderr  # NeMo and Lightning print freely; only the JSON goes to the real stdout

    import logging
    logging.disable(logging.WARNING)
    import torch
    import nemo
    if args.check:
        json.dump({"nemo": nemo.__version__, "torch": torch.__version__, "cuda": torch.cuda.is_available(),
                   "model": os.path.isfile(args.model)}, out)
        return 0
    from nemo.collections.asr.models import ASRModel

    rate, pcm = read_wav(args.audio)
    spans = pieces(rate, pcm)
    tmp = tempfile.mkdtemp(prefix="nemo-")
    files = []
    for i, (a, b) in enumerate(spans):
        f = os.path.join(tmp, f"{i:04d}.wav")
        with wave.open(f, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm[a * 2: b * 2])
        files.append(f)

    # auto = the CPU: this small model transcribed 75 s of speech in 11 s on the CPU against 47 s on a busy RTX 4090
    # (CUDA start-up and memory shared with other apps cost more than they save); --device cuda asks for the GPU.
    devices = ["cpu"] if args.device == "auto" else [args.device] + ([] if args.device == "cpu" else ["cpu"])
    errors = []
    try:
        for device in devices:
            try:
                model = ASRModel.restore_from(args.model, map_location=device).eval()
                with torch.inference_mode():
                    hyps = model.transcribe(files, batch_size=4, timestamps=True, verbose=False)
                if isinstance(hyps, tuple):
                    hyps = hyps[0]
                words = []
                for (a, _), h in zip(spans, hyps):
                    off = a / rate
                    for w in (getattr(h, "timestamp", None) or {}).get("word", []):
                        text = str(w.get("word", "")).strip()
                        if text:
                            words.append({"start": round(off + float(w["start"]), 3), "end": round(off + float(w["end"]), 3), "word": text, "p": None})
                json.dump({"language": "ar", "duration": len(pcm) / 2 / rate, "device": device, "segments": segments_of(words)}, out, ensure_ascii=False)
                return 0
            except Exception as e:  # noqa: BLE001 — a full or missing GPU: report and try the next device
                errors.append(f"{device}: {type(e).__name__}: {e}")
                model = None
                if device == "cuda":
                    torch.cuda.empty_cache()
    finally:
        for f in files:
            try:
                os.remove(f)
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass
    sys.stderr.write("\n".join(errors))
    return 2


if __name__ == "__main__":
    sys.exit(main())
