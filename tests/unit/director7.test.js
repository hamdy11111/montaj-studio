// Phase 7 — the director as a pipeline: moments from perception's timeline (speech AND wordless action), the phase 5 /
// phase 6 adapters, treatments that point only to moment numbers, the deterministic executor (hook, order, wordless
// moments kept), the pairwise critic (asked in both orders), the verifier's guards (they must FAIL when most of a
// wordless action video is cut — the 02 challenge) and output checks, the cut sheet, and the model glue (no key kept).
import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { buildMoments, momentsWithLinks, linkMoments, eventsOnAxis, ruleTreatments, validateTreatment, executionSpec, takeScorer, hookSpan, reactionOf, momentsTable, sameLine } from "../../src/core/treatments.js";
import { rubric, rankTreatments, shotLengths, compareByRubric } from "../../src/core/critic.js";
import { verifyPlan, verifyOutput, expectedSpeech, parseFfmpegChecks, cutSheet, keptIn, envelope, bestCorrelation, settleLine } from "../../src/core/verifier.js";
import { directPlan, withSpans, toPlanV2 } from "../../src/core/director.js";
import { retakeGroups } from "../../src/core/speech.js";
import { EDIT_PLAN_SCHEMA } from "../../src/core/editPlan.js";
import { treatmentsFromAnswer, llmGraphicsRanker, ClaudeDirectorLLM, PLAN_SCHEMA, planPrompt } from "../../src/services/directorLLM.js";
import { US } from "../../src/core/util.js";

const W = (text, s, e) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US) });
const EV = (type, t0, t1, extra = {}) => ({ type, t0, t1, confidence: extra.confidence ?? 0.8, text: extra.text || "", extra: extra.extra || {} });
// A 60 s group game: a few words at 20–22 s and 41–43 s, action all along, laughter at 10 s and 31 s, applause at 46 s,
// a quiet end (energy 1).
const GAME_WORDS = [W("يلا", 20.0, 20.4), W("يا", 20.5, 20.7), W("رجالة!", 20.7, 21.6), W("مين", 41.0, 41.3), W("كسب", 41.3, 41.8), W("الجولة؟", 41.8, 42.6)];
const GAME_EVENTS = [
  EV("shot_log", 0, 12, { extra: { energy: 5, action: "two men dance", summary_ar: "اتنين بيرقصوا" } }),
  EV("shot_log", 12, 24, { extra: { energy: 4, action: "a bubble gun" } }),
  EV("shot_log", 24, 36, { extra: { energy: 5, action: "jumps on a chair" } }),
  EV("shot_log", 36, 50, { extra: { energy: 4, action: "they clap" } }),
  EV("shot_log", 50, 60, { extra: { energy: 1, action: "people stand" } }),
  EV("laughter", 10.0, 11.2), EV("laughter", 31.0, 32.0),
  EV("audio_tag", 46.0, 48.0, { text: "Applause", confidence: 0.5 }),
  EV("audio_tag", 52.0, 54.0, { text: "Chatter", confidence: 0.5 }),
];
const onAxis = (events, durS) => eventsOnAxis({ m: { events } }, [{ mediaId: "m", srcStart: 0, srcEnd: durS * US, vStart: 0, speed: 1 }]);
const GAME = { words: GAME_WORDS, events: onAxis(GAME_EVENTS, 60), durationUs: 60 * US };

