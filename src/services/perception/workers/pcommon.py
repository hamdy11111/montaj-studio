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


def video_frames(ffmpeg, path, fps, long_side, start=0.0, duration=None, gpu=True):
    """Yield (index, time_s, HxWx3 uint8 BGR) frames of the media, resampled to `fps` and scaled so the long side
    is `long_side` (the display orientation: FFmpeg applies the rotation tag). Read from the original file in place;
    nothing is written to disk. Tries the CUDA decoder first, then the CPU one."""
    import numpy as np
    # One frame as PPM first: its header gives the scaled size after the rotation tag is applied.
    head = subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-ss", str(start), "-i", path, "-frames:v", "1",
                           "-vf", f"scale='if(gt(iw,ih),{long_side},-2)':'if(gt(iw,ih),-2,{long_side})'", "-f", "image2pipe", "-vcodec", "ppm", "-"],
                          capture_output=True).stdout
    # PPM header: P6\n<w> <h>\n255\n
    parts = head.split(b"\n", 3)
    w, h = (int(v) for v in parts[1].split())
    frame_bytes = w * h * 3
    for use_gpu in ([True, False] if gpu else [False]):
        cmd = [ffmpeg, "-hide_banner", "-v", "error"] + (["-hwaccel", "cuda"] if use_gpu else []) + ["-ss", str(start)]
        cmd += ["-i", path] + (["-t", str(duration)] if duration else [])
        cmd += ["-an", "-vf", f"fps={fps},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
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
        if i > 0 or not use_gpu:
            if p.returncode not in (0, None) and i == 0:
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
