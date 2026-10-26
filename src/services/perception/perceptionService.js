// The perception pipeline (Phase 4, «الإدراك»): runs the perception models on one media file, one after another,
// and writes ONE event timeline (timeline.js) for the later phases (best take, cause ↔ reaction, the director).
//
//   stage      runtime            model                                         GPU
//   words      runtime/asr        the speech engine (pluggable: NeMo Egyptian    the alignment (~2 GB)
//                                 today) + wav2vec2 Arabic forced alignment
//   speakers   runtime/perception pyannote speaker-diarization-community-1       ~1–2 GB
//   audio      runtime/perception PANNs Cnn14 (AudioSet tags), laughter-detection, ~1 GB
//                                 loudness / pitch spikes
//   emotion    runtime/perception emotion2vec+ large, per utterance              ~2 GB
//   shots      runtime/perception TransNetV2 shot boundaries                     < 1 GB
//   faces      runtime/perception InsightFace buffalo_l (SCRFD + ArcFace),        ~1–2 GB
//                                 AdaFace for poor light, tracks + identities
//   asd        runtime/perception LR-ASD (Light-ASD as the fast mode)             < 1 GB
//   vision     runtime/perception Qwen3.6-35B-A3B (llama.cpp, IQ4_XS + mmproj)    ~20 GB
//
// Every stage is its own Python process (the model's memory goes back when it ends) and takes the GPU lock for its
// run only, so other jobs on the shared card interleave and two heavy models are never loaded together. Results are
// cached per file content hash and per stage parameters: a second run reads them back, a changed option re-runs only
// the stages it touches (and the ones after them that read their output).
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimeline, speakerNames, wordsWithSpeakers, utterances, DEFAULTS as FUSE } from "./fuse.js";
import { nemoModel } from "../captionService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const WORKERS = path.join(HERE, "workers");
const ASR_DIR = path.join(HERE, "..", "asr");
const REPO = path.resolve(HERE, "..", "..", "..");

export const STAGES = Object.freeze(["words", "speakers", "audio", "emotion", "shots", "faces", "asd", "vision"]);
// Which stages read which earlier ones (a re-run of one makes these re-run too).
export const NEEDS = Object.freeze({ words: [], speakers: [], audio: [], emotion: ["words", "speakers"], shots: [], faces: ["shots"], asd: ["faces"], vision: ["shots", "words"] });
// Bump a stage's version when its worker's output changes: the cache key changes with it.
const VERSION = { asr: 1, words: 1, speakers: 1, audio: 1, emotion: 1, shots: 1, faces: 1, asd: 1, vision: 1 };
const WEIGHT = { words: 0.12, speakers: 0.08, audio: 0.08, emotion: 0.05, shots: 0.04, faces: 0.25, asd: 0.08, vision: 0.3 };

/** Stages to run, in pipeline order, with what they need added ("asd" alone also runs shots and faces). */
export function plan(wanted = STAGES) {
  const set = new Set();
  const add = (s) => { if (!STAGES.includes(s)) throw new Error(`unknown stage: ${s}`); for (const n of NEEDS[s]) add(n); set.add(s); };
  for (const s of wanted) add(s);
  return STAGES.filter((s) => set.has(s));
}

/** Content hash of a media file: SHA-256 of its size and its first and last 8 MB (fast on multi-GB phone videos). */
export function fileHash(file) {
  const st = fs.statSync(file);
  const h = crypto.createHash("sha256").update(`${st.size}|`);
  const fd = fs.openSync(file, "r");
  try {
    const n = Math.min(st.size, 8 * 2 ** 20);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    h.update(buf);
    if (st.size > n) { fs.readSync(fd, buf, 0, n, st.size - n); h.update(buf); }
  } finally { fs.closeSync(fd); }
  return h.digest("hex").slice(0, 24);
}

/** Stable short key of a stage's parameters (and the keys of the stages it reads). */
export function stageKey(stage, params) {
  const norm = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
  return crypto.createHash("sha1").update(JSON.stringify([stage, VERSION[stage], norm(params)])).digest("hex").slice(0, 12);
}

/** The GPU lock: the cross-session lock file script (development), the app's GpuQueue, or none. */
export function makeGpuLock({ script = null, queue = null, name = "perception" } = {}) {
  if (queue) return { kind: "queue", acquire: async (id) => queue.acquire(name, id) };
  if (script) {
    const call = (cmd) => new Promise((resolve, reject) => {
      execFile(process.execPath, [script, cmd, name, "--wait-min", "240"], { windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(`gpu-lock ${cmd}: ${stderr || err.message}`)) : resolve(stdout.trim())));
    });
    return { kind: "file", acquire: async () => { await call("acquire"); let done = false; return async () => { if (!done) { done = true; await call("release").catch(() => {}); } }; } };
  }
  return { kind: "none", acquire: async () => () => {} };
}

