// Pure timeline operations (FEAT-019..035). Every function takes a timeline object, mutates it in place and
// returns a result; callers clone first (the timeline service does) so history snapshots stay intact.
import { uid, US, clamp, deepClone } from "./util.js";
import { newSegment, newTrack, TRACK_ACCEPTS, KIND_TO_TRACK, findSegment, mainTrack, sortSegments, timelineDuration, DEFAULT_TEXT } from "./model.js";
import { timelineDurationFor } from "./speed.js";
import { AppError } from "./validation.js";
import { BEHIND, isBehindTrack, canGoBehind } from "./cutout.js";

export const MIN_DUR = Math.round(US / 30); // one frame at 30fps
const end = (s) => s.start + s.duration;
const overlaps = (a, b) => a.start < end(b) && b.start < end(a);

function assertUnlocked(track) {
  if (track.locked) throw new AppError("VALIDATION", "err.trackLocked");
}

/** Pack main-track clips back-to-back from 0 (Main track magnet, shortcut P). Returns {segId: deltaUs}. */
export function packMainTrack(tl) {
  const main = mainTrack(tl);
  const deltas = {};
  if (!main) return deltas;
  sortSegments(main);
  let t = 0;
  for (const s of main.segments) {
    if (s.start !== t) deltas[s.id] = t - s.start;
    s.start = t;
    t += s.duration;
  }
  return deltas;
}

/** Items "attached" to main-track clips for Linkage (FEAT-024/132): start falls inside the clip's span. */
export function linkedItems(tl, linkTypes) {
  const main = mainTrack(tl);
  const map = {};
  if (!main || !linkTypes?.length) return map;
  for (const t of tl.tracks) {
    if (t.isMain || !linkTypes.includes(t.type)) continue;
    for (const s of t.segments) {
      const anchor = main.segments.find((m) => s.start >= m.start && s.start < end(m));
      if (anchor) (map[anchor.id] ||= []).push(s.id);
    }
  }
  return map;
}

function applyLinkageShift(tl, attached, deltas) {
  for (const [anchorId, ids] of Object.entries(attached)) {
    const d = deltas[anchorId];
    if (!d) continue;
    for (const id of ids) {
      const f = findSegment(tl, id);
      if (f && !f.track.locked) f.segment.start = Math.max(0, f.segment.start + d);
    }
  }
  resolveOverlaps(tl);
}

/**
 * After a ripple move, linked layers that now overlap another layer on their track (e.g. a long text whose anchor
 * clip was deleted, reached by the texts after it) move to a free track of the same type instead of making the
 * whole edit fail — the layer keeps its time.
 */
export function resolveOverlaps(tl) {
  for (const t of [...tl.tracks]) {
    if (t.isMain || t.locked) continue;
    sortSegments(t);
    for (let i = 1; i < t.segments.length; i++) {
      const prev = t.segments[i - 1], s = t.segments[i];
      if (!overlaps(prev, s)) continue;
      t.segments.splice(i, 1); i--;
      trackFor(tl, t.type, s.start, s.duration).segments.push(s);
    }
  }
}

/** Run an edit with optional magnet + linkage handling around it. */
export function withMagnet(tl, opts, fn) {
  const attached = opts?.linkage ? linkedItems(tl, opts.linkTypes) : {};
  const before = Object.fromEntries((mainTrack(tl)?.segments || []).map((s) => [s.id, s.start]));
  const result = fn();
  let deltas = {};
  if (opts?.magnet !== false) deltas = packMainTrack(tl);
  // Combine moves done by fn and by packing for linkage.
  for (const s of mainTrack(tl)?.segments || []) {
    if (before[s.id] !== undefined && before[s.id] !== s.start) deltas[s.id] = s.start - before[s.id];
  }
  applyLinkageShift(tl, attached, deltas);
  cleanupTracks(tl);
  return result;
}

/** Remove empty non-main tracks and renumber order. */
export function cleanupTracks(tl) {
  tl.tracks = tl.tracks.filter((t) => t.isMain || t.segments.length > 0);
  tl.tracks.sort((a, b) => a.order - b.order).forEach((t, i) => { t.order = i; sortSegments(t); });
}

/** Find a track of `type` free over [start, start+dur) or create a new one above. */
export function trackFor(tl, type, start, dur, excludeId) {
  const probe = { start, duration: dur };
  // Tracks with a role (behind the person) only take what is put there on purpose.
  const candidates = tl.tracks.filter((t) => t.type === type && !t.isMain && !t.locked && !t.role).sort((a, b) => a.order - b.order);
  for (const t of candidates) if (!t.segments.some((s) => s.id !== excludeId && overlaps(s, probe))) return t;
  const track = newTrack(type, { order: tl.tracks.length });
  tl.tracks.push(track);
  return track;
}

