// Best take by performance (Phase 5): for every retake group of a media file (core/speech.js retakeGroups), measure
// each take (services/takes/features.js + workers/take_features.py), score the takes against each other
// (core/takeScore.js), send close calls to the AI judge (workers/judge.py, both orders) when asked, and return the
// `montaj.takes/1` result the director consumes (see HANDOFF.md). Also: match a published video to its raw to learn
// which take the user kept (workers/fingerprint.py + picks.js).
//
// Inputs it reads, never edits: the words (any transcript, source µs), perception's event timeline of the media
// (phase 4: speaker, emotion, laughter, faces — optional), the user's picks / learned weights (PickStore).
// Results are cached per media content hash + takes + stages, so a second run costs nothing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { retakeGroups } from "../../core/speech.js";
import { POLICY } from "../../core/policy.js";
import { scoreGroup, applyJudge, takesResult, weightsFor, typeFromName } from "../../core/takeScore.js";
import { timelineSignals, takeFeatures } from "./features.js";
import { PickStore, takeFromCoverage, rawSpansOf } from "./picks.js";
import { fileHash } from "../perception/perceptionService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS = path.join(HERE, "workers");
const REPO = path.resolve(HERE, "..", "..", "..");
const US = 1e6;
export const FEATURE_STAGES = Object.freeze(["prosody", "dnsmos", "face", "gaze", "video"]);
// Bump when workers/take_features.py measures differently, so cached measurements are made again.
export const FEATURES_VERSION = 2;

const venvPython = (runtime, name) => path.join(runtime, name, ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

/** The runtime folder with the `takes` venv: an explicit one, the app's data folder, or the project's runtime/. */
export function findRuntime({ runtimeDir = null, userData = null } = {}) {
  const dirs = [runtimeDir, userData && path.join(userData, "runtime"), path.join(REPO, "runtime")].filter(Boolean);
  return dirs.find((d) => fs.existsSync(venvPython(d, "takes"))) || dirs[0] || path.join(REPO, "runtime");
}

// The media content key is perception's own fileHash, so both caches (and a pick's media.hash) name a file the same way.
export { fileHash };

/** Words of a perception timeline in the transcript shape of core/speech.js (µs, conf). */
export function wordsFromTimeline(tl) {
  return (tl?.events || []).filter((e) => e.type === "word").map((e) => ({ text: e.text, startUs: Math.round(e.t0 * US), endUs: Math.round(e.t1 * US), conf: e.confidence, speaker: e.speaker }));
}

/** The jobs the feature worker needs: one per take, with its words (s) and how to find the speaker's face. */
export function workerTakes(groups, words, tl) {
  const out = [];
  groups.forEach((g, gi) => g.takes.forEach((t, ti) => {
    const t0 = t.fromUs / US, t1 = t.toUs / US;
    const next = g.takes[ti + 1] ? g.takes[ti + 1].fromUs / US : null;
    const part = timelineSignals(tl, t0, t1, { next });
    const faceMode = !tl || !(tl.events || []).some((e) => e.type === "face_track") ? "largest" : part.entity ? "entity" : "none";
    out.push({ id: `${gi}.${ti}`, t0, t1, words: words.slice(t.w0, t.w1 + 1).map((w) => [w.startUs / US, w.endUs / US]), faceBoxes: part.faceBoxes, faceMode, part });
  }));
  return out;
}

function runWorker(python, script, job, { outFile, onProgress, log = () => {}, signal, timeoutMs = 3600_000 }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const jobFile = `${outFile}.job.json`;
  fs.writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-X", "utf8", script, "--job", jobFile, "--out", outFile], {
      cwd: WORKERS, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", GLOG_minloglevel: "2" },
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
      for (const l of parts) { const m = /^PROGRESS ([\d.]+)/.exec(l); if (m) onProgress?.(Number(m[1])); else if (l.trim() && !/^[WI]0000 /.test(l)) log(l); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${path.basename(script)}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      if (code !== 0 || !fs.existsSync(outFile)) return reject(new Error(`${path.basename(script)} failed (${code}): ${tail.slice(-2500)}`));
      try { resolve(JSON.parse(fs.readFileSync(outFile, "utf8"))); } catch (e) { reject(new Error(`${path.basename(script)}: bad result: ${e.message}`)); }
      try { fs.rmSync(jobFile, { force: true }); } catch { /* kept */ }
    });
  });
}

/**
 * The AI judge used on close calls: "qwen3-omni" | "qwen2.5-omni". Round 4 asked both the same 8 pairs in both orders
 * (5 real sentences clean vs degraded, a false start vs the full take, two without a right answer): Qwen2.5-Omni-7B
 * answered "B" 15 times of 16 (consistent 1/8, right 1/6); Qwen3-Omni-30B-A3B was consistent on 7/8 and right on 6/6.
 */
export const JUDGE_ENGINE = "qwen3-omni";

