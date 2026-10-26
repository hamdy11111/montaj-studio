# Who speaks when: pyannote speaker-diarization-community-1 (pyannote.audio 4). Three views of the same run:
#   turns      the regular diarization (several speakers may be active at once)
#   exclusive  at most one speaker at a time — the one used to give every word its speaker
#   overlap    the regions where two or more speakers talk together (the cut avoids them, words there are "unsure")
# The number of speakers is free unless the job gives it (the model sometimes over/under-counts; a known count helps).
#
# job: {audio, modelsDir, numSpeakers?, minSpeakers?, maxSpeakers?}
# result: {model, device, turns: [{start, end, speaker}], exclusive: [...], overlap: [{start, end, speakers}],
#          speakers: [{id, seconds, embedding?}]}
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402

MODEL = "pyannote/speaker-diarization-community-1"


def spans(ann):
    out = []
    for seg, _, label in ann.itertracks(yield_label=True):
        out.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "speaker": str(label)})
    return sorted(out, key=lambda s: (s["start"], s["end"]))


def main():
    job, out = pc.args()
    T = pc.Timer()
    import numpy as np
    import torch
    from pyannote.audio import Pipeline
    dev = pc.device(job)
    pipe = Pipeline.from_pretrained(os.path.join(pc.models_dir(job), "pyannote-speaker-diarization-community-1"))
    pipe.to(torch.device(dev))
    T.mark("load")
    x = pc.read_wav16(job["audio"])
    kw = {k2: int(job[k1]) for k1, k2 in (("numSpeakers", "num_speakers"), ("minSpeakers", "min_speakers"), ("maxSpeakers", "max_speakers")) if job.get(k1)}
    steps = {"segmentation": 0.3, "embeddings": 0.9}

    def hook(step, artifact=None, file=None, total=None, completed=None, **_):
        base = {"segmentation": 0.0, "embeddings": 0.3}.get(step)
        if base is not None and total:
            pc.progress(base + (steps[step] - base) * (completed or 0) / total)

    res = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": 16000}, hook=hook, **kw)
    T.mark("diarize")
    turns = spans(res.speaker_diarization)
    excl = spans(res.exclusive_speaker_diarization)
    overlap = []
    ov = res.speaker_diarization.get_overlap()
    for seg in ov:
        who = sorted({str(l) for l in res.speaker_diarization.crop(seg).labels()})
        overlap.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "speakers": who})
    labels = sorted({t["speaker"] for t in turns})
    emb = getattr(res, "speaker_embeddings", None)
    speakers = []
    for i, lab in enumerate(labels):
        sec = sum(t["end"] - t["start"] for t in excl if t["speaker"] == lab)
        rec = {"id": lab, "seconds": round(sec, 2)}
        if emb is not None and i < len(emb) and np.all(np.isfinite(emb[i])):
            rec["embedding"] = [round(float(v), 5) for v in emb[i]]
        speakers.append(rec)
    pc.write(out, {"model": MODEL, "device": dev, "turns": turns, "exclusive": excl, "overlap": overlap, "speakers": speakers,
                   "vram_peak_mb": pc.torch_peak_mb(), "timing": T.parts})


if __name__ == "__main__":
    main()
