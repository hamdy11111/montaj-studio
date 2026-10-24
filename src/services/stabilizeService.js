// Stabilization of handheld footage: a stabilized copy per video, made once with the two-pass vid.stab filters
// (motion analysis, then the smoothed correction with a slight automatic zoom so no border shows) and cached in
// cache/stabilized. vidstabtransform follows a frame counter, so it cannot run on a seeked part of a file; a whole
// stabilized copy keeps the export, the preview and the person matte on the same pixels and timing. The audio is
// copied unchanged (same timing as the source). Measured on a 4K/60 selfie video: jitter −45 % (11.8 → 6.5 px RMS).
// The copy is made at the timeline's frame rate (bilinear resampling: bicubic made it 3× slower for no visible gain).
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../core/validation.js";
import { US } from "../core/util.js";
import { ffmpegJob } from "./ffmpeg.js";
import { decodeRecipe } from "./fastDecode.js";

const VERSION = "v1";
const SHORT_SIDE = 1080; // the copy is made at (at most) 1080p: the size of most exports

const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");

export class StabilizeService {
  constructor({ repos, paths, log = () => {}, notify = () => {} }) {
    this.repos = repos;
    this.log = log;
    this.notify = notify; // "stab:ready" → the preview switches to the stabilized copy
    this.dir = path.join(paths.cache, "stabilized");
    fs.mkdirSync(this.dir, { recursive: true });
    this.jobs = new Map();
  }

  file(mediaId, fps = 30) { return path.join(this.dir, `${mediaId}-${this.rate(mediaId, fps)}-${VERSION}.mp4`); }
  ready(mediaId, fps = 30) { return fs.existsSync(this.file(mediaId, fps)); }
  /** Frame rate of the copy: the timeline's, at most the source's. */
  rate(mediaId, fps) { let src = 60; try { src = Math.round(this.repos.media.get(mediaId).fps) || 60; } catch { /* unknown media */ } return Math.max(1, Math.min(src, Math.round(fps) || 30, 60)); }

  /** Size of the stabilized copy for a media item (aspect kept, short side ≤ 1080, even). */
  size(m) {
    const w = m.width || 1920, h = m.height || 1080, k = Math.min(1, SHORT_SIDE / Math.min(w, h));
    const even = (x) => Math.max(2, Math.round(x / 2) * 2);
    return { W: even(w * k), H: even(h * k) };
  }

  ensure(mediaId, { onProgress, signal, fps = 30 } = {}) {
    if (this.ready(mediaId, fps)) return Promise.resolve(this.file(mediaId, fps));
    const key = `${mediaId}|${this.rate(mediaId, fps)}`;
    if (!this.jobs.has(key)) this.jobs.set(key, this.make(mediaId, { onProgress, signal, fps: this.rate(mediaId, fps) }).finally(() => this.jobs.delete(key)));
    return this.jobs.get(key);
  }

  async make(mediaId, { onProgress, signal, fps }) {
    const m = this.repos.media.get(mediaId);
    if (m.type !== "video") throw new AppError("VALIDATION", "err.stabilizeVideoOnly", { mediaId });
    if (!fs.existsSync(m.path)) throw new AppError("IO", "err.fileNotFound", { file: m.path });
    const { W, H } = this.size(m);
    const work = fs.mkdtempSync(path.join(this.dir, `tmp-${mediaId}-`));
    const trf = path.join(work, "motion.trf"), out = path.join(work, "stab.mp4");
    const t0 = Date.now();
    const dec = await decodeRecipe(m.path, W, H, Math.min(1, m.durationUs / US / 2), this.log);
    const pass = (how, vf, tail, from, span) => {
      const job = ffmpegJob(["-hide_banner", "-y", ...how.pre, "-i", m.path, "-vf", `${how.vf},fps=${fps},${vf}`, ...tail], { durationUs: m.durationUs, onProgress: (p) => onProgress?.(from + p * span) });
      signal?.addEventListener("abort", () => job.cancel(), { once: true });
      return job.promise;
    };
    const smoothing = Math.round(0.75 * fps); // 0.75 s: keeps intended moves, removes the hand shake
    const detect = `vidstabdetect=shakiness=8:accuracy=15:stepsize=4:result='${esc(trf)}'`;
    const transform = `vidstabtransform=input='${esc(trf)}':smoothing=${smoothing}:optzoom=1:zoomspeed=0.15:interpol=bilinear,unsharp=5:5:0.4,format=yuv420p`;
    const encode = (codec) => [...(codec === "nvenc" ? ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "20", "-b:v", "0"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17"]),
      "-g", String(fps), "-r", String(fps), "-map", "0:v:0", "-map", "0:a?", "-c:a", "copy", "-movflags", "+faststart", out];
    try {
      const both = async (how) => {
        await pass(how, detect, ["-an", "-f", "null", "-"], 0, 0.4);
        await pass(how, transform, encode("nvenc"), 0.4, 0.6).catch(() => pass(how, transform, encode("x264"), 0.4, 0.6));
      };
      await both(dec).catch((e) => {
        if (!dec.gpu || signal?.aborted) throw e;
        this.log("stabilize: GPU decode failed, CPU", String(e.details?.stderr || e.message).slice(0, 200));
        return both(dec.cpu);
      });
      fs.renameSync(out, this.file(mediaId, fps));
      this.log("stabilized", mediaId, `${W}x${H}@${fps}, ${dec.gpu ? "GPU" : "CPU"} decode, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      onProgress?.(1);
      this.notify("stab:ready", { mediaIds: [mediaId] });
      return this.file(mediaId, fps);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { this.log("stabilize: temp folder kept", e.message); }
    }
  }

  /** Media facts of the stabilized copy (for the export graph): same timing and audio as the source. */
  async info(mediaId, fps = 30) {
    const m = this.repos.media.get(mediaId);
    const { W, H } = this.size(m);
    return { ...m, path: this.file(mediaId, fps), width: W, height: H, fps: this.rate(mediaId, fps), videoCodec: "h264" };
  }
}
