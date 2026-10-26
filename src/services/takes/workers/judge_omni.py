# The AI tie-breaker for close calls between two takes, with Qwen3-Omni-30B-A3B (perception's "ear": the ggml-org GGUF
# on llama.cpp, the files the AI set-up installs under runtime/models/perception/qwen3-omni-30b-a3b). It sees each
# take's frames and hears its sound, and is asked the same question as judge.py (Qwen2.5-Omni-7B), in both orders.
#
#     python -X utf8 judge_omni.py --job <job.json> --out <result.json>
#
# job: { media, ffmpeg, llama, modelsDir (runtime/models/perception), frames (6), side (448), workDir,
#        pairs: [{ id, a: {t0, t1, media?}, b: {t0, t1, media?}, type, line }] }
# result: { answers: { <id>: { ab, ba, rawAb, rawBa } }, model, ms } — the shape of judge.py's (core/takeScore.js
#   judgeVerdict counts a judgement only when both orders name the same take).
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "perception", "workers"))
from tcommon import args, progress, log, write  # noqa: E402
import llama  # noqa: E402  (perception's llama.cpp plumbing)

MODEL_DIR = "qwen3-omni-30b-a3b"
MODEL = "Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf"
MMPROJ = "mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf"
TYPES = {"comedy": "comedy sketch", "explainer": "explainer / tutorial", "vlog": "vlog", "interview": "interview", "cooking": "cooking video", "challenge": "challenge video"}
SCHEMA = {"type": "object", "properties": {"keep": {"type": "string", "enum": ["A", "B"]}}, "required": ["keep"]}


def take_parts(job, take, tag, work, name):
    """A take as the model gets it: its sound (16 kHz WAV, 0.15 s padding) and `frames` keyframes with their times."""
    media = take.get("media") or job["media"]
    pad = 0.15
    t0, t1 = max(0.0, float(take["t0"]) - pad), float(take["t1"]) + pad
    wav = os.path.join(work, f"{name}.wav")
    subprocess.run([job["ffmpeg"], "-hide_banner", "-v", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", media, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
    parts = [{"type": "text", "text": f"Take {tag} — its sound:"}, llama.audio_part(wav)]
    nf = int(job.get("frames") or 6)
    for k in range(nf):
        t = t0 + (t1 - t0) * (k + 0.5) / nf
        f = llama.keyframe(job["ffmpeg"], media, t, os.path.join(work, f"{name}_{k}.jpg"), int(job.get("side") or 448))
        parts += [{"type": "text", "text": f"Take {tag}, frame {k + 1}/{nf}:"}, llama.image_part(f)]
    return parts


def main():
    job, out = args()
    t_start = time.time()
    md = os.path.join(job["modelsDir"], MODEL_DIR)
    work = job.get("workDir") or os.path.join(os.path.dirname(out), "judge-omni")
    os.makedirs(work, exist_ok=True)
    answers = {}
    pairs = job["pairs"]
    with llama.Server(job["llama"], os.path.join(md, MODEL), os.path.join(md, MMPROJ), ctx=32768, log_path=os.path.join(work, "server.log")) as srv:
        load = srv.wait()
        log(f"model loaded in {load} s")

        def ask(first, second, kind, line):
            content = first + second + [{"type": "text", "text": (
                f"These are two takes of the same line from a {TYPES.get(kind, 'talking video')}, recorded one after the other "
                f"(the speaker said it again; Egyptian Arabic, roughly: «{line}»). Which take would a professional editor keep in the final cut — "
                "better delivery, energy, comic timing and facial expression, clear sound and picture, no stumbles or hesitation? Answer A or B.")}]
            text, _, _ = srv.chat([{"role": "user", "content": content}], schema=SCHEMA, max_tokens=20, temperature=0)
            reply = (llama.parse_json(text) or {}).get("keep") or text.strip()[:3]
            letter = str(reply)[:1].upper()
            return (letter if letter in ("A", "B") else "?"), text.strip()

        for n, p in enumerate(pairs):
            # The same clips in both orders; only the labels "A"/"B" and the order change.
            a1, b2 = take_parts(job, p["a"], "A", work, f"p{n}a_A"), take_parts(job, p["b"], "B", work, f"p{n}b_B")
            b1, a2 = take_parts(job, p["b"], "A", work, f"p{n}b_A"), take_parts(job, p["a"], "B", work, f"p{n}a_B")
            ab, raw_ab = ask(a1, b2, p.get("type"), p.get("line", ""))
            ba_letter, raw_ba = ask(b1, a2, p.get("type"), p.get("line", ""))
            answers[str(p["id"])] = {"ab": ab, "ba": ba_letter, "rawAb": raw_ab, "rawBa": raw_ba}
            log(f"pair {p['id']}: ab={raw_ab!r} ba={raw_ba!r}")
            progress((n + 1) / len(pairs))
    write(out, {"answers": answers, "model": "Qwen3-Omni-30B-A3B-Instruct Q4_K_M (llama.cpp)", "ms": int((time.time() - t_start) * 1000), "loadS": load})


if __name__ == "__main__":
    main()
