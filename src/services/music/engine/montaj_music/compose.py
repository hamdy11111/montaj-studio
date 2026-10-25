"""New music for a video with ACE-Step 1.5 Turbo (ComfyUI core nodes).

Ported from the AI Creative Studio's Music Rework Studio V3 (original.py: presets and the composition plan;
original_engine.py: generation and the timbre-only reference adapter; audio.py: export at a fixed loudness). What
changed: it runs as one ComfyUI node driven by Montaj Studio — the request comes as JSON, the files go to the folder the
app gives, the progress goes to the app as "montaj-music.progress" events, and the models are released after the job
unless the user keeps them loaded. The model never claims more than it does: the plan guides the composition; the
notes themselves are the model's.
"""
import contextlib
import json
import math
import os
import random
import subprocess
import time
import types

import numpy as np
import soundfile as sf

# (id, Arabic name, English name, direction for the model) — the source studio's presets.
PRESETS = [
    ("reference_vibe", "روح المرجع · بدون تغيير الاستخدام", "Reference Vibe", "an intimate instrumental piece with one clear melodic lead and breathing space"),
    ("family_challenge", "تحدي عائلي مضحك", "Funny Family Challenge", "playful bouncy small ensemble, comic pauses and light hand percussion"),
    ("suspense", "ترقّب قبل المفاجأة", "Suspense Before Reveal", "sparse suspenseful pulse, slowly rising tension and a short reveal ending"),
    ("chase", "مطاردة مرحة", "Playful Chase", "nimble playful staccato melody, light quick percussion"),
    ("egyptian_comedy", "كوميديا مصرية", "Egyptian Comedy", "playful Egyptian ensemble, short comic instrumental answers and light darbuka"),
    ("happy_family", "لحظات عائلية سعيدة", "Happy Family Moments", "warm gentle melodic phrases, uplifting intimate small ensemble"),
    ("competition", "منافسة حماسية", "Energetic Competition", "driving confident pulse, concise rising hook, controlled strong percussion"),
    ("secret_mission", "غموض ومهمة سرية", "Mystery and Secret Mission", "sneaky syncopated low pulse, sparse mysterious motif"),
    ("emotional", "مشهد عائلي مؤثر", "Emotional Family Scene", "restrained intimate emotional melody, breathing space, gentle accompaniment"),
    ("winner", "إعلان الفائز", "Epic Winner Reveal", "short dignified build, bright triumphant hook, decisive resolving ending"),
    ("daily_vlog", "طبخ وفلوج يومي", "Cooking and Daily Vlog", "friendly light rhythmic accompaniment, relaxed repeatable phrases below dialogue"),
]
KEYS = [f"{n} {m}" for n in ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] for m in ["major", "minor"]]
DEFAULTS = {"preset": "reference_vibe", "vibe": "balanced", "energy": "auto", "duration": 30, "bpm": 0, "keyscale": "D minor", "meter": 0,
            "seed": 2026101441, "loop": False, "description": "", "style_override": "", "reference": None, "keep_loaded": False}
# The default style when there is no analysed reference (the source studio's "blank DNA").
BLANK_STYLE = {"genre": "Egyptian Arabic folk shaabi music", "instruments": ["accordion"], "mood": "playful cheerful music",
               "groove": "straight regular dance rhythm", "character": "acoustic ensemble recording", "production": "dry intimate studio recording",
               "density": "small ensemble with clear melody", "bpm": 100}
HOOKS = ["a rising three-note call answered by a falling five-note phrase", "a short repeated upbeat followed by a long descending answer",
         "a gently arched phrase with a rest before a new four-note response", "a low opening leap into a stepwise descending response",
         "a sustained opening tone then two short rising questions and a quiet falling answer"]
MODELS = {"diffusion_models": "acestep_v1.5_turbo.safetensors", "text_encoders": ("qwen_0.6b_ace15.safetensors", "qwen_1.7b_ace15.safetensors"), "vae": "ace_1.5_vae.safetensors"}


