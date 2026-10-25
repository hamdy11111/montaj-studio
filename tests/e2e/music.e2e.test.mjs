// The music studio's whole cycle with its real engine (ComfyUI + ACE-Step 1.5 from the program's own runtime and
// models folder — MONTAJ_MUSIC_MODELS, default runtime/models/music): nothing starts with the app; a short piece is
// generated with its real stages; the file is valid and as long as asked; a refinement is a new version and the first
// stays; "save as" MP3 is a real MP3; added to a project and to its timeline (one undo removes it); everything is back
// after the app restarts; "stop" ends the engine and frees its GPU memory. RAM/GPU are measured before, during and after.
// Skipped when the runtime or the models are not prepared.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { musicRuntime } from "../../src/services/musicSetupService.js";
import { gpuFree } from "../../src/services/musicService.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS = process.env.MONTAJ_MUSIC_MODELS || path.join(APP, "runtime", "models", "music");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-music-e2e-"));
const ready = !!musicRuntime(root) && fs.existsSync(path.join(MODELS, "diffusion_models", "acestep_v1.5_turbo.safetensors"));
let S = null, closeDb = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const measures = [];

async function open() {
  const { createServices } = await import("../../src/services/index.js");
  ({ closeDatabase: closeDb } = await import("../../src/db/realmClient.js"));
  S = await createServices({ root, notify: () => {} });
  S.settings.set("music", { modelsDir: MODELS });
}

async function waitJob(id, seen) {
  for (let i = 0; i < 1800; i++) {
    const j = S.music.jobsList().find((x) => x.id === id);
    if (j.stage) seen.add(j.stage);
    if (j.stage === "generate" && !measures.some((m) => m.when === "during")) measures.push({ when: "during", ...S.music.resources() });
    if (["done", "failed", "cancelled"].includes(j.state)) return j;
    await sleep(500);
  }
  throw new Error("generation timed out");
}

after(async () => {
  try { await S?.music.stop(); } catch { /* not started */ }
  if (closeDb) closeDb({ shutdown: true });
  console.log("RESOURCES", JSON.stringify(measures));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ }
});