test("moments tile the video: sentences and wordless action / still stretches, reactions on their moment", () => {
  const ms = buildMoments(GAME);
  assert.equal(ms[0].s, 0); assert.equal(ms[ms.length - 1].e, 60 * US);
  for (let i = 1; i < ms.length; i++) assert.equal(ms[i].s, ms[i - 1].e, "no hole, no overlap");
  ms.forEach((m, i) => assert.equal(m.n, i + 1));
  assert.equal(ms.filter((m) => m.kind === "speech").length, 2);
  assert.ok(ms.filter((m) => m.kind === "action").length >= 5, "the game is mostly action moments");
  assert.ok(ms.some((m) => m.kind === "still"), "the quiet end is still");
  const laugh = ms.find((m) => m.reactions.some((r) => r.type === "laughter" && r.t === 10 * US));
  assert.ok(laugh && laugh.peak && laugh.s <= 6.6 * US && laugh.e >= 11.2 * US, "a reaction moment holds its lead-in and its tail");
  assert.equal(laugh.role, "reaction");
  assert.ok(!ms.some((m) => m.reactions.some((r) => r.t === 52 * US)), "chatter is not a reaction");
  assert.equal(reactionOf({ type: "loudness_spike", confidence: 0.4 }), null, "a weak loudness spike is not a reaction");
  // Without perception: the wordless stretches are unknown gaps (the old director's view).
  const blind = buildMoments({ ...GAME, events: [] });
  assert.ok(blind.filter((m) => m.kind !== "speech").every((m) => m.kind === "gap" && m.role === "filler"));
});

test("links: derived (unsure) without phase 6; phase 6's links, roles and promises win when given", () => {
  const words = [W("بص", 1.0, 1.3), W("هعمل", 1.4, 1.8), W("حاجة", 1.8, 2.3), W("مجنونة.", 2.3, 3.0)];
  const events = onAxis([EV("laughter", 3.4, 4.6)], 8);
  const { moments, links } = momentsWithLinks({ words, events, durationUs: 8 * US });
  const r = moments.find((m) => m.reactions.length);
  assert.ok(links.some((l) => l.reaction === r.n && l.cause === r.n - 1 && l.unsure && l.source === "rules"), "the moment before a reaction at its start causes it");
  const p6 = { links: [{ cause: { t0: 1.0, t1: 3.0 }, reaction: { t0: 3.4, t1: 4.6, type: "laughter" }, direction: "after", confidence: 0.9 }], roles: [{ t0: 1.0, t1: 3.0, role: "punch" }], promises: [{ t0: 1.0, t1: 3.0, text: "هعمل حاجة", payoff: { t0: 6, t1: 7 } }] };
  const w6 = momentsWithLinks({ words, events, durationUs: 8 * US }, p6);
  assert.equal(w6.links.length, 1); assert.equal(w6.links[0].source, "links"); assert.equal(w6.links[0].unsure, false);
  assert.equal(w6.moments.find((m) => m.n === w6.links[0].cause).role, "punch");
  assert.equal(w6.moments.find((m) => m.n === w6.links[0].cause).roleSource, "links");
  assert.equal(w6.promises.length, 1);
  assert.deepEqual(linkMoments(w6.moments, { links: [{ cause: null }] }).links, []);
});

test("phase 5 adapter: the best-scored take is kept; unmatched takes fall back to the last complete one", () => {
  const words = [W("انا", 0, 0.3), W("رحت", 0.3, 0.7), W("السوق", 0.7, 1.3), W("امبارح", 1.3, 2.0), W("انا", 3.0, 3.3), W("رحت", 3.3, 3.7), W("السوق", 3.7, 4.3), W("امبارح", 4.3, 5.0)];
  const def = retakeGroups(words);
  assert.equal(def.length, 1); assert.equal(def[0].kept, 1, "default: the last take");
  const score = takeScorer({ schema: "montaj.takes/1", groups: [{ takes: [{ t0: 0, t1: 2.0, score: 0.9 }, { t0: 3.0, t1: 5.0, score: 0.4 }] }] });
  const g = retakeGroups(words, { score });
  assert.equal(g[0].kept, 0, "phase 5 says the first take performs better");
  const none = takeScorer({ groups: [{ takes: [{ t0: 30, t1: 32, score: 1 }] }] });
  assert.equal(retakeGroups(words, { score: none })[0].kept, 1, "no match: the last complete take");
  assert.equal(takeScorer(null), null);
  const fn = () => 1; assert.equal(takeScorer(fn), fn);
});

