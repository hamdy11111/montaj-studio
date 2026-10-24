// Editing API: the catalogue of typed operations that skills and external agents (MCP) use. Every operation is
// { name, title, description, scope, input (JSON Schema), run(ctx, args) } and runs on the same services as the
// editor UI, so agent edits land in the same timeline, history and undo stack. ctx = { services, source,
// client, jobs, skills, guard } — see controlServer.js. Nothing here touches the window or simulates input.
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../core/validation.js";
import { mainTrack } from "../core/model.js";
import { FILTER_PRESETS, EFFECTS } from "../core/presets.js";
import { TRANSITIONS } from "../core/layerMath.js";
import { CANVAS_RATIOS } from "../core/model.js";
import { US } from "../core/util.js";

// ------------------------------------------------------------------ schema helpers
const S = {
  id: (description) => ({ type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9-]+$", description }),
  us: (description, min = 0) => ({ type: "integer", minimum: min, description: `${description} (microseconds)` }),
  num: (description, minimum, maximum) => ({ type: "number", minimum, maximum, description }),
  str: (description, maxLength = 500) => ({ type: "string", maxLength, description }),
  enumOf: (values, description) => ({ type: "string", enum: values, description }),
  ids: (description) => ({ type: "array", items: { type: "string", pattern: "^[A-Za-z0-9-]+$" }, minItems: 1, maxItems: 500, description }),
  rev: { type: "integer", minimum: 0, description: "Optional: the timeline revision this edit was planned against. If the timeline changed since, the edit is refused with CONFLICT." },
};
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TIMELINE = { timelineId: S.id("Timeline id (see project_inspect / timeline_inspect)") };
const EDIT = { ...TIMELINE, expectedRevision: S.rev };

// ------------------------------------------------------------------ helpers
const svc = (ctx) => ctx.services;
const tlState = (ctx, timelineId) => svc(ctx).timelines.get(timelineId);
const exec = (ctx, timelineId, cmd, args) => svc(ctx).timelines.execAs(ctx.source, timelineId, cmd, args);
const durationOf = (tl) => tl.tracks.reduce((m, t) => Math.max(m, ...t.segments.map((s) => s.start + s.duration), 0), 0);

/** A compact, model-friendly view of a timeline (ids, kinds, times, the settings an agent usually needs). */
export function summarizeTimeline(tl, revision, history) {
  return {
    timelineId: tl.id, projectId: tl.projectId, name: tl.name, revision, fps: tl.fps, canvas: tl.canvas, durationUs: durationOf(tl),
    history: history ? { canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.undoLabel, depth: history.depth } : undefined,
    tracks: [...tl.tracks].sort((a, b) => a.order - b.order).map((t) => ({
      trackId: t.id, type: t.type, isMain: !!t.isMain, hidden: !!t.hidden, muted: !!t.muted, locked: !!t.locked,
      clips: t.segments.map((s) => ({
        clipId: s.id, kind: s.kind, name: s.name, startUs: s.start, durationUs: s.duration, mediaId: s.mediaId || null, sourceStartUs: s.sourceStart,
        speed: s.speedMode === "curve" ? `curve:${s.curve?.preset}` : s.speed, volumeDb: s.volumeDb,
        transitionOut: s.transitionOut?.type && s.transitionOut.type !== "none" ? s.transitionOut : undefined,
        filter: s.filter?.preset ? s.filter : undefined, effect: s.effect?.type ? s.effect : undefined,
        text: s.text?.content !== undefined ? { content: s.text.content, isCaption: !!s.text.isCaption } : undefined,
        disabled: s.disabled || undefined,
      })),
    })),
    markers: tl.markers,
  };
}

const projectOfTimeline = (ctx, timelineId) => svc(ctx).repos.timelines.get(timelineId).projectId;

function audibleClips(tl) {
  const out = [];
  for (const t of tl.tracks) if (!t.muted) for (const s of t.segments) if (!s.disabled && (s.kind === "audio" || ((s.kind === "video" || s.kind === "compound") && !s.audioDetached))) out.push(s);
  return out;
}

// ------------------------------------------------------------------ the catalogue
export const OPERATIONS = [
  // ---------------------------------------------------------------- read
  {
    name: "project_list", scope: "read", title: "List projects",
    description: "Lists the user's projects (newest first) with their main timeline id.",
    input: obj({ search: S.str("Optional name filter", 100) }),
    run: (ctx, a) => svc(ctx).projects.list({ search: a.search || "" }).filter((p) => ctx.guard.projectAllowed(p.id)).map((p) => ({ projectId: p.id, name: p.name, mainTimelineId: p.mainTimelineId, durationUs: p.durationUs, updatedAt: p.updatedAt })),
  },
  {
    name: "project_inspect", scope: "read", title: "Inspect a project",
    description: "Project details, its media (ids, type, duration, size) and timelines.",
    input: obj({ projectId: S.id("Project id") }, ["projectId"]),
    project: (a) => a.projectId,
    run: (ctx, a) => {
      const p = svc(ctx).repos.projects.get(a.projectId);
      const media = svc(ctx).repos.media.listByProject(a.projectId).map((m) => ({ mediaId: m.id, name: m.name, type: m.type, durationUs: m.durationUs, width: m.width, height: m.height, hasAudio: m.hasAudio, status: m.status }));
      return { projectId: p.id, name: p.name, canvas: p.canvas, fps: p.fps, mainTimelineId: p.mainTimelineId, timelines: (p.timelineIds || [p.mainTimelineId]), media };
    },
  },
  {
    name: "timeline_inspect", scope: "read", title: "Inspect a timeline",
    description: "Tracks and clips of a timeline (ids, kinds, start/duration in µs, transitions, filters, text), its revision and undo state.",
    input: obj({ ...TIMELINE }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => { const r = tlState(ctx, a.timelineId); return summarizeTimeline(r.timeline, r.revision, r.history); },
  },
  {
    name: "media_inspect", scope: "read", title: "Inspect a media file",
    description: "Technical details of one imported media file.",
    input: obj({ mediaId: S.id("Media id") }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: (ctx, a) => { const m = svc(ctx).repos.media.get(a.mediaId); return { mediaId: m.id, name: m.name, type: m.type, durationUs: m.durationUs, width: m.width, height: m.height, fps: m.fps, hasAudio: m.hasAudio, hasVideo: m.hasVideo, videoCodec: m.videoCodec, audioCodec: m.audioCodec, sizeBytes: m.sizeBytes, status: m.status }; },
  },
  {
    name: "skills_list", scope: "read", title: "List skills",
    description: "Skills installed in Montaj Studio (official, user and imported), with their inputs and the permissions they need.",
    input: obj({ query: S.str("Optional text search", 100), category: S.str("Optional category", 40), includeDisabled: { type: "boolean" } }),
    run: (ctx, a) => ctx.skills.list({ query: a.query, category: a.category, includeDisabled: !!a.includeDisabled }).map((s) => ctx.skills.card(s)),
  },
  {
    name: "skills_inspect", scope: "read", title: "Inspect a skill",
    description: "The full definition of a skill: inputs schema, steps, permissions, requirements, tests.",
    input: obj({ skillId: S.str("Skill id", 80), version: S.str("Optional version", 40) }, ["skillId"]),
    run: (ctx, a) => ctx.skills.get(a.skillId, a.version),
  },
  {
    name: "skills_validate", scope: "read", title: "Validate a skill definition",
    description: "Checks a skill definition against the skill schema, the operation catalogue and its dependencies. Does not save it.",
    input: obj({ skill: { type: "object", description: "Skill definition (see skills_inspect for the shape)" } }, ["skill"]),
    run: (ctx, a) => ctx.skills.validate(a.skill),
  },
  {
    name: "skills_build_from_text", scope: "read", title: "Draft a skill from a description",
    description: "Turns a natural-language description (Arabic or English) into a draft skill definition built from real operations. Review it, then save with skills_save.",
    input: obj({ text: S.str("What the skill should do", 2000), name: S.str("Optional skill name", 80) }, ["text"]),
    run: (ctx, a) => ctx.skills.buildFromText(a.text, { name: a.name }),
  },
  {
    name: "job_status", scope: "read", title: "Job status",
    description: "Status, progress and result of a long-running job (skill run or export) started by this client.",
    input: obj({ jobId: S.str("Job id", 64) }, ["jobId"]),
    run: (ctx, a) => ctx.jobs.status(a.jobId, ctx.clientId),
  },

  // ---------------------------------------------------------------- media (reads files the user allowed)
  {
    name: "media_import", scope: "media", title: "Import media files",
    description: "Imports video/audio/image files into a project. Only files under the folders the user allowed for this client can be imported.",
    input: obj({ projectId: S.id("Project id"), paths: { type: "array", items: { type: "string", maxLength: 1000 }, minItems: 1, maxItems: 100, description: "Absolute file paths" } }, ["projectId", "paths"]),
    project: (a) => a.projectId,
    run: async (ctx, a) => {
      const files = a.paths.map((p) => ctx.guard.readablePath(p));
      const r = await svc(ctx).media.importFiles(a.projectId, files);
      for (const m of r.imported) svc(ctx).media.generateDerivatives(m.id).then((x) => ctx.notify?.("media:updated", x)).catch(() => {});
      return { imported: r.imported.map((m) => ({ mediaId: m.id, name: m.name, type: m.type, durationUs: m.durationUs, width: m.width, height: m.height, hasAudio: m.hasAudio })), errors: r.errors.map((e) => ({ file: path.basename(e.file || ""), messageKey: e.messageKey || e.error?.messageKey || "err.importFailed" })) };
    },
  },
  {
    name: "media_detect_silence", scope: "media", title: "Detect silences",
    description: "Silent ranges [[startUs, endUs]] of a media file (source time), using FFmpeg silencedetect.",
    input: obj({ mediaId: S.id("Media id"), noiseDb: S.num("Silence threshold in dB", -80, -10), minDurS: S.num("Minimum silence length in seconds", 0.1, 10) }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: async (ctx, a) => ({ ranges: await svc(ctx).analysis.silences(a.mediaId, { noiseDb: a.noiseDb ?? -35, minDurS: a.minDurS ?? 0.5 }) }),
  },
  {
    name: "media_detect_scenes", scope: "media", title: "Detect scene cuts",
    description: "Scene-change times (µs, source time) of a video file.",
    input: obj({ mediaId: S.id("Media id"), threshold: S.num("Scene score threshold", 0.05, 0.95) }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: async (ctx, a) => ({ timesUs: await svc(ctx).analysis.scenes(a.mediaId, { threshold: a.threshold ?? 0.35 }) }),
  },
  {
    name: "media_loudness", scope: "media", title: "Measure loudness",
    description: "Integrated loudness (LUFS) of a media file.",
    input: obj({ mediaId: S.id("Media id") }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: async (ctx, a) => ({ lufs: await svc(ctx).analysis.loudness(a.mediaId) }),
  },

  // ---------------------------------------------------------------- edit
  {
    name: "project_create", scope: "edit", title: "Create a project",
    description: "Creates a new empty project and returns its id and main timeline id.",
    input: obj({ name: S.str("Project name", 120), ratio: S.enumOf(Object.keys(CANVAS_RATIOS), "Canvas ratio") }),
    run: (ctx, a) => { const p = svc(ctx).projects.create({ name: a.name || null, ratio: a.ratio || "original" }); ctx.guard.grantProject(p.id); return { projectId: p.id, name: p.name, mainTimelineId: p.mainTimelineId }; },
  },
  {
    name: "timeline_add_clip", scope: "edit", title: "Add a media clip",
    description: "Adds an imported media file to the timeline (main track by default, at the end, or at atUs).",
    input: obj({ ...EDIT, mediaId: S.id("Media id"), atUs: S.us("Position on the timeline"), toMain: { type: "boolean", description: "Add to the main track (default true)" } }, ["timelineId", "mediaId"]),
    timeline: (a) => a.timelineId, media: (a) => a.mediaId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "addMedia", { mediaId: a.mediaId, atUs: a.atUs ?? null, toMain: a.toMain !== false, expectedRevision: a.expectedRevision }); return { clipId: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_split", scope: "edit", title: "Split clips",
    description: "Splits the clips under a time (all tracks, or only clipIds).",
    input: obj({ ...EDIT, atUs: S.us("Split time"), clipIds: S.ids("Optional: only these clips") }, ["timelineId", "atUs"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "split", { atUs: a.atUs, ids: a.clipIds || null, expectedRevision: a.expectedRevision }); return { result: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_trim", scope: "edit", title: "Trim a clip",
    description: "Moves the start or end edge of a clip to a timeline time.",
    input: obj({ ...EDIT, clipId: S.id("Clip id"), edge: S.enumOf(["start", "end"], "Which edge"), timeUs: S.us("New edge time") }, ["timelineId", "clipId", "edge", "timeUs"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "trim", { segId: a.clipId, edge: a.edge, timeUs: a.timeUs, expectedRevision: a.expectedRevision }); return { revision: r.revision }; },
  },
  {
    name: "timeline_move", scope: "edit", title: "Move a clip",
    description: "Moves a clip to a new start time (and optionally another track). On the main track with magnet on this reorders clips.",
    input: obj({ ...EDIT, clipId: S.id("Clip id"), startUs: S.us("New start"), trackId: S.id("Optional target track") }, ["timelineId", "clipId", "startUs"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "move", { segId: a.clipId, start: a.startUs, trackId: a.trackId || null, expectedRevision: a.expectedRevision }); return { revision: r.revision }; },
  },
  {
    name: "timeline_remove_clips", scope: "edit", title: "Remove clips",
    description: "Removes clips from the timeline (the media stays in the project). Undoable.",
    input: obj({ ...EDIT, clipIds: S.ids("Clips to remove") }, ["timelineId", "clipIds"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "delete", { ids: a.clipIds, expectedRevision: a.expectedRevision }); return { revision: r.revision }; },
  },
  {
    name: "timeline_update_clips", scope: "edit", title: "Change clip properties",
    description: "Patches clip properties: transform {x,y,scale,rotation,opacity}, adjust {brightness,contrast,saturation,temperature,...}, audioFx {denoise,enhanceVoice,normalize}, volumeDb, fadeInUs, fadeOutUs, text {...}, filter, effect, videoFx. One undo step.",
    input: obj({ ...EDIT, clipIds: S.ids("Clips to change"), patch: { type: "object", description: "Properties to merge into each clip" } }, ["timelineId", "clipIds", "patch"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "patchMany", { label: "agent update", items: a.clipIds.map((segId) => ({ segId, patch: a.patch })), expectedRevision: a.expectedRevision }); return { changed: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_add_layer", scope: "edit", title: "Add a filter, effect, adjustment or text layer",
    description: `Adds a layer clip over a time range. kind=filter: settings {preset: ${Object.keys(FILTER_PRESETS).join("|")}, intensity 0-100}; kind=effect: settings {type: ${Object.keys(EFFECTS).join("|")}, intensity}; kind=adjust: settings {adjust:{...}}; kind=text: settings {text:{content, ...}}.`,
    input: obj({ ...EDIT, kind: S.enumOf(["filter", "effect", "adjust", "text"], "Layer kind"), atUs: S.us("Start"), durationUs: S.us("Length (default: to the end of the timeline)", 1), settings: { type: "object", description: "Kind-specific settings" } }, ["timelineId", "kind"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const tl = tlState(ctx, a.timelineId).timeline;
      const at = a.atUs ?? 0;
      const dur = a.durationUs ?? Math.max(US, durationOf(tl) - at);
      const st = a.settings || {};
      const init = a.kind === "filter" ? { filter: { preset: st.preset, intensity: st.intensity ?? 100 } }
        : a.kind === "effect" ? { effect: { type: st.type, intensity: st.intensity ?? 50 } }
        : a.kind === "adjust" ? { adjust: st.adjust || st }
        : { text: st.text || st };
      if (a.kind === "filter" && !FILTER_PRESETS[init.filter.preset]) throw new AppError("VALIDATION", "err.enum", { field: "settings.preset", allowed: Object.keys(FILTER_PRESETS) });
      if (a.kind === "effect" && !EFFECTS[init.effect.type]) throw new AppError("VALIDATION", "err.enum", { field: "settings.type", allowed: Object.keys(EFFECTS) });
      const r = await exec(ctx, a.timelineId, "addSegment", { kind: a.kind, atUs: at, durationUs: dur, init, expectedRevision: a.expectedRevision });
      return { clipId: r.result, revision: r.revision };
    },
  },
  {
    name: "timeline_set_transition", scope: "edit", title: "Set a transition",
    description: `Sets the transition after a main-track clip. Types: ${TRANSITIONS.join(", ")}.`,
    input: obj({ ...EDIT, clipId: S.id("Main-track clip id"), type: S.enumOf(TRANSITIONS, "Transition"), durationUs: S.us("Length (0.1–5 s)", 100_000) }, ["timelineId", "clipId", "type"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "setTransition", { segId: a.clipId, type: a.type, durationUs: a.durationUs ?? 500_000, expectedRevision: a.expectedRevision }); return { revision: r.revision }; },
  },
  {
    name: "timeline_transition_all", scope: "edit", title: "Apply a transition to every cut",
    description: `Sets the same transition between all main-track clips. Types: ${TRANSITIONS.join(", ")}.`,
    input: obj({ ...EDIT, type: S.enumOf(TRANSITIONS, "Transition"), durationUs: S.us("Length (0.1–5 s)", 100_000) }, ["timelineId", "type"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "applyTransitionToAll", { type: a.type, durationUs: a.durationUs ?? 500_000, expectedRevision: a.expectedRevision }); return { cuts: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_remove_silences", scope: "edit", needs: ["media"], title: "Remove silences",
    description: "Detects silences in every main-track clip with audio and cuts them out (keeping paddingMs around speech). Returns how much time was removed.",
    input: obj({ ...EDIT, noiseDb: S.num("Silence threshold dB", -80, -10), minDurS: S.num("Minimum silence (s)", 0.2, 10), paddingMs: S.num("Speech padding kept on each side (ms)", 0, 1000) }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      svc(ctx).timelines.checkRevision(a.timelineId, a.expectedRevision);
      const tl = tlState(ctx, a.timelineId).timeline;
      const pad = (a.paddingMs ?? 120) * 1000;
      let removedUs = 0, clips = 0;
      for (const seg of [...mainTrack(tl).segments]) {
        if (seg.kind !== "video" && seg.kind !== "audio") continue;
        const m = svc(ctx).repos.media.find(seg.mediaId);
        if (!m?.hasAudio) continue;
        const ranges = (await svc(ctx).analysis.silences(m.id, { noiseDb: a.noiseDb ?? -35, minDurS: a.minDurS ?? 0.6 }))
          .map(([s, e]) => [s + pad, e - pad]).filter(([s, e]) => e - s > 150_000);
        const cur = tlState(ctx, a.timelineId).timeline;
        const still = mainTrack(cur).segments.find((x) => x.id === seg.id);
        if (!still || !ranges.length) continue;
        const r = await exec(ctx, a.timelineId, "removeRanges", { segId: seg.id, ranges });
        removedUs += r.result || 0; clips++;
      }
      return { removedUs, clips, revision: tlState(ctx, a.timelineId).revision };
    },
  },
  {
    name: "audio_normalize", scope: "edit", title: "Normalize loudness",
    description: "Turns on loudness normalization (EBU R128) for every audible clip at a target LUFS (-23 broadcast, -14 web/social).",
    input: obj({ ...EDIT, targetLufs: S.num("Target LUFS", -30, -9) }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const clips = audibleClips(tlState(ctx, a.timelineId).timeline);
      if (!clips.length) return { changed: 0 };
      const r = await exec(ctx, a.timelineId, "patchMany", { label: "normalize", items: clips.map((s) => ({ segId: s.id, patch: { audioFx: { normalize: { enabled: true, targetLufs: a.targetLufs ?? -14 } } } })), expectedRevision: a.expectedRevision });
      return { changed: r.result, revision: r.revision };
    },
  },
  {
    name: "audio_enhance_voice", scope: "edit", title: "Clean up voice",
    description: "Turns on noise reduction and/or voice enhancement for every audible clip.",
    input: obj({ ...EDIT, denoise: { type: "boolean" }, enhanceVoice: { type: "boolean" } }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const clips = audibleClips(tlState(ctx, a.timelineId).timeline);
      if (!clips.length) return { changed: 0 };
      const fx = { denoise: { enabled: a.denoise !== false }, enhanceVoice: { enabled: a.enhanceVoice !== false } };
      const r = await exec(ctx, a.timelineId, "patchMany", { label: "voice", items: clips.map((s) => ({ segId: s.id, patch: { audioFx: fx } })), expectedRevision: a.expectedRevision });
      return { changed: r.result, revision: r.revision };
    },
  },
  {
    name: "timeline_set_canvas", scope: "edit", title: "Canvas ratio and background",
    description: "Changes the canvas ratio (9:16, 16:9, 1:1, ...), background type (color/blur), colour or blur.",
    input: obj({ ...EDIT, ratio: S.enumOf(Object.keys(CANVAS_RATIOS), "Ratio"), bgType: S.enumOf(["color", "blur"], "Background"), bgColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, bgBlur: S.num("Blur 0-100", 0, 100) }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const { timelineId, expectedRevision, ...c } = a; const r = await exec(ctx, timelineId, "setCanvas", { ...c, expectedRevision }); return { canvas: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_add_captions", scope: "edit", needs: ["media"], provider: "whisper", title: "Auto captions",
    description: "Transcribes the main-track clips with the local whisper.cpp model (Settings › Providers) and adds caption text clips. Fails with PROVIDER if no model is configured.",
    input: obj({ ...EDIT, language: { type: "string", pattern: "^(auto|[a-z]{2})$", description: "Language code or auto" } }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      svc(ctx).timelines.checkRevision(a.timelineId, a.expectedRevision);
      const tl = tlState(ctx, a.timelineId).timeline;
      let added = 0;
      for (const seg of mainTrack(tl).segments) {
        const m = seg.mediaId ? svc(ctx).repos.media.find(seg.mediaId) : null;
        if (!m?.hasAudio) continue;
        const cues = await svc(ctx).captions.transcribe({ mediaId: m.id, sourceStartUs: seg.sourceStart, durationUs: seg.duration, timelineStartUs: seg.start, speed: seg.speed || 1, language: a.language || "auto" });
        const segs = svc(ctx).captions.segmentsFromCues(cues, { canvasHeight: tl.canvas.height, language: a.language });
        for (const s of segs) { await exec(ctx, a.timelineId, "addSegment", { kind: "text", atUs: s.start, durationUs: s.duration, init: { text: s.text, transform: s.transform, name: s.name } }); added++; }
      }
      return { captions: added, revision: tlState(ctx, a.timelineId).revision };
    },
  },
  {
    name: "timeline_undo", scope: "edit", title: "Undo",
    description: "Undoes the last edit on the timeline (a whole skill run is one step).",
    input: obj({ ...TIMELINE }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "undo", {}); return { undone: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_redo", scope: "edit", title: "Redo",
    description: "Redoes the last undone edit.",
    input: obj({ ...TIMELINE }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "redo", {}); return { redone: r.result, revision: r.revision }; },
  },

  // ---------------------------------------------------------------- skills
  {
    name: "skills_execute", scope: "skills.run", title: "Run a skill",
    description: "Runs an installed skill on a timeline. All its edits form one undo step; on failure the timeline is restored. Returns a job: wait=true (default) waits up to 110 s, otherwise poll job_status.",
    input: obj({ skillId: S.str("Skill id", 80), version: S.str("Optional version", 40), ...EDIT, inputs: { type: "object", description: "Skill inputs (see skills_inspect)" }, wait: { type: "boolean" } }, ["skillId", "timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const job = ctx.jobs.start({ kind: "skill", clientId: ctx.clientId, label: a.skillId, run: (j) => ctx.skills.run({ skillId: a.skillId, version: a.version, timelineId: a.timelineId, inputs: a.inputs || {}, ctx, job: j, expectedRevision: a.expectedRevision }) });
      return a.wait === false ? ctx.jobs.status(job.jobId, ctx.clientId) : ctx.jobs.wait(job.jobId, 110_000, ctx.clientId);
    },
  },
  {
    name: "skills_save", scope: "skills.write", title: "Save a skill",
    description: "Validates and saves a skill as a user skill (a new id, or a new version of the client's own user skill). Official and imported skills cannot be overwritten.",
    input: obj({ skill: { type: "object", description: "Skill definition" } }, ["skill"]),
    run: (ctx, a) => ctx.skills.save(a.skill, { author: ctx.clientName || "agent" }),
  },

  // ---------------------------------------------------------------- export
  {
    name: "export_start", scope: "export", title: "Export the timeline",
    description: "Renders the timeline to a video file in the export folder allowed for this client. Returns a job id; poll job_status.",
    input: obj({ ...TIMELINE, name: { type: "string", pattern: "^[^\\\\/:*?\"<>|]{1,100}$", description: "File name without extension" }, resolution: S.enumOf(["480p", "720p", "1080p", "2k", "4k", "8k"], "Resolution"), codec: S.enumOf(["h264", "hevc", "av1", "prores"], "Codec"), fps: S.enumOf(["24", "25", "30", "50", "60"], "Frame rate"), rangeStartUs: S.us("Optional range start"), rangeEndUs: S.us("Optional range end") }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => {
      const dir = ctx.guard.exportDir();
      const range = a.rangeEndUs ? { startUs: a.rangeStartUs || 0, endUs: a.rangeEndUs } : null;
      const { jobId, path: out } = svc(ctx).exporter.start({ timelineId: a.timelineId, mode: "video", name: a.name || undefined, dir, resolution: a.resolution || "1080p", codec: a.codec || "h264", format: a.codec === "prores" ? "mov" : "mp4", fps: Number(a.fps || 30), range });
      ctx.jobs.trackExport(jobId, { clientId: ctx.clientId, path: out });
      return { jobId, path: out };
    },
  },
  {
    name: "export_cancel", scope: "export", title: "Cancel an export",
    description: "Cancels a running export started by this client.",
    input: obj({ jobId: S.str("Export job id", 64) }, ["jobId"]),
    run: (ctx, a) => { ctx.jobs.status(a.jobId, ctx.clientId); return { cancelled: svc(ctx).exporter.cancel(a.jobId) }; },
  },

  // ---------------------------------------------------------------- delete (needs the user's approval every time)
  {
    name: "project_trash", scope: "delete", approval: true, title: "Move a project to the trash",
    description: "Moves a project to the trash (restorable for 30 days). The user must approve it in Montaj Studio.",
    input: obj({ projectId: S.id("Project id") }, ["projectId"]),
    project: (a) => a.projectId,
    run: (ctx, a) => { svc(ctx).projects.trash(a.projectId); return { trashed: true }; },
  },
];

export const OPERATION_INDEX = new Map(OPERATIONS.map((o) => [o.name, o]));
export const SCOPES = ["read", "media", "edit", "skills.run", "skills.write", "export", "delete"];

/** Scope set an operation requires (its own plus `needs`). */
export const requiredScopes = (op) => [op.scope, ...(op.needs || [])];

/** Files an agent may import: these extensions only (no executables, scripts or project databases). */
export const IMPORTABLE = /\.(mp4|mov|m4v|mkv|avi|webm|wmv|mpg|mpeg|mts|m2ts|3gp|flv|jpg|jpeg|png|webp|bmp|gif|tif|tiff|heic|mp3|wav|aac|m4a|flac|ogg|opus|wma)$/i;

export const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
