// Perception layer (Phase 4): the event timeline's shape, the fusion of the stages' outputs (words ↔ speakers,
// overlap, utterances, pauses, voices ↔ faces with the Hungarian method), and the service's cache keys and plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent, validateEvent, finalize, eventsIn, countByType, TYPES } from "../../src/services/perception/timeline.js";
import { hungarian, speakerNames, wordsWithSpeakers, utterances, pauses, speakingSpans, linkSpeakersToFaces, buildTimeline } from "../../src/services/perception/fuse.js";

test("events have the one shape; bad types and times are refused; confidence is clamped", () => {
  const e = makeEvent({ t0: 2.00049, t1: 1, type: "laughter", confidence: 1.7 });
  assert.deepEqual(Object.keys(e), ["id", "t0", "t1", "type", "source_model", "confidence", "speaker", "entity", "text", "extra"]);
  assert.equal(e.t0, 1);
  assert.equal(e.t1, 2);
  assert.equal(e.confidence, 1);
  assert.equal(e.extra, null);
  assert.deepEqual(validateEvent(e), []);
  assert.throws(() => makeEvent({ t0: 0, type: "nope" }));
  assert.throws(() => makeEvent({ t0: NaN, type: "word" }));
  assert.ok(validateEvent({ t0: 1 }).length > 0);
  assert.ok(TYPES.includes("shot_log"));
});

test("finalize sorts by time then type and numbers the events", () => {
  const ev = finalize([makeEvent({ t0: 3, type: "word" }), makeEvent({ t0: 1, t1: 2, type: "shot" }), makeEvent({ t0: 1, t1: 2, type: "word" })]);
  assert.deepEqual(ev.map((e) => [e.id, e.type, e.t0]), [["e000001", "word", 1], ["e000002", "shot", 1], ["e000003", "word", 3]]);
  assert.equal(eventsIn({ events: ev }, 2.5, 4, "word").length, 1);
  assert.deepEqual(countByType(ev), { word: 2, shot: 1 });
});

test("Hungarian: the cheapest one-to-one assignment, rectangular matrices padded", () => {
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  assert.deepEqual(hungarian([[1, 9], [9, 1], [5, 5]]), [0, 1, -1]); // 3 voices, 2 faces: one voice gets none
  assert.deepEqual(hungarian([[3, 1, 2]]), [1]);
  assert.deepEqual(hungarian([]), []);
});

test("speaker names follow speaking time; words get the exclusive turn and are unsure in overlap", () => {
  const excl = [{ start: 0, end: 4, speaker: "SPEAKER_01" }, { start: 4, end: 5, speaker: "SPEAKER_00" }];
  const names = speakerNames(excl);
  assert.equal(names.get("SPEAKER_01"), "S1");
  assert.equal(names.get("SPEAKER_00"), "S2");
  const words = [{ start: 0.5, end: 0.9, word: "أنا" }, { start: 3.8, end: 4.4, word: "مش" }, { start: 5.3, end: 5.6, word: "عارف" }, { start: 9, end: 9.3, word: "بعيد" }];
  const w = wordsWithSpeakers(words, excl, [{ start: 3.9, end: 4.3, speakers: ["a", "b"] }]);
  assert.deepEqual(w.map((x) => x.speaker), ["SPEAKER_01", "SPEAKER_00", "SPEAKER_00", null]); // 3.8–4.4: more of it in the 2nd turn; 5.3 is 0.3 s after the last turn; 9 is too far
  assert.deepEqual(w.map((x) => x.unsure), [false, true, false, false]);
});

test("utterances break on a new speaker or a long pause; pauses are found between words and at the end", () => {
  const w = [
    { start: 0, end: 0.4, word: "a", speaker: "S1" }, { start: 0.5, end: 0.9, word: "b", speaker: "S1" },
    { start: 2.0, end: 2.3, word: "c", speaker: "S1" }, { start: 2.4, end: 2.6, word: "d", speaker: "S2" },
  ];
  assert.deepEqual(utterances(w).map((u) => [u.speaker, u.text]), [["S1", "a b"], ["S1", "c"], ["S2", "d"]]);
  assert.deepEqual(pauses(w, 4), [{ start: 0.9, end: 2.0 }, { start: 2.6, end: 4 }]);
});

test("speaking spans: smoothed ASD score above zero, short blips dropped", () => {
  const scores = [...new Array(10).fill(-2), ...new Array(20).fill(1.5), -3, ...new Array(3).fill(2), ...new Array(10).fill(-2)];
  const sp = speakingSpans({ t0: 10, fps: 25, scores }, { asdSmooth: 1 });
  assert.equal(sp.length, 1);
  assert.equal(sp[0].start, 10 + 10 / 25);
  assert.equal(sp[0].end, 10 + 30 / 25);
});

test("voices ↔ faces: the face that speaks during a voice is linked; a voice whose visible face stays silent is off-screen", () => {
  const fps = 25;
  // P1 is on screen 0–20 s and speaks during S1's turns (0–8, 12–20); S2 (8–12) is the person behind the camera:
  // P1 is visible but silent then. P2 appears 20–30 s and speaks during S3.
  const p1 = Array.from({ length: 20 * fps }, (_, f) => (f / fps < 8 || f / fps >= 12 ? 1 : -1));
  const p2 = Array.from({ length: 10 * fps }, () => 1);
  const excl = [{ start: 0, end: 8, speaker: "S1" }, { start: 8, end: 12, speaker: "S2" }, { start: 12, end: 20, speaker: "S1" }, { start: 20, end: 30, speaker: "S3" }];
  const r = linkSpeakersToFaces(excl, [{ id: "T1", identity: "P1", t0: 0, fps, scores: p1 }, { id: "T2", identity: "P2", t0: 20, fps, scores: p2 }]);
  assert.equal(r.links.S1.face, "P1");
  assert.equal(r.links.S3.face, "P2");
  assert.equal(r.links.S2.face, null);
  assert.equal(r.links.S2.offScreen, true);
});

