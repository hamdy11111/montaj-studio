// Export jobs (FEAT-113..119, FEAT-030 export selected, FEAT-028 compound pre-processing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExport, planSegments, outputSize, videoBitrateKbps, estimateSizeBytes, pickVideoEncoder, ambienceByMedia } from "../core/exportGraph.js";
import { fileURLToPath } from "node:url";
import { capabilities, ffmpegJob, run, binaries } from "./ffmpeg.js";
import { speechRegions } from "../core/speech.js";
import { cuesFromTimeline, formatSrt, formatTxt } from "../core/srt.js";
import { AppError, validateName, validateEnum } from "../core/validation.js";
import { uid, US, deepClone } from "../core/util.js";
import { timelineDuration } from "../core/model.js";
import { cutoutLayers } from "../core/cutout.js";
import { GraphicsRenderer, remotionSegments } from "../graphics/render.js";

// RNNoise speech model ("somnolent-hogwash": speech in recording noise; GregorR/rnnoise-models, not copyrightable).
const RNN_MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "audio", "models", "sh.rnnn").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

// Parts rendered at once (each FFmpeg filter graph is mostly single-threaded; NVENC allows several sessions).
const PART_CONCURRENCY = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 4)));

/** Parts for a video export: the graph-size split, made finer (still ≥ 3 s each) when cores can run them at once. */
function planParts(timeline, range, fps) {
  let parts = planSegments(timeline, { range, fps });
  const total = parts.reduce((n, p) => n + (p.endUs - p.startUs), 0);
  for (const maxItems of [5, 3]) {
    if (parts.length >= PART_CONCURRENCY || total < PART_CONCURRENCY * 3 * US) break;
    parts = planSegments(timeline, { range, fps, maxItems, minUs: 3 * US });
  }
  return parts;
}

const GIF_HEIGHT = { "240p": 240, "320p": 320, "480p": 480 };

export class ExportService {
  constructor({ repos, paths, settings, notify = () => {} }) {
    this.repos = repos;
    this.paths = paths;
    this.settings = settings;
    this.notify = notify; // (event, payload) → renderer
    this.jobs = new Map();
    // (timeline, W, H) → {segId: PNG data URL}: rasterizes text/stickers when an export is started without the
    // editor's rasters (agents, frame previews). Set by the app (src/main/rasterHost.js); null in tests.
    this.rasterize = null;
  }

  /**
   * The Remotion graphics layer (src/graphics): renders the kit's graphics of a timeline into transparent clips that
   * are overlaid like the rasterized ones. Created on first use (it starts a worker and a headless browser).
   */
  get graphics() {
    if (!this._graphics) {
      this._graphics = new GraphicsRenderer({ cacheDir: path.join(this.paths.cache, "graphics"), userData: this.paths.root || null, resolveAsset: (ref) => this.resolveMediaRef(ref) });
    }
    return this._graphics;
  }

  /** media://asset/<id> · media://lib/<id> · media://thumb/<id> → the file on disk (null when unknown). */
  resolveMediaRef(ref) {
    try {
      const u = new URL(ref), id = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      if (u.hostname === "asset") return this.repos.media.get(id)?.path || null;
      if (u.hostname === "thumb") return this.repos.media.get(id)?.thumbPath || null;
      if (u.hostname === "lib") return this.repos.library.list().find((i) => i.id === id)?.path || null;
    } catch { /* not a media link */ }
    return null;
  }

  /** Transparent clips of the timeline's Remotion graphics at the export size: { segId: file } (empty when none). */
  async graphicsOverlays(timeline, { width, height, fps, range = null, onProgress = () => {}, job = null } = {}) {
    if (!remotionSegments(timeline).length) return {};
    return this.graphics.renderTimeline(timeline, { width, height, fps, range, onProgress, isCancelled: () => !!job?.cancelled });
  }

  /** Is an export running (other heavy GPU work, such as music generation, waits for it)? */
  busy() { return this.jobs.size > 0; }

  mediaMap(projectId) {
    return Object.fromEntries(this.repos.media.listByProject(projectId).map((m) => [m.id, m]));
  }

