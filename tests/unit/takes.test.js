// Best take by performance (Phase 5): the scorer (signals compared between takes only, gates, completeness, weights
// per content type, the both-orders judge rule, learning from picks, the agreement measurement), the per-take
// features from words + perception's timeline, the published-video → picks mapping, and the service without models.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { relativeScores, gateTakes, scoreGroup, judgeVerdict, applyJudge, scoreFn, learnWeights, chooseByWeights, agreement, leaveOneOut, exampleFrom, typeFromName, weightsFor, takesResult, SIGNAL_NAMES, TYPE_WEIGHTS, TAKES_VERSION } from "../../src/core/takeScore.js";
import { wordSignals, punchBeat, timelineSignals, takeFeatures, arousal } from "../../src/services/takes/features.js";
import { takeFromCoverage, rawSpansOf, PickStore } from "../../src/services/takes/picks.js";
import { TakeService, workerTakes, wordsFromTimeline } from "../../src/services/takes/takeService.js";
import { pickPageHtml } from "../../src/services/takes/pickPage.js";
import { retakeGroups } from "../../src/core/speech.js";

const US = 1e6;
const W = (text, s, e, conf = 0.9) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US), conf });
const take = (from, to, extra = {}) => ({ fromUs: from * US, toUs: to * US, text: "x", kind: "full", complete: true, ...extra });
const feat = (signals, gate = {}) => ({ signals, gate });

test("relative scores: 0.5 at the group mean, a jnd apart is a clear but not total difference, direction and nulls", () => {
  const r = relativeScores([1, 2], { better: "high", jnd: 1 });
  assert.ok(Math.abs(r[0] + r[1] - 1) < 1e-9);
  assert.ok(r[1] > 0.7 && r[1] < 0.8);
  const tiny = relativeScores([1, 1.01], { better: "high", jnd: 1 });
  assert.ok(Math.abs(tiny[1] - 0.5) < 0.01, "below a jnd is almost the same score");
  assert.ok(relativeScores([1, 2], { better: "low", jnd: 1 })[0] > 0.5);
  assert.deepEqual(relativeScores([1, null], { jnd: 1 }), [null, null]);
  const three = relativeScores([0, null, 3], { jnd: 1 });
  assert.equal(three[1], null);
  assert.ok(three[2] > three[0]);
});

test("gates are relative to the group and only count when some take passes", () => {
  const g = gateTakes([{ ovrl: 3.4, luma: 120, shake: 0.5 }, { ovrl: 2.2, luma: 50, shake: 3.5 }]);
  assert.deepEqual(g[0].fails, []);
  assert.deepEqual(g[1].fails.sort(), ["dark", "shaky", "sound"]);
  const close = gateTakes([{ ovrl: 1.8 }, { ovrl: 1.2 }]);
  assert.ok(close.every((x) => x.passes), "both poor and close: no gate (DNSMOS on a noisy street)");
  const allBad = gateTakes([{ shake: 9 }, { shake: 8.5 }]);
  assert.ok(allBad.every((x) => x.passes));
});

test("scoring: complete takes only, missing signals left out, the better take wins, ties go to the last complete", () => {
  const g = { takes: [take(0, 2, { complete: false, kind: "false-start" }), take(3, 6), take(7, 10)], kept: 2, line: "line" };
  const r = scoreGroup(g, [feat({ fillers: 0 }), feat({ fillers: 0.05, smile: 2 }), feat({ fillers: 0.3, smile: 1 })], { type: "default" });
  assert.equal(r.takes[0].eligible, false);
  assert.deepEqual(r.takes[0].ineligible, ["false start"]);
  assert.ok(r.signalsUsed.includes("fillers") && !r.signalsUsed.includes("smile"), "smile is missing for take 1 → left out");
  assert.ok(r.signalsPartial.includes("smile"));
  assert.equal(r.kept, 1);
  assert.equal(r.keptBy, "score");
  assert.match(r.reasonAr, /حشو أقل/);
  const tie = scoreGroup({ takes: [take(0, 2), take(3, 5)], kept: 1 }, [feat({}), feat({})]);
  assert.equal(tie.kept, 1);
  assert.equal(tie.keptBy, "last-complete");
  const gated = scoreGroup({ takes: [take(0, 2), take(3, 5)], kept: 1 }, [feat({ fillers: 0 }, { ovrl: 3.5 }), feat({ fillers: 0 }, { ovrl: 1.9 })]);
  assert.equal(gated.kept, 0);
  assert.deepEqual(gated.takes[1].ineligible, ["sound"]);
});

