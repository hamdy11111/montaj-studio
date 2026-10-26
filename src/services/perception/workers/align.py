# Word boundaries from the sound itself: Arabic wav2vec2 (CTC, jonatasgrosman/wav2vec2-large-xlsr-53-arabic)
# force-aligns the letters of every transcribed word, sentence by sentence, the same method as the edit-hamdy skill
# (scripts/_asr.py · 57_align.py). Whatever speech model wrote the words (NeMo today, the phase-0 winner tomorrow),
# their times come from here. Runs in the speech runtime (runtime/asr: torch + transformers + torchaudio).
#
# job: {audio, modelsDir, asr: {segments: [{start, end, words: [{start, end, word}]}]}, pad, maxShift, maxShiftSure,
#       sureConf, minConf}
# result: {model, device, words: [{start, end, word, asr_start, asr_end, align_conf, aligned}], moved, kept}
#
# A word moves only when the alignment is confident (≥ minConf) and the move is small (≤ maxShift, or ≤ maxShiftSure
# when ≥ sureConf: a first word after a long pause); otherwise it keeps the speech model's time. Order is kept and
# two words never overlap.
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402

MODEL = "jonatasgrosman/wav2vec2-large-xlsr-53-arabic"


def load(models_dir, dev):
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    local = os.path.join(models_dir, "wav2vec2-large-xlsr-53-arabic")
    src = local if os.path.isdir(local) else MODEL
    p = Wav2Vec2Processor.from_pretrained(src)
    m = Wav2Vec2ForCTC.from_pretrained(src).to(dev).eval()
    return p, m


def clean(w, vocab):
    w = re.sub(r"[ً-ْـٰ]", "", w or "")  # tashkeel, tatweel, dagger alef
    return "".join(ch for ch in w if ch in vocab)


def align(p, m, dev, audio, words, t0):
    """[(start, end, conf) or None] per word, in file time. conf = mean letter probability (0–1)."""
    import numpy as np
    import torch
    import torchaudio.functional as F
    vocab = p.tokenizer.get_vocab()
    sep = p.tokenizer.word_delimiter_token or "|"
    ids, owner = [], []
    for k, w in enumerate(clean(w, vocab) for w in words):
        if not w:
            continue
        if ids and sep in vocab:
            ids.append(vocab[sep])
            owner.append(-1)
        for ch in w:
            ids.append(vocab[ch])
            owner.append(k)
    if not ids or len(audio) < 1600:
        return [None] * len(words)
    x = p(audio, sampling_rate=16000, return_tensors="pt").input_values.to(dev)
    with torch.inference_mode():
        lp = torch.log_softmax(m(x).logits, -1).float().cpu()
    if lp.shape[1] < len(ids):
        return [None] * len(words)
    al, sc = F.forced_align(lp, torch.tensor([ids], dtype=torch.int32), blank=p.tokenizer.pad_token_id)
    al, sc = al[0].tolist(), sc[0].exp().tolist()
    fdur = len(audio) / 16000 / lp.shape[1]
    spans, j, prev = {}, -1, None
    for fi, (tok, s) in enumerate(zip(al, sc)):
        if tok == p.tokenizer.pad_token_id:
            prev = None
            continue
        if tok != prev:
            j += 1
        prev = tok
        if j < len(owner) and owner[j] >= 0:
            a = spans.setdefault(owner[j], [fi, fi, []])
            a[1] = fi
            a[2].append(s)
    out = []
    for k in range(len(words)):
        if k not in spans:
            out.append(None)
            continue
        f0, f1, ss = spans[k]
        out.append((round(t0 + f0 * fdur, 3), round(t0 + (f1 + 1) * fdur, 3), round(float(np.mean(ss)), 3)))
    return out


def main():
    job, out = pc.args()
    T = pc.Timer()
    dev = pc.device(job)
    X = pc.read_wav16(job["audio"])
    dur = len(X) / 16000
    segs = [s for s in job["asr"]["segments"] if s.get("words")]
    pad = float(job.get("pad", 0.3))
    mx, mxs = float(job.get("maxShift", 1.0)), float(job.get("maxShiftSure", 2.5))
    sure, minc = float(job.get("sureConf", 0.8)), float(job.get("minConf", 0.3))
    p, m = load(pc.models_dir(job), dev)
    T.mark("load")
    words, moved, kept = [], 0, 0
    for i, s in enumerate(segs):
        ws = s["words"]
        lo = float(segs[i - 1]["words"][-1]["end"]) if i else 0.0
        hi = float(segs[i + 1]["words"][0]["start"]) if i + 1 < len(segs) else dur
        a0 = max(lo, float(ws[0]["start"]) - pad)
        a1 = min(hi, float(ws[-1]["end"]) + pad)
        res = align(p, m, dev, X[int(a0 * 16000):int(a1 * 16000)], [w["word"] for w in ws], a0) if a1 - a0 >= 0.15 else [None] * len(ws)
        prev_e = lo
        for k, (w, r) in enumerate(zip(ws, res)):
            s0, e0 = float(w["start"]), float(w["end"])
            rec = {"start": s0, "end": e0, "word": w["word"], "asr_start": s0, "asr_end": e0, "align_conf": None, "aligned": False}
            if r is not None:
                ns, ne, cf = r
                rec["align_conf"] = cf
                lim = mxs if cf >= sure else mx
                if cf >= minc and abs(ns - s0) <= lim and abs(ne - e0) <= lim:
                    ns = max(ns, prev_e)
                    ne = max(ne, ns + 0.02)
                    if k + 1 < len(ws):  # never into the next word (at its new time when that one moves too)
                        nr = res[k + 1]
                        nxt = nr[0] if nr and nr[2] >= minc else float(ws[k + 1]["start"])
                        ne = min(ne, max(nxt, ns + 0.02))
                    rec.update(start=round(ns, 3), end=round(ne, 3), aligned=True)
            if rec["aligned"]:
                moved += 1
            else:
                kept += 1
            prev_e = max(prev_e, rec["end"])
            words.append(rec)
        pc.progress((i + 1) / max(1, len(segs)))
    T.mark("align")
    pc.write(out, {"model": MODEL, "device": dev, "words": words, "moved": moved, "kept": kept,
                   "vram_peak_mb": pc.torch_peak_mb(), "timing": T.parts})


if __name__ == "__main__":
    main()
