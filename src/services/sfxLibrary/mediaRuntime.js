// The media runtime shared by the sound library (CLAP), the B-roll index, the image tools and the matting pipeline:
//   runtime/media           a venv of runtime/python312 whose own packages sit on top of the video runtime's (torch's
//                           CUDA 13.0 build, transformers): a .pth file adds runtime/video's site-packages, so the 5 GB
//                           torch install is not duplicated. Its own packages: requirements-media.txt.
//   runtime/models/media    the models, one folder per Hugging Face repository ("owner__name"), pinned revisions.
// Python scripts talk JSON lines: progress lines while working, one result line at the end; a "serve" script answers
// one request per line and stays loaded (PyWorker).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runtimeDirs, relinkVenv } from "../engineSetupService.js";
import { AppError } from "../../core/validation.js";

const exe = (p) => (process.platform === "win32" ? `${p}.exe` : p);
const bin = process.platform === "win32" ? "Scripts" : "bin";
const sitePackages = (dir) => (process.platform === "win32" ? path.join(dir, "Lib", "site-packages") : path.join(dir, "lib", "python3.12", "site-packages"));

/** { dir, python, models } of the media runtime, or null when it is not set up. Re-points its link to the video runtime. */
export function mediaRuntime(userData = null) {
  for (const dir of runtimeDirs("media", userData)) {
    const python = path.join(dir, bin, exe("python"));
    if (!fs.existsSync(python)) continue;
    relinkVenv(dir);
    const video = path.join(path.dirname(dir), "video");
    const pth = path.join(sitePackages(dir), "zz_video_runtime.pth");
    try { if (fs.existsSync(video) && fs.readFileSync(pth, "utf8").trim() !== sitePackages(video)) fs.writeFileSync(pth, sitePackages(video)); } catch { try { fs.writeFileSync(pth, sitePackages(video)); } catch { /* read-only install */ } }
    return { dir, python, models: path.join(path.dirname(dir), "models", "media") };
  }
  return null;
}

/** The folder of a model (Hugging Face "owner/name") in the media models folder, or null when it is not there. */
export function modelDir(rt, repo) {
  const d = path.join(rt.models, repo.replace("/", "__"));
  return fs.existsSync(d) ? d : null;
}

/**
 * Run a media script to its end. JSON lines it prints go to onLine (progress, partial results); the last JSON line is
 * the result. Fails with the tail of stderr.
 */
export function runPy(rt, script, args, { onLine = () => {}, signal, env = {}, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(rt.python, ["-X", "utf8", script, ...args], { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", ...env } });
    let err = "", buf = "", last = null;
    const timer = timeoutMs ? setTimeout(() => p.kill("SIGKILL"), timeoutMs) : null;
    signal?.addEventListener("abort", () => p.kill("SIGKILL"), { once: true });
    p.stderr.on("data", (d) => { err = (err + d).slice(-20_000); });
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        try { last = JSON.parse(line); onLine(last); } catch { /* not ours */ }
      }
    });
    p.on("error", (e) => reject(new AppError("PROVIDER", "err.mediaRuntime", { message: e.message })));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(new AppError("MEDIA", "err.cancelled"));
      if (code !== 0) return reject(new AppError("PROVIDER", "err.mediaRuntime", { script: path.basename(script), code, stderr: err.replace(/^.*Warning.*$/gm, "").trim().slice(-1500) }));
      resolve(last);
    });
  });
}

/** A script in "serve" mode: loaded once, one JSON request per line, answers in order. */
export class PyWorker {
  constructor(rt, script, args, { log = () => {} } = {}) {
    Object.assign(this, { rt, script, args, log });
    this.proc = null; this.queue = []; this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const p = spawn(this.rt.python, ["-X", "utf8", this.script, ...this.args], { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
      this.proc = p;
      let buf = "", err = "", up = false;
      p.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
      p.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("{")) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (!up && msg.ready) { up = true; resolve(); continue; }
          const q = this.queue.shift();
          if (!q) continue;
          if (msg.error) q.reject(new AppError("PROVIDER", "err.mediaRuntime", { script: path.basename(this.script), message: msg.error })); else q.resolve(msg);
        }
      });
      p.on("close", (code) => {
        const e = new AppError("PROVIDER", "err.mediaRuntime", { script: path.basename(this.script), code, stderr: err.slice(-1500) });
        if (!up) reject(e);
        for (const q of this.queue.splice(0)) q.reject(e);
        this.proc = null; this.ready = null;
      });
    });
    return this.ready;
  }

  async request(obj) {
    await this.start();
    return new Promise((resolve, reject) => { this.queue.push({ resolve, reject }); this.proc.stdin.write(`${JSON.stringify(obj)}\n`); });
  }

  stop() { try { this.proc?.stdin.end(); this.proc?.kill(); } catch { /* gone */ } this.proc = null; this.ready = null; }
}

/** float32 rows of a .f32 file as one Float32Array (rows × dims). */
export function readF32(file) {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** Dot products of a normalised query with every row (rows are normalised too: cosine similarity). */
export function cosineAll(mat, dims, q) {
  const n = mat.length / dims, out = new Float32Array(n);
  for (let r = 0; r < n; r++) { let s = 0; const o = r * dims; for (let k = 0; k < dims; k++) s += mat[o + k] * q[k]; out[r] = s; }
  return out;
}
