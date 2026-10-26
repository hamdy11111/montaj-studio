"""Easy Cover: a song re-arranged by the model while its melody is kept (YuE2 3B on a SheetSage2 score).

Ported from the AI Creative Studio's Music Rework Studio V3 (legacy.py Prepare/Render/convert_checked, engines.extract,
longform.py, quality.inspect). One ComfyUI node driven by Montaj Studio, like compose.py: the request is JSON, the files
go to the folder the app gives, progress goes to the app as "montaj-music.progress" events.

The path, for each section of the chosen part (one section up to 130 s; a longer part is cut into ~100 s sections at
quiet points, see cover_core.plan):
  1. SheetSage2 writes the section's score (ABC) and its bar grid; the singer's melody moves to the instrument voice
     (Plenio's move_vocal_to_ins, checked note by note: nothing of the melody may be lost).
  2. YuE2 plays that score in the preset's arrangement (with the pinned instrumental LoRA). Its end token is refused
     before 97 % of the score's length (cover_core.min_frames) — the fix for the source studio's failed long-song test.
  3. The result is transcribed again: no sung notes, a melody close to the source (cover_core.melody/verdict), a length
     within ±10 % of the score. A take that fails is tried once more with another seed; the better one is kept, and a
     section with no passing take stops a long song (its drafts stay) — a preview is saved marked for review.
  4. Sections are laid on their score time (pitch-kept tempo correction) and cross-faded; the song is saved at a fixed
     loudness as WAV, FLAC and MP3 with report.json.

Plenio (Apache-2.0, github.com/jplenio/Plenio-Music-Production-System v0.7.0) is the model manager's pinned zip; it is
unpacked next to it on first use and imported as a library (not loaded as a ComfyUI node package).
"""
import contextlib
import json
import os
import sys
import time
import zipfile

import numpy as np

from . import cover_core as core
from .compose import export, ffmpeg, load_audio

PRESETS = json.load(open(os.path.join(os.path.dirname(__file__), "cover_presets.json"), encoding="utf-8"))["presets"]
MODELS = {"checkpoints": "yue2_3b_bf16.safetensors", "audio_encoders": "sheetsage2_bf16.safetensors", "loras": "ar_lora_inst_v3abc_comfyui.safetensors"}
DEFAULTS = {"source": "", "start": 0., "duration": 30., "preset": "egyptian_shaabi", "variant": "Classic", "description": "", "tempo": "original",
            "seed": 2026101441, "preview": False, "attempts": 2, "keep_loaded": False}
SAMPLING = {"temperature": 1., "top_p": .95, "top_k": 100, "repetition_penalty": 1.2, "steps": 32}


def normalize(req):
    s = {**DEFAULTS, **{k: v for k, v in req.items() if k in DEFAULTS}}
    if s["preset"] not in {p["id"] for p in PRESETS}:
        raise ValueError("طابع غير معروف")
    if s["variant"] not in ("Classic", "Modern", "Grand") or s["tempo"] not in core.TEMPO:
        raise ValueError("اختيار غير صالح للاتجاه أو السرعة")
    if not s["source"] or not os.path.exists(s["source"]):
        raise ValueError("ملف الأغنية غير موجود")
    s["start"], s["duration"] = max(0., float(s["start"])), float(s["duration"])
    if s["preview"]:
        s["duration"] = min(s["duration"], 30.)
    if not 8 <= s["duration"] <= core.MAX_SECONDS:
        raise ValueError("اختر جزءًا من 8 ثوانٍ إلى 20 دقيقة")
    s["seed"] = int(s["seed"]) & 0xffffffff
    s["attempts"] = max(1, min(3, int(s["attempts"])))
    s["description"] = str(s["description"] or "").strip()[:600]
    return s


def plenio(zip_path):
    """Import Plenio from the model manager's pinned zip (unpacked once beside it)."""
    if "plenio" in sys.modules:
        return
    if not zip_path or not os.path.exists(zip_path):
        raise ValueError("مكتبة Plenio غير مثبتة؛ نزّل «الكافر السهل» من النماذج والمتطلبات")
    root = zip_path[:-4]
    if not os.path.exists(os.path.join(root, "plenio", "__init__.py")):
        with zipfile.ZipFile(zip_path) as z:
            names = [n for n in z.namelist() if "/plenio/" in n and not n.endswith("/")]
            prefix = names[0].split("/plenio/")[0] + "/"
            for n in names:
                dest = os.path.join(root, n[len(prefix):])
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(n) as src, open(dest, "wb") as out:
                    out.write(src.read())
    sys.path.insert(0, root)


