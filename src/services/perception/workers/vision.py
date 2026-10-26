# The shot log: Qwen3.6-35B-A3B (Apache-2.0; unsloth's UD-IQ4_XS GGUF + the F16 vision projector, llama.cpp) looks
# at a few keyframes of every shot — long shots are cut into windows of at most `windowS` seconds, since a phone
# video is often one long take — with each keyframe's time written in the prompt, plus what is said in that window,
# and fills a fixed JSON form: who is there, where, what happens, shot size, camera, energy, whether it is a B-roll
# candidate. The model does not hear; the words are given as text. Thinking is off (plain JSON answers).
#
# job: {media, ffmpeg, llama, modelsDir, shots: [{start, end}], words: [[t, word]], workDir, windowS=12, frames=3,
#       side=640, duration}
# result: {model, device, windows: [{start, end, shot, keyframes: [t], log: {...}, ms, tokens}], serverLoadS}
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402
import llama  # noqa: E402

MODEL_FILE = "Qwen3.6-35B-A3B-UD-IQ4_XS.gguf"
MMPROJ = "mmproj-F16.gguf"

SCHEMA = {
    "type": "object",
    "properties": {
        "who": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
            "label": {"type": "string"}, "looks": {"type": "string"}, "position": {"type": "string", "enum": ["left", "center", "right", "full", "edge"]},
            "doing": {"type": "string"}, "facing_camera": {"type": "boolean"}}, "required": ["label", "looks", "position", "doing", "facing_camera"]}},
        "where": {"type": "string"},
        "indoor": {"type": "boolean"},
        "action": {"type": "string"},
        "objects": {"type": "array", "maxItems": 8, "items": {"type": "string"}},
        "text_on_screen": {"type": "string"},
        "shot_size": {"type": "string", "enum": ["extreme_close_up", "close_up", "medium_close_up", "medium", "medium_wide", "wide", "extreme_wide", "insert"]},
        "camera": {"type": "string", "enum": ["static", "handheld", "selfie", "pan", "tilt", "zoom", "tracking", "pov"]},
        "change": {"type": "string"},
        "energy": {"type": "integer", "minimum": 1, "maximum": 5},
        "broll_candidate": {"type": "boolean"},
        "broll_reason": {"type": "string"},
        "summary": {"type": "string"},
        "summary_ar": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["who", "where", "indoor", "action", "objects", "text_on_screen", "shot_size", "camera", "change", "energy", "broll_candidate", "broll_reason", "summary", "summary_ar", "confidence"],
}

SYSTEM = (
    "You log raw footage for a video editor who makes Egyptian Arabic social videos (vlogs, challenges, cooking, "
    "explainers, comedy). You see a few keyframes of one stretch of a video, each labelled with its time in seconds, "
    "and the words spoken in that stretch (Egyptian Arabic, machine-transcribed, may contain errors). Describe only "
    "what is visible; never invent people, places or events. Fill every field of the JSON form:\n"
    "- who: each visible person (label them person_1, person_2… left to right in the first frame; looks = clothing/hair, "
    "not identity; doing = what they do).\n"
    "- where: the place in a few words; action: what happens across the frames; change: what changes from the first "
    "keyframe to the last ('none' if nothing).\n"
    "- shot_size and camera: as a cinematographer would name them (a phone held at arm's length facing the speaker = selfie).\n"
    "- energy: 1 calm … 5 very energetic (movement, expressions, pace).\n"
    "- broll_candidate: true when this stretch shows something worth cutting to while someone talks over it (food, a "
    "place, a product, a hands-on action), false for a plain talking head; broll_reason in a few words.\n"
    "- summary: one English sentence; summary_ar: the same in one short Egyptian Arabic sentence.\n"
    "- confidence: how sure you are of this description (0–1). Answer with the JSON object only."
)


def windows(shots, max_s, duration):
    out = []
    for si, s in enumerate(shots):
        a, b = float(s["start"]), float(min(s["end"], duration or s["end"]))
        if b - a < 0.3:
            continue
        n = max(1, int((b - a) // max_s) + (1 if (b - a) % max_s > 0.5 * max_s else 0))
        step = (b - a) / n
        for k in range(n):
            out.append({"shot": si + 1, "start": round(a + k * step, 3), "end": round(a + (k + 1) * step, 3)})
    return out


def main():
    job, out = pc.args()
    T = pc.Timer()
    md = os.path.join(pc.models_dir(job), "qwen3.6-35b-a3b")
    work = job["workDir"]
    os.makedirs(work, exist_ok=True)
    W = windows(job["shots"], float(job.get("windowS", 12)), float(job.get("duration") or 0))
    nf = int(job.get("frames", 3))
    words = job.get("words", [])
    # Keyframes first (cheap), so the GPU time is only the model's.
    for w in W:
        span = w["end"] - w["start"]
        w["keyframes"] = [round(w["start"] + span * (k + 0.5) / nf, 2) for k in range(nf)]
        w["files"] = [llama.keyframe(job["ffmpeg"], job["media"], t, os.path.join(work, f"kf_{t:09.2f}.jpg"), int(job.get("side", 640))) for t in w["keyframes"]]
    T.mark("keyframes")
    srv = llama.Server(job["llama"], os.path.join(md, MODEL_FILE), os.path.join(md, MMPROJ), ctx=int(job.get("ctx", 16384)), log_path=os.path.join(work, "llama-server.log"))
    res = []
    with srv:
        load_s = srv.wait()
        T.mark("server load")
        for i, w in enumerate(W):
            said = " ".join(x[1] for x in words if w["start"] <= x[0] < w["end"]) or "(nothing said)"
            content = [{"type": "text", "text": f"Stretch {w['start']:.1f}–{w['end']:.1f} s of the video (shot {w['shot']}). Spoken in it: {said}"}]
            for t, f in zip(w["keyframes"], w["files"]):
                content.append({"type": "text", "text": f"Keyframe at t = {t:.2f} s:"})
                content.append(llama.image_part(f))
            t0 = time.perf_counter()
            log, err, usage = None, None, {}
            for attempt in range(2):
                try:
                    text, usage, _ = srv.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}], schema=SCHEMA)
                    log = llama.parse_json(text)
                    break
                except Exception as e:  # noqa: BLE001 — one retry, then the window is logged as failed
                    err = f"{type(e).__name__}: {e}"
            res.append({"start": w["start"], "end": w["end"], "shot": w["shot"], "keyframes": w["keyframes"], "log": log, "error": None if log else err,
                        "ms": round((time.perf_counter() - t0) * 1000), "tokens": usage})
            pc.progress((i + 1) / max(1, len(W)))
        T.mark("describe")
    pc.write(out, {"model": "Qwen3.6-35B-A3B UD-IQ4_XS (llama.cpp)", "device": "cuda", "windows": res, "serverLoadS": load_s, "timing": T.parts})


if __name__ == "__main__":
    main()
