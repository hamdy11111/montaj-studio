# Dubbing: Arabic speech → another language, spoken in each speaker's own (cloned) voice, with the emotion of the line,
# fitted to the original timing; music, ambience and effects are kept. Runs in the program's dubbing runtime
# (runtime/dub); the speech/background split is made before by the separation runtime (runtime/sep), the words come
# from the app's transcript (the Egyptian model). Three stages, each a subcommand writing JSON in the work folder:
#   analyze    who speaks when (sherpa-onnx: pyannote segmentation 3.0 + NeMo TitaNet-L embeddings, clustered), each
#              speaker's kind (man / woman / child: pitch + an ECAPA gender classifier + a wav2vec2 child classifier)
#              and a clean voice sample per speaker
#   translate  through a local LLM (llama.cpp server): the Arabic corrected with the whole video as context, cut into
#              whole sentences that never cross a speaker change, each translated to fit its time slot, with emotion
#   synth      Chatterbox (MIT) speaks each line in its speaker's voice (emotion → exaggeration); a line too long is
#              sped up (≤ 1.2×) or rewritten shorter, then placed on the original start; the background is lowered a
#              little under the new voice; voice, background and mix are written as WAV files
# Progress: "PROGRESS <0..1> <stage>" lines on stderr. Everything stays on this computer.
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def progress(p, stage):
    print(f"PROGRESS {max(0.0, min(1.0, p)):.3f} {stage}", file=sys.stderr, flush=True)


def jload(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def jsave(obj, p):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def load_mono(path, sr):
    import numpy as np
    import soundfile as sf
    import librosa
    a, s = sf.read(path, dtype="float32", always_2d=True)
    a = a.mean(1)
    if s != sr:
        a = librosa.resample(a, orig_sr=s, target_sr=sr)
    return np.ascontiguousarray(a, dtype=np.float32)


# ------------------------------------------------------------------ analyze
def diarize(a16, models, threads=8, threshold=0.7):
    import sherpa_onnx
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=os.path.join(models, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")),
            num_threads=threads),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=os.path.join(models, "nemo_en_titanet_large.onnx"), num_threads=threads),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=threshold),
        min_duration_on=0.3, min_duration_off=0.5)
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    res = sd.process(a16).sort_by_start_time()
    return [(r.start, r.end, int(r.speaker)) for r in res]


def speaker_of(t0, t1, turns):
    best, bo = None, 0.0
    for a, b, s in turns:
        o = min(b, t1) - max(a, t0)
        if o > bo:
            best, bo = s, o
    if best is None and turns:  # no overlap: the nearest turn
        best = min(turns, key=lambda x: min(abs(x[0] - t1), abs(x[1] - t0)))[2]
    return best if best is not None else 0


def median_f0(a16, spans):
    import numpy as np
    import librosa
    vals = []
    for t0, t1 in spans:
        seg = a16[int(t0 * 16000):int(t1 * 16000)]
        if len(seg) < 3200:
            continue
        f0, vflag, _ = librosa.pyin(seg, fmin=65, fmax=500, sr=16000, frame_length=1024)
        vals.extend(f0[vflag & ~np.isnan(f0)].tolist())
        if len(vals) > 3000:
            break
    return float(np.median(vals)) if vals else None


def classify_speakers(a16, spans_by_speaker, models_dir, dev):
    """{speaker: {f0, gender, child, kind}} — pitch first; the classifiers where the pitch is not decisive."""
    import numpy as np
    import torch
    out = {}
    gender_model = child = None
    try:
        sys.path.insert(0, HERE)
        from ecapa_gender import ECAPA_gender
        gender_model = ECAPA_gender.from_pretrained("JaesungHuh/voice-gender-classifier", cache_dir=os.path.join(models_dir, "hf")).to(dev).eval()
    except Exception as e:  # noqa: BLE001
        print("gender model unavailable:", e, file=sys.stderr)
    try:
        from transformers import pipeline
        child = pipeline("audio-classification", model="bookbot/wav2vec2-xls-r-adult-child-cls", device=0 if dev == "cuda" else -1, model_kwargs={"cache_dir": os.path.join(models_dir, "hf")})
    except Exception as e:  # noqa: BLE001
        print("child model unavailable:", e, file=sys.stderr)
    for spk, spans in spans_by_speaker.items():
        spans = sorted(spans, key=lambda x: -(x[1] - x[0]))
        clip, total = [], 0.0
        for t0, t1 in spans:
            clip.append(a16[int(t0 * 16000):int(t1 * 16000)])
            total += t1 - t0
            if total > 25:
                break
        sample = np.concatenate(clip) if clip else np.zeros(16000, dtype=np.float32)
        f0 = median_f0(a16, spans[:20])
        g = None
        if gender_model is not None and len(sample) > 16000:
            with torch.no_grad():
                logits = gender_model(torch.from_numpy(sample[: 16000 * 20]).unsqueeze(0).to(dev))
                pf = float(torch.softmax(logits, 1)[0, 1])
            g = "female" if pf > 0.5 else "male"
        else:
            pf = None
        if f0 is not None and (g is None or (f0 < 145 and g == "female" and (pf or 0) < 0.8) or (f0 > 200 and g == "male" and (pf or 1) > 0.2)):
            g = "male" if f0 < 165 else "female"  # the pitch decides when the classifier is unsure and the pitch is clear
        pc = None
        if child is not None and len(sample) > 16000:
            r = child({"array": sample[: 16000 * 15], "sampling_rate": 16000})
            pc = next((x["score"] for x in r if "child" in x["label"].lower()), None)
        is_child = bool(pc is not None and pc > 0.7 and (f0 or 0) > 220)
        out[spk] = {"f0": round(f0, 1) if f0 else None, "gender": g or "male", "pFemale": round(pf, 3) if pf is not None else None,
                    "pChild": round(pc, 3) if pc is not None else None, "child": is_child,
                    "kind": "child" if is_child else (g or "male"), "speech": round(sum(b - a for a, b in spans), 1)}
    return out


