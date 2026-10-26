// Music under speech ("music bed"): an audio track whose role is "music" (or "music:<dB>") is lowered under speech by
// that many dB — sidechain-style, from where words are heard on the timeline (the transcript's words, or a voice-activity
// reading of the sound when the file has no transcript) — with a fast attack before a word, a slower release after the
// phrase, and short pauses between phrases bridged so the music does not pump. Export and preview use the same spans
// and the same curve (duckExpr for FFmpeg, duckGainAt for the player). Pure functions; times in µs.
import { US, clamp } from "./util.js";
import { newTrack, newSegment, findSegment } from "./model.js";
import { AppError } from "./validation.js";

export const MUSIC_ROLE = "music";
export const DUCK_DEFAULT_DB = 12;
/** attack: the music is already down when a word starts; release: it comes back after the phrase; bridge: pauses
 * shorter than this stay ducked (no pumping between words). */
export const DUCK = { attackUs: 150_000, releaseUs: 500_000, bridgeUs: 700_000 };
/** A music bed sits this many LU under the speech between phrases (then DUCK_DEFAULT_DB more under the words). */
export const BED_GAP_LU = 16;
export const BED_FADE = { inUs: 1_500_000, outUs: 3_000_000 };

/** The role of a music track that ducks by `duckDb` (0 = a music track that does not duck). */
export function musicRole(duckDb = DUCK_DEFAULT_DB) {
  const db = clamp(Math.round(Number(duckDb) || 0), 0, 40);
  return db === DUCK_DEFAULT_DB ? MUSIC_ROLE : `${MUSIC_ROLE}:${db}`;
}

/** How much a track ducks under speech (dB), or null when it is not a music track. */
export function duckDbOf(track) {
  const m = /^music(?::(\d{1,2}))?$/.exec(track?.role || "");
  return m ? (m[1] === undefined ? DUCK_DEFAULT_DB : Number(m[1])) : null;
}
export const isMusicTrack = (t) => duckDbOf(t) !== null;

const isVoiceTrack = (t) => /^dub:.+:voice:/.test(t.role || "");

/**
 * Where speech is heard on the timeline: merged spans [[aUs, bUs]]. `regions`: mediaId → speech regions of the file in
 * source µs ([[a, b]], from core/speech.js speechRegions or a voice-activity reading), or null when unknown. Music
 * tracks, muted tracks and disabled clips are not speech; a dub's voice clips are speech as a whole.
 */
export function speechSpans(tl, regions, { bridgeUs = DUCK.bridgeUs } = {}) {
  const out = [];
  for (const t of tl.tracks || []) {
    if (t.muted || isMusicTrack(t) || !["video", "audio"].includes(t.type)) continue;
    for (const s of t.segments) {
      if (s.disabled || !s.mediaId || !["video", "audio"].includes(s.kind) || (s.kind === "video" && s.audioDetached)) continue;
      if (isVoiceTrack(t)) { out.push([s.start, s.start + s.duration]); continue; }
      const rs = regions?.[s.mediaId];
      if (!rs?.length) continue;
      const speed = s.speedMode === "curve" ? 1 : s.speed || 1;
      const from = s.sourceStart, to = s.sourceStart + s.duration * speed;
      for (const [a, b] of rs) {
        if (b <= from || a >= to) continue;
        out.push([s.start + (Math.max(a, from) - from) / speed, s.start + (Math.min(b, to) - from) / speed]);
      }
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of out) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] <= bridgeUs) last[1] = Math.max(last[1], b);
    else merged.push([Math.round(a), Math.round(b)]);
  }
  return merged;
}

/** How much of the duck applies at `tUs` (0..1): ramps up over the attack before a span, down over the release after. */
export function duckCover(spans, tUs, { attackUs = DUCK.attackUs, releaseUs = DUCK.releaseUs } = {}) {
  let c = 0;
  for (const [a, b] of spans) {
    if (tUs < a - attackUs) break;
    if (tUs > b + releaseUs) continue;
    c = Math.max(c, clamp((tUs - (a - attackUs)) / attackUs, 0, 1) * clamp((b + releaseUs - tUs) / releaseUs, 0, 1));
    if (c >= 1) return 1;
  }
  return c;
}

/** The music's gain factor at timeline time `tUs` (1 = untouched). */
export function duckGainAt(spans, tUs, duckDb = DUCK_DEFAULT_DB, o = DUCK) {
  if (!duckDb || !spans?.length) return 1;
  return 1 - (1 - 10 ** (-duckDb / 20)) * duckCover(spans, tUs, o);
}

/**
 * FFmpeg `volume` filter for a music clip that starts at timeline `segStartUs` and lasts `segDurUs`, with `tVar` the
 * clip-local time expression (seconds). The same curve as duckGainAt. Null when nothing is ducked in the clip.
 */