def normalize(req):
    """The request checked against the allowed values (the source studio's limits)."""
    s = {**DEFAULTS, **{k: v for k, v in req.items() if k in DEFAULTS}}
    if s["preset"] not in [p[0] for p in PRESETS]:
        raise ValueError("طابع غير معروف")
    if s["vibe"] not in ("close", "balanced", "free") or s["energy"] not in ("auto", "calm", "energetic"):
        raise ValueError("اختيار غير صالح للإحساس أو الطاقة")
    if s["keyscale"] not in KEYS or int(s["meter"]) not in (0, 2, 3, 4, 6):
        raise ValueError("المقام أو الميزان غير صالح")
    for key, lo, hi in (("duration", 4, 180), ("bpm", 0, 250), ("seed", 0, 2**32 - 1)):
        v = float(s[key])
        if not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError(f"{key}: الحد المتاح {lo}–{hi}")
        s[key] = int(v) if key in ("seed", "bpm") else v
    if s["bpm"] and s["bpm"] < 30:
        raise ValueError("السرعة المخصصة من 30 إلى 250 نبضة في الدقيقة؛ الصفر يعني تلقائي")
    s["meter"] = int(s["meter"])
    for key in ("description", "style_override"):
        s[key] = str(s[key] or "").strip()[:1500]
    return s


def plan(s, seconds, seed):
    """The composition plan: the model's text direction, tempo, metre, key and section layout (source: original.plan)."""
    rng = random.Random(seed)
    preset = next(p for p in PRESETS if p[0] == s["preset"])
    style_d = BLANK_STYLE
    instruments = style_d["instruments"][: {"free": 1, "balanced": 2, "close": 3}[s["vibe"]]]
    hook = rng.choice([h for h in HOOKS if h != s.get("_avoid_hook")])
    bpm = max(30, min(250, s["bpm"] or style_d["bpm"]))
    meter = s["meter"] or 4
    style = s["style_override"] or ", ".join([style_d["genre"], style_d["character"], *instruments, style_d["groove"], style_d["production"]] + ([style_d["density"]] if s["vibe"] == "close" else []))
    if s["vibe"] == "free":
        style += ". Explore a different instrumental color while keeping this musical family."
    energy = {"auto": style_d["mood"], "calm": "calm restrained energy, light percussion", "energetic": "energetic lively pulse, controlled dynamics"}[s["energy"]]
    structure = [{"name": "intro", "start": 0, "end": round(seconds * .15, 2)}, {"name": "new_hook", "start": round(seconds * .15, 2), "end": round(seconds * .5, 2)},
                 {"name": "development", "start": round(seconds * .5, 2), "end": round(seconds * .85, 2)},
                 {"name": "loop_return" if s["loop"] else "ending", "start": round(seconds * .85, 2), "end": seconds}]
    prompt = (f"Instrumental background music. {style}. {preset[3]}. {energy}. One clear lead, restrained accompaniment, breathing space. Original hook: {hook}. "
              "Brief introduction, new hook, contrasting development, " + ("return to opening groove for a loop." if s["loop"] else "short resolving ending.")
              + " No singing, no humming, no choir. " + s["description"])
    return {"schema": "independent-composition/4", "seed": seed, "seconds": seconds, "bpm": bpm, "meter": meter, "key": s["keyscale"],
            "temperature": 1.05 if s["vibe"] == "free" else .85, "prompt": prompt.strip(), "new_hook_design": hook, "structure": structure,
            "planner": "text direction + ACE Qwen fresh music tokens", "source_notes_used": False,
            "limitations_ar": "الخطة توجه التأليف؛ النغمات الفعلية يبتكرها النموذج. توقيت الأقسام والجمل غير مضمون حرفيًا."}


@contextlib.contextmanager
def style_conditioning(model, audit):
    """The reference reaches ACE's timbre encoder only; fresh text-generated codes stay the content (source:
    original_engine.style_conditioning). No core file is modified."""
    original = model.extra_conds
    had_local = "extra_conds" in model.__dict__
    previous = model.__dict__.get("extra_conds")

    def extra(self, **kwargs):
        import comfy.conds
        ref = kwargs.pop("inspired_style_latent", None)
        if kwargs.get("reference_audio_timbre_latents") is not None:
            raise ValueError("Cover conditioning is forbidden in this mode")
        out = original(**kwargs)
        if "audio_codes" not in out:
            raise ValueError("Fresh text-generated composition codes are required")
        if ref is not None:
            out["refer_audio"] = comfy.conds.CONDRegular(ref.to(kwargs["device"]))
        out.pop("is_covers", None)
        audit.append({"fresh_audio_codes": True, "reference_to_timbre_encoder_only": ref is not None, "reference_tokens_used": False})
        return out

    model.extra_conds = types.MethodType(extra, model)
    try:
        yield
    finally:
        if had_local:
            model.extra_conds = previous
        else:
            del model.extra_conds


