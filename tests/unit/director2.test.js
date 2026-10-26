// Round 4 (director2): the director's follow-ups — the precise verifier (the kept words force-aligned onto the export,
// a word cut at a joint fails, an Egyptian final ه / tanween read as said), no spoiler for explainers (no flash-forward
// of the ending), the kept action's own sound (plan.audio.keepAmbience, the contract with audio-export) with longer
// action beats once the export honours it, music beds on a ducking music track at a measured level, the agent
// operations (edit_auto's story options, musicbed_place / musicbed_set_duck, timeline_set_jl), and the same people
// across clips (voices matched across files, faces through their own voice).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { AgentHub } from "../../src/agent/controlServer.js";
import { alignExport } from "../../src/agent/director.js";
import { momentsWithLinks, eventsOnAxis, ruleTreatments, validateTreatment, executionSpec, avoidSpoilers, spoils, SPOILER_AT, AMBIENT_CORE } from "../../src/core/treatments.js";
import { expectedSpeech, verifyOutput, alignText, alignLayout, layoutAudio, wavBytes, verifyAligned, withAlignment, edgeLevels, ALIGN } from "../../src/core/verifier.js";
import { directPlan, DIRECTOR_STYLES } from "../../src/core/director.js";
import { crossFilePeople, storyPlan, SAME_VOICE } from "../../src/core/story.js";
import { planPrompt } from "../../src/services/directorLLM.js";
import { EDIT_PLAN_SCHEMA, mainPieces } from "../../src/core/editPlan.js";
import { US } from "../../src/core/util.js";

const W = (text, s, e) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US) });
const EV = (type, t0, t1, extra = {}) => ({ type, t0, t1, confidence: extra.confidence ?? 0.8, text: extra.text || "", entity: extra.entity, speaker: extra.speaker, extra: extra.extra || {} });
const onAxis = (events, durS) => eventsOnAxis({ m: { events } }, [{ mediaId: "m", srcStart: 0, srcEnd: durS * US, vStart: 0, speed: 1 }]);
const ajv = new Ajv({ allErrors: true, strict: false });

// ------------------------------------------------------------------ the precise verifier (pure)
// Two segments of one file: «كلام اول جملة طويلة شوية» … «وبعدين الكلام التاني» | a joint | «الجملة التالته …».
const LINE = (text, s, step = 0.4) => text.split(" ").map((w, i) => W(w, s + i * step, s + i * step + 0.3));
const SRC = [...LINE("كلام اول جملة طويلة شوية عشان نشوف", 1), ...LINE("وبعدين الكلام التاني كمان معانا", 5), ...LINE("الجملة التالته هنا بعد القطع خالص", 12), ...LINE("واخر كلام في الفيديو", 16)];
const PLAN = { schema: "montaj.editplan/2", segments: [{ mediaId: "m", fromUs: 0.8 * US, toUs: 7.5 * US }, { mediaId: "m", fromUs: 11.8 * US, toUs: 18 * US }] };

/** align.py's answer when every word is where the plan says, with its letters matched at `conf`. */
const perfect = (layout, conf = 0.8) => layout.asr.segments.flatMap((s) => s.words).map((w) => ({ start: w.start, end: w.end, word: w.word, align_conf: conf, aligned: true }));

test("forced alignment: what the aligner reads — an Egyptian final ه / ة and a tanween ا as said", () => {
  assert.equal(alignText("التركيه"), "التركي");
  assert.equal(alignText("الجامعة"), "الجامع");
  assert.equal(alignText("الله"), "الله", "a real h stays");
  assert.equal(alignText("فيه"), "فيه");
  assert.equal(alignText("مثلا"), "مثلن", "masalan");
  assert.equal(alignText("طبعًا"), "طبعن", "tashkeel off first");
  assert.equal(alignText("هنا"), "هنا", "a real final vowel stays");
  assert.equal(alignText("في"), "في");
});

