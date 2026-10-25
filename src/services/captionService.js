// Captions and speech (FEAT-083..088): import SRT/VTT into caption text clips, and local speech recognition with
// word timings through a LOCAL provider — no cloud service is used:
//   nemo           the Egyptian Arabic NeMo model that ships in the source (src/services/asr/models), run by the
//                  program's own Python runtime (runtime/asr, made by scripts/setup-asr.ps1) — the default engine
//   whispercpp     a whisper.cpp executable + ggml model chosen by the user
//   fasterwhisper  the faster-whisper Python package with a model already in the local Hugging Face cache
//                  (src/services/asr/faster_whisper_words.py; models are never downloaded by the app)
// Transcripts are cached per media file (and provider/model/language), so a file is transcribed once.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSrt } from "../core/srt.js";
import { run, binaries } from "./ffmpeg.js";
import { AppError } from "../core/validation.js";
import { newSegment, DEFAULT_TEXT } from "../core/model.js";
import { uid, US } from "../core/util.js";
import { TEXT_PRESETS } from "../core/presets.js";

// The Python helper must be a real file for the interpreter: in packaged builds it is unpacked next to app.asar.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASR_DIR = path.join(HERE, "asr").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const FW_SCRIPT = path.join(ASR_DIR, "faster_whisper_words.py");
const NEMO_SCRIPT = path.join(ASR_DIR, "nemo_words.py");
const NEMO_FILE = "asr-egyptian-nemo-v2.0.nemo";
export const NEMO_MODEL = path.join(ASR_DIR, "models", NEMO_FILE);
const NEMO_NAME = "egyptian-nemo-v2.0";

/**
 * The model file: in the source (src/services/asr/models) or, for an installed copy (the public installer does not
 * carry the model), in <user data>/models — which survives updates. Null when neither exists.
 */
export function nemoModel(userData) {
  for (const f of [NEMO_MODEL, ...(userData ? [path.join(userData, "models", NEMO_FILE)] : [])]) if (fs.existsSync(f)) return f;
  return null;
}

/**
 * The program's own Python runtime for the NeMo engine: <app root>/runtime/asr — the project folder in development,
 * the resources folder next to app.asar when packaged — or, failing that, <user data>/runtime/asr. Never a Python
 * from another project or the system PATH.
 */
export function nemoPython(userData) {
  const root = path.resolve(HERE, "..", "..");
  const base = /\.asar$/i.test(root) ? path.dirname(root) : root;
  const exe = process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python");
  const dirs = [path.join(base, "runtime", "asr"), ...(userData ? [path.join(userData, "runtime", "asr")] : [])];
  for (const d of dirs) if (fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  return null;
}

/** 10 ms RMS envelope of a 16-bit PCM WAV (the 16 kHz mono file extracted for recognition). */
export function wavEnvelope(file, frameMs = 10) {
  const buf = fs.readFileSync(file);
  let off = 12, rate = 16000, data = null;
  while (off + 8 <= buf.length) { // RIFF chunks: "fmt " gives the rate, "data" the samples
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(off + 12);
    if (id === "data") { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) return { env: [], frameUs: frameMs * 1000 };
  const win = Math.round((rate * frameMs) / 1000), n = Math.floor(data.length / 2), env = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let k = 0; k < win; k++) { const v = data.readInt16LE((i + k) * 2); s += v * v; } env.push(Math.sqrt(s / win)); }
  return { env, frameUs: frameMs * 1000 };
}

/**
 * Snap word times to the sound. Recognisers start the first word after a pause too early (part of the silence is
 * given to it — measured 0.5–1.2 s on real speech), which makes a caption appear before the word is said. A word
 * whose reported start is silent moves forward to where speech energy starts (−30 ms), and a word whose reported end
 * is silent moves back to its last voiced frame (+50 ms). "Speech" = 40 ms in a row above a threshold between the
 * noise floor (20th percentile) and the speech level (90th), so a click or breath does not count. Words keep at
 * least 60 ms and their order.
 */
