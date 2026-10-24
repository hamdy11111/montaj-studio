// The director and the pieces under it: creator pacing (beats kept), speech regions and the between-words gain,
// the static master gain (no per-clip loudness that lifted pauses), word scores and concepts, and a whole plan from a
// synthetic talk + person track that must validate as an edit plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { suggestCuts, speechRegions, correctWords } from "../../src/core/speech.js";
import { directPlan, wordScore, conceptOf, visualBeats } from "../../src/core/director.js";
import { EDIT_PLAN_SCHEMA } from "../../src/core/editPlan.js";
import { betweenWords, buildExport } from "../../src/core/exportGraph.js";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline } from "../../src/core/model.js";
import { US } from "../../src/core/util.js";

const W = (text, s, e) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US) });
// Arabic talk: an opening, a concept (شعري), a question, a sentence with two nouns, an end.
const TALK = [
  W("دي", 0.5, 0.7), W("تجربة", 0.7, 1.3), W("جديدة.", 1.3, 1.9),
  W("انا", 3.0, 3.2), W("شعري", 3.2, 3.8), W("منكوش.", 3.8, 4.5),
  W("شايفين", 6.5, 7.0), W("ده؟", 7.0, 7.4),
  W("الفيديو", 9.0, 9.6), W("والصوت", 9.7, 10.3), W("مهمين.", 10.3, 11.0),
  W("ونشوف", 13.0, 13.5), W("التجربة.", 13.5, 14.2),
];
// Person track: head at x 0.4, room on the right; the head jumps (a close-up) inside the 4.5–6.5 s pause.
const TRACK = Array.from({ length: 150 }, (_, i) => {
  const t = i * 100_000, close = t > 5_200_000 && t < 6_000_000;
  return [t, 0.25, 0.1, 0.55, 1, 0.4, close ? 0.45 : 0.35, close ? 0.4 : 0.22, close ? 0.6 : 0.4, 0.3];
});

test("creator pacing: every pause cut, a beat kept after a question, protected moments never cut", () => {
  const cuts = suggestCuts(TALK, { style: "creator", durationUs: 15 * US });
  const after = (w) => cuts.find((c) => c.fromUs >= TALK[w].endUs && c.fromUs < TALK[w].endUs + US);
  assert.ok(after(7).reason.includes("beat"), "after «ده؟»: a beat");
  assert.equal(after(7).fromUs - TALK[7].endUs, 140_000, "40 % of the 350 ms beat after the question");
  assert.equal(after(2).fromUs - TALK[2].endUs, 72_000, "40 % of 180 ms at a sentence end");
  const kept = suggestCuts(TALK, { style: "creator", durationUs: 15 * US, keep: [[5_000_000, 5_600_000]] });
  assert.ok(kept.every((c) => c.toUs <= 5_000_000 || c.fromUs >= 5_600_000), "the protected moment stays");
});

