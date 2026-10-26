// The music studio's engine, jobs and library (main process).
// Engine: ComfyUI 0.40.0 from the music runtime, started only when the user asks (the "start engine" button or a
// generation) — opening the app, the tab or the library loads nothing. It runs on a free local port with only the app's
// own node package enabled, its data in the app's data folder, offline; "stop engine" ends the process the app started
// (never another ComfyUI). One heavy GPU job at a time across the app (the shared GpuQueue: music, video) and none
// during a video export; RAM, GPU memory and disk are checked first. Progress: "music:job" events with the real stage, the elapsed time and — only while the model samples —
// the step count. Results: library items (kind audio, category "music") whose meta keeps the work group, the version,
// its parent, the settings, the plan, the seed and the engine; their files live in the app's data folder.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { AppError } from "../core/validation.js";
import { uid, US } from "../core/util.js";
import { binaries, run } from "./ffmpeg.js";
import { musicRuntime, NODE_PACKAGE } from "./musicSetupService.js";
import { MODEL_SETS, plenioZip } from "./music/catalog.js";
import { ComfyEngine, gpuFree } from "./comfyEngine.js";
import { GpuQueue } from "./gpuQueue.js";

export const MUSIC_FORMATS = ["wav", "mp3", "flac"];
export { gpuFree };

/** A file name from a title: the title's own words (Arabic kept), no characters Windows refuses. */
export function fileTitle(s) {
  return String(s || "music").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "music";
}

export class MusicService {
  constructor({ repos, paths, settings, media, setup, exporter = null, gpu = null, notify = () => {}, log = () => {} }) {
    this.repos = repos;
    this.paths = paths;
    this.settings = settings;
    this.media = media;
    this.setup = setup;
    this.exporter = exporter;
    this.notify = notify;
    this.log = log;
    this.dir = path.join(paths.root, "music");
    this.resultsDir = path.join(paths.library, "music");
    this.gpu = gpu || new GpuQueue({ exporter });
    this.engine = new ComfyEngine({ name: "music", dir: this.dir, logs: paths.logs, runtime: () => musicRuntime(paths.root), modelsDir: () => setup.modelsDir(),
      modelFolders: ["diffusion_models", "text_encoders", "vae", "checkpoints", "loras", "audio_encoders"], nodePackages: [{ name: "montaj_music", src: NODE_PACKAGE }],
      readyNode: "MontajMusicCompose", notify: (ev) => { this.notify("music:engine", this.status()); if (ev === "stopped") this.failRunning("err.musicEngineStopped"); } });
    this.gpu.register("music", this.engine);
    this.jobs = new Map();
    this.jobsFile = path.join(this.dir, "jobs.json");
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadJobs();
  }

  // ---------------------------------------------------------------- engine
  status() {
    const job = [...this.jobs.values()].find((j) => ["queued", "waiting", "starting", "running"].includes(j.state)) || null;
    return { engine: this.engine.status(), job: job && this.view(job), runtime: !!musicRuntime(this.paths.root), keepLoaded: !!this.settings.get("music").keepLoaded };
  }

  /** Resources now (shown before and after the engine runs). */
  resources() { return this.engine.resources(); }

  /** Before loading a model: enough RAM, GPU memory and disk, or a clear message (nothing is started). */
  checkResources(pathId = "compose") { return this.engine.checkResources({ ramMB: pathId === "cover" ? 8000 : 4000, vramMB: pathId === "cover" ? 12000 : 5000, diskMB: 2000 }); }

  start() { return this.engine.start(); }

  /** Stop the engine the app started (a job running is cancelled first). Frees its RAM and GPU memory. */
  async stop() {
    const job = [...this.jobs.values()].find((j) => j.state === "running");
    if (job) await this.cancel(job.id);
    return this.engine.stop();
  }

