// Dubbing an Arabic video into another language, all on this computer (src/services/dub/dub.py does the speech work):
//   1. the media's sound → speech and background apart (Mel-Band RoFormer, runtime/sep, audio-separator)
//   2. the clean speech → words with times (the Egyptian model, runtime/asr)
//   3. who speaks when, each speaker's kind and voice sample        (runtime/dub: dub.py analyze)
//   4. a local LLM (llama.cpp llama-server, runtime/llama + models/translate) corrects, splits and translates (translate)
//   5. each line spoken in its speaker's cloned voice with its emotion, fitted to its time; the background kept (synth)
//   6. the voice and the background become two audio tracks under the video, whose own sound is turned off (applyDub)
// The runtimes and models are the program's own: <app root>/runtime (the project folder in development, next to
// app.asar when packaged) or <user data>/runtime. Each stage reports progress; the whole run is weighted by measured
// stage times so the progress bar moves steadily.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, binaries } from "./ffmpeg.js";
import { nemoPython, nemoModel, refineWordTimes, wavEnvelope } from "./captionService.js";
import { AppError } from "../core/validation.js";
import { US } from "../core/util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUB_SCRIPT = path.join(HERE, "dub", "dub.py").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const NEMO_SCRIPT = path.join(HERE, "asr", "nemo_words.py").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const SEP_MODEL = "vocals_mel_band_roformer.ckpt";

/** Languages the voices can speak (Chatterbox: English; Chatterbox Multilingual: the others). */
export const DUB_LANGUAGES = ["en", "fr", "es", "de", "it", "pt", "tr", "ru", "nl", "pl", "sv", "da", "fi", "no", "el", "he", "hi", "ja", "ko", "zh", "ms", "sw"];

/** The program's runtime folders: next to the app first, then in the user's data folder. */
export function runtimeDirs(userData) {
  const root = path.resolve(HERE, "..", "..");
  const base = /\.asar$/i.test(root) ? path.dirname(root) : root;
  return [path.join(base, "runtime"), ...(userData ? [path.join(userData, "runtime")] : [])];
}
const exe = (p) => (process.platform === "win32" ? `${p}.exe` : p);

/** Where each part is (null when missing). */
export function dubParts(userData) {
  const find = (rel) => runtimeDirs(userData).map((d) => path.join(d, rel)).find((p) => fs.existsSync(p)) || null;
  const dirOf = (rel) => { const f = find(rel); return f ? path.dirname(f) : null; };
  const gguf = (() => {
    for (const d of runtimeDirs(userData).map((x) => path.join(x, "models", "translate"))) {
      const f = fs.existsSync(d) && fs.readdirSync(d).filter((x) => x.endsWith(".gguf")).sort()[0];
      if (f) return path.join(d, f);
    }
    return null;
  })();
  const bin = process.platform === "win32" ? "Scripts" : "bin";
  return {
    python: find(path.join("dub", bin, exe("python"))),
    separator: find(path.join("sep", bin, exe("audio-separator"))),
    llama: find(path.join("llama", exe("llama-server"))),
    translator: gguf,
    speakerModels: dirOf(path.join("models", "speaker", "nemo_en_titanet_large.onnx")),
    separationModels: dirOf(path.join("models", "separation", SEP_MODEL)),
    asrPython: nemoPython(userData),
    asrModel: nemoModel(userData),
  };
}

/** The speech model's JSON (seconds) with each word's start and end snapped to the sound (core of the captions). */
export function snapWords(j, envelope) {
  const flat = j.segments.flatMap((sg) => sg.words);
  const { words } = refineWordTimes(flat.map((w) => ({ startUs: Math.round(w.start * US), endUs: Math.round(w.end * US) })), envelope);
  flat.forEach((w, i) => { w.start = words[i].startUs / US; w.end = words[i].endUs / US; });
  for (const sg of j.segments) if (sg.words.length) { sg.start = sg.words[0].start; sg.end = sg.words[sg.words.length - 1].end; }
  return { ...j, snapped: true };
}

/** Spawn a process; lines "PROGRESS <p> <stage>" on stderr (or, with tqdm, its "45%|" bars) are reported; resolves stdout. */
function proc(cmd, args, { onProgress, signal, cwd, env, tqdm = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...env } });
    let out = "", err = "", line = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      err = (err + s).slice(-8000);
      line += s;
      const parts = line.split(/\r?\n|\r/); // tqdm redraws its bar after a bare \r
      line = parts.pop();
      for (const l of parts) {
        const m = /^PROGRESS ([\d.]+)/.exec(l), bar = tqdm && /(\d{1,3})%\|/.exec(l);
        if (m) onProgress?.(Number(m[1]));
        else if (bar) onProgress?.(Number(bar[1]) / 100);
      }
    });
    const kill = () => child.kill();
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => reject(new AppError("PROVIDER", "err.dubFailed", { message: e.message })));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) reject(new AppError("CONFLICT", "err.cancelled", { cancelled: true }));
      else if (code === 0) resolve(out);
      else reject(new AppError("PROVIDER", "err.dubFailed", { code, output: err.slice(-1500) }));
    });
  });
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

