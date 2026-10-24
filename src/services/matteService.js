// Person matte ("text behind the person"): a grayscale mask video per media file (white = the person), made
// locally with MediaPipe Selfie Multiclass (src/services/vision/person_matte.py) and cached in cache/mattes.
// The media is cut into chunks that run in parallel (the model costs ~70 ms a frame on the CPU; 8 chunks on 32 cores: ~0.4× real time for 4K); each chunk is
// FFmpeg decode → python → FFmpeg encode, and the chunks are joined without re-encoding. The mask has the
// media's timing from its first frame, so the export and the preview open it exactly like the media itself.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/validation.js";
import { US } from "../core/util.js";
import { binaries, run } from "./ffmpeg.js";

const VISION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vision").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const SCRIPT = path.join(VISION_DIR, "person_matte.py");
const MODEL = path.join(VISION_DIR, "models", "selfie_multiclass_256x256.tflite");
const VERSION = "v1"; // part of the file name: a new mask recipe makes new files
const SHORT_SIDE = 360;   // the model sees 256×256; a larger mask only costs time
const CHUNK_MIN_S = 4;
const GPU_PARTS = 4;

export class MatteService {
  constructor({ repos, paths, settings, log = () => {}, notify = () => {} }) {
    this.repos = repos;
    this.paths = paths;
    this.settings = settings;
    this.log = log;
    this.notify = notify; // "matte:ready" → the preview loads the new matte
    this.dir = path.join(paths.cache, "mattes");
    fs.mkdirSync(this.dir, { recursive: true });
    this.jobs = new Map(); // mediaId -> Promise<path>
    this.checked = null;   // { python, available, error }
    this.decoders = new Map(); // source path -> decode recipe (GPU or CPU), see decoder()
  }

  pythonCmd() { return this.settings.get("providers").pythonPath || "python"; }
  file(mediaId) { return path.join(this.dir, `${mediaId}-${VERSION}.mp4`); }
  ready(mediaId) { return fs.existsSync(this.file(mediaId)); }

  /** Whether python with mediapipe + opencv is available (cached per python path). */
  async status(force = false) {
    const py = this.pythonCmd();
    if (!force && this.checked?.python === py) return this.checked;
    try {
      await run(py, ["-c", "import mediapipe, cv2, numpy"], { timeoutMs: 90_000 });
      this.checked = { python: py, available: fs.existsSync(MODEL), error: fs.existsSync(MODEL) ? null : "model missing" };
    } catch (e) {
      this.checked = { python: py, available: false, error: (e.details?.stderr || e.message || "").slice(-300) };
    }
    return this.checked;
  }

  /** The mask video of a media file; made on first use (shared by concurrent callers). */
  ensure(mediaId, { onProgress, signal } = {}) {
    if (this.ready(mediaId)) return Promise.resolve(this.file(mediaId));
    if (!this.jobs.has(mediaId)) {
      const p = this.make(mediaId, { onProgress, signal }).finally(() => this.jobs.delete(mediaId));
      this.jobs.set(mediaId, p);
    }
    return this.jobs.get(mediaId);
  }