test("speech regions and the between-words gain; the master gain is static", () => {
  const r = speechRegions([W("a", 1, 1.5), W("b", 1.6, 2), W("c", 3, 3.5)]);
  assert.deepEqual(r, [[880_000, 2_120_000], [2_880_000, 3_620_000]]);
  const e = betweenWords(r, 0, 1, 4 * US);
  assert.match(e, /^0\.1\+0\.9\*min\(1,clip\(/);
  assert.equal((e.match(/clip\(/g) || []).length, 2);
  assert.equal(betweenWords(r, 10 * US, 1, US), "0.1", "no words in this span: lowered");
  assert.equal(betweenWords(null, 0, 1, US), null, "words unknown: untouched");
  const tl = newTimeline("p", { width: 640, height: 360 });
  const media = { a: { id: "a", path: "a.mp4", type: "video", durationUs: 4 * US, width: 640, height: 360, hasAudio: true, hasVideo: true, sampleRate: 48000, videoCodec: "h264" } };
  const seg = ops.addMediaSegment(tl, media.a);
  seg.audioFx = { normalize: { enabled: true, targetLufs: -14 }, denoise: { enabled: true }, enhanceVoice: { enabled: false }, isolate: "none", voiceChanger: "none" };
  const caps = { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() };
  const base = { media, width: 640, height: 360, fps: 30, mode: "audio", audio: { enabled: true, format: "aac" }, caps, speech: { a: r }, rnnModel: "C:/m/sh.rnnn" };
  const g = buildExport(tl, { ...base, masterGainDb: 6.5 }).graph;
  assert.doesNotMatch(g, /loudnorm/, "no per-clip dynamic loudness");
  assert.match(g, /volume=6\.50dB,alimiter=limit=0\.84:attack=5:release=60:level=0/);
  assert.match(g, /arnndn=model='C\\:\/m\/sh\.rnnn'/);
  assert.match(g, /volume='0\.1\+0\.9\*min\(1,clip/);
  assert.match(buildExport(tl, { ...base, measureLoudness: true }).graph, /ebur128/);
});

test("word scores prefer named concepts and nouns over verbs and participles; concepts survive prefixes", () => {
  assert.ok(wordScore("تجربة") > wordScore("شايفين"));
  assert.ok(wordScore("الفيديو") > wordScore("هتشوفوا"));
  assert.ok(wordScore("عيوب") > wordScore("عملنا"));
  assert.equal(wordScore("عليه"), -3);
  assert.equal(conceptOf("وشعري").emoji, "barber-pole");
  assert.equal(conceptOf("بالفلوس").emoji, "money-bag");
  assert.equal(conceptOf("قل"), null, "short stems do not catch unrelated words");
  assert.deepEqual(correctWords([{ t: "شاكله", s: 0, e: 1 }], [{ from: "شاكله", to: "شكله" }]).map((w) => w.t), ["شكله"]);
});

test("the director's plan: pacing, alternate framing, chosen graphics with sounds, punch on the question; it validates", () => {
  const beats = visualBeats(TALK, TRACK);
  assert.equal(beats.length, 1, "the close-up inside the pause is a beat");
  const { plan, notes } = directPlan({ mediaId: "m1", words: TALK, durationUs: 15 * US, track: TRACK, cta: "تابعني", captionTemplate: "clean-pro", corrections: [{ from: "منكوش", to: "منكوش!" }] });
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, plan), JSON.stringify(ajv.errors));
  assert.ok(plan.cuts.some((c) => c.reason.includes("beat")));
  assert.ok(plan.cuts.every((c) => c.toUs <= beats[0][0] || c.fromUs >= beats[0][1]), "the beat is not cut");
  const framing = plan.zooms.filter((z) => z.reason.startsWith("alternate"));
  assert.ok(framing.length >= 2 && framing.every((z) => z.scale === 1.14 && z.x > 0), "closer shots keep the head (left of centre) in place: the picture moves right");
  const t = (name) => plan.graphics.filter((g) => g.template === name);
  assert.ok(t("rise-behind").concat(t("emerge-side")).some((g) => g.params.text === "تجربة"), "the opening's key word");
  assert.ok(t("head-emoji").some((g) => g.params.emoji === "barber-pole"), "«شعري» → 💈");
  assert.ok(plan.graphics.filter((g) => !["progress-bar"].includes(g.template)).every((g) => g.sfx === true), "every motion has its sound");
  assert.ok(plan.zooms.some((z) => z.reason.startsWith("punch")) && plan.sfx.some((s) => s.sound === "impact"), "punch-in + impact on the question");
  assert.equal(t("follow-cta")[0].params.text, "تابعني");
  assert.equal(plan.captions.template, "clean-pro");
  assert.ok(plan.stabilize && plan.audio.denoise && plan.audio.normalizeLufs === -14);
  assert.ok(notes.length >= 5);
  // Graphics never crowd: at least the style's gap between their starts in the edit (cuts removed).
  const starts = plan.graphics.filter((g) => !["progress-bar", "follow-cta"].includes(g.template)).map((g) => g.fromUs).sort((a, b) => a - b);
  const edit = (s) => s - plan.cuts.filter((c) => c.toUs <= s).reduce((n, c) => n + c.toUs - c.fromUs, 0);
  for (let i = 1; i < starts.length; i++) assert.ok(edit(starts[i]) - edit(starts[i - 1]) >= 2_600_000 * 0.55 - 200_000, `graphics ${i - 1}/${i} too close`);
});
