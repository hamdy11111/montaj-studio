"""Professional person matte: SAM 3.1 finds the person, MatAnyone2 mattes them (hair, hands, soft edges).

  pro_matte.py --video V --out MASK.mp4 --ffmpeg F --comfy COMFYUI_DIR --sam SAM_CKPT --matanyone MODEL_DIR
               [--start S] [--dur D] [--short 720] [--fps 30] [--concept "person:8"] [--check-every 15]
               [--drift-iou 0.8] [--stats STATS.json] [--ab DIR] [--ab-at 0.5,2.5]

Per frame (decoded once by FFmpeg, auto-rotated, at --short px on the short side):
  * a cut (colour-histogram jump) starts a new segment: SAM 3.1 (text concept, up to 8 people; the main ones only —
    a detection under 15 % of the largest one's area, someone far in the background, is left out) gives the
    first-frame mask and MatAnyone2 starts again from it (its memory would carry the previous shot's person over the cut);
  * every --check-every frames SAM is asked again; when the matte (alpha > 0.5) and SAM's mask disagree (IoU below
    --drift-iou) MatAnyone2 restarts from SAM's mask — the matte drifted (a hand merged into the background, someone
    walked in front);
  * frames with nobody in them give an empty matte until SAM sees a person again.
The matte goes out as a grey video (white = person) with the media's timing, like the fast MediaPipe matte.
--stats writes fps, GPU memory, restarts and a flicker measure (mean |alpha change| on pixels whose colour did not
change: alpha that moves on a still pixel is flicker). --ab saves frames (source | matte over checkerboard).
SAM 3.1 runs in-process through ComfyUI's own model code (comfy/ldm/sam3), from the video runtime.
"""
import argparse, json, os, subprocess, sys, time
import numpy as np


def emit(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()


def probe(ffprobe, video):
    """(width, height, duration) as displayed: a 90/270 degree display rotation swaps the sides (FFmpeg auto-rotates
    when decoding). -show_streams works on every ffprobe version (old ones lack the stream_side_data section)."""
    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", video],
                       capture_output=True, text=True, encoding="utf8")
    d = json.loads(r.stdout or "{}")
    if not d.get("streams"):
        raise SystemExit(f"ffprobe found no video stream: {r.stderr[-300:]}")
    st = d["streams"][0]
    w, h = st.get("width", 16), st.get("height", 9)
    rot = next((abs(int(float(sd["rotation"]))) for sd in st.get("side_data_list", []) or [] if sd.get("rotation")), 0)
    rot = rot or abs(int((st.get("tags") or {}).get("rotate", 0) or 0))
    if rot % 180 == 90:
        w, h = h, w
    return w, h, float(d.get("format", {}).get("duration", 0) or 0)


class Sam:
    """SAM 3.1 through ComfyUI's code: text concept → union mask of the detections (H×W float 0/1)."""

    def __init__(self, comfy_dir, ckpt, concept):
        sys.path.insert(0, comfy_dir)
        import comfy.sd, nodes  # noqa: E402  (ComfyUI parses no CLI arguments when imported)
        from comfy_extras.nodes_sam3 import SAM3_Detect
        self.Detect = SAM3_Detect
        out = comfy.sd.load_checkpoint_guess_config(ckpt, output_vae=False, output_clip=True)
        self.model, clip = out[0], out[1]
        self.cond = nodes.CLIPTextEncode().encode(clip, concept)[0]
        self.calls, self.seconds = 0, 0.0

    def mask(self, rgb_u8, main_only=False, keep_share=0.15):
        """main_only: the main people only — detections at least `keep_share` of the largest one's area (two people
        side by side stay; someone small in the background goes)."""
        import torch
        t = time.time()
        img = torch.from_numpy(rgb_u8).float().div(255).unsqueeze(0)
        out = self.Detect.execute(model=self.model, image=img, conditioning=self.cond, threshold=0.45, refine_iterations=2, individual_masks=main_only)
        m = out.result[0] if hasattr(out, "result") else out[0]
        self.calls += 1; self.seconds += time.time() - t
        if not main_only:
            return m[0].float().cpu().numpy()
        if m.shape[0] == 0:
            return np.zeros(rgb_u8.shape[:2], np.float32)
        areas = m.flatten(1).sum(1)
        keep = areas >= keep_share * areas.max()
        return (m[keep].sum(0) > 0).float().cpu().numpy()


