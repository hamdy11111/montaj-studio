// Local signal analysis used by "AI" features that can be reproduced without cloud models:
//  Split scenes (FEAT-110), AI clipper / Long video to shorts (FEAT-018/106), Smart suggestions & Global edits
//  (FEAT-099), silence removal for EditPilot (FEAT-098). All FFmpeg-based, deterministic, offline.
import { run, binaries } from "./ffmpeg.js";
import { AppError } from "../core/validation.js";
import { US, clamp } from "../core/util.js";
import { mainTrack } from "../core/model.js";

export class AnalysisService {
  constructor({ repos }) { this.repos = repos; }

  media(id) {
    const m = this.repos.media.get(id);
    if (m.status === "missing") throw new AppError("MEDIA", "err.mediaMissing");
    return m;
  }

  /** Scene cut times (µs, source time) using FFmpeg's scene score. */
  async scenes(mediaId, { threshold = 0.35, fromUs = 0, durUs = null } = {}) {
    const m = this.media(mediaId);
    if (m.type !== "video") throw new AppError("VALIDATION", "err.analysisKind");
    const { ffmpeg } = binaries();
    const win = ["-ss", String(fromUs / US), ...(durUs ? ["-t", String(durUs / US)] : [])];
    const { stderr } = await run(ffmpeg, ["-hide_banner", ...win, "-i", m.path, "-vf", `scale=320:-2,select='gt(scene,${clamp(threshold, 0.05, 0.95)})',showinfo`, "-an", "-f", "null", "-"], { timeoutMs: 15 * 60_000 });
    return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((x) => Math.round(Number(x[1]) * US + fromUs));
  }

