// Editor command executor (main process is the source of truth). Each command: snapshot → mutate (pure ops) →
// validate → persist (one Realm transaction) → history push. Returns the new state for the renderer.
import fs from "node:fs";
import path from "node:path";
import * as ops from "../core/timelineOps.js";
import { History } from "../core/history.js";
import { newSegment, findSegment, mainTrack, canvasSize, KIND_TO_TRACK, CANVAS_RATIOS } from "../core/model.js";
import { deepClone, deepMerge, uid, US, clamp } from "../core/util.js";
import { AppError, validateEnum, validateNumber, validateColor } from "../core/validation.js";
import { CURVE_PRESETS, VELOCITY_EFFECTS } from "../core/speed.js";
import { KEYFRAME_PROPS, EASINGS, TRANSITIONS } from "../core/layerMath.js";

// Fields the renderer may patch on a segment (everything else goes through dedicated commands).
const PATCHABLE = new Set(["name", "transform", "crop", "adjust", "videoFx", "audioFx", "animation", "clipEffects", "volumeDb", "fadeInUs", "fadeOutUs",
  "text", "effect", "filter", "sticker", "changePitch", "colorTag", "disabled"]);

export class TimelineService {
  constructor({ repos, media, settings, exporter = null, analysis = null }) {
    this.repos = repos;
    this.media = media;
    this.settings = settings;
    this.exporter = exporter; // set later (circular: exporter renders compound clips)
    this.analysis = analysis;
    this.open = new Map(); // timelineId -> { state, history }
  }

  load(timelineId) {
    let entry = this.open.get(timelineId);
    if (!entry) {
      entry = { state: this.repos.timelines.get(timelineId), history: new History() };
      this.open.set(timelineId, entry);
    }
    return entry;
  }

  get(timelineId) {
    const e = this.load(timelineId);
    return { timeline: e.state, history: e.history.info() };
  }

  close(timelineId) { this.open.delete(timelineId); }

  editOpts() {
    const edit = this.settings.get("edit");
    return { magnet: edit.magnet !== false, linkage: edit.linkageEnabled !== false, linkTypes: edit.linkage || [] };
  }

  /** Apply a synchronous mutation with history + persistence. */
  commit(timelineId, label, mutate, { coalesceKey = null } = {}) {
    const entry = this.load(timelineId);
    const before = deepClone(entry.state);
    const work = deepClone(entry.state);
    const result = mutate(work);
    const problems = ops.validateTimeline(work);
    if (problems.length) throw new AppError("VALIDATION", "err.timelineInvalid", { problems: problems.slice(0, 5) });
    this.repos.timelines.saveState(work);
    entry.history.push(before, label, coalesceKey);
    entry.state = work;
    return { timeline: work, history: entry.history.info(), result };
  }

  undo(timelineId) {
    const entry = this.load(timelineId);
    const r = entry.history.undo(entry.state);
    if (!r) return { timeline: entry.state, history: entry.history.info(), result: null };
    this.repos.timelines.saveState(r.state);
    entry.state = r.state;
    return { timeline: entry.state, history: entry.history.info(), result: r.label };
  }

  redo(timelineId) {
    const entry = this.load(timelineId);
    const r = entry.history.redo(entry.state);
    if (!r) return { timeline: entry.state, history: entry.history.info(), result: null };
    this.repos.timelines.saveState(r.state);
    entry.state = r.state;
    return { timeline: entry.state, history: entry.history.info(), result: r.label };
  }

  mediaDuration(mediaId) {
    const m = mediaId ? this.repos.media.find(mediaId) : null;
    return m?.durationUs || null;
  }

