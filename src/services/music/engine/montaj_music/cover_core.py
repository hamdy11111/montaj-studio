"""Easy Cover's pure parts (no ComfyUI, no torch): the section plan of a long song, joining the sections, the style
text the model gets, the melody comparison and the checks that decide whether a section is kept.

Ported from the AI Creative Studio's Music Rework Studio V3 (longform_core.py: plan/assemble; producer.py: compose;
quality.py: sequence). What changed, and why:
- The source's live test of a long song failed: section 2 asked for 183.6 s and YuE2 ended at 120.6 s (the model
  emitted its end token early; its duration is a ceiling, not a promise). Two fixes here and one in cover.py:
  * sections are shorter (`CHUNK_SECONDS` 100 instead of 175), so each generation is a short, well-conditioned score;
  * `min_frames()` is the number of music frames before which the end token is refused (cover.py applies it to
    ComfyUI's YuE2 sampler), so a section can no longer stop at two thirds;
  * a section that is still outside the time-fit window is never stretched or padded: `fit_ratio()` refuses it, the
    engine tries once more with another seed, and a section that still fails stops the song (its drafts are kept).
- The tempo hint is no longer a number copied from the first section into every other one (the source's 95 vs
  104 BPM conflict): the style text carries no BPM at all — the tempo is the supplied score's.
"""
import math
from difflib import SequenceMatcher

import numpy as np

MAX_SECONDS = 1200          # 20 minutes per song
SINGLE_MAX_SECONDS = 130    # one generation up to this length; a longer song is generated in sections
CHUNK_SECONDS = 100
OVERLAP_SECONDS = 8
FRAMES_PER_SECOND = 25      # YuE2 music tokens per second (comfy/text_encoders/yue2.py)
MIN_FRACTION = .97          # a section's music may not end before 97 % of its score
FIT = (.9, 1.1)             # tempo correction allowed to lay a section exactly on its score time (pitch kept)
TEMPO = {"original": 1.0, "slower": .92, "faster": 1.08}


def plan(duration, valleys=(), beats=(), chunk_seconds=CHUNK_SECONDS, overlap=OVERLAP_SECONDS, single_max=SINGLE_MAX_SECONDS):
    """Sections of [0, duration] (source seconds). A section boundary is a low-energy valley near the target length,
    preferably on a beat. Each section reaches overlap/2 into its neighbours, for the cross-fade.
    valleys: [(seconds, energy 0..1)], beats: [seconds]."""
    if not math.isfinite(duration) or not 8 <= duration <= MAX_SECONDS:
        raise ValueError("المدة المدعومة من 8 ثوانٍ إلى 20 دقيقة")
    if chunk_seconds < 24 or overlap < 1 or overlap >= chunk_seconds / 3:
        raise ValueError("Invalid section limits")
    cuts = [0.]
    if duration > single_max:
        while duration - cuts[-1] > chunk_seconds + 20:
            ideal = cuts[-1] + chunk_seconds
            near = [(t, e) for t, e in valleys if abs(t - ideal) <= 12 and t - cuts[-1] >= chunk_seconds - 12]

            def cost(item):
                t, e = item
                beat = min((abs(t - b) for b in beats if abs(t - b) < 2), default=2)
                return e + abs(t - ideal) / 24 + beat * .15
            cuts.append(float(min(near, key=cost)[0] if near else ideal))
    cuts.append(float(duration))
    chunks = []
    for i, (a, b) in enumerate(zip(cuts, cuts[1:])):
        chunks.append({"index": i + 1, "core_start": a, "core_end": b,
                       "start": max(0., a - overlap / 2) if i else 0., "end": min(duration, b + overlap / 2) if i < len(cuts) - 2 else duration})
    return {"duration": duration, "cuts": cuts, "chunks": chunks, "overlap": overlap if len(chunks) > 1 else 0,
            "method": "low-energy valley near the target length and a beat; a heuristic phrase boundary, not a recognised section"}


def min_frames(expected_seconds, ceiling_seconds):
    """Music frames before which YuE2 may not end (97 % of the score), below the generation's ceiling."""
    return max(1, min(round(expected_seconds * MIN_FRACTION * FRAMES_PER_SECOND), round(ceiling_seconds * FRAMES_PER_SECOND) - 1))