/** Build a segment from a media asset (video/image/audio). */
export function segmentFromMedia(media, settings = {}) {
  const kind = media.type === "audio" ? "audio" : media.type === "image" ? "image" : "video";
  const dur = kind === "image" ? (settings.imageDurationUs || 5 * US) : Math.max(MIN_DUR, media.durationUs);
  return newSegment(kind, { mediaId: media.id, name: media.name, duration: dur, sourceStart: 0, sourceDuration: kind === "image" ? 0 : media.durationUs });
}

/** FEAT-019: add media to the end of the main track (video/image) or at `atUs` on a free track. */
export function addMediaSegment(tl, media, { atUs = null, toMain = true, settings = {}, magnet = true } = {}) {
  const seg = segmentFromMedia(media, settings);
  if (seg.kind === "audio") {
    seg.start = atUs ?? 0;
    trackFor(tl, "audio", seg.start, seg.duration).segments.push(seg);
  } else if (toMain) {
    const main = mainTrack(tl);
    assertUnlocked(main);
    if (atUs === null) seg.start = timelineEndOf(main);
    else if (magnet) {
      // Insert at the clip boundary nearest atUs (between two clips); later clips move right by its length.
      const bounds = [0, ...main.segments.map((s) => end(s))];
      const at = bounds.reduce((b, x) => (Math.abs(x - atUs) < Math.abs(b - atUs) ? x : b), bounds[0]);
      for (const s of main.segments) if (s.start >= at) s.start += seg.duration;
      seg.start = at;
    } else seg.start = atUs;
    main.segments.push(seg);
    if (magnet) packMainTrack(tl);
  } else {
    seg.start = atUs ?? 0;
    trackFor(tl, "video", seg.start, seg.duration).segments.push(seg); // overlay (picture-in-picture)
  }
  cleanupTracks(tl);
  return seg;
}

/**
 * Put layers behind the person (or back in front): behind layers move to "behind" tracks right above the main
 * track, under every other track; the cutout of the person is drawn over them at render time (core/cutout.js).
 * Returns the ids moved.
 */
/**
 * Roles of a dub's tracks (no schema change): "dub:<the dubbed media id>:<part>", part = "orig" (the clip's own sound,
 * muted), "bg" (the background without the speech), "voice:<lang>" (one clip per line), "cap:<lang>" (the line's
 * words as text), "cap:ar" (the Arabic lines, hidden).
 */
export const dubRole = (mediaId, part = "") => (part ? `dub:${mediaId}:${part}` : `dub:${mediaId}`);
const isDubTrackOf = (t, mediaId) => t.role === `dub:${mediaId}` || (t.role || "").startsWith(`dub:${mediaId}:`);
/** The languages a media is dubbed into on this timeline, and the one heard. */
export function dubLanguages(tl, mediaId) {
  const voice = tl.tracks.filter((t) => (t.role || "").startsWith(`dub:${mediaId}:voice:`));
  return { langs: voice.map((t) => t.role.split(":").pop()), active: voice.find((t) => !t.muted)?.role.split(":").pop() || null };
}

/** Timeline time of a source time of the clips (constant speed), or null when that moment was cut out. */
function onTimeline(clips, srcUs) {
  for (const c of clips) {
    const speed = c.speedMode === "curve" ? 1 : c.speed || 1;
    if (srcUs >= c.sourceStart && srcUs < c.sourceStart + c.duration * speed) return { at: c.start + (srcUs - c.sourceStart) / speed, end: c.start + c.duration };
  }
  return null;
}

const SUBTITLE = { font: "IBM Plex Sans Arabic", size: 6.5, color: "#FFFFFF", bgColor: "#000000", bgOpacity: 60, bold: false, align: "center" };

/**
 * Put a dub of `sourceMediaId` into language `dub.lang` on the timeline, so every line can be seen, heard and moved:
 *   text   "cap:<lang>"  the dubbed lines as subtitles (shown while it is the language heard)
 *   text   "cap:ar"      the Arabic lines (hidden — to check each one has its dubbed line)
 *   audio  "orig"        the clips' own sound, muted (the clips' sound is turned off: audioDetached)
 *   audio  "voice:<lang>" one clip per line, at its line's moment, grouped with its subtitle (they move together)
 *   audio  "bg"          the background without the speech, following the clips
 * dub = { lang, voice: media, background: media, lines: [{ n, label, text, ar, arStart, arEnd, at, duration }] (µs, at =
 * where the line's voice starts in the source's time = in voice.wav), canvas }. Lines in a part of the video that was
 * cut are left out. Other languages stay (muted, their subtitles hidden). A line moved by hand keeps its shift when
 * the same language is dubbed again. Returns { voiceTrackId, lines placed }.
 */
