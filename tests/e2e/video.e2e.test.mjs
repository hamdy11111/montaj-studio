// The video studio's whole cycle with its real engine (ComfyUI + MiniMax H3 + SAM 3.1 + SeedVR2 from the program's
// own runtime and models folder — MONTAJ_VIDEO_MODELS, default runtime/models/video): nothing starts with the app; a
// short generation (a person replaced from one reference image) with its real stages; a valid video of the planned
// length and size with the source's sound; one short quality enhancement as a new version (the original kept); a
// cancel during sampling; save as MP4; into a project and its timeline (one undo removes it); everything back after a
// restart; "stop" ends the engine and frees its GPU memory. RAM/GPU are measured before, during and after.
// Needs MONTAJ_VIDEO_SAMPLE (a video with one person in its first seconds) and MONTAJ_VIDEO_REF (a picture of a
// person); skipped otherwise or when the runtime/models are not prepared. Inputs are never committed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { videoRuntime } from "../../src/services/videoSetupService.js";
import { outputDimensions, enhanceDimensions, snapFrames } from "../../src/services/video/graphs.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS = process.env.MONTAJ_VIDEO_MODELS || path.join(APP, "runtime", "models", "video");
const SAMPLE = process.env.MONTAJ_VIDEO_SAMPLE || "", REF = process.env.MONTAJ_VIDEO_REF || "";
const START = Number(process.env.MONTAJ_VIDEO_START || 2.5), END = Number(process.env.MONTAJ_VIDEO_END || 4.2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-video-e2e-"));
const ready = !!videoRuntime(root) && fs.existsSync(path.join(MODELS, "diffusion_models", "minimax_h3_ref2va_pruned_int8_convrot.safetensors")) && fs.existsSync(SAMPLE) && fs.existsSync(REF);
let S = null, closeDb = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const measures = [];

async function open() {
  const { createServices } = await import("../../src/services/index.js");
  ({ closeDatabase: closeDb } = await import("../../src/db/realmClient.js"));
  S = await createServices({ root, notify: () => {} });
  S.settings.set("video", { modelsDir: MODELS });
}

const stepTimes = {};
async function waitJob(id, { onTick = () => {} } = {}) {
  const t0 = Date.now();
  for (let i = 0; i < 7200; i++) {
    const j = S.video.jobsList().find((x) => x.id === id);
    if (j.step && !(stepTimes[id] ||= []).some((s) => s.step === j.step)) stepTimes[id].push({ step: j.step, s: Math.round((Date.now() - t0) / 1000) });
    if (j.stage === "generate" && !measures.some((m) => m.when === "during generation")) measures.push({ when: "during generation", ...S.video.resources() });
    if (j.stage === "enhance" && !measures.some((m) => m.when === "during enhancement")) measures.push({ when: "during enhancement", ...S.video.resources() });
    if (await onTick(j)) return j;
    if (["done", "failed", "cancelled"].includes(j.state)) return j;
    await sleep(500);
  }
  throw new Error("timed out");
}

after(async () => {
  try { await S?.video.stop(); } catch { /* not started */ }
  if (closeDb) closeDb({ shutdown: true });
  console.log("RESOURCES", JSON.stringify(measures));
  console.log("STEP TIMES", JSON.stringify(stepTimes));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ }
});