test("buildTimeline joins the stages into one sorted, valid timeline (missing stages are fine)", () => {
  const fps = 25;
  const stages = {
    words: { model: "wav2vec2", asrModel: "nemo", words: [{ start: 0.2, end: 0.6, word: "ازيك", aligned: true, align_conf: 0.9, asr_start: 0.1, asr_end: 0.6 }, { start: 3, end: 3.4, word: "تمام", aligned: false, asr_start: 3, asr_end: 3.4 }] },
    speakers: { model: "community-1", exclusive: [{ start: 0, end: 1.5, speaker: "SPEAKER_00" }, { start: 2.8, end: 4, speaker: "SPEAKER_01" }], overlap: [], turns: [] },
    faces: { model: "buffalo_l", fps, tracks: [{ id: "T1", t0: 0, t1: 4, identity: "P1", poor: false, quality: { det: 0.8 }, boxes: [[0, 0.1, 0.1, 0.2, 0.2, 0.9]] }], identities: [{ id: "P1", tracks: ["T1"], seconds: 4 }] },
    asd: { model: "LR-ASD", tracks: [{ id: "T1", t0: 0, fps, scores: Array.from({ length: 100 }, (_, f) => (f < 25 ? 2 : -2)) }] },
    audio: { tagModel: "PANNs", tags: [{ start: 1, end: 2, label: "Music", p: 0.6, index: 137 }], laughter: [{ start: 3.5, end: 4, p: 0.8, sources: ["laughter-detection", "PANNs"] }], loudness: [], pitch: [] },
    shots: { model: "TransNetV2", shots: [{ start: 0, end: 4 }] },
  };
  const tl = buildTimeline({ media: { duration: 4 }, stages, opts: { linkMinEvidenceS: 0.5 } });
  assert.equal(tl.version, 1);
  for (const e of tl.events) assert.deepEqual(validateEvent(e), [], JSON.stringify(e));
  for (let i = 1; i < tl.events.length; i++) assert.ok(tl.events[i].t0 >= tl.events[i - 1].t0);
  const c = countByType(tl.events);
  assert.equal(c.word, 2);
  assert.equal(c.speaker_turn, 2);
  assert.equal(c.laughter, 1);
  assert.equal(c.shot, 1);
  assert.equal(tl.events.find((e) => e.type === "word").speaker, "S1");
  assert.equal(tl.speakers.find((s) => s.id === "S1").face, "P1");
  assert.equal(tl.events.find((e) => e.type === "laughter").speaker, "S2");
  assert.equal(tl.events.find((e) => e.type === "active_speaker").speaker, "S1");
  assert.ok(buildTimeline({ media: { duration: 1 }, stages: {} }).events.length === 0);
});

test("stage plan adds what a stage needs, in pipeline order; cache keys change with parameters only", async () => {
  const { plan, stageKey, NEEDS, STAGES } = await import("../../src/services/perception/perceptionService.js");
  assert.deepEqual(plan(["asd"]), ["shots", "faces", "asd"]);
  assert.deepEqual(plan(["emotion", "words"]), ["words", "speakers", "emotion"]);
  assert.deepEqual(plan(), STAGES);
  assert.throws(() => plan(["nope"]));
  for (const s of STAGES) for (const n of NEEDS[s]) assert.ok(STAGES.indexOf(n) < STAGES.indexOf(s), `${n} before ${s}`);
  assert.equal(stageKey("faces", { a: 1, b: [1, 2] }), stageKey("faces", { b: [1, 2], a: 1 }));
  assert.notEqual(stageKey("faces", { a: 1 }), stageKey("faces", { a: 2 }));
  assert.notEqual(stageKey("faces", { a: 1 }), stageKey("asd", { a: 1 }));
});

test("file hash reads only the head and tail; the lock without a backend is a no-op", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileHash, makeGpuLock } = await import("../../src/services/perception/perceptionService.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-"));
  const a = path.join(dir, "a.bin"), b = path.join(dir, "b.bin");
  fs.writeFileSync(a, Buffer.alloc(100, 1));
  fs.writeFileSync(b, Buffer.alloc(100, 2));
  assert.notEqual(fileHash(a), fileHash(b));
  assert.equal(fileHash(a), fileHash(a));
  const lock = makeGpuLock();
  assert.equal(lock.kind, "none");
  const rel = await lock.acquire("x");
  await rel();
  let got = null;
  const q = makeGpuLock({ queue: { acquire: async (owner, id) => { got = [owner, id]; return () => {}; } } });
  await q.acquire("job1");
  assert.deepEqual(got, ["perception", "job1"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Arabic summary page renders every section from a timeline", async () => {
  const { summaryHtml } = await import("../../src/services/perception/summary.js");
  const tl = buildTimeline({ media: { name: "x.mp4", duration: 10, width: 1080, height: 1920, fps: 30 }, stages: {
    audio: { tagModel: "PANNs", tags: [{ start: 1, end: 2, label: "Music", p: 0.6, index: 137 }], laughter: [{ start: 3, end: 4, p: 0.8, sources: ["PANNs"] }], loudness: [], pitch: [] },
  } });
  tl.report = { stages: { audio: { ms: 1200, vram: { deltaMB: 900 }, device: "cuda", model: "PANNs" } }, totalMs: 1500 };
  const html = summaryHtml(tl, { check: [{ what: "ضحك", t: 3, verdict: true, note: "باين" }] });
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /الضحك \(1\)/);
  assert.match(html, /مراجعة بالعين/);
  assert.match(html, /900/);
});