  async make(mediaId, { onProgress, signal }) {
    const m = this.repos.media.get(mediaId);
    if (m.type !== "video") throw new AppError("VALIDATION", "err.matteVideoOnly", { mediaId });
    const st = await this.status();
    if (!st.available) throw new AppError("PROVIDER", "err.matteUnavailable", { error: st.error });
    const src = m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path;
    if (!fs.existsSync(src)) throw new AppError("IO", "err.fileNotFound", { file: src });
    const fps = Math.min(30, Math.round(m.fps) || 30);
    const landscape = (m.width || 16) >= (m.height || 9);
    const even = (x) => Math.max(2, Math.round(x / 2) * 2);
    const W = landscape ? even((SHORT_SIDE * (m.width || 16)) / (m.height || 9)) : SHORT_SIDE;
    const H = landscape ? SHORT_SIDE : even((SHORT_SIDE * (m.height || 16)) / (m.width || 9));
    const total = Math.max(1, Math.ceil((m.durationUs / US) * fps));
    const workers = Math.max(1, Math.min(8, Math.floor(os.cpus().length / 4) || 1, Math.ceil(total / (CHUNK_MIN_S * fps))));
    const per = Math.ceil(total / workers);
    const work = fs.mkdtempSync(path.join(this.dir, `tmp-${mediaId}-`));
    const done = new Array(workers).fill(0);
    const report = () => onProgress?.(Math.min(0.99, done.reduce((a, b) => a + b, 0) / total));
    const t0 = Date.now();
    const dec = await this.decoder(src, W, H, Math.min(1, m.durationUs / US / 2));
    try {
      const parts = await Promise.all(Array.from({ length: workers }, (_, k) => {
        const a = k * per, n = Math.min(per, total - a);
        // At most 4 GPU decoders (each holds a CUDA context; other apps may hold GPU memory too); a part whose GPU
        // decode fails is made again with the CPU decoder, into a new file.
        const part = (how, out) => this.chunk({ src, dec: how, out, startFrame: a, frames: n, fps, W, H, signal, onFrames: (f) => { done[k] = f; report(); } }).then(() => out);
        const how = dec.gpu && k < GPU_PARTS ? dec : dec.cpu;
        return part(how, path.join(work, `part${k}.mp4`)).catch((e) => {
          if (how === dec.cpu || signal?.aborted) throw e;
          this.log("matte: GPU decode failed, CPU for this part", String(e.details?.stderr || e.message).slice(0, 200));
          done[k] = 0;
          return part(dec.cpu, path.join(work, `part${k}-cpu.mp4`));
        });
      }));
      const list = path.join(work, "list.txt");
      fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
      const tmp = path.join(work, "joined.mp4");
      await run(binaries().ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp], { timeoutMs: 5 * 60_000, signal });
      fs.renameSync(tmp, this.file(mediaId));
      this.log("matte ready", mediaId, `${total} frames, ${workers} workers, ${dec.gpu ? "GPU" : "CPU"} decode, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      onProgress?.(1);
      this.notify("matte:ready", { mediaIds: [mediaId] });
      return this.file(mediaId);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { this.log("matte: temp folder kept", e.message); }
    }
  }

  /**
   * How to decode a file small and fast. 4K HEVC decodes at ~1× real time on the CPU, which dominated the matte
   * time; NVIDIA decoding with the resize on the GPU is ~4× faster. GPU frames skip FFmpeg's automatic rotation, so
   * the orientation is chosen by comparing one GPU frame (as is, flipped, turned) with the CPU frame (rotated by
   * FFmpeg). No NVIDIA GPU, or no match: the CPU path.
   */
  async decoder(src, W, H, atS) {
    const key = `${src}|${W}x${H}`;
    if (this.decoders.has(key)) return this.decoders.get(key);
    const { ffmpeg } = binaries();
    const cpu = { gpu: false, pre: [], vf: `scale=${W}:${H}:flags=bilinear` };
    cpu.cpu = cpu;
    const grab = async (pre, vf) => (await run(ffmpeg, ["-hide_banner", "-loglevel", "error", ...pre, "-ss", atS.toFixed(3), "-i", src, "-an", "-vf", `${vf},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeoutMs: 60_000 })).stdout;
    let best = cpu;
    try {
      const ref = await grab(cpu.pre, cpu.vf);
      const pre = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
      let bestErr = Infinity;
      for (const [turn, sw, sh] of [["", W, H], [",hflip,vflip", W, H], [",transpose=clock", H, W], [",transpose=cclock", H, W]]) {
        const vf = `scale_cuda=${sw}:${sh}:format=yuv420p,hwdownload,format=yuv420p${turn}`;
        const img = await grab(pre, vf).catch(() => null);
        if (!img || img.length !== ref.length) continue;
        let err = 0;
        for (let i = 0; i < ref.length; i += 7) { const d = ref[i] - img[i]; err += d * d; }
        err /= ref.length / 7;
        if (err < bestErr) { bestErr = err; best = { gpu: true, pre, vf, cpu }; }
      }
      if (bestErr > 120) best = cpu; // PSNR under ~27 dB: not the same picture
    } catch (e) { this.log("matte decoder probe failed", e.message); best = cpu; }
    this.decoders.set(key, best);
    return best;
  }

  /** Frames [startFrame, startFrame + frames) of the media at `fps`: decode → model → encode. */
  chunk({ src, dec: how, out, startFrame, frames, fps, W, H, signal, onFrames }) {
    const { ffmpeg } = binaries();
    return new Promise((resolve, reject) => {
      const dec = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", ...how.pre, "-ss", (startFrame / fps).toFixed(6), "-i", src, "-an", "-vf", `${how.vf},fps=${fps}`,
        "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true });
      const py = spawn(this.pythonCmd(), ["-X", "utf8", SCRIPT, "--width", String(W), "--height", String(H), "--fps", String(fps), "--step", "2", "--model", MODEL], { windowsHide: true });
      const enc = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-g", String(fps), "-pix_fmt", "yuv420p", out], { windowsHide: true });
      const procs = [dec, py, enc];
      let err = "", failed = null, bytes = 0, closed = 0;
      // A failure stops all three processes; it is reported once they have exited (their files are closed then).
      const fail = (e) => { if (failed) return; failed = e; for (const p of procs) p.kill("SIGKILL"); setTimeout(() => reject(e), 5000); };
      for (const [name, p] of [["decode", dec], ["matte", py], ["encode", enc]]) {
        p.stderr.on("data", (d) => { err += `${name}: ${d}`; if (err.length > 20_000) err = err.slice(-8000); });
        p.on("error", (e) => fail(new AppError("PROVIDER", "err.matteFailed", { step: name, message: e.message })));
      }
      for (const s of [py.stdin, enc.stdin]) s.on("error", () => { /* the reader stopped: its exit code reports why */ });
      dec.stdout.pipe(py.stdin);
      py.stdout.on("data", (d) => { bytes += d.length; onFrames(Math.floor(bytes / (W * H))); });
      py.stdout.pipe(enc.stdin);
      signal?.addEventListener("abort", () => fail(new AppError("MEDIA", "err.cancelled")), { once: true });
      for (const [name, p] of [["decode", dec], ["matte", py], ["encode", enc]]) {
        p.on("close", (code) => {
          if (code !== 0 && code !== null) fail(new AppError("PROVIDER", "err.matteFailed", { step: name, code, stderr: err.replace(/^.*(?:WARNING|W0000|INFO:).*$/gm, "").trim().slice(-1500) }));
          if (++closed === 3) { if (failed) reject(failed); else resolve(); }
        });
      }
    });
  }
}
