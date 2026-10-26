// Phase 0 speech-model comparison (asr-ab): the provisional agreement between models before the user's reference
// exists, the final score's extra columns, and the Python helpers of bench/asr_engines.py (long-clip splitting at
// pauses, model tag clean-up) run with the bundled Python when it is there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agreement, score } from "../../bench/asr-score.mjs";

const segments = [
  { id: 1, clip: "clips/0001.mp3", media: "a.mp4", start: 0, draft: "انا رايح الجامعة بكرة" },
  { id: 2, clip: "clips/0002.mp3", media: "a.mp4", start: 5, draft: "قابلت زياد امبارح" },
  { id: 3, clip: "clips/0003.mp3", media: "a.mp4", start: 9, draft: "" },
];
const hyps = [
  { model: "x", label: "X", rtf: 0.1, vramMB: 3000, segments: [{ id: 1, text: "أنا رايح الجامعه بكره" }, { id: 2, text: "قابلت زياد امبارح" }, { id: 3, text: "" }] },
  { model: "y", label: "Y", segments: [{ id: 1, text: "انا رايح الجامعة بكرة" }, { id: 2, text: "قابلت زيد امبارح" }, { id: 3, text: "" }] },
  { model: "z", label: "Z", segments: [{ id: 1, text: "انا رحت" }, { id: 2, text: "قابلت زياد امبارح" }, { id: 3, text: "اشتركوا في القناة" }] },
];

test("agreement: spelling-only differences agree fully; pairs, distance from the draft and empty sentences", () => {
  const ag = agreement(hyps, segments);
  const pair = (a, b) => ag.pairs.find((p) => p.a === a && p.b === b).pct;
  // x and y differ only by ة/ه and one name: 1 word of 7 (mean length) — normalisation hides spelling
  assert.equal(pair("x", "y"), Math.round(1000 * 1 / 7) / 10);
  assert.ok(pair("x", "z") > pair("x", "y"), "z drops words and invents text in the silent sentence");
  const m = Object.fromEntries(ag.models.map((r) => [r.model, r]));
  assert.equal(m.x.vsDraft, 0, "x says what the draft says once spelling is normalised");
  assert.equal(m.x.empty, 1);
  assert.equal(m.z.empty, 0);
  assert.equal(m.x.rtf, 0.1);
  assert.equal(m.x.vramMB, 3000);
  assert.equal(ag.models.at(-1).model, "z", "the outlier is last");
  assert.equal(ag.hardest[0].id, 3, "the sentence they disagree on most comes first");
  assert.deepEqual(Object.keys(ag.hardest[0].texts), ["x", "y", "z"]);
});

test("agreement: a model with a missing sentence counts it as empty, not as a crash", () => {
  const ag = agreement([hyps[0], { model: "w", segments: [{ id: 1, text: "انا رايح الجامعة بكرة" }] }], segments);
  const w = ag.models.find((r) => r.model === "w");
  assert.equal(w.empty, 2);
  assert.equal(w.sentences, 1);
});

test("final score rows carry the label, plan, speed and GPU memory of each model", () => {
  const reference = { segments: segments.map((s) => ({ id: s.id, text: s.draft || "[مفيش كلام]", status: "done" })) };
  const rows = score(reference, hyps.map((h) => ({ ...h, plan: "contender", loadSeconds: 12 })));
  const x = rows.find((r) => r.model === "x");
  assert.equal(x.label, "X");
  assert.equal(x.plan, "contender");
  assert.equal(x.vramMB, 3000);
  assert.equal(x.loadSeconds, 12);
  assert.equal(x.wer, 0);
  assert.equal(rows.find((r) => r.model === "z").inventedWordsInSilence, 3);
});

// The Python helpers have no heavy imports: any of the app's Pythons runs them.
const PY = ["python312/python.exe", "asr-hf/Scripts/python.exe"].map((p) => path.join("runtime", p)).find((p) => fs.existsSync(p));

test("asr_engines.py: long clips split at pauses, model tags removed", { skip: !PY && "no bundled Python (runtime\\python312)" }, () => {
  const r = spawnSync(PY, ["-X", "utf8", "-I", path.join("tests", "python", "test_asr_engines.py")], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