class Matter:
    """MatAnyone2, restartable from a mask."""

    def __init__(self, model_dir, device):
        from matanyone2 import MatAnyone2
        self.net = MatAnyone2.from_pretrained(model_dir)
        self.device = device
        self.core = None

    def start(self, rgb_u8, mask01, warmup=10):
        import torch
        from matanyone2 import InferenceCore
        from matanyone2.utils.inference_utils import gen_dilate, gen_erosion
        self.core = InferenceCore(self.net, device=self.device)
        m = (mask01 * 255).astype(np.uint8)
        m = gen_erosion(gen_dilate(m, 10, 10), 10, 10)  # as the reference pipeline: close small holes, keep the outline
        img = self._img(rgb_u8)
        mt = torch.from_numpy(m).float().to(self.device)
        with torch.inference_mode(), torch.amp.autocast(device_type=self.device):
            self.core.step(img, mt, objects=[1])
            p = self.core.step(img, first_frame_pred=True)
            for _ in range(warmup):
                p = self.core.step(img, first_frame_pred=True)
        return self.core.output_prob_to_mask(p).float().cpu().numpy()

    def step(self, rgb_u8):
        import torch
        with torch.inference_mode(), torch.amp.autocast(device_type=self.device):
            p = self.core.step(self._img(rgb_u8))
        return self.core.output_prob_to_mask(p).float().cpu().numpy()

    def _img(self, rgb_u8):
        import torch
        return torch.from_numpy(rgb_u8).permute(2, 0, 1).float().div(255).to(self.device)


def iou(a, b):
    a, b = a > 0.5, b > 0.5
    u = np.logical_or(a, b).sum()
    return 1.0 if u == 0 else float(np.logical_and(a, b).sum() / u)


