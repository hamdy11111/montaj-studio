# Sound events and laughter, with their times:
#   tags       PANNs Cnn14_DecisionLevelMax (AudioSet, 527 classes, a score every 10 ms): spans where a class stays
#              above the threshold (hysteresis), speech classes left out (the words stage covers speech)
#   laughter   laughter-detection (Gillick et al., ResNet on 8 kHz mel frames) merged with PANNs' laughter classes:
#              a span either model finds; both = higher confidence
#   loudness   short bursts well above the local level (a shout, a bang): RMS in dB against a 6 s rolling median
#   pitch      the voice jumping well above its local pitch (surprise, excitement): pYIN f0 against a 10 s median
#
# job: {audio, modelsDir, tagThreshold=0.3, laughThreshold=0.5}
# result: {tagModel, laughModel, tags: [{start, end, label, index, p}], laughter: [{start, end, p, sources, kind}],
#          loudness: [{start, end, db, above, p}], pitch: [{start, end, hz, ratio, p}]}
import math
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402

SPEECH = {"Speech", "Male speech, man speaking", "Female speech, woman speaking", "Child speech, kid speaking", "Conversation",
          "Narration, monologue", "Babbling", "Speech synthesizer", "Inside, small room", "Inside, large room or hall", "Silence"}
LAUGH = {"Laughter", "Baby laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle"}


def spans_of(prob, hop_s, hi, lo, min_s, gap_s):
    """Hysteresis spans of a 1-D probability track: start above `hi`, continue while above `lo`."""
    import numpy as np
    out, on, st = [], False, 0
    for i, v in enumerate(prob):
        if not on and v >= hi:
            on, st = True, i
            while st > 0 and prob[st - 1] >= lo:
                st -= 1
        elif on and v < lo:
            on = False
            out.append([st, i])
    if on:
        out.append([st, len(prob)])
    merged = []
    for a, b in out:
        if merged and (a - merged[-1][1]) * hop_s <= gap_s:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a * hop_s, b * hop_s, float(np.max(prob[a:b]))) for a, b in merged if (b - a) * hop_s >= min_s]


