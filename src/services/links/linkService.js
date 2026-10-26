// Cause ↔ reaction links and moment roles for one media file (Phase 6): reads the perception event timeline (never
// re-runs perception), finds the sudden silences in its cached 16 kHz sound, proposes the candidates
// (src/core/causeLinks.js), asks the vision model to check them (workers/verify_links.py, under the shared GPU lock),
// gives every moment its role (src/core/momentRoles.js) and writes one document, schema "montaj.links/1".
//
// The model's answers are cached per media hash + the exact questions, so changing a knob re-scores the links
// without the GPU; the final document is written to <cache>/<hash>/links.json (and by the CLI next to its output).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildLinks, verifyQueries, controlQueries, mergeAnswers, envelopeDb, suddenSilences, LINKS_SCHEMA } from "../../core/causeLinks.js";
import { assignRoles, roleShares } from "../../core/momentRoles.js";
import { findRuntime, makeGpuLock, fileHash } from "../perception/perceptionService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const WORKERS = path.join(HERE, "workers");
export const VERIFY_ENGINES = Object.freeze(["qwen3.6", "qwen3-omni", "both", "none"]);
const VERSION = 2; // 2: grounded prompt, candidates in time order, decoy controls

const venvPython = (runtime) => path.join(runtime, "perception", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

/** 16-bit PCM samples of a WAV file (mono expected; the first channel otherwise). {samples, sampleRate}. */
export function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(p + 10), sampleRate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === "data") {
      if (!fmt || fmt.bits !== 16) throw new Error("only 16-bit PCM WAV");
      const n = Math.floor(Math.min(size, buf.length - p - 8) / 2 / fmt.channels);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(p + 8 + i * 2 * fmt.channels);
      return { samples, sampleRate: fmt.sampleRate };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error("WAV without data");
}

/**
 * The worker's answers split into the real questions' and the decoys', each pinned to the causes its letters meant
 * (_map) and its cause time taken from the frame it named when it named one (the grounded answer).
 */
export function splitAnswers(all, queries, controls) {
  const pin = (q) => {
    const a = all?.[q.reaction];
    if (!a) return null;
    const f = Number(a.cause_frame);
    return { ...a, cause_time: Number.isFinite(f) && a.cause_frame !== "none" ? f : a.cause_time, _map: Object.fromEntries(q.candidates.map((c) => [c.key, c.cause])) };
  };
  const pick = (list) => Object.fromEntries(list.map((q) => [q.reaction, pin(q)]).filter(([, a]) => a));
  return { answers: pick(queries), controlAnswers: pick(controls) };
}

/** Short stable key of a JSON value. */
const keyOf = (v) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 12);

function runWorker(python, script, job, { signal, onProgress, log = () => {}, outFile, timeoutMs = 2 * 3600_000 }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const jobFile = `${outFile}.job.json`;
  fs.writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-X", "utf8", script, "--job", jobFile, "--out", outFile], {
      cwd: path.dirname(script), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", HF_HUB_OFFLINE: "1" },
    });
    let tail = "", line = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    signal?.addEventListener("abort", () => child.kill(), { once: true });
    child.stdout.on("data", (d) => { tail = (tail + d.toString("utf8")).slice(-4000); });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      tail = (tail + s).slice(-6000);
      line += s;
      const parts = line.split(/\r?\n/);
      line = parts.pop();
      for (const l of parts) { const m = /^PROGRESS ([\d.]+)/.exec(l); if (m) onProgress?.(Number(m[1])); else if (l.trim()) log(l); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${path.basename(script)}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      if (code !== 0 || !fs.existsSync(outFile)) return reject(new Error(`${path.basename(script)} failed (${code}): ${tail.slice(-2500)}`));
      try { resolve(JSON.parse(fs.readFileSync(outFile, "utf8"))); } catch (e) { reject(new Error(`bad result: ${e.message}`)); }
      try { fs.rmSync(jobFile, { force: true }); } catch { /* kept */ }
    });
  });
}

function runCmd(bin, args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => execFile(bin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 2 ** 20 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr).slice(-1500) || err.message)) : resolve())));
}

