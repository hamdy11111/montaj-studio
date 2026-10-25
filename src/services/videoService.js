// «توليد الفيديو» — the video studio's engine, jobs and library (main process).
// Engine: ComfyUI from the video runtime (its own environment: torch CUDA 13.0), started only when the user asks (the
// start button, a generation or an enhancement); opening the app, the tab or the results loads nothing. Only the app's
// node package is enabled; "stop engine" ends the process the app started. One heavy GPU job at a time across the app
// (the shared GpuQueue: music, video) and none during a video export; RAM, GPU memory and disk are checked first.
// A generation: the chosen part of a source video (cut by the app to exact frames at 24 fps — never cut short in
// silence: the request says how many frames it makes) + 1–3 reference images → MiniMax H3 replaces the person, keeping
// the scene, the motion and (optionally) the sound. An enhancement: a result through SeedVR2, as a new version.
// Progress: "video:job" events with the real stage, the elapsed time and — while the model samples — the step count.
// Results: library items (kind video, category "aivideo") with their settings, seed, engine, source and references.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AppError } from "../core/validation.js";
import { uid, US } from "../core/util.js";
import { timelineDuration } from "../core/model.js";
import { binaries, run } from "./ffmpeg.js";
import { ComfyEngine } from "./comfyEngine.js";
import { GpuQueue } from "./gpuQueue.js";
import { videoRuntime, VIDEO_NODE_PACKAGE } from "./videoSetupService.js";
import { MODEL_SETS } from "./video/catalog.js";
import { SCENES, STYLES, PRIORITIES, composeDescription } from "./video/presets.js";
import {
  FPS, MAX_FRAMES, MIN_FRAMES, FRAME_OPTIONS, QUALITY_OPTIONS, STEP_OPTIONS, TURBO_STEPS, MAX_REFS, GENERATE_DEFAULTS, ENHANCE_DEFAULTS,
  generateSettings, enhanceSettings, extractPromptTemplate, resolveFrames, outputDimensions, enhanceDimensions, buildGenerateGraph, buildEnhanceGraph, GENERATE_STAGES, ENHANCE_STAGES, GENERATE_ORDER, ENHANCE_ORDER, snapFrames,
} from "./video/graphs.js";

const ACTIVE = ["queued", "waiting", "starting", "running"];
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const meta = (x) => (typeof x.meta === "string" ? JSON.parse(x.meta || "{}") : x.meta || {});