export function applyDub(tl, sourceMediaId, dub) {
  const clips = tl.tracks.flatMap((t) => t.segments.filter((s) => s.mediaId === sourceMediaId && (s.kind === "video" || s.kind === "compound"))).sort((a, b) => a.start - b.start);
  if (!clips.length) throw new AppError("VALIDATION", "err.dubNoClip");
  const lang = dub.lang;
  const role = (part) => dubRole(sourceMediaId, part);
  // Shifts the user gave lines of this language (where each clip is now − where the dub put it).
  const shift = new Map();
  for (const s of tl.tracks.find((t) => t.role === role(`voice:${lang}`))?.segments || []) {
    const m = /^#(\d+)/.exec(s.name || ""), l = m && dub.lines.find((x) => x.n === Number(m[1]) - 1);
    const p = l && onTimeline(clips, l.at);
    if (p) shift.set(l.n, s.start - Math.round(p.at));
  }
  const keep = (t) => !isDubTrackOf(t, sourceMediaId) || ((/:voice:|:cap:/.test(t.role)) && !t.role.endsWith(`:${lang}`) && !t.role.endsWith(":cap:ar"));
  tl.tracks = tl.tracks.filter(keep);
  for (const t of tl.tracks) if (isDubTrackOf(t, sourceMediaId)) t[t.type === "audio" ? "muted" : "hidden"] = true; // other languages: off
  for (const c of clips) c.audioDetached = true;
  const add = (type, part, name, flags = {}) => { const t = newTrack(type, { order: tl.tracks.length, name, role: role(part) }); Object.assign(t, flags); tl.tracks.push(t); return t; };
  const mirror = (track, media, name, volumeDb = 0) => {
    for (const c of clips) {
      track.segments.push(newSegment("audio", { mediaId: media.id, name, start: c.start, duration: c.duration, sourceStart: c.sourceStart, sourceDuration: media.durationUs,
        speed: c.speed, speedMode: c.speedMode, curve: deepClone(c.curve), changePitch: c.changePitch, volumeDb }));
    }
  };
  const wide = !(dub.canvas && dub.canvas.height > dub.canvas.width);
  const capAr = add("text", "cap:ar", "AR", { hidden: true });
  const capLang = add("text", `cap:${lang}`, lang.toUpperCase());
  const orig = add("audio", "orig", "Original", { muted: true });
  mirror(orig, dub.source, "Original");
  const voice = add("audio", `voice:${lang}`, `Dub (${lang.toUpperCase()})`);
  const text = (content, rtl) => ({ ...DEFAULT_TEXT, ...SUBTITLE, content, direction: rtl ? "rtl" : "auto" });
  let placed = 0;
  for (const l of dub.lines) {
    const a = onTimeline(clips, l.arStart);
    if (a) {
      capAr.segments.push(newSegment("text", { name: (l.ar || "").slice(0, 40), start: Math.round(a.at), duration: Math.max(MIN_DUR, Math.min(l.arEnd - l.arStart, a.end - a.at)),
        text: text(l.ar || "", true), transform: { y: wide ? 0.24 : 0.18 } }));
    }
    const p = onTimeline(clips, l.at);
    if (!p || !l.duration) continue;
    const start = Math.max(0, Math.round(p.at) + (shift.get(l.n) || 0)), gid = uid();
    voice.segments.push(newSegment("audio", { mediaId: dub.voice.id, name: `#${l.n + 1} · ${l.label || ""}`.trim(), start, duration: Math.round(l.duration),
      sourceStart: Math.round(l.at), sourceDuration: dub.voice.durationUs, groupId: gid }));
    capLang.segments.push(newSegment("text", { name: (l.text || "").slice(0, 40), start, duration: Math.round(l.duration), groupId: gid,
      text: text(l.text || "", false), transform: { y: wide ? 0.38 : 0.3 } }));
    placed++;
  }
  mirror(add("audio", "bg", "Background"), dub.background, "Background");
  for (const t of [capAr, capLang, voice]) sortSegments(t);
  // Two lines never share a moment on the voice track (a hand-moved line may have drifted onto the next): the later
  // one goes to start where the earlier ends.
  for (let i = 1; i < voice.segments.length; i++) {
    const prev = voice.segments[i - 1], cur = voice.segments[i];
    if (cur.start < prev.start + prev.duration) {
      const to = prev.start + prev.duration;
      for (const s of [...voice.segments, ...capLang.segments]) if (s.groupId === cur.groupId) s.start = to;
    }
  }
  cleanupTracks(tl);
  return { voiceTrackId: voice.id, placed };
}

