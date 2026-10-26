# The semantic check of cause ↔ reaction links (Phase 6, plan item 9 step 2.2: «علاقة في المعنى»): for every reaction,
# a vision model looks at frames of the span around it (dense just before and during the reaction, one frame on each
# far candidate), reads what is said in it and what the sound models heard (it does not hear), and answers one
# multiple choice: is the reaction real, which lettered candidate caused it (or "other" at a time it saw, or "none"),
# how sure, why — grounded on named frames, with "nothing visible" / "none" as explicit answers. The same question is
# also asked at decoy moments where nothing was heard (causeLinks.controlQueries): how often the model still says yes
# there is its false-yes rate, which discounts its confidence. causeLinks.applyAnswers turns the answers into verdicts.
#
#   qwen3.6     Qwen3.6-35B-A3B UD-IQ4_XS + mmproj F16 (Apache-2.0), the copy the perception stage installed under
#               runtime/models/perception/qwen3.6-35b-a3b — reused, not downloaded again. Sees only: the sound is
#               described in words.
#   qwen3-omni  Qwen3-Omni-30B-A3B-Instruct Q4_K_M + mmproj Q8_0 (ggml-org GGUF of Qwen's Apache-2.0 model), in
#               runtime/models/perception/qwen3-omni-30b-a3b (the folder perception's windowCheck hook reads): hears
#               the clip around the flagged moment and sees fewer frames — the "reaction reviewer" of plan item 2.
# Both run on llama.cpp's server, thinking off, JSON schema, ~18–20 GB on the card: the service takes the shared GPU
# lock around this process (not around the "frames" pass, which only decodes video on the CPU).
#
# job: {media, ffmpeg, llama, modelsDir, engine, queries: [verifyQueries(…) + controlQueries(…) items], workDir,
#       side=448, mode: "frames" | "check"}
# result: {engine, model, available, answers: {R001: {...}}, ms: {R001: n}, serverLoadS}
import os
import subprocess
import sys
import time

# The perception workers' plumbing (llama.cpp server, keyframes, job/progress I/O), read in place.
PERCEPTION = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "perception", "workers")
sys.path.insert(0, PERCEPTION)
import pcommon as pc  # noqa: E402
import llama  # noqa: E402

ENGINES = {
    "qwen3.6": {"dir": "qwen3.6-35b-a3b", "model": "Qwen3.6-35B-A3B-UD-IQ4_XS.gguf", "mmproj": "mmproj-F16.gguf", "audio": False,
                "name": "Qwen3.6-35B-A3B UD-IQ4_XS (llama.cpp)"},
    "qwen3-omni": {"dir": "qwen3-omni-30b-a3b", "model": "Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf", "mmproj": "mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf",
                   "audio": True, "frames": 6, "name": "Qwen3-Omni-30B-A3B-Instruct Q4_K_M (llama.cpp)"},
}

SYSTEM = (
    "You check cause-and-reaction links for a video editor who cuts Egyptian Arabic social videos (vlogs, pranks, "
    "challenges, games, comedy). You get frames of one stretch of raw phone footage, each labelled with its time in "
    "seconds, the words said in it (Egyptian Arabic, machine-transcribed, often wrong or incomplete), and what sound "
    "models flagged at a given time. You cannot hear. Sound models flag many moments that are NOT reactions: loud "
    "talk, a shout to someone, a car, a door, a child crying, wind, the phone moving. So:\n"
    "1. Look at the frames at and just after the flagged time. reaction_seen: what the people visibly do there "
    "(laughing, smiling, cheering, clapping, shocked, hands_on_head, covering_face, screaming, jumping) or "
    "nothing_visible (normal talk, walking, a crying baby, no faces, blur) or camera_away (the camera does not show "
    "the people). reaction_frame: the frame time where that reaction shows best, or \"none\". reaction_real: true only "
    "when a frame shows people reacting to something; reaction_confidence 0-1.\n"
    "2. cause: the lettered candidate that made them react — only if you can point to the frame where it happens "
    "(cause_frame) or it is a line said just before. A candidate that merely spans the same seconds is not a cause; "
    "\"seen (vision log)\" candidates are long windows described by another model, judge them by the frames. In games, "
    "challenges and pranks the cause can be far earlier (the stakes said at the start); a reaction can also come just "
    "before its cause (laughing while the punchline is still said, tension before a reveal). If the frames show a cause "
    "no candidate describes, answer \"other\" with cause_frame. If no reaction is real, or nothing shown explains it, "
    "answer \"none\" — that is the right answer for most flagged moments. cause_time: when the cause happens (-1 for "
    "none). also_related: other letters that are part of the same cause, usually empty.\n"
    "confidence 0-1 for the cause: 0.8+ only when one frame shows the cause and a later one the reaction to it. "
    "reason: one short English sentence naming the frames. Answer with the JSON object only."
)