test("content types weigh differently: comedy keeps the timing + laughter take, explainer the fluent one looking at the lens", () => {
  const g = { takes: [take(0, 3), take(4, 7)], kept: 1 };
  const f = [feat({ timing: 0.5, laughter: 1.5, fillers: 0.2, gaze: 0.3 }), feat({ timing: 0, laughter: 0, fillers: 0, gaze: 0.9 })];
  assert.equal(scoreGroup(g, f, { type: "comedy" }).kept, 0);
  assert.equal(scoreGroup(g, f, { type: "explainer" }).kept, 1);
  assert.equal(typeFromName("06-كوميديا"), "comedy");
  assert.equal(typeFromName("05-شرح"), "explainer");
  assert.equal(typeFromName("01-فلوق"), "vlog");
  assert.equal(typeFromName("whatever"), "default");
  assert.equal(weightsFor("comedy").timing, TYPE_WEIGHTS.comedy.timing);
  assert.equal(weightsFor("comedy", { comedy: { weights: { timing: 0.1 } } }).timing, 0.1);
});

test("the AI judge counts only when it agrees with itself in both orders", () => {
  assert.equal(judgeVerdict("A", "B"), "leader");
  assert.equal(judgeVerdict("b", "a"), "runnerUp");
  assert.equal(judgeVerdict("B", "B"), null, "always the second clip = position bias");
  assert.equal(judgeVerdict("A", "?"), null);
  const g = scoreGroup({ takes: [take(0, 2), take(3, 5)], kept: 1 }, [feat({ fillers: 0.1 }), feat({ fillers: 0.104 })]);
  assert.ok(g.closeCall);
  const lead = g.kept, other = g.runnerUp;
  const flipped = applyJudge(g, { ab: "B", ba: "A", model: "m" });
  assert.equal(flipped.kept, other);
  assert.equal(flipped.runnerUp, lead);
  assert.equal(flipped.keptBy, "judge");
  const biased = applyJudge(g, { ab: "B", ba: "B" });
  assert.equal(biased.kept, lead);
  assert.equal(biased.judge.consistent, false);
  assert.equal(biased.keptBy, "score");
  const clear = scoreGroup({ takes: [take(0, 2), take(3, 5)], kept: 1 }, [feat({ fillers: 0 }), feat({ fillers: 0.5 })]);
  assert.equal(applyJudge(clear, { ab: "B", ba: "A" }), clear, "not a close call: the judge is not asked");
});

test("scoreFn plugs a result into core/speech.js retakeGroups", () => {
  const words = [W("قولتلك", 0, 0.4), W("الكلام", 0.45, 0.9), W("ده", 0.95, 1.2), W("قولتلك", 2.5, 2.9), W("الكلام", 2.95, 3.4), W("ده", 3.45, 3.7)];
  const groups = retakeGroups(words);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kept, 1, "phase 2's default: the last complete take");
  const r = scoreGroup(groups[0], [feat({ fillers: 0 }), feat({ fillers: 0.4 })]);
  const res = takesResult({ groups: [r] });
  assert.equal(res.version, TAKES_VERSION);
  assert.equal(res.schema, TAKES_VERSION);
  assert.equal(res.groups[0].best, 0);
  assert.deepEqual(res.groups[0].takes.map((t) => [t.t0, t.t1, t.score]), [[0, 1.2, 1], [2.5, 3.7, res.groups[0].takes[1].score]]);
  assert.ok(res.groups[0].takes[1].score < 1 && res.groups[0].takes[0].why);
  const again = retakeGroups(words, { score: scoreFn(res) });
  assert.equal(again[0].kept, 0);
  assert.equal(again[0].reason, "best performance");
});

test("learning from picks moves the weights towards what the user keeps; agreement next to random and last-take", () => {
  // The user always keeps the take with more laughter after it, even when it has more fillers.
  const ex = [];
  for (let k = 0; k < 6; k++) {
    const g = scoreGroup({ takes: [take(0, 2), take(3, 5)], kept: 1 }, [feat({ laughter: 1 + k * 0.1, fillers: 0.25 }), feat({ laughter: 0, fillers: 0 })], { type: "vlog" });
    ex.push(exampleFrom(g, 0));
  }
  const before = ex.map((e) => chooseByWeights(e, { ...TYPE_WEIGHTS.vlog, fillers: 3, laughter: 0.5 }));
  assert.ok(before.every((c) => c === 1));
  const l = learnWeights(ex, { type: "vlog", prior: { ...TYPE_WEIGHTS.vlog, fillers: 3, laughter: 0.5 } });
  assert.ok(l.learned);
  assert.ok(l.weights.laughter > 0.5 && l.weights.fillers < 3);
  assert.ok(ex.every((e) => chooseByWeights(e, l.weights) === 0));
  const a = agreement(ex, ex.map(() => 0));
  assert.deepEqual([a.n, a.chooser, a.random, a.last], [6, 1, 0.5, 0]);
  assert.equal(leaveOneOut(ex, { type: "*", prior: { ...TYPE_WEIGHTS.vlog, fillers: 3, laughter: 0.5 } }).length, 6);
  assert.equal(learnWeights(ex.slice(0, 2), { type: "vlog" }).learned, false, "under minExamples: the defaults stay");
});