@contextlib.contextmanager
def no_early_end(frames):
    """YuE2 may not end its music before `frames` tokens (ComfyUI's own sampler refuses the end token until
    min_tokens, 200 by default; the request raises it). No core file is modified."""
    from comfy.text_encoders import yue2
    original = yue2.YuE2TEModel._generate
    seen = []

    def generate(self, prefix, seed, max_tokens, phase, dtype, **kw):
        if phase == "semantic" and "min_tokens" in kw:
            kw["min_tokens"] = max(kw["min_tokens"], min(frames, max_tokens - 1))
            seen.append(kw["min_tokens"])
        return original(self, prefix, seed, max_tokens, phase, dtype, **kw)
    yue2.YuE2TEModel._generate = generate
    try:
        yield seen
    finally:
        yue2.YuE2TEModel._generate = original


def boundaries(x, sr):
    """Low-energy valleys (0.1 s hops, relative to the 90th percentile) and beat times, for the section plan."""
    import librosa
    mono = x.mean(1)
    if sr != 8000:
        mono = librosa.resample(mono, orig_sr=sr, target_sr=8000)
    hop = 800
    energy = np.array([np.sqrt(np.mean(mono[k:k + hop] ** 2) + 1e-12) for k in range(0, len(mono), hop)])
    scale = max(float(np.percentile(energy, 90)), 1e-6)
    valleys = [(k * .1, float(energy[k] / scale)) for k in range(1, len(energy) - 1) if energy[k] <= energy[k - 1] and energy[k] <= energy[k + 1]]
    _, frames = librosa.beat.beat_track(y=mono, sr=8000, hop_length=256, trim=False)
    return valleys, librosa.frames_to_time(frames, sr=8000, hop_length=256).tolist()


def comfy_audio(x, sr):
    import torch
    return {"waveform": torch.from_numpy(np.ascontiguousarray(x.T, dtype=np.float32))[None], "sample_rate": sr}


def score_notes(abc):
    from plenio.third_party.yue2_abc_tools import parse_abc
    sc = parse_abc(abc)
    v = sc.voices["Vocal"].notes or sc.voices["Ins"].notes
    return [(float(a) * 60 / sc.bpm, int(p), float(d) * 60 / sc.bpm) for a, p, d in v], float(sc.bpm)


def score_of(encoder, x, sr, seconds):
    """SheetSage2 score of a section, with the singer's melody moved to the instrument voice (nothing lost)."""
    from plenio.comfy import host
    from plenio.core.score import native as rules
    from plenio.third_party.yue2_abc_tools import parse_abc
    if float(np.mean(x * x)) < 1e-10:
        raise ValueError("المقطع صامت؛ لا توجد نوتة لاستخراجها")
    tr = host.sheetsage_transcribe(encoder, comfy_audio(x, sr))
    if tr.get("engine_path") != "events":
        raise ValueError("SheetSage2 لم يُخرج شبكة الموازير؛ توقفنا بدل اختراع التزامن")
    abc = tr["abc"]
    parsed = parse_abc(abc)
    rules.validate(abc)
    score_seconds = float(parsed.voices["Ins"].time) * 60 / parsed.bpm
    if abs(score_seconds - seconds) > max(8, seconds * .12):
        raise ValueError(f"النوتة المستخرجة غير متزامنة ({score_seconds:.1f} ث مقابل {seconds:.1f} ث)")
    change = rules.move_vocal_to_ins(abc, conflict="replace")
    after = parse_abc(change.abc)
    rules.validate(change.abc)
    if after.voices["Vocal"].notes or parsed.voices["Vocal"].bars != after.voices["Vocal"].bars:
        raise ValueError("نقل اللحن للآلة غيّر شبكة الموازير؛ توقفنا")
    trip = lambda ns: sorted((str(a), int(p), str(d)) for a, p, d in ns)  # noqa: E731
    kept = trip(after.voices["Ins"].notes)
    missing = [n for n in trip(parsed.voices["Vocal"].notes) if n not in kept]
    if missing:
        raise ValueError("لم يُحفظ لحن المطرب كاملًا عند نقله للآلة؛ توقفنا")
    if not after.voices["Ins"].notes:
        raise ValueError("لم تُستخرج نغمات من المقطع")
    bars = after.voices["Ins"].bars
    if len(bars) != len(tr["bar_starts"]):
        raise ValueError("النوتة وشبكة الموازير غير متطابقتين؛ توقفنا")
    # Bar starts in the song and in the score (its fixed tempo), plus the end of the last bar: the section's time map.
    grid = {"source": [float(x) for x in tr["bar_starts"]] + [float(tr["bar_ends"][-1])],
            "score": [float(b[0]) * 60 / after.bpm for b in bars] + [float(after.voices["Ins"].time) * 60 / after.bpm]}
    return {"abc": change.abc, "source_abc": abc, "bpm": float(after.bpm), "expected": float(after.voices["Ins"].time) * 60 / after.bpm,
            "vocal_notes": len(parsed.voices["Vocal"].notes), "ins_notes": len(after.voices["Ins"].notes), "bars": len(bars), "grid": grid}


