// Music under speech in the editor (main process): where speech is heard on a timeline (the transcript's words, else a
// voice-activity reading of the sound, cached), putting a music file under the edit as a ducking music bed at a level
// measured against the speech, and the spans the export and the preview duck under (core/musicBed.js has the curve).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AppError } from "../core/validation.js";
import { US } from "../core/util.js";
import { speechRegions } from "../core/speech.js";
import { speechSpans, isMusicTrack, bedLevelDb, placeMusicBed, setMusicDuck, DUCK_DEFAULT_DB } from "../core/musicBed.js";
import { binaries, run } from "./ffmpeg.js";

/** Sounds that are never read as speech when their words are unknown (music, effects). */
const NOT_SPEECH = new Set(["music", "sfx", "library"]);

/**
 * Voice activity of a mono signal (energy, 20 ms frames): above max(noise floor + 10 dB, loud level − 30 dB), short
 * gaps closed (200 ms), blips dropped (< 150 ms). Returns [[aUs, bUs]]. A fallback for files without a transcript: it
 * hears any sound, not only words.
 */
export function energyVad(samples, rate, { frameMs = 20, gapMs = 200, minMs = 150, padMs = 80 } = {}) {
  const n = Math.max(1, Math.round((rate * frameMs) / 1000));
  const db = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let e = 0;
    for (let k = i; k < i + n; k++) e += samples[k] * samples[k];
    db.push(10 * Math.log10(e / n + 1e-12));
  }
  if (!db.length) return [];
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)], loud = sorted[Math.floor(sorted.length * 0.95)];
  const thr = Math.max(floor + 10, loud - 30, -60);
  const out = [];
  let a = null;
  for (let i = 0; i <= db.length; i++) {
    const on = i < db.length && db[i] > thr;
    if (on && a === null) a = i;
    if (!on && a !== null) { out.push([a, i]); a = null; }
  }
  const merged = [];
  for (const [x, y] of out) {
    const last = merged[merged.length - 1];
    if (last && (x - last[1]) * frameMs < gapMs) last[1] = y; else merged.push([x, y]);
  }
  return merged.filter(([x, y]) => (y - x) * frameMs >= minMs).map(([x, y]) => [Math.max(0, (x * frameMs - padMs) * 1000), (y * frameMs + padMs) * 1000]);
}

export class MusicBedService {
  constructor({ repos, paths, timelines, captions = null, media = null, log = () => {} }) {
    Object.assign(this, { repos, paths, timelines, captions, media, log });
    this.dir = path.join(paths.cache, "vad");
    this.mem = new Map(); // mediaId → { key, regions, source }
  }