test("word signals: fillers in context, in-sentence pauses, confidence, the beat before the punchline", () => {
  const words = [W("بص", 0, 0.3), W("انا", 0.8, 1.0, 0.8), W("رحت", 1.05, 1.3, 0.6), W("السوق", 1.35, 1.8, 0.7), W("و", 1.85, 1.9), W("لقيته", 2.6, 3.0), W("مقفول", 3.05, 3.5), W("ايه", 3.6, 3.8)];
  const s = wordSignals(words, 1, 6);
  assert.equal(s.fillers, 0, "«ايه» right after the take is not counted, «بص» before it is not the take's");
  assert.ok(s.pauses > 0.2 && s.pauses < 0.35);
  assert.ok(Math.abs(s.asrConf - (0.8 + 0.6 + 0.7 + 0.9 + 0.9 + 0.9) / 6) < 1e-9);
  assert.ok(s.timing > 0.5, "a clear beat before «لقيته مقفول»");
  assert.equal(punchBeat(words.slice(0, 3)), null);
  const even = [W("a", 0, 0.2), W("b", 0.3, 0.5), W("c", 0.6, 0.8), W("d", 0.9, 1.1), W("e", 1.2, 1.4)];
  assert.ok(punchBeat(even) <= 0.01, "an even rhythm has no beat");
  assert.equal(wordSignals([W("امال", 0, 0.3), W("عايز", 0.35, 0.6), W("ايه", 0.62, 0.9), W("طيب", 2, 2.3)], 0, 2).fillers, 0, "«عايز ايه» is a question");
  assert.ok(wordSignals([W("انا", 0, 0.3), W("ايه", 0.8, 1.0), W("رحت", 1.6, 1.9)], 0, 2).fillers > 0.3, "«ايه» alone between pauses is a hesitation");
  const allFill = wordSignals([W("امم", 0, 0.3), W("يعني", 0.8, 1.0), W("ماشي", 1.5, 1.8)]);
  assert.ok(allFill.fillers > 0.4);
});

test("timeline signals: who speaks, emotion by overlap, laughter after (others double), the speaker's face on screen", () => {
  const ev = (type, t0, t1, o = {}) => ({ type, t0, t1, confidence: null, speaker: null, entity: null, text: null, extra: null, ...o });
  const tl = {
    speakers: [{ id: "S1", face: "P1" }, { id: "S2", face: null, offScreen: true }], links: {},
    events: [ev("word", 1, 1.5, { speaker: "S1" }), ev("word", 1.6, 2.4, { speaker: "S1" }), ev("word", 2.5, 2.8, { speaker: "S2" }),
      ev("emotion", 0.9, 2.0, { extra: { scores: { happy: 0.8, neutral: 0.2 } } }), ev("emotion", 2.0, 3.0, { extra: { scores: { neutral: 1 } } }),
      ev("laughter", 3.2, 4.2, { speaker: "S2" }), ev("audio_tag", 3.0, 3.5, { text: "Laughter", confidence: 0.5 }),
      ev("face_track", 0, 2.0, { entity: "P1", extra: { boxes: [[1, 0.4, 0.2, 0.2, 0.2], [1.8, 0.41, 0.2, 0.2, 0.2]] } })],
  };
  const r = timelineSignals(tl, 1, 3, { next: 6 });
  assert.equal(r.speaker, "S1");
  assert.equal(r.entity, "P1");
  assert.ok(Math.abs(r.signals.emotion - (1 * arousal({ happy: 0.8, neutral: 0.2 }) + 1 * -1) / 2) < 1e-9);
  assert.ok(Math.abs(r.signals.laughter - (1.0 * 2 + 0.5)) < 1e-9);
  assert.ok(Math.abs(r.signals.onScreen - 0.5) < 1e-9);
  assert.equal(r.faceBoxes.length, 2);
  const cut = timelineSignals(tl, 1, 3, { next: 3.1 });
  assert.ok(cut.signals.laughter < r.signals.laughter, "laughter is looked for only until just after the next take starts");
  const none = timelineSignals(null, 0, 1);
  assert.deepEqual(none.signals, { emotion: null, laughter: null, onScreen: null });
  const f = takeFeatures({ words: [W("a", 1, 1.5)], tlPart: r, worker: { prosody: { loudnessMean: 2, pitchVar: 0.2 }, dnsmos: { ovrl: 3 }, face: { frames: 10, faceFrames: 0 }, video: { luma: 90, shake: 1 } } });
  assert.equal(f.signals.loudness, 1);
  assert.equal(f.signals.smile, null, "no face frames → no face signals");
  assert.deepEqual(f.gate, { ovrl: 3, luma: 90, shake: 1 });
});