test("generate → listen → refine → save → project → timeline → restart → stop", { timeout: 60 * 60_000 }, async (t) => {
  if (!ready) return t.skip("music runtime or ACE-Step models not prepared");
  await open();
  measures.push({ when: "before", ...S.music.resources() });
  assert.equal(S.music.status().engine.running, false, "opening the app starts no engine");
  const seen = new Set();
  const t0 = Date.now();
  const j = S.music.submit({ path: "compose", preset: "suspense", energy: "calm", duration: 8, seed: 12345, title: "اختبار ترقّب" });
  assert.equal(j.state, "queued", "received at once");
  assert.throws(() => S.music.submit({ path: "compose", duration: 8 }), (e) => e.messageKey === "err.musicBusy", "a second click makes no second job");
  const done = await waitJob(j.id, seen);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  const stages = done.stages.map((x) => x.stage);
  for (const st of ["engine", "load", "compose", "generate", "decode", "save"]) assert.ok(stages.includes(st), `stage ${st} reported (${stages})`);
  console.log("STAGES", JSON.stringify(done.stages));
  console.log("first generation (cold start) took", Math.round((Date.now() - t0) / 1000), "s");
  const first = S.music.item(done.result);
  assert.ok(fs.existsSync(first.path));
  const probe = await S.media.probe(first.path);
  assert.ok(Math.abs(probe.durationUs / 1e6 - 8) < 1.5, `length ${probe.durationUs / 1e6}`);
  assert.equal(first.meta.seed, 12345);
  assert.match(first.meta.engine, /ACE-Step/);
  assert.ok((await S.music.peaks(first.id)).length > 100, "a waveform");
  assert.ok(!/^\d+$/.test(path.basename(first.path, ".wav")), "a readable name");

  // A refinement is a new version of the same work; the first stays.
  const t1 = Date.now();
  const j2 = S.music.submit({ path: "compose", preset: "suspense", energy: "energetic", duration: 8, seed: 12345, title: "اختبار ترقّب", group: done.group, parent: first.id });
  const done2 = await waitJob(j2.id, new Set());
  assert.equal(done2.state, "done", JSON.stringify(done2.error));
  console.log("second generation (engine warm) took", Math.round((Date.now() - t1) / 1000), "s");
  const versions = S.music.library({ group: done.group });
  assert.equal(versions.length, 2);
  assert.ok(fs.existsSync(first.path), "the first version is kept");
  assert.equal(S.music.item(done2.result).meta.parent, first.id);

  // Inspired by a reference (its sound only, never its notes), made into a loop.
  const j3 = S.music.submit({ path: "inspired", preset: "reference_vibe", duration: 8, seed: 99, title: "مستوحاة", loop: true, reference: { file: first.path, start: 1, seconds: 6 } });
  const done3 = await waitJob(j3.id, new Set());
  assert.equal(done3.state, "done", JSON.stringify(done3.error));
  assert.ok(done3.stages.some((x) => x.stage === "reference"), "the reference is encoded");
  const inspired = S.music.item(done3.result);
  assert.ok(inspired.meta.reference, "the reference is recorded");
  assert.ok(inspired.meta.loop, "made into a loop");
  const audit = JSON.parse(fs.readFileSync(inspired.meta.report, "utf8")).condition_audit;
  assert.ok(audit.some((a) => a.reference_to_timbre_encoder_only === true && a.reference_tokens_used === false), "only the reference's sound, none of its notes");
  console.log("INSPIRED", JSON.stringify({ reference: inspired.meta.reference, loop: inspired.meta.loop, audit }));

  // Save as MP3 (the real format checked).
  const mp3 = path.join(root, "حفظ.mp3");
  await S.music.saveAs(first.id, mp3);
  assert.match(String((await S.media.probe(mp3)).audioCodec || ""), /mp3/i);

  // Into a project, then onto its timeline; one undo removes it.
  const p = S.projects.create({ name: "music e2e" });
  const media = await S.music.addToProject(first.id, p.id);
  const before = S.timelines.get(p.mainTimelineId).timeline.tracks.flatMap((x) => x.segments).length;
  await S.timelines.exec(p.mainTimelineId, "addMedia", { mediaId: media.id, toMain: false, atUs: 0 });
  assert.equal(S.timelines.get(p.mainTimelineId).timeline.tracks.flatMap((x) => x.segments).length, before + 1);
  await S.timelines.exec(p.mainTimelineId, "undo", {});
  assert.equal(S.timelines.get(p.mainTimelineId).timeline.tracks.flatMap((x) => x.segments).length, before, "undo removes it");
  await S.timelines.exec(p.mainTimelineId, "addMedia", { mediaId: media.id, toMain: false, atUs: 0 });

  // Stop: the engine ends and its GPU memory comes back.
  measures.push({ when: "engine on, after generating", ...S.music.resources() });
  const { pid, workPid } = S.music.status().engine;
  assert.ok(measures.find((m) => m.when === "during").engineRamMB > 500, "the engine's real process is measured");
  await S.music.stop();
  await sleep(3000);
  assert.equal(S.music.status().engine.running, false);
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  assert.equal(alive(pid) || alive(workPid), false, "the engine processes are gone");
  measures.push({ when: "after stop", ...S.music.resources() });
  const g0 = measures[0].gpu, g1 = measures.at(-1).gpu;
  if (g0 && g1) assert.ok(g1.free >= g0.free - 1500, `GPU memory freed (before ${g0.free} MiB free, after ${g1.free})`);

  // Restart: the library, the settings and the project's link are back.
  closeDb({ shutdown: true });
  await open();
  const again = S.music.library({ group: done.group });
  assert.equal(again.length, 2);
  assert.equal(again.find((x) => x.id === first.id).meta.seed, 12345);
  assert.ok(S.repos.media.listByProject(p.id, {}).some((m) => m.path === first.path), "the project still uses the same file");
  assert.equal(S.music.status().engine.running, false, "nothing restarted by itself");
});