export function refineWordTimes(words, { env, frameUs }) {
  if (!env.length || !words.length) return { words, moved: 0 };
  const sorted = [...env].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const floor = pct(0.2), speech = pct(0.9);
  const thr = floor + 0.12 * (speech - floor);
  if (!(speech > floor * 2)) return { words, moved: 0 }; // no clear speech/silence contrast: leave as is
  const frame = (us) => Math.max(0, Math.min(env.length - 1, Math.floor(us / frameUs)));
  const RUN = Math.max(1, Math.round(40_000 / frameUs));
  const voicedAt = (j) => { for (let k = 0; k < RUN; k++) if (!(env[j + k] >= thr)) return false; return true; };
  const voicedBefore = (j) => { for (let k = 0; k < RUN; k++) if (!(env[j - k] >= thr)) return false; return true; };
  let moved = 0;
  const out = words.map((w, i) => {
    let s = w.startUs, e = w.endUs;
    const nextStart = words[i + 1]?.startUs ?? Infinity;
    if (env[frame(s)] < thr) {
      // The sound may begin after the reported END too (the whole word placed in the silence): search up to the
      // next word, and keep the word's length when it moves past its end.
      let j = frame(s); const lim = frame(Math.min(Math.max(e - 40_000, nextStart - 40_000), s + 1_500_000));
      while (j < lim && !voicedAt(j)) j++;
      if (voicedAt(j)) {
        const ns = Math.max(w.startUs, j * frameUs - 30_000);
        if (ns >= e - 60_000) e = Math.min(Math.max(nextStart, ns + 60_000), ns + Math.max(150_000, w.endUs - w.startUs));
        s = ns;
      }
    }
    if (env[frame(e)] < thr) {
      let j = frame(e); const lim = frame(s + 60_000);
      while (j > lim && !voicedBefore(j)) j--;
      if (voicedBefore(j)) e = Math.min(w.endUs, (j + 1) * frameUs + 50_000);
    }
    if (e - s < 60_000) e = Math.min(w.endUs, s + 60_000);
    if (s !== w.startUs || e !== w.endUs) moved++;
    return { ...w, startUs: Math.round(s), endUs: Math.round(Math.max(e, s + 1)) };
  });
  return { words: out, moved };
}

/** Run a process, collect stdout/stderr; rejects with PROVIDER err on failure. */
function exec(cmd, args, { timeoutMs = 60_000, signal, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    let line = "";
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      err += s; if (err.length > 20000) err = err.slice(-10000);
      if (onStderrLine) { line += s; const parts = line.split(/\r?\n/); line = parts.pop(); for (const l of parts) onStderrLine(l); }
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    signal?.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", (e) => { clearTimeout(timer); reject(new AppError("PROVIDER", "err.whisperFailed", { message: e.message })); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new AppError("PROVIDER", "err.whisperFailed", { code, stderr: err.slice(-1500) })); });
  });
}

export class CaptionService {
  constructor({ repos, paths, settings }) {
    this.repos = repos;
    this.paths = paths;
    this.settings = settings;
    this.fw = null;          // faster-whisper detection result (cached per python path + model)
    this.fwChecking = null;
    this.nemo = null;        // NeMo runtime detection result
    this.nemoChecking = null;
  }

  /** Text segments for cues (offset in µs), styled as captions near the bottom of the frame. */
  segmentsFromCues(cues, { offsetUs = 0, canvasHeight = 1080, language = "auto" } = {}) {
    return cues.map((c) => newSegment("text", {
      name: c.text.slice(0, 40), start: Math.max(0, c.startUs + offsetUs), duration: Math.max(Math.round(US / 10), c.endUs - c.startUs),
      text: { ...DEFAULT_TEXT, ...TEXT_PRESETS.caption, content: c.text, isCaption: true, direction: language === "ar" ? "rtl" : "auto" },
      transform: { x: 0, y: 0.36, scale: 1, scaleX: 1, scaleY: 1, uniform: true, rotation: 0, flipH: false, flipV: false, opacity: 1, blend: "normal" },
    }));
  }

  importFile(file) {
    if (!fs.existsSync(file)) throw new AppError("IO", "err.fileNotFound", { file });
    if (fs.statSync(file).size > 3 * 1024 * 1024) throw new AppError("VALIDATION", "err.captionTooLarge"); // report: «no more than 3MB»
    return parseSrt(fs.readFileSync(file, "utf8"));
  }

  // ------------------------------------------------------------------ providers
  pythonCmd() { return this.settings.get("providers").pythonPath || "python"; }