/** Which dubbed language is heard (its voice on, its subtitles shown); the others are muted and hidden. */
export function setDubLanguage(tl, sourceMediaId, lang) {
  const { langs } = dubLanguages(tl, sourceMediaId);
  if (!langs.includes(lang)) throw new AppError("VALIDATION", "err.dubNone");
  for (const t of tl.tracks) {
    const m = new RegExp(`^dub:${sourceMediaId}:(voice|cap):(.+)$`).exec(t.role || "");
    if (!m || m[2] === "ar") continue;
    t[m[1] === "voice" ? "muted" : "hidden"] = m[2] !== lang;
  }
  return lang;
}

/** Undo a dub of `sourceMediaId` (one language, or all): its tracks go; with none left, the clips' own sound comes back. */
export function removeDub(tl, sourceMediaId, lang = null) {
  if (lang) tl.tracks = tl.tracks.filter((t) => t.role !== dubRole(sourceMediaId, `voice:${lang}`) && t.role !== dubRole(sourceMediaId, `cap:${lang}`));
  const left = dubLanguages(tl, sourceMediaId).langs;
  if (!lang || !left.length) {
    tl.tracks = tl.tracks.filter((t) => !isDubTrackOf(t, sourceMediaId));
    for (const t of tl.tracks) for (const s of t.segments) if (s.mediaId === sourceMediaId && s.kind !== "audio") s.audioDetached = false;
  } else if (!dubLanguages(tl, sourceMediaId).active) setDubLanguage(tl, sourceMediaId, left[0]);
  cleanupTracks(tl);
}

export function setBehindPerson(tl, ids, behind = true) {
  const main = mainTrack(tl);
  const moved = [];
  for (const id of ids) {
    const f = findSegment(tl, id);
    if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound", { segId: id });
    const { track, segment: seg } = f;
    if (track.isMain || !canGoBehind(seg)) throw new AppError("VALIDATION", "err.cannotGoBehind", { segId: id, kind: seg.kind });
    if (isBehindTrack(track) === behind) continue;
    assertUnlocked(track);
    track.segments = track.segments.filter((s) => s.id !== id);
    const type = KIND_TO_TRACK[seg.kind];
    let dest;
    if (behind) {
      // A free behind track of this type, else a new one on top of the behind stack (still under everything else).
      const stack = tl.tracks.filter((t) => isBehindTrack(t)).sort((a, b) => a.order - b.order);
      dest = stack.find((t) => t.type === type && !t.locked && !t.segments.some((s) => overlaps(s, seg)));
      if (!dest) {
        const top = Math.max(main.order, ...stack.map((t) => t.order));
        dest = newTrack(type, { order: top + 0.5, role: BEHIND });
        tl.tracks.push(dest);
      }
    } else dest = trackFor(tl, type, seg.start, seg.duration);
    dest.segments.push(seg);
    moved.push(id);
  }
  cleanupTracks(tl);
  return moved;
}

/** Insert an already-built segment (text, sticker, effect, filter, adjust, audio...). */
export function addSegment(tl, seg, { trackId = null } = {}) {
  const type = KIND_TO_TRACK[seg.kind];
  let track = trackId ? tl.tracks.find((t) => t.id === trackId) : null;
  if (track && (!TRACK_ACCEPTS[track.type].includes(seg.kind) || track.segments.some((s) => overlaps(s, seg)))) track = null;
  if (!track) track = trackFor(tl, type, seg.start, seg.duration);
  assertUnlocked(track);
  track.segments.push(seg);
  cleanupTracks(tl);
  return seg;
}

const timelineEndOf = (track) => track.segments.reduce((m, s) => Math.max(m, end(s)), 0);