test("treatments point only to moment numbers: 3–5 different ones; the validator drops invented numbers and keeps causes with reactions", () => {
  const { moments, links } = momentsWithLinks(GAME);
  const ts = ruleTreatments(moments, { durationUs: GAME.durationUs, links });
  assert.ok(ts.length >= 3 && ts.length <= 5, `${ts.length} treatments`);
  const N = moments.length;
  for (const t of ts) {
    assert.ok(t.order.length && t.order.every((n) => Number.isInteger(n) && n >= 1 && n <= N), t.id);
    assert.equal(new Set(t.order).size, t.order.length, "no moment twice");
    if (t.hook) assert.ok(t.order.includes(t.hook.moment), "the hook stays in its place too");
  }
  assert.equal(new Set(ts.map((t) => JSON.stringify([t.order, t.hook]))).size, ts.length, "all different");
  assert.ok(new Set(ts.map((t) => t.hook?.kind || "none")).size >= 2, "different hooks");
  const link = { cause: 3, reaction: 4, direction: "after" };
  const v = validateTreatment({ order: [4, 999, 4, 1], hook: { kind: "reaction", moment: 77 } }, moments, [link]);
  assert.deepEqual(v.treatment.order.slice(0, 3), [3, 4, 1], "cause put before its reaction; 999 and the repeat dropped");
  assert.equal(v.treatment.hook, null, "an invented hook moment is refused");
  assert.ok(v.fixes.some((f) => /999/.test(f)) && v.fixes.some((f) => /causes the reaction/.test(f)));
  assert.ok(momentsTable(moments, links).split("\n").length >= N);
});

test("the executor: a flash-forward hook first (role hook, kept in place too), the treatment's order, wordless action kept — the plan validates", () => {
  const { moments, links } = momentsWithLinks(GAME);
  const ts = ruleTreatments(moments, { durationUs: GAME.durationUs, links });
  const t = ts.find((x) => x.hook && x.hook.kind !== "action") || ts[0];
  const spec = executionSpec(t, moments, GAME.words);
  const r = directPlan({ mediaId: "media-1", words: GAME.words, wordsCorrected: true, durationUs: GAME.durationUs, track: [], style: "energetic", spec });
  const plan = r.plan;
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, plan), JSON.stringify(ajv.errors?.slice(0, 3)));
  if (spec.hook) {
    assert.equal(plan.segments[0].role, "hook");
    const h = plan.segments[0];
    assert.ok(h.toUs - h.fromUs <= 3_500_000, "a short flash-forward");
    assert.ok(plan.segments.slice(1).some((s) => s.fromUs <= h.fromUs && s.toUs >= h.toUs - 1000), "its natural place is kept too");
  }
  const editUs = plan.segments.filter((s) => s.role !== "hook").reduce((n, s) => n + s.toUs - s.fromUs, 0);
  assert.ok(editUs > 25 * US, `the action stays: ${editUs / US} s kept of 60 s`);
  const guards = verifyPlan({ moments, links, cuts: r.virtual.cuts, durationUs: GAME.durationUs, treatment: t });
  assert.ok(guards.ok, JSON.stringify(guards.checks));
  // A spec with no speech at all still gives a plan (wordless executor).
  const silent = { ...t, order: moments.filter((m) => m.kind === "action").map((m) => m.n), hook: null };
  const rs = directPlan({ mediaId: "media-1", words: GAME.words, wordsCorrected: true, durationUs: GAME.durationUs, track: [], spec: executionSpec(silent, moments, GAME.words) });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, rs.plan), JSON.stringify(ajv.errors?.slice(0, 3)));
  assert.ok(rs.plan.segments.length >= 2 && (rs.plan.zooms || []).length >= 1, "jump cuts and angle changes in the action");
});

