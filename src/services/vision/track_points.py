"""Point tracks for graphics that stick to something (a name on a product, an arrow on a pan): CoTracker3 (offline).

  track_points.py --video V --out TRACKS.json --model scaled_offline.pth --ffmpeg F --ffprobe P
                  --points '[{"id":"a","x":0.5,"y":0.4,"t":0.0}, ...]' [--start S] [--dur D] [--fps 15] [--short 512]
Points are fractions of the frame (x, y) at a time t (seconds from --start). The video window is tracked forward and
backward from each point's time. Output JSON:
  {"fps", "startS", "width", "height", "points": [{"id", "track": [[tS, x, y, visible], ...]}]}  (x, y fractions)
"""
import argparse, json, subprocess, sys, time
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True); p.add_argument("--out", required=True); p.add_argument("--model", required=True)
    p.add_argument("--ffmpeg", default="ffmpeg"); p.add_argument("--ffprobe", default="ffprobe")
    p.add_argument("--points", required=True); p.add_argument("--start", type=float, default=0); p.add_argument("--dur", type=float, default=10)
    p.add_argument("--fps", type=float, default=15); p.add_argument("--short", type=int, default=512)
    a = p.parse_args()
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from pro_matte import probe
    import torch
    from cotracker.predictor import CoTrackerPredictor
    W0, H0, _ = probe(a.ffprobe, a.video)
    even = lambda x: max(2, int(round(x / 2)) * 2)
    W, H = (even(W0 * a.short / H0), a.short) if W0 >= H0 else (a.short, even(H0 * a.short / W0))
    r = subprocess.run([a.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{a.start:.3f}", "-i", a.video, "-t", f"{a.dur:.3f}", "-an",
                        "-vf", f"fps={a.fps},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    frames = np.frombuffer(r.stdout, np.uint8).reshape(-1, H, W, 3)
    pts = json.loads(a.points)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.time()
    if dev == "cuda":
        torch.cuda.reset_peak_memory_stats()
    model = CoTrackerPredictor(checkpoint=a.model, offline=True).to(dev)
    video = torch.from_numpy(frames.copy()).permute(0, 3, 1, 2)[None].float().to(dev)
    q = torch.tensor([[min(len(frames) - 1, int(round(pt.get("t", 0) * a.fps))), pt["x"] * W, pt["y"] * H] for pt in pts], dtype=torch.float32)[None].to(dev)
    with torch.no_grad():
        tracks, vis = model(video, queries=q, backward_tracking=True)
    tracks, vis = tracks[0].cpu().numpy(), vis[0].cpu().numpy()
    out = {"fps": a.fps, "startS": a.start, "width": W0, "height": H0, "points": []}
    for k, pt in enumerate(pts):
        tr = [[round(a.start + i / a.fps, 4), round(float(tracks[i, k, 0]) / W, 4), round(float(tracks[i, k, 1]) / H, 4), bool(vis[i, k] > 0.5)] for i in range(len(frames))]
        out["points"].append({"id": pt.get("id", str(k)), "track": tr})
    json.dump(out, open(a.out, "w"))
    peak = torch.cuda.max_memory_allocated() / 2 ** 30 if dev == "cuda" else 0
    sys.stdout.write(json.dumps({"done": True, "frames": len(frames), "seconds": round(time.time() - t0, 2), "peakGB": round(peak, 2)}) + "\n")


if __name__ == "__main__":
    main()
