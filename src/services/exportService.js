// Export jobs (FEAT-113..119, FEAT-030 export selected, FEAT-028 compound pre-processing).
import fs from "node:fs";
import path from "node:path";
import { buildExport, planSegments, outputSize, videoBitrateKbps, estimateSizeBytes, pickVideoEncoder } from "../core/exportGraph.js";
import { capabilities, ffmpegJob } from "./ffmpeg.js";
import { cuesFromTimeline, formatSrt, formatTxt } from "../core/srt.js";
import { AppError, validateName, validateEnum } from "../core/validation.js";
import { uid, US, deepClone } from "../core/util.js";
import { timelineDuration } from "../core/model.js";

const GIF_HEIGHT = { "240p": 240, "320p": 320, "480p": 480 };

export class ExportService {
  constructor({ repos, paths, settings, notify = () => {} }) {
    this.repos = repos;
    this.paths = paths;
    this.settings = settings;
    this.notify = notify; // (event, payload) → renderer
    this.jobs = new Map();
  }

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
      const data = String(b64).replace(/^data:image\/png;base64,/, "");
      const file = path.join(jobDir, `${segId}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      out[segId] = file;
    }
    return out;
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

  /** The picture parts, in order; fills `list` with concat-demuxer entries. */
  async renderParts({ timeline, common, parts, jobDir, graphArg, step, report, ts, total, list }) {
    let done = 0;
    for (const [i, part] of parts.entries()) {
      const built = buildExport(timeline, { ...common, range: part, audio: { ...common.audio, enabled: false } });
      // Container-specific flags go on the final file only.
      const encode = built.encode.filter((x, k, a) => !(x === "-movflags" || a[k - 1] === "-movflags" || (x === "-tag:v" || a[k - 1] === "-tag:v")));
      const file = path.join(jobDir, `part${i}.${ts ? "ts" : "mov"}`);
      const dur = part.endUs - part.startUs;
      await step([...built.inputs, ...graphArg(built.graph), ...encode, "-f", ts ? "mpegts" : "mov", file], built.durationUs, (p) => report(((done + p * dur) / total) * 0.96));
      list.push(`file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${(dur / US).toFixed(6)}`);
      done += dur;
    }
  }

  async runJob({ jobId = uid(), projectId, projectName = "", timeline, mode, out, overlays = {}, compoundOverlays = {}, opts = {}, record }) {
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
      // Renderer rasters (text, stickers at the export size) win; original sticker files are the fallback.
      const files = { ...this.stickerFiles(timeline), ...this.writeOverlays(jobDir, overlays) };
      const size = outputSize(timeline.canvas, opts.resolution || "1080p");
      const fps = Number(opts.fps) || timeline.fps || 30;
      const common = {
        media: this.mediaMap(projectId), overlays: files, luts: this.lutMap(timeline), compoundFiles, caps,
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
      const report = (p) => { this.notify("export:progress", { jobId, progress: p }); if (recId) this.repos.exports.update(recId, { progress: p }); };
      const step = async (args, durationUs, onProgress) => {
        if (job.cancelled) throw new AppError("MEDIA", "err.cancelled");
        if (process.env.MONTAJ_KEEP_EXPORT_GRAPH) fs.writeFileSync(path.join(jobDir, `args${graphs}.json`), JSON.stringify(args, null, 1));
        const run = ffmpegJob(args, { durationUs, onProgress });
        job.runs.add(run);
        job.cancel = () => { for (const r of job.runs) r.cancel(); };
        try { await run.promise; } finally { job.runs.delete(run); }
      };
      if (mode === "video") await this.renderVideo({ timeline, common, parts: planSegments(timeline, { range: common.range, fps }), out, jobDir, graphArg, step, report, job });
      else {
        const built = buildExport(timeline, common);
        await step([...built.inputs, ...graphArg(built.graph), ...built.encode, out], built.durationUs, report);
      }
      const sizeBytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (recId) this.repos.exports.update(recId, { status: "done", progress: 1, sizeBytes });
      this.notify("export:done", { jobId, path: out, sizeBytes, mode });
      return out;
    } catch (err) {
      const cancelled = job.cancelled || err?.messageKey === "err.cancelled";
      if (recId) this.repos.exports.update(recId, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "cancelled" : String(err?.details?.stderr || err?.message || err).slice(-2000) });
      if (fs.existsSync(out) && cancelled) fs.rmSync(out, { force: true });
      this.notify("export:error", { jobId, cancelled, error: err instanceof AppError ? err.toJSON() : { code: "INTERNAL", messageKey: "err.exportFailed", details: { message: String(err?.message || err) } } });
      throw err;
    } finally {
      this.jobs.delete(jobId);
      if (process.env.MONTAJ_KEEP_EXPORT_GRAPH) console.log("[export] graph kept in", jobDir);
      else fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }
}

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