  /** Check (once per python path + model) that faster-whisper and the model are available offline. */
  async detectFasterWhisper(force = false) {
    const p = this.settings.get("providers");
    const key = `${this.pythonCmd()}|${p.fwModel}`;
    // A success is kept; a failure is retried after 20 s (Python can be slow to start while the app launches — a
    // failed first check must not disable speech until the next restart).
    if (!force && this.fw?.key === key && (this.fw.ok || Date.now() - this.fw.at < 20_000)) return this.fw;
    if (!force && this.fwChecking?.key === key) return this.fwChecking.promise;
    const code = "import json,faster_whisper,ctranslate2\nfrom faster_whisper.utils import download_model\n"
      + "m=None\ntry:\n  m=download_model(__import__('sys').argv[1],local_files_only=True)\nexcept Exception as e:\n  m=None\n"
      + "print(json.dumps({'version':faster_whisper.__version__,'cuda':ctranslate2.get_cuda_device_count(),'model':bool(m)}))";
    const promise = exec(this.pythonCmd(), ["-X", "utf8", "-c", code, p.fwModel || "large-v3-turbo"], { timeoutMs: 90_000 })
      .then((out) => { const j = JSON.parse(out.trim().split("\n").pop()); return { key, at: Date.now(), ok: j.model, installed: true, version: j.version, cuda: j.cuda > 0, model: p.fwModel }; })
      .catch((e) => ({ key, at: Date.now(), ok: false, installed: false, error: String(e?.details?.stderr || e?.details?.message || e?.message || e).slice(-300) }))
      .then((r) => { this.fw = r; this.fwChecking = null; return r; });
    this.fwChecking = { key, promise };
    return promise;
  }

  /** Check (once; a failure is retried after 20 s) that the program's NeMo runtime and the shipped model work. */
  async detectNemo(force = false) {
    const py = nemoPython(this.paths.root), model = nemoModel(this.paths.root);
    const key = `${py}|${model}`;
    if (!force && this.nemo?.key === key && (this.nemo.ok || Date.now() - this.nemo.at < 20_000)) return this.nemo;
    if (!force && this.nemoChecking?.key === key) return this.nemoChecking.promise;
    const base = { key, at: Date.now(), python: py, modelFile: !!model, model: NEMO_NAME };
    const promise = (!py || !base.modelFile
      ? Promise.resolve({ ...base, ok: false, installed: !!py })
      : exec(py, ["-X", "utf8", NEMO_SCRIPT, "--audio", "-", "--check", "--model", model], { timeoutMs: 120_000 })
        .then((out) => { const j = JSON.parse(out.trim().split("\n").pop()); return { ...base, ok: !!j.model, installed: true, version: j.nemo, cuda: !!j.cuda }; })
        .catch((e) => ({ ...base, ok: false, installed: false, error: String(e?.details?.stderr || e?.details?.message || e?.message || e).slice(-300) })))
      .then((r) => { this.nemo = r; this.nemoChecking = null; return r; });
    this.nemoChecking = { key, promise };
    return promise;
  }

  whisperCppOk() {
    const p = this.settings.get("providers");
    return !!p.whisperPath && fs.existsSync(p.whisperPath) && !!p.whisperModel && fs.existsSync(p.whisperModel);
  }

  /**
   * Which provider transcription of `language` will use (null if none is available). Sync: uses the last detection.
   * The Egyptian model understands Arabic only: another language named explicitly goes to the other engines.
   */
  engine(language = "auto") {
    const want = this.settings.get("providers").asrEngine || "auto";
    const cpp = this.whisperCppOk(), fw = !!this.fw?.ok, nemo = !!this.nemo?.ok && (language === "ar" || language === "auto");
    if (want === "nemo") return nemo ? "nemo" : null;
    if (want === "whispercpp") return cpp ? "whispercpp" : null;
    if (want === "fasterwhisper") return fw ? "fasterwhisper" : null;
    // auto: the Egyptian model first (measured 7.6 % word errors on Egyptian speech against 10.6 % for whisper turbo)
    return nemo ? "nemo" : fw ? "fasterwhisper" : cpp ? "whispercpp" : null;
  }

  providerStatus() {
    const p = this.settings.get("providers");
    const engine = this.engine();
    return { autoCaptions: !!engine, words: !!engine, engine, whisperPath: p.whisperPath, whisperModel: p.whisperModel,
      fasterWhisper: this.fw ? { installed: this.fw.installed, modelCached: this.fw.ok, version: this.fw.version, cuda: this.fw.cuda, model: p.fwModel } : null,
      nemo: this.nemo ? { installed: this.nemo.installed, ready: this.nemo.ok, modelFile: this.nemo.modelFile, version: this.nemo.version, cuda: this.nemo.cuda, model: NEMO_NAME, python: this.nemo.python, error: this.nemo.error } : null };
  }

