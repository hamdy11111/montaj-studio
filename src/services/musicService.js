// The music studio's engine, jobs and library (main process).
// Engine: ComfyUI 0.40.0 from the music runtime, started only when the user asks (the "start engine" button or a
// generation) — opening the app, the tab or the library loads nothing. It runs on a free local port with only the app's
// own node package enabled, its data in the app's data folder, offline; "stop engine" ends the process the app started
// (never another ComfyUI). One job at a time; a job waits while a video export runs; RAM, GPU memory and disk are checked
// first. Progress: "music:job" events with the real stage, the elapsed time and — only while the model samples —
// the step count. Results: library items (kind audio, category "music") whose meta keeps the work group, the version,
// its parent, the settings, the plan, the seed and the engine; their files live in the app's data folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { AppError } from "../core/validation.js";
import { uid, US } from "../core/util.js";
import { binaries, run } from "./ffmpeg.js";
import { musicRuntime, NODE_PACKAGE } from "./musicSetupService.js";
import { MODEL_SETS } from "./music/catalog.js";

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MUSIC_FORMATS = ["wav", "mp3", "flac"];

/** Free GPU memory in MiB (NVIDIA), or null. */
export function gpuFree() {
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=memory.free,memory.total,memory.used", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 8000, encoding: "utf8" });
    if (r.status !== 0) return null;
    const [free, total, used] = r.stdout.split("\n")[0].split(",").map((x) => Number(x.trim()));
    return { free, total, used };
  } catch { return null; }
}

/** A file name from a title: the title's own words (Arabic kept), no characters Windows refuses. */
export function fileTitle(s) {
  return String(s || "music").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "music";
}

export class MusicService {
  constructor({ repos, paths, settings, media, setup, exporter = null, notify = () => {}, log = () => {} }) {
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
    this.engine = null; // { child, port, url, pid, started }
    this.starting = null;
    this.jobs = new Map();
    this.jobsFile = path.join(this.dir, "jobs.json");
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadJobs();
  }

  // ---------------------------------------------------------------- engine
  status() {
    const job = [...this.jobs.values()].find((j) => ["queued", "waiting", "starting", "running"].includes(j.state)) || null;
    return { engine: this.engine ? { running: true, port: this.engine.port, pid: this.engine.pid, workPid: this.engine.workPid, since: this.engine.started } : { running: false, starting: !!this.starting },
      job: job && this.view(job), runtime: !!musicRuntime(this.paths.root), keepLoaded: !!this.settings.get("music").keepLoaded };
  }