  // ------------------------------------------------------------------ command router
  async exec(timelineId, cmd, a = {}) {
    const o = this.editOpts();
    const imageDurationUs = (this.settings.get("edit").imageDurationS || 5) * US;
    switch (cmd) {
      case "undo": return this.undo(timelineId);
      case "redo": return this.redo(timelineId);
      case "addMedia": {
        const m = this.repos.media.get(a.mediaId);
        return this.commit(timelineId, "addMedia", (tl) => {
          const seg = ops.addMediaSegment(tl, m, { atUs: a.atUs ?? null, toMain: a.toMain !== false, settings: { imageDurationUs }, magnet: o.magnet });
          if (tl.tracks.find((t) => t.isMain).segments.length === 1 && tl.canvas.ratio === "original" && m.width && m.height) {
            tl.canvas.width = m.width; tl.canvas.height = m.height; // "Original" ratio follows the first clip
          }
          return seg.id;
        });
      }
      case "addSegment": {
        const kind = validateEnum(a.kind, Object.keys(KIND_TO_TRACK), "kind");
        const seg = newSegment(kind, a.init || {});
        seg.start = Math.max(0, Math.round(a.atUs ?? 0));
        seg.duration = Math.max(ops.MIN_DUR, Math.round(a.durationUs ?? seg.duration));
        if (a.mediaId) { const m = this.repos.media.get(a.mediaId); seg.mediaId = m.id; seg.name = seg.name || m.name; if (m.durationUs && kind === "audio") { seg.duration = m.durationUs; seg.sourceDuration = m.durationUs; } }
        return this.commit(timelineId, `add:${kind}`, (tl) => ops.addSegment(tl, seg, { trackId: a.trackId || null }).id);
      }
      case "updateSegment": return this.commit(timelineId, "update", (tl) => this.patchSegment(tl, a.segId, a.patch), { coalesceKey: a.coalesceKey ? `${a.segId}:${a.coalesceKey}` : null });
      case "updateSegments": return this.commit(timelineId, "update", (tl) => { for (const id of a.ids) this.patchSegment(tl, id, a.patch); return a.ids.length; }, { coalesceKey: a.coalesceKey || null });
      case "patchMany": return this.commit(timelineId, a.label || "update", (tl) => { for (const it of a.items || []) this.patchSegment(tl, it.segId, it.patch); return (a.items || []).length; }); // one undo step (Global edits, EditPilot)
      case "split": return this.commit(timelineId, "split", (tl) => ops.split(tl, a.atUs, a.ids || null));
      case "splitAll": return this.commit(timelineId, "splitAll", (tl) => ops.split(tl, a.atUs, null));
      case "delete": return this.commit(timelineId, "delete", (tl) => ops.deleteSegments(tl, a.ids, o));
      case "deleteSide": return this.commit(timelineId, `delete-${a.side}`, (tl) => ops.deleteSide(tl, a.segId, a.atUs, validateEnum(a.side, ["left", "right"], "side"), o));
      case "move": return this.commit(timelineId, "move", (tl) => ops.moveSegment(tl, a.segId, a.start, a.trackId || null, o));
      case "trim": return this.commit(timelineId, "trim", (tl) => {
        const f = findSegment(tl, a.segId);
        return ops.trimSegment(tl, a.segId, validateEnum(a.edge, ["start", "end"], "edge"), a.timeUs, f ? this.mediaDuration(f.segment.mediaId) || (f.segment.kind === "compound" ? f.segment.sourceDuration : null) : null, o);
      });
      case "setSpeed": return this.commit(timelineId, "speed", (tl) => ops.setSpeed(tl, a.segId, validateNumber(a.speed, { field: "speed", min: 0.1, max: 100 }), o), { coalesceKey: `${a.segId}:speed` });
      case "setCurve": {
        const preset = validateEnum(a.preset, Object.keys(CURVE_PRESETS), "preset");
        const points = a.points?.length ? a.points : CURVE_PRESETS[preset];
        return this.commit(timelineId, "curve", (tl) => ops.setCurve(tl, a.segId, preset, points, o), { coalesceKey: a.coalesceKey ? `${a.segId}:curve` : null });
      }
      case "setVelocityEffect": {
        const ve = validateEnum(a.type, Object.keys(VELOCITY_EFFECTS), "type");
        return this.commit(timelineId, "velocity", (tl) => {
          const f = findSegment(tl, a.segId);
          if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
          f.segment.clipEffects = (f.segment.clipEffects || []).filter((e) => !e.velocity);
          if (ve === "none") return ops.setCurve(tl, a.segId, "none", [], o);
          const def = VELOCITY_EFFECTS[ve];
          ops.setCurve(tl, a.segId, def.curve, CURVE_PRESETS[def.curve], o);
          findSegment(tl, a.segId).segment.clipEffects.push({ type: def.effect, intensity: 60, velocity: true });
          return ve;
        });
      }
      case "pasteSegments": return this.commit(timelineId, "paste", (tl) => ops.pasteSegments(tl, a.clips, a.atUs, o));
      case "pasteAttributes": return this.commit(timelineId, "pasteAttributes", (tl) => ops.pasteAttributes(tl, a.ids, a.attrs));
      case "group": return this.commit(timelineId, "group", (tl) => ops.group(tl, a.ids));
      case "ungroup": return this.commit(timelineId, "ungroup", (tl) => ops.ungroup(tl, a.ids));
      case "setDisabled": return this.commit(timelineId, "disable", (tl) => { for (const id of a.ids) { const f = findSegment(tl, id); if (f) f.segment.disabled = !!a.value; } return a.ids.length; });
      case "addMarker": return this.commit(timelineId, "marker", (tl) => ops.addMarker(tl, a.timeUs, a.color ? validateColor(a.color) : "#00C1CD", a.note || ""));
      case "updateMarker": return this.commit(timelineId, "marker", (tl) => { const m = tl.markers.find((x) => x.id === a.id); if (!m) throw new AppError("NOT_FOUND", "err.markerNotFound"); if (a.note !== undefined) m.note = String(a.note).slice(0, 500); if (a.color) m.color = validateColor(a.color); return m; });
      case "removeMarker": return this.commit(timelineId, "marker", (tl) => { tl.markers = tl.markers.filter((m) => m.id !== a.id); return true; });
      case "setTrackFlag": return this.commit(timelineId, "track", (tl) => ops.setTrackFlag(tl, a.trackId, a.flag, a.value));
      case "setCanvas": return this.commit(timelineId, "canvas", (tl) => this.applyCanvas(tl, a));
      case "setTransition": return this.commit(timelineId, "transition", (tl) => {
        const f = findSegment(tl, a.segId);
        if (!f || !f.track.isMain) throw new AppError("VALIDATION", "err.transitionMainOnly");
        f.segment.transitionOut = { type: validateEnum(a.type, TRANSITIONS, "type"), durationUs: Math.round(clamp(a.durationUs ?? 500_000, 100_000, 5 * US)) };
        return true;
      });
      case "applyTransitionToAll": return this.commit(timelineId, "transitionAll", (tl) => {
        const main = mainTrack(tl);
        for (const s of main.segments.slice(0, -1)) s.transitionOut = { type: validateEnum(a.type, TRANSITIONS, "type"), durationUs: Math.round(clamp(a.durationUs ?? 500_000, 100_000, 5 * US)) };
        return main.segments.length - 1;
      });
      case "addKeyframe": return this.commit(timelineId, "keyframe", (tl) => this.addKeyframe(tl, a));
      case "removeKeyframe": return this.commit(timelineId, "keyframe", (tl) => { const f = findSegment(tl, a.segId); if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound"); f.segment.keyframes = f.segment.keyframes.filter((k) => k.id !== a.keyframeId); return true; });
      case "setKeyframeEasing": return this.commit(timelineId, "keyframe", (tl) => {
        const f = findSegment(tl, a.segId);
        const easing = validateEnum(a.easing, EASINGS, "easing");
        for (const k of f?.segment.keyframes || []) if (!a.keyframeId || k.id === a.keyframeId) k.easing = easing;
        return true;
      });
      case "applyToAll": return this.commit(timelineId, "applyAll", (tl) => {
        const f = findSegment(tl, a.segId);
        if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
        const key = validateEnum(a.key, ["adjust", "videoFx", "animation", "transform", "audioFx", "canvas"], "key");
        let n = 0;
        for (const t of tl.tracks) for (const s of t.segments) if (s.id !== f.segment.id && s.kind === f.segment.kind && !t.locked && s[key] !== undefined) { s[key] = deepClone(f.segment[key]); n++; }
        return n;
      });
      case "extractAudio": return this.commit(timelineId, "extractAudio", (tl) => {
        const f = findSegment(tl, a.segId);
        if (!f || !["video", "compound"].includes(f.segment.kind)) throw new AppError("VALIDATION", "err.extractKind");
        const m = f.segment.mediaId ? this.repos.media.get(f.segment.mediaId) : null;
        if (m && !m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
        if (f.segment.audioDetached) { // Restore audio: remove the linked audio clip
          for (const t of tl.tracks) if (t.type === "audio") t.segments = t.segments.filter((s) => !(s.mediaId === f.segment.mediaId && s.start === f.segment.start && s.sourceStart === f.segment.sourceStart));
          f.segment.audioDetached = false;
          ops.cleanupTracks(tl);
          return "restored";
        }
        const seg = newSegment("audio", { mediaId: f.segment.mediaId, name: `${f.segment.name} (audio)`, start: f.segment.start, duration: f.segment.duration,
          sourceStart: f.segment.sourceStart, sourceDuration: f.segment.sourceDuration, speed: f.segment.speed, speedMode: f.segment.speedMode, curve: deepClone(f.segment.curve),
          volumeDb: f.segment.volumeDb, fadeInUs: f.segment.fadeInUs, fadeOutUs: f.segment.fadeOutUs, audioFx: deepClone(f.segment.audioFx) });
        ops.trackFor(tl, "audio", seg.start, seg.duration).segments.push(seg);
        f.segment.audioDetached = true;
        return seg.id;
      });
      case "replaceClip": {
        const m = this.repos.media.get(a.mediaId);
        return this.commit(timelineId, "replace", (tl) => {
          const f = findSegment(tl, a.segId);
          if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
          const s = f.segment;
          const wantVisual = ["video", "image"].includes(s.kind);
          if (wantVisual && m.type === "audio") throw new AppError("VALIDATION", "err.replaceType");
          if (s.kind === "audio" && m.type !== "audio" && !m.hasAudio) throw new AppError("VALIDATION", "err.replaceType");
          if (m.type !== "image" && m.durationUs < s.duration * (s.speed || 1)) throw new AppError("VALIDATION", "err.replaceTooShort", { needUs: s.duration * (s.speed || 1) });
          s.mediaId = m.id; s.name = m.name; s.sourceStart = 0;
          if (wantVisual) s.kind = m.type === "image" ? "image" : "video";
          return s.id;
        });
      }
      case "freeze": {
        const st = this.load(timelineId).state;
        const f = findSegment(st, a.segId);
        if (!f || !["video", "image"].includes(f.segment.kind)) throw new AppError("VALIDATION", "err.freezeKind");
        const local = clamp(a.atUs - f.segment.start, 0, f.segment.duration - 1);
        const srcTime = f.segment.sourceStart + local * (f.segment.speed || 1);
        const projectId = st.projectId;
        const still = await this.media.freezeFrame(projectId, f.segment.mediaId, srcTime);
        return this.commit(timelineId, "freeze", (tl) => ops.insertFreeze(tl, a.segId, a.atUs, still, a.durationUs || 3 * US, o));
      }
      case "reverse": {
        const st = this.load(timelineId).state;
        const f = findSegment(st, a.segId);
        if (!f || f.segment.kind !== "video") throw new AppError("VALIDATION", "err.reverseKind");
        const cur = this.repos.media.get(f.segment.mediaId);
        const span = Math.round(f.segment.duration * (f.segment.speedMode === "curve" ? 1 : f.segment.speed || 1));
        if (cur.origin === "reverse" && cur.derivedFromId) {
          const ss = Number(/-ss(\d+)\./.exec(cur.path)?.[1] || 0);
          return this.commit(timelineId, "reverse", (tl) => { const g = findSegment(tl, a.segId).segment; g.mediaId = cur.derivedFromId; g.sourceStart = ss; return "original"; });
        }
        const rev = await this.media.reverse(st.projectId, cur.id, f.segment.sourceStart, span);
        const tagged = rev.path.replace(/\.mp4$/, `-ss${Math.round(f.segment.sourceStart)}.mp4`);
        fs.renameSync(rev.path, tagged);
        this.repos.media.update(rev.id, { path: tagged });
        return this.commit(timelineId, "reverse", (tl) => { const g = findSegment(tl, a.segId).segment; g.mediaId = rev.id; g.sourceStart = 0; return "reversed"; });
      }
      case "splitAtTimes": return this.commit(timelineId, "splitScenes", (tl) => { const ids = []; for (const t of [...a.timesUs].sort((x, y) => y - x)) { const r = ops.splitSegment(tl, a.segId, t); if (r) ids.push(r.id); } return ids; });
      case "removeRanges": return this.commit(timelineId, "removeRanges", (tl) => this.removeRanges(tl, a.segId, a.ranges, o));
      case "createCompound": {
        const st = this.load(timelineId).state;
        const child = this.repos.timelines.create(st.projectId, { name: a.name || "Compound clip", canvas: deepClone(st.canvas), fps: st.fps, isCompound: true });
        const out = this.commit(timelineId, "compound", (tl) => {
          const childState = deepClone(child);
          const comp = ops.createCompound(tl, a.ids, childState);
          this.repos.timelines.saveState(childState);
          return comp.id;
        });
        this.open.delete(child.id);
        return { ...out, compoundTimelineId: child.id }; // the renderer pre-processes it (it rasterizes text)
      }
      case "undoCompound": {
        const st = this.load(timelineId).state;
        const f = findSegment(st, a.segId);
        if (!f || f.segment.kind !== "compound") throw new AppError("VALIDATION", "err.notCompound");
        const child = this.repos.timelines.get(f.segment.compoundTimelineId);
        return this.commit(timelineId, "uncompound", (tl) => ops.expandCompound(tl, a.segId, child));
      }
      default:
        throw new AppError("VALIDATION", "err.unknownCommand", { cmd });
    }
  }

  // ------------------------------------------------------------------ helpers
  patchSegment(tl, segId, patch) {
    const f = findSegment(tl, segId);
    if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
    if (f.track.locked) throw new AppError("VALIDATION", "err.trackLocked");
    const s = f.segment;
    for (const [k, v] of Object.entries(patch || {})) {
      if (!PATCHABLE.has(k)) throw new AppError("VALIDATION", "err.fieldNotPatchable", { field: k });
      if (k === "volumeDb") { s.volumeDb = validateNumber(v, { field: k, min: -60, max: 20 }); continue; }
      if (k === "fadeInUs" || k === "fadeOutUs") { s[k] = Math.round(clamp(validateNumber(v, { field: k, min: 0 }), 0, s.duration)); continue; }
      if (v && typeof v === "object" && !Array.isArray(v) && s[k] && typeof s[k] === "object") s[k] = deepMerge(s[k], v);
      else s[k] = deepClone(v);
    }
    if (s.transform) {
      s.transform.scale = clamp(s.transform.scale ?? 1, 0.01, 50);
      s.transform.opacity = clamp(s.transform.opacity ?? 1, 0, 1);
    }
    if (s.text) {
      if (typeof s.text.content !== "string") throw new AppError("VALIDATION", "err.textContent");
      s.text.size = clamp(Number(s.text.size) || 15, 1, 400);
      validateColor(s.text.color, "text.color");
    }
    return s.id;
  }

  addKeyframe(tl, a) {
    const f = findSegment(tl, a.segId);
    if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
    const prop = validateEnum(a.prop, KEYFRAME_PROPS, "prop");
    const s = f.segment;
    const t = Math.round(clamp(a.timeUs, 0, s.duration));
    const frame = US / (tl.fps || 30);
    const existing = s.keyframes.find((k) => k.prop === prop && Math.abs(k.timeUs - t) < frame / 2);
    const value = validateNumber(a.value, { field: "value" });
    if (existing) { existing.value = value; if (a.easing) existing.easing = validateEnum(a.easing, EASINGS, "easing"); return existing.id; }
    const k = { id: uid(), prop, timeUs: t, value, easing: a.easing ? validateEnum(a.easing, EASINGS, "easing") : "linear" };
    s.keyframes.push(k);
    s.keyframes.sort((x, y) => x.timeUs - y.timeUs);
    return k.id;
  }

  applyCanvas(tl, a) {
    if (a.ratio !== undefined) {
      validateEnum(a.ratio, Object.keys(CANVAS_RATIOS), "ratio");
      const first = mainTrack(tl).segments[0];
      const m = first?.mediaId ? this.repos.media.find(first.mediaId) : null;
      const size = canvasSize(a.ratio, 1080, m ? { width: m.width, height: m.height } : { width: tl.canvas.width, height: tl.canvas.height });
      Object.assign(tl.canvas, { ratio: a.ratio, ...size });
    }
    if (a.bgType !== undefined) tl.canvas.bgType = validateEnum(a.bgType, ["color", "blur"], "bgType");
    if (a.bgColor !== undefined) tl.canvas.bgColor = validateColor(a.bgColor);
    if (a.bgBlur !== undefined) tl.canvas.bgBlur = clamp(Number(a.bgBlur) || 0, 0, 100);
    if (a.fps !== undefined) tl.fps = validateNumber(a.fps, { field: "fps", min: 1, max: 120 });
    return tl.canvas;
  }

  /** Remove source ranges (e.g. silences) from one clip: split at range edges and delete inner pieces. */
  removeRanges(tl, segId, ranges, o) {
    const f = findSegment(tl, segId);
    if (!f) throw new AppError("NOT_FOUND", "err.segmentNotFound");
    const s = f.segment;
    const speed = s.speed || 1;
    const toTimeline = (srcUs) => s.start + (srcUs - s.sourceStart) / speed;
    const cuts = ranges
      .map(([a, b]) => [Math.max(s.start, toTimeline(a)), Math.min(s.start + s.duration, toTimeline(b))])
      .filter(([a, b]) => b - a > 100_000)
      .sort((x, y) => y[0] - x[0]); // right-to-left so earlier times stay valid
    let removed = 0;
    for (const [a, b] of cuts) {
      const piece = ops.allSegments(tl).find((x) => x.segment.start <= a && x.segment.start + x.segment.duration >= b && (x.segment.id === segId || x.segment.mediaId === s.mediaId) && x.track.id === f.track.id);
      if (!piece) continue;
      const mid = ops.splitSegment(tl, piece.segment.id, a) || piece.segment;
      const right = ops.splitSegment(tl, mid.id, b);
      f.track.segments = f.track.segments.filter((x) => x.id !== mid.id);
      if (!f.track.isMain && right) right.start -= b - a;
      removed += b - a;
    }
    if (o.magnet !== false) ops.packMainTrack(tl);
    ops.cleanupTracks(tl);
    return removed;
  }
}