  /** Detect the engines that may be used (the Egyptian model always; faster-whisper only when it could be chosen). */
  async detectEngines(force = false, language = "auto") {
    const nemo = await this.detectNemo(force);
    const want = this.settings.get("providers").asrEngine || "auto";
    const arabic = language === "ar" || language === "auto";
    if (want === "fasterwhisper" || (want === "auto" && !(nemo.ok && arabic))) await this.detectFasterWhisper(force);
  }

  /** providerStatus after (re)detecting the engines. */
  async status(force = false) { await this.detectEngines(force); return this.providerStatus(); }

  // ------------------------------------------------------------------ transcription
  async extractWav(m, work, { fromUs = 0, durUs = null, signal } = {}) {
    const wav = path.join(work, "audio.wav");
    await run(binaries().ffmpeg, ["-hide_banner", "-y", ...(fromUs ? ["-ss", String(fromUs / US)] : []), ...(durUs ? ["-t", String(durUs / US)] : []), "-i", m.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { timeoutMs: 30 * 60_000, signal });
    return wav;
  }

  /**
   * Word-level transcript of a whole media file in SOURCE time: { language, engine, model, durationUs,
   * words: [{ text, startUs, endUs, p }], segments: [{ text, startUs, endUs, w0, w1 }] } (w0..w1 = word indices).
   * Cached in cache/transcripts; `fresh` ignores the cache.
   */
  async transcribeWords({ mediaId, language = "auto", fresh = false, signal, onProgress } = {}) {
    const lang = /^[a-z]{2}$|^auto$/.test(language) ? language : "auto";
    await this.detectEngines(false, lang);
    const engine = this.engine(lang);
    if (!engine) throw new AppError("PROVIDER", "err.whisperNotConfigured");
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const p = this.settings.get("providers");
    const model = engine === "nemo" ? NEMO_NAME : engine === "fasterwhisper" ? p.fwModel : path.basename(p.whisperModel);
    let stamp = "";
    try { const st = fs.statSync(m.path); stamp = `${st.size}:${st.mtimeMs}`; } catch { throw new AppError("IO", "err.fileNotFound", { file: path.basename(m.path) }); }
    const dir = path.join(this.paths.cache, "transcripts");
    const file = path.join(dir, `${m.id}.${crypto.createHash("sha1").update(`${engine}|${model}|${lang}|${stamp}|onsets-v1`).digest("hex").slice(0, 12)}.json`);
    if (!fresh && fs.existsSync(file)) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* re-run */ } }
    const work = path.join(this.paths.cache, `asr-${uid()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const wav = await this.extractWav(m, work, { signal });
      const result = engine === "nemo" ? await this.runNemo(wav, signal, onProgress)
        : engine === "fasterwhisper" ? await this.runFasterWhisper(wav, lang, signal) : await this.runWhisperCppWords(wav, work, lang, signal);
      const snapped = refineWordTimes(result.data.words, wavEnvelope(wav));
      for (const sg of result.data.segments) { const a = snapped.words[sg.w0], b = snapped.words[sg.w1]; if (a && b) { sg.startUs = a.startUs; sg.endUs = b.endUs; } }
      const out = { mediaId: m.id, engine, model, language: result.language || lang, durationUs: m.durationUs, ...result.data, words: snapped.words, timing: { snappedToAudio: snapped.moved } };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out));
      return out;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** The newest cached word transcript of a media file, or null — never runs recognition (used by the export). */
  cachedWords(mediaId) {
    const dir = path.join(this.paths.cache, "transcripts");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith(`${mediaId}.`) && f.endsWith(".json")).map((f) => path.join(dir, f)); } catch { return null; }
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files) { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.words?.length) return j.words; } catch { /* next */ } }
    return null;
  }

  async runFasterWhisper(wav, lang, signal) {
    const p = this.settings.get("providers");
    const out = await exec(this.pythonCmd(), ["-X", "utf8", FW_SCRIPT, "--audio", wav, "--model", p.fwModel || "large-v3-turbo", "--language", lang], { timeoutMs: 60 * 60_000, signal });
    return this.parseWordJson(out);
  }

  /** The Egyptian model through the program's runtime; same JSON as faster-whisper. */
  async runNemo(wav, signal, onProgress) {
    const py = nemoPython(this.paths.root), model = nemoModel(this.paths.root);
    if (!py || !model) throw new AppError("PROVIDER", "err.whisperNotConfigured");
    const onStderrLine = (l) => { const m = /^PROGRESS ([\d.]+)/.exec(l); if (m) onProgress?.(Number(m[1])); };
    return this.parseWordJson(await exec(py, ["-X", "utf8", NEMO_SCRIPT, "--audio", wav, "--model", model], { timeoutMs: 6 * 60 * 60_000, signal, onStderrLine }));
  }

  parseWordJson(out) {
    let j;
    try { j = JSON.parse(out); } catch { throw new AppError("PROVIDER", "err.whisperFailed", { message: "invalid output" }); }
    const words = [], segments = [];
    for (const s of j.segments) {
      const w0 = words.length;
      for (const w of s.words) if (w.word) words.push({ text: w.word, startUs: Math.round(w.start * US), endUs: Math.round(w.end * US), p: w.p });
      if (s.text) segments.push({ text: s.text, startUs: Math.round(s.start * US), endUs: Math.round(s.end * US), w0, w1: words.length - 1 });
    }
    return { language: j.language, data: { device: j.device, words, segments } };
  }

  /** whisper.cpp with one word per cue (--max-len 1 --split-on-word); segments are rebuilt from punctuation. */
  async runWhisperCppWords(wav, work, lang, signal) {
    const p = this.settings.get("providers");
    const base = path.join(work, "words");
    await exec(p.whisperPath, ["-m", p.whisperModel, "-f", wav, "-l", lang, "-ml", "1", "-sow", "-osrt", "-of", base], { timeoutMs: 60 * 60_000, signal });
    const words = parseSrt(fs.readFileSync(`${base}.srt`, "utf8")).map((c) => ({ text: c.text.trim(), startUs: c.startUs, endUs: c.endUs, p: null })).filter((w) => w.text);
    const segments = [];
    let w0 = 0;
    words.forEach((w, i) => {
      const end = /[.!?؟。]$/.test(w.text) || i === words.length - 1 || (words[i + 1] && words[i + 1].startUs - w.endUs > 700_000);
      if (end) { segments.push({ text: words.slice(w0, i + 1).map((x) => x.text).join(" "), startUs: words[w0].startUs, endUs: w.endUs, w0, w1: i }); w0 = i + 1; }
    });
    return { language: lang, data: { words, segments } };
  }

  /** Auto captions for one media span; returns cues in timeline time. */
  async transcribe({ mediaId, sourceStartUs = 0, durationUs = null, timelineStartUs = 0, speed = 1, language = "auto", signal } = {}) {
    const asked = /^[a-z]{2}$|^auto$/.test(language) ? language : "auto";
    await this.detectEngines(false, asked);
    const engine = this.engine(asked);
    if (!engine) throw new AppError("PROVIDER", "err.whisperNotConfigured");
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const srcEnd = durationUs ? sourceStartUs + durationUs * speed : Infinity;
    if (engine !== "whispercpp") {
      // Whole-file transcript (cached), cut to the clip's source span and mapped to the timeline.
      const tr = await this.transcribeWords({ mediaId, language, signal });
      return tr.segments.map((sg) => {
        const ws = tr.words.slice(sg.w0, sg.w1 + 1).filter((w) => w.startUs >= sourceStartUs && w.endUs <= srcEnd);
        if (!ws.length) return null;
        return { text: ws.map((w) => w.text).join(" "), startUs: timelineStartUs + (ws[0].startUs - sourceStartUs) / speed, endUs: timelineStartUs + (ws[ws.length - 1].endUs - sourceStartUs) / speed };
      }).filter(Boolean);
    }
    const work = path.join(this.paths.cache, `asr-${uid()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const wav = await this.extractWav(m, work, { fromUs: sourceStartUs, durUs: durationUs ? durationUs * speed : null, signal });
      const base = path.join(work, "out");
      const lang = /^[a-z]{2}$|^auto$/.test(language) ? language : "auto";
      const p = this.settings.get("providers");
      await exec(p.whisperPath, ["-m", p.whisperModel, "-f", wav, "-l", lang, "-osrt", "-of", base], { timeoutMs: 30 * 60_000, signal });
      const cues = parseSrt(fs.readFileSync(`${base}.srt`, "utf8"));
      return cues.map((c) => ({ ...c, startUs: timelineStartUs + c.startUs / speed, endUs: timelineStartUs + c.endUs / speed }));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