test("forced alignment: the layout puts every segment's sound apart (silence after it); the job has one line per run of words", () => {
  const e = expectedSpeech(PLAN, { m: SRC });
  assert.equal(e.segs.length, 2);
  assert.deepEqual(e.segs.map((s) => [s.editFromUs, s.editToUs, s.mediaId, s.srcFromUs]), [[0, 6.7 * US, "m", 0.8 * US], [6.7 * US, 12.9 * US, "m", 11.8 * US]]);
  assert.ok(e.words.every((w) => Number.isInteger(w.segment) && Number.isInteger(w.line) && w.editEndUs > w.editUs));
  assert.deepEqual(e.words.filter((w) => w.joint).map((w) => w.text), ["معانا", "الجملة"], "the words on both sides of the joint");
  const L = alignLayout(e);
  assert.deepEqual(L.pieces.map((p) => p.wavFromUs), [0, 6.7 * US + ALIGN.gapUs]);
  assert.equal(L.totalUs, 12.9 * US + 2 * ALIGN.gapUs);
  assert.equal(L.asr.segments.length, e.lines.length, "one aligner segment per line");
  assert.equal(L.index.length, e.words.length);
  const second = L.asr.segments.find((s) => s.words[0].word === "الجمل"); // the final ة left out for the aligner
  assert.ok(Math.abs(second.start - (6.7 + 0.2 + ALIGN.gapUs / US)) < 1e-6, "edit time + the silence before it");
  // The audio: each segment's PCM at its place, zeros in between.
  const rate = 1000, pcm = new Int16Array(Math.round(12.9 * rate)).fill(7);
  const a = layoutAudio(pcm, rate, L);
  assert.equal(a.length, Math.round((L.totalUs / US) * rate));
  assert.equal(a[100], 7);
  assert.equal(a[Math.round(6.9 * rate)], 0, "silence after the first segment");
  assert.equal(a[Math.round((6.7 + ALIGN.gapUs / US + 0.1) * rate)], 7);
  const wav = wavBytes(new Int16Array([1, -1, 2]), 16000);
  assert.equal(wav.length, 44 + 6);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
});

test("forced alignment: a clean export passes; a word cut at a joint fails (its letters dragged past the cut); a lost important line fails", () => {
  const e = expectedSpeech(PLAN, { m: SRC }, { important: (mid, a) => a >= 11.9 * US && a < 15 * US });
  const L = alignLayout(e);
  const ok = verifyAligned({ expected: e, layout: L, aligned: perfect(L) });
  assert.equal(ok.judged, true);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));
  assert.ok(ok.passed.includes("out.clippedWord") && ok.passed.includes("out.lineMissing"));
  assert.equal(ok.stats.jointWords, 2);
  // The last word before the joint: its letters run 250 ms into the silence after the cut (its end was cut off).
  const cutEnd = perfect(L);
  const j = L.index.findIndex((i) => e.words[i].text === "معانا");
  const segEndWav = (L.pieces[0].wavFromUs + 6.7 * US) / US;
  cutEnd[j] = { ...cutEnd[j], end: segEndWav + 0.25 };
  const v = verifyAligned({ expected: e, layout: L, aligned: cutEnd });
  assert.equal(v.ok, false);
  const c = v.checks.find((x) => x.id === "out.clippedWord");
  assert.equal(c.args.word, "معانا");
  assert.equal(c.args.side, "end");
  assert.ok(c.args.spillMs >= 240 && c.args.spillMs <= 260);
  // The first word after the joint starts before its segment: its beginning was cut.
  const cutStart = perfect(L);
  const k = L.index.findIndex((i) => e.words[i].text === "الجملة");
  cutStart[k] = { ...cutStart[k], start: L.pieces[1].wavFromUs / US - 0.15 };
  assert.equal(verifyAligned({ expected: e, layout: L, aligned: cutStart }).checks.find((x) => x.id === "out.clippedWord").args.side, "start");
  // A small drift inside the segment is no cut.
  const near = perfect(L);
  near[j] = { ...near[j], end: segEndWav + 0.05 };
  assert.equal(verifyAligned({ expected: e, layout: L, aligned: near }).ok, true);
  // An important line whose letters do not match (masked or gone) fails; an ordinary one is a warning.
  const lost = perfect(L).map((w, n) => (e.words[L.index[n]].line === e.words.find((x) => x.text === "الجملة").line ? { ...w, align_conf: 0.05 } : w));
  const vl = verifyAligned({ expected: e, layout: L, aligned: lost });
  assert.ok(vl.checks.some((x) => x.id === "out.lineMissing" && x.level === "fail" && x.args.important));
  const e2 = expectedSpeech(PLAN, { m: SRC });
  assert.ok(verifyAligned({ expected: e2, layout: alignLayout(e2), aligned: lost }).checks.some((x) => x.id === "out.lineWeak" && x.level === "warn"));
  // Too few words to know the file's own quality: nothing judged (the transcription takes over).
  const few = expectedSpeech({ schema: "montaj.editplan/2", segments: [{ mediaId: "m", fromUs: 0.8 * US, toUs: 2.5 * US }] }, { m: SRC });
  const lf = alignLayout(few);
  assert.equal(verifyAligned({ expected: few, layout: lf, aligned: perfect(lf) }).judged, false);
});