test("the guards FAIL when most of a wordless action video is cut (the 02 failure), pass when the action is kept", () => {
  const { moments, links } = momentsWithLinks(GAME);
  // The old director: words only — every silence between them cut (perception unknown to it).
  const old = directPlan({ mediaId: "media-1", words: GAME.words, durationUs: GAME.durationUs, track: [], style: "energetic" });
  const cutsOld = [];
  let t = 0;
  for (const s of old.plan.segments) { if (s.fromUs > t) cutsOld.push({ fromUs: t, toUs: s.fromUs }); t = s.toUs; }
  if (t < GAME.durationUs) cutsOld.push({ fromUs: t, toUs: GAME.durationUs });
  const v = verifyPlan({ moments, links, cuts: cutsOld, durationUs: GAME.durationUs });
  assert.ok(old.qa.ok || true, "the old guards may well say «all passed»");
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => c.id === "action.cut" && c.level === "fail"), JSON.stringify(v.checks));
  assert.ok(v.checks.some((c) => c.id === "edit.tooShort"));
  assert.ok(v.stats.keptShare < 0.2);
  assert.equal(keptIn([{ fromUs: 0, toUs: 5 }], 0, 10), 5);
  // A talking-head video (mostly speech) with its pauses cut is fine.
  const talk = Array.from({ length: 40 }, (_, i) => W(`كلمة${i}`, i * 1.4, i * 1.4 + 1.2));
  const tm = momentsWithLinks({ words: talk, events: [], durationUs: 58 * US });
  assert.ok(verifyPlan({ moments: tm.moments, cuts: [{ fromUs: 56.5 * US, toUs: 58 * US }], durationUs: 58 * US }).ok);
  // A cause separated from its reaction fails.
  const sep = verifyPlan({ moments, links: [{ cause: 2, reaction: 5, direction: "after" }], cuts: [], durationUs: GAME.durationUs, treatment: { order: [2, 3, 5] } });
  assert.ok(sep.checks.some((c) => c.id === "links.apart"));
});

test("the critic: the rubric's criteria, pairs judged in both orders — only a judge answer that survives the swap counts", async () => {
  const { moments, links } = momentsWithLinks(GAME);
  const ts = ruleTreatments(moments, { durationUs: GAME.durationUs, links });
  const items = ts.map((t) => { const spec = executionSpec(t, moments, GAME.words); const r = directPlan({ mediaId: "media-1", words: GAME.words, wordsCorrected: true, durationUs: GAME.durationUs, track: [], spec }); return { id: t.id, treatment: t, plan: r.plan, qa: r.qa, rubric: rubric({ treatment: t, plan: r.plan, qa: r.qa, moments, links }) }; });
  for (const x of items) {
    for (const k of ["hook", "pace", "punch", "repetition", "midWord", "story"]) assert.ok(x.rubric.scores[k] >= 0 && x.rubric.scores[k] <= 1, `${x.id} ${k}`);
    assert.ok(x.rubric.facts.editSec > 0);
  }
  assert.ok(shotLengths(items[0].plan).length >= items[0].plan.segments.length);
  // A judge that always says "A" is position-biased: it never survives the swap → the rubric decides.
  const biased = await rankTreatments(items, { judge: async () => ({ winner: "A", why: "first" }), moments });
  assert.ok(biased.pairs.every((p) => p.by === "rubric" && p.consistent === false));
  const rub = await rankTreatments(items, { moments });
  assert.deepEqual(biased.ranking.map((r) => r.id), rub.ranking.map((r) => r.id));
  // A consistent judge that prefers the last treatment decides every pair it is in.
  const fav = items[items.length - 1].id;
  const judge = async ({ a, b }) => ({ winner: a.id === fav ? "A" : b.id === fav ? "B" : "tie", why: "likes it" });
  const j = await rankTreatments(items, { judge, moments });
  assert.equal(j.ranking[0].id, fav);
  assert.ok(j.pairs.filter((p) => p.a === fav || p.b === fav).every((p) => p.by === "judge" && p.winner === fav));
  assert.equal(compareByRubric({ total: 0.5, scores: {} }, { total: 0.505, scores: {} }).winner, "tie");
  const sheet = cutSheet({ chosen: j.ranking[0].id, items, ranking: j.ranking, pairs: j.pairs, moments, links });
  assert.equal(sheet.chosen.id, fav); assert.equal(sheet.alternatives.length, items.length - 1);
  assert.ok(sheet.text[0].startsWith("المعالجة المختارة"));
  assert.ok(sameLine("انا رحت السوق امبارح الصبح", "انا رحت السوق امبارح")); assert.ok(!sameLine("انا رحت السوق", "الجو حلو النهارده جدا"));
});