/** Split one segment at `atUs` (timeline time). Returns the new right-hand segment or null. */
export function splitSegment(tl, segId, atUs) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  const { track, segment: s } = f;
  assertUnlocked(track);
  if (atUs <= s.start + MIN_DUR / 2 || atUs >= end(s) - MIN_DUR / 2) return null;
  const local = atUs - s.start;
  const right = deepClone(s);
  right.id = uid();
  right.start = atUs;
  right.duration = s.duration - local;
  if (s.speedMode === "curve") {
    // Keep curves simple after a split: freeze each half at its average speed.
    const leftSrc = sourceSpan(s, 0, local), rightSrc = sourceSpan(s, local, s.duration);
    s.speedMode = right.speedMode = "standard";
    s.speed = leftSrc / local; right.speed = rightSrc / right.duration;
    right.sourceStart = s.sourceStart + leftSrc;
  } else if (s.kind === "video" || s.kind === "audio" || s.kind === "compound") {
    right.sourceStart = s.sourceStart + Math.round(local * (s.speed || 1));
  }
  s.duration = local;
  if (s.sourceDuration) { s.sourceDuration = Math.round(local * (s.speed || 1)); right.sourceDuration = Math.round(right.duration * (right.speed || 1)); }
  // Keyframes are distributed by time; animations/fades stay on the outer edges.
  right.keyframes = (s.keyframes || []).filter((k) => k.timeUs >= local).map((k) => ({ ...k, id: uid(), timeUs: k.timeUs - local }));
  s.keyframes = (s.keyframes || []).filter((k) => k.timeUs < local);
  right.fadeInUs = 0; s.fadeOutUs = 0;
  right.animation = { ...deepClone(s.animation), in: { ...s.animation.in, type: "none" } };
  s.animation = { ...s.animation, out: { ...s.animation.out, type: "none" } };
  right.transitionOut = deepClone(s.transitionOut);
  s.transitionOut = { type: "none", durationUs: s.transitionOut?.durationUs || 500_000 };
  track.segments.splice(f.index + 1, 0, right);
  return right;
}

function sourceSpan(s, a, b) {
  // Integral of speed between local a..b, using the generic chunker in speed.js would be circular here,
  // so approximate with 64 samples (only used when splitting curve-speed clips).
  const n = 64; let acc = 0;
  for (let i = 0; i < n; i++) {
    const t = a + ((b - a) * (i + 0.5)) / n;
    const x = clamp(t / s.duration, 0, 1);
    const pts = s.curve.points;
    let v = pts[pts.length - 1][1];
    for (let j = 1; j < pts.length; j++) if (x <= pts[j][0]) { const [x0, v0] = pts[j - 1], [x1, v1] = pts[j]; v = x1 === x0 ? v1 : v0 + ((v1 - v0) * (x - x0)) / (x1 - x0); break; }
    acc += v * ((b - a) / n);
  }
  return acc;
}

/** FEAT-020 Split / Split all at the playhead. ids omitted ⇒ every unlocked segment under the playhead. */
export function split(tl, atUs, ids = null) {
  const targets = [];
  for (const t of tl.tracks) {
    if (t.locked) continue;
    for (const s of t.segments) if ((!ids || ids.includes(s.id)) && atUs > s.start && atUs < end(s)) targets.push(s.id);
  }
  return targets.map((id) => splitSegment(tl, id, atUs)).filter(Boolean).map((s) => s.id);
}

/** FEAT-021 Delete segments; main-track gaps close when the magnet is on. */
export function deleteSegments(tl, ids, opts = {}) {
  return withMagnet(tl, { ...opts, magnet: opts.magnet !== false }, () => {
    let n = 0;
    for (const t of tl.tracks) {
      const before = t.segments.length;
      t.segments = t.segments.filter((s) => !(ids.includes(s.id) && !t.locked));
      n += before - t.segments.length;
    }
    return n;
  });
}

/** FEAT-021 Delete left (Q) / right (W) of the playhead within the selected clip. */
export function deleteSide(tl, segId, atUs, side, opts = {}) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  if (atUs <= f.segment.start || atUs >= end(f.segment)) return false;
  return withMagnet(tl, opts, () => {
    const right = splitSegment(tl, segId, atUs);
    if (!right) return false;
    const removeId = side === "left" ? segId : right.id;
    f.track.segments = f.track.segments.filter((s) => s.id !== removeId);
    return true;
  });
}

/**
 * Move a segment (and its group) to newStart, optionally onto another track. Main-track moves reorder clips.
 * Collisions on the target track push the segment to a fresh track (CapCut-like behaviour).
 */
