// Captions and speech (FEAT-083..088): import SRT/VTT into caption text clips, and local speech recognition with
// word timings through one of two LOCAL providers configured in Settings › Providers — no cloud service is used:
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
const FW_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "asr", "faster_whisper_words.py").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

/** Run a process, collect stdout/stderr; rejects with PROVIDER err on failure. */
function exec(cmd, args, { timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); if (err.length > 20000) err = err.slice(-10000); });
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
    if (!force && this.fw?.key === key) return this.fw;
    if (!force && this.fwChecking?.key === key) return this.fwChecking.promise;
    const code = "import json,faster_whisper,ctranslate2\nfrom faster_whisper.utils import download_model\n"
      + "m=None\ntry:\n  m=download_model(__import__('sys').argv[1],local_files_only=True)\nexcept Exception as e:\n  m=None\n"
      + "print(json.dumps({'version':faster_whisper.__version__,'cuda':ctranslate2.get_cuda_device_count(),'model':bool(m)}))";
    const promise = exec(this.pythonCmd(), ["-X", "utf8", "-c", code, p.fwModel || "large-v3-turbo"], { timeoutMs: 30_000 })
      .then((out) => { const j = JSON.parse(out.trim().split("\n").pop()); return { key, ok: j.model, installed: true, version: j.version, cuda: j.cuda > 0, model: p.fwModel }; })
      .catch(() => ({ key, ok: false, installed: false }))
      .then((r) => { this.fw = r; this.fwChecking = null; return r; });
    this.fwChecking = { key, promise };
    return promise;
  }

  whisperCppOk() {
    const p = this.settings.get("providers");
    return !!p.whisperPath && fs.existsSync(p.whisperPath) && !!p.whisperModel && fs.existsSync(p.whisperModel);
  }

  /** Which provider transcription will use (null if none is available). Sync: uses the last detection. */
  engine() {
    const want = this.settings.get("providers").asrEngine || "auto";
    const cpp = this.whisperCppOk(), fw = !!this.fw?.ok;
    if (want === "whispercpp") return cpp ? "whispercpp" : null;
    if (want === "fasterwhisper") return fw ? "fasterwhisper" : null;
    return fw ? "fasterwhisper" : cpp ? "whispercpp" : null; // auto: word timings are more accurate with faster-whisper
  }

  providerStatus() {
    const p = this.settings.get("providers");
    const engine = this.engine();
    return { autoCaptions: !!engine, words: !!engine, engine, whisperPath: p.whisperPath, whisperModel: p.whisperModel,
      fasterWhisper: this.fw ? { installed: this.fw.installed, modelCached: this.fw.ok, version: this.fw.version, cuda: this.fw.cuda, model: p.fwModel } : null };
  }

  /** providerStatus after (re)detecting faster-whisper. */
  async status(force = false) { await this.detectFasterWhisper(force); return this.providerStatus(); }

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
  async transcribeWords({ mediaId, language = "auto", fresh = false, signal } = {}) {
    await this.detectFasterWhisper();
    const engine = this.engine();
    if (!engine) throw new AppError("PROVIDER", "err.whisperNotConfigured");
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const lang = /^[a-z]{2}$|^auto$/.test(language) ? language : "auto";
    const p = this.settings.get("providers");
    const model = engine === "fasterwhisper" ? p.fwModel : path.basename(p.whisperModel);
    let stamp = "";
    try { const st = fs.statSync(m.path); stamp = `${st.size}:${st.mtimeMs}`; } catch { throw new AppError("IO", "err.fileNotFound", { file: path.basename(m.path) }); }
    const dir = path.join(this.paths.cache, "transcripts");
    const file = path.join(dir, `${m.id}.${crypto.createHash("sha1").update(`${engine}|${model}|${lang}|${stamp}`).digest("hex").slice(0, 12)}.json`);
    if (!fresh && fs.existsSync(file)) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* re-run */ } }
    const work = path.join(this.paths.cache, `asr-${uid()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const wav = await this.extractWav(m, work, { signal });
      const result = engine === "fasterwhisper" ? await this.runFasterWhisper(wav, lang, signal) : await this.runWhisperCppWords(wav, work, lang, signal);
      const out = { mediaId: m.id, engine, model, language: result.language || lang, durationUs: m.durationUs, ...result.data };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out));
      return out;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async runFasterWhisper(wav, lang, signal) {
    const p = this.settings.get("providers");
    const out = await exec(this.pythonCmd(), ["-X", "utf8", FW_SCRIPT, "--audio", wav, "--model", p.fwModel || "large-v3-turbo", "--language", lang], { timeoutMs: 60 * 60_000, signal });
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
    await this.detectFasterWhisper();
    const engine = this.engine();
    if (!engine) throw new AppError("PROVIDER", "err.whisperNotConfigured");
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const srcEnd = durationUs ? sourceStartUs + durationUs * speed : Infinity;
    if (engine === "fasterwhisper") {
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