  /** Resources now (shown before and after the engine runs). */
  resources() {
    const g = gpuFree();
    let disk = null;
    try { const st = fs.statfsSync(this.dir); disk = Math.round((st.bavail * st.bsize) / 2 ** 20); } catch { /* unknown */ }
    let engineRam = null;
    if (this.engine?.pid) {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${this.engine.workPid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8" });
      const m = /"([\d,.\s]+) K"/.exec(r.stdout || "");
      if (m) engineRam = Math.round(Number(m[1].replace(/[^\d]/g, "")) / 1024);
    }
    return { ramFreeMB: Math.round(os.freemem() / 2 ** 20), ramTotalMB: Math.round(os.totalmem() / 2 ** 20), gpu: g, diskFreeMB: disk, engineRamMB: engineRam };
  }

  /** Before loading a model: enough RAM, GPU memory and disk, or a clear message (nothing is started). */
  checkResources() {
    const r = this.resources();
    if (r.ramFreeMB < 4000) throw new AppError("RESOURCE", "err.musicRam", { free: Math.round(r.ramFreeMB / 1024 * 10) / 10 });
    if (r.gpu && r.gpu.free < 5000) throw new AppError("RESOURCE", "err.musicVram", { free: Math.round(r.gpu.free / 1024 * 10) / 10 });
    if (r.diskFreeMB !== null && r.diskFreeMB < 2000) throw new AppError("RESOURCE", "err.diskLow", { free: Math.round(r.diskFreeMB / 1024 * 10) / 10 });
    return r;
  }

  /** Start the engine (once; a second call while it starts waits for the same start). */
  start() {
    if (this.engine) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    const rt = musicRuntime(this.paths.root);
    if (!rt) throw new AppError("PROVIDER", "err.musicNotReady", { missing: ["runtime"] });
    const models = this.setup.modelsDir();
    // The app's node package, fresh for this version of the app.
    const dest = path.join(rt.comfy, "custom_nodes", "montaj_music");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(NODE_PACKAGE, dest, { recursive: true, filter: (p) => !p.includes("__pycache__") });
    const port = await freePort();
    const dirs = { out: path.join(this.dir, "engine-out"), input: path.join(this.dir, "engine-in"), temp: path.join(this.dir, "engine-temp"), user: path.join(this.dir, "engine-user") };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const args = ["-X", "utf8", path.join(rt.comfy, "main.py"), "--listen", "127.0.0.1", "--port", String(port), "--disable-auto-launch",
      "--base-directory", rt.comfy, "--output-directory", dirs.out, "--input-directory", dirs.input, "--temp-directory", dirs.temp, "--user-directory", dirs.user,
      "--database-url", `sqlite:///${path.join(dirs.user, "comfy.db").replace(/\\/g, "/")}`, "--disable-all-custom-nodes", "--whitelist-custom-nodes", "montaj_music",
      "--extra-model-paths-config", this.modelPathsFile(models)];
    const logFile = path.join(this.paths.logs, "music-engine.log");
    const out = fs.openSync(logFile, "a");
    const child = spawn(rt.python, args, { cwd: rt.comfy, windowsHide: true, stdio: ["ignore", out, out],
      env: { ...process.env, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HOME: path.join(this.dir, "hf") } });
    let exited = null;
    child.on("exit", (code) => { exited = code; if (this.engine?.child === child) { this.engine = null; this.notify("music:engine", this.status()); this.failRunning("err.musicEngineStopped"); } });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 600; i++) { // up to 5 minutes (a cold start loads torch)
      if (exited !== null) throw new AppError("PROVIDER", "err.musicEngineFailed", { code: exited, log: tail(logFile) });
      try { const r = await fetch(`${url}/object_info/MontajMusicCompose`); if (r.ok && Object.keys(await r.json()).length) break; } catch { /* not up yet */ }
      await sleep(500);
      if (i === 599) { child.kill(); throw new AppError("PROVIDER", "err.musicEngineFailed", { log: tail(logFile) }); }
    }
    // The process that holds the models (the venv's python.exe is a launcher that starts it): measured in resources().
    const work = await fetch(`${url}/montaj-music/process`).then((r) => r.json()).catch(() => ({}));
    this.engine = { child, port, url, pid: child.pid, workPid: work.pid || child.pid, started: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, "engine.pid"), String(child.pid));
    this.notify("music:engine", this.status());
    return this.status();
  }

  /** ComfyUI's extra model paths: the music models folder (whatever folder the user chose). */
  modelPathsFile(models) {
    const f = path.join(this.dir, "model-paths.yaml");
    const q = (p) => JSON.stringify(p.replace(/\\/g, "/"));
    fs.writeFileSync(f, `montaj:\n  base_path: ${q(models)}\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  checkpoints: checkpoints\n  loras: loras\n  audio_encoders: audio_encoders\n`);
    return f;
  }

  /** Stop the engine the app started (a job running is cancelled first). Frees its RAM and GPU memory. */
  async stop() {
    const e = this.engine;
    if (!e) return this.status();
    const job = [...this.jobs.values()].find((j) => j.state === "running");
    if (job) await this.cancel(job.id);
    this.engine = null;
    try { spawnSync("taskkill", ["/PID", String(e.pid), "/T", "/F"], { windowsHide: true }); } catch { e.child.kill(); }
    fs.rmSync(path.join(this.dir, "engine.pid"), { force: true });
    this.notify("music:engine", this.status());
    return this.status();
  }

  /** End the engine at once (the app is closing): only the process the app started. */
  killNow() {
    const e = this.engine;
    this.engine = null;
    if (e) { try { spawnSync("taskkill", ["/PID", String(e.pid), "/T", "/F"], { windowsHide: true }); } catch { e.child.kill(); } }
    for (const j of this.jobs.values()) if (["queued", "waiting", "starting", "running"].includes(j.state)) Object.assign(j, { state: "interrupted", stage: "interrupted", endedAt: new Date().toISOString() });
    try { this.saveJobs(); } catch { /* closing */ }
  }

  /** Free the models from memory without stopping the engine. */
  async release() {
    if (!this.engine) return false;
    await fetch(`${this.engine.url}/free`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
    return true;
  }

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
   * title }. Returns the job at once ("queued"); a second request while one runs is refused (no duplicate jobs).
   */
  submit(req) {
    const busy = [...this.jobs.values()].find((j) => ["queued", "waiting", "starting", "running"].includes(j.state));
    if (busy) throw new AppError("CONFLICT", "err.musicBusy", { job: busy.id });
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
    // A video export uses the GPU: wait for it (the user sees "waiting" and can cancel).
    while (this.exporter?.busy?.()) {
      if (j.state === "cancelled") return;
      if (j.state !== "waiting") this.update(j, { state: "waiting", stage: "waitExport" });
      await sleep(2000);
    }
    if (j.state === "cancelled") return;
    const st = await this.setup.status();
    const set = st.sets.find((s) => s.id === j.set);
    if (!st.runtime.installed || (set && !set.installed)) throw new AppError("PROVIDER", "err.musicNotReady", { missing: [!st.runtime.installed && "runtime", set && !set.installed && set.name].filter(Boolean) });
    this.checkResources();
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
      model_sha256: Object.fromEntries((MODEL_SETS.find((s) => s.id === j.set)?.files || []).map((x) => [x.file, x.sha256])) };
    const ws = new WebSocket(`ws://127.0.0.1:${this.engine.port}/ws?clientId=${encodeURIComponent(clientId)}`);
    const finished = new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
        const d = m.data || {};
        if (d.prompt_id && j.promptId && d.prompt_id !== j.promptId) return;
        if (m.type === "montaj-music.progress" && d.job === j.id) this.update(j, { state: "running", stage: d.stage, message: d.message, step: null, steps: null });
        else if (m.type === "progress") this.update(j, { step: d.value, steps: d.max });
        else if (m.type === "execution_error") reject(new AppError("PROVIDER", "err.musicFailed", { message: String(d.exception_message || "").slice(0, 800) }));
        else if (m.type === "execution_interrupted") reject(new AppError("CONFLICT", "err.cancelled", { cancelled: true }));
        else if (m.type === "execution_success" || (m.type === "executing" && d.node === null && j.promptId)) resolve();
      };
      ws.onerror = () => reject(new AppError("PROVIDER", "err.musicEngineStopped"));
    });
    await new Promise((r) => { ws.onopen = r; setTimeout(r, 3000); });
    const res = await fetch(`${this.engine.url}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, prompt: { 1: { class_type: "MontajMusicCompose", inputs: { request: JSON.stringify(request) } } } }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.prompt_id) { ws.close(); throw new AppError("PROVIDER", "err.musicFailed", { message: JSON.stringify(body.error || body.node_errors || body).slice(0, 800) }); }
    this.update(j, { promptId: body.prompt_id, state: "running", stage: "load" });
    try { await finished; } catch (e) {
      ws.close();
      if (e.details?.cancelled) { this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() }); fs.rmSync(outDir, { recursive: true, force: true }); return; }
      throw e;
    }
    ws.close();
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "report.json"), "utf8"));
    const item = await this.addResult(j, version, outDir, report);
    this.update(j, { state: "done", stage: "done", endedAt: new Date().toISOString(), result: item.id });
  }

  async cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new AppError("NOT_FOUND", "err.notFound");
    if (["queued", "waiting"].includes(j.state)) { this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() }); return this.view(j); }
    if (this.engine && j.promptId) {
      await fetch(`${this.engine.url}/interrupt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: j.promptId }) }).catch(() => {});
      await fetch(`${this.engine.url}/queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [j.promptId] }) }).catch(() => {});
    } else if (j.state === "starting") this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() });
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
      generationSeconds: report.generation_seconds, status: report.status, rating: null, reason: "", source: j.req.sourceName || null };
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
function tail(file) { try { const s = fs.readFileSync(file, "utf8"); return s.slice(-2000); } catch { return ""; } }
export const musicHash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