test("the verifier on the output: a lost important line and cut words fail; loudness and black frames are measured", () => {
  const plan = { segments: [{ mediaId: "a", fromUs: 0, toUs: 4 * US }, { mediaId: "a", fromUs: 6 * US, toUs: 10 * US }] };
  const words = { a: [W("النهارده", 0.2, 0.8), W("هنجرب", 0.9, 1.4), W("اكلة", 1.5, 2.0), W("جديدة", 2.0, 2.6), W("والنتيجة", 6.2, 6.9), W("كانت", 7.0, 7.3), W("مفاجأة", 7.3, 8.0), W("للكل", 8.0, 8.6)] };
  const exp = expectedSpeech(plan, words, { important: (mid, a) => a >= 6 * US });
  assert.equal(exp.lines.length, 2); assert.equal(exp.joints.length, 1); assert.equal(exp.editUs, 8 * US);
  assert.equal(exp.lines[1].editFromUs, 4.2 * US);
  const heard = [W("النهارده", 0.2, 0.8), W("هنجرب", 0.9, 1.4), W("اكلة", 1.5, 2.0), W("جديدة", 2.0, 2.6), W("والنتيجة", 4.2, 4.9), W("كانت", 5.0, 5.3), W("مفاجأة", 5.3, 6.0), W("للكل", 6.0, 6.6)];
  const ok = verifyOutput({ expected: exp, outWords: heard, loudness: { i: -14.3, tp: -1.5 }, black: [], frozen: [], durationS: 8, plannedS: 8 });
  assert.ok(ok.ok, JSON.stringify(ok.checks)); assert.equal(ok.stats.linesFound, 2);
  const lost = verifyOutput({ expected: exp, outWords: heard.slice(0, 4), loudness: { i: -20, tp: 0.5 }, black: [{ startS: 3.9, endS: 4.3 }], frozen: [{ startS: 1, endS: 4 }], durationS: 8, plannedS: 8 });
  const ids = lost.checks.map((c) => `${c.id}:${c.level}`);
  for (const id of ["out.lineMissing:fail", "out.loudness:fail", "out.truePeak:warn", "out.black:fail", "out.frozen:warn"]) assert.ok(ids.includes(id), `${id} in ${ids}`);
  const err = `[blackdetect @ 0x1] black_start:3.9 black_end:4.3 black_duration:0.4\n[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 1.0\nlavfi.freezedetect.freeze_duration: 3\nlavfi.freezedetect.freeze_end: 4.0\n[Parsed_ebur128_0 @ 0x3] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.6 LUFS\n\n  True peak:\n    Peak:       -1.1 dBFS`;
  const f = parseFfmpegChecks(err);
  assert.deepEqual(f.black, [{ startS: 3.9, endS: 4.3 }]); assert.deepEqual(f.frozen, [{ startS: 1, endS: 4 }]);
  assert.deepEqual(f.loudness, { i: -14.2, tp: -1.1 });
});