export class LinkService {
  /**
   * runtimeDir: the folder with the perception venv, llama/ and models/perception/ (found like perception's).
   * cacheDir: links results per media hash. perceptionCache: where perception keeps its per-file folders (the WAV).
   * perception: a PerceptionService (optional) to get a media file's cached timeline.
   */
  constructor({ runtimeDir = null, userData = null, cacheDir = null, perceptionCache = null, perception = null, ffmpeg = null, gpuLock = makeGpuLock({ name: "links" }), log = () => {} } = {}) {
    this.runtime = findRuntime({ runtimeDir, userData });
    this.models = path.join(this.runtime, "models", "perception");
    this.cacheDir = cacheDir || path.join(this.runtime, "links-cache");
    this.perceptionCache = perceptionCache || perception?.cacheDir || path.join(this.runtime, "perception-cache");
    this.perception = perception;
    this.ffmpeg = ffmpeg;
    this.gpuLock = gpuLock;
    this.log = log;
  }

  status() {
    const llama = path.join(this.runtime, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server");
    return {
      runtime: this.runtime, env: fs.existsSync(venvPython(this.runtime)), llama: fs.existsSync(llama),
      engines: {
        "qwen3.6": fs.existsSync(path.join(this.models, "qwen3.6-35b-a3b", "Qwen3.6-35B-A3B-UD-IQ4_XS.gguf")),
        "qwen3-omni": ["Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf", "mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf"].every((f) => fs.existsSync(path.join(this.models, "qwen3-omni-30b-a3b", f))),
      },
    };
  }

  /** A timeline from a .timeline.json path, a timeline object, or a media file perception has analysed. */
  timelineOf(src) {
    if (src && typeof src === "object") return src;
    if (/\.json$/i.test(src)) return JSON.parse(fs.readFileSync(src, "utf8"));
    const tl = this.perception?.cached(src) ?? (() => { const f = path.join(this.perceptionCache, fileHash(src), "timeline.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; })();
    if (!tl) throw new Error(`no perception timeline for ${src}: run perception first`);
    return tl;
  }

  /** Sudden silences from the perception cache's 16 kHz WAV (made here from the media when it is missing). */
  async silences(tl) {
    const hash = tl.media?.hash;
    const cands = [hash && path.join(this.perceptionCache, hash, "audio16k.wav"), tl.artifacts?.dir && path.join(tl.artifacts.dir, "audio16k.wav"), hash && path.join(this.cacheDir, hash, "audio16k.wav")].filter(Boolean);
    let wav = cands.find((f) => fs.existsSync(f));
    if (!wav && tl.media?.hasAudio && this.ffmpeg && fs.existsSync(tl.media.path)) {
      wav = path.join(this.cacheDir, hash || "x", "audio16k.wav");
      fs.mkdirSync(path.dirname(wav), { recursive: true });
      await runCmd(this.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", tl.media.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    }
    if (!wav) return { list: [], wav: null };
    const { samples, sampleRate } = readWav(fs.readFileSync(wav));
    return { list: suddenSilences(envelopeDb(samples, sampleRate, 0.1)), wav };
  }

  /**
   * One engine's answers to the questions (+ decoys), from the cache or from the worker: frames on the CPU first, then
   * the model under the GPU lock. {answers, controlAnswers, report}; answers null when the engine is not installed.
   */
  async #ask(engine, tl, dir, queries, controls, { side, refresh, signal, onProgress, from = 0, to = 1 }) {
    const st = this.status();
    const ansFile = path.join(dir, `answers.${keyOf([VERSION, engine, queries, controls])}.json`);
    if (fs.existsSync(ansFile) && !refresh) {
      const r = JSON.parse(fs.readFileSync(ansFile, "utf8"));
      return { answers: r.answers, controlAnswers: r.controls ?? null, report: { ...r.report, cached: true } };
    }
    if (!st.engines[engine] || !st.llama || !st.env) return { answers: null, controlAnswers: null, report: { engine, available: false, reason: `not installed (${JSON.stringify(st)})` } };
    const llama = path.join(this.runtime, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server");
    const job = { media: tl.media.path, ffmpeg: this.ffmpeg, llama, modelsDir: this.models, engine, queries: [...queries, ...controls], workDir: path.join(dir, "frames"), side };
    const script = path.join(WORKERS, "verify_links.py");
    const mid = from + 0.4 * (to - from);
    const wopts = (stage, a, b) => ({ signal, onProgress: (p) => onProgress?.(a + (b - a) * p), log: (l) => this.log(`[links ${engine} ${stage}] ${l}`), outFile: path.join(dir, `${engine}-${stage}-${Date.now()}.json`) });
    // The frames (and sound clips) on the CPU first — 4K phone video decodes slowly — outside the GPU lock.
    await runWorker(venvPython(this.runtime), script, { ...job, mode: "frames" }, wopts("frames", from, mid));
    const wait0 = Date.now();
    const release = await this.gpuLock.acquire(`links-${engine}-${(tl.media?.hash || "x").slice(0, 8)}`);
    const waitMs = Date.now() - wait0;
    try {
      const r = await runWorker(venvPython(this.runtime), script, job, wopts("verify", mid, to));
      const got = r.available ? splitAnswers(r.answers, queries, controls) : { answers: null, controlAnswers: null };
      const report = { engine, available: r.available, model: r.model, reason: r.reason ?? null, errors: r.errors, msPerReaction: r.ms, serverLoadS: r.serverLoadS, frames: r.frames, timing: r.timing, gpuWaitMs: waitMs };
      if (r.available) fs.writeFileSync(ansFile, JSON.stringify({ answers: got.answers, controls: got.controlAnswers, report }, null, 1));
      return { ...got, report };
    } finally { await Promise.resolve(release()).catch(() => {}); }
  }

  /**
   * The links document of one media. verify: "qwen3.6" (default: sees) | "qwen3-omni" (hears + sees fewer frames) |
   * "both" (each asked, answers merged by causeLinks.mergeAnswers) | "none". hint: the content type. refresh: ask the
   * model again even when its answers are cached. options: causeLinks knobs, plus `controls` (decoy questions, default
   * 6; 0 = none) and `side` (frame size, 448). Resolves with the document (also written to the cache).
   */
  async analyze(src, { verify = "qwen3.6", hint = null, refresh = false, options: { controls: nControls = 6, side = 448, ...options } = {}, onProgress, signal } = {}) {
    const t0 = Date.now();
    if (!VERIFY_ENGINES.includes(verify)) throw new Error(`unknown verify engine ${verify}`);
    const tl = this.timelineOf(src);
    const hash = tl.media?.hash || keyOf(tl.media?.path || "");
    const dir = path.join(this.cacheDir, hash);
    fs.mkdirSync(dir, { recursive: true });
    const sil = await this.silences(tl);
    const first = buildLinks(tl, { silences: sil.list, hint, ...options });
    const queries = verifyQueries(tl, first);
    const controls = nControls ? controlQueries(tl, first, { n: nControls }) : [];
    let answers = null, controlAnswers = null, report = { engine: verify, available: false, reason: verify === "none" ? "not asked" : null };
    if (verify !== "none" && queries.length) {
      const o = { side, refresh, signal, onProgress };
      if (verify === "both") {
        const v = await this.#ask("qwen3.6", tl, dir, queries, controls, { ...o, from: 0, to: 0.5 });
        const a = await this.#ask("qwen3-omni", tl, dir, queries, controls, { ...o, from: 0.5, to: 1 });
        answers = mergeAnswers(v.answers, a.answers);
        controlAnswers = mergeAnswers(v.controlAnswers, a.controlAnswers);
        report = { engine: "both", available: !!(v.answers || a.answers), vision: v.report, audio: a.report };
      } else ({ answers, controlAnswers, report } = await this.#ask(verify, tl, dir, queries, controls, o));
    }
    const doc = buildLinks(tl, { silences: sil.list, hint, answers, controls: controlAnswers, verify: { ...report, pairs: queries.reduce((s, q) => s + q.candidates.length, 0), questions: queries.length }, ...options });
    doc.moments = assignRoles(tl, doc);
    doc.report.roles = roleShares(doc.moments);
    doc.report.silences = { wav: sil.wav, count: sil.list.length };
    doc.report.ms = Date.now() - t0;
    // The last document (what cached() returns), and one per engine for comparing them.
    for (const f of ["links.json", `links.${verify}.json`]) fs.writeFileSync(path.join(dir, f), JSON.stringify(doc, null, 1));
    return doc;
  }

  /** The last links document made for this media (or timeline), or null. */
  cached(src) {
    try {
      const tl = this.timelineOf(src);
      const f = path.join(this.cacheDir, tl.media?.hash || "", "links.json");
      const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
      return d?.schema === LINKS_SCHEMA ? d : null;
    } catch { return null; }
  }
}
