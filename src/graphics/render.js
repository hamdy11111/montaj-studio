// The graphics layer seen from the app: turns the Remotion graphics of a timeline into transparent clips that the
// exporter overlays like any other layer (core/exportGraph.js reads a .mov overlay as alpha video from the segment
// start, padded back to the full frame when only a band was rendered). Rendering runs in renderWorker.js (one child
// process, one browser, reused). Speed comes from three things, measured in tests/bench:
//   - only a band of the frame is rendered (core/graphicsKit.js kitCrop) — the browser's cost grows with the pixels;
//     a band whose drawing touches its edge is rendered again on the whole frame, so nothing is ever cut off
//   - the graphics missing from the cache are rendered together, one browser render per band height ("Sheet":
//     one graphic after another), then cut per graphic by stream copy (ProRes frames are all key frames)
//   - identical graphics (template, parameters, pack, size, rate, length) are rendered once and cached
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { KIT_TEMPLATES, kitParams, kitCrop } from "../core/graphicsKit.js";
import { graphicsRuntime } from "./setup.js";
import { binaries, run } from "../services/ffmpeg.js";
import { decodeAlpha, ALPHA_ON } from "./measure.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const US = 1_000_000;
const require = createRequire(import.meta.url);
const unpacked = (p) => p.replace(/\.asar([\\/])/i, ".asar.unpacked$1");

/** Folder of Remotion's compositor + ffmpeg binaries (outside the asar in the packaged app). */
export function binariesDir() {
  try { return unpacked(path.dirname(require.resolve("@remotion/compositor-win32-x64-msvc/package.json"))); } catch { return null; }
}

/** Remotion graphic segments of a timeline: [{ seg, track, template, params, pack }]. */
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

/** Render job of one graphic segment at an output size and rate (crop: the band to render, null = whole frame). */
export function segmentJob({ seg, template, params, pack }, { width, height, fps }) {
  const P = kitParams(template, params);
  return { template, params: P, pack, width, height, fps, durationInFrames: Math.max(1, Math.round((seg.duration / US) * fps)), crop: kitCrop(template, P, width, height) };
}

/** Cache key of a job (and of the bundle it is rendered with: a rebuilt bundle renders again). */
export function jobKey(job, bundleStamp = "") {
  const h = crypto.createHash("sha1");
  h.update(JSON.stringify([job.template, job.params, job.pack, job.width, job.height, job.fps, job.durationInFrames, job.crop || null, bundleStamp]));
  return h.digest("hex").slice(0, 20);
}

/**
 * Render cost model (measured on the i9-13900K, tests/bench): a frame costs about FRAME_MS + ROW_MS × band height
 * (1080×1920: 45 ms, 1080×480: 15 ms) and each browser render adds START_MS (tabs, bundle, fonts).
 */
export const COST = { FRAME_MS: 5, ROW_MS: 0.0208, START_MS: 1500 };

/**
 * Groups for one browser render each: whole-frame jobs together; banded jobs sorted by band height and cut into
 * runs so that the total cost (each run rendered at its tallest band) is the lowest (exact, by dynamic programming).
 */
export function groupJobs(jobs, cost = COST) {
  const full = jobs.filter((j) => !j.crop), banded = jobs.filter((j) => j.crop).sort((a, b) => b.crop.h - a.crop.h);
  const groups = full.length ? [{ h: null, jobs: full }] : [];
  const n = banded.length, best = new Array(n + 1).fill(Infinity), cut = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    let frames = 0;
    for (let k = i; k >= 1; k--) { // run banded[k-1 .. i-1], rendered at banded[k-1]'s (tallest) band
      frames += banded[k - 1].durationInFrames;
      const c = best[k - 1] + cost.START_MS + frames * (cost.FRAME_MS + cost.ROW_MS * banded[k - 1].crop.h);
      if (c < best[i]) { best[i] = c; cut[i] = k - 1; }
    }
  }
  const runs = [];
  for (let i = n; i > 0; i = cut[i]) runs.unshift(banded.slice(cut[i], i));
  for (const r of runs) groups.push({ h: r[0].crop.h, jobs: r });
  return groups;
}