  /** End the engine at once (the app is closing): only the process the app started. */
  killNow() {
    this.engine.stop();
    for (const j of this.jobs.values()) if (["queued", "waiting", "starting", "running"].includes(j.state)) Object.assign(j, { state: "interrupted", stage: "interrupted", endedAt: new Date().toISOString() });
    try { this.saveJobs(); } catch { /* closing */ }
  }

  /** Free the models from memory without stopping the engine. */
  release() { return this.engine.release(); }

  // ---------------------------------------------------------------- jobs
  loadJobs() {
    try {
      for (const j of JSON.parse(fs.readFileSync(this.jobsFile, "utf8"))) {
        // A job that was running when the app closed did not finish: say so (its saved results stay).
        if (["queued", "waiting", "starting", "running"].includes(j.state)) Object.assign(j, { state: "interrupted", stage: "interrupted" });
        this.jobs.set(j.id, j);
      }
    } catch { /* none yet */ }
  }

  saveJobs() {
    const list = [...this.jobs.values()].sort((a, b) => a.created.localeCompare(b.created)).slice(-100);
    fs.writeFileSync(this.jobsFile, JSON.stringify(list));
  }

  view(j) { return { id: j.id, state: j.state, stage: j.stage, message: j.message, created: j.created, startedAt: j.startedAt, endedAt: j.endedAt, step: j.step, steps: j.steps, error: j.error, result: j.result, group: j.group, title: j.title, stages: j.stages || [] }; }

  update(j, patch) {
    // Every stage the job went through, with the second it began (the stage timings in its report).
    if (patch.stage && patch.stage !== j.stage) (j.stages ||= []).push({ stage: patch.stage, s: Math.round((Date.now() - Date.parse(j.created)) / 100) / 10 });
    Object.assign(j, patch);
    this.saveJobs();
    this.notify("music:job", this.view(j));
  }

  jobsList() { return [...this.jobs.values()].map((j) => this.view(j)).reverse(); }

  failRunning(messageKey) {
    for (const j of this.jobs.values()) if (["starting", "running"].includes(j.state)) this.update(j, { state: "failed", error: { messageKey }, endedAt: new Date().toISOString() });
  }

  /**
   * A new generation. req: { path: "compose"|"inspired", preset, vibe, energy, duration, bpm, keyscale, meter, seed, loop,
   * description, style_override, reference: { file, start, seconds }, group (to add a version to a work group), parent,
   * title }; Easy Cover ("cover"): { source (a studio source file), start, duration, preset, variant, tempo, description, seed,
   * preview }. Returns the job at once ("queued"); a second request while one runs is refused (no duplicate jobs).
   */
  submit(req) {
    const busy = [...this.jobs.values()].find((j) => ["queued", "waiting", "starting", "running"].includes(j.state));
    if (busy) throw new AppError("CONFLICT", "err.musicBusy", { job: busy.id });
    if (req.path === "cover" && (!req.source || !fs.existsSync(req.source))) throw new AppError("VALIDATION", "err.musicSource");
    const set = MODEL_SETS.find((s) => s.paths.includes(req.path || "compose"));
    const j = { id: uid(), state: "queued", stage: "queued", message: "", created: new Date().toISOString(), req: { ...req }, group: req.group || uid(), title: String(req.title || "").slice(0, 80), set: set?.id };
    this.jobs.set(j.id, j);
    this.update(j, {});
    this.runJob(j).catch((e) => {
      this.log("music job failed", e?.message);
      if (!["cancelled", "failed"].includes(j.state)) this.update(j, { state: "failed", error: e?.messageKey ? { messageKey: e.messageKey, details: e.details } : { messageKey: "err.musicFailed", details: { message: String(e?.message || e) } }, endedAt: new Date().toISOString() });
    });
    return this.view(j);
  }

  async runJob(j) {
    // One heavy GPU job at a time in the app (music, video) and none during a video export: wait for the turn.
    let release;
    try {
      release = await this.gpu.acquire("music", j.id, { onWait: (why) => { if (j.state !== "cancelled") this.update(j, { state: "waiting", stage: why === "export" ? "waitExport" : "waitQueue" }); } });
    } catch (e) { if (e.cancelled) return; throw e; }
    try { await this.runTurn(j); } finally { release(); }
  }