test("forced alignment: the sound at each cut is measured and reported with a cut word; a short window keeps a drag under the threshold", () => {
  const e = expectedSpeech(PLAN, { m: SRC });
  const L = alignLayout(e);
  const rate = 1000, pcm = new Int16Array(Math.round(12.9 * rate)).fill(30);
  for (let i = Math.round(6.66 * rate); i < Math.round(6.7 * rate); i++) pcm[i] = 8000; // loud right at the first cut
  const lv = edgeLevels(pcm, rate, L);
  assert.ok(lv.edges.get(0).endDb > lv.quietDb + 40 && Math.abs(lv.edges.get(1).startDb - lv.quietDb) < 1);
  const al = perfect(L), j = L.index.findIndex((i) => e.words[i].text === "معانا");
  al[j] = { ...al[j], end: (L.pieces[0].wavFromUs + 6.7 * US) / US + 0.3 };
  const c = verifyAligned({ expected: e, layout: L, aligned: al, levels: lv }).checks.find((x) => x.id === "out.clippedWord");
  assert.ok(c.args.atCutDb > c.args.quietDb + 40);
  // The worst drag of a line's last letter: the window's pad minus the director's smallest margin (60 ms).
  assert.ok(ALIGN.pad * US - 60_000 < ALIGN.spillUs);
});

test("forced alignment replaces the transcription's speech checks, keeps loudness / black / frozen, and says which method judged", () => {
  const e = expectedSpeech(PLAN, { m: SRC });
  const out = verifyOutput({ expected: e, outWords: [], loudness: { i: -20, tp: -2 }, black: [], frozen: [] });
  assert.ok(out.checks.some((c) => c.id === "out.noTranscript"));
  const L = alignLayout(e);
  const al = verifyAligned({ expected: e, layout: L, aligned: perfect(L) });
  const v = withAlignment(out, al);
  assert.equal(v.stats.method, "align");
  assert.ok(!v.checks.some((c) => c.id === "out.noTranscript"));
  assert.ok(v.checks.some((c) => c.id === "out.loudness" && c.level === "fail"), "loudness still judged");
  assert.equal(v.ok, false);
  assert.ok(v.passed.includes("out.clippedWord"));
  assert.equal(withAlignment(out, { judged: false, stats: { aligned: 2 } }).stats.method, "transcribe");
  assert.equal(withAlignment(out, null).checks.length, out.checks.length);
});