test("a published cut → which take it kept, by the raw spans its sound matched", () => {
  const g = { takes: [take(59.4, 60.7), take(61.96, 63.94)] };
  const c = takeFromCoverage(g, [[9.98, 18.18], [61.89, 63.68], [70.37, 84.7]]);
  assert.equal(c.picked, 1);
  assert.equal(c.coverage[0], 0);
  assert.ok(c.coverage[1] > 0.8);
  assert.equal(takeFromCoverage(g, [[59, 65]]).picked, null, "both used: a deliberate repeat, not a pick");
  assert.equal(takeFromCoverage(g, [[0, 10]]).picked, null, "the line was cut");
  const m = { matches: [{ raw: "/x/a.mp4", segments: [{ r0: 1, r1: 2 }] }] };
  assert.deepEqual(rawSpansOf(m, "/x/a.mp4"), [[1, 2]]);
});

test("pick store: add, replace, learn, measure (scorer vs defaults vs leave-one-out vs last take)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takes-"));
  try {
    const store = new PickStore(dir);
    for (let k = 0; k < 4; k++) {
      const g = scoreGroup({ takes: [take(k * 10, k * 10 + 2), take(k * 10 + 3, k * 10 + 5)], kept: 1 }, [feat({ laughter: 1, fillers: 0.2 }), feat({ laughter: 0, fillers: 0 })], { type: "comedy" });
      store.add({ media: { hash: "h", path: "/m.mp4" }, g, picked: 0, source: "hand" });
      if (k === 0) store.add({ media: { hash: "h", path: "/m.mp4" }, g, picked: 0, source: "hand" });
    }
    assert.equal(store.list().length, 4, "the same group again replaces its pick");
    const learned = store.learn();
    assert.ok(learned.comedy.learned);
    assert.ok(store.learned().comedy.weights.laughter >= TYPE_WEIGHTS.comedy.laughter);
    const m = store.measure();
    assert.equal(m.picks, 4);
    assert.equal(m.lastComplete.chooser, 0);
    assert.equal(m.scorer.random, 0.5);
    assert.throws(() => store.add({ media: {}, g: { takes: [take(0, 1)] }, picked: 3 }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("service without models: groups from the timeline's words, signals from the timeline, the contract shape; pick page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takes-svc-"));
  try {
    const media = path.join(dir, "IMG_1.MP4");
    fs.writeFileSync(media, Buffer.alloc(4096, 7));
    const ev = (type, t0, t1, o = {}) => ({ type, t0, t1, confidence: 0.9, speaker: "S1", entity: null, text: null, extra: null, ...o });
    const words = ["قولتلك", "الكلام", "ده", "قولتلك", "الكلام", "ده"];
    const times = [[0, 0.4], [0.45, 0.9], [0.95, 1.2], [2.5, 2.9], [2.95, 3.4], [3.45, 3.7]];
    const tl = { speakers: [{ id: "S1", face: null, offScreen: true }], links: {}, report: { stages: { audio: {}, emotion: {} } },
      events: [...words.map((w, i) => ev("word", times[i][0], times[i][1], { text: w })), ev("emotion", 0, 1.2, { extra: { scores: { neutral: 1 } } }), ev("emotion", 2.5, 3.7, { extra: { scores: { happy: 1 } } }), ev("laughter", 3.8, 4.8, { speaker: "S2" })] };
    assert.equal(wordsFromTimeline(tl).length, 6);
    const svc = new TakeService({ runtimeDir: path.join(dir, "rt"), storeDir: path.join(dir, "store"), cacheDir: path.join(dir, "cache") });
    const res = await svc.analyze({ media, timeline: tl, type: "comedy", stages: [] });
    assert.equal(res.version, TAKES_VERSION);
    assert.equal(res.media.name, "IMG_1.MP4");
    assert.equal(res.groups.length, 1);
    const g = res.groups[0];
    assert.equal(g.kept, 1);
    assert.ok(g.signalsUsed.includes("emotion") && g.signalsUsed.includes("laughter"));
    assert.ok(res.missing.some((m) => m.startsWith("prosody")));
    assert.ok(SIGNAL_NAMES.every((s) => s in g.takes[0].scores));
    const jobs = workerTakes([{ takes: [{ fromUs: 0, toUs: 1.2e6, w0: 0, w1: 2 }] }], wordsFromTimeline(tl), tl);
    assert.equal(jobs[0].faceMode, "largest", "no face stage in the timeline → the largest face");
    const html = pickPageHtml([{ name: "case", res }]);
    assert.match(html, /اختار الإعادة/);
    assert.match(html, /file:\/\//);
    assert.match(html, /احفظ اختياراتي/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