def fit_ratio(actual, expected):
    """The tempo ratio that lays `actual` seconds on `expected` (pitch kept), or None when it is outside the window
    (the section is then refused, never stretched further, repeated or padded with silence)."""
    if not expected > 0 or not actual > 0:
        return None
    r = actual / expected
    return r if FIT[0] <= r <= FIT[1] else None


def score_time(grid, s):
    """Score seconds at source second `s` of a section: piecewise linear through the bar grid (source bar starts ↔ the
    score's bar starts at its fixed tempo), extended with the first/last bar's slope. A sung song drifts in tempo; the
    score does not — this keeps a section's ends on the right notes. grid: {"source": [...], "score": [...]}, the bar
    starts plus the end of the last bar in both times."""
    xs, ys = grid["source"], grid["score"]
    if len(xs) < 2:
        return s
    i = 0 if s < xs[0] else len(xs) - 2 if s >= xs[-1] else max(k for k in range(len(xs) - 1) if xs[k] <= s)
    return ys[i] + (s - xs[i]) * (ys[i + 1] - ys[i]) / max(xs[i + 1] - xs[i], 1e-6)


def window(grid, length, ratio, actual, expected):
    """Where a section's source span [0, length] is in the generated take (seconds): through score_time, the tempo
    change (ratio) and the take's own pace (actual / expected score seconds). Clamped to the take."""
    k = actual / max(expected, 1e-6)
    g0 = score_time(grid, 0.) / ratio * k
    g1 = score_time(grid, length) / ratio * k
    return max(0., g0), min(actual, g1)


def assemble(chunks, waves, sr, ratio=1.):
    """Join sections that each cover exactly [start, end] / ratio seconds: equal-power cross-fade over the overlap,
    a bounded gain match (±3 dB) applied to the whole next section. Raises when a sample would stay uncovered."""
    if len(chunks) != len(waves) or not chunks:
        raise ValueError("Incomplete section set")
    total = round(chunks[-1]["end"] / ratio * sr)
    out = np.zeros((total, 2), np.float32)
    covered = np.zeros(total, np.bool_)
    seams = []
    previous_end = 0

    def rms(z):
        return float(np.sqrt(np.mean(z.astype(np.float64) ** 2) + 1e-15))
    for i, (c, x) in enumerate(zip(chunks, waves)):
        a = round(c["start"] / ratio * sr)
        b = round(c["end"] / ratio * sr)
        if x.shape != (b - a, 2) or not np.isfinite(x).all():
            raise ValueError("Section length/shape is not aligned")
        if i == 0:
            out[a:b] = x
            covered[a:b] = True
            previous_end = b
            continue
        overlap = previous_end - a
        if overlap <= 0 or overlap >= len(x):
            raise ValueError("No valid overlap at a join")
        left = out[a:previous_end].copy()
        gain = float(np.clip(rms(left) / max(rms(x[:overlap]), 1e-7), 10 ** (-3 / 20), 10 ** (3 / 20)))
        x = x * gain
        right = x[:overlap]
        t = np.linspace(0, 1, overlap, dtype=np.float32)[:, None]
        w = .5 - .5 * np.cos(np.pi * t)
        rho = float(np.clip(np.mean(left * right) / (rms(left) * rms(right)), 0, 1))
        mixed = (left * (1 - w) + right * w) / np.sqrt((1 - w) ** 2 + w * w + 2 * rho * w * (1 - w))
        out[a:previous_end] = mixed
        out[previous_end:b] = x[overlap:]
        covered[a:b] = True
        window = max(1, int(.1 * sr))
        levels = [rms(mixed[k:k + window]) for k in range(0, len(mixed), window)]
        drop = 20 * math.log10(max(min(levels), 1e-9) / max(rms(left), rms(right), 1e-9))
        seams.append({"at_seconds": round(c["core_start"] / ratio, 3), "overlap_seconds": round(overlap / sr, 3), "gain_db": round(20 * math.log10(gain), 2),
                      "minimum_100ms_relative_db": round(drop, 2), "silence_warning": drop < -24, "requires_listening": True})
        previous_end = b
    if not covered.all():
        raise ValueError("Uncovered samples; silence padding is forbidden")
    return out, seams


