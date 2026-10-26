"""Where a thing is over time, for arrows and circles that follow it: SAM 3.1 by concept ("pan", "person", "cup")
on every frame of a window (10 fps by default). The box and centre of the union mask per frame; smoothing is done by
the caller (matteService.js → smoothTrack), so the raw detections stay inspectable.

  track_object.py --video V --out TRACK.json --ffmpeg F --ffprobe P --comfy DIR --sam CKPT --concept "pan"
                  [--start S] [--dur D] [--fps 10] [--short 640]
Output: {"concept", "fps", "startS", "frames": [[tS, x0, y0, x1, y1, cx, cy, area], ...]}  (fractions; area 0 = not seen)
"""
import argparse, json, os, subprocess, sys, time
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True); p.add_argument("--out", required=True)
    p.add_argument("--ffmpeg", default="ffmpeg"); p.add_argument("--ffprobe", default="ffprobe")
    p.add_argument("--comfy", required=True); p.add_argument("--sam", required=True); p.add_argument("--concept", required=True)
    p.add_argument("--start", type=float, default=0); p.add_argument("--dur", type=float, default=10)
    p.add_argument("--fps", type=float, default=10); p.add_argument("--short", type=int, default=640)
    a = p.parse_args()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from pro_matte import probe, Sam
    W0, H0, _ = probe(a.ffprobe, a.video)
    even = lambda x: max(2, int(round(x / 2)) * 2)
    W, H = (even(W0 * a.short / H0), a.short) if W0 >= H0 else (a.short, even(H0 * a.short / W0))
    r = subprocess.run([a.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{a.start:.3f}", "-i", a.video, "-t", f"{a.dur:.3f}", "-an",
                        "-vf", f"fps={a.fps},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    frames = np.frombuffer(r.stdout, np.uint8).reshape(-1, H, W, 3)
    t0 = time.time()
    sam = Sam(a.comfy, a.sam, a.concept)
    out = []
    r4 = lambda v: round(float(v), 4)
    for i, f in enumerate(frames):
        m = sam.mask(f) > 0.5
        t = round(a.start + i / a.fps, 3)
        if m.sum() < 20:
            out.append([t, 0, 0, 0, 0, 0, 0, 0]); continue
        ys, xs = np.nonzero(m)
        out.append([t, r4(xs.min() / W), r4(ys.min() / H), r4((xs.max() + 1) / W), r4((ys.max() + 1) / H), r4(xs.mean() / W), r4(ys.mean() / H), r4(m.mean())])
    json.dump({"concept": a.concept, "fps": a.fps, "startS": a.start, "width": W0, "height": H0, "frames": out}, open(a.out, "w"))
    sys.stdout.write(json.dumps({"done": True, "frames": len(out), "seconds": round(time.time() - t0, 2)}) + "\n")


if __name__ == "__main__":
    main()