/** The judge model folder: runtime/models/takes/qwen2.5-omni-7b, else the local Hugging Face cache (never downloaded). */
export function judgeModelPath(models, home = process.env.USERPROFILE || process.env.HOME || "") {
  const own = path.join(models, "qwen2.5-omni-7b");
  if (fs.existsSync(path.join(own, "config.json"))) return own;
  const snaps = path.join(process.env.HF_HOME || path.join(home, ".cache", "huggingface"), "hub", "models--Qwen--Qwen2.5-Omni-7B", "snapshots");
  if (!fs.existsSync(snaps)) return null;
  const s = fs.readdirSync(snaps).map((d) => path.join(snaps, d)).find((d) => fs.existsSync(path.join(d, "config.json")) && fs.existsSync(path.join(d, "model.safetensors.index.json")));
  return s || null;
}

export class TakeService {
  /**
   * runtimeDir/userData: where the `takes` venv and models/takes are (found when omitted). cacheDir: feature cache.
   * storeDir: the user's picks + learned weights. perception: a PerceptionService (for its cached timelines), optional.
   * gpuLock: { acquire(name) → release } (perception's makeGpuLock shape) — taken for the judge only.
   */
  constructor({ runtimeDir = null, userData = null, cacheDir = null, storeDir = null, ffmpeg, ffprobe, perception = null, gpuLock = null, log = () => {} } = {}) {
    this.runtime = findRuntime({ runtimeDir, userData });
    this.models = path.join(this.runtime, "models", "takes");
    this.cacheDir = cacheDir || path.join(this.runtime, "takes-cache");
    this.picks = new PickStore(storeDir || path.join(userData || this.runtime, "takes-picks"));
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.perception = perception;
    this.gpuLock = gpuLock || { acquire: async () => () => {} };
    this.log = log;
  }