test("alignExport: the export's sound laid out with silences, the job sent to the aligner, its answer judged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-d2-"));
  try {
    const file = path.join(dir, "export.wav");
    await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=13", "-ar", "16000", file], { timeoutMs: 60_000 });
    const e = expectedSpeech(PLAN, { m: SRC });
    let job = null;
    const r = await alignExport({ perception: { runtime: dir } }, file, e, { runWorker: async (j) => { job = j; assert.ok(fs.existsSync(j.audio)); return { device: "test", words: j.asr.segments.flatMap((s) => s.words).map((w) => ({ ...w, align_conf: 0.9 })) }; } });
    assert.equal(job.minConf, 0);
    assert.equal(job.device, "cpu", "the CPU by default: never waits for the shared card");
    assert.ok(job.maxShift >= 10, "every move allowed: the verifier judges");
    assert.ok(job.asr.segments.flatMap((s) => s.words).some((w) => w.word === "الجمل"), "the text the aligner reads (final ة left out)");
    assert.equal(r.judged, true);
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.dirname(job.audio)), "its work folder is gone");
    // Neither the runtime nor the model there: no alignment (the transcription is the fallback).
    assert.equal(await alignExport({ perception: { runtime: dir } }, file, e), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ no spoiler
// A wordless group game (60 s): laughter at 10 s and 31 s, applause at 46 s — the strongest reaction is late.
const GAME_WORDS = [W("يلا", 20.0, 20.4), W("يا", 20.5, 20.7), W("رجالة!", 20.7, 21.6), W("مين", 41.0, 41.3), W("كسب", 41.3, 41.8), W("الجولة؟", 41.8, 42.6)];
const GAME_EVENTS = [
  EV("shot_log", 0, 12, { extra: { energy: 5, action: "two men dance" } }), EV("shot_log", 12, 24, { extra: { energy: 4, action: "a bubble gun" } }),
  EV("shot_log", 24, 36, { extra: { energy: 5, action: "jumps on a chair" } }), EV("shot_log", 36, 50, { extra: { energy: 4, action: "they clap" } }),
  EV("shot_log", 50, 60, { extra: { energy: 1, action: "people stand" } }),
  EV("laughter", 10.0, 11.2), EV("laughter", 31.0, 32.0), EV("audio_tag", 46.0, 48.0, { text: "Applause", confidence: 0.5 }), EV("laughter", 47.0, 48.5),
];
const GAME = { words: GAME_WORDS, events: onAxis(GAME_EVENTS, 60), durationUs: 60 * US };

test("no spoiler: on for the explain style and explainers (by name or type); the asked setting wins", () => {
  assert.equal(avoidSpoilers({ style: "explain", styles: DIRECTOR_STYLES }), true);
  assert.equal(avoidSpoilers({ style: "energetic", styles: DIRECTOR_STYLES, name: "05-شرح الطبخة" }), true);
  assert.equal(avoidSpoilers({ style: "energetic", styles: DIRECTOR_STYLES, contentType: "explainer" }), true);
  assert.equal(avoidSpoilers({ style: "energetic", styles: DIRECTOR_STYLES, name: "02-تحدي" }), false);
  assert.equal(avoidSpoilers({ spoiler: "allow", style: "explain", styles: DIRECTOR_STYLES }), false);
  assert.equal(avoidSpoilers({ spoiler: "avoid", style: "energetic", styles: DIRECTOR_STYLES }), true);
  assert.equal(DIRECTOR_STYLES.explain.noSpoiler, true);
});

test("no spoiler: no result or reaction flash-forward from the ending; a planner's spoiling hook is dropped, a question kept", () => {
  const { moments, links, promises } = momentsWithLinks(GAME);
  const D = GAME.durationUs, late = (n) => moments[n - 1].s / D >= SPOILER_AT;
  const free = ruleTreatments(moments, { durationUs: D, links, promises });
  assert.ok(free.some((t) => t.hook && (t.hook.kind === "result" || t.hook.kind === "reaction") && late(t.hook.moment)), "the fixture: without the option a hook comes from the ending");
  const safe = ruleTreatments(moments, { durationUs: D, links, promises, noSpoiler: true });
  assert.ok(safe.length >= 3);
  for (const t of safe) if (t.hook && (t.hook.kind === "result" || t.hook.kind === "reaction")) assert.ok(!late(t.hook.moment), `${t.id}: hook from ${moments[t.hook.moment - 1].s / US} s`);
  const last = moments.filter((m) => m.kind !== "gap").at(-1);
  assert.equal(spoils(last, moments, { durationUs: D }), true);
  assert.equal(spoils(moments[0], moments, { durationUs: D }), false);
  assert.equal(spoils(moments[0], moments, { durationUs: D, promises: [{ promise: 2, payoff: 1 }] }), true, "the payoff of a promise");
  const all = moments.map((m) => m.n);
  const v = validateTreatment({ order: all, hook: { kind: "result", moment: last.n } }, moments, links, promises, { noSpoiler: true, durationUs: D });
  assert.equal(v.treatment.hook, null);
  assert.ok(v.fixes.some((f) => /give away the ending/.test(f)));
  assert.deepEqual(validateTreatment({ order: all, hook: { kind: "question", moment: last.n } }, moments, links, promises, { noSpoiler: true, durationUs: D }).treatment.hook, { kind: "question", moment: last.n });
  assert.equal(validateTreatment({ order: all, hook: { kind: "result", moment: last.n } }, moments, links, promises, { durationUs: D }).treatment.hook.moment, last.n, "without the option it stays");
  assert.match(planPrompt({ moments, links, durationS: 60, noSpoiler: true }), /No spoilers/);
  assert.doesNotMatch(planPrompt({ moments, links, durationS: 60 }), /No spoilers/);
});

// ------------------------------------------------------------------ the kept action's own sound
const TALK = Array.from({ length: 40 }, (_, i) => W(`كلمة${i}`, i * 1.4, i * 1.4 + 1.2));
// Ten words, 8 s of action without words (two shots), then the rest of the talk.
const TW = [...TALK.slice(0, 10), ...TALK.slice(10).map((w) => ({ ...w, startUs: w.startUs + 8 * US, endUs: w.endUs + 8 * US }))];
const SHOTS = [EV("shot_log", 13.2, 17.6, { extra: { energy: 4, action: "kicks a ball" } }), EV("shot_log", 17.6, 22, { extra: { energy: 4, action: "runs" } })];
// The same two shots with a heard reaction in each (laughter) — and without (a picture-only action, quiet).
const TE = onAxis([...SHOTS, EV("laughter", 15.0, 16.0), EV("laughter", 19.5, 20.5)], 66), TQ = onAxis(SHOTS, 66);

test("keepAmbience: with the export honouring it a talking video keeps longer action beats, one after another, and marks their sound", () => {
  const { moments } = momentsWithLinks({ words: TW, events: TE, durationUs: 66 * US });
  const act = moments.filter((m) => m.kind === "action");
  assert.ok(act.length >= 1 && act.every((m) => m.reactions.length), JSON.stringify(act.map((m) => [m.s / US, m.e / US, m.reactions.map((r) => r.type)])));
  const t = { order: moments.map((m) => m.n), hook: null, length: "full" };
  const old = executionSpec(t, moments, TW);
  const longest = (sp) => Math.max(...sp.keepSpans.map(([a, b]) => b - a));
  assert.ok(longest(old) <= 3_000_000, "before: short beats (the clean-up would make a longer one dead air)");
  assert.deepEqual(old.ambience, []);
  const spec = executionSpec(t, moments, TW, { ambience: true });
  assert.ok(longest(spec) > longest(old) && longest(spec) <= AMBIENT_CORE.lead + 1_000_000 + AMBIENT_CORE.tail + 1, JSON.stringify([old.keepSpans, spec.keepSpans]));
  assert.ok(act.every((m) => !spec.cutSpans.some((c) => c.fromUs === m.s && c.toUs === m.e)), "the heard action beats, one after another");
  assert.ok(spec.ambience.length >= act.length);
  // A quiet action shot (picture only) stays a short beat: kept long it would be dead air again (01's vlog) — its
  // sound is still kept under the clean-up.
  const q = momentsWithLinks({ words: TW, events: TQ, durationUs: 66 * US });
  const qs = executionSpec({ order: q.moments.map((m) => m.n), hook: null, length: "full" }, q.moments, TW, { ambience: true });
  assert.ok(qs.keepSpans.every(([a, b]) => b - a <= 2_000_000), JSON.stringify(qs.keepSpans));
  assert.ok(qs.ambience.length >= 1);
  assert.equal(spec.audio, undefined, "a talking video keeps its clean-up");
  // In the plan: SOURCE spans of the real file, under the clean-up — and the plan validates.
  const r = directPlan({ mediaId: "media-1", words: TW, wordsCorrected: true, durationUs: 66 * US, track: [], spec });
  const keep = r.plan.audio.keepAmbience;
  assert.equal(r.plan.audio.denoise, true);
  assert.ok(keep.length >= 1 && keep.every((x) => x.mediaId === "media-1" && x.toUs > x.fromUs && x.fromUs >= 13 * US && x.toUs <= 22.1 * US), JSON.stringify(keep));
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, r.plan), JSON.stringify(ajv.errors));
  assert.equal(directPlan({ mediaId: "media-1", words: TW, wordsCorrected: true, durationUs: 66 * US, track: [], spec: old }).plan.audio.keepAmbience, undefined);
});

