// Easy Cover with its real engine (ComfyUI + SheetSage2 + YuE2 3B + the instrumental LoRA + Plenio, from the program's
// runtime and models folder — MONTAJ_MUSIC_MODELS, default runtime/models/music) on a real song (MONTAJ_COVER_SONG):
// 1. a 30 s preview: the stages are real, the file is as long as the part, the report carries the melody comparison;
// 2. a 4-minute part, generated in 3 sections: every section is at least 97 % of its score before the tempo fit (the
//    source studio's failure was a section that ended at two thirds), the song is exactly the part's length, no seam
//    is silent. MONTAJ_COVER_LONG=0 skips the long part.
// Skipped when the runtime, the models or the song are missing. Take the GPU lock first (D:\capcut new\gpu-lock.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { musicRuntime } from "../../src/services/musicSetupService.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS = process.env.MONTAJ_MUSIC_MODELS || path.join(APP, "runtime", "models", "music");
const SONG = process.env.MONTAJ_COVER_SONG || "F:\\AI_CREATIVE_STUDIO_PORTABLE_CLEAN\\outputs\\Music_Rework_Studio_V3\\Song_Rework\\8fa1be25c6754dc5\\Imports\\b5d82aeedcc54c14b82433ea5b81e6f1.mp3";
const OUT = process.env.MONTAJ_COVER_OUT || null; // keep the results here (for listening)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-cover-e2e-"));
const ready = !!musicRuntime(root) && fs.existsSync(path.join(MODELS, "checkpoints", "yue2_3b_bf16.safetensors")) && fs.existsSync(path.join(MODELS, "packages", "plenio-0.7.0.zip")) && fs.existsSync(SONG);
let S = null, closeDb = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open() {
  if (S) return;
  const { createServices } = await import("../../src/services/index.js");
  ({ closeDatabase: closeDb } = await import("../../src/db/realmClient.js"));
  S = await createServices({ root, notify: () => {} });
  S.settings.set("music", { modelsDir: MODELS });
}

async function waitJob(id) {
  for (let i = 0; i < 7200; i++) {
    const j = S.music.jobsList().find((x) => x.id === id);
    if (["done", "failed", "cancelled"].includes(j.state)) return j;
    await sleep(500);
  }
  throw new Error("cover timed out");
}

function keep(item, label) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(item.path, path.join(OUT, `${label}.wav`));
  fs.copyFileSync(item.meta.report, path.join(OUT, `${label}.report.json`));
  const takes = path.join(path.dirname(item.path), "sections");
  if (fs.existsSync(takes)) fs.cpSync(takes, path.join(OUT, `${label}-takes`), { recursive: true });
}
const brief = (s) => ({ index: s.index, start: s.start, end: s.end, chosen: s.chosen_take, takes: s.takes.map((k) => ({ seconds: k.seconds, expected: k.expected_seconds, window: k.window, min_frames: k.min_frames, fit: k.fit_ratio, vocal: k.vocal.notes, melody: k.melody.pitch_class_sequence_ratio, contour: k.melody.contour_direction_ratio, shift: k.melody.matched_register_shift_semitones, notes: [k.melody.source_notes, k.melody.output_notes], failures: k.failures, warnings: k.warnings })) });

after(async () => {
  try { await S?.music.stop(); } catch { /* not started */ }
  if (closeDb) closeDb({ shutdown: true });
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ }
});