def cover(req, notify, check_interrupt):
    """One cover (a preview or the whole part). Returns the report (written next to the audio as report.json)."""
    import nodes
    import folder_paths
    import comfy.model_management as mm
    from comfy_extras.nodes_audio_encoder import AudioEncoderLoader
    from comfy_extras.nodes_yue2 import YuE2GenerateMusic, EmptyYuE2LatentAudio
    from comfy_extras.nodes_audio import VAEDecodeAudio

    s = normalize(req)
    exe, out_dir = req["ffmpeg"], req["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    plenio(req.get("plenio"))
    from plenio.core.score import native as rules
    from plenio.core.vocals import VocalReading
    from plenio.comfy import host
    preset = next(p for p in PRESETS if p["id"] == s["preset"])
    ratio = core.TEMPO[s["tempo"]]
    started = time.time()

    notify("analyze", "قراءة الجزء المختار وتقسيمه عند نقاط الهدوء")
    x, sr = load_audio(exe, s["source"], s["start"], s["duration"], check_interrupt)
    seconds = len(x) / sr
    valleys, beats = boundaries(x, sr) if seconds > core.SINGLE_MAX_SECONDS else ((), ())
    plan = core.plan(seconds, valleys, beats)
    chunks = plan["chunks"]
    n = len(chunks)

    notify("score", "استخراج اللحن والنوتة (SheetSage2)")
    encoder = AudioEncoderLoader.execute(MODELS["audio_encoders"]).result[0]
    scores = []
    for c in chunks:
        check_interrupt()
        part = x[round(c["start"] * sr):round(c["end"] * sr)]
        sc = score_of(encoder, part, sr, len(part) / sr)
        if ratio != 1:
            sc["abc"] = rules.set_tempo(sc["abc"], int(round(sc["bpm"] * ratio))).abc
            sc["expected"] /= ratio
        scores.append(sc)
    ref_notes = [score_notes(sc["source_abc"])[0] for sc in scores]
    median = float(np.median([p for r in ref_notes for _, p, _ in r])) if any(ref_notes) else None
    # What two different melodies of the same song score against each other (the bar a kept melody must clear).
    baseline = [core.melody(a, b).get("pitch_class_sequence_ratio") for a, b in zip(ref_notes, ref_notes[1:])]

    notify("load", "تحميل YuE2 ومحوّل الآلات في الذاكرة")
    model, clip, vae = nodes.CheckpointLoaderSimple().load_checkpoint(MODELS["checkpoints"])
    model, clip = nodes.LoraLoader().load_lora(model, clip, MODELS["loras"], 0., 1.)
    waves, records = [], []
    folder = os.path.join(out_dir, "sections")
    try:
        for i, (c, sc) in enumerate(zip(chunks, scores)):
            expected = sc["expected"]
            style = core.style_text(preset, s["variant"], s["description"], median, (i + 1, n))
            lyrics = rules.section_tags(sc["abc"])
            ceiling = min(900., expected + 6)
            takes = []
            for k in range(s["attempts"]):
                check_interrupt()
                seed = (s["seed"] + i * 1000 + k) & 0xffffffff
                notify("generate", f"الجزء {i + 1} من {n} · محاولة {k + 1}: توليد التوزيع على نفس اللحن" if n > 1 else f"محاولة {k + 1}: توليد التوزيع على نفس اللحن")
                t0 = time.time()
                with no_early_end(core.min_frames(expected, ceiling)) as applied:
                    cond, gen_seconds = YuE2GenerateMusic.execute(clip=clip, style=style, lyrics=lyrics, seed=seed, mode="melody", max_duration=ceiling,
                                                                  temperature=SAMPLING["temperature"], top_p=SAMPLING["top_p"], top_k=SAMPLING["top_k"],
                                                                  repetition_penalty=SAMPLING["repetition_penalty"], abc=sc["abc"], cfg_scale=1.).result
                latent = EmptyYuE2LatentAudio.execute(gen_seconds, 1).result[0]
                negative = nodes.ConditioningZeroOut().zero_out(cond)[0]
                sampled = nodes.common_ksampler(model, seed, SAMPLING["steps"], 1., "dpm_2", "sgm_uniform", cond, negative, latent, denoise=1.)[0]
                out = VAEDecodeAudio.execute(vae=vae, samples=sampled).result[0]
                y = out["waveform"][0].detach().cpu().float().numpy().T.copy()
                ysr = int(out["sample_rate"])
                if y.shape[1] == 1:
                    y = np.repeat(y, 2, 1)
                check_interrupt()
                notify("check", f"فحص الجزء {i + 1}: اللحن والغناء والطول" if n > 1 else "فحص النتيجة: اللحن والغناء والطول")
                tr = host.sheetsage_transcribe(encoder, comfy_audio(y, ysr))
                actual = len(y) / ysr
                vocal = VocalReading.from_notes(tr.get("vocal_notes", []), actual)
                cmp = core.melody(ref_notes[i], score_notes(tr["abc"])[0] if tr.get("abc") else [])
                length = (c["end"] - c["start"]) / ratio
                win = core.window(sc["grid"], c["end"] - c["start"], ratio, actual, expected)
                # Two checks of the length: the whole score was played, and the section's span needs only a small fit.
                fit = core.fit_ratio(win[1] - win[0], length) if core.fit_ratio(actual, expected) else None
                v = core.verdict(cmp, vocal.notes, fit)
                raw = os.path.join(folder, f"section_{i + 1:02d}_take_{k + 1}.wav")
                os.makedirs(folder, exist_ok=True)
                import soundfile as sf
                sf.write(raw, y, ysr, subtype="FLOAT")
                takes.append({"take": k + 1, "seed": seed, "file": raw, "seconds": round(actual, 3), "expected_seconds": round(expected, 3), "fit_ratio": fit,
                              "window": [round(win[0], 3), round(win[1], 3)],
                              "min_frames": applied[-1] if applied else None, "generated_seconds": round(float(gen_seconds), 3),
                              "vocal": vocal.to_dict(), "melody": cmp, **v, "elapsed_seconds": round(time.time() - t0, 2), "_audio": (y, ysr)})
                if v["passed"]:
                    break
            best = min(takes, key=lambda t: (not t["passed"], t["penalty"]))
            y, ysr = best.pop("_audio")
            for t in takes:
                t.pop("_audio", None)
            rec = {**{k: c[k] for k in ("index", "start", "end", "core_start", "core_end")}, "bpm": sc["bpm"], "bars": sc["bars"], "vocal_notes_moved": sc["vocal_notes"],
                   "takes": takes, "chosen_take": best["take"], "passed": best["passed"], "style": style}
            records.append(rec)
            # Only a section that cannot be laid on its time stops a long song (no repetition, no silence); a section
            # whose melody or voice check failed keeps its best take and the song is marked for review.
            if best["fit_ratio"] is None and n > 1:
                raise ValueError(f"الجزء {i + 1} لم يطابق طوله بعد {len(takes)} محاولات ({'؛ '.join(best['failures'])}). المسودات محفوظة في المجلد، ولم نُكمل الأغنية بتكرار أو صمت")
            if best["fit_ratio"] is None:
                # A preview that did not fit is still saved, untouched, and marked for review.
                waves.append(y if ysr == 48000 else resample(exe, y, ysr, check_interrupt))
                continue
            waves.append(lay(exe, y[round(best["window"][0] * ysr):round(best["window"][1] * ysr)], ysr, c, ratio, check_interrupt))
    except BaseException:
        with open(os.path.join(out_dir, "sections.json"), "w", encoding="utf-8") as f:
            json.dump({"plan": plan, "sections": records, "melody_baseline_between_sections": baseline, "status": "incomplete"}, f, ensure_ascii=False, indent=1)
        raise
    finally:
        del model, clip, vae, encoder
        if not s["keep_loaded"]:
            mm.unload_all_models()
            mm.soft_empty_cache()

    notify("join", "ربط الأجزاء بانتقالات ناعمة وفحص الطول" if n > 1 else "تجهيز النتيجة")
    if n > 1:
        y, seams = core.assemble(chunks, waves, 48000, ratio)
    else:
        y, seams = waves[0], []
    notify("save", "حفظ الملف بجودة WAV وFLAC وMP3 بنفس مستوى الصوت")
    files, loudness = export(exe, y, 48000, out_dir, req.get("name") or "cover", check_interrupt)
    passed = all(r["passed"] for r in records)
    models = []
    for kind, name in MODELS.items():
        p = folder_paths.get_full_path_or_raise(kind, name)
        models.append({"file": name, "bytes": os.path.getsize(p), "sha256": (req.get("model_sha256") or {}).get(name)})
    reasons = [(f"الجزء {r['index']}: " if n > 1 else "") + f for r in records for f in r["takes"][r["chosen_take"] - 1]["failures"] + r["takes"][r["chosen_take"] - 1]["warnings"]]
    report = {"schema": "montaj-music.result/1", "status": "SCREENING_PASSED_LISTENING_REQUIRED" if passed else "REVIEW_REQUIRED_NOT_CLEARED",
              "engine": "YuE2 3B + SheetSage2 + instrumental LoRA (ComfyUI) · Plenio 0.7.0", "path": "cover",
              "settings": s, "source": {"name": os.path.basename(s["source"]), "start": s["start"], "seconds": round(seconds, 3)},
              "composition": {"preset": preset["id"], "preset_name": preset["name_ar"], "variant": s["variant"], "seed": s["seed"]},
              "plan": plan, "sections": records, "seams": seams, "melody_baseline_between_sections": baseline, "review_reasons": reasons, "loudness": loudness, "files": files, "duration": len(y) / 48000,
              "models": models, "sampling": SAMPLING, "generation_seconds": round(time.time() - started, 2),
              "fixes": {"early_end_refused_before_fraction": core.MIN_FRACTION, "section_seconds": core.CHUNK_SECONDS, "tempo_hint": "the score's own; no BPM in the style text"},
              "limits": ["YuE2 keeps the score conditionally: pitch, octave, timing and lead timbre can differ — listening is required.",
                         "The melody check re-transcribes the result: ordered pitch classes and contour only.",
                         "No-vocals is screened by SheetSage2's sung-note reading only (no separate vocal-stem detector)."],
              "licensing": {"YuE2, SheetSage2, instrumental LoRA": "CC BY-NC 4.0 (non-commercial)", "Plenio": "Apache-2.0", "commercial_clearance_claimed": False}}
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    return report


def resample(exe, y, sr, check_interrupt):
    import soundfile as sf
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, "a.wav"), os.path.join(d, "b.wav")
        sf.write(a, y, sr, subtype="FLOAT")
        ffmpeg(exe, ["-y", "-i", a, "-ar", "48000", "-c:a", "pcm_f32le", b], check_interrupt)
        return sf.read(b, dtype="float32")[0]


def lay(exe, y, sr, c, ratio, check_interrupt):
    """A section's span of the take (core.window) laid exactly on the song's time at 48 kHz: pitch-kept tempo
    correction (Rubber Band, within ±10 %), then cut to the sample. Never padded: a section that does not cover its time raises."""
    import soundfile as sf
    import tempfile
    want = round(c["end"] / ratio * 48000) - round(c["start"] / ratio * 48000)
    tempo = (len(y) / sr) / (want / 48000)
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, "a.wav"), os.path.join(d, "b.wav")
        sf.write(a, y, sr, subtype="FLOAT")
        # A hair slower than exact (0.1 % longer), so the stretched take is never a few samples short; then cut.
        filt = f"rubberband=tempo={tempo * (1 - 1e-3):.6f}:pitch=1"
        ffmpeg(exe, ["-y", "-i", a, "-af", filt, "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", b], check_interrupt)
        z = sf.read(b, dtype="float32")[0]
    if len(z) < want:
        raise ValueError("المعالجة لم تغطِّ مدة الجزء؛ لا نضيف صمتًا")
    return np.ascontiguousarray(z[:want], dtype=np.float32)