/** Where a job sits in its group's band: the band (group height) centred on the job's own band, inside the frame. */
export function bandOf(job, groupH) {
  if (!groupH) return { x: 0, y: 0, w: job.width, h: job.height };
  const y = Math.max(0, Math.min(job.height - groupH, job.crop.y - Math.floor((groupH - job.crop.h) / 4) * 2));
  return { x: 0, y, w: job.width, h: groupH };
}

/** Does anything drawn touch a band edge that is inside the frame (the band was too small)? */
export function touchesEdge({ frames, w, h }, band, frameH, rows = 2) {
  const top = band.y > 0, bottom = band.y + band.h < frameH;
  for (const a of frames) {
    for (let r = 0; r < rows; r++) for (let x = 0; x < w; x++) {
      if (top && a[r * w + x] > ALPHA_ON) return true;
      if (bottom && a[(h - 1 - r) * w + x] > ALPHA_ON) return true;
    }
  }
  return false;
}

export class GraphicsRenderer {
  /**
   * @param {object} o
   * @param {string} o.cacheDir           where rendered clips are kept (reused while the graphic is unchanged)
   * @param {string} [o.userData]         the app's data folder (the browser may be installed there)
   * @param {(ref: string) => string|null} [o.resolveAsset]  media://… → file path
   * @param {number} [o.concurrency]      browser tabs rendering in parallel
   * @param {boolean} [o.bands]           render bands instead of whole frames (default true)
   */
  constructor({ cacheDir, userData = null, resolveAsset = () => null, concurrency, bands = true } = {}) {
    this.cacheDir = cacheDir;
    this.userData = userData;
    this.resolveAsset = resolveAsset;
    this.concurrency = concurrency;
    this.bands = bands;
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

  keyOf(job) { return jobKey(job, this.bundleStamp()); }

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

  /** Run in the worker one after another (each render is parallel inside). */
  serial(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
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

  /** Cached clip of a job: { path, x, y, w, h } (where its band sits in the frame), or null. */
  cached(job) {
    const base = path.join(this.cacheDir, this.keyOf(job));
    try {
      const meta = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
      if (fs.statSync(`${base}.mov`).size > 0) return { path: `${base}.mov`, ...meta };
    } catch { /* not rendered */ }
    return null;
  }

  /**
   * Render jobs of one size and rate: grouped by band, one browser render per group, cut per job by stream copy,
   * checked for drawing at a band edge (those are rendered again on the whole frame, under the same cache key).
   * Returns { path, x, y, w, h } per job, in order.
   */
  async renderJobs(jobs, { onProgress = () => {} } = {}) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const work = jobs.map((j) => ({ job: j, run: this.bands ? j : { ...j, crop: null } }));
    const total = work.reduce((a, w) => a + w.job.durationInFrames, 0) || 1;
    let done = 0;
    const results = new Map();
    for (const g of groupJobs(work.map((w) => w.run))) {
      const n = g.jobs.reduce((a, j) => a + j.durationInFrames, 0);
      const files = await this.renderGroup(g, (p) => onProgress(Math.min(0.99, (done + p * n) / total)), g.jobs.map((j) => this.keyOf(work.find((w) => w.run === j).job)));
      g.jobs.forEach((j, i) => results.set(j, files[i]));
      done += n;
    }
    for (const w of work) {
      const r = results.get(w.run);
      if (!w.run.crop) continue;
      const alpha = await decodeAlpha(r.path, { w: 216, h: Math.max(8, Math.round((216 * r.h) / r.w / 2) * 2) });
      if (touchesEdge(alpha, r, w.job.height)) results.set(w.run, (await this.renderGroup({ h: null, jobs: [{ ...w.run, crop: null }] }, () => {}, [this.keyOf(w.job)]))[0]);
    }
    onProgress(1);
    return work.map((w) => results.get(w.run));
  }

  /** One browser render of a group ("Sheet"), cut per job; keys: the cache key of each job. */
  async renderGroup(group, onProgress, keys) {
    const { width, height, fps } = group.jobs[0];
    let from = 0;
    const items = group.jobs.map((j) => { const it = { template: j.template, params: j.params, from, durationInFrames: j.durationInFrames, crop: group.h ? bandOf(j, group.h) : null }; from += j.durationInFrames; return it; });
    const packed = path.join(this.cacheDir, `pack-${crypto.randomBytes(6).toString("hex")}.mov`);
    const job = { composition: "Sheet", props: { items, pack: group.jobs[0].pack, frameWidth: width, frameHeight: height }, width, height: group.h || height, fps, durationInFrames: from, out: `${packed}.part.mov`, assets: this.assetsOf(group.jobs.map((j) => j.params)) };
    await this.serial(() => this.send("render", job, onProgress));
    fs.renameSync(job.out, packed);
    try {
      const out = [];
      for (const [i, j] of group.jobs.entries()) {
        const base = path.join(this.cacheDir, keys[i]), part = `${base}.part.mov`;
        if (group.jobs.length === 1) fs.copyFileSync(packed, part);
        else await run(binaries().ffmpeg, ["-hide_banner", "-v", "error", "-y", "-ss", (items[i].from / fps).toFixed(6), "-i", packed, "-frames:v", String(j.durationInFrames), "-c", "copy", "-an", part], { timeoutMs: 300_000 });
        fs.renameSync(part, `${base}.mov`);
        const b = items[i].crop || { x: 0, y: 0, w: width, h: height };
        fs.writeFileSync(`${base}.json`, JSON.stringify(b));
        out.push({ path: `${base}.mov`, ...b });
      }
      return out;
    } finally { fs.rmSync(packed, { force: true }); }
  }

  /** One job → its clip (cached): { path, x, y, w, h }. */
  async renderJob(job, { onProgress, force = false } = {}) {
    if (!force) { const c = this.cached(job); if (c) return c; }
    return (await this.renderJobs([job], { onProgress }))[0];
  }

  /** Render any composition to a file (sample videos): { composition, props, width, height, fps, durationInFrames, out, codec }. */
  renderTo(job, { onProgress } = {}) {
    return this.serial(() => this.send("render", { ...job, assets: this.assetsOf(job.props) }, onProgress)).then((r) => r.out);
  }

  /** A transparent PNG of one frame of a job (whole frame). */
  still(job, frame, out) {
    return this.serial(() => this.send("still", { ...job, crop: undefined, frame, out, assets: this.assetsOf(job.params || job.props) }).then((r) => r.out));
  }

  /**
   * Every Remotion graphic of a timeline for an export: { segId: { path, x, y, w, h } }. onProgress(0..1).
   * Segments outside `range` ({ startUs, endUs }) are skipped; cached graphics are reused, the others rendered together.
   */
  async renderTimeline(tl, { width, height, fps, range = null, onProgress = () => {}, isCancelled = () => false } = {}) {
    const segs = remotionSegments(tl).filter(({ seg }) => !range || (seg.start < range.endUs && seg.start + seg.duration > range.startUs));
    const out = {}, missing = [], same = new Map();
    for (const x of segs) {
      const job = segmentJob(x, { width, height, fps });
      const c = this.cached(job);
      if (c) { out[x.seg.id] = c; continue; }
      const k = this.keyOf(job);
      if (same.has(k)) { same.get(k).ids.push(x.seg.id); continue; } // the same graphic twice: rendered once
      same.set(k, { job, ids: [x.seg.id] });
      missing.push(k);
    }
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { messageKey: "err.cancelled" });
    if (missing.length) {
      const files = await this.renderJobs(missing.map((k) => same.get(k).job), { onProgress });
      missing.forEach((k, i) => { for (const id of same.get(k).ids) out[id] = files[i]; });
    }
    onProgress(1);
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