test("Easy Cover: a 30 s preview keeps the part's length and reports the melody check", { timeout: 40 * 60_000 }, async (t) => {
  if (!ready) return t.skip("music runtime, cover models or the test song not prepared");
  await open();
  const src = await S.music.addSource(SONG, "عيون القلب");
  const t0 = Date.now();
  const j = S.music.submit({ path: "cover", source: src.file, start: 60, duration: 30, preview: true, preset: "oriental_takht", variant: "Classic", seed: 20261026, title: "كافر · عيون القلب" });
  const done = await waitJob(j.id);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  const stages = done.stages.map((x) => x.stage);
  for (const st of ["engine", "analyze", "score", "load", "generate", "check", "save"]) assert.ok(stages.includes(st), `stage ${st} reported (${stages})`);
  const item = S.music.item(done.result);
  const report = JSON.parse(fs.readFileSync(item.meta.report, "utf8"));
  const probe = await S.media.probe(item.path);
  console.log("PREVIEW", Math.round((Date.now() - t0) / 1000), "s", JSON.stringify({ status: report.status, seconds: probe.durationUs / 1e6, sections: report.sections.map((s) => s.takes.map((k) => ({ seconds: k.seconds, expected: k.expected_seconds, fit: k.fit_ratio, vocal: k.vocal.notes, melody: k.melody.pitch_class_sequence_ratio, contour: k.melody.contour_direction_ratio, shift: k.melody.matched_register_shift_semitones, failures: k.failures, warnings: k.warnings }))) }));
  keep(item, "preview");
  assert.equal(report.path, "cover");
  assert.ok(Math.abs(probe.durationUs / 1e6 - 30) < 1.5, `length ${probe.durationUs / 1e6}`);
  const take = report.sections[0].takes[report.sections[0].chosen_take - 1];
  assert.ok(take.seconds >= take.expected_seconds * 0.97 - 0.05, `the model did not stop early (${take.seconds} of ${take.expected_seconds})`);
  assert.ok(take.melody.sufficient, "enough notes to compare the melody");
});

test("Easy Cover: a 4-minute part in 3 sections — no section ends early, the song is the part's length", { timeout: 90 * 60_000 }, async (t) => {
  if (!ready) return t.skip("music runtime, cover models or the test song not prepared");
  if (process.env.MONTAJ_COVER_LONG === "0") return t.skip("MONTAJ_COVER_LONG=0");
  await open();
  const src = S.music.sources().find((x) => x.name === "عيون القلب") || await S.music.addSource(SONG, "عيون القلب");
  const t0 = Date.now();
  const j = S.music.submit({ path: "cover", source: src.file, start: 170, duration: 240, preset: "oriental_takht", variant: "Classic", seed: 20261026, title: "كافر طويل · عيون القلب" });
  const done = await waitJob(j.id);
  const sectionsFile = done.state === "done" ? null : fs.readdirSync(path.join(root, "library", "music"), { recursive: true }).find((f) => String(f).endsWith("sections.json"));
  if (sectionsFile) { const x = JSON.parse(fs.readFileSync(path.join(root, "library", "music", String(sectionsFile)), "utf8")); console.log("SECTIONS", JSON.stringify({ cuts: x.plan.cuts, baseline: x.melody_baseline_between_sections, sections: x.sections.map(brief) })); }
  assert.equal(done.state, "done", JSON.stringify(done.error));
  const item = S.music.item(done.result);
  const report = JSON.parse(fs.readFileSync(item.meta.report, "utf8"));
  const probe = await S.media.probe(item.path);
  console.log("LONG", Math.round((Date.now() - t0) / 1000), "s", JSON.stringify({ status: report.status, seconds: probe.durationUs / 1e6, cuts: report.plan.cuts, seams: report.seams,
    baseline: report.melody_baseline_between_sections, review: report.review_reasons, sections: report.sections.map(brief) }));
  keep(item, "long");
  assert.equal(report.sections.length, 3, "generated in 3 sections");
  for (const s of report.sections) for (const k of s.takes) assert.ok(k.seconds >= k.expected_seconds * 0.97 - 0.05, `section ${s.index} take ${k.take} stopped early: ${k.seconds} of ${k.expected_seconds}`);
  assert.ok(Math.abs(probe.durationUs / 1e6 - 240) < 0.5, `length ${probe.durationUs / 1e6}`);
  assert.equal(report.seams.length, 2);
  assert.ok(report.seams.every((x) => !x.silence_warning), "no silent seam");
});