export class DubService {
  constructor({ repos, paths, notify = () => {}, log = () => {} }) {
    this.repos = repos;
    this.paths = paths;
    this.notify = notify;
    this.log = log;
  }

  parts() { return dubParts(this.paths.root); }

  /** { ready, missing: [part names] } */
  status() {
    const p = this.parts();
    const missing = Object.entries(p).filter(([, v]) => !v).map(([k]) => k);
    return { ready: !missing.length, missing, parts: p, languages: DUB_LANGUAGES };
  }

  /**
   * Expected seconds per stage for a media of `durationS`, from real runs on the development machine (RTX 4090; a
   * 150 s two-speaker video into English took 21 + 42 + 61 + 123 + 200 s): separation 10 s + 0.06 × duration; the
   * clean speech's words 10 s + 0.2 ×; speakers 15 s + 0.3 ×; translation 30 s + 0.65 ×; voices (each line spoken,
   * heard back, re-taken when needed, fitted to its time) 20 s + 1.2 ×. Cached stages cost ~1 s.
   */
  estimate(durationS, cached = {}) {
    const stages = [
      { key: "separate", sec: cached.separate ? 1 : 10 + 0.06 * durationS },
      { key: "words", sec: cached.words ? 1 : 10 + 0.2 * durationS },
      { key: "speakers", sec: cached.speakers ? 1 : 15 + 0.3 * durationS },
      { key: "translate", sec: 30 + 0.65 * durationS },
      { key: "voices", sec: 20 + 1.2 * durationS },
      { key: "timeline", sec: 3 },
    ];
    return { stages, totalSec: Math.round(stages.reduce((n, s) => n + s.sec, 0)) };
  }

  workDir(m) {
    let stamp = "";
    try { const st = fs.statSync(m.path); stamp = `${st.size}:${st.mtimeMs}`; } catch { /* missing file: reported later */ }
    return path.join(this.paths.cache, "dub", `${m.id}-${crypto.createHash("sha1").update(`${m.path}|${stamp}`).digest("hex").slice(0, 10)}`);
  }

  /** Is the audio-level work of this media already done (separation, words, speakers)? */
  cachedFor(m) {
    const w = this.workDir(m);
    return { separate: fs.existsSync(path.join(w, "vocals.wav")) && fs.existsSync(path.join(w, "other.wav")), words: fs.existsSync(path.join(w, "words.json")), speakers: fs.existsSync(path.join(w, "analysis.json")) };
  }