/** Samples the card's used memory (nvidia-smi) while a stage runs; peak − the level at its start ≈ the stage's use. */
export function vramMonitor(intervalMs = 500) {
  let base = null, peak = null, timer = null, busy = false;
  const read = () => new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : Number(String(out).split(/\r?\n/)[0]) || null));
  });
  return {
    async start() {
      base = await read();
      peak = base;
      timer = setInterval(async () => { if (busy) return; busy = true; const v = await read(); busy = false; if (v !== null && (peak === null || v > peak)) peak = v; }, intervalMs);
    },
    async stop() { clearInterval(timer); const v = await read(); if (v !== null && (peak === null || v > peak)) peak = v; return base === null ? null : { baseMB: base, peakMB: peak, deltaMB: Math.max(0, peak - base) }; },
  };
}

/** Runs a worker; resolves with its result JSON. Progress lines ("PROGRESS 0.4") go to onProgress. */
function runWorker(python, script, job, { cwd, signal, onProgress, log = () => {}, env = {}, timeoutMs = 4 * 3600_000, outFile }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const jobFile = `${outFile}.job.json`;
  fs.writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-X", "utf8", script, "--job", jobFile, "--out", outFile], {
      cwd, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", ...env },
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
      try { resolve(JSON.parse(fs.readFileSync(outFile, "utf8"))); } catch (e) { reject(new Error(`${path.basename(script)}: bad result: ${e.message}`)); }
      try { fs.rmSync(jobFile, { force: true }); } catch { /* kept */ }
    });
  });
}

