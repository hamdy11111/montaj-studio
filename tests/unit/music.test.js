// Music studio without its engine: the model manager (a download that stops resumes where it stopped and is checked
// by SHA-256; a model set is imported from a folder by name and hash, the folder only read; damaged files are found),
// the results library (a generated piece with its settings, seed and engine; ratings; "save as" in WAV/MP3/FLAC with
// the real format checked; adding it to a project's media), and the Arabic description rules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { MusicSetupService, relinkVenv } from "../../src/services/musicSetupService.js";
import { MusicService, fileTitle } from "../../src/services/musicService.js";
import { MODEL_SETS } from "../../src/services/music/catalog.js";
import { interpret, COMPOSE_PRESETS } from "../../src/services/music/presets.js";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-music-"));
const blob = crypto.randomBytes(3_000_000);
const sha = crypto.createHash("sha256").update(blob).digest("hex");
let server, url, S;
const FAKE = { id: "test-set", name: "Test", version: "1", engine: "test", paths: ["test"], license: "MIT", restrictions: "", needs: "", source: "", status: "experimental", files: [] };

before(async () => {
  // A local server that honours Range requests and can stop half-way (to test resuming).
  let cut = true;
  server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || "");
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { "Content-Length": blob.length - from, ...(m ? { "Content-Range": `bytes ${from}-${blob.length - 1}/${blob.length}` } : {}) });
    if (cut && !m) { cut = false; res.write(blob.subarray(0, 1_000_000)); setTimeout(() => res.destroy(), 300); return; }
    res.end(blob.subarray(from));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/model.bin`;
  FAKE.files = [{ url, file: "model.bin", dir: "diffusion_models", sha256: sha, size: blob.length }];
  MODEL_SETS.push(FAKE);
  S = await createServices({ root, notify: () => {} });
});
after(() => {
  MODEL_SETS.splice(MODEL_SETS.indexOf(FAKE), 1);
  server.close();
  closeDatabase({ shutdown: true });
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ }
});

test("a model download that stops resumes where it stopped and is checked by its SHA-256", async () => {
  const setup = new MusicSetupService({ paths: { root }, settings: { get: () => ({ modelsDir: path.join(root, "models") }) } });
  await assert.rejects(setup.download("test-set"), (e) => e.messageKey === "err.musicDownload");
  const part = path.join(root, "models", "diffusion_models", "model.bin.part");
  assert.equal(fs.statSync(part).size, 1_000_000, "the stopped download kept what it had");
  let st = await setup.status();
  assert.equal(st.sets.find((s) => s.id === "test-set").files[0].state, "partial");
  await setup.download("test-set");
  st = await setup.status({ verify: true });
  assert.equal(st.sets.find((s) => s.id === "test-set").installed, true, "resumed from 1 MB and the hash matches");
  // A damaged file is found by the check.
  fs.appendFileSync(path.join(root, "models", "diffusion_models", "model.bin"), "x");
  st = await setup.status();
  assert.equal(st.sets.find((s) => s.id === "test-set").files[0].state, "damaged");
});

test("a model set is imported from a folder by name and hash, the folder only read", async () => {
  const src = path.join(root, "elsewhere", "deep", "models");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "model.bin"), blob);
  const before = fs.statSync(path.join(src, "model.bin")).mtimeMs;
  const setup = new MusicSetupService({ paths: { root }, settings: { get: () => ({ modelsDir: path.join(root, "models2") }) } });
  const r = await setup.importFrom("test-set", path.join(root, "elsewhere"));
  assert.deepEqual(r.report.map((x) => x.result), ["copied"]);
  assert.equal(fs.statSync(path.join(src, "model.bin")).mtimeMs, before, "the source is untouched");
  assert.equal(r.status.sets.find((s) => s.id === "test-set").installed, true);
  // A file with the right name but other content is refused.
  fs.writeFileSync(path.join(src, "model.bin"), crypto.randomBytes(blob.length));
  const setup3 = new MusicSetupService({ paths: { root }, settings: { get: () => ({ modelsDir: path.join(root, "models3") }) } });
  const r3 = await setup3.importFrom("test-set", path.join(root, "elsewhere"));
  assert.deepEqual(r3.report.map((x) => x.result), ["mismatch"]);
});

test("a generated piece goes to the library with its settings; saved as WAV/MP3/FLAC in the real format; added to a project", async () => {
  const dir = path.join(root, "gen");
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, "music.wav"), mp3 = path.join(dir, "music.mp3"), flac = path.join(dir, "music.flac");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", wav], { timeoutMs: 60_000 });
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "320k", mp3], { timeoutMs: 60_000 });
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", wav, "-c:a", "flac", flac], { timeoutMs: 60_000 });
  const report = { path: "compose", engine: "ACE-Step 1.5 Turbo (ComfyUI)", settings: { preset: "suspense", seed: 7 }, composition: { seed: 7, prompt: "x" }, files: { wav, mp3, flac }, duration: 3, status: "HUMAN_LISTENING_REQUIRED", generation_seconds: 12 };
  const job = { group: "g1", title: "ترقّب قبل المفاجأة", req: {} };
  const item = await S.music.addResult(job, "v1", dir, report);
  assert.equal(item.name, "ترقّب قبل المفاجأة · نسخة 1");
  assert.equal(item.category, "music");
  assert.equal(item.meta.seed, 7);
  assert.equal(item.meta.engine, "ACE-Step 1.5 Turbo (ComfyUI)");
  assert.ok(path.basename(item.path).startsWith("ترقّب قبل المفاجأة"), "a readable file name, not digits");
  assert.ok(Math.abs(item.durationUs / 1e6 - 3) < 0.1);
  const dir2 = path.join(root, "gen2");
  fs.mkdirSync(dir2, { recursive: true });
  for (const f of [wav, mp3, flac]) fs.copyFileSync(item.meta.files[path.extname(f).slice(1)], path.join(dir2, path.basename(f)));
  const again = await S.music.addResult(job, "v2", dir2, { ...report, files: { wav: path.join(dir2, "music.wav"), mp3: path.join(dir2, "music.mp3"), flac: path.join(dir2, "music.flac") } });
  assert.equal(again.meta.n, 2, "a second version in the same work group");
  assert.equal(S.music.library({ group: "g1" }).length, 2);
  // Ratings and the reason are kept.
  assert.equal(S.music.rate(item.id, "dislike", "سريعة").meta.rating, "dislike");
  // Save as: the extension decides the format, and the file's real format is checked.
  for (const ext of ["wav", "mp3", "flac"]) {
    const dest = path.join(root, `out.${ext}`);
    const r = await S.music.saveAs(item.id, dest);
    assert.ok(r.bytes > 1000);
  }
  await assert.rejects(S.music.saveAs(item.id, path.join(root, "out.ogg")), (e) => e.messageKey === "err.enum");
  // Added to a project's media (once), nothing else in the project changes.
  const p = S.projects.create({ name: "music" });
  const m1 = await S.music.addToProject(item.id, p.id);
  const m2 = await S.music.addToProject(item.id, p.id);
  assert.equal(m1.id, m2.id);
  assert.equal(S.repos.media.listByProject(p.id, {}).length, 1);
  assert.equal(S.repos.timelines.get(p.mainTimelineId).tracks.flatMap((t) => t.segments).length, 0, "the timeline is untouched");
});

test("Arabic descriptions become suggestions, never silent changes; file titles stay readable", () => {
  const r = interpret("عايز موسيقى هادية فيها تشويق ومن غير طبول");
  assert.deepEqual(r.suggestions, { energy: "calm", preset: "suspense", description: "no percussion" });
  assert.ok(COMPOSE_PRESETS.length === 11);
  assert.equal(fileTitle('ترقّب: "قبل" المفاجأة?'), "ترقّب قبل المفاجأة");
  assert.ok(new MusicService({ repos: S.repos, paths: S.paths, settings: S.settings, media: S.media, setup: S.musicSetup }).status().engine.running === false, "nothing starts by itself");
});

test("a runtime moved to another folder points its venv at the base Python that moved with it", () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-mu-move-"));
  const rt = path.join(ud, "runtime"), venv = path.join(rt, "music");
  const bin = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  fs.mkdirSync(venv, { recursive: true });
  fs.mkdirSync(path.join(rt, "python312"), { recursive: true }); fs.writeFileSync(path.join(rt, "python312", bin[1]), "");
  const old = path.join(os.tmpdir(), `gone-${Date.now()}`, "python312");
  fs.writeFileSync(path.join(venv, "pyvenv.cfg"), `home = ${old}\nversion = 3.12.15\nexecutable = ${path.join(old, bin[1])}\n`);
  relinkVenv(venv);
  const cfg = fs.readFileSync(path.join(venv, "pyvenv.cfg"), "utf8");
  assert.ok(!cfg.includes(old), cfg);
  assert.ok(cfg.split("\n").includes(`home = ${path.join(rt, "python312")}`), cfg);
  assert.ok(cfg.includes(`executable = ${path.join(rt, "python312", bin[1])}`), cfg);
  // A venv whose base Python still exists is left alone.
  const before = cfg;
  relinkVenv(venv);
  assert.equal(fs.readFileSync(path.join(venv, "pyvenv.cfg"), "utf8"), before);
  fs.rmSync(ud, { recursive: true, force: true });
});