test("hook spans never start or end inside a word; cuts merge with kept spans restored", () => {
  const words = [W("ده", 0.1, 0.3), W("اللي", 0.35, 0.6), W("حصل", 0.65, 1.2), W("في", 1.25, 1.4), W("الاخر", 1.45, 2.2), W("وكلنا", 2.3, 2.9), W("ضحكنا", 2.95, 3.6), W("جامد", 3.65, 4.4)];
  const m = buildMoments({ words, events: onAxis([EV("laughter", 3.0, 4.0)], 6), durationUs: 6 * US })[0];
  for (const kind of ["result", "reaction", "question"]) {
    const h = hookSpan(m, words, kind);
    assert.ok(h.toUs - h.fromUs > 0 && h.toUs - h.fromUs <= 3_800_000, kind);
    for (const w of words) { assert.ok(!(w.startUs < h.fromUs && w.endUs > h.fromUs), `${kind}: start inside «${w.text}»`); assert.ok(!(w.startUs < h.toUs && w.endUs > h.toUs), `${kind}: end inside «${w.text}»`); }
  }
  const c = withSpans([{ fromUs: 0, toUs: 2 * US, reason: "pause" }], [{ fromUs: 1.5 * US, toUs: 5 * US, reason: "treatment" }], [[3 * US, 4 * US]]);
  assert.deepEqual(c.map((x) => [x.fromUs, x.toUs]), [[0, 3 * US], [4 * US, 5 * US]]);
  // toPlanV2 orders spans by the treatment and prepends the hook copy.
  const v2 = toPlanV2({ title: "t", cuts: [{ fromUs: 4 * US, toUs: 5 * US }] }, { clips: [{ mediaId: "a", srcStart: 0, srcEnd: 10 * US, vStart: 0 }], durationUs: 10 * US, order: [[5 * US, 10 * US], [0, 5 * US]], hook: { fromUs: 7 * US, toUs: 9 * US, kind: "result", moment: 2 } });
  assert.deepEqual(v2.segments.map((s) => [s.fromUs / US, s.toUs / US, s.role || "body"]), [[7, 9, "hook"], [5, 10, "body"], [0, 4, "body"]]);
});

test("the planner glue: the schema answer becomes treatments; the graphics ranker puts the model's picks first; a Claude client never keeps the key on itself", async () => {
  const ans = { treatments: [{ title: "النتيجة الأول", hook_kind: "result", hook_moment: 4, order: [1, 2, 4], length: "medium", why: "x" }, { title: "بدون", hook_kind: "none", hook_moment: 0, order: [2, 3], length: "full", why: "" }] };
  const t = treatmentsFromAnswer(ans, "local");
  assert.deepEqual(t[0].hook, { kind: "result", moment: 4 }); assert.equal(t[1].hook, null); assert.equal(t[0].source, "local");
  assert.ok(PLAN_SCHEMA.properties.treatments.items.required.includes("order"));
  assert.ok(planPrompt({ moments: buildMoments(GAME), links: [], durationS: 60 }).includes("Moments"));
  const fake = { info: { id: "qwen3.8-27b", name: "Qwen3.8-27B" }, json: async () => ({ json: { picks: [{ need: 3, templates: ["slam-stamp"] }, { need: 4, templates: [] }] }, ms: 5 }) };
  const base = async () => [{ template: "kinetic-word", score: 2 }, { template: "slam-stamp", score: 1 }];
  const { ranker } = await llmGraphicsRanker(fake, [{ i: 3, startUs: 0, tags: [], energy: 3, candidates: [] }], base);
  assert.deepEqual((await ranker({ need: { i: 3 } })).map((x) => x.template), ["slam-stamp", "kinetic-word"]);
  assert.deepEqual(await ranker({ need: { i: 4 } }), [], "the model said nothing fits");
  assert.equal((await ranker({ need: { i: 9 } })).length, 2, "not asked: the heuristic order");
  const c = new ClaudeDirectorLLM({ key: "sk-ant-test-123" });
  assert.ok(!JSON.stringify(c).includes("sk-ant") && !Object.values(c).some((v) => typeof v === "string" && v.includes("sk-ant")));
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try { assert.throws(() => new ClaudeDirectorLLM({}), /claudeKeyMissing/); } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});

