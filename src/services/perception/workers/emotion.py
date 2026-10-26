# The feeling of every utterance: emotion2vec+ large (FunASR; 9 classes: angry, disgusted, fearful, happy, neutral,
# other, sad, surprised, unknown). Trained mostly on acted and Chinese/English speech and never tested on Egyptian
# comedy, so the plan uses it only to COMPARE takes of the same line with each other, not as an absolute verdict.
#
# job: {audio, modelsDir, utterances: [{start, end, speaker, text}]}
# result: {model, device, utterances: [{start, end, speaker, label, p, scores: {label: p}}]}
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402


def main():
    job, out = pc.args()
    T = pc.Timer()
    import numpy as np
    from funasr import AutoModel
    dev = pc.device(job)
    m = AutoModel(model=os.path.join(pc.models_dir(job), "emotion2vec_plus_large"), hub="hf", device="cuda:0" if dev == "cuda" else "cpu", disable_update=True, disable_pbar=True, log_level="ERROR")
    T.mark("load")
    x = pc.read_wav16(job["audio"])
    res = []
    utt = job.get("utterances", [])
    for i, u in enumerate(utt):
        seg = x[int(u["start"] * 16000):int(u["end"] * 16000)]
        if len(seg) < 8000:
            continue
        r = m.generate(seg.astype(np.float32), granularity="utterance", extract_embedding=False)[0]
        labels = [str(l).split("/")[-1] for l in r["labels"]]
        scores = {l: round(float(s), 3) for l, s in zip(labels, r["scores"]) if l not in ("<unk>", "unk")}
        best = max(scores, key=scores.get)
        res.append({"start": u["start"], "end": u["end"], "speaker": u.get("speaker"), "label": best, "p": scores[best], "scores": scores})
        if i % 5 == 0:
            pc.progress((i + 1) / max(1, len(utt)))
    T.mark("classify")
    pc.write(out, {"model": "emotion2vec+ large", "device": dev, "utterances": res, "vram_peak_mb": pc.torch_peak_mb(), "timing": T.parts})


if __name__ == "__main__":
    main()
