# Shared plumbing of the perception workers (src/services/perception/workers/*.py).
#
# Every worker is one process per stage, started by perceptionService.js:
#     python -X utf8 <worker>.py --job <job.json> --out <result.json>
# The job is a JSON object (paths, options, the outputs of earlier stages it needs); the result is a JSON object the
# service merges into the event timeline. Progress goes to stderr as "PROGRESS 0.42"; anything else on stderr is a
# log line. One process per stage means the model's GPU memory is given back when the stage ends, so two heavy models
# are never on the card together.
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.job, encoding="utf-8") as f:
        job = json.load(f)
    return job, a.out


def progress(p, note=""):
    print(f"PROGRESS {max(0.0, min(1.0, p)):.3f}{(' ' + note) if note else ''}", file=sys.stderr, flush=True)


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def write(out, result):
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, out)


def models_dir(job):
    """runtime/models/perception: every weight file the workers load (never downloaded at run time)."""
    return job["modelsDir"]


def device(job):
    want = job.get("device", "auto")
    if want != "auto":
        return want
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def torch_peak_mb():
    """The most GPU memory torch reserved in this process (MB), or None without CUDA."""
    try:
        import torch
        if torch.cuda.is_available():
            return round(torch.cuda.max_memory_reserved() / 2 ** 20)
    except ImportError:
        pass
    return None


def read_wav16(path):
    """The stage's 16 kHz mono float32 audio (the service extracts it once per media file)."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != 16000:
        import librosa
        x = librosa.resample(x, orig_sr=sr, target_sr=16000)
    return np.ascontiguousarray(x, dtype=np.float32)


def _grab(ffmpeg, path, pre, vf, at, w, h):
    import numpy as np
    r = subprocess.run([ffmpeg, "-hide_banner", "-v", "error"] + pre + ["-ss", f"{at:.3f}", "-i", path, "-an", "-vf", vf, "-frames:v", "1",
                        "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True)
    return np.frombuffer(r.stdout, np.uint8).reshape(h, w, 3) if r.returncode == 0 and len(r.stdout) == w * h * 3 else None


def decode_plan(ffmpeg, path, long_side, at=1.0):
    """How to decode the media small and fast: NVIDIA decoding with the resize on the GPU is ~4× faster than the CPU
    for 4K HEVC (and the plain "-hwaccel cuda" download of full 4K frames is slower than the CPU). GPU frames skip
    FFmpeg's automatic rotation, so the orientation is chosen by comparing one GPU frame (as is, flipped, turned) with
    the CPU frame — the recipe of the app's fastDecode.js. Returns (w, h, pre_args, vf) for the display size."""
    import numpy as np
    head = subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-ss", f"{at:.3f}", "-i", path, "-frames:v", "1",
                           "-vf", f"scale='if(gt(iw,ih),{long_side},-2)':'if(gt(iw,ih),-2,{long_side})'", "-f", "image2pipe", "-vcodec", "ppm", "-"],
                          capture_output=True).stdout
    if not head:  # a very short file: grab from its start
        return decode_plan(ffmpeg, path, long_side, 0.0) if at else (0, 0, [], "")
    w, h = (int(v) for v in head.split(b"\n", 3)[1].split())
    cpu_vf = f"scale={w}:{h}:flags=bicubic"
    ref = _grab(ffmpeg, path, [], cpu_vf, at, w, h)
    pre = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    best, best_err = None, float("inf")
    for turn, sw, sh in (("", w, h), (",hflip,vflip", w, h), (",transpose=clock", h, w), (",transpose=cclock", h, w)):
        vf = f"scale_cuda={sw}:{sh}:format=yuv420p,hwdownload,format=yuv420p{turn}"
        img = _grab(ffmpeg, path, pre, vf, at, w, h) if ref is not None else None
        if img is None:
            continue
        err = float(np.mean((img.astype(np.float32)[::3, ::3] - ref.astype(np.float32)[::3, ::3]) ** 2))
        if err < best_err:
            best, best_err = vf, err
    if best is not None and best_err <= 120:   # PSNR above ~27 dB: the same picture
        return w, h, pre, best
    return w, h, [], cpu_vf


def video_frames(ffmpeg, path, fps, long_side, start=0.0, duration=None):
    """Yield (index, time_s, HxWx3 uint8 BGR) frames of the media, resampled to `fps`, the long side `long_side` in
    the display orientation (decode_plan). Read from the original file in place; nothing is written to disk. Falls
    back to the CPU decoder when the GPU one fails."""
    import numpy as np
    w, h, pre, vf = decode_plan(ffmpeg, path, long_side)
    if not w:
        raise RuntimeError("could not read a frame of the video")
    frame_bytes = w * h * 3
    plans = [(pre, vf)] + ([([], f"scale={w}:{h}:flags=bicubic")] if pre else [])
    for k, (p_pre, p_vf) in enumerate(plans):
        cmd = [ffmpeg, "-hide_banner", "-v", "error"] + p_pre + (["-ss", str(start)] if start else []) + ["-i", path]
        cmd += (["-t", str(duration)] if duration else []) + ["-an", "-vf", f"{p_vf},fps={fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 4)
        i = 0
        try:
            while True:
                buf = p.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    break
                yield i, start + i / fps, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                i += 1
        finally:
            p.stdout.close()
            err = p.stderr.read().decode("utf-8", "replace")
            p.wait()
        if i > 0 or k == len(plans) - 1:
            if i == 0:
                raise RuntimeError(f"ffmpeg decode failed: {err[-500:]}")
            return
        log("GPU decode gave no frames, CPU decode:", err[-200:])


class Timer:
    """Wall time of named parts of a stage (reported in the result's `timing`)."""

    def __init__(self):
        self.t0 = time.perf_counter()
        self.parts = {}
        self._last = self.t0

    def mark(self, name):
        now = time.perf_counter()
        self.parts[name] = round(self.parts.get(name, 0) + now - self._last, 3)
        self._last = now

    def total(self):
        return round(time.perf_counter() - self.t0, 3)