test("found on the 02 challenge: a mostly wordless video keeps its own sound (no voice clean-up) and its action gets cut and angle changes", () => {
  const { moments, links } = momentsWithLinks(GAME);
  const t = ruleTreatments(moments, { durationUs: GAME.durationUs, links }).find((x) => x.length === "full");
  const spec = executionSpec(t, moments, GAME.words);
  assert.equal(spec.actionVideo, true);
  assert.deepEqual(spec.audio, { denoise: false, enhanceVoice: false, normalizeLufs: -14 }, "the voice clean-up lowers everything between words: never on a wordless video");
  const r = directPlan({ mediaId: "media-1", words: GAME.words, wordsCorrected: true, durationUs: GAME.durationUs, track: [], spec });
  assert.equal(r.plan.audio.denoise, false);
  // Kept action: never longer than its core, an angle change every ~2.5 s inside it.
  for (const [a, b] of spec.keepSpans) assert.ok(b - a <= 6.6 * US, `${(b - a) / US} s`);
  assert.ok(spec.angleBreaks.length >= spec.keepSpans.length * 1.5, `${spec.angleBreaks.length} angle changes`);
  const shots = shotLengths(r.plan).sort((x, y) => x - y);
  assert.ok(shots[shots.length - 1] <= 6, `longest shot (the quality target: 6 s) ${shots[shots.length - 1]} s`);
  // A talking video keeps the clean-up.
  const talk = Array.from({ length: 40 }, (_, i) => W(`كلمة${i}`, i * 1.4, i * 1.4 + 1.2));
  const tm = momentsWithLinks({ words: talk, events: [], durationUs: 58 * US });
  const tt = ruleTreatments(tm.moments, { durationUs: 58 * US })[0];
  assert.equal(executionSpec(tt, tm.moments, talk).audio, undefined);
  // In a talking video a kept wordless moment is a short beat (the clean-up would make a longer one dead air).
  const tw = [...talk.slice(0, 10), ...talk.slice(10).map((w) => ({ ...w, startUs: w.startUs + 8 * US, endUs: w.endUs + 8 * US }))];
  const te = onAxis([EV("shot_log", 13, 22, { extra: { energy: 4 } })], 66);
  const tmw = momentsWithLinks({ words: tw, events: te, durationUs: 66 * US });
  const act = tmw.moments.filter((m) => m.kind === "action");
  assert.ok(act.length >= 1);
  const ts2 = executionSpec({ order: tmw.moments.map((m) => m.n), hook: null, length: "full" }, tmw.moments, tw);
  assert.ok(ts2.keepSpans.every(([a, b]) => b - a <= 2_000_000), JSON.stringify(ts2.keepSpans));
});

test("the output check without a transcript says so (a warning) instead of failing every line", () => {
  const plan = { segments: [{ mediaId: "a", fromUs: 0, toUs: 4 * US }] };
  const exp = expectedSpeech(plan, { a: [W("النهارده", 0.2, 0.8), W("هنجرب", 0.9, 1.4), W("اكلة", 1.5, 2.0)] });
  const v = verifyOutput({ expected: exp, outWords: [], loudness: { i: -14, tp: -2 } });
  assert.ok(v.ok); assert.deepEqual(v.checks.map((c) => c.id), ["out.noTranscript"]);
});