function runCmd(bin, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 2 ** 20, encoding: "buffer" }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(bin)}: ${String(stderr).slice(-1500) || err.message}`)) : resolve(stdout)));
  });
}

/** The runtime folder (venvs + models): an explicit one, the app's data folder, or the project's runtime/. */
export function findRuntime({ runtimeDir = null, userData = null } = {}) {
  const exe = process.platform === "win32" ? path.join("perception", "Scripts", "python.exe") : path.join("perception", "bin", "python");
  const dirs = [runtimeDir, userData && path.join(userData, "runtime"), path.join(REPO, "runtime")].filter(Boolean);
  return dirs.find((d) => fs.existsSync(path.join(d, exe))) || dirs[0] || path.join(REPO, "runtime");
}

const venvPython = (runtime, name) => path.join(runtime, name, ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

/**
 * ASR engines the words stage can use; each writes {segments: [{start, end, text, words: [{start, end, word, p}]}]}.
 * The phase-0 winner (QwenCleo-ASR, Cohere Transcribe Arabic…) drops in here as another entry; "file" takes a
 * transcript some other tool already made (same shape).
 */
export const ASR_ENGINES = {
  nemo: {
    model: "asr-egyptian-nemo-v2.0 (NeMo)",
    params: (o) => ({ model: path.basename(o.nemoModel || "asr-egyptian-nemo-v2.0.nemo") }),
    // nemo_words.py prints its JSON on stdout (the captions service's contract) and runs on the CPU by default.
    run: async (ctx, o) => {
      const model = o.nemoModel || nemoModel(ctx.userData);
      if (!model || !fs.existsSync(model)) throw new Error("the Egyptian NeMo model file is missing (src/services/asr/models/asr-egyptian-nemo-v2.0.nemo)");
      const out = await runCmd(venvPython(ctx.runtime, "asr"), ["-X", "utf8", path.join(ASR_DIR, "nemo_words.py"), "--audio", ctx.audio, "--model", model, "--device", o.asrDevice || "auto"], { timeoutMs: 3600_000 });
      return JSON.parse(out.toString("utf8"));
    },
  },
  file: {
    model: "external transcript",
    params: (o) => ({ file: o.asrFile, mtime: o.asrFile && fs.existsSync(o.asrFile) ? fs.statSync(o.asrFile).mtimeMs : 0 }),
    run: async (_ctx, o) => JSON.parse(fs.readFileSync(o.asrFile, "utf8")),
  },
};

export class PerceptionService {
  /**
   * runtimeDir: the folder with the venvs (perception, asr), llama/ and models/perception/ (found when omitted).
   * cacheDir: where results are kept per file hash. ffmpeg/ffprobe: binaries. gpuLock: makeGpuLock(…).
   */
  constructor({ runtimeDir = null, userData = null, cacheDir = null, ffmpeg, ffprobe, gpuLock = makeGpuLock(), log = () => {} } = {}) {
    this.runtime = findRuntime({ runtimeDir, userData });
    this.userData = userData;
    this.models = path.join(this.runtime, "models", "perception");
    this.cacheDir = cacheDir || path.join(this.runtime, "perception-cache");
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.gpuLock = gpuLock;
    this.log = log;
    this.jobs = new Map();
  }

  /** What is installed: the venvs, the model files, llama.cpp. */
  status() {
    const has = (...p) => fs.existsSync(path.join(...p));
    return {
      runtime: this.runtime,
      perceptionEnv: fs.existsSync(venvPython(this.runtime, "perception")),
      asrEnv: fs.existsSync(venvPython(this.runtime, "asr")),
      models: {
        align: has(this.models, "wav2vec2-large-xlsr-53-arabic"),
        speakers: has(this.models, "pyannote-speaker-diarization-community-1", "config.yaml"),
        panns: has(this.models, "panns", "Cnn14_DecisionLevelMax_mAP=0.385.pth"),
        laughter: has(this.models, "laughter-detection"),
        emotion: has(this.models, "emotion2vec_plus_large"),
        shots: has(this.models, "transnetv2"),
        faces: has(this.models, "buffalo_l", "det_10g.onnx"),
        adaface: has(this.models, "adaface"),
        asd: has(this.models, "LR-ASD"),
        vision: has(this.models, "qwen3.6-35b-a3b"),
      },
      llama: has(this.runtime, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server"),
    };
  }

  async probe(file) {
    const out = await runCmd(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
    const j = JSON.parse(out.toString("utf8"));
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    const a = (j.streams || []).find((s) => s.codec_type === "audio");
    const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
    const turned = Math.abs(rot) % 180 === 90;
    const [n, d] = String(v?.r_frame_rate || "0/1").split("/").map(Number);
    return {
      path: file, name: path.basename(file), duration: Number(j.format?.duration) || 0, hasAudio: !!a, hasVideo: !!v,
      width: v ? (turned ? v.height : v.width) : null, height: v ? (turned ? v.width : v.height) : null, fps: d ? Number((n / d).toFixed(3)) : null,
    };
  }

  /** The last timeline made for this file's content, or null. */
  cached(file) {
    if (!fs.existsSync(file)) return null;
    const f = path.join(this.cacheDir, fileHash(file), "timeline.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  }

  /**
   * Yes/no checks on short windows (≤ 30 s) by a model that sees — and with Qwen3-Omni hears — the window: the hook for
   * phase 6 (is this reaction caused by that event?). checks: [{t0, t1, question}]. engine: "qwen3-omni" | "keye".
   * Answers {available: false, reason} while that model is not installed.
   */
  async windowCheck(file, checks, { engine = "qwen3-omni", signal } = {}) {
    const hash = fileHash(file);
    const dir = path.join(this.cacheDir, hash, "window-check");
    const release = await this.gpuLock.acquire(`perception-window-${hash.slice(0, 8)}`);
    try {
      return await runWorker(venvPython(this.runtime, "perception"), path.join(WORKERS, "window_check.py"),
        { modelsDir: this.models, media: file, ffmpeg: this.ffmpeg, llama: path.join(this.runtime, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server"), engine, checks, workDir: dir },
        { cwd: WORKERS, signal, log: (l) => this.log(`[window-check] ${l}`), outFile: path.join(dir, `checks-${Date.now()}.json`) });
    } finally { await Promise.resolve(release()).catch(() => {}); }
  }

  /** Analyse one file (concurrent calls for the same file share the run). Resolves with the timeline. */
  analyze(file, opts = {}) {
    const key = `${path.resolve(file)}|${JSON.stringify(opts.stages || STAGES)}`;
    if (!this.jobs.has(key)) this.jobs.set(key, this.#analyze(file, opts).finally(() => this.jobs.delete(key)));
    return this.jobs.get(key);
  }

  async #analyze(file, { stages = STAGES, onProgress, signal, asr = "nemo", options = {}, refresh = [] } = {}) {
    const t0 = Date.now();
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const media = await this.probe(file);
    media.hash = fileHash(file);
    const dir = path.join(this.cacheDir, media.hash);
    fs.mkdirSync(dir, { recursive: true });
    const todo = plan(stages);
    const report = {};
    const results = {};
    const keys = {};
    let doneW = 0;
    const totalW = todo.reduce((a, s) => a + WEIGHT[s], 0);
    const prog = (s, p) => onProgress?.({ stage: s, stageProgress: p, progress: Math.min(0.999, (doneW + WEIGHT[s] * p) / totalW) });

    // The 16 kHz mono sound, once per file (read in place from the original).
    const audio = path.join(dir, "audio16k.wav");
    if (media.hasAudio && !fs.existsSync(audio)) {
      await runCmd(this.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", `${audio}.tmp.wav`], { timeoutMs: 1800_000 });
      fs.renameSync(`${audio}.tmp.wav`, audio);
    }
    const workerOpts = (stage) => ({ cwd: WORKERS, signal, log: (l) => this.log(`[${stage}] ${l}`), onProgress: (p) => prog(stage, p) });
    const o = { ...FUSE, ...options };

    for (const stage of todo) {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
      const def = this.#stage(stage, { media, audio, dir, results, asr, o });
      if (def.skip) { report[stage] = { skipped: def.skip }; doneW += WEIGHT[stage]; continue; }
      keys[stage] = stageKey(stage, { ...def.params, needs: NEEDS[stage].map((n) => keys[n] || null) });
      const outFile = path.join(dir, `${stage}.${keys[stage]}.json`);
      const t = Date.now();
      if (fs.existsSync(outFile) && !refresh.includes(stage)) {
        results[stage] = JSON.parse(fs.readFileSync(outFile, "utf8"));
        report[stage] = { ...(results[stage]._report || {}), cached: true };
      } else {
        let release = async () => {};
        const mon = vramMonitor();
        let waitMs = 0;
        try {
          if (def.gpu) { const w0 = Date.now(); release = await this.gpuLock.acquire(`perception-${stage}-${media.hash.slice(0, 8)}`); waitMs = Date.now() - w0; }
          await mon.start();
          const r = await def.run({ outFile, workerOpts: workerOpts(stage) });
          const v = await mon.stop();
          r._report = { ms: Date.now() - t - waitMs, gpuWaitMs: waitMs, device: r.device ?? null, model: r.model ?? def.model ?? null, torchPeakMB: r.vram_peak_mb ?? null, vram: v, parts: r.timing ?? null };
          fs.writeFileSync(outFile, JSON.stringify(r));
          results[stage] = r;
          report[stage] = { ...r._report, cached: false };
        } catch (e) {
          await mon.stop().catch(() => null);
          if (e.cancelled) throw e;
          this.log(`[${stage}] failed: ${e.message}`);
          report[stage] = { failed: String(e.message).slice(0, 2000), ms: Date.now() - t };
        } finally {
          await Promise.resolve(release()).catch(() => {});
        }
      }
      doneW += WEIGHT[stage];
      prog(stage, 1);
    }
    const timeline = buildTimeline({ media, stages: results, opts: o });
    timeline.generated = new Date().toISOString();
    // Side files the later phases may open: face crops/thumbnails, the vision keyframes.
    timeline.artifacts = { dir, faces: results.faces?.workDir ?? null, vision: results.vision ? path.join(dir, "vision") : null };
    timeline.report = { stages: report, totalMs: Date.now() - t0, keys };
    fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(timeline));
    onProgress?.({ stage: "done", progress: 1 });
    return timeline;
  }

  /** One stage's definition for this file: its parameters (cache key), whether it uses the GPU, and how to run it. */
  #stage(stage, { media, audio, dir, results, asr, o }) {
    const pyP = venvPython(this.runtime, "perception");
    const pyA = venvPython(this.runtime, "asr");
    const base = { modelsDir: this.models, device: o.device || "auto" };
    const W = (name) => path.join(WORKERS, name);
    const needAudio = media.hasAudio ? null : "no audio";
    const needVideo = media.hasVideo ? null : "no video";
    switch (stage) {
      case "words": {
        const eng = ASR_ENGINES[asr];
        if (!eng) throw new Error(`unknown ASR engine: ${asr}`);
        const p = { asr, asrParams: eng.params(o), align: { pad: 0.3, maxShift: 1.0, maxShiftSure: 2.5, sureConf: 0.8, minConf: 0.3 } };
        return {
          skip: needAudio, gpu: true, params: p, model: eng.model,
          run: async ({ outFile, workerOpts }) => {
            const asrFile = path.join(dir, `asr.${stageKey("asr", p.asrParams)}.json`);
            let tr;
            const ta = Date.now();
            if (fs.existsSync(asrFile)) tr = JSON.parse(fs.readFileSync(asrFile, "utf8"));
            else { tr = await eng.run({ runtime: this.runtime, userData: this.userData, audio, out: (n) => path.join(dir, n), workerOpts: { ...workerOpts, cwd: ASR_DIR } }, { ...o, asrFile: o.asrFile }); fs.writeFileSync(asrFile, JSON.stringify(tr)); }
            const asrMs = Date.now() - ta;
            const r = await runWorker(pyA, W("align.py"), { ...base, audio, asr: tr, ...p.align }, { ...workerOpts, outFile: `${outFile}.align` });
            r.asrModel = eng.model;
            r.asrDevice = tr.device ?? null;
            r.timing = { asr: asrMs / 1000, ...(r.timing || {}) };
            return r;
          },
        };
      }
      case "speakers": {
        const p = { numSpeakers: o.numSpeakers || null, minSpeakers: o.minSpeakers || null, maxSpeakers: o.maxSpeakers || null };
        return { skip: needAudio, gpu: true, params: p, run: ({ outFile, workerOpts }) => runWorker(pyP, W("speakers.py"), { ...base, audio, ...p }, { ...workerOpts, outFile }) };
      }
      case "audio": {
        const p = { tagThreshold: o.tagThreshold ?? 0.3, laughThreshold: o.laughThreshold ?? 0.5 };
        return { skip: needAudio, gpu: true, params: p, run: ({ outFile, workerOpts }) => runWorker(pyP, W("audio_events.py"), { ...base, audio, ...p }, { ...workerOpts, outFile }) };
      }
      case "emotion": {
        if (needAudio) return { skip: needAudio };
        if (!results.words) return { skip: "no words" };
        const names = results.speakers ? speakerNames(results.speakers.exclusive) : new Map();
        const excl = (results.speakers?.exclusive || []).map((t) => ({ ...t, speaker: names.get(t.speaker) }));
        const utt = utterances(wordsWithSpeakers(results.words.words, excl, [], o), o).filter((u) => u.end - u.start >= 0.5);
        const p = { granularity: "utterance" };
        return { gpu: true, params: p, run: ({ outFile, workerOpts }) => runWorker(pyP, W("emotion.py"), { ...base, audio, utterances: utt }, { ...workerOpts, outFile }) };
      }
      case "shots": {
        const p = { fps: 25, threshold: o.shotThreshold ?? 0.5 };
        return { skip: needVideo, gpu: true, params: p, run: ({ outFile, workerOpts }) => runWorker(pyP, W("shots.py"), { ...base, media: media.path, ffmpeg: this.ffmpeg, duration: media.duration, ...p }, { ...workerOpts, outFile }) };
      }
      case "faces": {
        const cuts = (results.shots?.shots || []).slice(1).map((s) => s.start);
        const p = { fps: 25, longSide: 960, detThresh: 0.5, minTrackS: 0.4, cuts };
        const work = path.join(dir, "faces");
        return {
          skip: needVideo, gpu: true, params: p,
          run: ({ outFile, workerOpts }) => runWorker(pyP, W("faces.py"), { ...base, media: media.path, ffmpeg: this.ffmpeg, duration: media.duration, workDir: work, shotCuts: cuts, ...p }, { ...workerOpts, outFile }).then((r) => ({ ...r, workDir: work })),
        };
      }
      case "asd": {
        if (needAudio) return { skip: needAudio };
        if (!results.faces?.tracks?.length) return { skip: "no faces" };
        const p = { model: o.asdModel || "lr-asd" };
        const tracks = results.faces.tracks.map((t) => ({ id: t.id, t0: t.t0, first: t.first, frames: t.frames, crop: path.join(results.faces.workDir, t.crop) }));
        return { gpu: true, params: p, run: ({ outFile, workerOpts }) => runWorker(pyP, W("asd.py"), { ...base, audio, fps: results.faces.fps, tracks, ...p }, { ...workerOpts, outFile }) };
      }
      case "vision": {
        if (needVideo) return { skip: needVideo };
        const llama = path.join(this.runtime, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server");
        const shots = results.shots?.shots?.length ? results.shots.shots : [{ start: 0, end: media.duration }];
        const p = { model: o.visionModel || "Qwen3.6-35B-A3B-UD-IQ4_XS", windowS: o.visionWindowS ?? 12, frames: o.visionFrames ?? 3, side: 640, prompt: 2 };
        const words = (results.words?.words || []).map((w) => [w.start, w.word]);
        return {
          gpu: true, params: { ...p, shots: shots.map((s) => [s.start, s.end]) },
          run: ({ outFile, workerOpts }) => runWorker(pyP, W("vision.py"), { ...base, media: media.path, ffmpeg: this.ffmpeg, llama, duration: media.duration, shots, words, workDir: path.join(dir, "vision"), ...p }, { ...workerOpts, outFile }),
        };
      }
      default: throw new Error(`unknown stage: ${stage}`);
    }
  }
}
