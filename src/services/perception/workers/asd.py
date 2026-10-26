# Who speaks on screen: active-speaker detection on every face track. LR-ASD (Liao et al., IJCV 2025; MIT), with
# the weights fine-tuned on TalkSet — the better ones for ordinary video — or Light-ASD (CVPR 2023) as the fast mode.
# The recipe of the authors' Columbia_test.py: the track's mouth-area crops (112×112 gray, 25 fps, made by faces.py)
# and the track's sound as 13 MFCC at 100 frames/s; scores of 1–6 s pieces averaged; a score > 0 = speaking.
#
# job: {audio, modelsDir, fps=25, model: "lr-asd" | "light-asd", tracks: [{id, t0, frames, crop (.npy path)}]}
# result: {model, device, tracks: [{id, t0, fps, scores: [per frame, 1 decimal]}]}
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402

KINDS = {
    "lr-asd": ("LR-ASD", "finetuning_TalkSet.model", (1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6)),
    "light-asd": ("Light-ASD", "finetuning_TalkSet.model", (1, 2, 4)),
}


def load(md, kind, dev):
    import torch
    import torch.nn as nn
    folder, weights, durations = KINDS[kind]
    root = os.path.join(md, folder)
    sys.path.insert(0, root)
    from model.Model import ASD_Model  # the authors' code (runtime/models/perception/<folder>/model)
    from loss import lossAV

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.model = ASD_Model()
            self.lossAV = lossAV()

    net = Net()
    sd = torch.load(os.path.join(root, "weight", weights), map_location="cpu", weights_only=False)
    sd = {k.replace("module.", ""): v for k, v in sd.items()}
    missing = net.load_state_dict({k: v for k, v in sd.items() if k.startswith(("model.", "lossAV."))}, strict=False)
    if missing.missing_keys:
        raise RuntimeError(f"{folder}: weights missing {missing.missing_keys[:5]}")
    return net.to(dev).eval(), f"{folder} ({weights})", durations


def main():
    job, out = pc.args()
    T = pc.Timer()
    import numpy as np
    import torch
    import python_speech_features
    dev = pc.device(job)
    kind = job.get("model", "lr-asd")
    net, name, durations = load(pc.models_dir(job), kind, dev)
    T.mark("load")
    fps = float(job.get("fps", 25))
    x = pc.read_wav16(job["audio"])
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)   # the authors read 16-bit WAV samples
    res = []
    total = sum(t["frames"] for t in job["tracks"]) or 1
    seen = 0
    for tr in job["tracks"]:
        V = np.load(tr["crop"]).astype(np.float32)
        a0 = int(round(tr["t0"] * 16000))
        a1 = int(round((tr["t0"] + len(V) / fps) * 16000))
        A = python_speech_features.mfcc(pcm[a0:a1], 16000, numcep=13, winlen=0.025, winstep=0.010)
        length = min((A.shape[0] - A.shape[0] % 4) / 100, V.shape[0] / fps)
        A = A[:int(round(length * 100))]
        V = V[:int(round(length * fps))]
        scores = np.zeros(len(V), np.float32)
        if length >= 0.2:
            allscore = []
            for d in durations:
                sc = []
                with torch.inference_mode():
                    for i in range(int(math.ceil(length / d))):
                        ia = torch.from_numpy(A[i * d * 100:(i + 1) * d * 100].astype(np.float32))[None].to(dev)
                        iv = torch.from_numpy(V[i * d * 25:(i + 1) * d * 25])[None].to(dev)
                        if ia.shape[1] < 4 or iv.shape[1] < 1:
                            continue
                        m = net.model
                        o = m.forward_audio_visual_backend(m.forward_audio_frontend(ia), m.forward_visual_frontend(iv))
                        sc.extend(net.lossAV.forward(o, labels=None).tolist())
                allscore.append(np.array(sc[:len(V)] + [sc[-1] if sc else 0.0] * (len(V) - len(sc)), np.float32))
            scores = np.mean(np.stack(allscore), axis=0)
        res.append({"id": tr["id"], "t0": tr["t0"], "fps": fps, "scores": [round(float(v), 1) for v in scores]})
        seen += tr["frames"]
        pc.progress(seen / total)
    T.mark("score")
    pc.write(out, {"model": name, "device": dev, "tracks": res, "vram_peak_mb": pc.torch_peak_mb(), "timing": T.parts})


if __name__ == "__main__":
    main()