def ffmpeg(exe, args, check_interrupt):
    p = subprocess.Popen([exe, "-hide_banner", "-nostdin", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        while True:
            try:
                out, err = p.communicate(timeout=.5)
                break
            except subprocess.TimeoutExpired:
                check_interrupt()
    except BaseException:
        p.kill()
        p.communicate()
        raise
    if p.returncode:
        raise ValueError(err.decode("utf8", "replace")[-2500:])
    return out, err.decode("utf8", "replace")


def load_audio(exe, path, start, duration, check_interrupt, rate=48000):
    args = ["-ss", str(float(start)), "-i", str(path)] + (["-t", str(float(duration))] if duration > 0 else [])
    raw, _ = ffmpeg(exe, args + ["-f", "f32le", "-acodec", "pcm_f32le", "-ar", str(rate), "-ac", "2", "pipe:1"], check_interrupt)
    x = np.frombuffer(raw, np.float32).reshape(-1, 2).copy()
    if not len(x) or not np.isfinite(x).all():
        raise ValueError("الملف الصوتي فارغ أو غير صالح")
    return x, rate


def loop_audio(x, sr, bpm, meter=4):
    """A whole number of bars with the tail cross-faded into the head (source: original.loop_audio)."""
    beat = 60 / bpm
    bar = beat * (3 if meter == 6 else meter)
    bars = int((len(x) / sr - .15) / bar)
    if bars < 1:
        raise ValueError("النتيجة أقصر من مازورة كاملة بهذه السرعة؛ اختر مدة أطول")
    n = min(len(x) - int(.15 * sr), round(bars * bar * sr))
    fade = min(int(.15 * sr), len(x) - n, n // 8)
    y = x[:n].copy()
    w = np.linspace(0, 1, fade, endpoint=False)[:, None]
    y[:fade] = x[n:n + fade] * (1 - w) + x[:fade] * w
    return y, {"bars": bars, "seconds": n / sr, "crossfade_seconds": fade / sr, "listening_required": True}


def export(exe, x, sr, out_dir, name, check_interrupt, lufs=-15.0, true_peak=-1.5):
    """WAV 48 kHz 24-bit at a fixed loudness (two-pass loudnorm), plus FLAC and MP3 320k (source: audio.export)."""
    if not np.isfinite(x).all() or np.mean(x * x) < 1e-12:
        raise ValueError("النتيجة صامتة أو غير صالحة؛ لم تُحفظ")
    os.makedirs(out_dir, exist_ok=True)
    raw = os.path.join(out_dir, name + "_raw.wav")
    sf.write(raw, x, sr, subtype="FLOAT")
    _, log = ffmpeg(exe, ["-i", raw, "-af", f"loudnorm=I={lufs}:TP={true_peak}:LRA=11:print_format=json", "-f", "null", "-"], check_interrupt)
    m = json.loads(log[log.rfind("{"):log.rfind("}") + 1])
    wav = os.path.join(out_dir, name + ".wav")
    measurable = all(math.isfinite(float(m[k])) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset"))
    if measurable:
        filt = (f"loudnorm=I={lufs}:TP={true_peak}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
                f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true:print_format=json")
        _, master = ffmpeg(exe, ["-i", raw, "-af", filt, "-ar", "48000", "-c:a", "pcm_s24le", wav], check_interrupt)
        loud = json.loads(master[master.rfind("{"):master.rfind("}") + 1])
    else:
        ffmpeg(exe, ["-i", raw, "-ar", "48000", "-c:a", "pcm_s24le", wav], check_interrupt)
        loud = {"normalization": "skipped: loudness not measurable; original level kept"}
    ffmpeg(exe, ["-y", "-i", wav, "-c:a", "flac", "-sample_fmt", "s32", wav[:-4] + ".flac"], check_interrupt)
    ffmpeg(exe, ["-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "320k", wav[:-4] + ".mp3"], check_interrupt)
    os.remove(raw)
    return {"wav": wav, "flac": wav[:-4] + ".flac", "mp3": wav[:-4] + ".mp3"}, loud


def compose(req, notify, check_interrupt):
    """One composition. Returns the report (written next to the audio as report.json)."""
    import nodes
    import torch
    import folder_paths
    import node_helpers
    import comfy.model_management as mm
    from comfy_extras.nodes_ace import TextEncodeAceStepAudio15, EmptyAceStep15LatentAudio
    from comfy_extras.nodes_audio import VAEEncodeAudio, VAEDecodeAudio
    from comfy_extras.nodes_model_advanced import ModelSamplingAuraFlow
    from comfy.model_base import ACEStep15

    s = normalize(req)
    exe = req["ffmpeg"]
    out_dir = req["out_dir"]
    seconds = float(s["duration"])
    seed = int(s["seed"])
    comp = plan(s, seconds, seed)
    started = time.time()
    notify("load", "تحميل نماذج التأليف (ACE-Step 1.5) في الذاكرة")
    model = nodes.UNETLoader().load_unet(MODELS["diffusion_models"], "default")[0]
    if not isinstance(model.model, ACEStep15):
        raise ValueError("النموذج المحمّل ليس ACE-Step 1.5")
    model = ModelSamplingAuraFlow().patch(model, 3.)[0]
    clip = nodes.DualCLIPLoader().load_clip(MODELS["text_encoders"][0], MODELS["text_encoders"][1], "ace")[0]
    vae = nodes.VAELoader().load_vae(MODELS["vae"])[0]
    check_interrupt()
    notify("compose", "كتابة خطة اللحن من الوصف (رموز موسيقية جديدة)")
    cond = TextEncodeAceStepAudio15.execute(clip, comp["prompt"], "[Instrumental]", seed, comp["bpm"], seconds, str(comp["meter"]), "unknown", comp["key"], True, 2., comp["temperature"], .9, 0, 0.).result[0]
    codes = cond[0][1].get("audio_codes")
    if codes is None or not len(codes):
        raise ValueError("ACE لم يولّد رموز التأليف")
    neg = nodes.ConditioningZeroOut().zero_out(cond)[0]
    latent = EmptyAceStep15LatentAudio.execute(seconds, 1).result[0]
    ref_meta = None
    ref = s.get("reference")
    if ref and ref.get("path"):
        check_interrupt()
        notify("reference", "ترميز روح المرجع (الخامة الصوتية فقط، بدون نوتاته)")
        x, sr = load_audio(exe, ref["path"], float(ref.get("start", 0)), min(20.0, float(ref.get("seconds", 20))), check_interrupt)
        import torch as _t
        latent_ref = VAEEncodeAudio.execute(vae, {"waveform": _t.from_numpy(x.T.copy())[None], "sample_rate": sr}).result[0]["samples"]
        cond = node_helpers.conditioning_set_values(cond, {"inspired_style_latent": latent_ref})
        neg = node_helpers.conditioning_set_values(neg, {"inspired_style_latent": latent_ref})
        ref_meta = {"start": float(ref.get("start", 0)), "seconds": min(20.0, float(ref.get("seconds", 20))), "name": os.path.basename(ref["path"])}
    audit = []
    notify("generate", "توليد الصوت: 8 خطوات ACE-Step 1.5 Turbo")
    with style_conditioning(model.model, audit):
        sampled = nodes.common_ksampler(model, seed, 8, 1., "euler", "simple", cond, neg, latent, denoise=1.)[0]
    if not audit:
        raise ValueError("لم يُثبت تنفيذ مسار التوليد")
    check_interrupt()
    notify("decode", "تحويل النتيجة إلى صوت")
    result = VAEDecodeAudio.execute(vae, sampled).result[0]
    x = result["waveform"][0].detach().cpu().numpy().T.copy()
    sr = int(result["sample_rate"])
    loop = None
    if s["loop"]:
        x, loop = loop_audio(x, sr, comp["bpm"], comp["meter"])
    notify("save", "حفظ الملف بجودة WAV وFLAC وMP3 بنفس مستوى الصوت")
    files, loudness = export(exe, x, sr, out_dir, req.get("name") or "music", check_interrupt)
    models = []
    for kind, names in MODELS.items():
        for name in (names if isinstance(names, tuple) else (names,)):
            p = folder_paths.get_full_path_or_raise(kind, name)
            models.append({"file": name, "bytes": os.path.getsize(p), "sha256": (req.get("model_sha256") or {}).get(name)})
    report = {"schema": "montaj-music.result/1", "status": "HUMAN_LISTENING_REQUIRED", "engine": "ACE-Step 1.5 Turbo (ComfyUI)", "path": "inspired" if ref_meta else "compose",
              "settings": {k: v for k, v in s.items() if k != "reference"}, "composition": comp, "reference": ref_meta, "loop": loop, "loudness": loudness,
              "files": files, "duration": len(x) / sr if not loop else loop["seconds"], "models": models, "steps": 8, "sampler": "euler", "scheduler": "simple",
              "condition_audit": audit, "generation_seconds": round(time.time() - started, 2),
              "licensing": {"ACE-Step": "MIT upstream / Comfy-Org repack Apache-2.0", "commercial_clearance_claimed": False}}
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    if not s["keep_loaded"]:
        mm.unload_all_models()
        mm.soft_empty_cache()
    return report