test("keepAmbience: an action video keeps the clean-up for its speech once the export keeps the action's sound; off as before otherwise", () => {
  const { moments, links } = momentsWithLinks(GAME);
  const t = ruleTreatments(moments, { durationUs: GAME.durationUs, links }).find((x) => x.length === "full");
  assert.deepEqual(executionSpec(t, moments, GAME.words).audio, { denoise: false, enhanceVoice: false, normalizeLufs: -14 });
  const spec = executionSpec(t, moments, GAME.words, { ambience: true });
  assert.deepEqual(spec.audio, { denoise: true, enhanceVoice: false, normalizeLufs: -14 });
  const r = directPlan({ mediaId: "media-1", words: GAME.words, wordsCorrected: true, durationUs: GAME.durationUs, track: [], spec });
  const kept = spec.keepSpans.filter(([a, b]) => spec.ambience.some(([x, y]) => x === a && y === b));
  assert.ok(kept.length >= 3 && r.plan.audio.keepAmbience.length >= 3, `${r.plan.audio.keepAmbience?.length} spans`);
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, r.plan), JSON.stringify(ajv.errors));
  // The schema: keepAmbience is part of audio; anything else there still fails.
  assert.ok(!ajv.validate(EDIT_PLAN_SCHEMA, { ...r.plan, audio: { ...r.plan.audio, keepAmbience: [{ mediaId: "media-1", fromUs: 1 }] } }));
});