  /**
   * The spoken language of a media file: { language, p, arabic (0..1) } — cached; ~10 s the first time (Whisper
   * small, three 30 s windows of the sound).
   */
  async detect(mediaId, { signal } = {}) {
    const st = this.status();
    if (!st.parts.python) throw new AppError("PROVIDER", "err.dubNotReady", { missing: ["python"] });
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const work = this.workDir(m), file = path.join(work, "language.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    fs.mkdirSync(work, { recursive: true });
    const wav = path.join(work, "lid16.wav");
    await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", m.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { timeoutMs: 30 * 60_000, signal });
    try {
      const out = await proc(st.parts.python, ["-X", "utf8", DUB_SCRIPT, "langid", "--out", work, "--vocals", wav], { signal });
      const r = JSON.parse(out.trim().split(/\r?\n/).pop());
      fs.writeFileSync(file, JSON.stringify(r));
      return r;
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  /** The cached language of a media file, or null (never runs detection). */
  knownLanguage(m) {
    try { return JSON.parse(fs.readFileSync(path.join(this.workDir(m), "language.json"), "utf8")); } catch { return null; }
  }

  /** Start the local translator; resolves { url, stop }. Tries the GPU, then the CPU alone. */
  async startTranslator(p, signal) {
    for (const gpu of [true, false]) {
      const port = await freePort();
      const args = ["-m", p.translator, "--host", "127.0.0.1", "--port", String(port), "-c", "16384", "--jinja", "-t", "16", ...(gpu ? ["-ngl", "99", "--n-cpu-moe", "16"] : ["-ngl", "0"])];
      const child = spawn(p.llama, args, { windowsHide: true, cwd: path.dirname(p.llama) });
      let exited = false, tail = "";
      child.stderr.on("data", (d) => { tail = (tail + d.toString("utf8")).slice(-3000); });
      child.on("close", () => { exited = true; });
      const stop = () => { try { child.kill(); } catch { /* gone */ } };
      signal?.addEventListener("abort", stop, { once: true });
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 600 && !exited; i++) { // up to 5 minutes to load 22 GB
        if (signal?.aborted) { stop(); throw new AppError("CONFLICT", "err.cancelled", { cancelled: true }); }
        try { const r = await fetch(`${url}/health`); if (r.ok) return { url, stop, gpu }; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      stop();
      this.log("translator failed to start", gpu ? "(GPU)" : "(CPU)", tail.slice(-600));
    }
    throw new AppError("PROVIDER", "err.dubTranslator");
  }

  /**
   * Dub a media file. opts: { lang, context, duckDb }. onProgress(p 0..1, stage). Returns { work, lang, lines,
   * speakers, files: { voice, background, mix } }.
   */
  async dub(mediaId, opts = {}, { onProgress, signal } = {}) {
    const st = this.status();
    if (!st.ready) throw new AppError("PROVIDER", "err.dubNotReady", { missing: st.missing });
    const p = st.parts;
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const lang = DUB_LANGUAGES.includes(opts.lang) ? opts.lang : "en";
    const work = this.workDir(m);
    fs.mkdirSync(work, { recursive: true });
    const est = this.estimate(m.durationUs / US, this.cachedFor(m));
    let done = 0;
    // Each stage's real seconds go to timing.json (to check the estimate against real runs).
    const timing = {};
    let mark = { key: null, at: Date.now() };
    const stage = (key) => {
      if (mark.key) timing[mark.key] = Math.round((Date.now() - mark.at) / 100) / 10;
      mark = { key, at: Date.now() };
      const w = est.stages.find((s) => s.key === key).sec, base = done;
      done += w;
      const f = (x) => onProgress?.(Math.min(0.995, (base + w * Math.max(0, Math.min(1, x || 0))) / est.totalSec), key);
      f(0);
      return f;
    };
    const { ffmpeg } = binaries();

    // 0. Only Arabic speech is dubbed (the speech model, the speakers' analysis and the translation expect it).
    const sep = stage("separate");
    const spoken = await this.detect(m.id, { signal });
    if (spoken.arabic < 0.5 && !opts.force) throw new AppError("VALIDATION", "err.dubNotArabic", { language: spoken.language });
    sep(0.05);
    // 1. Speech and background apart.
    const vocals = path.join(work, "vocals.wav"), other = path.join(work, "other.wav");
    if (!fs.existsSync(vocals) || !fs.existsSync(other)) {
      const src = path.join(work, "source.wav");
      await run(ffmpeg, ["-hide_banner", "-y", "-i", m.path, "-vn", "-ac", "2", "-ar", "44100", src], { timeoutMs: 60 * 60_000, signal });
      sep(0.1);
      const outDir = path.join(work, "sep");
      fs.mkdirSync(outDir, { recursive: true });
      await proc(p.separator, [src, "-m", SEP_MODEL, "--model_file_dir", p.separationModels, "--output_dir", outDir, "--output_format", "WAV"], { signal, tqdm: true, onProgress: (x) => sep(0.1 + 0.85 * x) });
      const files = fs.readdirSync(outDir);
      const pick = (tag) => path.join(outDir, files.find((f) => f.includes(`(${tag})`)) || "");
      fs.renameSync(pick("vocals"), vocals);
      fs.renameSync(pick("other"), other);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(src, { force: true });
    }
    // 2. Words of the clean speech (the Egyptian model).
    const wr = stage("words");
    const wordsFile = path.join(work, "words.json");
    let cachedWords = null;
    try { cachedWords = JSON.parse(fs.readFileSync(wordsFile, "utf8")); } catch { /* none yet */ }
    if (!cachedWords?.snapped) {
      const v16 = path.join(work, "vocals16.wav");
      await run(ffmpeg, ["-hide_banner", "-y", "-i", vocals, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", v16], { timeoutMs: 30 * 60_000, signal });
      const raw = cachedWords || JSON.parse(await proc(p.asrPython, ["-X", "utf8", NEMO_SCRIPT, "--audio", v16, "--model", p.asrModel], { onProgress: wr, signal }));
      // Word times snapped to the sound, as the captions do (the model starts a word after a pause too early). The
      // speakers' analysis is built on them, so an older one goes too.
      fs.writeFileSync(wordsFile, JSON.stringify(snapWords(raw, wavEnvelope(v16))));
      fs.rmSync(v16, { force: true });
      fs.rmSync(path.join(work, "analysis.json"), { force: true });
    }
    // 3. Speakers.
    const sp = stage("speakers");
    if (!fs.existsSync(path.join(work, "analysis.json"))) await this.py(p, "analyze", work, ["--vocals", vocals, "--words", wordsFile, "--models", p.speakerModels], sp, signal);
    // 4–5. Translation and voices, in a folder per language (the speakers' analysis is shared; its voice samples are
    // absolute paths). The translator also shortens lines that come out too long.
    const out = this.langDir(work, lang);
    fs.copyFileSync(path.join(work, "analysis.json"), path.join(out, "analysis.json"));
    const tr = stage("translate");
    const server = await this.startTranslator(p, signal);
    try {
      await this.py(p, "translate", out, ["--lang", lang, "--server", server.url, ...(opts.context ? ["--context", String(opts.context).slice(0, 500)] : [])], tr, signal);
    } finally {
      server.stop(); // the voices get the GPU to themselves (sharing it made them ~9× slower)
    }
    const vo = stage("voices");
    await this.py(p, "synth", out, this.synthArgs(lang, "", work, opts), (x) => vo(0.85 * x), signal);
    await this.refit(p, out, lang, work, opts, signal, (x) => vo(0.85 + 0.15 * x));
    stage("timeline");
    fs.writeFileSync(path.join(out, "timing.json"), JSON.stringify({ durationS: m.durationUs / US, estimate: est, timing }));
    return this.result(out, lang);
  }

  /**
   * Lines the voices found too long or too short for their time (after speeding up or slowing down): the translator
   * says them shorter or fuller, then they are voiced again.
   */
  async refit(p, out, lang, work, opts, signal, report) {
    const file = path.join(out, "lines.json");
    if (!JSON.parse(fs.readFileSync(file, "utf8")).lines.some((l) => l.tooLong || l.tooShort)) return report(1);
    const server = await this.startTranslator(p, signal);
    try {
      await this.py(p, "refit", out, ["--lang", lang, "--server", server.url], (x) => report(0.4 * x), signal);
    } finally {
      server.stop();
    }
    await this.py(p, "synth", out, this.synthArgs(lang, "", work, opts), (x) => report(0.4 + 0.6 * x), signal);
  }

  langDir(work, lang) {
    const d = path.join(work, lang);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  py(p, stageName, out, args, report, signal) {
    return proc(p.python, ["-X", "utf8", DUB_SCRIPT, stageName, "--out", out, ...args], { onProgress: report, signal });
  }

  synthArgs(lang, serverUrl, work, opts = {}) {
    return ["--lang", lang, "--server", serverUrl, "--vocals", path.join(work, "vocals.wav"), "--background", path.join(work, "other.wav"), "--ffmpeg", binaries().ffmpeg, "--duck-db", String(opts.duckDb ?? 6)];
  }

  result(out, lang) {
    const data = JSON.parse(fs.readFileSync(path.join(out, "lines.json"), "utf8"));
    return { work: out, lang, lines: data.lines, speakers: data.speakers, summary: data.summary, files: { voice: path.join(out, "voice.wav"), background: path.join(out, "background.wav"), mix: path.join(out, "mix.wav") } };
  }

  /** The last dub of a media in a language, or null. */
  last(mediaId, lang) {
    const m = this.repos.media.get(mediaId);
    const out = path.join(this.workDir(m), lang);
    return fs.existsSync(path.join(out, "voice.wav")) ? this.result(out, lang) : null;
  }

  /**
   * Voice again after the user changed lines: edits [{ n, text?, emotion?, intensity?, speaker? }] (n = the line's
   * index). Every line is placed again (the timing of one line depends on the one before it).
   */
  async revoice(mediaId, lang, edits = [], opts = {}, { onProgress, signal } = {}) {
    const st = this.status();
    if (!st.ready) throw new AppError("PROVIDER", "err.dubNotReady", { missing: st.missing });
    const m = this.repos.media.get(mediaId);
    const work = this.workDir(m), out = path.join(work, lang), file = path.join(out, "lines.json");
    if (!fs.existsSync(file)) throw new AppError("NOT_FOUND", "err.dubNone");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ids = new Set(data.speakers.map((s) => s.id));
    for (const e of edits) {
      const l = data.lines[e.n];
      if (!l) continue;
      if (typeof e.text === "string" && e.text.trim()) { l.text = e.text.trim().slice(0, 400); delete l.spoken; l.edited = true; }
      if (typeof e.emotion === "string") l.emotion = e.emotion;
      if (Number.isFinite(e.intensity)) l.intensity = Math.max(0, Math.min(1, e.intensity));
      if (ids.has(e.speaker)) l.spk = e.speaker;
    }
    fs.writeFileSync(file, JSON.stringify(data));
    // No translator needed: the lines already spoken keep their fitted words, the edited ones are spoken as written.
    await this.py(st.parts, "synth", out, this.synthArgs(lang, "", work, opts), (x) => onProgress?.(Math.min(0.99, x), "voices"), signal);
    return this.result(out, lang);
  }
}