export function moveSegment(tl, segId, newStart, targetTrackId = null, opts = {}) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  assertUnlocked(f.track);
  const s = f.segment;
  const delta = Math.round(newStart) - s.start;
  const group = s.groupId ? allSegments(tl).filter((x) => x.segment.groupId === s.groupId) : [f];
  return withMagnet(tl, opts, () => {
    // "new" = dropped above/below the existing tracks: use a free track of the right type (created if needed).
    let target = targetTrackId === "new" ? trackFor(tl, KIND_TO_TRACK[s.kind], Math.max(0, s.start + delta), s.duration, s.id)
      : targetTrackId ? tl.tracks.find((t) => t.id === targetTrackId) : f.track;
    if (!target || !TRACK_ACCEPTS[target.type].includes(s.kind) || target.locked) target = f.track;
    for (const g of group) {
      const seg = g.segment;
      seg.start = Math.max(0, seg.start + delta);
      const dest = g === f ? target : g.track;
      if (dest.isMain) {
        if (g.track !== dest) { g.track.segments = g.track.segments.filter((x) => x.id !== seg.id); dest.segments.push(seg); }
        if (opts.magnet !== false && g === f) {
          // Magnet reorder: the drop position picks an insertion slot — before the first other clip whose
          // midpoint lies after the dropped clip's left edge — and the track is laid out in that order.
          // (Sorting by start alone could never move a clip before its neighbour: ties keep the old order.)
          const others = dest.segments.filter((x) => x.id !== seg.id).sort((a, b) => a.start - b.start);
          const idx = others.findIndex((x) => x.start + x.duration / 2 > seg.start);
          const order = idx < 0 ? [...others, seg] : [...others.slice(0, idx), seg, ...others.slice(idx)];
          let t = 0;
          for (const x of order) { x.start = t; t += x.duration; }
          dest.segments = order;
          continue;
        }
        // Without the magnet: place by its new start; a clip dropped onto another main clip moves up to an
        // overlay track instead of overlapping.
        sortSegments(dest);
        if (opts.magnet === false && dest.segments.some((x) => x.id !== seg.id && overlaps(x, seg))) {
          dest.segments = dest.segments.filter((x) => x.id !== seg.id);
          trackFor(tl, "video", seg.start, seg.duration, seg.id).segments.push(seg);
        }
        continue;
      }
      const clash = dest.segments.some((x) => x.id !== seg.id && overlaps(x, seg));
      const finalTrack = clash ? trackFor(tl, dest.type, seg.start, seg.duration, seg.id) : dest;
      if (g.track !== finalTrack) {
        g.track.segments = g.track.segments.filter((x) => x.id !== seg.id);
        finalTrack.segments.push(seg);
      }
    }
    return s.start;
  });
}

/** Trim an edge (FEAT-020/021 handles, "Trim clip"). Bounded by source media length for video/audio. */
export function trimSegment(tl, segId, edge, newTimeUs, mediaDurationUs = null, opts = {}) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  assertUnlocked(f.track);
  const s = f.segment;
  const bounded = (s.kind === "video" || s.kind === "audio") && mediaDurationUs;
  const speed = s.speedMode === "curve" ? 1 : s.speed || 1;
  return withMagnet(tl, opts, () => {
    if (edge === "start") {
      let ns = Math.min(newTimeUs, end(s) - MIN_DUR);
      if (bounded) ns = Math.max(ns, s.start - s.sourceStart / speed);
      ns = Math.max(0, ns);
      const d = ns - s.start;
      s.start = ns;
      s.duration -= d;
      if (bounded || s.kind === "compound") s.sourceStart = Math.max(0, Math.round(s.sourceStart + d * speed));
      s.keyframes = (s.keyframes || []).map((k) => ({ ...k, timeUs: k.timeUs - d })).filter((k) => k.timeUs >= 0);
    } else {
      let ne = Math.max(newTimeUs, s.start + MIN_DUR);
      if (bounded) ne = Math.min(ne, s.start + (mediaDurationUs - s.sourceStart) / speed);
      s.duration = Math.round(ne - s.start);
      s.keyframes = (s.keyframes || []).filter((k) => k.timeUs <= s.duration);
    }
    if (s.sourceDuration) s.sourceDuration = Math.round(s.duration * speed);
    return { start: s.start, duration: s.duration };
  });
}

/** FEAT-067: constant speed; recomputes the timeline duration from the shown source span. */
export function setSpeed(tl, segId, speed, opts = {}) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  const s = f.segment;
  if (!["video", "audio", "compound"].includes(s.kind)) throw new AppError("VALIDATION", "err.speedKind");
  const srcSpan = s.speedMode === "curve" ? Math.round(s.duration * 1) : Math.round(s.duration * (s.speed || 1));
  return withMagnet(tl, opts, () => {
    s.speedMode = "standard";
    s.speed = clamp(speed, 0.1, 100);
    const old = s.duration;
    s.duration = timelineDurationFor(s, srcSpan);
    const ratio = s.duration / old;
    s.keyframes = (s.keyframes || []).map((k) => ({ ...k, timeUs: Math.round(k.timeUs * ratio) }));
    return s.duration;
  });
}

/** FEAT-068: speed curve; `points` normalized [[x, speed]]. Keeps the same source span. */
export function setCurve(tl, segId, preset, points, opts = {}) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  const s = f.segment;
  const srcSpan = s.speedMode === "curve" ? null : Math.round(s.duration * (s.speed || 1));
  return withMagnet(tl, opts, () => {
    const src = srcSpan ?? s.sourceDuration ?? s.duration;
    if (preset === "none") { s.speedMode = "standard"; s.speed = 1; s.curve = { preset: "none", points: [] }; s.duration = timelineDurationFor(s, src); return s.duration; }
    s.speedMode = "curve";
    s.curve = { preset, points };
    s.duration = timelineDurationFor(s, src);
    s.sourceDuration = src;
    return s.duration;
  });
}

