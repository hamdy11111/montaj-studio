// The graphics layer seen from the app: turns the Remotion graphics of a timeline into transparent clips that the
// exporter overlays like any other layer (core/exportGraph.js reads .mov overlays as alpha video from the segment
// start). Rendering runs in renderWorker.js (one child process, one browser, reused across graphics); identical
// graphics (same template, parameters, pack, size, rate and length) are rendered once and cached.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { KIT_TEMPLATES, kitParams } from "../core/graphicsKit.js";
import { graphicsRuntime } from "./setup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const US = 1_000_000;
const require = createRequire(import.meta.url);
const unpacked = (p) => p.replace(/\.asar([\\/])/i, ".asar.unpacked$1");

/** Folder of Remotion's compositor + ffmpeg binaries (outside the asar in the packaged app). */
export function binariesDir() {
  try { return unpacked(path.dirname(require.resolve("@remotion/compositor-win32-x64-msvc/package.json"))); } catch { return null; }
}

/** Remotion graphic segments of a timeline: [{ seg, template, params, pack }]. */
export function remotionSegments(tl) {
  const out = [];
  for (const t of tl?.tracks || []) for (const s of t.segments || []) {
    const g = s.kind === "text" ? s.text?.graphic : null;
    if (g && KIT_TEMPLATES[g.template]?.engine === "remotion" && !s.disabled) out.push({ seg: s, track: t, template: g.template, params: g.params || {}, pack: g.pack || "punchy" });
  }
  return out;
}

/** Every string in a parameter object that names a picture/file (media:// links and absolute paths). */
export function assetRefs(params) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") { if (/^media:\/\//i.test(v) || /^([A-Za-z]:[\\/]|\\\\|\/)/.test(v)) out.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(params);
  return [...out];
}

/** Render job of one graphic segment at an output size and rate. */
export function segmentJob({ seg, template, params, pack }, { width, height, fps }) {
  const durationInFrames = Math.max(1, Math.round((seg.duration / US) * fps));
  return { template, params: kitParams(template, params), pack, width, height, fps, durationInFrames };
}

/** Cache key of a job (and of the bundle it is rendered with: a rebuilt bundle renders again). */
export function jobKey(job, bundleStamp = "") {
  const h = crypto.createHash("sha1");
  h.update(JSON.stringify([job.template, job.params, job.pack, job.width, job.height, job.fps, job.durationInFrames, job.codec || "prores", job.scale || 1, bundleStamp]));
  return h.digest("hex").slice(0, 20);
}

export class GraphicsRenderer {
  /**
   * @param {object} o
   * @param {string} o.cacheDir           where rendered clips are kept (reused while the graphic is unchanged)
   * @param {string} [o.userData]         the app's data folder (the browser may be installed there)
   * @param {(ref: string) => string|null} [o.resolveAsset]  media://… → file path
   * @param {number} [o.concurrency]      browser tabs rendering in parallel
   */
  constructor({ cacheDir, userData = null, resolveAsset = () => null, concurrency } = {}) {
    this.cacheDir = cacheDir;
    this.userData = userData;
    this.resolveAsset = resolveAsset;
    this.concurrency = concurrency;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.queue = Promise.resolve(); // one job at a time in the worker (each job is parallel inside)
  }

  runtime() { return graphicsRuntime(this.userData); }

  bundleStamp() {
    const rt = this.runtime();
    try { return rt.bundle ? String(fs.statSync(path.join(rt.bundle, "bundle.js")).mtimeMs) : ""; } catch { return ""; }
  }

  start() {
    if (this.child) return this.child;
    const rt = this.runtime();
    if (!rt.ready) throw Object.assign(new Error(`graphics runtime missing: ${rt.missing.join(", ")}`), { code: "GRAPHICS_RUNTIME", missing: rt.missing });
    const isElectron = !!process.versions.electron;
    this.child = fork(path.join(HERE, "renderWorker.js"), [], {
      execPath: process.execPath, stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, ...(isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    });
    let stderr = "";
    this.child.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    this.child.on("message", (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress !== undefined) { p.onProgress?.(m.progress); return; }
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { stack: m.error.stack })); else p.resolve(m.result);
    });
    this.child.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`graphics worker exited (${code}) ${stderr}`));
      this.pending.clear();
      this.child = null;
    });
    this.send("config", { browser: rt.browser, bundle: rt.bundle, binaries: binariesDir(), concurrency: this.concurrency });
    return this.child;
  }

  send(cmd, job, onProgress) {
    const child = this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, onProgress }); child.send({ id, cmd, job }); });
  }

  /** The files a job's pictures point to: { reference: path } (only these are served to the browser). */
  assetsOf(params) {
    const out = {};
    for (const ref of assetRefs(params)) {
      const file = /^media:/i.test(ref) ? this.resolveAsset(ref) : ref;
      if (file && fs.existsSync(file)) out[ref] = file;
    }
    return out;
  }

  /** Render one job to a transparent clip (cached). Returns the file path. */
  renderJob(job, { onProgress, force = false } = {}) {
    const out = job.out || path.join(this.cacheDir, `${jobKey(job, this.bundleStamp())}.${job.codec && job.codec !== "prores" ? "mp4" : "mov"}`);
    if (!force && !job.out && fs.existsSync(out) && fs.statSync(out).size > 0) return Promise.resolve(out);
    const run = () => this.send("render", { ...job, out: `${out}.part.${job.codec && job.codec !== "prores" ? "mp4" : "mov"}`, assets: this.assetsOf(job.params || job.props) }, onProgress)
      .then((r) => { fs.renameSync(r.out, out); return out; });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** A transparent PNG of one frame of a job. */
  still(job, frame, out) {
    const run = () => this.send("still", { ...job, frame, out, assets: this.assetsOf(job.params || job.props) }).then((r) => r.out);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Render every Remotion graphic of a timeline for an export: { segId: file }. onProgress(0..1) over all of them.
   * Segments outside `range` ({ startUs, endUs }) are skipped.
   */
  async renderTimeline(tl, { width, height, fps, range = null, onProgress = () => {}, isCancelled = () => false } = {}) {
    const segs = remotionSegments(tl).filter(({ seg }) => !range || (seg.start < range.endUs && seg.start + seg.duration > range.startUs));
    const jobs = segs.map((x) => ({ segId: x.seg.id, job: segmentJob(x, { width, height, fps }) }));
    const total = jobs.reduce((a, j) => a + j.job.durationInFrames, 0) || 1;
    let done = 0;
    const out = {};
    for (const { segId, job } of jobs) {
      if (isCancelled()) throw Object.assign(new Error("cancelled"), { messageKey: "err.cancelled" });
      out[segId] = await this.renderJob(job, { onProgress: (p) => onProgress((done + p * job.durationInFrames) / total) });
      done += job.durationInFrames;
      onProgress(done / total);
    }
    return out;
  }

  /** Remove cached clips not used for `days` days. */
  prune(days = 7) {
    if (!this.cacheDir || !fs.existsSync(this.cacheDir)) return 0;
    const cut = Date.now() - days * 86_400_000;
    let n = 0;
    for (const f of fs.readdirSync(this.cacheDir)) {
      const p = path.join(this.cacheDir, f);
      try { if (fs.statSync(p).atimeMs < cut) { fs.rmSync(p, { force: true }); n++; } } catch { /* in use */ }
    }
    return n;
  }

  async close() {
    if (!this.child) return;
    try { await Promise.race([this.send("close"), new Promise((r) => setTimeout(r, 3000))]); } catch { /* already gone */ }
    this.child?.kill();
    this.child = null;
  }
}