def reference_clip(a_full, sr, spans, out_path, target=10.0):
    """A clean voice sample: the speaker's longest steady stretches, 6–12 s, joined with short gaps."""
    import numpy as np
    import soundfile as sf
    parts, total = [], 0.0
    for t0, t1 in sorted(spans, key=lambda x: -(x[1] - x[0])):
        if t1 - t0 < 1.2:
            continue
        seg = a_full[int(t0 * sr):int(t1 * sr)]
        if not len(seg):
            continue
        parts.append(seg)
        parts.append(np.zeros(int(0.15 * sr), dtype=np.float32))
        total += t1 - t0
        if total >= target:
            break
    if not parts:
        return None
    clip = np.concatenate(parts)[: int(12 * sr)]
    peak = float(np.max(np.abs(clip))) or 1.0
    sf.write(out_path, clip / peak * 0.9, sr)
    return out_path


SAME_VOICE = 0.55  # TitaNet cosine between two speakers' samples: one person measured 0.61-0.91, two people 0.29


def voice_print(path, models):
    import numpy as np
    import sherpa_onnx
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=os.path.join(models, "nemo_en_titanet_large.onnx"), num_threads=4))
    st = ex.create_stream()
    st.accept_waveform(16000, load_mono(path, 16000))
    st.input_finished()
    e = np.array(ex.compute(st))
    return e / (np.linalg.norm(e) + 1e-9)


def same_voice(refs, profiles, models):
    """{speaker: the speaker it is the same person as} — pairs of the same kind whose voices match, the one who
    speaks less joining the one who speaks more, the closest pair first."""
    import itertools
    prints = {k: voice_print(r, models) for k, r in refs.items() if r}
    pairs = sorted(((float(prints[x] @ prints[y]), x, y) for x, y in itertools.combinations(prints, 2)), reverse=True)
    into = {}
    root = lambda k: root(into[k]) if k in into else k  # noqa: E731
    for sim, x, y in pairs:
        x, y = root(x), root(y)
        if sim < SAME_VOICE or x == y or profiles[x]["kind"] != profiles[y]["kind"]:
            continue
        small, big = (x, y) if profiles[x]["speech"] < profiles[y]["speech"] else (y, x)
        into[small] = big
        print(f"speaker {small} is {big} (voice match {sim:.2f})", file=sys.stderr)
    return {k: root(k) for k in into}


def cmd_analyze(a):
    import numpy as np
    import torch
    dev = "cuda" if torch.cuda.is_available() and a.device != "cpu" else "cpu"
    progress(0.02, "speakers")
    words = [w for s in jload(a.words)["segments"] for w in s["words"]] if a.words.endswith(".json") else []
    a16 = load_mono(a.vocals, 16000)
    turns = diarize(a16, a.models)
    progress(0.6, "speakers")
    for w in words:
        w["spk"] = speaker_of(w["start"], w["end"], turns)
    # A run of under 1 s inside another speaker's talk (the same speaker before and after) is a diarization slip.
    runs, k = [], 0
    while k < len(words):
        m = k
        while m + 1 < len(words) and words[m + 1]["spk"] == words[k]["spk"]:
            m += 1
        runs.append((k, m))
        k = m + 1
    for r in range(1, len(runs) - 1):
        a0, a1 = runs[r]
        if words[a1]["end"] - words[a0]["start"] < 1.0 and words[runs[r - 1][0]]["spk"] == words[runs[r + 1][0]]["spk"]:
            for k in range(a0, a1 + 1):
                words[k]["spk"] = words[runs[r - 1][0]]["spk"]
    # Each speaker's stretches of speech: runs of their words (gaps < 0.6 s), clipped to the diarization.
    spans_by = {}
    run = None
    for w in words:
        if run and run[2] == w["spk"] and w["start"] - run[1] < 0.6:
            run[1] = w["end"]
        else:
            if run:
                spans_by.setdefault(run[2], []).append((run[0], run[1]))
            run = [w["start"], w["end"], w["spk"]]
    if run:
        spans_by.setdefault(run[2], []).append((run[0], run[1]))
    profiles = classify_speakers(a16, spans_by, a.models, dev)
    progress(0.85, "speakers")
    a24 = load_mono(a.vocals, 24000)
    refs = {}
    for spk, spans in spans_by.items():
        refs[spk] = reference_clip(a24, 24000, spans, os.path.join(a.out, f"ref_S{spk}.wav"))
    # One person split in two clusters (a change of tone, of distance to the microphone) is one speaker again.
    joined = same_voice(refs, profiles, a.models)
    if joined:
        for w in words:
            w["spk"] = joined.get(w["spk"], w["spk"])
        for small, big in joined.items():
            spans_by.setdefault(big, []).extend(spans_by.pop(small, []))
            profiles[big]["speech"] = round(profiles[big]["speech"] + profiles.pop(small)["speech"], 2)
            if refs.get(small):
                os.remove(refs.pop(small))
        for big in set(joined.values()):
            refs[big] = reference_clip(a24, 24000, spans_by[big], os.path.join(a.out, f"ref_S{big}.wav"))
    # Speakers who say almost nothing (a stray cluster) are merged into the nearest real speaker by time.
    main = {s for s, p in profiles.items() if p["speech"] >= 2.0} or set(profiles)
    for w in words:
        if w["spk"] not in main:
            w["spk"] = min(main, key=lambda s: min(abs(t0 - w["start"]) for t0, _ in spans_by[s]))
    speakers = [{"id": s, **profiles[s], "ref": refs.get(s)} for s in sorted(main)]
    jsave({"words": words, "turns": turns, "speakers": speakers}, os.path.join(a.out, "analysis.json"))
    progress(1, "speakers")
    print(json.dumps({"speakers": speakers}, ensure_ascii=False))