  /** Speech regions of a media file (source µs) and how they were found: "words", "vad" or null (unknown). */
  regionsOf(mediaId) {
    const words = this.captions?.cachedWords?.(mediaId);
    if (words?.length) return { regions: speechRegions(words), source: "words" };
    let m;
    try { m = this.repos.media.get(mediaId); } catch { return { regions: null, source: null }; }
    if (!m?.hasAudio || !fs.existsSync(m.path) || NOT_SPEECH.has(m.origin)) return { regions: null, source: null };
    let key = "";
    try { const st = fs.statSync(m.path); key = `${m.path}|${st.size}|${st.mtimeMs}`; } catch { return { regions: null, source: null }; }
    const hit = this.mem.get(mediaId);
    if (hit?.key === key) return hit;
    const file = path.join(this.dir, `${mediaId}.json`);
    try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (c.key === key) { this.mem.set(mediaId, c); return c; } } catch { /* not yet */ }
    const r = spawnSync(binaries().ffmpeg, ["-hide_banner", "-v", "error", "-i", m.path, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 30, windowsHide: true });
    if (r.status !== 0 || !r.stdout?.length) return { regions: null, source: null };
    const a = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
    const c = { key, regions: energyVad(a, 8000), source: "vad" };
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c)); } catch { /* read-only: recompute next time */ }
    this.mem.set(mediaId, c);
    return c;
  }

  /** Where speech is heard on a timeline: { spans: [[aUs, bUs]], sources: { mediaId: "words" | "vad" | null } }. */
  speech(tl) {
    const regions = {}, sources = {};
    for (const t of tl.tracks) {
      if (t.muted || isMusicTrack(t)) continue;
      for (const s of t.segments) if (s.mediaId && regions[s.mediaId] === undefined && ["video", "audio"].includes(s.kind)) {
        const r = this.regionsOf(s.mediaId);
        regions[s.mediaId] = r.regions;
        sources[s.mediaId] = r.source;
      }
    }
    return { spans: speechSpans(tl, regions), sources };
  }

  /** For the export: the spans music beds duck under, or null when the timeline has no music bed. */
  forExport(tl) {
    if (!tl.tracks.some((t) => isMusicTrack(t) && t.segments.length)) return null;
    return { spans: this.speech(tl).spans };
  }

  speechOf(timelineId) { const { timeline } = this.timelines.get(timelineId); return this.speech(timeline); }

  /** Integrated loudness (LUFS) of a file's first `seconds` (EBU R128; silence gated), or NaN. */
  async loudness(file, fromUs = 0, seconds = 120) {
    const { stderr } = await run(binaries().ffmpeg, ["-hide_banner", "-nostats", "-ss", String(fromUs / US), "-t", String(seconds), "-i", file, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { timeoutMs: 5 * 60_000 });
    const m = [...String(stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
    return m ? Number(m[1]) : NaN;
  }

  /** The level (dB) for a music clip: BED_GAP_LU under the timeline's speech (its longest speaking clip). */
  async levelFor(tl, musicMedia, offsetUs = 0) {
    let speaker = null, best = 0;
    for (const t of tl.tracks) if (!t.muted && !isMusicTrack(t)) for (const s of t.segments) {
      if (!s.mediaId || s.disabled || !["video", "audio"].includes(s.kind) || s.mediaId === musicMedia.id) continue;
      const r = this.regionsOf(s.mediaId);
      if (r.regions?.length && s.duration > best) { best = s.duration; speaker = s; }
    }
    if (!speaker) return { volumeDb: -18, measured: null };
    const sm = this.repos.media.get(speaker.mediaId);
    const [musicLufs, speechLufs] = await Promise.all([this.loudness(musicMedia.path, offsetUs), this.loudness(sm.path, speaker.sourceStart)]);
    return { volumeDb: bedLevelDb({ musicLufs, speechLufs }), measured: { musicLufs, speechLufs } };
  }

  /**
   * Put a project's sound (mediaId) or a music-library result (libraryId, added to the project first) under the edit.
   * o: { projectId, fromUs, toUs, offsetUs, duckDb, autoLevel (default true), volumeDb }. One undo step.
   */
  async place(timelineId, o = {}) {
    let mediaId = o.mediaId;
    if (!mediaId && o.libraryId) {
      if (!this.media || !o.projectId) throw new AppError("VALIDATION", "err.musicBedMedia");
      const x = this.repos.library.list({ kind: "audio" }).find((i) => i.id === o.libraryId);
      if (!x) throw new AppError("NOT_FOUND", "err.notFound");
      const have = this.repos.media.listByProject(o.projectId, {}).find((m) => m.path === x.path);
      mediaId = have?.id || (await this.media.importFiles(o.projectId, [x.path], { origin: "music" })).imported[0]?.id;
    }
    if (!mediaId) throw new AppError("VALIDATION", "err.musicBedMedia");
    const media = this.repos.media.get(mediaId);
    const { timeline } = this.timelines.get(timelineId);
    const level = o.autoLevel === false ? { volumeDb: o.volumeDb ?? -18, measured: null } : await this.levelFor(timeline, media, o.offsetUs || 0);
    const res = this.timelines.commit(timelineId, "musicBed", (tl) => placeMusicBed(tl, media, { fromUs: o.fromUs ?? null, toUs: o.toUs ?? null, offsetUs: o.offsetUs || 0, duckDb: o.duckDb ?? DUCK_DEFAULT_DB, volumeDb: level.volumeDb }));
    return { ...res, level };
  }

  /** Re-measure a music clip's level against the speech and set it (one undo step). */
  async autoLevel(timelineId, segId) {
    const { timeline } = this.timelines.get(timelineId);
    const seg = timeline.tracks.flatMap((t) => t.segments).find((s) => s.id === segId);
    if (!seg?.mediaId) throw new AppError("NOT_FOUND", "err.segmentNotFound");
    const level = await this.levelFor(timeline, this.repos.media.get(seg.mediaId), seg.sourceStart);
    const res = this.timelines.exec(timelineId, "updateSegment", { segId, patch: { volumeDb: level.volumeDb } });
    return { ...(await res), level };
  }

  /** Make a sound clip duck under speech by `duckDb` (null: an ordinary sound again). One undo step. */
  setDuck(timelineId, segId, duckDb) {
    return this.timelines.commit(timelineId, "musicDuck", (tl) => setMusicDuck(tl, segId, duckDb === null || duckDb === undefined ? null : Number(duckDb)));
  }
}