test("the joint check is measured against the speech model's own agreement: words lost only at the joints fail", () => {
  const seg = (k) => ({ mediaId: "a", fromUs: k * 10 * US, toUs: k * 10 * US + 6 * US });
  const plan = { segments: [seg(0), seg(1), seg(2), seg(3)] };
  const ws = [];
  for (let k = 0; k < 4; k++) for (let i = 0; i < 5; i++) ws.push(W(["الجولة", "التانية", "كانت", "صعبة", "جدا"][i] + k, k * 10 + 0.3 + i * 1.1, k * 10 + 1.2 + i * 1.1));
  const exp = expectedSpeech(plan, { a: ws });
  const back = (keep) => exp.words.filter(keep).map((w) => ({ text: w.text, startUs: w.editUs, endUs: w.editUs + 500_000 }));
  const fine = verifyOutput({ expected: exp, outWords: back(() => true) });
  assert.ok(fine.ok && fine.stats.agreement === 1 && fine.stats.jointRecall === 1);
  const cut = verifyOutput({ expected: exp, outWords: back((w) => !w.joint) });
  assert.ok(cut.checks.some((c) => c.id === "out.cutWords" && c.level === "fail"), JSON.stringify(cut.checks.map((c) => c.id)));
  // A noisy file (the model hears a third of the words again): nothing is judged, it says why.
  const noisy = verifyOutput({ expected: exp, outWords: back((w, i) => exp.words.indexOf(w) % 3 === 0) });
  assert.ok(noisy.ok && noisy.checks.some((c) => c.id === "out.lowAgreement"));
});

test("a long take is broken by an angle change at a word boundary (no long static shot); no time is removed", () => {
  // 20 s of uninterrupted talk (words 0.4 s apart), one tiny pause at 9.0 s.
  const talk = [];
  let k = 0;
  for (let t = 0.2; t < 20; t += 0.5) talk.push(W(t > 8.9 && t < 9.3 ? "كده." : `كلمة${k++}`, t, t + 0.4));
  const r = directPlan({ mediaId: "media-1", words: talk, durationUs: 20.5 * US, track: [], style: "energetic", retakes: false, media: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } });
  const shots = shotLengths(r.plan).sort((a, b) => a - b);
  assert.ok(shots[shots.length - 1] <= 6.5, `longest ${shots[shots.length - 1]} s`);
  const kept = r.plan.segments.reduce((n, s) => n + s.toUs - s.fromUs, 0);
  assert.ok(kept > 19 * US, "the talk is kept");
  // (an angle piece that starts where a punch-in ends inherits the punch-in's time: not a split made here)
  const punchEnds = new Set((r.plan.zooms || []).filter((x) => /^punch/.test(x.reason)).map((x) => x.toUs));
  for (const z of (r.plan.zooms || []).filter((x) => /^angle/.test(x.reason) && !punchEnds.has(x.fromUs))) for (const w of talk) assert.ok(!(w.startUs < z.fromUs && w.endUs > z.fromUs + 1000) || z.fromUs <= 300_000, `an angle change inside «${w.text}» at ${z.fromUs}`);
});

test("a line the model did not hear again is settled by its sound: the same sound is a warning, a different one a fail", () => {
  // A speech-like envelope (bursts) and the same at a lower gain with 20 ms of lag; noise for a masked / missing line.
  const rate = 8000, len = rate * 3;
  const burst = (i) => (Math.floor(i / 1200) % 3 === 0 ? 0 : Math.sin(i / 3) * (6000 + 4000 * Math.sin(i / 900)));
  const src = Int16Array.from({ length: len }, (_, i) => burst(i));
  const same = Int16Array.from({ length: len }, (_, i) => 0.6 * burst(i + 160));
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const other = Int16Array.from({ length: len }, () => 9000 * rnd());
  const r1 = bestCorrelation(envelope(same), envelope(src)).r, r2 = bestCorrelation(envelope(other), envelope(src)).r;
  assert.ok(r1 > 0.9, `same sound r=${r1}`); assert.ok(r2 < 0.3, `other sound r=${r2}`);
  const check = { id: "out.lineMissing", level: "fail", message: "«x» is not heard", args: {} };
  assert.equal(settleLine(check, r1).level, "warn"); assert.equal(settleLine(check, r1).id, "out.lineHeardDifferently");
  assert.equal(settleLine({ ...check, id: "out.lineWeak", level: "warn", args: { important: true } }, r2).level, "fail", "an important line with another sound");
  assert.equal(settleLine({ ...check, id: "out.lineWeak", level: "warn", args: { important: false } }, r2).level, "warn", "an ordinary line stays a warning");
});
