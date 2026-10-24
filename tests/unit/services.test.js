// Service layer through the real composition root (Realm + FFmpeg, no Electron): projects, templates, timelines,
// timeline commands, settings validation, analysis, captions, packages, backup/restore and offline TTS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { US } from "../../src/core/util.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-svc-"));
const events = [];
let S, project, clip, silentGap;

before(async () => {
  S = await createServices({ root, notify: (e, p) => events.push([e, p]) });
  const ff = binaries().ffmpeg;
  clip = path.join(root, "scenes.mp4");
  // Two visually different halves (scene cut at 2 s) and a silent second in the middle of the audio.
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=2", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=500:duration=4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v];[2:a]volume='if(between(t,1.5,2.7),0,1)':eval=frame[a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip], { timeoutMs: 120_000 });
  silentGap = [1.5 * US, 2.7 * US];
});

after(() => { closeDatabase({ shutdown: true }); fs.rmSync(root, { recursive: true, force: true }); });

test("projects: default names, rename conflicts, duplicate, templates", async () => {
  project = S.projects.create({});
  const second = S.projects.create({});
  assert.match(second.name, /^\d{4} \(1\)$/);
  assert.throws(() => S.projects.rename(second.id, project.name), (e) => e.messageKey === "err.nameTaken");
  const dup = S.projects.duplicate(project.id);
  assert.notEqual(dup.id, project.id);
  const tpl = S.projects.saveAsTemplate(project.id, { name: "Promo" });
  assert.equal(tpl.isTemplate, true);
  assert.equal(S.projects.listTemplates({ orientation: tpl.template.orientation }).length, 1);
  const fromTpl = S.projects.useTemplate(tpl.id);
  assert.equal(fromTpl.isTemplate, false);
  assert.equal(S.repos.projects.get(tpl.id).template.usageCount, 1);
  S.projects.toggleTemplateFavorite(tpl.id);
  assert.equal(S.projects.listTemplates({ favorite: true }).length, 1);
  for (const p of [second, dup, fromTpl]) S.projects.deleteForever(p.id);
});

test("import, timeline commands, history and one-step batch edits", async () => {
  const { imported } = await S.media.importFiles(project.id, [clip]);
  const m = imported[0];
  await S.media.generateDerivatives(m.id);
  assert.ok(events.some(([e, p]) => e === "media:updated" && p.id === m.id));
  const tid = project.mainTimelineId;
  let r = await S.timelines.exec(tid, "addMedia", { mediaId: m.id });
  const segId = r.result;
  r = await S.timelines.exec(tid, "extractAudio", { segId });
  assert.equal(r.timeline.tracks.filter((t) => t.type === "audio").length, 1);
  r = await S.timelines.exec(tid, "extractAudio", { segId }); // restore
  assert.equal(r.timeline.tracks.filter((t) => t.type === "audio").length, 0);
  r = await S.timelines.exec(tid, "patchMany", { items: [{ segId, patch: { volumeDb: -3 } }, { segId, patch: { transform: { x: 0.1 } } }] });
  const depth = r.history.depth;
  r = await S.timelines.exec(tid, "undo");
  assert.equal(r.history.depth, depth - 1);
  assert.equal(r.timeline.tracks[0].segments[0].volumeDb, 0);
  await S.timelines.exec(tid, "redo");
  await assert.rejects(S.timelines.exec(tid, "updateSegment", { segId, patch: { mediaId: "x" } }), (e) => e.messageKey === "err.fieldNotPatchable");
  await assert.rejects(S.timelines.exec(tid, "nope", {}), (e) => e.messageKey === "err.unknownCommand");
  const still = await S.timelines.exec(tid, "freeze", { segId, atUs: 1e6, durationUs: 1e6 });
  assert.equal(still.timeline.tracks[0].segments.length, 3); // left, still, right
  await S.timelines.exec(tid, "undo");
});

