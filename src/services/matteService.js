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
import { decodeRecipe } from "./fastDecode.js";

const VISION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vision").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const SCRIPT = path.join(VISION_DIR, "person_matte.py");
const MODEL = path.join(VISION_DIR, "models", "selfie_multiclass_256x256.tflite");
const VERSION = "v2"; // part of the file name: a new mask recipe makes new files (v2: + face/head boxes)
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
  }

  pythonCmd() { return this.settings.get("providers").pythonPath || "python"; }
  // variant "stab": the matte of the stabilized copy (StabilizeService), so a stabilized cutout lines up.
  file(mediaId, variant = "") { return path.join(this.dir, `${mediaId}${variant ? `-${variant}` : ""}-${VERSION}.mp4`); }
  ready(mediaId, variant = "") { return fs.existsSync(this.file(mediaId, variant)); }

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

  /**
   * The mask video of a media file; made on first use (shared by concurrent callers). `variant`/`source`: the mask
   * of another rendition with the same timing (the stabilized copy).
   */
  ensure(mediaId, { onProgress, signal, variant = "", source = null } = {}) {
    if (this.ready(mediaId, variant)) return Promise.resolve(this.file(mediaId, variant));
    const key = `${mediaId}|${variant}`;
    if (!this.jobs.has(key)) {
      const p = this.make(mediaId, { onProgress, signal, variant, source }).finally(() => this.jobs.delete(key));
      this.jobs.set(key, p);
    }
    return this.jobs.get(key);
  }

  async make(mediaId, { onProgress, signal, variant = "", source = null }) {
    const m = this.repos.media.get(mediaId);
    if (m.type !== "video") throw new AppError("VALIDATION", "err.matteVideoOnly", { mediaId });
    const st = await this.status();
    if (!st.available) throw new AppError("PROVIDER", "err.matteUnavailable", { error: st.error });
    const src = source || (m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path);
    if (!fs.existsSync(src)) throw new AppError("IO", "err.fileNotFound", { file: src });
    const fps = Math.min(30, Math.round(m.fps) || 30);
    const landscape = (m.width || 16) >= (m.height || 9);
    const even = (x) => Math.max(2, Math.round(x / 2) * 2);
    const W = landscape ? even((SHORT_SIDE * (m.width || 16)) / (m.height || 9)) : SHORT_SIDE;
    const H = landscape ? SHORT_SIDE : even((SHORT_SIDE * (m.height || 16)) / (m.width || 9));
    const total = Math.max(1, Math.ceil((m.durationUs / US) * fps));
    const workers = Math.max(1, Math.min(8, Math.floor(os.cpus().length / 4) || 1, Math.ceil(total / (CHUNK_MIN_S * fps))));
    const per = Math.ceil(total / workers);
    const work = fs.mkdtempSync(path.join(this.dir, `tmp-${mediaId}${variant ? `-${variant}` : ""}-`));
    const done = new Array(workers).fill(0);
    const report = () => onProgress?.(Math.min(0.99, done.reduce((a, b) => a + b, 0) / total));
    const t0 = Date.now();
    const dec = await decodeRecipe(src, W, H, Math.min(1, m.durationUs / US / 2), this.log);
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
      // Face/head boxes of every frame, in part order (written by the model next to each part).
      const boxes = parts.flatMap((p) => fs.readFileSync(`${p}.boxes.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      fs.writeFileSync(`${this.file(mediaId, variant)}.boxes.json`, JSON.stringify({ fps, boxes }));
      fs.renameSync(tmp, this.file(mediaId, variant));
      this.log("matte ready", mediaId + (variant ? ` (${variant})` : ""), `${total} frames, ${workers} workers, ${dec.gpu ? "GPU" : "CPU"} decode, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      onProgress?.(1);
      this.notify("matte:ready", { mediaIds: [mediaId] });
      return this.file(mediaId, variant);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { this.log("matte: temp folder kept", e.message); }
    }
  }

  /**
   * Where the person is over time, read from the matte (10 samples a second, source time): frames of
   * [tUs, x0, y0, x1, y1, hx, hy, hw, hh, area] in fractions of the frame — the person's box (x0/x1: the silhouette's
   * edges at head height, arms and hands included), the head's centre and
   * size (face + hair from the model's own classes; the silhouette's top when the face is not seen). Empty frames
   * (nobody) have area 0 and repeat the last known box. Cached as JSON.
   */
  async track(mediaId, { variant = "", source = null, onProgress } = {}) {
    const file = await this.ensure(mediaId, { variant, source, onProgress });
    const cache = `${file}.track3.json`;
    if (fs.existsSync(cache)) { try { return JSON.parse(fs.readFileSync(cache, "utf8")); } catch { /* remake */ } }
    const W = 160, H = 90;
    const { stdout } = await run(binaries().ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `fps=10,scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"], { timeoutMs: 10 * 60_000 });
    const n = Math.floor(stdout.length / (W * H));
    let faces = null;
    try { faces = JSON.parse(fs.readFileSync(`${file}.boxes.json`, "utf8")); } catch { /* an older matte: silhouette only */ }
    const headAt = (i) => { const b = faces?.boxes[Math.min(faces.boxes.length - 1, Math.round((i / 10) * faces.fps))]; return b?.[1] || null; };
    const frames = [];
    let last = [0.3, 0.1, 0.7, 1, 0.5, 0.3, 0.2, 0.25];
    const r3 = (x) => Math.round(x * 1000) / 1000;
    for (let i = 0; i < n; i++) {
      const px = stdout.subarray(i * W * H, (i + 1) * W * H);
      let x0 = W, x1 = -1, y0 = H, y1 = -1, count = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[y * W + x] > 128) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (count < W * H * 0.01) { frames.push([Math.round((i * US) / 10), ...last, 0]); continue; }
      // Head: the silhouette's top band (≈ a head height: a quarter of the person's height, at most 30 % of the frame).
      const band = Math.max(3, Math.min(Math.round(H * 0.3), Math.round((y1 - y0 + 1) * 0.28)));
      let hx0 = W, hx1 = -1, sx = 0, sc = 0;
      for (let y = y0; y < Math.min(H, y0 + band); y++) for (let x = 0; x < W; x++) if (px[y * W + x] > 128) { sc++; sx += x; if (x < hx0) hx0 = x; if (x > hx1) hx1 = x; }
      const hw = Math.min(hx1 - hx0 + 1, Math.round(band * 1.3)); // a raised arm widens the band: keep a head-like width
      const hx = sc ? sx / sc : (x0 + x1) / 2;
      last = [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H, hx / W, (y0 + band / 2) / H, hw / W, band / H].map(r3);
      const head = headAt(i); // face + hair box from the model
      if (head) last.splice(4, 4, ...[(head[0] + head[2]) / 2, (head[1] + head[3]) / 2, head[2] - head[0], head[3] - head[1]].map(r3));
      // The silhouette's left/right edges at head height (a raised arm or a hand counts): where the free side starts.
      // Upper part of the head only (where words sit): lower rows reach the shoulders in a close-up.
      const ya = Math.max(0, Math.floor((last[5] - last[7] / 2) * H)), yb = Math.min(H - 1, Math.ceil((last[5] + last[7] * 0.1) * H));
      let bx0 = W, bx1 = -1;
      for (let y = ya; y <= yb; y++) for (let x = 0; x < W; x++) if (px[y * W + x] > 128) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
      if (bx1 >= 0) { last[0] = r3(bx0 / W); last[2] = r3((bx1 + 1) / W); }
      frames.push([Math.round((i * US) / 10), ...last, r3(count / (W * H))]);
    }
    fs.writeFileSync(cache, JSON.stringify(frames));
    return frames;
  }

  /** Frames [startFrame, startFrame + frames) of the media at `fps`: decode → model → encode. */
  chunk({ src, dec: how, out, startFrame, frames, fps, W, H, signal, onFrames }) {
    const { ffmpeg } = binaries();
    return new Promise((resolve, reject) => {
      const dec = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", ...how.pre, "-ss", (startFrame / fps).toFixed(6), "-i", src, "-an", "-vf", `${how.vf},fps=${fps}`,
        "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true });
      const py = spawn(this.pythonCmd(), ["-X", "utf8", SCRIPT, "--width", String(W), "--height", String(H), "--fps", String(fps), "--step", "2", "--boxes", `${out}.boxes.jsonl`, "--model", MODEL], { windowsHide: true });
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
