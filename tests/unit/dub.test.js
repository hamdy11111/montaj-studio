// Dubbing on the timeline (core/timelineOps applyDub / setDubLanguage / removeDub) and the dub service's plan of a run:
// every line is its own voice clip with its subtitle (grouped, so they move together), the Arabic lines are there
// hidden, the clip's own sound is a muted track, the background follows the clips; lines in a cut part are left out;
// a second language keeps the first (muted); a hand-moved line keeps its shift when voiced again; export lowers the
// background under the voice clips where they are.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline, mainTrack } from "../../src/core/model.js";
import { buildExport } from "../../src/core/exportGraph.js";
import { DubService, DUB_LANGUAGES, snapWords } from "../../src/services/dubService.js";
import { US } from "../../src/core/util.js";
import { has } from "../../src/renderer/js/i18n.js";

const media = (id, durS, type = "video") => ({ id, name: `${id}.mp4`, type, durationUs: durS * US, width: 1920, height: 1080, hasAudio: true, path: `C:/m/${id}.mp4` });
const LINES = [
  { n: 0, label: "S1", text: "First line.", ar: "الجملة الأولى", arStart: 1 * US, arEnd: 3 * US, at: 1 * US, duration: 1.8 * US },
  { n: 1, label: "S2", text: "Cut away.", ar: "دي اتقصت", arStart: 4.5 * US, arEnd: 5.5 * US, at: 4.5 * US, duration: 0.9 * US },
  { n: 2, label: "S1", text: "Third line.", ar: "الجملة التالتة", arStart: 7 * US, arEnd: 9 * US, at: 7.1 * US, duration: 1.7 * US },
];
const dubOf = (lang) => ({ lang, source: media("v", 10), voice: media(`voice-${lang}`, 10, "audio"), background: media("bg", 10, "audio"), lines: LINES, canvas: { width: 1920, height: 1080 } });
const role = (tl, part) => tl.tracks.find((t) => t.role === ops.dubRole("v", part));

/** A 10 s video with 4–6 s cut out. */
function cutVideo() {
  const tl = newTimeline("p1");
  ops.addMediaSegment(tl, media("v", 10));
  const main = mainTrack(tl);
  ops.splitSegment(tl, main.segments[0].id, 4 * US);
  ops.splitSegment(tl, main.segments[1].id, 6 * US);
  ops.deleteSegments(tl, [main.segments[1].id], { magnet: true, linkage: true, linkTypes: [] });
  return tl;
}

test("a dub puts every line on the timeline: its voice clip and subtitle together, the Arabic hidden, the original muted", () => {
  const tl = cutVideo();
  const r = ops.applyDub(tl, "v", dubOf("en"));
  assert.equal(r.placed, 2, "the line in the cut part is left out");
  const voice = role(tl, "voice:en"), cap = role(tl, "cap:en"), ar = role(tl, "cap:ar"), orig = role(tl, "orig"), bg = role(tl, "bg");
  assert.ok(voice && cap && ar && orig && bg);
  assert.deepEqual(voice.segments.map((s) => s.name), ["#1 · S1", "#3 · S1"]);
  // Line 3 is at 7.1 s of the source → 5.1 s on the timeline (2 s were cut before it); voice.wav is in source time.
  const third = voice.segments[1];
  assert.equal(third.start, 5.1 * US);
  assert.equal(third.sourceStart, 7.1 * US);
  assert.equal(third.duration, 1.7 * US);
  const sub = cap.segments.find((s) => s.groupId === third.groupId);
  assert.equal(sub.text.content, "Third line.");
  assert.equal(sub.start, third.start, "the subtitle is where its voice is");
  assert.equal(ar.hidden, true);
  assert.deepEqual(ar.segments.map((s) => s.text.content), ["الجملة الأولى", "الجملة التالتة"]);
  assert.equal(ar.segments[0].text.direction, "rtl");
  assert.equal(orig.muted, true);
  assert.equal(orig.segments.length, 2, "the original sound follows the two clips");
  assert.deepEqual(bg.segments.map((s) => [s.start, s.sourceStart]), mainTrack(tl).segments.map((s) => [s.start, s.sourceStart]));
  assert.ok(mainTrack(tl).segments.every((s) => s.audioDetached));
  assert.ok(!voice.muted && !cap.hidden);
  // The view order: subtitles above the Arabic, both above the video; under it the original, the voice, the background.
  const order = (t) => t.order;
  assert.ok(order(cap) > order(ar));
  assert.ok(order(orig) < order(voice) && order(voice) < order(bg));
  assert.deepEqual(ops.validateTimeline(tl), []);
});