# ------------------------------------------------------------------ translate
def llm(server, system, user, temperature=0.3, max_tokens=4096, think=False, attempts=3):
    body = {"model": "local", "temperature": temperature, "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "chat_template_kwargs": {"enable_thinking": think}}
    if not think:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(server.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    err = None
    for attempt in range(attempts):
        try:
            r = json.load(urllib.request.urlopen(req, timeout=1800))
            txt = r["choices"][0]["message"]["content"]
            txt = txt[txt.find("{"): txt.rfind("}") + 1]
            return json.loads(txt)
        except Exception as e:  # noqa: BLE001 — retry a malformed answer
            err = e
    raise RuntimeError(f"translation server failed: {err}")


LANG_NAMES = {"en": "English", "fr": "French", "es": "Spanish", "de": "German", "it": "Italian", "pt": "Portuguese", "tr": "Turkish", "ru": "Russian",
              "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "hi": "Hindi", "nl": "Dutch", "pl": "Polish", "sv": "Swedish", "da": "Danish", "fi": "Finnish",
              "no": "Norwegian", "el": "Greek", "he": "Hebrew", "ms": "Malay", "sw": "Swahili", "ar": "Arabic"}
# Characters per second a voice speaks, per language (the room a line has); refined per speaker in synth.
CPS = {"en": 15.0, "fr": 15.5, "es": 15.5, "de": 14.5, "it": 15.5, "pt": 15.5, "tr": 14.0, "ru": 14.0, "zh": 5.0, "ja": 7.5, "ko": 7.5, "hi": 13.0}

SEGMENT_SYSTEM = """You prepare an Egyptian Arabic video for dubbing. You get the words of the transcript from automatic speech recognition, each as "index|word"; "‖" marks a pause, "[S2]" marks that speaker 2 starts talking. The recognition has mistakes (missing ta marbuta, a word that sounds alike, names and places misheard). Using the whole context and the video summary:
1. Split the words into dubbing lines: each line is one complete sentence or a complete clause that can be said alone, about 1.5 to 8 seconds long, never across a speaker change, preferably ending at a pause. Every index must belong to exactly one line, in order.
2. For each line give "ar": what the speaker really said, in correct Arabic spelling (keep the Egyptian dialect, fix recognition errors, names and places; do not add or drop meaning).
Return only JSON: {"lines":[{"from": first_index, "to": last_index, "ar": "..."}]}"""

SUMMARY_SYSTEM = """You read the automatic transcript (with recognition errors) of an Egyptian Arabic video. Misheard names are common: work out the REAL people, places, institutions and products that the sounds most likely refer to (use your knowledge of real-world names, e.g. a real city, university or company that sounds similar), and how they are spelled correctly in Arabic and in English. Return only JSON: {"summary": "3-5 sentences in English: what the video is about, who speaks, the setting", "names": ["each real name as: misheard form -> correct Arabic -> correct English"], "tone": "the overall tone"}"""

TRANSLATE_SYSTEM = """You are a professional dubbing translator. Translate each Egyptian Arabic line into natural, spoken {lang} — what a native speaker would really say in that situation, keeping the meaning, the names, and the speaker's register (casual stays casual). Each line will be spoken by a voice actor in the given number of seconds, so it MUST fit: at most max_chars characters; if the full meaning does not fit, keep the essential meaning in fewer words. Lines continue each other (a sentence may run over two lines); keep the flow natural across lines, using the lines before and after for context.
The transcript has no punctuation: questions are not marked — when a speaker (often the interviewer) asks something, translate it as a question. Use the names list as given; never invent a surname (a word after a name is usually a description, e.g. "أحمد مهندس" = "Ahmed, an engineer"). Keep who says what: "I" stays the speaker.
Also give "emotion": one of neutral, happy, excited, sad, angry, surprised, serious, warm, curious — how the speaker sounds on this line; and "intensity": 0.0 to 1.0.
Return only JSON: {{"lines":[{{"id": .., "text": "...", "emotion": "...", "intensity": ..}}]}}"""

SHORTEN_SYSTEM = """You shorten one line of a {lang} dub so it can be spoken in less time. Keep the meaning and the tone, natural spoken {lang}, at most {max_chars} characters. Use complete, real words only — never cut or abbreviate a word. Return only JSON: {{"text": "..."}}"""


def fallback_lines(words, i0, i1):
    """Lines by rule when the LLM's split is unusable: a speaker change, a pause ≥ 0.6 s, or 8 s ends a line."""
    out, start = [], i0
    for i in range(i0, i1 + 1):
        nxt = i + 1
        end = nxt > i1 or words[nxt]["spk"] != words[i]["spk"] or words[nxt]["start"] - words[i]["end"] >= 0.6 or words[i]["end"] - words[start]["start"] >= 8
        if end:
            out.append({"from": start, "to": i, "ar": " ".join(w["word"] for w in words[start:i + 1])})
            start = nxt
    return out


def repair_lines(got, words, i0, i1):
    """The model's lines made usable instead of thrown away: gaps and overlaps filled by rule, a line split at any pause
    of 1.5 s or more and at a real change of speaker; a speaker label on less than 1.2 s of a line is taken as a
    diarization slip at a turn's edge and corrected. Returns (lines, repairs)."""
    out, pos, fixes = [], i0, 0
    for l in sorted([x for x in got if isinstance(x.get("from"), int) and isinstance(x.get("to"), int)], key=lambda x: x["from"]):
        f, t = max(l["from"], pos), min(l["to"], i1)
        if t < f:
            fixes += 1
            continue
        if f > pos:
            out.extend(fallback_lines(words, pos, f - 1)); fixes += 1
        out.append({"from": f, "to": t, "ar": l.get("ar") if (f, t) == (l["from"], l["to"]) else " ".join(w["word"] for w in words[f:t + 1])})
        pos = t + 1
    if pos <= i1:
        out.extend(fallback_lines(words, pos, i1)); fixes += 1
    final = []
    for l in out:
        idx = list(range(l["from"], l["to"] + 1))
        dur = {}
        for k in idx:
            dur[words[k]["spk"]] = dur.get(words[k]["spk"], 0) + words[k]["end"] - words[k]["start"]
        major = max(dur, key=dur.get)
        if len(dur) > 1 and sum(v for s, v in dur.items() if s != major) < 1.2:
            for k in idx:
                words[k]["spk"] = major
            fixes += 1
        cuts = [k for k in idx[1:] if words[k]["spk"] != words[k - 1]["spk"] or words[k]["start"] - words[k - 1]["end"] >= 1.5]
        if not cuts:
            final.append(l)
            continue
        fixes += 1
        start = l["from"]
        for c in cuts + [l["to"] + 1]:
            final.append({"from": start, "to": c - 1, "ar": " ".join(w["word"] for w in words[start:c])})
            start = c
    return final, fixes


EMOTIONS = ("neutral", "happy", "excited", "sad", "angry", "surprised", "serious", "warm", "curious")


def cmd_translate(a):
    an = jload(os.path.join(a.out, "analysis.json"))
    words = an["words"]
    lang = LANG_NAMES.get(a.lang, a.lang)
    spk_kind = {s["id"]: s["kind"] for s in an["speakers"]}
    progress(0.02, "translate")
    text = " ".join(w["word"] for w in words)
    # The summary (who is named, what it is about) with the model thinking first; when the thinking runs out of
    # room (a long video), once more without it; the translation goes on without a summary when both fail.
    summ = {}
    for think, budget in ((True, 9000), (False, 1500)):
        try:
            summ = llm(a.server, SUMMARY_SYSTEM, text[:12000], temperature=0.2, max_tokens=budget, think=think, attempts=1 if think else 2)
            break
        except Exception as e:  # noqa: BLE001
            print("summary failed" + (" (thinking)" if think else "") + ":", e, file=sys.stderr)
    context = f"Video summary: {summ.get('summary', '')}\nNames: {', '.join(summ.get('names', []))}\n" + (f"Note from the editor: {a.context}\n" if a.context else "")
    progress(0.1, "translate")
    # 1. Lines (correct Arabic), in chunks of ~180 words that end at a pause.
    lines, i = [], 0
    while i < len(words):
        j = min(len(words) - 1, i + 180)
        while j < len(words) - 1 and j > i + 120 and words[j + 1]["start"] - words[j]["end"] < 0.5:
            j -= 1
        toks = []
        for k in range(i, j + 1):
            if k > i and words[k]["spk"] != words[k - 1]["spk"]:
                toks.append(f"[S{words[k]['spk'] + 1}]")
            elif k > i and words[k]["start"] - words[k - 1]["end"] >= 0.35:
                toks.append("‖")
            toks.append(f"{k}|{words[k]['word']}")
        try:
            got = llm(a.server, SEGMENT_SYSTEM, context + "\nWords:\n" + " ".join(toks), temperature=0.2, max_tokens=6000).get("lines", [])
        except Exception as e:  # noqa: BLE001
            print("segmentation failed, using pauses:", e, file=sys.stderr)
            got = []
        part, fixes = repair_lines(got, words, i, j) if got else (fallback_lines(words, i, j), -1)
        if fixes:
            print(f"lines {i}-{j}: {'split by pauses' if fixes < 0 else f'{fixes} repairs'}", file=sys.stderr)
        lines.extend(part)
        i = j + 1
        progress(0.1 + 0.4 * i / len(words), "translate")
    # A fragment under 0.7 s joins the line before it when the same speaker says it right after (< 0.5 s), else the
    # line after it when that follows right away (< 0.5 s) — a word cut off at a turn's edge belongs to its sentence.
    merged = []
    for l in lines:
        ws = words[l["from"]:l["to"] + 1]
        p = merged[-1] if merged else None
        if p and ws[-1]["end"] - ws[0]["start"] < 0.7 and words[p["to"]]["spk"] == ws[0]["spk"] and ws[0]["start"] - words[p["to"]]["end"] < 0.5:
            p["to"], p["ar"] = l["to"], f"{p['ar']} {l['ar']}"
        else:
            merged.append(l)
    lines, k = [], 0
    while k < len(merged):
        l = merged[k]
        ws = words[l["from"]:l["to"] + 1]
        nx = merged[k + 1] if k + 1 < len(merged) else None
        if nx and ws[-1]["end"] - ws[0]["start"] < 0.7 and words[nx["from"]]["start"] - ws[-1]["end"] < 0.5:
            for i in range(l["from"], l["to"] + 1):
                words[i]["spk"] = words[nx["from"]]["spk"]
            nx["from"], nx["ar"] = l["from"], f"{l['ar']} {nx['ar']}"
        else:
            lines.append(l)
        k += 1
    # Timing of each line: from its first word; its room runs to the next line (or 0.8 s of silence after it).
    for n, l in enumerate(lines):
        ws = words[l["from"]:l["to"] + 1]
        l["id"], l["spk"] = n, ws[0]["spk"]
        l["start"], l["end"] = ws[0]["start"], ws[-1]["end"]
    for n, l in enumerate(lines):
        nxt = lines[n + 1]["start"] if n + 1 < len(lines) else l["end"] + 1.5
        l["slot"] = round(max(l["end"] - l["start"], min(nxt - 0.12, l["end"] + 0.8) - l["start"]), 2)
        l["maxChars"] = max(12, int(l["slot"] * CPS.get(a.lang, 14.0)))
    # 2. Translation with emotion, ~25 lines a call, the previous lines as context.
    for b in range(0, len(lines), 25):
        chunk = lines[b:b + 25]
        prev = [{"speaker": f"S{x['spk'] + 1}", "ar": x["ar"], "text": x.get("text", "")} for x in lines[max(0, b - 4):b]]
        after = [{"speaker": f"S{x['spk'] + 1}", "ar": x["ar"]} for x in lines[b + 25:b + 29]]
        req = {"context": context, "previous_lines": prev, "following_lines": after, "lines": [{"id": x["id"], "speaker": f"S{x['spk'] + 1} ({spk_kind.get(x['spk'], 'adult')})", "ar": x["ar"], "seconds": x["slot"], "max_chars": x["maxChars"]} for x in chunk]}
        try:
            got = {g.get("id"): g for g in llm(a.server, TRANSLATE_SYSTEM.format(lang=lang), json.dumps(req, ensure_ascii=False), temperature=0.3, max_tokens=6000).get("lines", [])}
        except Exception as e:  # noqa: BLE001 — the lines go one at a time below
            print(f"lines {b}-{b + len(chunk) - 1}: batch translation failed:", e, file=sys.stderr)
            got = {}
        for x in chunk:
            g = got.get(x["id"]) or {}
            x["text"] = str(g.get("text") or "").strip()
            x["emotion"] = g.get("emotion") if g.get("emotion") in EMOTIONS else "neutral"
            try:
                x["intensity"] = max(0.0, min(1.0, float(g.get("intensity", 0.4))))
            except (TypeError, ValueError):
                x["intensity"] = 0.4
        for x in chunk:  # too long for its time: said shorter now (cheaper than after the voice is made)
            if x["text"] and len(x["text"]) > x["maxChars"] * 1.15:
                try:
                    x["text"] = str(llm(a.server, SHORTEN_SYSTEM.format(lang=lang, max_chars=x["maxChars"]), json.dumps({"line": x["text"], "meaning_in_arabic": x["ar"]}, ensure_ascii=False), temperature=0.3, max_tokens=300).get("text") or x["text"]).strip()
                except Exception as e:  # noqa: BLE001
                    print("shorten failed:", e, file=sys.stderr)
        missing = [x for x in chunk if not x["text"]]
        for x in missing:  # one line at a time when the batch dropped it
            try:
                g = llm(a.server, TRANSLATE_SYSTEM.format(lang=lang), json.dumps({"context": context, "lines": [{"id": x["id"], "ar": x["ar"], "seconds": x["slot"], "max_chars": x["maxChars"]}]}, ensure_ascii=False))
                g = (g.get("lines") or [{}])[0]
                x["text"] = str(g.get("text") or "").strip()
                if g.get("emotion") in EMOTIONS:
                    x["emotion"] = g["emotion"]
            except Exception as e:  # noqa: BLE001
                print(f"line {x['id']}: translation failed:", e, file=sys.stderr)
            if not x["text"]:
                x["untranslated"] = True  # left silent; the dialog shows it empty for the user to fill in
        progress(0.5 + 0.5 * min(1, (b + 25) / len(lines)), "translate")
    jsave({"lang": a.lang, "summary": summ, "lines": lines, "speakers": an["speakers"]}, os.path.join(a.out, "lines.json"))
    progress(1, "translate")


# ------------------------------------------------------------------ synth
# Emotion → Chatterbox controls. exaggeration: 0.5 is neutral reading; higher is more expressive (and a bit faster).
# cfg_weight lower = slower, more deliberate pacing; for expressive lines a lower cfg keeps them from rushing.
EMOTION = {"neutral": (0.45, 0.5), "serious": (0.42, 0.5), "warm": (0.55, 0.5), "curious": (0.55, 0.45), "happy": (0.65, 0.45),
           "excited": (0.8, 0.35), "surprised": (0.75, 0.4), "sad": (0.55, 0.55), "angry": (0.8, 0.35)}


def trim_silence(w, sr, top_db=40):
    import librosa
    _, (s, e) = librosa.effects.trim(w, top_db=top_db, frame_length=1024, hop_length=256)
    pad = int(0.04 * sr)
    return w[max(0, s - pad):min(len(w), e + pad)]


def atempo(w, sr, factor, ffmpeg):
    """Speed up (factor > 1) without changing the pitch (ffmpeg atempo)."""
    import subprocess
    import numpy as np
    if abs(factor - 1) < 0.01:
        return w
    p = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-", "-af", f"atempo={factor:.4f}", "-f", "f32le", "-"],
                       input=w.astype(np.float32).tobytes(), capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def norm_text(t):
    import unicodedata
    t = unicodedata.normalize("NFKC", t).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", t)).strip()


class Listener:
    """Hears each new line back (Whisper) to catch a voice that said something else — a dropped, repeated or
    invented word. score: 0..1 character similarity of what was heard to what was meant."""

    def __init__(self, lang, dev):
        self.lang, self.model = lang, None
        try:
            from faster_whisper import WhisperModel
            self.model = WhisperModel("large-v3", device=dev, compute_type="float16" if dev == "cuda" else "int8")
        except Exception as e:  # noqa: BLE001
            print("listener unavailable:", e, file=sys.stderr)

    def score(self, w, sr, text):
        if self.model is None:
            return 1.0, ""
        import difflib
        import librosa
        a16 = librosa.resample(w, orig_sr=sr, target_sr=16000) if sr != 16000 else w
        segs, _ = self.model.transcribe(a16, language=self.lang, beam_size=1, condition_on_previous_text=False, without_timestamps=True)
        heard = " ".join(x.text for x in segs).strip()
        a, b = norm_text(text), norm_text(heard)
        sc = difflib.SequenceMatcher(None, a, b).ratio() if a or b else 1.0
        if len(b) > 1.15 * len(a) + 4:  # words the line does not have (a repeated phrase, an invented ending)
            sc = min(sc, 0.7)
        return sc, heard


def rms_db(x):
    import numpy as np
    return 20 * math.log10(float(np.sqrt(np.mean(np.square(x)))) + 1e-9) if len(x) else -120.0


def cmd_synth(a):
    import numpy as np
    import soundfile as sf
    import torch
    data = jload(os.path.join(a.out, "lines.json"))
    lines, speakers = data["lines"], {s["id"]: s for s in data["speakers"]}
    lang = data.get("lang", a.lang)
    dev = "cuda" if torch.cuda.is_available() and a.device != "cpu" else "cpu"
    progress(0.01, "voices")
    if lang == "en":
        from chatterbox.tts import ChatterboxTTS
        model = ChatterboxTTS.from_pretrained(device=dev)
        gen = lambda text, ref, ex, cfg: model.generate(text, audio_prompt_path=ref, exaggeration=ex, cfg_weight=cfg)  # noqa: E731
    else:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        model = ChatterboxMultilingualTTS.from_pretrained(device=dev)
        gen = lambda text, ref, ex, cfg: model.generate(text, language_id=lang, audio_prompt_path=ref, exaggeration=ex, cfg_weight=cfg)  # noqa: E731
    sr = model.sr
    listener = Listener(lang, dev)

    def say(n, text, spk, ex, cfg):
        """The line in the speaker's voice: up to 3 takes (fixed seeds, so a re-run is the same), the first one heard
        back as meant (similarity >= 0.85) or else the closest."""
        best = None
        for take in range(3):
            torch.manual_seed(1000 * (take + 1) + n)
            w = trim_silence(gen(text, spk["ref"], ex, cfg).squeeze(0).cpu().numpy().astype(np.float32), sr)
            sc, heard = listener.score(w, sr, text)
            if best is None or sc > best[1]:
                best = (w, sc, heard, take)
            if sc >= 0.85:
                break
        return best

    vocals = load_mono(a.vocals, sr)
    bg_full = load_mono(a.background, sr) if a.background else None
    total = max(len(vocals), len(bg_full) if bg_full is not None else 0)
    voice = np.zeros(total + sr * 5, dtype=np.float32)
    lang_name = LANG_NAMES.get(lang, lang)
    done, prev_end = 0, -1.0
    for n, l in enumerate(lines):
        # A line already spoken keeps its fitted words (a re-run is the same and needs no translator); a line the user
        # changed is spoken as written, never shortened.
        text = (l.get("spoken") or l.get("text") or "").strip()
        if not text:
            continue
        # A line that ends without a stop runs on (the voice may add words): every line ends with one.
        if not re.search(r"[.!?…。！？]$", text):
            text = re.sub(r"[,;:\-–—\s]+$", "", text) + "."
        spk = speakers.get(l["spk"]) or next(iter(speakers.values()))
        ex0, cfg = EMOTION.get(l.get("emotion"), EMOTION["neutral"])
        ex = min(a.ex_cap, ex0 + 0.25 * (l.get("intensity", 0.4) - 0.4))
        if a.cfg is not None:
            cfg = a.cfg
        slot = l["slot"]
        tries, w = 0, None
        while True:
            w, check, heard, take = say(n, text, spk, ex, cfg)
            dur = len(w) / sr
            if dur <= slot * 1.2 or tries >= 3 or l.get("edited") or not a.server:
                break
            # Too long even sped up 1.2×: the LLM says it shorter (to the room the voice actually needs).
            tries += 1
            target = max(12, int(len(text) * slot / dur * 0.92))
            try:
                text = str(llm(a.server, SHORTEN_SYSTEM.format(lang=lang_name, max_chars=target), json.dumps({"line": text, "meaning_in_arabic": l["ar"]}, ensure_ascii=False), temperature=0.3, max_tokens=300).get("text") or text).strip()
            except Exception as e:  # noqa: BLE001
                print("shorten failed:", e, file=sys.stderr)
                break
        l.pop("tooLong", None)
        if dur > slot * 1.2 and not l.get("edited") and not a.server:
            l["tooLong"] = max(12, int(len(text) * slot / dur * 0.92))  # the characters it should have
        speed = 1.0
        if dur > slot:
            # Sped up to the room it has; past 1.35× it may run into a following gap when that gap is free.
            nxt = lines[n + 1]["start"] if n + 1 < len(lines) else l["start"] + dur + 1
            room = max(slot, nxt - 0.08 - l["start"])
            speed = min(1.35, max(1.0, dur / room))
            w = atempo(w, sr, speed, a.ffmpeg)
            dur = len(w) / sr
        # Loudness of the original line (its voice), within ±6 dB of a common level.
        i0, i1 = int(l["start"] * sr), int(l["end"] * sr)
        target_db = min(-14.0, max(-26.0, rms_db(vocals[i0:i1]) if i1 > i0 else -20.0))
        w = w * (10 ** ((target_db - rms_db(w)) / 20))
        # Never two voices at once: a line still running when this one would start delays it. A delay over 0.3 s is
        # won back by speaking this line faster (up to 1.5× in all), so the lateness does not carry on to the next.
        at = max(l["start"], prev_end + 0.06)
        late = at - l["start"]
        if late > 0.3 and speed < 1.5:
            f = min(1.5 / max(speed, 1.0), dur / max(0.3, dur - late))
            w2 = atempo(w, sr, f, a.ffmpeg)
            speed, w, dur = speed * len(w) / max(1, len(w2)), w2, len(w2) / sr
        l["late"] = round(late, 3)
        prev_end = at + dur
        l["placed"] = round(at, 3)
        s0 = int(at * sr)
        voice[s0:s0 + len(w)] += w[: max(0, len(voice) - s0)]
        l.update({"spoken": text, "duration": round(dur, 2), "speed": round(speed, 3), "exaggeration": round(ex, 2), "cfg": cfg, "shortened": tries,
                  "check": round(check, 3), "heard": heard, "take": take})
        done += 1
        progress(0.02 + 0.9 * (n + 1) / len(lines), "voices")
    voice = voice[:total]
    peak = float(np.max(np.abs(voice))) or 1.0
    if peak > 0.98:
        voice *= 0.98 / peak
    sf.write(os.path.join(a.out, "voice.wav"), voice, sr)
    if bg_full is not None:
        # The background a little lower under the new voice (what is left of the old one disappears under it).
        env = np.zeros(total, dtype=np.float32)
        for l in lines:
            if l.get("duration"):
                t0 = l.get("placed", l["start"])
                env[int(t0 * sr):int((t0 + l["duration"]) * sr)] = 1.0
        k = int(0.12 * sr)
        env = np.convolve(env, np.ones(k) / k, mode="same")
        duck = 10 ** (-a.duck_db * env / 20)
        bg = bg_full[:total] * duck[: len(bg_full[:total])]
        sf.write(os.path.join(a.out, "background.wav"), bg, sr)
        mix = bg + voice[: len(bg)]
        pk = float(np.max(np.abs(mix))) or 1.0
        if pk > 0.98:
            mix *= 0.98 / pk
        sf.write(os.path.join(a.out, "mix.wav"), mix, sr)
    jsave(data, os.path.join(a.out, "lines.json"))
    progress(1, "voices")
    print(json.dumps({"lines": done, "sped": sum(1 for l in lines if l.get("speed", 1) > 1.01), "shortened": sum(1 for l in lines if l.get("shortened")),
                      "tooLong": sum(1 for l in lines if l.get("tooLong")),
                      "doubtful": [n for n, l in enumerate(lines) if l.get("check", 1) < 0.7]}))


def cmd_shorten(a):
    """Lines the voices found too long for their time (synth marked them) said shorter by the translator."""
    data = jload(os.path.join(a.out, "lines.json"))
    lang = LANG_NAMES.get(data.get("lang", a.lang), a.lang)
    todo = [l for l in data["lines"] if l.get("tooLong")]
    for k, l in enumerate(todo):
        text = l.get("spoken") or l.get("text") or ""
        try:
            new = str(llm(a.server, SHORTEN_SYSTEM.format(lang=lang, max_chars=l["tooLong"]), json.dumps({"line": text, "meaning_in_arabic": l["ar"]}, ensure_ascii=False), temperature=0.3, max_tokens=300).get("text") or "").strip()
        except Exception as e:  # noqa: BLE001
            print("shorten failed:", e, file=sys.stderr)
            new = ""
        if new and len(new) < len(text):
            l["text"], l["shortened"] = new, (l.get("shortened") or 0) + 1
            l.pop("spoken", None)
        l.pop("tooLong", None)
        progress((k + 1) / len(todo), "shorten")
    jsave(data, os.path.join(a.out, "lines.json"))
    print(json.dumps({"shortened": len(todo)}))


def cmd_prefetch(a):
    """Download the voice, listening and speaker models once (set-up), so the first dub needs no network."""
    from huggingface_hub import snapshot_download
    hf = os.path.join(a.models, "hf")
    repos = [("JaesungHuh/voice-gender-classifier", hf), ("bookbot/wav2vec2-xls-r-adult-child-cls", hf), ("Systran/faster-whisper-small", None),
             ("Systran/faster-whisper-large-v3", None), ("ResembleAI/chatterbox", None)]
    for i, (repo, cache) in enumerate(repos):
        progress(i / len(repos), "prefetch")
        snapshot_download(repo, cache_dir=cache)
    progress(1, "prefetch")
    print(json.dumps({"models": [r for r, _ in repos]}))


def cmd_langid(a):
    """The spoken language of a 16 kHz mono file (Whisper small's language detection over up to three 30 s windows)."""
    import numpy as np
    import soundfile as sf
    import torch
    from faster_whisper import WhisperModel
    w, sr = sf.read(a.vocals, dtype="float32")
    if w.ndim > 1:
        w = w.mean(axis=1)
    dev = "cuda" if torch.cuda.is_available() and a.device != "cpu" else "cpu"
    model = WhisperModel("small", device=dev, compute_type="float16" if dev == "cuda" else "int8")
    n, win = len(w), 30 * sr
    starts = sorted({max(0, min(n - win, int(n * f))) for f in (0.1, 0.45, 0.75)}) if n > win else [0]
    score = {}
    for s0 in starts:
        _, _, probs = model.detect_language(w[s0:s0 + win])
        for code, p in probs[:5]:
            score[code] = score.get(code, 0.0) + p / len(starts)
    best = max(score, key=score.get)
    print(json.dumps({"language": best, "p": round(score[best], 3), "arabic": round(score.get("ar", 0.0), 3)}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["prefetch", "langid", "analyze", "translate", "synth", "shorten"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--vocals")
    ap.add_argument("--background")
    ap.add_argument("--words")
    ap.add_argument("--models", default=os.path.join(HERE, "..", "..", "..", "runtime", "models", "speaker"))
    ap.add_argument("--server", default="http://127.0.0.1:18080")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--context", default="")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--duck-db", dest="duck_db", type=float, default=6.0)
    ap.add_argument("--cfg", type=float, default=None, help="voice: one cfg_weight for every line (tests)")
    ap.add_argument("--ex-cap", dest="ex_cap", type=float, default=1.2, help="voice: the most exaggeration a line gets")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(a.out, exist_ok=True)
    {"prefetch": cmd_prefetch, "langid": cmd_langid, "analyze": cmd_analyze, "translate": cmd_translate, "synth": cmd_synth, "shorten": cmd_shorten}[a.stage](a)


if __name__ == "__main__":
    main()