export function allSegments(tl) {
  const out = [];
  for (const t of tl.tracks) t.segments.forEach((s, i) => out.push({ track: t, segment: s, index: i }));
  return out;
}

/** Copy (returns plain clones) / paste at a time. */
export function copySegments(tl, ids) {
  return allSegments(tl).filter((x) => ids.includes(x.segment.id)).map((x) => deepClone(x.segment));
}

export function pasteSegments(tl, clips, atUs, opts = {}) {
  if (!clips.length) return [];
  const minStart = Math.min(...clips.map((c) => c.start));
  const newGroup = {};
  const ids = [];
  withMagnet(tl, opts, () => {
    for (const c of clips) {
      const seg = deepClone(c);
      seg.id = uid();
      if (seg.groupId) seg.groupId = newGroup[seg.groupId] ||= uid();
      seg.keyframes = (seg.keyframes || []).map((k) => ({ ...k, id: uid() }));
      seg.start = atUs + (c.start - minStart);
      if (["video", "image", "compound"].includes(seg.kind) && !opts.asOverlay) {
        const main = mainTrack(tl);
        seg.start = atUs;
        main.segments.push(seg);
        sortSegments(main);
      } else {
        trackFor(tl, KIND_TO_TRACK[seg.kind], seg.start, seg.duration).segments.push(seg);
      }
      ids.push(seg.id);
    }
  });
  return ids;
}

/** Copy/paste attributes (Ctrl+Shift+C / Ctrl+Shift+V). */
export const ATTRIBUTE_KEYS = ["transform", "crop", "adjust", "videoFx", "audioFx", "animation", "clipEffects", "volumeDb", "fadeInUs", "fadeOutUs", "text"];
export function copyAttributes(seg) {
  return Object.fromEntries(ATTRIBUTE_KEYS.filter((k) => seg[k] !== undefined && seg[k] !== null).map((k) => [k, deepClone(seg[k])]));
}
export function pasteAttributes(tl, ids, attrs) {
  let n = 0;
  for (const { track, segment } of allSegments(tl)) {
    if (!ids.includes(segment.id) || track.locked) continue;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text" && segment.kind !== "text") continue;
      if (segment[k] === null && !["volumeDb", "fadeInUs", "fadeOutUs"].includes(k)) continue;
      segment[k] = deepClone(v);
    }
    n++;
  }
  return n;
}

/** FEAT-028 Group / Ungroup. */
export function group(tl, ids) {
  if (ids.length < 2) throw new AppError("VALIDATION", "err.groupMin");
  const gid = uid();
  for (const { segment } of allSegments(tl)) if (ids.includes(segment.id)) segment.groupId = gid;
  return gid;
}
export function ungroup(tl, ids) {
  const gids = new Set(allSegments(tl).filter((x) => ids.includes(x.segment.id)).map((x) => x.segment.groupId).filter(Boolean));
  for (const { segment } of allSegments(tl)) if (gids.has(segment.groupId)) segment.groupId = null;
  return gids.size;
}

/** FEAT-025 Markers. */
export function addMarker(tl, timeUs, color = "#00C1CD", note = "") {
  const m = { id: uid(), timeUs: Math.max(0, Math.round(timeUs)), color, note };
  tl.markers.push(m);
  tl.markers.sort((a, b) => a.timeUs - b.timeUs);
  return m;
}
export function nextMarker(tl, timeUs, dir = 1) {
  const ms = [...tl.markers].sort((a, b) => a.timeUs - b.timeUs);
  return dir > 0 ? ms.find((m) => m.timeUs > timeUs + 1) || null : [...ms].reverse().find((m) => m.timeUs < timeUs - 1) || null;
}

/** Cut points (Last/Next cut point ↑/↓): every segment edge. */
export function cutPoints(tl) {
  const pts = new Set([0]);
  for (const t of tl.tracks) for (const s of t.segments) { pts.add(s.start); pts.add(end(s)); }
  return [...pts].sort((a, b) => a - b);
}

/** Snap candidate times (Auto snapping, N): edges, markers and the playhead. */
export function snapTime(tl, timeUs, thresholdUs, { exclude = [], playheadUs = null } = {}) {
  const cands = [];
  for (const t of tl.tracks) for (const s of t.segments) if (!exclude.includes(s.id)) cands.push(s.start, end(s));
  for (const m of tl.markers) cands.push(m.timeUs);
  if (playheadUs !== null) cands.push(playheadUs);
  cands.push(0);
  let best = timeUs, bestD = thresholdUs;
  for (const c of cands) { const d = Math.abs(c - timeUs); if (d < bestD) { best = c; bestD = d; } }
  return best;
}