// ------------------------------------------------------------------ the same people across clips
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const NOISE = (v, k) => unit(v.map((x, i) => x + k * Math.sin(i * 7.3)));
const E1 = unit(Array.from({ length: 16 }, (_, i) => Math.cos(i))), E2 = unit(Array.from({ length: 16 }, (_, i) => Math.sin(i * 2.1))), E3 = unit(Array.from({ length: 16 }, (_, i) => (i % 3) - 1));

test("the same people across clips: voices matched across files (mutual best, ≥ the threshold), a face through its own voice", () => {
  const files = [
    { key: "a", speakers: [{ id: "S1", embedding: E1 }, { id: "S2", embedding: E2 }], faces: [{ id: "P1", voice: "S1" }, { id: "P2", voice: null }] },
    { key: "b", speakers: [{ id: "S1", embedding: NOISE(E1, 0.05) }, { id: "S2", embedding: E3 }], faces: [{ id: "P1", voice: "S2" }] },
    // c: one voice close to a:S1 but not b's best match for it — the mutual best decides.
    { key: "c", speakers: [{ id: "S1", embedding: NOISE(E1, 0.4) }], faces: [] },
  ];
  const r = crossFilePeople(files);
  const id = (x) => r.map.get(x);
  assert.ok(id("a:S1") && id("a:S1") === id("b:S1") && id("a:S1") === id("a:P1"), JSON.stringify([...r.map]));
  assert.equal(id("b:P1"), id("b:S2"), "a face with its own voice");
  assert.notEqual(id("b:P1"), id("a:S1"));
  assert.equal(id("a:P2"), undefined, "joined to nothing: keeps its own id");
  assert.ok(r.pairs.some((p) => p.a === "a:S1" && p.b === "b:S1" && p.cos > 0.95));
  const cos = (u, v) => u.reduce((n, x, i) => n + x * v[i], 0);
  assert.ok(cos(E1, NOISE(E1, 0.4)) < SAME_VOICE || !r.pairs.some((p) => p.b === "c:S1" && p.a === "b:S1"), "c joins only as a mutual best above the threshold");
  // Different voices never join, whatever the order.
  assert.equal(crossFilePeople([{ key: "x", speakers: [{ id: "S1", embedding: E2 }] }, { key: "y", speakers: [{ id: "S1", embedding: E3 }] }]).pairs.length, 0);
});

