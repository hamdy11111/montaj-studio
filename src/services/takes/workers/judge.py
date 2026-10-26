# The AI tie-breaker for close calls between two takes of the same line (Phase 5, best take).
#
#     python -X utf8 judge.py --job <job.json> --out <result.json>
#
# job: { media, ffmpeg, modelPath, fps (2), side (320), pairs: [{ id, a: {t0, t1}, b: {t0, t1}, type, line }] }
# result: { answers: { <id>: { ab, ba, rawAb, rawBa } }, model, ms, torchPeakMB }
#   ab: the answer ("A" | "B" | "?") with take a shown first, ba: with take b shown first — the scorer
#   (core/takeScore.js judgeVerdict) counts the judgement only when both orders name the same take.
#
# Model: Qwen2.5-Omni-7B (thinker only, bf16 — it sees the frames AND hears the take), read from the local Hugging Face
# cache or runtime/models/takes; never downloaded here. Needs ~18–21 GB of GPU memory (the weights alone are ~17.8 GB):
# the service takes the GPU lock, and the frames are kept small (320 px short side, 2 fps).
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tcommon import args, progress, log, write  # noqa: E402

SR = 16000
TYPES = {"comedy": "comedy sketch", "explainer": "explainer / tutorial", "vlog": "vlog", "interview": "interview", "cooking": "cooking video", "challenge": "challenge video"}


def clip(ffmpeg, media, t0, t1, fps, side):
    pad = 0.15
    a, d = max(0.0, t0 - pad), (t1 - t0) + 2 * pad
    raw = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{a:.3f}", "-t", f"{d:.3f}", "-i", media, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, np.float32).copy()
    vf = f"fps={fps},scale='if(gt(iw,ih),-2,{side})':'if(gt(iw,ih),{side},-2)'"
    probe = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{a:.3f}", "-t", f"{d:.3f}", "-i", media, "-an", "-vf", vf, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "ppm", "-"], capture_output=True, check=True).stdout
    w, h = [int(x) for x in probe.split(b"\n")[1].split()]
    raw = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{a:.3f}", "-t", f"{d:.3f}", "-i", media, "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    frames = np.frombuffer(raw[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)
    if len(frames) % 2:  # the vision encoder takes frames in pairs
        frames = np.concatenate([frames, frames[-1:]], 0)
    return frames, audio


def main():
    job, out = args()
    t_start = time.time()
    import torch
    from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor
    path = job["modelPath"]
    proc = Qwen2_5OmniProcessor.from_pretrained(path)
    model = Qwen2_5OmniForConditionalGeneration.from_pretrained(path, dtype=torch.bfloat16, device_map="cuda", enable_audio_output=False)
    model.disable_talker()
    model.eval()
    fps, side = float(job.get("fps") or 2), int(job.get("side") or 320)  # 448 px frames pushed a 6 s pair past 24 GB
    answers = {}
    pairs = job["pairs"]

    def ask(first, second, kind, line):
        content = [{"type": "text", "text": "Take A:"}, {"type": "video"}, {"type": "audio"}, {"type": "text", "text": "Take B:"}, {"type": "video"}, {"type": "audio"},
                   {"type": "text", "text": (f"These are two takes of the same line from a {TYPES.get(kind, 'talking video')}, recorded one after the other "
                                             f"(the speaker said it again; Egyptian Arabic, roughly: «{line}»). Which take would a professional editor keep in the final cut — "
                                             "better delivery, energy, comic timing and facial expression, no stumbles or hesitation? Answer with one letter only: A or B.")}]
        text = proc.apply_chat_template([{"role": "user", "content": content}], add_generation_prompt=True, tokenize=False)
        inputs = proc(text=text, videos=[first[0], second[0]], audio=[first[1], second[1]], return_tensors="pt", padding=True, use_audio_in_video=False, fps=fps)
        inputs = inputs.to(model.device)
        for k, v in inputs.items():
            if torch.is_tensor(v) and v.is_floating_point():
                inputs[k] = v.to(torch.bfloat16)
        with torch.no_grad():
            ids = model.thinker.generate(**inputs, max_new_tokens=3, do_sample=False)
        reply = proc.batch_decode(ids[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip()
        letter = reply[:1].upper()
        return (letter if letter in ("A", "B") else "?"), reply

    for n, p in enumerate(pairs):
        a = clip(job["ffmpeg"], job["media"], p["a"]["t0"], p["a"]["t1"], fps, side)
        b = clip(job["ffmpeg"], job["media"], p["b"]["t0"], p["b"]["t1"], fps, side)
        ab, raw_ab = ask(a, b, p.get("type"), p.get("line", ""))
        ba, raw_ba = ask(b, a, p.get("type"), p.get("line", ""))
        answers[str(p["id"])] = {"ab": ab, "ba": ba, "rawAb": raw_ab, "rawBa": raw_ba}
        log(f"pair {p['id']}: ab={raw_ab!r} ba={raw_ba!r}")
        progress((n + 1) / len(pairs))
    peak = round(torch.cuda.max_memory_reserved() / 2 ** 20) if torch.cuda.is_available() else None
    write(out, {"answers": answers, "model": "Qwen2.5-Omni-7B (thinker, bf16)", "ms": int((time.time() - t_start) * 1000), "torchPeakMB": peak})


if __name__ == "__main__":
    main()