/** A file name from a title: the title's own words (Arabic kept), no characters Windows refuses. */
export const fileTitle = (s) => String(s || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video";

export class VideoService {
  constructor({ repos, paths, settings, media, timelines = null, setup, exporter = null, gpu = null, notify = () => {}, log = () => {} }) {
    Object.assign(this, { repos, paths, settings, media, timelines, setup, exporter, notify, log });
    this.dir = path.join(paths.root, "video");
    this.resultsDir = path.join(paths.library, "aivideo");
    this.sourcesDir = path.join(this.dir, "sources");
    fs.mkdirSync(this.sourcesDir, { recursive: true });
    this.gpu = gpu || new GpuQueue({ exporter });
    this.engine = new ComfyEngine({ name: "video", dir: this.dir, logs: paths.logs, runtime: () => videoRuntime(paths.root), modelsDir: () => setup.modelsDir(),
      modelFolders: ["diffusion_models", "text_encoders", "vae", "checkpoints", "loras"], nodePackages: [{ name: "montaj_video", src: VIDEO_NODE_PACKAGE }],
      readyNode: "MontajFreeModels",
      // Its own caches in the app's data folder (compiled GPU kernels kept between runs).
      env: { PYTHONNOUSERSITE: "1", CUDA_CACHE_PATH: path.join(this.dir, "cache", "cuda"), CUDA_CACHE_MAXSIZE: String(4 * 2 ** 30), TORCH_HOME: path.join(this.dir, "cache", "torch"),
        TORCH_EXTENSIONS_DIR: path.join(this.dir, "cache", "torch_extensions") },
      notify: (ev) => { this.notify("video:engine", this.status()); if (ev === "stopped") this.failRunning("err.videoEngineStopped"); } });
    this.gpu.register("video", this.engine);
    this.jobs = new Map();
    this.jobsFile = path.join(this.dir, "jobs.json");
    this.loadJobs();
  }

  // ---------------------------------------------------------------- engine
  status() {
    const job = [...this.jobs.values()].find((j) => ACTIVE.includes(j.state)) || null;
    return { engine: this.engine.status(), job: job && this.view(job), runtime: !!videoRuntime(this.paths.root) };
  }
  resources() { return this.engine.resources(); }
  start() { return this.engine.start(); }
  release() { return this.engine.release(); }
  async stop() {
    const job = [...this.jobs.values()].find((j) => j.state === "running");
    if (job) await this.cancel(job.id);
    return this.engine.stop();
  }
  /** End the engine at once (the app is closing): only the process the app started; running jobs are marked interrupted. */
  killNow() {
    this.engine.stop();
    for (const j of this.jobs.values()) if (ACTIVE.includes(j.state)) Object.assign(j, { state: "interrupted", stage: "interrupted", endedAt: new Date().toISOString() });
    try { this.saveJobs(); } catch { /* closing */ }
  }
  /** Is a job running (for the "close the app while generating" question)? */
  busy() { return [...this.jobs.values()].some((j) => ["starting", "running"].includes(j.state)); }

  /** Everything the page offers, with the limits it must respect (nothing loads a model). */
  choices() {
    return {
      scenes: SCENES.map(({ id, ar, help }) => ({ id, ar, help })), styles: STYLES.map(({ id, ar, help }) => ({ id, ar, help })),
      priorities: PRIORITIES.map(({ id, ar, help }) => ({ id, ar, help })),
      fps: FPS, minFrames: MIN_FRAMES, maxFrames: MAX_FRAMES, frameOptions: FRAME_OPTIONS, quality: QUALITY_OPTIONS, steps: STEP_OPTIONS, turboSteps: TURBO_STEPS, maxRefs: MAX_REFS,
      generate: { ...GENERATE_DEFAULTS, ...this.defaults().generate }, enhance: { ...ENHANCE_DEFAULTS, ...this.defaults().enhance }, template: this.templateInfo(),
      enhanceOptions: { shortEdge: [1080, 1440, 2160], chunkFrames: [0, 9, 17, 33], tileSize: [512, 768, 1024], crf: [16, 18, 20], color: ["lab", "wavelet", "adain", "none"] },
    };
  }
  describe(selection) { return composeDescription(selection); }

  // The user's own prompt template (from a workflow of theirs): kept in the app's data folder for this user only.
  get templateFile() { return path.join(this.dir, "prompt-template.json"); }
  template() { try { return JSON.parse(fs.readFileSync(this.templateFile, "utf8")); } catch { return null; } }
  templateInfo() { const t = this.template(); return t ? { from: t.from, importedAt: t.importedAt, chars: t.text.length, steps: t.steps.length, text: t.text } : null; }
  importTemplate(file) {
    if (!file || !fs.existsSync(file)) throw new AppError("NOT_FOUND", "err.fileNotFound", { file });
    let json;
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new AppError("VALIDATION", "err.videoTemplateFormat"); }
    const t = extractPromptTemplate(json);
    fs.writeFileSync(this.templateFile, JSON.stringify({ ...t, from: path.basename(file), importedAt: new Date().toISOString() }, null, 1));
    return this.templateInfo();
  }
  removeTemplate() { fs.rmSync(this.templateFile, { force: true }); return null; }

  /** The user's start-up settings ("save as my defaults"); the texts are never kept. */
  defaults() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "defaults.json"), "utf8")); } catch { return {}; } }
  saveDefaults({ generate = null, enhance = null } = {}) {
    const cur = this.defaults();
    if (generate) cur.generate = { ...generateSettings(generate), characterNotes: "", instructions: "" };
    if (enhance) cur.enhance = enhanceSettings(enhance);
    fs.writeFileSync(path.join(this.dir, "defaults.json"), JSON.stringify(cur, null, 1));
    return this.choices();
  }

  // ---------------------------------------------------------------- sources
  /** A source (video or reference image) copied into the studio: its own copy, so a result can always be compared. */
  async addSource(file, name = null) {
    if (!file || !fs.existsSync(file)) throw new AppError("NOT_FOUND", "err.fileNotFound", { file });
    const ext = path.extname(file).toLowerCase();
    const kind = VIDEO_EXT.has(ext) ? "video" : IMAGE_EXT.has(ext) ? "image" : null;
    if (!kind) throw new AppError("VALIDATION", "err.videoSourceType");
    const size = fs.statSync(file).size;
    if (kind === "image" && size > 20 * 2 ** 20) throw new AppError("VALIDATION", "err.videoImageBig");
    const info = await this.media.probe(file);
    if (kind === "video" && (!info.hasVideo || !(info.durationUs > 0))) throw new AppError("VALIDATION", "err.videoSourceBad");
    if (kind === "image" && (Math.min(info.width, info.height) < 64 || info.width * info.height > 70e6)) throw new AppError("VALIDATION", "err.videoImageSize");
    const sid = uid();
    const dest = path.join(this.sourcesDir, `${sid}${ext}`);
    fs.copyFileSync(file, dest);
    const thumb = path.join(this.sourcesDir, `${sid}.jpg`);
    await this.thumbnail(dest, thumb, kind === "video" ? Math.min(1, info.durationUs / US / 2) : 0).catch(() => {});
    const src = { id: sid, kind, name: name || path.basename(file), file: dest, thumb: fs.existsSync(thumb) ? thumb : null, durationUs: info.durationUs || 0,
      width: info.width, height: info.height, hasAudio: !!info.hasAudio, added: new Date().toISOString() };
    const list = this.sources().filter((x) => x.id !== sid);
    fs.writeFileSync(path.join(this.sourcesDir, "sources.json"), JSON.stringify([src, ...list].slice(0, 80)));
    return src;
  }
  /** A project's media file as a source. */
  addMediaSource(mediaId) {
    const m = this.repos.media.get(mediaId);
    return this.addSource(m.path, m.name);
  }
  /** The selected part of a timeline (picture and sound), rendered to a file, as a source. */
  async addRangeSource(timelineId, startUs, endUs) {
    if (!(endUs > startUs)) throw new AppError("VALIDATION", "err.videoSegmentShort");
    if ((endUs - startUs) / US > 60) throw new AppError("VALIDATION", "err.videoRangeLong");
    const tmp = path.join(this.dir, `range-${uid()}.mp4`);
    await this.exporter.renderRange(timelineId, { startUs, endUs }, tmp);
    try { return await this.addSource(tmp, `${(startUs / US).toFixed(1)}–${(endUs / US).toFixed(1)} ث`); } finally { fs.rmSync(tmp, { force: true }); }
  }
  sources() { try { return JSON.parse(fs.readFileSync(path.join(this.sourcesDir, "sources.json"), "utf8")).filter((x) => fs.existsSync(x.file)); } catch { return []; } }
  source(sid) { const s = this.sources().find((x) => x.id === sid); if (!s) throw new AppError("NOT_FOUND", "err.notFound"); return s; }
  sourcePath(sid) { return this.sources().find((x) => x.id === sid)?.file || null; }
  sourceThumb(sid) { return this.sources().find((x) => x.id === sid)?.thumb || null; }

  thumbnail(file, out, atSeconds = 0) {
    return run(binaries().ffmpeg, ["-hide_banner", "-v", "error", "-y", "-ss", String(atSeconds), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", out], { timeoutMs: 60_000 });
  }

  /**
   * What a generation would make, before anything is sent: frames and seconds (and how much of the chosen part is
   * left out by the model's 15-second limit), the output size, whether the sound is used. Refuses what cannot run.
   */
  plan(req) {
    const s = generateSettings(req.settings || {});
    const src = this.source(req.source);
    if (src.kind !== "video") throw new AppError("VALIDATION", "err.videoSourceType");
    const refs = (req.refs || []).map((r) => this.source(r));
    if (!refs.length || refs.length > MAX_REFS || refs.some((r) => r.kind !== "image") || new Set(req.refs).size !== refs.length) throw new AppError("VALIDATION", "err.videoRefs");
    if (s.sound && !src.hasAudio) throw new AppError("VALIDATION", "err.videoNoSound");
    if (s.promptStyle === "original" && !this.template()) throw new AppError("VALIDATION", "err.videoNoTemplate");
    const duration = src.durationUs / US;
    const end = s.durationMode === "range" && Number.isFinite(req.end) ? req.end : null;
    const { frames, leftOut } = resolveFrames(s, duration, end);
    const [width, height] = outputDimensions(src.width, src.height, s.megapixels);
    return { frames, seconds: Math.round(frames / FPS * 100) / 100, leftOut: Math.round(leftOut * 100) / 100, start: s.start, width, height, sound: s.sound && src.hasAudio, steps: s.turbo ? s.turboSteps : s.steps, settings: s };
  }

  // ---------------------------------------------------------------- jobs
  loadJobs() {
    try {
      for (const j of JSON.parse(fs.readFileSync(this.jobsFile, "utf8"))) {
        // A job that was running when the app closed did not finish: say so (never re-run it by itself).
        if (ACTIVE.includes(j.state)) Object.assign(j, { state: "interrupted", stage: "interrupted" });
        this.jobs.set(j.id, j);
      }
    } catch { /* first run */ }
  }
  saveJobs() { fs.writeFileSync(this.jobsFile, JSON.stringify([...this.jobs.values()].slice(-60))); }
  view(j) {
    return { id: j.id, kind: j.kind, state: j.state, stage: j.stage, created: j.created, startedAt: j.startedAt, endedAt: j.endedAt, step: j.step, steps: j.steps,
      error: j.error, result: j.result, group: j.group, title: j.title, plan: j.plan || null, stages: j.stages || [] };
  }
  update(j, patch) {
    if (patch.stage && patch.stage !== j.stage) (j.stages ||= []).push({ stage: patch.stage, s: Math.round((Date.now() - Date.parse(j.created)) / 100) / 10 });
    Object.assign(j, patch);
    this.saveJobs();
    this.notify("video:job", this.view(j));
  }
  jobsList() { return [...this.jobs.values()].map((j) => this.view(j)).reverse(); }
  failRunning(messageKey) {
    for (const j of this.jobs.values()) if (["starting", "running"].includes(j.state)) this.update(j, { state: "failed", error: { messageKey }, endedAt: new Date().toISOString() });
  }

  /**
   * A new job, received at once ("queued"). req: { kind: "generate", source, refs: [ids], end?, settings, title, group?,
   * parent? } or { kind: "enhance", item: <result id>, settings }. A second request while one runs is refused.
   */
  submit(req) {
    const busy = [...this.jobs.values()].find((j) => ACTIVE.includes(j.state));
    if (busy) throw new AppError("CONFLICT", "err.videoBusy", { job: busy.id });
    const kind = req.kind === "enhance" ? "enhance" : "generate";
    let plan = null, group = req.group || uid(), title = String(req.title || "").slice(0, 80);
    if (kind === "generate") plan = this.plan(req);
    else {
      const it = this.item(req.item);
      enhanceSettings(req.settings || {});
      group = it.meta.group; title = it.meta.title || it.name;
    }
    const j = { id: uid(), kind, state: "queued", stage: "queued", created: new Date().toISOString(), req: { ...req }, plan, group, title };
    this.jobs.set(j.id, j);
    this.update(j, {});
    this.runJob(j).catch((e) => {
      this.log("video job failed", e?.message);
      if (!["cancelled", "failed"].includes(j.state)) this.update(j, { state: "failed", error: e?.messageKey ? { messageKey: e.messageKey, details: e.details } : { messageKey: "err.videoFailed", details: { message: String(e?.message || e) } }, endedAt: new Date().toISOString() });
    });
    return this.view(j);
  }

  async runJob(j) {
    let release;
    try {
      release = await this.gpu.acquire("video", j.id, { onWait: (why) => { if (j.state !== "cancelled") this.update(j, { state: "waiting", stage: why === "export" ? "waitExport" : "waitQueue" }); } });
    } catch (e) { if (e.cancelled) return; throw e; }
    try { await (j.kind === "enhance" ? this.runEnhance(j) : this.runGenerate(j)); } finally {
      for (const f of j.inputs || []) fs.rmSync(f, { force: true });
      // The models go back unless the user keeps them loaded (the engine stays up for the next job) — before the next
      // job's turn, so it starts with the GPU's memory free.
      if (!this.settings.get("video")?.keepLoaded) await this.engine.release().catch(() => {});
      release();
    }
  }

  /** The runtime and the sets this job needs, installed, with their licences accepted. */
  async ready(sets) {
    const st = await this.setup.status();
    const missing = [];
    if (!st.runtime.installed) missing.push("runtime");
    for (const id of sets) {
      const s = st.sets.find((x) => x.id === id);
      if (!s?.installed) missing.push(s?.name || id);
      else if (!s.accepted) throw new AppError("CONFLICT", "err.licenseNotAccepted", { set: s.name });
    }
    if (missing.length) throw new AppError("PROVIDER", "err.videoNotReady", { missing });
  }

  inputDir() { return path.join(this.dir, "engine-in"); }

  async runGenerate(j) {
    if (j.state === "cancelled") return;
    const s = j.plan.settings;
    await this.ready(["h3", "sam31", ...(s.turbo ? ["h3turbo"] : [])]);
    this.engine.checkResources({ ramMB: 16000, vramMB: 18000, diskMB: 5000 });
    this.update(j, { state: "starting", stage: "cut", startedAt: new Date().toISOString() });
    const src = this.source(j.req.source), refs = j.req.refs.map((r) => this.source(r));
    // The chosen part, exactly: `frames` frames at 24 fps from `start` (picture re-encoded near-lossless, the sound kept).
    fs.mkdirSync(this.inputDir(), { recursive: true });
    const cutName = `job-${j.id}-source.mp4`, cut = path.join(this.inputDir(), cutName);
    j.inputs = [cut];
    await run(binaries().ffmpeg, ["-hide_banner", "-v", "error", "-y", "-ss", String(j.plan.start), "-i", src.file, "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `fps=${FPS}`, "-frames:v", String(j.plan.frames), "-t", String(j.plan.frames / FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", cut], { timeoutMs: 10 * 60_000 });
    const cutInfo = await this.media.probe(cut);
    const got = countFrames(cut);
    const frames = got && got < j.plan.frames ? snapFrames(got) : j.plan.frames; // a source shorter than its header said: fewer frames, and the plan says so
    if (frames !== j.plan.frames) this.update(j, { plan: { ...j.plan, frames, seconds: frames / FPS } });
    const images = refs.map((r, i) => {
      const name = `job-${j.id}-ref${i}${path.extname(r.file).toLowerCase()}`;
      fs.copyFileSync(r.file, path.join(this.inputDir(), name));
      j.inputs.push(path.join(this.inputDir(), name));
      return name;
    });
    const prefix = `montaj/${j.id}`;
    const built = buildGenerateGraph({ video: cutName, images, frames, width: cutInfo.width, height: cutInfo.height, hasAudio: !!cutInfo.hasAudio, settings: s, prefix,
      template: s.promptStyle === "original" ? this.template() : null });
    this.update(j, { stage: "engine" });
    await this.engine.start();
    if (j.state === "cancelled") return;
    const t0 = Date.now();
    await this.execute(j, built.graph, GENERATE_STAGES, GENERATE_ORDER, "25");
    if (j.state === "cancelled") return;
    const out = this.engineOutput(j.id);
    const item = await this.addResult(j, out, {
      kind: "generate", engine: "MiniMax H3", settings: s, seed: s.seed, frames, seconds: frames / FPS, width: built.width, height: built.height, sound: built.sound,
      steps: built.steps, prompt: built.prompt, generationSeconds: Math.round((Date.now() - t0) / 1000),
      source: { id: src.id, name: src.name, start: j.plan.start, frames, cut }, refs: refs.map((r) => ({ id: r.id, name: r.name, file: r.file })),
    });
    this.update(j, { state: "done", stage: "done", endedAt: new Date().toISOString(), result: item.id });
  }

  async runEnhance(j) {
    if (j.state === "cancelled") return;
    const s = enhanceSettings(j.req.settings || {});
    const it = this.item(j.req.item);
    await this.ready(["seedvr2"]);
    const info = await this.media.probe(it.path);
    if (info.durationUs / US > 60) throw new AppError("VALIDATION", "err.videoEnhanceLong");
    enhanceDimensions(info.width, info.height, s.shortEdge);
    this.engine.checkResources({ ramMB: 8000, vramMB: 10000, diskMB: 3000 });
    this.update(j, { state: "starting", stage: "engine", startedAt: new Date().toISOString() });
    fs.mkdirSync(this.inputDir(), { recursive: true });
    const name = `job-${j.id}-enhance.mp4`;
    fs.copyFileSync(it.path, path.join(this.inputDir(), name));
    j.inputs = [path.join(this.inputDir(), name)];
    const built = buildEnhanceGraph({ video: name, width: info.width, height: info.height, hasAudio: !!info.hasAudio, settings: s, prefix: `montaj/${j.id}` });
    await this.engine.start();
    if (j.state === "cancelled") return;
    const t0 = Date.now();
    await this.execute(j, built.graph, ENHANCE_STAGES, ENHANCE_ORDER, "10");
    if (j.state === "cancelled") return;
    const out = this.engineOutput(j.id);
    const m = it.meta;
    const item = await this.addResult({ ...j, req: { ...j.req, parent: it.id } }, out, {
      kind: "enhance", engine: "SeedVR2 3B", settings: s, seed: s.seed, frames: m.frames, seconds: m.seconds, width: built.width, height: built.height, sound: s.sound && !!info.hasAudio,
      generationSeconds: Math.round((Date.now() - t0) / 1000), source: m.source, refs: m.refs, prompt: m.prompt, enhancedFrom: it.id,
    });
    this.update(j, { state: "done", stage: "done", endedAt: new Date().toISOString(), result: item.id });
  }

  /** Run a graph; the stage follows the node that runs (forward only), the step count only while the sampler node runs. */
  async execute(j, graph, stages, order, samplerNode) {
    const ahead = (s) => order.indexOf(s) > order.indexOf(j.stage);
    try {
      await this.engine.runPrompt(graph, {
        clientId: `montaj-video-${j.id}`, failKey: "err.videoFailed",
        onQueued: (promptId) => this.update(j, { promptId, state: "running", ...(ahead("load") ? { stage: "load" } : {}) }),
        onEvent: (type, d) => {
          if (type === "executing" && d.node && stages[d.node] && ahead(stages[d.node])) this.update(j, { stage: stages[d.node], step: null, steps: null });
          else if (type === "progress" && String(d.node) === samplerNode) this.update(j, { step: d.value, steps: d.max });
        },
      });
    } catch (e) {
      if (e.details?.cancelled) { this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() }); return; }
      throw e;
    }
  }

  /** The video the engine saved for this job. */
  engineOutput(jobId) {
    const dir = path.join(this.dir, "engine-out", "montaj");
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith(jobId) && /\.(mp4|webm|mov)$/i.test(x)).sort().pop() : null;
    if (!f) throw new AppError("PROVIDER", "err.videoFailed", { message: "no output" });
    return path.join(dir, f);
  }

  async cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new AppError("NOT_FOUND", "err.notFound");
    if (["queued", "waiting"].includes(j.state)) { this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() }); this.gpu.cancel(j.id); return this.view(j); }
    if (this.engine.running && j.promptId) await this.engine.interrupt(j.promptId);
    else if (j.state === "starting") this.update(j, { state: "cancelled", stage: "cancelled", endedAt: new Date().toISOString() });
    return this.view(j);
  }

  // ---------------------------------------------------------------- library «الفيديوهات المولّدة»
  async addResult(j, file, m) {
    const versions = this.library({ group: j.group });
    const n = versions.length + 1;
    const title = j.title || "فيديو";
    const version = uid();
    const dir = path.join(this.resultsDir, j.group, version);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${title} · نسخة ${n}${m.kind === "enhance" ? " (محسّنة)" : ""}`;
    const dest = path.join(dir, `${fileTitle(name)}.mp4`);
    fs.renameSync(file, dest);
    // The inputs, kept with the result: the cut source (to compare) and the references.
    const keep = path.join(dir, "inputs");
    fs.mkdirSync(keep, { recursive: true });
    let sourceCopy = null;
    if (m.kind === "generate" && m.source?.cut && fs.existsSync(m.source.cut)) { sourceCopy = path.join(keep, "source.mp4"); fs.copyFileSync(m.source.cut, sourceCopy); }
    else if (m.source?.copy) sourceCopy = m.source.copy;
    const refs = (m.refs || []).map((r, i) => {
      if (r.copy) return r;
      const to = path.join(keep, `ref${i + 1}${path.extname(r.file).toLowerCase()}`);
      try { fs.copyFileSync(r.file, to); } catch { /* the source list was cleared */ }
      return { id: r.id, name: r.name, copy: to };
    });
    const info = await this.media.probe(dest);
    const thumb = path.join(dir, "thumb.jpg");
    await this.thumbnail(dest, thumb, Math.min(1, info.durationUs / US / 2)).catch(() => {});
    const record = { ...m, source: m.source ? { id: m.source.id, name: m.source.name, start: m.source.start, frames: m.source.frames, copy: sourceCopy } : null, refs,
      group: j.group, version, parent: j.req.parent || null, n, title, thumb: fs.existsSync(thumb) ? thumb : null, rating: null, reason: "", created: new Date().toISOString(), stages: j.stages || [] };
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ schema: "montaj-video.result/1", ...record, file: dest,
      models: MODEL_SETS.filter((s) => (m.kind === "enhance" ? ["seedvr2"] : ["h3", "sam31", ...(m.settings?.turbo ? ["h3turbo"] : [])]).includes(s.id)).flatMap((s) => s.files.map((f) => ({ file: f.file, sha256: f.sha256, license: s.license }))) }, null, 1));
    const lid = this.repos.library.add({ kind: "video", category: "aivideo", name, path: dest, durationUs: info.durationUs || 0, sizeBytes: fs.statSync(dest).size, meta: record });
    return this.item(lid);
  }

  library(q = {}) {
    const text = String(q.search || "").trim().toLowerCase();
    return this.repos.library.list({ kind: "video" }).filter((x) => x.category === "aivideo")
      .map((x) => ({ ...x, meta: meta(x), exists: fs.existsSync(x.path) }))
      .filter((x) => (!q.favorite || x.favorite) && (!q.group || x.meta.group === q.group) && (!q.kind || x.meta.kind === q.kind)
        && (!text || x.name.toLowerCase().includes(text) || String(x.meta.source?.name || "").toLowerCase().includes(text) || String(x.meta.settings?.instructions || "").toLowerCase().includes(text)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  item(id) {
    const x = this.repos.library.list({ kind: "video" }).find((i) => i.id === id && i.category === "aivideo");
    if (!x) throw new AppError("NOT_FOUND", "err.notFound");
    return { ...x, meta: meta(x) };
  }
  thumbPath(id) { try { return this.item(id).meta.thumb; } catch { return null; } }
  /** A file kept with a result, for the comparison player: "source" or "ref1".."ref3". */
  inputPath(id, which) {
    const m = this.item(id).meta;
    if (which === "source") return m.source?.copy || null;
    const i = Number(String(which).replace("ref", "")) - 1;
    return m.refs?.[i]?.copy || null;
  }

  rate(id, rating, reason = "") {
    const x = this.item(id);
    this.repos.library.update(id, { meta: { ...x.meta, rating: ["like", "dislike", null].includes(rating) ? rating : null, reason: String(reason || "").slice(0, 300) } });
    return this.item(id);
  }
  rename(id, name) { this.item(id); this.repos.library.update(id, { name: String(name || "").trim().slice(0, 120) || "فيديو" }); return this.item(id); }
  favorite(id, on) { this.item(id); this.repos.library.update(id, { favorite: !!on }); return this.item(id); }

  /** Delete a result (its folder with its inputs); projects that already use the file keep their own media record. */
  remove(id) {
    const x = this.item(id);
    const inUse = this.repos.media.usesPath(x.path);
    this.repos.library.remove(id);
    if (!inUse) fs.rmSync(path.dirname(x.path), { recursive: true, force: true });
    return { removed: true, keptFile: !!inUse };
  }

  /** "Save as": a copy where the user chose (MP4), checked to be a real video. */
  async saveAs(id, dest) {
    const x = this.item(id);
    if (!/\.mp4$/i.test(dest)) dest += ".mp4";
    fs.copyFileSync(x.path, dest);
    const r = spawnSync(binaries().ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", dest], { encoding: "utf8", windowsHide: true });
    if (!String(r.stdout).trim()) { fs.rmSync(dest, { force: true }); throw new AppError("IO", "err.videoFormat"); }
    return { path: dest, codec: String(r.stdout).trim() };
  }

  /** Into a project's media (the same file, once). */
  async addToProject(id, projectId) {
    const x = this.item(id);
    const existing = this.repos.media.listByProject(projectId, {}).find((m) => m.path === x.path);
    if (existing) return existing;
    const { imported, errors } = await this.media.importFiles(projectId, [x.path], { origin: "aivideo" });
    if (!imported.length) throw new AppError("IO", "err.importFailed", { message: errors?.[0]?.message });
    return imported[0];
  }

  /**
   * Onto a project's main timeline, on a track of its own (nothing is replaced): at `atUs` (the editor's playhead or
   * the selected range's start) or after the last clip. One undo removes it.
   */
  async addToTimeline(id, projectId, atUs = null) {
    const m = await this.addToProject(id, projectId);
    const p = this.repos.projects.get(projectId);
    const tl = this.timelines.get(p.mainTimelineId).timeline;
    const end = timelineDuration(tl);
    const r = await this.timelines.exec(p.mainTimelineId, "addMedia", { mediaId: m.id, toMain: false, atUs: atUs ?? end });
    return { mediaId: m.id, segmentId: r?.result ?? null, atUs: atUs ?? end };
  }
}

/** The frames a video file really has (by counting its packets), or null. */
function countFrames(file) {
  const r = spawnSync(binaries().ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  const n = parseInt(String(r.stdout || "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}