test("analysis finds the scene cut and the silent range; remove silences shortens the clip", async () => {
  const m = S.repos.media.listByProject(project.id)[0];
  const cuts = await S.analysis.scenes(m.id, {});
  assert.ok(cuts.some((u) => Math.abs(u - 2 * US) < 0.15 * US), `cuts ${cuts}`);
  const sil = await S.analysis.silences(m.id, { minDurS: 0.5 });
  assert.equal(sil.length, 1);
  assert.ok(Math.abs(sil[0][0] - silentGap[0]) < 0.2 * US && Math.abs(sil[0][1] - silentGap[1]) < 0.2 * US);
  const tid = project.mainTimelineId;
  const seg = S.timelines.get(tid).timeline.tracks[0].segments[0];
  const r = await S.timelines.exec(tid, "removeRanges", { segId: seg.id, ranges: sil });
  const dur = r.timeline.tracks[0].segments.reduce((a, s) => a + s.duration, 0);
  assert.ok(Math.abs(dur - (4 * US - (sil[0][1] - sil[0][0]))) < 0.05 * US);
  const shorts = await S.analysis.shortsCandidates(m.id, { minS: 1, maxS: 3 });
  assert.ok(shorts.length >= 1);
});

test("settings are validated; captions import and auto-captions need a local provider", async () => {
  assert.throws(() => S.settings.set("edit", { stepFrames: 0 }), (e) => e.messageKey === "err.range");
  assert.throws(() => S.settings.set("edit", { bogus: 1 }), (e) => e.messageKey === "err.settingUnknown");
  assert.equal(S.settings.set("general", { language: "en" }).language, "en");
  const srt = path.join(root, "c.srt");
  fs.writeFileSync(srt, "1\n00:00:00,500 --> 00:00:01,500\nمرحبا\n");
  const cues = S.captions.importFile(srt);
  const segs = S.captions.segmentsFromCues(cues, { language: "ar" });
  assert.equal(segs[0].text.isCaption, true);
  assert.equal(segs[0].transform.y, 0.36);
  const m = S.repos.media.listByProject(project.id)[0];
  await assert.rejects(S.captions.transcribe({ mediaId: m.id }), (e) => e.code === "PROVIDER" && e.messageKey === "err.whisperNotConfigured");
});

test("package export/import round trip keeps media and timeline structure", async () => {
  const file = path.join(root, "share.mstudio");
  const out = await S.packages.exportPackage(project.id, file);
  assert.ok(out.sizeBytes > 1000);
  const imported = await S.packages.importPackage(file);
  assert.notEqual(imported.id, project.id);
  const a = S.timelines.get(project.mainTimelineId).timeline, b = S.repos.timelines.get(imported.mainTimelineId);
  assert.deepEqual(b.tracks.map((t) => t.segments.length), a.tracks.map((t) => t.segments.length));
  assert.equal(S.repos.media.listByProject(imported.id).length, S.repos.media.listByProject(project.id).length);
  assert.deepEqual(S.repos.shares.list().map((x) => x.direction).sort(), ["in", "out"]);
  S.projects.deleteForever(imported.id);
});

test("backup and restore replace the database and keep a safety copy", async () => {
  const b = S.backup.backup(undefined, { includeMedia: false });
  assert.equal(b.manifest.counts.projects >= 1, true);
  const extra = S.projects.create({ name: "after backup" });
  assert.ok(S.repos.projects.list().some((p) => p.id === extra.id));
  const r = await S.backup.restore(b.dir);
  assert.ok(fs.existsSync(r.previous));
  assert.ok(!S.repos.projects.list().some((p) => p.id === extra.id)); // restored state
  assert.throws(() => S.backup.readManifest(root), (e) => e.messageKey === "err.backupInvalid");
});

test("offline text-to-speech with an installed Windows voice", { skip: process.platform !== "win32" }, async () => {
  const voices = await S.tts.voices();
  assert.ok(voices.length > 0, "no Windows voices installed");
  const ar = voices.find((v) => /^ar/i.test(v.language));
  const a = await S.tts.synthesize(project.id, { text: ar ? "مرحبا بكم" : "Hello there", voice: (ar || voices[0]).name });
  assert.equal(a.type, "audio");
  assert.ok(a.durationUs > 300_000);
  assert.equal(a.origin, "tts");
});
