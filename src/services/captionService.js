// Captions (FEAT-083..088): import SRT/VTT into caption text clips, and Auto captions through a LOCAL
// whisper.cpp executable + model configured by the user (Settings › Providers). No cloud service is used.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseSrt } from "../core/srt.js";
import { run, binaries } from "./ffmpeg.js";
import { AppError } from "../core/validation.js";
import { newSegment, DEFAULT_TEXT } from "../core/model.js";
import { uid, US } from "../core/util.js";
import { TEXT_PRESETS } from "../core/presets.js";

export class CaptionService {
  constructor({ repos, paths, settings }) {
    this.repos = repos;
    this.paths = paths;
    this.settings = settings;
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

  providerStatus() {
    const p = this.settings.get("providers");
    const ok = !!p.whisperPath && fs.existsSync(p.whisperPath) && !!p.whisperModel && fs.existsSync(p.whisperModel);
    return { autoCaptions: ok, whisperPath: p.whisperPath, whisperModel: p.whisperModel };
  }

  /** Auto captions for one media span; returns cues in timeline time. */
  async transcribe({ mediaId, sourceStartUs = 0, durationUs = null, timelineStartUs = 0, speed = 1, language = "auto", signal } = {}) {
    const status = this.providerStatus();
    if (!status.autoCaptions) throw new AppError("PROVIDER", "err.whisperNotConfigured");
    const m = this.repos.media.get(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const work = path.join(this.paths.cache, `asr-${uid()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const wav = path.join(work, "audio.wav");
      await run(binaries().ffmpeg, ["-hide_banner", "-y", "-ss", String(sourceStartUs / US), ...(durationUs ? ["-t", String((durationUs * speed) / US)] : []), "-i", m.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { timeoutMs: 30 * 60_000, signal });
      const base = path.join(work, "out");
      await new Promise((resolve, reject) => {
        const lang = /^[a-z]{2}$|^auto$/.test(language) ? language : "auto";
        const child = spawn(status.whisperPath, ["-m", status.whisperModel, "-f", wav, "-l", lang, "-osrt", "-of", base], { windowsHide: true });
        let err = "";
        child.stderr.on("data", (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
        signal?.addEventListener("abort", () => child.kill(), { once: true });
        child.on("error", (e) => reject(new AppError("PROVIDER", "err.whisperFailed", { message: e.message })));
        child.on("close", (code) => (code === 0 ? resolve() : reject(new AppError("PROVIDER", "err.whisperFailed", { code, stderr: err.slice(-1500) }))));
      });
      const cues = parseSrt(fs.readFileSync(`${base}.srt`, "utf8"));
      return cues.map((c) => ({ ...c, startUs: timelineStartUs + c.startUs / speed, endUs: timelineStartUs + c.endUs / speed }));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
