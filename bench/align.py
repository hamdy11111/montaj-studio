"""Where every part of a published edit came from in the raw footage (Phase 0 of PLAN_editor_and_graphics.md).

The published video's sound is matched against the raw files' sound, window by window (log-mel features,
normalised cross-correlation computed with one FFT per window over all raw files at once), then consecutive windows
with the same offset are joined into segments. From that: which raw parts were kept, in what order (Kendall tau
against the raw chronology), whether the opening is a flash-forward, and what share of the raw survived.

    python bench/align.py --ffmpeg <ffmpeg.exe> --published <video> --raw <video> [--raw <video> ...] --out <file.json>

Music, sound effects or graphics without the original sound make windows that match nothing; they are reported as
"unmatched", never forced onto the raw.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

SR = 16000
HOP = 800          # 0.05 s
WIN_SEC = 3.0      # matching window
STEP_SEC = 1.0     # window step
MIN_CONF = 0.55    # normalised correlation below this = no match


def audio(ffmpeg, path):
    fd, tmp = tempfile.mkstemp(suffix=".f32")
    os.close(fd)
    try:
        subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", tmp], check=True)
        return np.fromfile(tmp, dtype=np.float32)
    finally:
        os.remove(tmp)


def features(x):
    import librosa
    m = librosa.feature.melspectrogram(y=x, sr=SR, n_fft=1024, hop_length=HOP, n_mels=40, fmin=80, fmax=7600)
    f = np.log(m + 1e-6)
    f = (f - f.mean(axis=1, keepdims=True)) / (f.std(axis=1, keepdims=True) + 1e-6)
    return f.astype(np.float32)  # bands × frames


def match(pub, raw):
    """For every window of the published features: (best raw frame, normalised correlation)."""
    B, N = raw.shape
    w = int(WIN_SEC * SR / HOP)
    step = int(STEP_SEC * SR / HOP)
    size = 1 << int(np.ceil(np.log2(N + w)))
    R = np.fft.rfft(raw, n=size, axis=1)
    # Sliding energy of the raw over w frames, all bands.
    e = np.concatenate([[0.0], np.cumsum((raw.astype(np.float64) ** 2).sum(axis=0))])
    energy = np.sqrt(np.maximum(e[w:] - e[:-w], 1e-9))
    out = []
    for s in range(0, pub.shape[1] - w + 1, step):
        win = pub[:, s:s + w]
        win = win - win.mean(axis=1, keepdims=True)
        nrm = np.sqrt((win.astype(np.float64) ** 2).sum())
        if nrm < 1e-6:
            out.append((s, -1, 0.0, 0.0))
            continue
        W = np.fft.rfft(win[:, ::-1], n=size, axis=1)
        corr = np.fft.irfft((R * W).sum(axis=0), n=size)[w - 1:w - 1 + N - w + 1]
        score = corr / (energy[:len(corr)] * nrm)
        k = int(np.argmax(score))
        best = float(score[k])
        # How distinct the best match is: the next best peak away from it.
        lo, hi = max(0, k - w), min(len(score), k + w)
        rest = np.concatenate([score[:lo], score[hi:]])
        second = float(rest.max()) if rest.size else 0.0
        out.append((s, k, best, second))
    return out, w


def segments(matches, w, offsets, names):
    """Join consecutive windows that keep the same offset into segments."""
    sec = HOP / SR
    segs, cur = [], None
    for s, k, conf, second in matches:
        ok = k >= 0 and conf >= MIN_CONF and conf - second >= 0.05
        if not ok:
            if cur:
                segs.append(cur)
                cur = None
            continue
        delta = k - s
        if cur and abs(delta - cur["delta"]) <= 3 and s - cur["last"] <= int(STEP_SEC * SR / HOP) + 1:
            cur["last"], cur["end"] = s, s + w
            cur["conf"].append(conf)
        else:
            if cur:
                segs.append(cur)
            cur = {"delta": delta, "start": s, "end": s + w, "last": s, "conf": [conf]}
    if cur:
        segs.append(cur)
    # Windows are 3 s long, so neighbouring segments overlap by up to a window at a join: split the overlap in the
    # middle (the edit point lies there), moving the raw side by the same amount.
    for a, b in zip(segs, segs[1:]):
        if b["start"] < a["end"]:
            mid = (b["start"] + a["end"]) // 2
            a["end"] = mid
            b["start"] = mid
    result = []
    for g in segs:
        raw_start = g["start"] + g["delta"]
        fi = max(i for i, o in enumerate(offsets) if o <= raw_start)
        result.append({
            "pubStart": round(g["start"] * sec, 2), "pubEnd": round(g["end"] * sec, 2),
            "rawFile": fi, "rawName": names[fi],
            "rawStart": round((raw_start - offsets[fi]) * sec, 2), "rawEnd": round((raw_start - offsets[fi] + g["end"] - g["start"]) * sec, 2),
            "conf": round(float(np.mean(g["conf"])), 3),
        })
    return result


def kendall_tau(order):
    """Agreement of a sequence with its sorted order: 1 = same order, -1 = reversed."""
    n = len(order)
    if n < 2:
        return 1.0
    c = d = 0
    for i in range(n):
        for j in range(i + 1, n):
            if order[i] < order[j]:
                c += 1
            elif order[i] > order[j]:
                d += 1
    return (c - d) / max(1, c + d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--published", required=True)
    ap.add_argument("--raw", action="append", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    pub_x = audio(a.ffmpeg, a.published)
    raws = [audio(a.ffmpeg, r) for r in a.raw]
    names = [os.path.basename(r) for r in a.raw]
    feats = [features(x) for x in raws]
    gap = np.zeros((40, int(WIN_SEC * SR / HOP)), dtype=np.float32)  # a silent gap so no window spans two files
    offsets, parts, pos = [], [], 0
    for f in feats:
        offsets.append(pos)
        parts += [f, gap]
        pos += f.shape[1] + gap.shape[1]
    raw = np.concatenate(parts, axis=1)
    pub = features(pub_x)
    matches, w = match(pub, raw)
    segs = segments(matches, w, offsets, names)
    sec = HOP / SR
    pub_len = pub.shape[1] * sec
    raw_lens = [f.shape[1] * sec for f in feats]
    matched = sum(s["pubEnd"] - s["pubStart"] for s in segs)
    # Raw chronology = file order (as listed) then time inside the file.
    chrono = [s["rawFile"] * 1e6 + s["rawStart"] for s in segs]
    first = segs[0] if segs else None
    report = {
        "schema": "montaj-bench.align/1",
        "published": a.published, "raw": a.raw,
        "publishedSec": round(pub_len, 2), "rawSec": [round(x, 2) for x in raw_lens],
        "matchedSec": round(matched, 2), "matchedPct": round(100 * matched / max(pub_len, 1e-6), 1),
        "keptOfRawPct": round(100 * matched / max(sum(raw_lens), 1e-6), 1),
        "segments": segs,
        "orderTau": round(kendall_tau(chrono), 3),
        "openingFromRawPct": round(100 * (sum(raw_lens[:first["rawFile"]]) + first["rawStart"]) / max(sum(raw_lens), 1e-6), 1) if first else None,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: report[k] for k in ("matchedPct", "keptOfRawPct", "orderTau", "openingFromRawPct")}, ensure_ascii=False))
    print("segments", len(segs))


if __name__ == "__main__":
    sys.exit(main())