test("the same people across clips count in the story's continuity (people sets share an id)", () => {
  // Two clips of different files, the same woman speaking in both (S1 in a, S2 in b).
  const words = [...LINE("اهلا بيكم النهارده هنعمل اكلة جديدة", 0.5), ...LINE("وده الطبق خلص وطعمه حلو قوي", 10.5)];
  const clips = [{ mediaId: "a", vStart: 0, srcStart: 0, speed: 1 }, { mediaId: "b", vStart: 10 * US, srcStart: 0, speed: 1 }];
  const events = [EV("utterance", 0.4 * US, 3.5 * US, { speaker: "S1" }), EV("utterance", 10.4 * US, 13.5 * US, { speaker: "S2" })];
  const { moments, links, promises } = momentsWithLinks({ words, events: [], durationUs: 20 * US, joints: [10 * US] });
  const plain = storyPlan({ moments, links, promises, events, clips }, { useTime: false });
  const [pa, pb] = plain.segments.map((g) => [...g.people]);
  assert.ok(pa.length && pb.length && !pa.some((x) => pb.includes(x)), "per file: no one in common");
  const people = crossFilePeople([{ key: "a", speakers: [{ id: "S1", embedding: E1 }] }, { key: "b", speakers: [{ id: "S2", embedding: NOISE(E1, 0.05) }] }]).map;
  const same = storyPlan({ moments, links, promises, events, clips, people }, { useTime: false });
  const [qa, qb] = same.segments.map((g) => [...g.people]);
  assert.ok(qa.some((x) => qb.includes(x)), JSON.stringify([qa, qb]));
});

// ------------------------------------------------------------------ in the app: the hand-over, the music bed, the operations
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-d2-app-"));
const mediaDir = path.join(root, "m");
let S, hub, client, tid, red, blue, tone;
const call = (n, a) => hub.call(hub.clients.all().find((c) => c.id === client.id), n, a);