/** Freeze (FEAT-027): insert a still image segment (created by the media service) at the playhead. */
export function insertFreeze(tl, segId, atUs, imageMedia, durationUs = 3 * US, opts = {}) {
  const f = findSegment(tl, segId);
  if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
  return withMagnet(tl, opts, () => {
    const right = splitSegment(tl, segId, atUs);
    const still = newSegment("image", { mediaId: imageMedia.id, name: `${f.segment.name || "Freeze"} (freeze)`, start: atUs, duration: durationUs,
      transform: deepClone(f.segment.transform), crop: deepClone(f.segment.crop), adjust: deepClone(f.segment.adjust) });
    const idx = f.track.segments.findIndex((s) => s.id === segId);
    if (f.track.isMain) {
      if (right) right.start += durationUs;
      f.track.segments.splice(idx + 1, 0, still);
    } else {
      if (right) right.start += durationUs;
      f.track.segments.push(still);
    }
    return still.id;
  });
}

/** Compound clip (FEAT-028): move selected segments into a child timeline, leave one compound segment. */
export function createCompound(tl, ids, childTimeline) {
  const picked = allSegments(tl).filter((x) => ids.includes(x.segment.id) && !x.track.locked);
  if (!picked.length) throw new AppError("VALIDATION", "err.selectionEmpty");
  const t0 = Math.min(...picked.map((x) => x.segment.start));
  const t1 = Math.max(...picked.map((x) => end(x.segment)));
  // Recreate track structure inside the child timeline (main stays main).
  const trackMap = new Map();
  for (const { track, segment } of picked) {
    let ct = trackMap.get(track.id);
    if (!ct) {
      ct = track.isMain ? childTimeline.tracks.find((t) => t.isMain) : newTrack(track.type, { order: childTimeline.tracks.length });
      if (!track.isMain) childTimeline.tracks.push(ct);
      trackMap.set(track.id, ct);
    }
    const c = deepClone(segment);
    c.start -= t0;
    ct.segments.push(c);
    track.segments = track.segments.filter((s) => s.id !== segment.id);
  }
  childTimeline.isCompound = true;
  childTimeline.canvas = deepClone(tl.canvas);
  childTimeline.fps = tl.fps;
  const comp = newSegment("compound", { name: childTimeline.name, start: t0, duration: t1 - t0, sourceStart: 0, sourceDuration: t1 - t0, compoundTimelineId: childTimeline.id });
  const host = picked.some((x) => x.track.isMain) ? mainTrack(tl) : trackFor(tl, "video", t0, t1 - t0);
  host.segments.push(comp);
  sortSegments(host);
  cleanupTracks(tl);
  return comp;
}

/** Undo compound: put the child's segments back at the compound's position. */
export function expandCompound(tl, compSegId, childTimeline) {
  const f = findSegment(tl, compSegId);
  if (!f || f.segment.kind !== "compound") throw new AppError("VALIDATION", "err.notCompound");
  const t0 = f.segment.start;
  f.track.segments = f.track.segments.filter((s) => s.id !== compSegId);
  const ids = [];
  for (const ct of childTimeline.tracks) {
    for (const cs of ct.segments) {
      const s = deepClone(cs);
      s.start += t0;
      if (ct.isMain && f.track.isMain) f.track.segments.push(s);
      else trackFor(tl, ct.type === "video" && ct.isMain ? "video" : ct.type, s.start, s.duration).segments.push(s);
      ids.push(s.id);
    }
  }
  cleanupTracks(tl);
  return ids;
}

export function setTrackFlag(tl, trackId, flag, value) {
  const t = tl.tracks.find((x) => x.id === trackId);
  if (!t) throw new AppError("NOT_FOUND", "err.trackNotFound");
  if (!["locked", "hidden", "muted"].includes(flag)) throw new AppError("VALIDATION", "err.enum");
  t[flag] = !!value;
  return t;
}

/** Validation of a whole timeline (used before saving). */
export function validateTimeline(tl) {
  const problems = [];
  for (const t of tl.tracks) {
    const segs = [...t.segments].sort((a, b) => a.start - b.start);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!(s.duration > 0)) problems.push({ segId: s.id, problem: "duration" });
      if (s.start < 0) problems.push({ segId: s.id, problem: "start" });
      if (!TRACK_ACCEPTS[t.type].includes(s.kind)) problems.push({ segId: s.id, problem: "kind" });
      if (i > 0 && overlaps(segs[i - 1], s)) problems.push({ segId: s.id, problem: "overlap" });
    }
  }
  return problems;
}

export { timelineDuration };