  async runTurn(j) {
    if (j.state === "cancelled") return;
    const st = await this.setup.status();
    const set = st.sets.find((s) => s.id === j.set);
    if (!st.runtime.installed || (set && !set.installed)) throw new AppError("PROVIDER", "err.musicNotReady", { missing: [!st.runtime.installed && "runtime", set && !set.installed && set.name].filter(Boolean) });
    this.checkResources(j.req.path);
    this.update(j, { state: "starting", stage: "engine", startedAt: new Date().toISOString() });
    await this.start();
    if (j.state === "cancelled") return;
    const version = uid();
    const outDir = path.join(this.resultsDir, j.group, version);
    fs.mkdirSync(outDir, { recursive: true });
    const name = fileTitle(j.title || "music");
    const ref = j.req.reference?.file ? { path: j.req.reference.file, start: Number(j.req.reference.start) || 0, seconds: Number(j.req.reference.seconds) || 20 } : null;
    const clientId = `montaj-${j.id}`;
    const request = { ...j.req, reference: ref, job: j.id, client: clientId, out_dir: outDir, name, ffmpeg: binaries().ffmpeg, keep_loaded: !!this.settings.get("music").keepLoaded,
      // The models' SHA-256 for the result's report: checked by the model manager when they were installed or imported.
      model_sha256: Object.fromEntries((MODEL_SETS.find((s) => s.id === j.set)?.files || []).map((x) => [x.file, x.sha256])),
      plenio: j.req.path === "cover" ? plenioZip(this.setup.modelsDir()) : undefined };
    const node = j.req.path === "cover" ? "MontajMusicCover" : "MontajMusicCompose";
    try {
      await this.engine.runPrompt({ 1: { class_type: node, inputs: { request: JSON.stringify(request) } } }, {
        clientId, failKey: "err.musicFailed",
        onQueued: (promptId) => this.update(j, { promptId, state: "running", stage: "load" }),
        onEvent: (type, d) => {
          if (type === "montaj-music.progress" && d.job === j.id) this.update(j, { state: "running", stage: d.stage, message: d.message, step: null, steps: null });
          else if (type === "progress") this.update(j, { step: d.value, steps: d.max });
        },
      });
    } catch (e) {
      if (e.details?.cancelled) { this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() }); fs.rmSync(outDir, { recursive: true, force: true }); return; }
      throw e;
    }
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "report.json"), "utf8"));
    const item = await this.addResult(j, version, outDir, report);
    this.update(j, { state: "done", stage: "done", endedAt: new Date().toISOString(), result: item.id });
  }

  async cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new AppError("NOT_FOUND", "err.notFound");
    if (["queued", "waiting"].includes(j.state)) { this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() }); this.gpu.cancel(j.id); return this.view(j); }
    if (this.engine.running && j.promptId) await this.engine.interrupt(j.promptId);
    else if (j.state === "starting") this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() });
    return this.view(j);
  }

  /** Is a job running (for the "close the app while generating" question)? */
  busy() { return [...this.jobs.values()].some((j) => ["starting", "running"].includes(j.state)); }

  // ---------------------------------------------------------------- library
  async addResult(j, version, outDir, report) {
    const versions = this.repos.library.list({ kind: "audio" }).filter((x) => x.category === "music" && meta(x).group === j.group);
    const n = versions.length + 1;
    const title = `${j.title || "موسيقى"} · نسخة ${n}`;
    // Readable file names: the title and the version, in the result's own folder.
    const files = {};
    for (const ext of MUSIC_FORMATS) {
      const from = report.files[ext];
      const to = path.join(outDir, `${fileTitle(title)}.${ext}`);
      if (from && fs.existsSync(from)) { if (from !== to) fs.renameSync(from, to); files[ext] = to; }
    }
    let durationUs = Math.round((report.duration || 0) * US);
    try { durationUs = (await this.media.probe(files.wav)).durationUs || durationUs; } catch { /* keep the engine's */ }
    const m = { group: j.group, version, parent: j.req.parent || null, n, path: report.path, engine: report.engine, settings: report.settings, plan: report.composition,
      seed: report.composition?.seed, reference: report.reference, loop: report.loop, loudness: report.loudness, files, report: path.join(outDir, "report.json"),
      generationSeconds: report.generation_seconds, status: report.status, rating: null, reason: "", source: j.req.sourceName || null,
      // Easy Cover: what the checks said (review reasons) and how many sections the song was generated in.
      review: report.review_reasons || null, sections: report.plan?.chunks?.length || null };
    const lid = this.repos.library.add({ kind: "audio", category: "music", name: title, path: files.wav, durationUs, sizeBytes: fs.statSync(files.wav).size, meta: m });
    return this.item(lid);
  }

  library(q = {}) {
    const text = String(q.search || "").trim().toLowerCase();
    return this.repos.library.list({ kind: "audio" }).filter((x) => x.category === "music")
      .map((x) => ({ ...x, meta: meta(x), exists: fs.existsSync(x.path) }))
      .filter((x) => (!q.favorite || x.favorite) && (!q.group || x.meta.group === q.group) && (!q.path || x.meta.path === q.path)
        && (!text || x.name.toLowerCase().includes(text) || String(x.meta.settings?.preset || "").includes(text) || String(x.meta.settings?.description || "").toLowerCase().includes(text)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  item(id) {
    const x = this.repos.library.list({ kind: "audio" }).find((i) => i.id === id && i.category === "music");
    if (!x) throw new AppError("NOT_FOUND", "err.notFound");
    return { ...x, meta: meta(x) };
  }

  rate(id, rating, reason = "") {
    const x = this.item(id);
    const m = { ...x.meta, rating: ["like", "dislike", null].includes(rating) ? rating : null, reason: String(reason || "").slice(0, 300) };
    this.repos.library.update(id, { meta: m });
    return this.item(id);
  }

  /**
   * Save a result as `dest` in the user's folder: the format follows the extension (wav, mp3, flac), converted when it
   * is not one the result already has, then checked with ffprobe (the file's real format matches its extension).
   */
  async saveAs(id, dest) {
    const x = this.item(id);
    const ext = path.extname(dest).slice(1).toLowerCase();
    if (!MUSIC_FORMATS.includes(ext)) throw new AppError("VALIDATION", "err.enum", { field: "format", allowed: MUSIC_FORMATS });
    const src = x.meta.files?.[ext];
    if (src && fs.existsSync(src)) fs.copyFileSync(src, dest);
    else {
      const codec = { wav: ["-c:a", "pcm_s24le"], mp3: ["-c:a", "libmp3lame", "-b:a", "320k"], flac: ["-c:a", "flac"] }[ext];
      await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", x.path, ...codec, dest], { timeoutMs: 10 * 60_000 });
    }
    const probe = await this.media.probe(dest).catch(() => null);
    const want = { wav: /wav/, mp3: /mp3/, flac: /flac/ }[ext];
    if (!probe || !want.test(String(probe.container || probe.format || probe.audioCodec || "").toLowerCase())) {
      const r = spawnSync(binaries().ffprobe, ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", dest], { encoding: "utf8", windowsHide: true });
      if (!want.test(r.stdout || "")) { fs.rmSync(dest, { force: true }); throw new AppError("IO", "err.musicFormat", { file: path.basename(dest) }); }
    }
    return { path: dest, bytes: fs.statSync(dest).size };
  }

  /** Add a result to a project's media (any project; nothing else in it changes). Returns the media item. */
  async addToProject(id, projectId) {
    const x = this.item(id);
    const existing = this.repos.media.listByProject(projectId, {}).find((m) => m.path === x.path);
    if (existing) return existing;
    const { imported, errors } = await this.media.importFiles(projectId, [x.path], { origin: "music" });
    if (!imported.length) throw new AppError("IO", "err.importFailed", { message: errors?.[0]?.message });
    return imported[0];
  }

  // ---------------------------------------------------------------- sources, waveforms, templates
  /** A source sound for "inspired" music: a file (or a project's media file) copied into the studio's sources. */
  async addSource(file, name = null) {
    if (!file || !fs.existsSync(file)) throw new AppError("NOT_FOUND", "err.fileNotFound", { file });
    const dir = path.join(this.dir, "sources");
    fs.mkdirSync(dir, { recursive: true });
    const sid = uid();
    const dest = path.join(dir, `${sid}${path.extname(file).toLowerCase() || ".wav"}`);
    fs.copyFileSync(file, dest);
    let durationUs = 0;
    try { durationUs = (await this.media.probe(dest)).durationUs; } catch { fs.rmSync(dest, { force: true }); throw new AppError("VALIDATION", "err.musicSource"); }
    if (!durationUs) { fs.rmSync(dest, { force: true }); throw new AppError("VALIDATION", "err.musicSource"); }
    const src = { id: sid, name: name || path.basename(file), file: dest, durationS: durationUs / US, peaks: await this.peaksOf(dest) };
    const list = this.sources().filter((x) => x.id !== sid);
    fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify([src, ...list].slice(0, 50)));
    return src;
  }

  sources() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "sources", "sources.json"), "utf8")).filter((x) => fs.existsSync(x.file)); } catch { return []; } }
  sourcePath(sid) { return this.sources().find((x) => x.id === sid)?.file || null; }

  /** 600 loudness peaks of a sound (for the waveform), decoded with FFmpeg. */
  async peaksOf(file, bins = 600) {
    const r = spawnSync(binaries().ffmpeg, ["-hide_banner", "-v", "error", "-i", file, "-ac", "1", "-ar", "4000", "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 30, windowsHide: true });
    if (r.status !== 0 || !r.stdout?.length) return [];
    const a = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
    const step = Math.max(1, Math.floor(a.length / bins)), out = [];
    for (let i = 0; i < a.length; i += step) { let m = 0; for (let k = i; k < Math.min(a.length, i + step); k++) m = Math.max(m, Math.abs(a[k])); out.push(Math.round(m * 1000) / 1000); }
    return out;
  }

  async peaks(id) {
    const x = this.item(id);
    const f = path.join(path.dirname(x.path), "peaks.json");
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* not yet */ }
    const p = await this.peaksOf(x.path);
    try { fs.writeFileSync(f, JSON.stringify(p)); } catch { /* read-only: recompute next time */ }
    return p;
  }

  /** Saved choices ("save as template"): name + settings, in the studio's data folder. */
  templates() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "templates.json"), "utf8")); } catch { return []; } }
  saveTemplate(name, settings) {
    const t = { id: uid(), name: String(name || "").trim().slice(0, 80) || "قالب", settings: settings || {}, created: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, "templates.json"), JSON.stringify([t, ...this.templates()].slice(0, 200)));
    return t;
  }
  removeTemplate(tid) { fs.writeFileSync(path.join(this.dir, "templates.json"), JSON.stringify(this.templates().filter((x) => x.id !== tid))); return true; }

  rename(id, name) { this.repos.library.update(id, { name: String(name || "").trim().slice(0, 120) || "موسيقى" }); return this.item(id); }

  /** Delete a result (its files too); its other versions stay. */
  remove(id) {
    const x = this.item(id);
    const dir = path.dirname(x.path);
    this.repos.library.remove(id);
    if (dir.startsWith(this.resultsDir)) fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

function meta(x) { try { return typeof x.meta === "string" ? JSON.parse(x.meta || "{}") : x.meta || {}; } catch { return {}; } }

export const musicHash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