test("sources → generate → watch → enhance → cancel → save → project → timeline → restart → stop", { timeout: 3 * 60 * 60_000 }, async (t) => {
  if (!ready) return t.skip("video runtime, models or the sample/reference not prepared");
  await open();
  S.videoSetup.accept("h3"); // the licence the user accepted for this test
  measures.push({ when: "before", ...S.video.resources() });
  assert.equal(S.video.status().engine.running, false, "opening the app starts no engine");
  const src = await S.video.addSource(SAMPLE, "sample"), ref = await S.video.addSource(REF, "reference");
  const settings = { durationMode: "range", start: START, megapixels: 0.4, steps: 20, sound: true, promptStyle: "reference", seed: 12345 };
  const plan = S.video.plan({ source: src.id, refs: [ref.id], end: END, settings });
  assert.equal(plan.frames, snapFrames(Math.floor((END - START) * 24 + 1e-8)));
  assert.equal(S.video.status().engine.running, false, "planning loads nothing");

  // One short generation.
  const t0 = Date.now();
  const j = S.video.submit({ kind: "generate", source: src.id, refs: [ref.id], end: END, settings, title: "اختبار" });
  assert.equal(j.state, "queued", "received at once");
  assert.throws(() => S.video.submit({ kind: "generate", source: src.id, refs: [ref.id], end: END, settings }), (e) => e.messageKey === "err.videoBusy");
  const done = await waitJob(j.id);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  const stages = done.stages.map((x) => x.stage);
  for (const st of ["cut", "engine", "load", "findPerson", "prepare", "generate", "decode", "save"]) assert.ok(stages.includes(st), `stage ${st} (${stages})`);
  console.log("STAGES", JSON.stringify(done.stages));
  console.log("generation (cold) took", Math.round((Date.now() - t0) / 1000), "s");
  const first = S.video.item(done.result);
  const probe = await S.media.probe(first.path);
  assert.ok(Math.abs(probe.durationUs / 1e6 - plan.frames / 24) < 0.15, `length ${probe.durationUs / 1e6}`);
  assert.deepEqual([probe.width, probe.height], outputDimensions(src.width, src.height, 0.4));
  assert.ok(probe.hasAudio, "the source's sound is in the result");
  assert.equal(first.meta.seed, 12345);
  assert.equal(first.meta.engine, "MiniMax H3");
  assert.ok(fs.existsSync(first.meta.thumb) && fs.existsSync(first.meta.source.copy) && fs.existsSync(first.meta.refs[0].copy));

  // One short enhancement: a new version, the original kept.
  const t1 = Date.now();
  const e = S.video.submit({ kind: "enhance", item: first.id, settings: { shortEdge: 1080, strength: 0.6 } });
  const eDone = await waitJob(e.id);
  assert.equal(eDone.state, "done", JSON.stringify(eDone.error));
  console.log("enhancement took", Math.round((Date.now() - t1) / 1000), "s", JSON.stringify(eDone.stages));
  const enh = S.video.item(eDone.result);
  const ep = await S.media.probe(enh.path);
  assert.deepEqual([ep.width, ep.height], enhanceDimensions(probe.width, probe.height, 1080));
  assert.equal(enh.meta.parent, first.id);
  assert.ok(fs.existsSync(first.path), "the original stays");
  assert.equal(S.video.library({ group: done.group }).length, 2);

  // Cancel while sampling: no result, the engine stays up.
  const c = S.video.submit({ kind: "generate", source: src.id, refs: [ref.id], end: END, settings: { ...settings, seed: 7 }, title: "إلغاء" });
  let asked = false;
  const cDone = await waitJob(c.id, { onTick: async (x) => { if (!asked && x.stage === "generate" && x.step >= 1) { asked = true; await S.video.cancel(c.id); } return false; } });
  assert.equal(cDone.state, "cancelled", JSON.stringify(cDone.error));
  assert.equal(S.video.library({ group: cDone.group }).length, 0, "nothing saved for a cancelled job");
  assert.equal(S.video.status().engine.running, true);

  // Save as MP4 (checked), into a project and onto its timeline; one undo removes it.
  const saved = await S.video.saveAs(first.id, path.join(root, "حفظ.mp4"));
  assert.equal(saved.codec, "h264");
  const p = S.projects.create({ name: "video e2e" });
  const media = await S.video.addToProject(first.id, p.id);
  const count = () => S.timelines.get(p.mainTimelineId).timeline.tracks.flatMap((x) => x.segments).length;
  const before = count();
  await S.timelines.exec(p.mainTimelineId, "addMedia", { mediaId: media.id, toMain: false, atUs: 0 });
  assert.equal(count(), before + 1);
  await S.timelines.exec(p.mainTimelineId, "undo", {});
  assert.equal(count(), before, "undo removes it");
  await S.timelines.exec(p.mainTimelineId, "addMedia", { mediaId: media.id, toMain: false, atUs: 0 });

  // The results, kept outside the repository for the user to watch (MONTAJ_VIDEO_KEEP).
  if (process.env.MONTAJ_VIDEO_KEEP) {
    fs.mkdirSync(process.env.MONTAJ_VIDEO_KEEP, { recursive: true });
    for (const [x, n] of [[first.path, "1-generated.mp4"], [enh.path, "2-improved.mp4"], [first.meta.source.copy, "0-source-part.mp4"], [first.meta.refs[0].copy, `0-reference${path.extname(first.meta.refs[0].copy)}`]]) fs.copyFileSync(x, path.join(process.env.MONTAJ_VIDEO_KEEP, n));
  }

  // Stop: the engine ends and its GPU memory comes back.
  measures.push({ when: "engine on, after the jobs", ...S.video.resources() });
  const { pid, workPid } = S.video.status().engine;
  await S.video.stop();
  await sleep(3000);
  const alive = (x) => { try { process.kill(x, 0); return true; } catch { return false; } };
  assert.equal(alive(pid) || alive(workPid), false, "the engine processes are gone");
  measures.push({ when: "after stop", ...S.video.resources() });
  const g0 = measures[0].gpu, g1 = measures.at(-1).gpu;
  if (g0 && g1) assert.ok(g1.free >= g0.free - 1500, `GPU memory freed (before ${g0.free} MiB free, after ${g1.free})`);

  // Restart: the library, the project's media and the timeline are back; nothing restarts by itself.
  closeDb({ shutdown: true });
  await open();
  assert.equal(S.video.library({ group: done.group }).length, 2);
  assert.ok(S.repos.media.listByProject(p.id, {}).some((m) => m.path === first.path));
  assert.equal(count(), before + 1);
  assert.equal(S.video.status().engine.running, false);
  assert.equal(S.video.jobsList().find((x) => x.id === c.id).state, "cancelled");
});