export function duckExpr(spans, segStartUs, segDurUs, tVar, duckDb = DUCK_DEFAULT_DB, { attackUs = DUCK.attackUs, releaseUs = DUCK.releaseUs } = {}) {
  if (!duckDb || !spans?.length) return null;
  const att = attackUs / US, rel = releaseUs / US, f = (x) => x.toFixed(3);
  const terms = [];
  for (const [a, b] of spans) {
    const la = (a - segStartUs) / US, lb = (b - segStartUs) / US;
    if (lb + rel < 0 || la - att > segDurUs / US) continue;
    terms.push(`clip((${tVar}-${f(la - att)})/${f(att)},0,1)*clip((${f(lb + rel)}-${tVar})/${f(rel)},0,1)`);
  }
  if (!terms.length) return null;
  return `volume='1-${(1 - 10 ** (-duckDb / 20)).toFixed(4)}*min(1,${terms.join("+")})':eval=frame`;
}

/** The bed's level (dB) from measured loudness: BED_GAP_LU under the speech; -18 dB when either is unknown. */
export function bedLevelDb({ musicLufs, speechLufs } = {}, gapLu = BED_GAP_LU) {
  if (!Number.isFinite(musicLufs) || !Number.isFinite(speechLufs) || musicLufs < -70 || speechLufs < -70) return -18;
  return Math.round(clamp(speechLufs - gapLu - musicLufs, -40, 6) * 10) / 10;
}

/** The edit's extent: [0, end of the last picture or speech clip]. */
export function editExtent(tl) {
  let end = 0;
  for (const t of tl.tracks || []) if (!isMusicTrack(t)) for (const s of t.segments) if (!s.disabled) end = Math.max(end, s.start + s.duration);
  return { startUs: 0, endUs: end };
}

/**
 * Where a music file goes under the edit: from `fromUs` to `toUs` (default the whole edit), starting `offsetUs` into the
 * file, cut to the file's length, with a fade in and a longer fade out (shortened on short beds). Returns the clip's
 * timing, or null when there is less than a second to fill.
 */
export function bedPlacement(tl, { fromUs = null, toUs = null, mediaDurationUs = null, offsetUs = 0 } = {}) {
  const ext = editExtent(tl);
  const a = Math.max(0, Math.round(fromUs ?? ext.startUs));
  let b = Math.round(toUs ?? ext.endUs);
  if (mediaDurationUs) b = Math.min(b, a + Math.max(0, mediaDurationUs - offsetUs));
  if (b - a < US) return null;
  const d = b - a;
  return { start: a, duration: d, sourceStart: Math.max(0, Math.round(offsetUs)), sourceDuration: d,
    fadeInUs: Math.min(BED_FADE.inUs, Math.round(d * 0.1)), fadeOutUs: Math.min(BED_FADE.outUs, Math.round(d * 0.2)) };
}

// ------------------------------------------------------------------ timeline edits (run inside a timeline commit)

const unlocked = (t) => { if (t.locked) throw new AppError("VALIDATION", "err.trackLocked"); };

/** Put a music file under the edit on a new music track (bedPlacement timing, `volumeDb` level). Returns the clip id. */
export function placeMusicBed(tl, media, { fromUs = null, toUs = null, offsetUs = 0, duckDb = DUCK_DEFAULT_DB, volumeDb = -18 } = {}) {
  if (!media || !["audio", "video"].includes(media.type)) throw new AppError("VALIDATION", "err.musicBedMedia");
  const p = bedPlacement(tl, { fromUs, toUs, mediaDurationUs: media.durationUs || null, offsetUs });
  if (!p) throw new AppError("VALIDATION", "err.musicBedShort");
  const track = newTrack("audio", { order: tl.tracks.length, name: "Music", role: musicRole(duckDb) });
  const seg = newSegment("audio", { mediaId: media.id, name: media.name, ...p, volumeDb: clamp(Number(volumeDb) || 0, -60, 12) });
  track.segments.push(seg);
  tl.tracks.push(track);
  return seg.id;
}

/**
 * Make a sound clip a music bed that ducks by `duckDb` under speech (null: an ordinary sound again). The setting is the
 * track's: a clip that shares its track with other sounds moves to its own music track first.
 */
export function setMusicDuck(tl, segId, duckDb) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  const { track, segment: seg } = f;
  unlocked(track);
  if (!["audio", "video"].includes(seg.kind) || track.isMain) throw new AppError("VALIDATION", "err.musicBedMedia");
  if (duckDb === null || duckDb === undefined) { if (isMusicTrack(track)) track.role = ""; return null; }
  const role = musicRole(duckDb);
  if (isMusicTrack(track) || (track.type === "audio" && !track.role && track.segments.length === 1)) { track.role = role; return duckDbOf(track); }
  track.segments = track.segments.filter((s) => s.id !== seg.id);
  const own = newTrack(track.type, { order: tl.tracks.length, name: "Music", role });
  own.segments.push(seg);
  tl.tracks.push(own);
  return duckDbOf(own);
}
