// Phase 0 measurement tools: Egyptian Arabic normalisation and speech-model scoring, cut detection from frame
// scores, and the editing-quality metrics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, parseEquivalences, editOps } from "../../bench/lib/arabicNorm.mjs";
import { score } from "../../bench/asr-score.mjs";
import { detectCuts } from "../../bench/lib/signals.mjs";
import { metrics } from "../../bench/quality.mjs";

test("normalisation: hamza, ta marbuta, alef maqsura, digits, diacritics, punctuation, standalone و, equivalences", () => {
  assert.equal(normalize("أنا رايح المدرسة، إمبارح!"), "انا رايح المدرسه امبارح");
  assert.equal(normalize("مُسْتَشْفَى"), "مستشفي");
  assert.equal(normalize("عندي ٣ حاجات"), "عندي 3 حاجات");
  assert.equal(normalize("و انا كمان"), "وانا كمان");
  assert.equal(normalize("بصّ [غير مفهوم] كده"), "بص كده");
  const eq = parseEquivalences("يوتيوب = youtube\n# تعليق\nاوكي=ok");
  assert.equal(normalize("شفته على يوتيوب أوكي", eq), "شفته علي youtube ok");
  assert.equal(normalize("YouTube Challenge"), "youtube challenge");
});

test("edit operations split into substitutions, deletions and insertions", () => {
  assert.deepEqual(editOps("a b c d".split(" "), "a x c d e".split(" ")), { distance: 2, S: 1, D: 0, I: 1, n: 4 });
  assert.equal(editOps([], ["a"]).distance, 1);
});

test("model scoring: only reviewed sentences; hard and silent sentences apart; names and English counted", () => {
  const reference = { segments: [
    { id: 1, text: "انا رايح الجامعة بكرة", status: "done" },
    { id: 2, text: "قابلت زياد في YouTube", status: "done" },
    { id: 3, text: "[مفيش كلام]", status: "done" },
    { id: 4, text: "كلام [متداخل] كتير", status: "done" },
    { id: 5, text: "لسه ما اتراجعتش", status: "edited" },
  ] };
  const hyps = [
    { model: "a", segments: [{ id: 1, text: "أنا رايح الجامعه بكره" }, { id: 2, text: "قابلت زياد في يوتيوب" }, { id: 3, text: "" }, { id: 4, text: "كلام كتير" }, { id: 5, text: "x" }] },
    { model: "b", segments: [{ id: 1, text: "انا رحت الجامعة" }, { id: 2, text: "قابلت زيد في youtube" }, { id: 3, text: "اشتركوا في القناة" }] },
  ];
  const rows = score(reference, hyps, { names: ["زياد"], equivalences: parseEquivalences("يوتيوب = youtube") });
  const a = rows.find((r) => r.model === "a"), b = rows.find((r) => r.model === "b");
  assert.equal(a.wer, 0);
  assert.equal(a.namesPct, 100);
  assert.equal(a.latinPct, 100);
  assert.equal(a.inventedWordsInSilence, 0);
  assert.equal(a.werHard, 0);
  assert.ok(b.wer > 0);
  assert.equal(b.namesPct, 0);
  assert.equal(b.inventedWordsInSilence, 3);
  assert.equal(b.missing, 1, "a reviewed sentence the model has no text for");
  assert.equal(rows[0].model, "a", "best first");
});

test("cuts: clear spikes count (incl. a small jump cut), steady motion does not", () => {
  const scores = [];
  for (let i = 0; i < 300; i++) scores.push({ t: i / 25, s: 0.8 + 0.3 * Math.sin(i) });
  scores[50].s = 30;   // a hard cut
  scores[150].s = 6;   // a jump cut in the same framing
  scores[200].s = 3.5; // too small: a gesture
  assert.deepEqual(detectCuts(scores), [2, 6]);
});

test("quality metrics: shots, dead air over 2 s, first speech and stagnation", () => {
  const scores = [];
  for (let i = 0; i < 25 * 20; i++) scores.push({ t: i / 25, s: i / 25 > 8 && i / 25 < 14 ? 0.3 : 2 });
  scores[25 * 5].s = 40;
  scores[25 * 15].s = 40;
  const m = metrics({ duration: 20, fps: 25, width: 1920, height: 1080, scores, silences: [{ start: 0, end: 0.6 }, { start: 9, end: 11.5 }], loudness: { i: -14, tp: -1, lra: 4 } });
  assert.equal(m.cuts, 2);
  assert.equal(m.shot.median, 5);
  assert.equal(m.shot.longest, 10);
  assert.equal(m.opening.firstSpeechSec, 0.6);
  assert.deepEqual(m.deadAir.over2s, [{ at: 9, len: 2.5 }]);
  assert.ok(m.stillestSec > 5.5 && m.stillestSec < 6.1, String(m.stillestSec));
});