test("moving a line moves its subtitle; voicing it again keeps the shift; a second language mutes the first", () => {
  const tl = cutVideo();
  ops.applyDub(tl, "v", dubOf("en"));
  const first = role(tl, "voice:en").segments[0];
  ops.moveSegment(tl, first.id, first.start + 0.3 * US, null, { magnet: false });
  const sub = role(tl, "cap:en").segments.find((s) => s.groupId === first.groupId);
  assert.equal(sub.start, 1.3 * US, "grouped: the subtitle moved with its voice");
  ops.applyDub(tl, "v", dubOf("en"));
  assert.equal(role(tl, "voice:en").segments[0].start, 1.3 * US, "voiced again: the hand shift stays");
  ops.applyDub(tl, "v", dubOf("fr"));
  assert.deepEqual(ops.dubLanguages(tl, "v"), { langs: ["en", "fr"], active: "fr" });
  assert.equal(role(tl, "voice:en").muted, true);
  assert.equal(role(tl, "cap:en").hidden, true);
  ops.setDubLanguage(tl, "v", "en");
  assert.equal(role(tl, "voice:en").muted, false);
  assert.equal(role(tl, "voice:fr").muted, true);
  assert.equal(role(tl, "cap:fr").hidden, true);
  ops.removeDub(tl, "v", "en");
  assert.deepEqual(ops.dubLanguages(tl, "v"), { langs: ["fr"], active: "fr" }, "the language left is heard");
  ops.removeDub(tl, "v");
  assert.equal(tl.tracks.filter((t) => (t.role || "").startsWith("dub:")).length, 0);
  assert.ok(mainTrack(tl).segments.every((s) => !s.audioDetached), "the original sound is back");
});

test("export lowers the background under the voice clips where they are, and plays neither the muted original nor a muted language", () => {
  const tl = cutVideo();
  const d = dubOf("en");
  ops.applyDub(tl, "v", d);
  const mediaById = { v: d.source, "voice-en": d.voice, bg: d.background };
  const graph = JSON.stringify(buildExport(tl, { width: 640, height: 360, fps: 30, mode: "audio", format: "mp3", media: mediaById }));
  const ducks = graph.match(/volume='1-0\.4988\*min\(1,[^']*'/g) || [];
  assert.equal(ducks.length, 2, "each background clip is ducked");
  assert.equal((ducks[0].match(/clip\(/g) || []).length, 2, "under the first clip's one voice line (two ramps)");
  assert.ok(!graph.includes("C:/m/v.mp4"), "the muted original is not in the mix (nor the video's own sound)");
  ops.applyDub(tl, "v", { ...d, lang: "fr", voice: media("voice-fr", 10, "audio") });
  const two = JSON.stringify(buildExport(tl, { width: 640, height: 360, fps: 30, mode: "audio", format: "mp3", media: { ...mediaById, "voice-fr": media("voice-fr", 10, "audio") } }));
  assert.ok(two.includes("voice-fr.mp4") && !two.includes("voice-en.mp4"), "only the heard language is in the mix");
});

test("word times are snapped to the sound, as the captions do", () => {
  // 1 s of silence then 1 s of tone at 16 kHz in 10 ms frames: a word reported from 0.5 s really starts at 1 s.
  const env = [...Array(100).fill(1), ...Array(100).fill(1000)];
  const j = { segments: [{ start: 0.5, end: 1.8, words: [{ word: "كلمة", start: 0.5, end: 1.8 }] }] };
  const out = snapWords(j, { env, frameUs: 10_000 });
  assert.equal(out.snapped, true);
  assert.ok(Math.abs(out.segments[0].words[0].start - 0.97) < 0.02, `start ${out.segments[0].words[0].start}`);
});

test("the run is planned in stages; cached audio work costs nothing; every language and error has a name", () => {
  const svc = new DubService({ repos: {}, paths: { root: "", cache: "" } });
  const fresh = svc.estimate(150), cached = svc.estimate(150, { separate: true, words: true, speakers: true });
  assert.deepEqual(fresh.stages.map((s) => s.key), ["separate", "words", "speakers", "translate", "voices", "timeline"]);
  assert.ok(cached.totalSec < fresh.totalSec - 60);
  assert.ok(svc.estimate(600).totalSec > fresh.totalSec, "longer video, longer run");
  for (const l of DUB_LANGUAGES) assert.ok(has(`dub.l.${l}`), l);
  for (const s of fresh.stages) assert.ok(has(`dub.stage.${s.key}`), s.key);
  for (const k of ["err.dubNotReady", "err.dubNotArabic", "err.dubFailed", "err.dubTranslator", "err.dubNone", "err.dubNoClip", "err.dubOneVideo", "err.dubBusy", "dub.heard", "dub.thin"]) assert.ok(has(k), k);
});

test("who says each word: quick replies between a man and a woman, two men, one person split in two (the dub runtime's Python)", async (t) => {
  const py = path.join(process.cwd(), "runtime", "dub", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!fs.existsSync(py)) return t.skip("dub runtime not set up");
  const r = spawnSync(py, ["-X", "utf8", path.join("tests", "python", "test_dub_speakers.py")], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || "").slice(-1500));
  assert.equal((r.stdout.match(/^ok /gm) || []).length, 3);
});