def checker(h, w, s=16):
    y, x = np.mgrid[0:h, 0:w]
    c = ((x // s + y // s) % 2).astype(np.float32)
    return (0.55 + 0.25 * c)[..., None] * 255


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True); p.add_argument("--out", required=True); p.add_argument("--ffmpeg", default="ffmpeg"); p.add_argument("--ffprobe", default="ffprobe")
    p.add_argument("--comfy", required=True); p.add_argument("--sam", required=True); p.add_argument("--matanyone", required=True)
    p.add_argument("--start", type=float, default=0); p.add_argument("--dur", type=float, default=0)
    p.add_argument("--short", type=int, default=720); p.add_argument("--fps", type=float, default=30)
    p.add_argument("--concept", default="person:8"); p.add_argument("--check-every", dest="check", type=int, default=15)
    p.add_argument("--drift-iou", dest="drift", type=float, default=0.8)
    p.add_argument("--stats"); p.add_argument("--ab"); p.add_argument("--ab-at", dest="ab_at", default="")
    p.add_argument("--all-people", dest="main_only", action="store_false", help="matte everyone SAM finds, not only the main people")
    a = p.parse_args()

    import torch
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    W0, H0, dur = probe(a.ffprobe, a.video)
    even = lambda x: max(2, int(round(x / 2)) * 2)
    if W0 >= H0:
        H = a.short; W = even(W0 * a.short / H0)
    else:
        W = a.short; H = even(H0 * a.short / W0)
    total = int(round(((a.dur or (dur - a.start)) * a.fps)))
    t_load = time.time()
    if dev == "cuda":
        torch.cuda.reset_peak_memory_stats()
    sam = Sam(a.comfy, a.sam, a.concept)
    mat = Matter(a.matanyone, dev)
    load_s = time.time() - t_load

    dec = subprocess.Popen([a.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{a.start:.3f}", "-i", a.video, *(["-t", f"{a.dur:.3f}"] if a.dur else []),
                            "-an", "-vf", f"fps={a.fps},scale={W}:{H}:flags=bicubic", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen([a.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(a.fps), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-g", str(int(a.fps)), "-pix_fmt", "yuv420p", a.out], stdin=subprocess.PIPE)
    ab_times = [float(x) for x in a.ab_at.split(",") if x.strip()]
    ab_frames = {int(round(t * a.fps)) for t in ab_times}
    if a.ab:
        os.makedirs(a.ab, exist_ok=True)

    size = W * H * 3
    prev_hist = prev_img = prev_alpha = None
    alpha = np.zeros((H, W), np.float32)
    active = False
    n = restarts = cuts = 0
    flicker_sum, flicker_n = 0.0, 0
    events = []
    t0 = time.time()
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        img = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        small = img[::8, ::8]
        q = (small // 32).reshape(-1, 3).astype(np.int32)
        hist = np.bincount(q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2], minlength=512).astype(np.float32); hist /= hist.sum()
        cut = prev_hist is not None and float(np.abs(hist - prev_hist).sum()) > 0.6
        if n == 0 or cut or not active or n % a.check == 0:
            sm = sam.mask(img, main_only=a.main_only)
            has = sm.mean() > 0.002
            if n == 0 or cut:
                if cut:
                    cuts += 1
                if has:
                    alpha = mat.start(img, sm); active = True; events.append([n, "start" if n == 0 else "cut"])
                else:
                    active = False; alpha = np.zeros((H, W), np.float32); events.append([n, "nobody"])
            elif not active:
                if has:
                    alpha = mat.start(img, sm); active = True; restarts += 1; events.append([n, "found"])
            else:
                alpha = mat.step(img)
                j = iou(alpha, sm)
                if not has or j < a.drift:
                    restarts += 1; events.append([n, "drift", round(j, 3)])
                    if has:
                        alpha = mat.start(img, sm)
                    else:
                        active = False; alpha = np.zeros((H, W), np.float32)
        else:
            alpha = mat.step(img)
        alpha = np.clip(alpha, 0, 1)
        # flicker: alpha changing on pixels whose colour stayed (same shot only)
        if prev_img is not None and not cut:
            still = np.abs(img.astype(np.int16) - prev_img.astype(np.int16)).max(axis=2) < 6
            if still.any():
                flicker_sum += float(np.abs(alpha - prev_alpha)[still].mean()); flicker_n += 1
        enc.stdin.write((alpha * 255 + 0.5).astype(np.uint8).tobytes())
        if a.ab and n in ab_frames:
            from PIL import Image
            comp = img.astype(np.float32) * alpha[..., None] + checker(H, W) * (1 - alpha[..., None])
            Image.fromarray(np.concatenate([img, comp.astype(np.uint8)], axis=1)).save(os.path.join(a.ab, f"pro_{n:05d}.jpg"), quality=90)
            Image.fromarray((alpha * 255).astype(np.uint8)).save(os.path.join(a.ab, f"pro_{n:05d}_alpha.png"))
        prev_hist, prev_img, prev_alpha = hist, img, alpha
        n += 1
        if n % 30 == 0:
            emit({"progress": min(0.99, n / max(1, total)), "fps": round(n / (time.time() - t0), 2)})
    dec.wait(); enc.stdin.close(); enc.wait()
    secs = time.time() - t0
    peak = torch.cuda.max_memory_allocated() / 2 ** 30 if dev == "cuda" else 0
    stats = {"frames": n, "width": W, "height": H, "fps": round(n / max(secs, 1e-6), 2), "seconds": round(secs, 1), "loadS": round(load_s, 1),
             "peakGB": round(peak, 2), "cuts": cuts, "restarts": restarts, "samCalls": sam.calls, "samSeconds": round(sam.seconds, 1),
             "flicker": round(flicker_sum / max(1, flicker_n), 5), "events": events[:200]}
    if a.stats:
        json.dump(stats, open(a.stats, "w"), indent=1)
    emit({"done": True, **{k: v for k, v in stats.items() if k != "events"}})


if __name__ == "__main__":
    main()