async function clip(name, color, hz, seconds = 6) {
  const out = path.join(mediaDir, name);
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=320x180:rate=30:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`, "-shortest", "-c:a", "aac", "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { timeoutMs: 120_000 });
  return out;
}

before(async () => {
  fs.mkdirSync(mediaDir, { recursive: true });
  S = await createServices({ root, notify: () => {} });
  const files = [await clip("red.mp4", "red", 300), await clip("blue.mp4", "blue", 1000)];
  const wav = path.join(mediaDir, "tone.wav");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=600:duration=12", wav], { timeoutMs: 60_000 });
  files.push(wav);
  hub = new AgentHub({ services: S, dir: S.paths.agents });
  client = hub.clients.create({ name: "d2", scopes: ["read", "media", "edit"], projects: "*", importRoots: [mediaDir] }).client;
  const p = await call("project_create", { name: "d2", ratio: "16:9" });
  tid = p.mainTimelineId;
  [red, blue, tone] = (await call("media_import", { projectId: p.projectId, paths: files })).imported.map((m) => m.mediaId);
  await call("timeline_add_clip", { timelineId: tid, mediaId: red });
});
after(() => { hub.close(); closeDatabase({ shutdown: true }); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("applying a plan hands its keepAmbience to the export (when the export service has it) and clears stale spans", async () => {
  const stored = [];
  const ex = S.exporter, had = { set: ex.setKeepAmbience, get: ex.keepAmbience };
  ex.setKeepAmbience = (t, list) => { stored.push({ t, list }); return list; };
  ex.keepAmbience = () => stored.at(-1)?.list || [];
  try {
    const keep = [{ mediaId: red, fromUs: US, toUs: 3 * US }];
    const plan = { schema: "montaj.editplan/2", title: "amb", segments: [{ mediaId: red, fromUs: 0, toUs: 4 * US }, { mediaId: blue, fromUs: 0, toUs: 3 * US }], audio: { denoise: true, normalizeLufs: -14, keepAmbience: keep } };
    const v = await call("edit_plan_validate", { timelineId: tid, plan });
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.ok(v.cutSheet.some((l) => /action's own sound kept in 1 span/.test(l)));
    const r = await call("edit_plan_apply", { timelineId: tid, plan });
    assert.equal(r.status, "done", JSON.stringify(r.error));
    assert.deepEqual(stored.at(-1), { t: tid, list: keep });
    assert.ok(r.result.applied.some((x) => /action sound kept \(1\)/.test(x)));
    const r2 = await call("edit_plan_apply", { timelineId: tid, plan: { ...plan, title: "amb2", audio: { denoise: true } } });
    assert.equal(r2.status, "done");
    assert.deepEqual(stored.at(-1).list, [], "a plan without spans clears the old ones");
  } finally { ex.setKeepAmbience = had.set; ex.keepAmbience = had.get; }
  // Without the method (the export before round 4) the field is simply ignored.
  if (!S.exporter.setKeepAmbience) {
    const r = await call("edit_plan_apply", { timelineId: tid, plan: { schema: "montaj.editplan/2", title: "amb3", segments: [{ mediaId: red, fromUs: 0, toUs: 4 * US }], audio: { denoise: true, keepAmbience: [{ mediaId: red, fromUs: 0, toUs: US }] } } });
    assert.equal(r.status, "done");
  }
});

test("a plan's music goes on a music track that ducks under the speech, at the level measured against it (or the plan's own)", async () => {
  const bed = S.music.bed, had = bed.levelFor;
  bed.levelFor = async () => ({ volumeDb: -23.5, measured: { musicLufs: -12, speechLufs: -20 } });
  try {
    const plan = { schema: "montaj.editplan/2", title: "music", segments: [{ mediaId: red, fromUs: 0, toUs: 4 * US }, { mediaId: blue, fromUs: 0, toUs: 3 * US }], music: [{ mediaId: tone, editFromUs: 0 }, { mediaId: tone, editFromUs: US, editToUs: 5 * US, volumeDb: -20, duckDb: 6, fadeUs: 400_000 }] };
    const r = await call("edit_plan_apply", { timelineId: tid, plan });
    assert.equal(r.status, "done", JSON.stringify(r.error));
    const tl = S.timelines.get(tid).timeline;
    const tracks = tl.tracks.filter((t) => t.segments.some((s) => s.mediaId === tone));
    assert.equal(tracks.length, 2, "each bed on its own track");
    const a = tracks.find((t) => t.role === "music"), b = tracks.find((t) => t.role === "music:6");
    assert.ok(a && b, JSON.stringify(tracks.map((t) => t.role)));
    assert.equal(a.segments[0].volumeDb, -23.5, "measured against the speech");
    assert.equal(a.segments[0].duration, 7 * US, "to the end of the edit");
    assert.equal(b.segments[0].volumeDb, -20, "the plan's own level");
    assert.equal(b.segments[0].fadeInUs, 400_000);
    assert.ok(r.result.applied.some((x) => /music under the speech \(2\)/.test(x)));
  } finally { bed.levelFor = had; }
});

test("agent operations: timeline_set_jl on a joint, musicbed_place / musicbed_set_duck; edit_auto lists the story and spoiler options", async () => {
  const main = () => mainPieces(S.timelines.get(tid).timeline);
  const second = S.timelines.get(tid).timeline.tracks.find((t) => t.isMain).segments.find((s) => s.start === main()[1].start);
  const j = await call("timeline_set_jl", { timelineId: tid, clipId: second.id, jlUs: -200_000 });
  assert.equal(j.jlUs, -200_000);
  assert.equal(S.timelines.get(tid).timeline.tracks.find((t) => t.isMain).segments.find((s) => s.id === second.id).jlUs, -200_000);
  const p = await call("musicbed_place", { timelineId: tid, mediaId: tone, autoLevel: false, volumeDb: -19, duckDb: 9 });
  const track = () => S.timelines.get(tid).timeline.tracks.find((t) => t.segments.some((s) => s.id === p.clipId));
  assert.equal(track().role, "music:9");
  assert.equal(track().segments[0].volumeDb, -19);
  assert.equal((await call("musicbed_set_duck", { timelineId: tid, clipId: p.clipId, duckDb: 12 })).duckDb, 12);
  assert.equal(track().role, "music");
  await call("musicbed_set_duck", { timelineId: tid, clipId: p.clipId, duckDb: null });
  assert.equal(track().role, "");
  const { OPERATION_INDEX } = await import("../../src/agent/operations.js");
  const props = OPERATION_INDEX.get("edit_auto").input.properties;
  for (const k of ["story", "storyHints", "storyPlanner", "spoiler", "contentType"]) assert.ok(props[k], k);
  assert.match(OPERATION_INDEX.get("edit_plan_schema").description, /keepAmbience/);
});
