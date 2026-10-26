# Shot boundaries: TransNetV2 (Souček & Lokoč; MIT) through the authors' own PyTorch port (inference-pytorch/
# transnetv2_pytorch.py) with weights converted once from the official TensorFlow release by their convert_weights.py
# (the official checkpoint is TF only). The authors' inference recipe: 48×27 RGB frames, 100-frame windows stepping
# 50 (25 frames of context each side), sigmoid, a cut where the score crosses the threshold.
#
# job: {media, ffmpeg, modelsDir, fps=25, threshold=0.5, duration}
# result: {model, device, fps, shots: [{start, end, p}], cuts: [{t, p}]}
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402


def frames48(ffmpeg, path, fps):
    """The authors' input: every frame as 48×27 RGB (the picture squeezed, whatever its shape)."""
    import cv2
    import numpy as np
    out = [cv2.resize(img, (48, 27), interpolation=cv2.INTER_AREA)[..., ::-1] for _, _, img in pc.video_frames(ffmpeg, path, fps, 320)]
    return np.ascontiguousarray(np.stack(out))


def scenes(pred, thr):
    """The authors' predictions_to_scenes: [[first, last]] frame ranges."""
    p = (pred > thr).astype("uint8")
    out, t_prev, start, t = [], 0, 0, 0
    for i, t in enumerate(p):
        if t_prev == 1 and t == 0:
            start = i
        if t_prev == 0 and t == 1 and i != 0:
            out.append([start, i])
        t_prev = t
    if t == 0:
        out.append([start, len(p) - 1])
    return out or [[0, len(p) - 1]]


def main():
    job, out = pc.args()
    T = pc.Timer()
    import numpy as np
    import torch
    dev = pc.device(job)
    md = os.path.join(pc.models_dir(job), "transnetv2")
    sys.path.insert(0, md)
    from transnetv2_pytorch import TransNetV2
    net = TransNetV2()
    net.load_state_dict(torch.load(os.path.join(md, "transnetv2-pytorch-weights.pth"), map_location="cpu"))
    net.to(dev).eval()
    T.mark("load")
    fps = float(job.get("fps", 25))
    X = frames48(job["ffmpeg"], job["media"], fps)
    T.mark("decode")
    n = len(X)
    end_pad = 25 + 50 - (n % 50 if n % 50 else 50)
    P = np.concatenate([np.repeat(X[:1], 25, 0), X, np.repeat(X[-1:], end_pad, 0)])
    preds = []
    with torch.inference_mode():
        for ptr in range(0, len(P) - 99, 50):
            single, _ = net(torch.from_numpy(P[ptr:ptr + 100])[None].to(dev))
            preds.append(torch.sigmoid(single).float().cpu().numpy()[0, 25:75, 0])
            pc.progress(0.5 + 0.5 * ptr / len(P))
    pred = np.concatenate(preds)[:n]
    T.mark("predict")
    thr = float(job.get("threshold", 0.5))
    shots = []
    for a, b in scenes(pred, thr):
        shots.append({"start": round(a / fps, 3), "end": round((b + 1) / fps, 3), "p": round(float(pred[max(0, a - 1)]), 3) if a else None})
    shots[-1]["end"] = max(shots[-1]["end"], round(float(job.get("duration") or 0), 3))
    cuts = [{"t": s["start"], "p": s["p"]} for s in shots[1:]]
    pc.write(out, {"model": "TransNetV2", "device": dev, "fps": fps, "frames": n, "shots": shots, "cuts": cuts,
                   "vram_peak_mb": pc.torch_peak_mb(), "timing": T.parts})


if __name__ == "__main__":
    main()