  lutMap(tl) {
    const ids = new Set();
    for (const t of tl.tracks) for (const s of t.segments) if (s.adjust?.lut?.assetId) ids.add(s.adjust.lut.assetId);
    const items = this.repos.library.list({ kind: "lut" });
    return Object.fromEntries(items.filter((i) => ids.has(i.id)).map((i) => [i.id, i.path]));
  }

  writeOverlays(jobDir, overlays = {}) {
    fs.mkdirSync(jobDir, { recursive: true });
    const out = {};
    for (const [segId, b64] of Object.entries(overlays)) {
      if (!/^[A-Za-z0-9-]+$/.test(segId)) continue;
      if (b64 && typeof b64 === "object" && b64.caption) { out[segId] = this.writeCaptionSequence(jobDir, segId, b64); continue; }
      if (!b64 || (typeof b64 === "object" && b64.remotion)) continue; // a Remotion graphic: rendered by graphicsOverlays
      const data = String(b64).replace(/^data:image\/png;base64,/, "");
      const file = path.join(jobDir, `${segId}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      out[segId] = file;
    }
    return out;
  }

  /** A word-timed caption page: its state images + an ffconcat sequence (played as one overlay stream). */
  writeCaptionSequence(jobDir, segId, seq) {
    const files = seq.images.map((img, i) => {
      const file = path.join(jobDir, `${segId}-${i}.png`);
      fs.writeFileSync(file, Buffer.from(String(img).replace(/^data:image\/png;base64,/, ""), "base64"));
      return file.replace(/\\/g, "/").replace(/'/g, "'\\''");
    });
    const lines = ["ffconcat version 1.0"];
    for (const f of seq.frames) lines.push(`file '${files[f.img]}'`, `duration ${(f.durUs / US).toFixed(6)}`);
    if (seq.frames.length) lines.push(`file '${files[seq.frames[seq.frames.length - 1].img]}'`); // the demuxer needs the last file again
    const list = path.join(jobDir, `${segId}.ffconcat`);
    fs.writeFileSync(list, lines.join("\n") + "\n", "utf8");
    return list;
  }

  stickerFiles(tl) {
    const out = {};
    for (const t of tl.tracks) for (const s of t.segments) {
      if (s.kind === "sticker" && s.sticker?.assetId) {
        const item = this.repos.library.list({ kind: "sticker" }).find((i) => i.id === s.sticker.assetId);
        if (item && fs.existsSync(item.path)) out[s.id] = item.path;
      }
    }
    return out;
  }

  compoundPath(timelineId) { return path.join(this.paths.compound, `${timelineId}.mp4`); }

  compoundFresh(timelineId) {
    const p = this.compoundPath(timelineId);
    if (!fs.existsSync(p)) return false;
    const tlRaw = this.repos.timelines.raw(timelineId);
    return fs.statSync(p).mtimeMs >= tlRaw.updatedAt.getTime();
  }

  neededCompounds(tl) {
    const ids = new Set();
    for (const t of tl.tracks) for (const s of t.segments) if (s.kind === "compound" && s.compoundTimelineId) ids.add(s.compoundTimelineId);
    return [...ids];
  }

  /** A part of a timeline as a video file (the video studio's "selected range" source): picture and sound only. */
  async renderRange(timelineId, range, out) {
    const tl = this.repos.timelines.get(timelineId);
    await this.runJob({ projectId: tl.projectId, timeline: tl, mode: "video", out, record: false,
      opts: { resolution: "1080p", codec: "h264", bitrate: "higher", format: "mp4", fps: tl.fps, range } });
    return out;
  }

  /** Render a compound clip's child timeline to the cache (Pre-process compound clip). */
  async renderCompound(timelineId, { overlays = {}, compoundOverlays = {} } = {}) {
    const tl = this.repos.timelines.get(timelineId);
    const out = this.compoundPath(timelineId);
    await this.runJob({ projectId: tl.projectId, timeline: tl, mode: "video", out, overlays, compoundOverlays, record: false,
      opts: { resolution: "1080p", codec: "h264", bitrate: "higher", format: "mp4", fps: tl.fps } });
    return out;
  }

  estimate(timelineId, req = {}) {
    const tl = this.repos.timelines.get(timelineId);
    const dur = req.range ? req.range.endUs - req.range.startUs : timelineDuration(tl);
    const size = outputSize(tl.canvas, req.resolution || "1080p");
    const kbps = videoBitrateKbps({ ...size, fps: req.fps || tl.fps, bitrate: req.bitrate, codec: req.codec });
    const encoder = pickVideoEncoder(req.codec || "h264", { hw: this.settings.get("performance").hwEncode, encoders: this.caps?.encoders ?? null, width: size.width, height: size.height });
    return { durationUs: dur, ...size, videoKbps: kbps, sizeBytes: estimateSizeBytes(dur, req.videoEnabled === false ? 0 : kbps, 192), encoder: encoder.name, hwFallback: encoder.hwFallback, switchedTo: encoder.switchedTo };
  }

  /**
   * Start an export. req: { timelineId, name, dir, mode: video|audio|gif|still|captions, resolution, bitrate, codec,
   *   format, fps, audioFormat, gifResolution, captionsFormat, range, onlySegmentIds, stillAtUs, overlays, compoundOverlays }
   * Returns { jobId, path } immediately; progress/done/error are pushed through notify().
   */
  start(req) {
    const tl0 = this.repos.timelines.get(req.timelineId);
    const project = this.repos.projects.get(tl0.projectId);
    const mode = validateEnum(req.mode || "video", ["video", "audio", "gif", "still", "captions"], "mode");
    const name = validateName(req.name || project.name);
    const dir = req.dir || this.settings.get("export").dir;
    if (!fs.existsSync(dir)) throw new AppError("IO", "err.folderNotFound", { dir });
    const ext = { video: req.format === "mov" ? "mov" : "mp4", audio: req.audioFormat || "flac", gif: "gif", still: "png", captions: req.captionsFormat === "txt" ? "txt" : "srt" }[mode];
    const out = uniquePath(path.join(dir, `${name}.${ext}`));
    if (mode === "video" || mode === "audio") {
      // Low disk warning (FEAT-142): need the estimated size plus a 10 % margin.
      const est = this.estimate(req.timelineId, req).sizeBytes;
      let free = null;
      try { const st = fs.statfsSync(dir); free = st.bavail * st.bsize; } catch { /* unknown: let FFmpeg report it */ }
      if (free !== null && free < est * 1.1) throw new AppError("IO", "err.diskFull", { needBytes: est, freeBytes: free });
    }
    let tl = tl0;
    if (req.onlySegmentIds?.length) tl = onlySegments(tl0, req.onlySegmentIds);
    if (mode === "captions") {
      const cues = cuesFromTimeline(tl);
      if (!cues.length) throw new AppError("VALIDATION", "err.noCaptions");
      fs.writeFileSync(out, "﻿" + (ext === "txt" ? formatTxt(cues) : formatSrt(cues)), "utf8");
      const rec = this.repos.exports.create({ projectId: project.id, projectName: project.name, path: out, kind: "captions", settings: { format: ext } });
      this.repos.exports.update(rec, { status: "done", progress: 1, sizeBytes: fs.statSync(out).size });
      return { jobId: rec, path: out, done: true };
    }
    const jobId = uid();
    const promise = this.runJob({ jobId, projectId: project.id, projectName: project.name, timeline: tl, mode, out, overlays: req.overlays, compoundOverlays: req.compoundOverlays, opts: req, record: true });
    promise.catch(() => {}); // errors are reported via notify
    return { jobId, path: out };
  }

  cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    j.cancelled = true;
    j.cancel?.();
    return true;
  }

  /** Encoder capabilities, cached for estimate(); refreshed on every job. */
  async loadCaps() { this.caps = await capabilities(); return this.caps; }

  /**
   * A video export: the picture in one or more parts (each part a range export, frame-identical to the same frames
   * of a single run), encoded with the final codec into a container that joins cleanly (MPEG-TS for H.264/HEVC);
   * the audio in its own FFmpeg run at the same time (in one run, FFmpeg 6.1 encodes AAC on the same thread as the
   * picture: +1.3 s on a 60 s 1080p export); then picture and sound are joined by stream copy.
   */
  async renderVideo({ timeline, common, parts, out, jobDir, graphArg, step, report, job }) {
    const { name: encoder } = pickVideoEncoder(common.video.codec, { hw: common.video.hw, encoders: common.caps?.encoders, width: common.width, height: common.height });
    const hevc = /hevc|x265/.test(encoder); // the codec actually written (an 8K H.264 export may switch to HEVC)
    const ts = hevc || /264/.test(encoder);
    const total = parts.reduce((n, p) => n + (p.endUs - p.startUs), 0);
    const list = [];
    let audioFile = null, audio = null;
    if (common.audio.enabled) {
      const built = buildExport(timeline, { ...common, mode: "audio", audio: { enabled: true, format: "aac" } });
      audioFile = path.join(jobDir, "audio.m4a");
      audio = step([...built.inputs, ...graphArg(built.graph), ...built.encode, audioFile], built.durationUs, () => {});
      audio.catch(() => {}); // awaited below; a picture failure stops it first
    }
    try {
      await this.renderParts({ timeline, common, parts, jobDir, graphArg, step, report, ts, total, list });
      await audio;
    } catch (err) { job.cancel?.(); throw err; }
    const listFile = path.join(jobDir, "parts.txt");
    fs.writeFileSync(listFile, list.join("\n") + "\n", "utf8");
    const join = ["-f", "concat", "-safe", "0", "-i", listFile, ...(audioFile ? ["-i", audioFile] : []), "-map", "0:v", ...(audioFile ? ["-map", "1:a"] : []), "-c", "copy",
      ...(hevc ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", out];
    await step(join, total, (p) => report(0.96 + p * 0.04));
  }

  /**
   * Files derived from the media that a timeline needs: stabilized copies of stabilized clips' videos, and person
   * mattes for cutouts (of the stabilized copy when the clip is stabilized). Made once per media file and cached.
   * onProgress(stage: "stabilize" | "matte", 0..1). Returns { stabilized: {mediaId: media}, mattes: {key: path} }.
   */
  async prepareDerived(timeline, onProgress = () => {}) {
    const stabilized = {};
    for (const id of stabilizedMedia(timeline)) {
      if (!this.stabilizer) continue; // deshake in the graph instead
      await this.stabilizer.ensure(id, { fps: timeline.fps || 30, onProgress: (p) => onProgress("stabilize", p) });
      stabilized[id] = await this.stabilizer.info(id, timeline.fps || 30);
    }
    const mattes = {};
    for (const [id, stab] of mattedMedia(timeline)) {
      if (!this.mattes) throw new AppError("PROVIDER", "err.matteUnavailable", {});
      const opts = { onProgress: (p) => onProgress("matte", p) };
      if (stab && stabilized[id]) mattes[`${id}|stab`] = await this.mattes.ensure(id, { ...opts, variant: "stab", source: stabilized[id].path });
      else mattes[id] = await this.mattes.ensure(id, opts);
    }
    return { stabilized, mattes };
  }

  /** Whether everything prepareDerived() would make already exists. */
  derivedReady(timeline) {
    return stabilizedMedia(timeline).every((id) => !this.stabilizer || this.stabilizer.ready(id, timeline.fps || 30))
      && mattedMedia(timeline).every(([id, stab]) => this.mattes?.ready(id, stab && this.stabilizer ? "stab" : ""));
  }

  /**
   * Voice clean-up data for the export: the RNNoise model, per media where its words are (cached transcripts), and
   * the kept action whose own sound the clean-up leaves alone (keepAmbience, source µs per media; `override` = an
   * export request's own list, else what the edit plan stored for this timeline).
   */
  voiceFor(tl, override = null) {
    const speech = {};
    for (const t of tl.tracks) for (const s of t.segments) {
      if (!s.mediaId || !s.audioFx?.denoise?.enabled || speech[s.mediaId] !== undefined) continue;
      const words = this.captions?.cachedWords?.(s.mediaId);
      speech[s.mediaId] = words?.length ? speechRegions(words) : null;
    }
    const keepAmbience = ambienceByMedia(override || this.keepAmbience(tl.id));
    return { speech, rnnModel: fs.existsSync(RNN_MODEL) ? RNN_MODEL : null, ...(keepAmbience ? { keepAmbience } : {}) };
  }

  /** Where a timeline's kept-action spans are stored (one small JSON per timeline, beside the app's other caches). */
  ambienceFile(timelineId) { return path.join(this.paths.cache, "ambience", `${String(timelineId).replace(/[^\w.-]/g, "_")}.json`); }

  /**
   * Stores the edit plan's `audio.keepAmbience` (`[{ mediaId, fromUs, toUs }]`, SOURCE time) for a timeline: every
   * later export of it keeps those spans' own sound under the voice clean-up. An empty list removes it. Returns the
   * spans kept (merged, malformed ones dropped). Called when a plan is applied (agent/editPlan.js).
   */
  setKeepAmbience(timelineId, list) {
    const file = this.ambienceFile(timelineId);
    const by = ambienceByMedia(list);
    const flat = by ? Object.entries(by).flatMap(([mediaId, sp]) => sp.map(([fromUs, toUs]) => ({ mediaId, fromUs, toUs }))) : [];
    if (!flat.length) { fs.rmSync(file, { force: true }); return []; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: "montaj.keepAmbience/1", spans: flat }), "utf8");
    return flat;
  }

  /** The kept-action spans stored for a timeline (`[{ mediaId, fromUs, toUs }]`), [] when none. */
  keepAmbience(timelineId) {
    try { return JSON.parse(fs.readFileSync(this.ambienceFile(timelineId), "utf8")).spans || []; } catch { return []; }
  }

  /** Static gain (dB) that brings the mix to `target` LUFS: renders the audio once and measures it (EBU R128). */
  async masterGain(timeline, common, target, graphArg) {
    const b = buildExport(timeline, { ...common, mode: "audio", audio: { enabled: true, format: "aac" }, measureLoudness: true });
    const { stderr } = await run(binaries().ffmpeg, ["-hide_banner", "-nostats", ...b.inputs, ...graphArg(b.graph), "-map", "[aout]", "-f", "null", "-"], { timeoutMs: 30 * 60_000 });
    const m = [...String(stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
    const measured = m ? Number(m[1]) : NaN;
    return Number.isFinite(measured) && measured > -70 ? Math.max(-20, Math.min(30, target - measured)) : 0;
  }

  /**
   * The picture parts; fills `list` with concat-demuxer entries in timeline order. Several parts render at once:
   * a filter graph mostly runs on one core, so independent parts in parallel use the machine (a timeline of many
   * short clips with transitions was 3× slower than CapCut one part at a time). 8K-class frames stay sequential.
   */
  async renderParts({ timeline, common, parts, jobDir, graphArg, step, report, ts, total, list }) {
    const big = common.width * common.height > 4096 * 2304;
    const width = big ? 1 : Math.max(1, Math.min(PART_CONCURRENCY, parts.length));
    const progress = new Array(parts.length).fill(0);
    const files = [];
    const renderOne = async (i) => {
      const part = parts[i];
      const built = buildExport(timeline, { ...common, range: part, audio: { ...common.audio, enabled: false } });
      // Container-specific flags go on the final file only.
      const encode = built.encode.filter((x, k, a) => !(x === "-movflags" || a[k - 1] === "-movflags" || (x === "-tag:v" || a[k - 1] === "-tag:v")));
      const file = path.join(jobDir, `part${i}.${ts ? "ts" : "mov"}`);
      const dur = part.endUs - part.startUs;
      files[i] = { file, dur };
      await step([...built.inputs, ...graphArg(built.graph), ...encode, "-f", ts ? "mpegts" : "mov", file], built.durationUs, (p) => {
        progress[i] = p * dur;
        report((progress.reduce((a, b) => a + b, 0) / total) * 0.96);
      });
      progress[i] = dur;
    };
    let next = 0;
    const worker = async () => { while (next < parts.length) await renderOne(next++); };
    await Promise.all(Array.from({ length: width }, worker));
    for (const { file, dur } of files) list.push(`file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${(dur / US).toFixed(6)}`);
  }

  /**
   * Render frames of a timeline as JPEG files (for agents to look at): the same graph as a still export, at a small
   * size, without notifications or export records. Returns [{ atUs, file }]; the caller deletes the files.
   */
  async renderFrames(timelineId, timesUs, { short = 360 } = {}) {
    let tl = this.repos.timelines.get(timelineId);
    const size = outputSize(tl.canvas, short);
    const overlays = this.rasterize && needsRaster(tl) ? await this.rasterize(tl, size.width, size.height) : {};
    const textOmitted = !this.rasterize && needsRaster(tl);
    if (textOmitted) tl = { ...tl, tracks: tl.tracks.map((t) => ({ ...t, segments: t.segments.filter((s) => s.kind !== "text" && s.kind !== "sticker") })) }; // no raster window (tests)
    const dir = path.join(this.paths.cache, "frames");
    fs.mkdirSync(dir, { recursive: true });
    const total = timelineDuration(tl);
    const out = [];
    for (const t of timesUs) {
      const atUs = Math.max(0, Math.min(Math.round(t), Math.max(0, total - 1)));
      const file = path.join(dir, `${uid()}.jpg`);
      await this.runJob({ projectId: tl.projectId, timeline: tl, mode: "still", out: file, overlays, opts: { resolution: short, stillAtUs: atUs }, record: false, quiet: true });
      out.push({ atUs, file, textOmitted });
    }
    return out;
  }

  async runJob({ jobId = uid(), projectId, projectName = "", timeline, mode, out, overlays = {}, compoundOverlays = {}, opts = {}, record, quiet = false }) {
    const notify = quiet ? () => {} : this.notify;
    const caps = await this.loadCaps();
    const job = { cancel: null, cancelled: false, runs: new Set() };
    this.jobs.set(jobId, job);
    const recId = record ? this.repos.exports.create({ projectId, projectName, path: out, kind: mode, settings: { ...opts, overlays: undefined, compoundOverlays: undefined } }) : null;
    const jobDir = path.join(this.paths.overlays, jobId);
    try {
      // Compound clips must be pre-processed (rendered) first.
      const compoundFiles = {};
      for (const cid of this.neededCompounds(timeline)) {
        if (!this.compoundFresh(cid)) await this.renderCompound(cid, { overlays: compoundOverlays?.[cid] || {}, compoundOverlays });
        compoundFiles[cid] = this.compoundPath(cid);
      }
      const { stabilized, mattes } = await this.prepareDerived(timeline, (stage, p) => notify("export:progress", { jobId, progress: 0, stage, stageProgress: p }));
      const size = outputSize(timeline.canvas, opts.resolution || "1080p");
      const voice = this.voiceFor(timeline, opts.keepAmbience);
      // Started without the editor's rasters (agents, compounds): rasterize here with the same drawing code.
      if ((!overlays || !Object.keys(overlays).length) && this.rasterize && needsRaster(timeline)) overlays = await this.rasterize(timeline, size.width, size.height);
      // Renderer rasters (text, stickers at the export size) win; original sticker files are the fallback.
      const fps = Number(opts.fps) || timeline.fps || 30;
      // Remotion graphics: one transparent clip each, rendered (or reused from the cache) before the FFmpeg graph.
      const gfx = await this.graphicsOverlays(timeline, { width: size.width, height: size.height, fps, range: opts.range || null, job, onProgress: (p) => notify("export:progress", { jobId, progress: 0, stage: "graphics", stageProgress: p }) });
      const files = { ...this.stickerFiles(timeline), ...this.writeOverlays(jobDir, overlays), ...gfx };
      const common = {
        media: this.mediaMap(projectId), overlays: files, luts: this.lutMap(timeline), compoundFiles, mattes, stabilized, caps, ...voice,
        musicBed: this.musicBed?.forExport(timeline) || null, // music under speech (services/musicBedService.js)
        width: size.width, height: size.height, fps, range: opts.range || null, mode,
        video: { codec: opts.codec || "h264", format: opts.format || "mp4", bitrate: opts.bitrate || "recommended", hw: this.settings.get("performance").hwEncode },
        audio: { enabled: opts.audioEnabled !== false, format: opts.audioFormat || "flac" },
        gifHeight: GIF_HEIGHT[opts.gifResolution] || 320, gifFps: 15, stillAtUs: opts.stillAtUs ?? 0,
      };
      fs.mkdirSync(jobDir, { recursive: true });
      const major = Number(/version (\d+)/.exec(caps.version)?.[1] || 6);
      let graphs = 0;
      const graphArg = (graph) => {
        const graphFile = path.join(jobDir, `graph${graphs++ || ""}.txt`);
        fs.writeFileSync(graphFile, graph, "utf8");
        return major >= 7 ? ["-/filter_complex", graphFile] : ["-filter_complex_script", graphFile];
      };
      const report = (p) => { notify("export:progress", { jobId, progress: p }); if (recId) this.repos.exports.update(recId, { progress: p }); };
      // Loudness in two passes: measure the finished mix, then one static gain (+ limiter) on the whole of it.
      const target = loudnessTarget(timeline);
      if (target !== null && (mode === "video" || mode === "audio")) common.masterGainDb = await this.masterGain(timeline, common, target, graphArg);
      const step = async (args, durationUs, onProgress) => {
        if (job.cancelled) throw new AppError("MEDIA", "err.cancelled");
        if (process.env.MONTAJ_KEEP_EXPORT_GRAPH) fs.writeFileSync(path.join(jobDir, `args${graphs}.json`), JSON.stringify(args, null, 1));
        const run = ffmpegJob(args, { durationUs, onProgress });
        job.runs.add(run);
        job.cancel = () => { for (const r of job.runs) r.cancel(); };
        try { await run.promise; } finally { job.runs.delete(run); }
      };
      if (mode === "video") await this.renderVideo({ timeline, common, parts: planParts(timeline, common.range, fps), out, jobDir, graphArg, step, report, job });
      else {
        const built = buildExport(timeline, common);
        await step([...built.inputs, ...graphArg(built.graph), ...built.encode, out], built.durationUs, report);
      }
      const sizeBytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (recId) this.repos.exports.update(recId, { status: "done", progress: 1, sizeBytes });
      notify("export:done", { jobId, path: out, sizeBytes, mode });
      return out;
    } catch (err) {
      const cancelled = job.cancelled || err?.messageKey === "err.cancelled";
      if (recId) this.repos.exports.update(recId, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "cancelled" : String(err?.details?.stderr || err?.message || err).slice(-2000) });
      if (fs.existsSync(out) && cancelled) fs.rmSync(out, { force: true });
      notify("export:error", { jobId, cancelled, error: err instanceof AppError ? err.toJSON() : { code: "INTERNAL", messageKey: "err.exportFailed", details: { message: String(err?.message || err) } } });
      throw err;
    } finally {
      this.jobs.delete(jobId);
      if (process.env.MONTAJ_KEEP_EXPORT_GRAPH) console.log("[export] graph kept in", jobDir);
      else fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }
}

/** [mediaId, stabilized] pairs of the clips shown as person cutouts (videoFx.matte = person, or behind-person). */
export function mattedMedia(tl) {
  const out = new Map();
  const add = (s) => out.set(`${s.mediaId}|${!!s.videoFx?.stabilize?.enabled}`, [s.mediaId, !!s.videoFx?.stabilize?.enabled]);
  for (const t of tl.tracks) for (const s of t.segments) if (s.kind === "video" && !s.disabled && s.videoFx?.matte?.type === "person") add(s);
  for (const c of cutoutLayers(tl)) add(c.seg);
  return [...out.values()];
}

/** Media ids of visible video clips with stabilization on. */
export const stabilizedMedia = (tl) => [...new Set(tl.tracks.filter((t) => !t.hidden).flatMap((t) => t.segments.filter((s) => s.kind === "video" && !s.disabled && s.videoFx?.stabilize?.enabled).map((s) => s.mediaId)))];

/** Target loudness (LUFS) when a clip asks for normalization, else null. */
export function loudnessTarget(tl) {
  for (const t of tl.tracks) if (!t.muted) for (const s of t.segments) if (!s.disabled && s.audioFx?.normalize?.enabled) return s.audioFx.normalize.targetLufs ?? -14;
  return null;
}

/** True when a timeline has text or sticker layers that must be rasterized for export. */
export const needsRaster = (tl) => tl.tracks.some((t) => t.segments.some((s) => s.kind === "text" || s.kind === "sticker"));

export function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 1; i < 10_000; i++) { const p = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(p)) return p; }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}

/** Keep only the given segments, shifted so the earliest starts at 0 (Export selected clips). */
export function onlySegments(tl, ids) {
  const c = deepClone(tl);
  let min = Infinity;
  for (const t of c.tracks) { t.segments = t.segments.filter((s) => ids.includes(s.id)); for (const s of t.segments) min = Math.min(min, s.start); }
  if (!Number.isFinite(min)) throw new AppError("VALIDATION", "err.selectionEmpty");
  for (const t of c.tracks) for (const s of t.segments) { s.start -= min; s.transitionOut = { type: "none", durationUs: 500_000 }; }
  c.tracks = c.tracks.filter((t) => t.segments.length);
  return c;
}

export { US };