  /** Silent ranges [[startUs, endUs]] in source time. */
  async silences(mediaId, { noiseDb = -35, minDurS = 0.5, fromUs = 0, durUs = null } = {}) {
    const m = this.media(mediaId);
    if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
    const { ffmpeg } = binaries();
    const win = ["-ss", String(fromUs / US), ...(durUs ? ["-t", String(durUs / US)] : [])];
    const { stderr } = await run(ffmpeg, ["-hide_banner", ...win, "-i", m.path, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurS}`, "-f", "null", "-"], { timeoutMs: 15 * 60_000 });
    const starts = [...stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((x) => Number(x[1]));
    const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((x) => Number(x[1]));
    const total = (durUs ?? m.durationUs - fromUs) / US;
    return starts.map((s0, i) => [Math.round(Math.max(0, s0) * US + fromUs), Math.round((ends[i] ?? total) * US + fromUs)]);
  }

  /** Integrated loudness (LUFS) of a source span. */
  async loudness(mediaId, { fromUs = 0, durUs = null } = {}) {
    const m = this.media(mediaId);
    if (!m.hasAudio) return null;
    const { ffmpeg } = binaries();
    const win = ["-ss", String(fromUs / US), ...(durUs ? ["-t", String(durUs / US)] : [])];
    const { stderr } = await run(ffmpeg, ["-hide_banner", ...win, "-i", m.path, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { timeoutMs: 15 * 60_000 });
    const i = /I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf("Summary")));
    return i ? Number(i[1]) : null;
  }

  /** Average luma (0..255) and saturation of a source span (signalstats on a 1fps sample). */
  async colorStats(mediaId, { fromUs = 0, durUs = null } = {}) {
    const m = this.media(mediaId);
    if (m.type === "audio") return null;
    const { ffmpeg } = binaries();
    const win = m.type === "image" ? [] : ["-ss", String(fromUs / US), ...(durUs ? ["-t", String(durUs / US)] : [])];
    const { stderr } = await run(ffmpeg, ["-hide_banner", ...win, "-i", m.path, "-vf", "fps=1,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG,metadata=print:key=lavfi.signalstats.SATAVG", "-an", "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
    const avg = (re) => { const v = [...stderr.matchAll(re)].map((x) => Number(x[1])); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return { luma: avg(/YAVG=([\d.]+)/g), saturation: avg(/SATAVG=([\d.]+)/g) };
  }

  /** Smart suggestions for a timeline (report: «Find out how your video can be improved»). */
  async suggestions(tl) {
    const main = mainTrack(tl);
    const clips = main.segments.filter((s) => s.kind === "video" || s.kind === "image");
    const out = [];
    const louds = [];
    const stats = [];
    for (const s of clips) {
      const span = { fromUs: s.sourceStart, durUs: Math.max(US, s.duration * (s.speed || 1)) };
      if (s.kind === "video") { const l = await this.loudness(s.mediaId, span).catch(() => null); if (l !== null && Number.isFinite(l)) louds.push({ segId: s.id, lufs: l }); }
      const c = await this.colorStats(s.mediaId, s.kind === "image" ? {} : span).catch(() => null);
      if (c?.luma !== null && c) stats.push({ segId: s.id, ...c });
    }
    if (louds.length >= 2) {
      const spread = Math.max(...louds.map((x) => x.lufs)) - Math.min(...louds.map((x) => x.lufs));
      if (spread > 4) out.push({ id: "volumeConsistent", spreadDb: Number(spread.toFixed(1)) });
    }
    if (louds.some((x) => x.lufs < -30)) out.push({ id: "voiceClearer" });
    if (stats.length >= 2) {
      const lumas = stats.map((x) => x.luma);
      if (Math.max(...lumas) - Math.min(...lumas) > 25) out.push({ id: "colorsConsistent" });
    }
    if (stats.some((x) => x.luma < 70 || x.saturation < 25)) out.push({ id: "colorsBetter" });
    return { suggestions: out, loudness: louds, color: stats };
  }

  /** Patches for Global edits (applied by the renderer through timeline commands, so they are undoable). */
  async globalEditPatches(tl, kind, settings) {
    const main = mainTrack(tl);
    const clips = main.segments.filter((s) => s.kind === "video" || s.kind === "image");
    const patches = [];
    if (kind === "volumeConsistent") {
      const target = settings.get("edit").targetLufs ?? -23;
      for (const s of clips.filter((c) => c.kind === "video")) {
        const l = await this.loudness(s.mediaId, { fromUs: s.sourceStart, durUs: s.duration * (s.speed || 1) }).catch(() => null);
        if (l !== null && Number.isFinite(l)) patches.push({ segId: s.id, patch: { volumeDb: clamp(Number((target - l).toFixed(1)), -60, 20) } });
      }
    } else if (kind === "colorsConsistent" || kind === "colorsBetter") {
      const stats = [];
      for (const s of clips) { const c = await this.colorStats(s.mediaId, s.kind === "image" ? {} : { fromUs: s.sourceStart, durUs: s.duration * (s.speed || 1) }).catch(() => null); if (c?.luma) stats.push({ s, ...c }); }
      const refL = kind === "colorsBetter" ? 118 : stats.reduce((a, x) => a + x.luma, 0) / Math.max(1, stats.length);
      const refS = kind === "colorsBetter" ? 45 : stats.reduce((a, x) => a + x.saturation, 0) / Math.max(1, stats.length);
      for (const x of stats) {
        const brightness = clamp(Math.round(((refL - x.luma) / 255) * 333 * 0.8), -60, 60);
        const saturation = clamp(Math.round(((refS - x.saturation) / Math.max(10, x.saturation)) * 60), -50, 60);
        patches.push({ segId: x.s.id, patch: { adjust: { brightness, saturation, contrast: kind === "colorsBetter" ? 8 : x.s.adjust?.contrast || 0 } } });
      }
    } else if (kind === "voiceClearer") {
      for (const s of clips.filter((c) => c.kind === "video")) patches.push({ segId: s.id, patch: { audioFx: { denoise: { enabled: true }, enhanceVoice: { enabled: true } } } });
    } else if (kind === "videoClearer") {
      for (const s of clips) patches.push({ segId: s.id, patch: { adjust: { sharpen: 25 }, videoFx: { denoise: { enabled: true, level: 30 } } } });
    } else {
      throw new AppError("VALIDATION", "err.enum", { field: "kind" });
    }
    return patches;
  }

  /**
   * Long video → shorts (local alternative): candidate clips of 15–60 s bounded by scene cuts and pauses,
   * ranked by speech density (less silence first).
   */
  async shortsCandidates(mediaId, { minS = 15, maxS = 60, count = 5 } = {}) {
    const m = this.media(mediaId);
    if (m.type !== "video") throw new AppError("VALIDATION", "err.analysisKind");
    if (m.durationUs > 180 * 60 * US) throw new AppError("VALIDATION", "err.videoTooLong", { maxMinutes: 180 });
    const cuts = await this.scenes(mediaId, { threshold: 0.4 }).catch(() => []);
    const sil = m.hasAudio ? await this.silences(mediaId, { noiseDb: -35, minDurS: 0.6 }).catch(() => []) : [];
    const bounds = [...new Set([0, ...cuts, ...sil.map((r) => r[1]), m.durationUs])].sort((a, b) => a - b);
    const candidates = [];
    for (let i = 0; i < bounds.length; i++) {
      for (let j = i + 1; j < bounds.length; j++) {
        const d = bounds[j] - bounds[i];
        if (d < minS * US) continue;
        if (d > maxS * US) break;
        const silent = sil.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, bounds[j]) - Math.max(a, bounds[i])), 0);
        candidates.push({ startUs: bounds[i], endUs: bounds[j], speechRatio: 1 - silent / d });
        break;
      }
    }
    if (!candidates.length && m.durationUs >= minS * US) {
      for (let t = 0; t + minS * US <= m.durationUs && candidates.length < count; t += Math.min(maxS, 30) * US) candidates.push({ startUs: t, endUs: Math.min(m.durationUs, t + Math.min(maxS, 30) * US), speechRatio: 1 });
    }
    return candidates.sort((a, b) => b.speechRatio - a.speechRatio).slice(0, count).sort((a, b) => a.startUs - b.startUs);
  }
}
