# Which parts of the raw footage a published video used — matched by sound (Phase 5: learning the user's take picks).
#
#     python -X utf8 fingerprint.py --job <job.json> --out <result.json>
#
# job: { published, raw: [paths], ffmpeg, binS (0.25), minVotes (6) }
# result: { published: {path, duration}, matches: [{ raw, segments: [{ p0, p1, r0, r1, votes }] }], ms }
#   p0/p1: seconds in the published video, r0/r1: the same sound in that raw file (offset constant inside a segment).
#
# Method: landmark ("constellation") fingerprints — spectral peaks of 8 kHz audio, paired anchor → target within a
# short window, hash = (f1, f2, Δt); a published second that shares many hashes with the raw at ONE time offset is that
# raw second (music, captions and sound effects added over it only remove some hashes). Offsets are first found per 4 s
# window (1 s hop), then every 0.25 s bin of the published sound is given to the offset its own hashes agree with, so
# segment edges land within about a quarter second — enough to tell which take of a line was kept.
import os
import subprocess
import sys
import time
from collections import defaultdict, Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tcommon import args, progress, write  # noqa: E402

SR, NFFT, HOP = 8000, 1024, 256
FPS = SR / HOP  # frames per second (31.25)


def audio(ffmpeg, path):
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def peaks(x, per_sec=30):
    from scipy.ndimage import maximum_filter
    if len(x) < NFFT:
        return np.zeros((0, 2), np.int32)
    win = np.hanning(NFFT).astype(np.float32)
    n = 1 + (len(x) - NFFT) // HOP
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * win, axis=1)).T  # (freq, time)
    S = 20 * np.log10(S + 1e-6)
    S = S[8:400]  # 62 Hz … 3.1 kHz: where speech is, little hum
    mx = maximum_filter(S, size=(21, 13), mode="constant", cval=-1e9)
    f, t = np.nonzero((S == mx) & (S > np.median(S) + 10))
    if not len(t):
        return np.zeros((0, 2), np.int32)
    amp = S[f, t]
    keep = []
    for sec in range(int(t.max() / FPS) + 1):  # strongest peaks per second only, so loud and quiet passages weigh alike
        m = np.nonzero((t >= sec * FPS) & (t < (sec + 1) * FPS))[0]
        keep.extend(m[np.argsort(-amp[m])[:per_sec]])
    keep = np.array(sorted(keep, key=lambda i: (t[i], f[i])), np.int64)
    return np.stack([t[keep], f[keep] + 8], 1).astype(np.int32)


def hashes(pk, fan=8, dt_max=48, df_max=120):
    """[(hash, t_anchor)] from peaks [(t, f)] sorted by time."""
    out = []
    n = len(pk)
    for i in range(n):
        t1, f1 = pk[i]
        c = 0
        for j in range(i + 1, n):
            t2, f2 = pk[j]
            dt = t2 - t1
            if dt <= 0:
                continue
            if dt > dt_max or c >= fan:
                break
            if abs(int(f2) - int(f1)) > df_max:
                continue
            out.append((((int(f1) & 1023) << 20) | ((int(f2) & 1023) << 10) | (int(dt) & 1023), int(t1)))
            c += 1
    return out


def main():
    job, out = args()
    t_start = time.time()
    ff = job["ffmpeg"]
    bin_s = float(job.get("binS") or 0.25)
    min_votes = int(job.get("minVotes") or 6)
    index = defaultdict(list)  # hash -> [(raw index, frame)]
    raws = job["raw"]
    for k, r in enumerate(raws):
        for h, t in hashes(peaks(audio(ff, r))):
            index[h].append((k, t))
        progress(0.5 * (k + 1) / len(raws), f"raw {k + 1}/{len(raws)}")
    pub = audio(ff, job["published"])
    ph = hashes(peaks(pub))
    pdur = len(pub) / SR
    # 1) candidate offsets per 4 s window (1 s hop)
    by_frame = defaultdict(list)
    for h, t in ph:
        by_frame[t].append(h)
    cands = set()
    W = int(4 * FPS)
    for w0 in range(0, max(1, int(pdur * FPS) - W + 1), int(FPS)):
        votes = Counter()
        for t in range(w0, w0 + W):
            for h in by_frame.get(t, ()):
                for k, rt in index.get(h, ()):
                    votes[(k, rt - t)] += 1
        if votes:
            (k, off), v = votes.most_common(1)[0]
            if v >= min_votes * 2:
                cands.add((k, off))
    # 2) each 0.25 s bin of the published sound → the candidate offset its own hashes agree with (± 1 frame)
    B = max(1, int(round(bin_s * FPS)))
    nb = int(np.ceil(pdur * FPS / B))
    assign = [None] * nb
    for b in range(nb):
        votes = Counter()
        for t in range(b * B, (b + 1) * B):
            for h in by_frame.get(t, ()):
                for k, rt in index.get(h, ()):
                    off = rt - t
                    for d in (-1, 0, 1):
                        if (k, off + d) in cands:
                            votes[(k, off + d)] += 1
        if votes:
            key, v = votes.most_common(1)[0]
            if v >= 2:
                assign[b] = (key, v)
        progress(0.5 + 0.5 * (b + 1) / nb)
    # 3) runs of bins with the same raw + offset (a gap of one empty bin is bridged) → segments
    segs = defaultdict(list)
    b = 0
    while b < nb:
        if assign[b] is None:
            b += 1
            continue
        key, v0 = assign[b]
        e, votes = b, v0
        while e + 1 < nb and (assign[e + 1] and assign[e + 1][0] == key or (assign[e + 1] is None and e + 2 < nb and assign[e + 2] and assign[e + 2][0] == key)):
            e += 1
            votes += assign[e][1] if assign[e] else 0
        k, off = key
        p0, p1 = b * B / FPS, min(pdur, (e + 1) * B / FPS)
        if votes >= min_votes:
            segs[k].append({"p0": round(p0, 3), "p1": round(p1, 3), "r0": round(p0 + off / FPS, 3), "r1": round(p1 + off / FPS, 3), "votes": int(votes)})
        b = e + 1
    write(out, {"published": {"path": job["published"], "duration": round(pdur, 3)}, "binS": B / FPS,
                "matches": [{"raw": raws[k], "segments": segs[k]} for k in range(len(raws))], "ms": int((time.time() - t_start) * 1000)})


if __name__ == "__main__":
    main()