def panns(x16, md, dev, thr):
    import numpy as np
    import librosa
    import torch
    home = os.path.join(os.path.expanduser("~"), "panns_data")
    os.makedirs(home, exist_ok=True)
    csv = os.path.join(home, "class_labels_indices.csv")
    if not os.path.isfile(csv):  # panns_inference reads it at import (and would try wget without it)
        shutil.copy(os.path.join(md, "panns", "class_labels_indices.csv"), csv)
    from panns_inference.models import Cnn14_DecisionLevelMax
    from panns_inference.config import labels
    m = Cnn14_DecisionLevelMax(sample_rate=32000, window_size=1024, hop_size=320, mel_bins=64, fmin=50, fmax=14000, classes_num=527)
    ck = torch.load(os.path.join(md, "panns", "Cnn14_DecisionLevelMax_mAP=0.385.pth"), map_location="cpu", weights_only=False)
    m.load_state_dict(ck["model"])
    m.to(dev).eval()
    x = librosa.resample(x16, orig_sr=16000, target_sr=32000)
    hop = 320 / 32000
    win, ctx = 10 * 32000, 1 * 32000   # 10 s pieces with 1 s of context on each side (30 s pieces took ~8 GB)
    frames = int(math.ceil(len(x) / 320))
    out = np.zeros((frames, 527), np.float32)
    for a in range(0, len(x), win):
        lo, hi = max(0, a - ctx), min(len(x), a + win + ctx)
        with torch.inference_mode():
            fw = m(torch.from_numpy(x[lo:hi])[None].to(dev))["framewise_output"][0].float().cpu().numpy()
        f0 = (a - lo) // 320
        n = min(frames - a // 320, win // 320, len(fw) - f0)
        out[a // 320:a // 320 + n] = fw[f0:f0 + n]
        pc.progress(0.05 + 0.35 * min(1, (a + win) / len(x)))
    tags = []
    for k, name in enumerate(labels):
        col = out[:, k]
        if name in SPEECH or col.max() < thr:
            continue
        for s, e, p in spans_of(col, hop, thr, thr * 0.6, 0.2, 0.3):
            tags.append({"start": round(s, 3), "end": round(e, 3), "label": name, "index": k, "p": round(p, 3)})
    laugh_track = out[:, [i for i, n in enumerate(labels) if n in LAUGH]].max(axis=1)
    return tags, laugh_track, hop


def laughter_model(x16, md, dev, thr):
    """Frame-wise laughter probability (≈43 frames/s) from the Gillick et al. ResNet, and its frame hop."""
    import numpy as np
    import librosa
    import scipy.signal
    import torch
    sys.path.insert(0, os.path.join(md, "laughter-detection"))
    import models as lmodels  # the repo's models.py (ResNetBigger)
    m = lmodels.ResNetBigger(dropout_rate=0.0, linear_layer_size=128, filter_sizes=[128, 64, 32, 32])
    ck = torch.load(os.path.join(md, "laughter-detection", "checkpoints", "in_use", "resnet_with_augmentation", "best.pth.tar"), map_location="cpu", weights_only=False)
    m.load_state_dict(ck["state_dict"])
    m.to(dev).eval()
    y = librosa.resample(x16, orig_sr=16000, target_sr=8000)
    S = librosa.feature.melspectrogram(y=y, sr=8000, hop_length=186)
    S = librosa.amplitude_to_db(S, ref=np.max).T.astype(np.float32)  # (frames, 128)
    hop = 186 / 8000
    n = len(S)
    pad = np.pad(S, ((22, 22), (0, 0)), mode="edge")
    probs = np.zeros(n, np.float32)
    for a in range(0, n, 128):  # 512 windows at once took ~8 GB of activations
        b = min(n, a + 128)
        batch = np.stack([pad[i:i + 44] for i in range(a, b)])[:, None]
        with torch.inference_mode():
            probs[a:b] = m(torch.from_numpy(batch).to(dev)).float().cpu().numpy().reshape(-1)
        pc.progress(0.4 + 0.3 * b / n)
    # The authors' post-processing: a low-pass on the frame probabilities, then threshold and minimum length.
    if len(probs) > 12:
        b_, a_ = scipy.signal.butter(2, 0.01, btype="low")
        probs = scipy.signal.filtfilt(b_, a_, probs).astype(np.float32)
    return probs, hop


def loudness_spikes(x):
    import numpy as np
    import scipy.ndimage as nd
    hop, win = 160, 400
    n = 1 + max(0, (len(x) - win) // hop)
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(x[idx] ** 2, axis=1) + 1e-10)
    db = 20 * np.log10(rms + 1e-9)
    db = nd.uniform_filter1d(db, 10)
    base = nd.median_filter(db, size=600, mode="nearest")   # 6 s
    above = db - base
    hot = (above >= 8) & (db >= -30)
    out = []
    for s, e, p in spans_of(hot.astype(np.float32), hop / 16000, 0.5, 0.5, 0.12, 0.25):
        a, b = int(s * 100), int(e * 100)
        ex = float(above[a:b].max())
        out.append({"start": round(s, 3), "end": round(e, 3), "db": round(float(db[a:b].max()), 1), "above": round(ex, 1), "p": round(1 / (1 + math.exp(-(ex - 10) / 2)), 3)})
    return out


def pitch_spikes(x):
    import numpy as np
    import librosa
    import scipy.ndimage as nd
    f0, voiced, vp = librosa.pyin(x, fmin=70, fmax=600, sr=16000, frame_length=1024, hop_length=320)
    hop = 320 / 16000
    v = voiced & (vp > 0.5) & np.isfinite(f0)
    f = np.where(v, f0, np.nan)
    # Local voice level: median of the voiced frames over 10 s (NaN-aware, by a running window over the voiced ones).
    base = np.full(len(f), np.nan)
    W = int(5 / hop)
    vi = np.where(v)[0]
    if len(vi) < 20:
        return []
    vf = f[vi]
    for k in range(0, len(f), 10):
        lo, hi = np.searchsorted(vi, k - W), np.searchsorted(vi, k + W)
        if hi - lo >= 10:
            base[k:k + 10] = np.median(vf[lo:hi])
    ratio = f / base
    hot = np.nan_to_num(ratio, nan=0) >= 1.4
    hot = nd.binary_closing(hot, iterations=2)
    out = []
    for s, e, _ in spans_of(hot.astype(np.float32), hop, 0.5, 0.5, 0.2, 0.15):
        a, b = int(s / hop), int(e / hop)
        r = float(np.nanmax(ratio[a:b])) if np.isfinite(ratio[a:b]).any() else 1.4
        out.append({"start": round(s, 3), "end": round(e, 3), "hz": round(float(np.nanmax(f[a:b])), 1) if np.isfinite(f[a:b]).any() else None,
                    "ratio": round(r, 2), "p": round(min(1.0, (r - 1.2) / 0.8), 3)})
    return out


def main():
    job, out = pc.args()
    T = pc.Timer()
    import numpy as np
    dev = pc.device(job)
    md = pc.models_dir(job)
    x = pc.read_wav16(job["audio"])
    tags, p_laugh, hop_p = panns(x, md, dev, float(job.get("tagThreshold", 0.3)))
    T.mark("panns")
    thr = float(job.get("laughThreshold", 0.5))
    laugh, laugh_model = [], None
    try:
        p_l, hop_l = laughter_model(x, md, dev, thr)
        laugh_model = "laughter-detection (resnet_with_augmentation)"
        T.mark("laughter")
    except Exception as e:  # noqa: BLE001 — PANNs' laughter alone then
        pc.log("laughter-detection failed:", type(e).__name__, e)
        p_l, hop_l = None, None
    # The two laughter tracks on one 10 ms grid; a span from either, its sources and the better score.
    n = int(len(x) / 160)
    grid = np.arange(n) * 0.01
    a = np.interp(grid, np.arange(len(p_laugh)) * hop_p, p_laugh) if len(p_laugh) else np.zeros(n)
    b = np.interp(grid, np.arange(len(p_l)) * hop_l, p_l) if p_l is not None and len(p_l) else np.zeros(n)
    PT = 0.3  # PANNs' laughter classes count from here (its frame scores run lower than the dedicated model's)
    for s, e, _ in spans_of(np.maximum(a * thr / PT, b), 0.01, thr, thr * 0.8, 0.2, 0.3):
        i0, i1 = int(s * 100), int(e * 100)
        src, pa, pb = [], float(a[i0:i1].max()), float(b[i0:i1].max())
        if pb >= thr:
            src.append("laughter-detection")
        if pa >= PT:
            src.append("PANNs")
        p = max(pb, min(1.0, pa * thr / PT)) if len(src) == 1 else min(1.0, 0.5 + 0.5 * max(pa, pb))
        laugh.append({"start": round(s, 3), "end": round(e, 3), "p": round(p, 3), "sources": src or ["PANNs"]})
    T.mark("merge")
    pc.progress(0.75)
    loud = loudness_spikes(x)
    T.mark("loudness")
    pitch = pitch_spikes(x)
    T.mark("pitch")
    # The two laughter tracks on a 50 ms grid, so the thresholds can be tuned later without running the models again.
    track = {"hop": 0.05, "laughterDetection": [round(float(v), 2) for v in b[::5]], "panns": [round(float(v), 2) for v in a[::5]]}
    pc.write(out, {"model": "PANNs Cnn14_DecisionLevelMax + " + (laugh_model or "—"), "laughTrack": track, "tagModel": "PANNs Cnn14_DecisionLevelMax (AudioSet)", "laughModel": laugh_model,
                   "device": dev, "tags": tags, "laughter": laugh, "loudness": loud, "pitch": pitch, "vram_peak_mb": pc.torch_peak_mb(), "timing": T.parts})


if __name__ == "__main__":
    main()
