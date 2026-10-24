// Media import and derived media (FEAT-011..017, FEAT-027 freeze/reverse, FEAT-066 extract audio, proxies).
import fs from "node:fs";
import path from "node:path";
import { ffprobe, run, binaries, ffmpegJob } from "./ffmpeg.js";
import { AppError } from "../core/validation.js";
import { US, uid } from "../core/util.js";

export const MAX_IMPORT_BYTES = 4 * 1024 ** 3; // report: «Each file cannot exceed 4G»
export const MEDIA_EXT = {
  video: [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".wmv", ".mpg", ".mpeg", ".mts", ".m2ts", ".3gp", ".flv"],
  image: [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".jxl"],
  audio: [".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus", ".wma"],
};
const ALL_EXT = new Set(Object.values(MEDIA_EXT).flat());

export function classifyProbe(info, file) {
  const v = info.streams?.find((x) => x.codec_type === "video" && !x.disposition?.attached_pic);
  const a = info.streams?.find((x) => x.codec_type === "audio");
  const ext = path.extname(file).toLowerCase();
  const durSec = Number(info.format?.duration || v?.duration || a?.duration || 0);
  const isImage = MEDIA_EXT.image.includes(ext) && (!durSec || durSec < 0.05 || ["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe"].includes(info.format?.format_name) || ext !== ".gif");
  let type = v ? (isImage ? "image" : "video") : a ? "audio" : null;
  if (!type) throw new AppError("MEDIA", "err.unsupportedMedia", { file });
  const fpsStr = v?.avg_frame_rate || v?.r_frame_rate || "0/1";
  const [fn, fd] = fpsStr.split("/").map(Number);
  let width = v?.width || 0, height = v?.height || 0;
  const rot = Number(v?.tags?.rotate || v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
  return {
    type, width, height, fps: fd ? fn / fd : 0,
    durationUs: type === "image" ? 0 : Math.round(durSec * US),
    hasVideo: !!v, hasAudio: !!a, videoCodec: v?.codec_name || "", audioCodec: a?.codec_name || "",
    sampleRate: Number(a?.sample_rate || 0), channels: a?.channels || 0,
  };
}

export class MediaService {
  constructor({ repos, paths, log = () => {}, notify = () => {}, shouldProxy = () => false }) {
    this.repos = repos;
    this.paths = paths;
    this.log = log;
    this.notify = notify;           // (event, payload) → renderer ("media:updated" when thumbnails/waveforms are ready)
    this.shouldProxy = shouldProxy; // Settings › Performance › Proxy
    this.jobs = new Map(); // mediaId -> Promise (thumbnails/waveforms in progress)
  }

  async probe(file) {
    if (!fs.existsSync(file)) throw new AppError("IO", "err.fileNotFound", { file });
    const st = fs.statSync(file);
    if (st.size > MAX_IMPORT_BYTES) throw new AppError("MEDIA", "err.fileTooLarge", { file, max: MAX_IMPORT_BYTES });
    const info = await ffprobe(file);
    return { ...classifyProbe(info, file), sizeBytes: st.size, name: path.basename(file), path: path.resolve(file) };
  }

  /** Import files into a project. Returns { imported: [media], errors: [{file, error}] }. */
  async importFiles(projectId, files, { origin = "import", derivedFromId = null } = {}) {
    const imported = [], errors = [];
    for (const file of files) {
      try {
        const meta = await this.probe(file);
        const m = this.repos.media.add(projectId, { ...meta, origin, derivedFromId });
        imported.push(m);
        this.generateDerivatives(m.id).catch((e) => this.log("derivatives failed", m.id, e.message));
      } catch (e) {
        errors.push({ file, error: e instanceof AppError ? e.toJSON() : { code: "INTERNAL", messageKey: "err.internal", details: { message: e.message } } });
      }
    }
    return { imported, errors };
  }

  /** "Import folder": every media file in the folder (non-recursive). */
  listFolder(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new AppError("IO", "err.folderNotFound", { dir });
    return fs.readdirSync(dir).filter((f) => ALL_EXT.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
  }

  /** Thumbnails sprite + waveform; safe to call repeatedly. */
  generateDerivatives(mediaId) {
    if (this.jobs.has(mediaId)) return this.jobs.get(mediaId);
    const job = (async () => {
      const m = this.repos.media.get(mediaId);
      const patch = {};
      if (m.type === "video" || m.type === "image") Object.assign(patch, await this.makeThumbs(m));
      if (m.hasAudio) patch.waveformPath = await this.makeWaveform(m);
      if (Object.keys(patch).length) this.repos.media.update(mediaId, patch);
      if (m.type === "video" && this.shouldProxy() && !m.proxyPath) await this.makeProxy(mediaId).catch((e) => this.log("proxy failed", mediaId, e.message));
      const done = this.repos.media.get(mediaId);
      this.notify("media:updated", done);
      return done;
    })().finally(() => this.jobs.delete(mediaId));
    this.jobs.set(mediaId, job);
    return job;
  }

  async makeThumbs(m) {
    const { ffmpeg } = binaries();
    const out = path.join(this.paths.thumbs, `${m.id}.jpg`);
    if (m.type === "image") {
      await run(ffmpeg, ["-hide_banner", "-y", "-i", m.path, "-vf", "scale=-2:96", "-frames:v", "1", out], { timeoutMs: 60_000 });
      return { thumbPath: out, thumbCount: 1 };
    }
    const dur = Math.max(0.1, m.durationUs / US);
    const count = Math.max(1, Math.min(60, Math.ceil(dur / 2)));
    await run(ffmpeg, ["-hide_banner", "-y", "-i", m.path, "-vf", `fps=${(count / dur).toFixed(5)},scale=-2:72,tile=${count}x1`, "-frames:v", "1", "-q:v", "5", out], { timeoutMs: 180_000 });
    return { thumbPath: out, thumbCount: count };
  }

  /** 100 peaks per second, 0..1, stored as JSON. */
  async makeWaveform(m) {
    const { ffmpeg } = binaries();
    const { stdout } = await run(ffmpeg, ["-hide_banner", "-i", m.path, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], { timeoutMs: 300_000 });
    const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
    const per = 80, peaks = [];
    for (let i = 0; i < samples.length; i += per) {
      let mx = 0;
      for (let j = i; j < Math.min(samples.length, i + per); j++) { const v = Math.abs(samples[j]); if (v > mx) mx = v; }
      peaks.push(Number((mx / 32768).toFixed(3)));
    }
    const out = path.join(this.paths.waveforms, `${m.id}.json`);
    fs.writeFileSync(out, JSON.stringify({ rate: 100, peaks }));
    return out;
  }

  readWaveform(mediaId) {
    const m = this.repos.media.get(mediaId);
    if (!m.waveformPath || !fs.existsSync(m.waveformPath)) return null;
    return JSON.parse(fs.readFileSync(m.waveformPath, "utf8"));
  }

  /** Proxy (Settings › Performance › Proxy): 540p H.264 for smooth preview. */
  async makeProxy(mediaId) {
    const m = this.repos.media.get(mediaId);
    if (m.type !== "video") return m;
    const out = path.join(this.paths.proxy, `${m.id}.mp4`);
    const job = ffmpegJob(["-i", m.path, "-vf", "scale=-2:540", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "128k", out], { durationUs: m.durationUs });
    await job.promise;
    return this.repos.media.update(mediaId, { proxyPath: out });
  }

  /** Reverse (FEAT-027): render the shown source span backwards into a new derived asset. */
  async reverse(projectId, mediaId, sourceStartUs, sourceDurUs) {
    const m = this.repos.media.get(mediaId);
    if (m.type !== "video") throw new AppError("VALIDATION", "err.reverseKind");
    if (sourceDurUs > 120 * US) throw new AppError("VALIDATION", "err.reverseTooLong", { maxSeconds: 120 });
    const out = path.join(this.paths.media, `reverse-${uid()}.mp4`);
    const args = ["-ss", String(sourceStartUs / US), "-t", String(sourceDurUs / US), "-i", m.path, "-vf", "reverse", ...(m.hasAudio ? ["-af", "areverse", "-c:a", "aac"] : ["-an"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", out];
    await ffmpegJob(args, { durationUs: sourceDurUs }).promise;
    const { imported, errors } = await this.importFiles(projectId, [out], { origin: "reverse", derivedFromId: mediaId });
    if (!imported.length) throw new AppError("MEDIA", "err.reverseFailed", { errors });
    return imported[0];
  }

  /** Still frame (Freeze / Export still / cover). */
  async frameAt(mediaId, timeUs, outFile = null) {
    const m = this.repos.media.get(mediaId);
    const { ffmpeg } = binaries();
    const out = outFile || path.join(this.paths.media, `freeze-${uid()}.png`);
    const at = m.type === "image" ? [] : ["-ss", String(Math.max(0, timeUs) / US)];
    await run(ffmpeg, ["-hide_banner", "-y", ...at, "-i", m.path, "-frames:v", "1", out], { timeoutMs: 60_000 });
    if (!fs.existsSync(out)) throw new AppError("MEDIA", "err.frameFailed");
    return out;
  }

  async freezeFrame(projectId, mediaId, timeUs) {
    const file = await this.frameAt(mediaId, timeUs);
    const { imported } = await this.importFiles(projectId, [file], { origin: "freeze", derivedFromId: mediaId });
    return imported[0];
  }

  /** Mark missing files (startup check) and relink (Link to media). */
  verifyProject(projectId) {
    const missing = [];
    for (const m of this.repos.media.listByProject(projectId)) {
      const exists = fs.existsSync(m.path);
      if (!exists && m.status !== "missing") this.repos.media.update(m.id, { status: "missing" });
      if (exists && m.status === "missing") this.repos.media.update(m.id, { status: "ready" });
      if (!exists) missing.push(m.id);
    }
    return missing;
  }

  async relink(mediaId, newPath) {
    const meta = await this.probe(newPath);
    const m = this.repos.media.get(mediaId);
    if (meta.type !== m.type) throw new AppError("VALIDATION", "err.relinkType");
    const updated = this.repos.media.update(mediaId, { path: meta.path, status: "ready" });
    this.generateDerivatives(mediaId).catch(() => {});
    return updated;
  }
}