  /**
   * The judge's worker and its arguments, or null when that engine is not installed: "qwen3-omni" (perception's
   * Qwen3-Omni GGUF on llama.cpp, judge_omni.py) or "qwen2.5-omni" (Qwen2.5-Omni-7B on transformers, judge.py).
   */
  judgeJob(engine = JUDGE_ENGINE) {
    if (engine === "qwen3-omni") {
      const models = path.join(this.runtime, "models", "perception"), llama = path.join(this.runtime, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server");
      const ok = [llama, path.join(models, "qwen3-omni-30b-a3b", "Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf"), path.join(models, "qwen3-omni-30b-a3b", "mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf")].every((p) => fs.existsSync(p));
      return ok ? { script: "judge_omni.py", args: { llama, modelsDir: models, frames: 6, side: 448 } } : null;
    }
    const mp = judgeModelPath(this.models);
    return mp ? { script: "judge.py", args: { modelPath: mp } } : null;
  }

  status() {
    const has = (...p) => fs.existsSync(path.join(this.models, ...p));
    return {
      runtime: this.runtime, env: fs.existsSync(venvPython(this.runtime, "takes")),
      models: { dnsmos: has("dnsmos", "sig_bak_ovr.onnx"), mediapipe: has("mediapipe", "face_landmarker.task"), libreface: has("libreface", "LibreFace_AU_Encoder.onnx"), l2cs: has("l2cs", "l2cs_gaze360_resnet50.safetensors"), judge: !!this.judgeJob() },
      judgeEngine: JUDGE_ENGINE,
    };
  }

  /** Stages the installed runtime can run (a missing model drops its stage; its signals stay null). */
  stagesAvailable(wanted = FEATURE_STAGES) {
    const s = this.status();
    if (!s.env) return [];
    return wanted.filter((st) => ({ prosody: true, dnsmos: s.models.dnsmos, face: s.models.mediapipe && s.models.libreface, gaze: s.models.mediapipe && s.models.l2cs, video: true })[st]);
  }

  /**
   * The best take of every retake group of a media file. Returns the montaj.takes/1 result.
   * o: { media (path), words (µs; default: the timeline's), groups (default: retakeGroups(words) with the director's
   *   POLICY), timeline (default: perception's cached one), type (content type; default from the file/folder name),
   *   stages, judge (true: ask the AI judge on close calls), weights (override), onProgress, signal }
   */
  async analyze(o) {
    const t0 = Date.now();
    const media = o.media;
    if (!media || !fs.existsSync(media)) throw new Error(`file not found: ${media}`);
    const hash = fileHash(media);
    const tl = o.timeline !== undefined ? o.timeline : this.perception?.cached?.(media) || null;
    const words = o.words || wordsFromTimeline(tl);
    const type = o.type || typeFromName(`${path.basename(path.dirname(path.dirname(media)))} ${path.basename(media)}`);
    const groups = o.groups || retakeGroups(words, { withinUs: POLICY.retakes.within * US, falseStartWithinUs: POLICY.retakes.falseStart * US });
    const learned = this.picks.learned();
    const weights = o.weights || weightsFor(type, learned);
    const weightsSource = o.weights ? "given" : learned?.[type]?.learned ? `learned from ${learned[type].examples} pick(s)` : "default";
    const missing = [];
    if (!tl) missing.push("no perception timeline: emotion, laughter and the speaker's face are not known (the largest face is used)");
    const mediaInfo = { path: media, name: path.basename(media), hash };
    if (!groups.length) return takesResult({ media: mediaInfo, type, weightsSource, groups: [], missing, timings: { ms: Date.now() - t0 } });

    const jobs = workerTakes(groups, words, tl);
    const stages = this.stagesAvailable(o.stages || FEATURE_STAGES);
    for (const st of FEATURE_STAGES) if (!stages.includes(st)) missing.push(`${st}: not installed or not asked`);
    let worker = { takes: {} };
    if (stages.length) {
      const key = crypto.createHash("sha1").update(JSON.stringify({ v: FEATURES_VERSION, hash, stages, takes: jobs.map((j) => [j.t0, j.t1, j.faceMode, j.faceBoxes.length]) })).digest("hex").slice(0, 16);
      const outFile = path.join(this.cacheDir, hash, `features-${key}.json`);
      if (fs.existsSync(outFile)) worker = JSON.parse(fs.readFileSync(outFile, "utf8"));
      else {
        worker = await runWorker(venvPython(this.runtime, "takes"), path.join(WORKERS, "take_features.py"),
          { media, ffmpeg: this.ffmpeg, ffprobe: this.ffprobe, modelsDir: this.models, stages, takes: jobs.map(({ part, ...j }) => j) },
          { outFile, onProgress: (p) => o.onProgress?.({ stage: "features", progress: p }), log: (l) => this.log(`[takes] ${l}`), signal: o.signal });
      }
    }
    let k = 0;
    const scored = groups.map((g) => {
      const feats = g.takes.map((t) => {
        const j = jobs[k++];
        return takeFeatures({ words, w0: t.w0, w1: t.w1, tlPart: j.part, worker: worker.takes?.[j.id] || null });
      });
      const s = scoreGroup(g, feats, { type, weights });
      s.takes.forEach((t, i) => { t.info = feats[i].info; });
      return s;
    });
    let judged = scored;
    const close = scored.map((g, i) => ({ g, i })).filter((x) => x.g.closeCall);
    if (o.judge && close.length) {
      const engine = o.judgeEngine || JUDGE_ENGINE;
      const job = this.judgeJob(engine);
      if (!job) missing.push(`judge: ${engine} not installed`);
      else {
        const pairs = close.map(({ g, i }) => ({ id: String(i), a: { t0: g.takes[g.kept].fromUs / US, t1: g.takes[g.kept].toUs / US }, b: { t0: g.takes[g.runnerUp].fromUs / US, t1: g.takes[g.runnerUp].toUs / US }, type, line: String(g.line).slice(0, 120) }));
        const release = await this.gpuLock.acquire(`takes-judge-${hash.slice(0, 8)}`);
        let res;
        try {
          res = await runWorker(venvPython(this.runtime, "takes"), path.join(WORKERS, job.script), { media, ffmpeg: this.ffmpeg, pairs, ...job.args, workDir: path.join(this.cacheDir, hash, "judge") },
            { outFile: path.join(this.cacheDir, hash, `judge-${Date.now()}.json`), onProgress: (p) => o.onProgress?.({ stage: "judge", progress: p }), log: (l) => this.log(`[takes-judge] ${l}`), signal: o.signal });
        } finally { await Promise.resolve(release()).catch(() => {}); }
        judged = scored.map((g, i) => (res.answers?.[String(i)] ? applyJudge(g, { ...res.answers[String(i)], model: res.model }) : g));
      }
    }
    return takesResult({ media: mediaInfo, type, weightsSource, groups: judged, missing, timings: { ms: Date.now() - t0, workerMs: worker.ms ?? null } });
  }

  /**
   * Learns which take the user kept from a video they published: fingerprint-matches it to the raw file(s), then for
   * every group of each raw's result the take the published cut used is stored as a pick. results: { [rawPath]: takes result }.
   * Returns { match, picks: [{ media, group, picked, coverage }] }.
   */
  async learnFromPublished(published, results, { signal, min = 0.6 } = {}) {
    const raws = Object.keys(results);
    const match = await runWorker(venvPython(this.runtime, "takes"), path.join(WORKERS, "fingerprint.py"), { published, raw: raws, ffmpeg: this.ffmpeg },
      { outFile: path.join(this.cacheDir, "published", `${fileHash(published)}.json`), log: (l) => this.log(`[takes-fp] ${l}`), signal });
    const picks = [];
    for (const raw of raws) {
      const spans = rawSpansOf(match, raw);
      for (const g of results[raw].groups || []) {
        const c = takeFromCoverage(g, spans, { min });
        if (c.picked !== null) this.picks.add({ media: results[raw].media, g, picked: c.picked, source: "published", note: path.basename(published) });
        picks.push({ media: raw, line: g.line, picked: c.picked, coverage: c.coverage, both: c.both });
      }
    }
    return { match, picks };
  }
}