def style_text(preset, variant="Classic", description="", median_pitch=None, section=None):
    """What YuE2 is asked for (source: producer.compose + legacy.Render): the preset's ensemble, one lead, the cover
    policy, the source register, the user's words. No tempo number (the score carries it). `section`: (index, total)
    of a long song — inner sections are told not to start or end like a song."""
    parts = ["Instrumental cover. Lead instrument: " + preset["lead"] + ".", preset["prompt"],
             "One melodic lead at a time. Leave rests between phrases; the answering instrument enters only in those gaps. Keep accompaniment below and away from the lead register.",
             preset.get("ornaments", ""), preset.get("dynamics", ""), preset["variants"].get(variant, preset["variants"]["Classic"])["direction"],
             "Faithful cover: retain the supplied melody, original register, recognizable note sequence and phrase timing. No octave doubling of the lead."]
    if median_pitch is not None:
        parts.append(f"Keep the melodic lead around source MIDI pitch {median_pitch:.0f}, in the source octave.")
    if section and section[1] > 1:
        i, n = section
        parts.append("Continuous arrangement section; keep the same instruments and pulse." + ("" if i == 1 else " No separate introduction.") + ("" if i == n else " No ending cadence, no fade, no pause at the end."))
    if description.strip():
        parts.append("User direction: " + description.strip()[:600])
    parts.append("Instrumental performance, the vocal melody carried by the lead instrument; no sung words. No human voice, no vocals, no humming, no choir.")
    return " ".join(p.strip() for p in parts if p and p.strip())


def melody(ref, out):
    """Ordered note comparison of the source melody and the re-transcribed result (source: quality.sequence).
    ref/out: [(seconds, midi, seconds)]. Pitch classes and interval direction only: not a percentage of melody kept."""
    a = [int(n[1]) for n in ref][:1600]
    b = [int(n[1]) for n in out][:1600]
    if len(a) < 8 or len(b) < 8:
        return {"sufficient": False, "source_notes": len(a), "output_notes": len(b)}
    match = SequenceMatcher(None, [p % 12 for p in a], [p % 12 for p in b], autojunk=False)
    pairs = [(a[k.a + i], b[k.b + i]) for k in match.get_matching_blocks() for i in range(k.size)]
    shift = float(np.median([y - x for x, y in pairs])) if pairs else float(np.median(b) - np.median(a))

    def steps(n):
        return [int(np.sign(y - x)) for x, y in zip(n, n[1:])]
    return {"sufficient": True, "source_notes": len(a), "output_notes": len(b), "pitch_class_sequence_ratio": round(match.ratio(), 4),
            "contour_direction_ratio": round(SequenceMatcher(None, steps(a), steps(b), autojunk=False).ratio(), 4),
            "matched_register_shift_semitones": shift, "source_median_pitch": float(np.median(a)), "output_median_pitch": float(np.median(b)),
            "limits": "Monophonic re-transcription; ordered pitch classes and interval direction only — misses phrasing, microtones and timbre."}


def verdict(cmp, vocal_notes, fit):
    """Checks of one take: failures (the take is not kept when another passes) and warnings (listening needed)."""
    fail, warn = [], []
    if fit is None:
        fail.append("طول الجزء الناتج بعيد عن طول النوتة؛ لا نمطّه ولا نكمّله بصمت")
    if vocal_notes > 0:
        fail.append(f"رُصدت {vocal_notes} نغمة غناء في الناتج")
    if cmp.get("sufficient"):
        ratio, shift = cmp["pitch_class_sequence_ratio"], abs(cmp["matched_register_shift_semitones"])
        # Calibrated on one song (عيون القلب): two different melodies of it score 0.09–0.25; covers 0.44–0.90.
        if ratio < .35:
            fail.append("تسلسل النغمات بعيد عن لحن الأصل")
        elif ratio < .7:
            warn.append("تسلسل النغمات تغيّر بوضوح؛ راجع اللحن بالاستماع")
        # The same melody an octave away (an instrument's register) is kept; another key is not.
        if shift >= 7:
            warn.append("اللحن اتعزف في أوكتاف تاني غير صوت المطرب" if abs(shift) % 12 <= 1 or abs(shift) % 12 >= 11 else "نطاق اللحن مختلف عن الأصل؛ راجع الطبقة بالاستماع")
    else:
        warn.append("نغمات قليلة لمقارنة لحنية موثوقة")
    penalty = len(fail) * 10 + len(warn) + (1 - cmp.get("pitch_class_sequence_ratio", 0)) * 5
    return {"failures": fail, "warnings": warn, "passed": not fail, "penalty": round(penalty, 3)}