SEEN = ["laughing", "smiling", "cheering", "clapping", "shocked", "hands_on_head", "covering_face", "screaming", "jumping", "nothing_visible", "camera_away"]


def schema_frames(letters, frames):
    ft = [f"{t:.2f}" for t in frames]
    return {"type": "object", "properties": {
        "reaction_seen": {"type": "string", "enum": SEEN},
        "reaction_frame": {"type": "string", "enum": ft + ["none"]},
        "reaction_real": {"type": "boolean"}, "reaction_confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "who_reacts": {"type": "string"},
        "cause": {"type": "string", "enum": letters + ["other", "none"]},
        "cause_frame": {"type": "string", "enum": ft + ["none"]},
        "cause_time": {"type": "number"},
        "also_related": {"type": "array", "maxItems": 3, "items": {"type": "string", "enum": letters}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason": {"type": "string"}},
        "required": ["reaction_seen", "reaction_frame", "reaction_real", "reaction_confidence", "who_reacts", "cause", "cause_frame", "cause_time", "also_related", "confidence", "reason"]}


HEARD = ["laughter", "cheering", "applause", "screaming", "gasp", "crying", "talking", "shouting_words", "music", "noise", "silence"]
HEARING = (
    "\nYou can also HEAR the sound of the clip (its start and end times are given). Use it first for the flagged moment: "
    "sound_heard is what you hear at the flagged time — laughter, cheering, applause, screaming, gasp (reactions) or "
    "crying (a baby or child), talking, shouting_words (calling someone, giving orders), music, noise, silence (not "
    "reactions by themselves). Laughter means people laughing, not a child crying. A sudden silence counts only when "
    "people fall silent in tension or surprise."
)


def schema(letters, frames, audio=False):
    s = schema_frames(letters, frames)
    if audio:
        s["properties"]["sound_heard"] = {"type": "string", "enum": HEARD}
        s["required"] = ["sound_heard"] + s["required"]
    return s


KIND = {"speech": "said", "promise": "said (a promise / the stakes)", "action": "seen (vision log)", "sound": "a sudden sound"}


def prompt(q, files, wav=None, clip=None):
    lines = [f"Flagged moment {q['t0']:.1f}-{q['t1']:.1f} s. The sound models flagged there: {', '.join(q['heard'])}.",
             f"Content: {'a game / challenge / prank (causes may be far earlier)' if q['profile'] == 'event' else 'talk / comedy / vlog'}.",
             "Words said around it:" if q["said"] else "Nothing transcribed around it."]
    for t0, t1, sp, text in q["said"]:
        lines.append(f"  {t0:.1f}-{t1:.1f} s, voice {sp or '?'}: {text}")
    lines.append("Candidate causes:")
    for c in q["candidates"]:
        lines.append(f"  {c['key']}. {c['t0']:.1f}-{c['t1']:.1f} s, {KIND.get(c['kind'], c['kind'])}: {c['text'][:200]}")
    content = [{"type": "text", "text": "\n".join(lines)}]
    if wav:
        content += [{"type": "text", "text": f"The sound from {clip[0]:.1f} s to {clip[1]:.1f} s:"}, llama.audio_part(wav)]
    for t, f in files:
        content.append({"type": "text", "text": f"Frame at t = {t:.2f} s{' (flagged moment)' if q['t0'] - 0.3 <= t <= q['t1'] + 0.3 else ''}:"})
        content.append(llama.image_part(f))
    return content


def clip_of(q, max_s=12.0):
    """The sound to hear: from a little before the nearest candidate (or 4 s before the moment) to 2 s after it."""
    near = [c["t0"] for c in q["candidates"] if not c.get("far")]
    a = max(q["span"][0], min([q["t0"] - 4] + [t for t in near if t >= q["t0"] - 8]))
    b = q["t1"] + 2.0
    if b - a > max_s:
        a = b - max_s
    return max(0.0, a), b


def pick_frames(frames, t0, t1, n):
    """n of the frames, evenly over the list, always keeping the one nearest the flagged moment."""
    if len(frames) <= n:
        return list(frames)
    idx = {round(k * (len(frames) - 1) / (n - 1)) for k in range(n)}
    idx.add(min(range(len(frames)), key=lambda i: abs(frames[i] - (t0 + t1) / 2)))
    return [frames[i] for i in sorted(idx)][:n + 1]


def main():
    job, out = pc.args()
    T = pc.Timer()
    name = job.get("engine", "qwen3.6")
    eng = ENGINES[name]
    md = os.path.join(pc.models_dir(job), eng["dir"])
    model, mmproj = os.path.join(md, eng["model"]), os.path.join(md, eng["mmproj"])
    missing = [p for p in (model, mmproj, job["llama"]) if not os.path.isfile(p)]
    if missing:
        pc.write(out, {"engine": name, "available": False, "reason": "not installed: " + ", ".join(missing), "answers": {}})
        return
    work = job["workDir"]
    os.makedirs(work, exist_ok=True)
    side = int(job.get("side", 448))
    Q = job["queries"]
    # Frames first (CPU). The service runs this as its own pass ("frames") before it takes the GPU lock, so the card
    # is held for the model only; the "check" pass finds them on disk.
    frames_only = job.get("mode") == "frames"
    for i, q in enumerate(Q):
        ts = pick_frames(q["frames"], q["t0"], q["t1"], eng["frames"]) if eng.get("frames") else q["frames"]
        q["_frames"] = ts
        q["_files"] = [(t, llama.keyframe(job["ffmpeg"], job["media"], t, os.path.join(work, f"f_{t:09.2f}_{side}.jpg"), side)) for t in ts]
        if eng["audio"]:
            q["_clip"] = clip_of(q)
            q["_wav"] = os.path.join(work, f"a_{q['_clip'][0]:09.2f}_{q['_clip'][1]:09.2f}.wav")
            if not os.path.isfile(q["_wav"]):
                subprocess.run([job["ffmpeg"], "-hide_banner", "-v", "error", "-y", "-ss", f"{q['_clip'][0]:.3f}", "-t", f"{q['_clip'][1] - q['_clip'][0]:.3f}",
                                "-i", job["media"], "-vn", "-ac", "1", "-ar", "16000", q["_wav"]], check=True)
        pc.progress((1.0 if frames_only else 0.3) * (i + 1) / max(1, len(Q)), "frames")
    T.mark("frames")
    if frames_only:
        pc.write(out, {"engine": name, "available": True, "frames": sum(len(q["_frames"]) for q in Q), "timing": T.parts})
        return
    answers, ms, errors = {}, {}, {}
    system = SYSTEM + (HEARING if eng["audio"] else "")
    srv = llama.Server(job["llama"], model, mmproj, ctx=int(job.get("ctx", 16384)), log_path=os.path.join(work, f"llama-server-{name}.log"))
    with srv:
        load_s = srv.wait()
        T.mark("server load")
        for i, q in enumerate(Q):
            letters = [c["key"] for c in q["candidates"]]
            t0 = time.perf_counter()
            for attempt in range(2):
                try:
                    text, _, _ = srv.chat([{"role": "system", "content": system}, {"role": "user", "content": prompt(q, q["_files"], q.get("_wav"), q.get("_clip"))}],
                                          schema=schema(letters, q["_frames"], eng["audio"]), max_tokens=450, temperature=0.0)
                    a = llama.parse_json(text)
                    a["cause"] = a["cause"] if a["cause"] in ("other", "none") else str(a["cause"]).upper()
                    answers[q["reaction"]] = a
                    errors.pop(q["reaction"], None)
                    break
                except Exception as e:  # noqa: BLE001 — one retry, then the reaction stays unchecked
                    errors[q["reaction"]] = f"{type(e).__name__}: {e}"
            ms[q["reaction"]] = round((time.perf_counter() - t0) * 1000)
            pc.progress(0.3 + 0.7 * (i + 1) / max(1, len(Q)))
        T.mark("check")
    pc.write(out, {"engine": name, "model": eng["name"], "available": True, "answers": answers, "errors": errors,
                   "ms": ms, "serverLoadS": load_s, "frames": sum(len(q["_frames"]) for q in Q), "timing": T.parts})


if __name__ == "__main__":
    main()
