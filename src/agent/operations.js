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
import { analyzeSpeech, sentences } from "../core/speech.js";
import { run as runProcess, binaries } from "../services/ffmpeg.js";
import { CAPTION_TEMPLATES } from "../core/captionTemplates.js";
import { GRAPHIC_TEMPLATES, EMOJI_ALIASES } from "../core/graphics.js";
import { cutoutMedia } from "../core/cutout.js";
import { subjectTrack, subjectReady } from "./subject.js";
import { SFX } from "../core/sfx.js";
import { addSfx } from "./sfx.js";
import { autoEdit } from "./director.js";
import { dubTimeline, removeDubbing } from "./dub.js";
import { DUB_LANGUAGES } from "../services/dubService.js";
import { DEFAULT_TEXT } from "../core/model.js";
import { checkInputs } from "./skills/runtime.js";
import { EDIT_PLAN_SCHEMA } from "../core/editPlan.js";
import { inspectPlan, applyPlan } from "./editPlan.js";
import { applyCaptions, restyleCaptions, transact } from "./captions.js";

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
      trackId: t.id, type: t.type, isMain: !!t.isMain, hidden: !!t.hidden, muted: !!t.muted, locked: !!t.locked, behindPerson: t.role === "behind" || undefined,
      clips: t.segments.map((s) => ({
        clipId: s.id, kind: s.kind, name: s.name, startUs: s.start, durationUs: s.duration, mediaId: s.mediaId || null, sourceStartUs: s.sourceStart,
        speed: s.speedMode === "curve" ? `curve:${s.curve?.preset}` : s.speed, volumeDb: s.volumeDb,
        transform: s.transform && ((s.transform.scale ?? 1) !== 1 || s.transform.x || s.transform.y || s.transform.rotation) ? { scale: s.transform.scale ?? 1, x: s.transform.x || 0, y: s.transform.y || 0, rotation: s.transform.rotation || 0 } : undefined,
        animation: s.animation && ["in", "out", "combo"].some((k) => s.animation[k]?.type && s.animation[k].type !== "none") ? s.animation : undefined,
        transitionOut: s.transitionOut?.type && s.transitionOut.type !== "none" ? s.transitionOut : undefined,
        filter: s.filter?.preset ? s.filter : undefined, effect: s.effect?.type ? s.effect : undefined,
        text: s.text?.content !== undefined ? { content: s.text.content, isCaption: !!s.text.isCaption, graphic: s.text.graphic?.template } : undefined,
        disabled: s.disabled || undefined,
      })),
    })),
    markers: tl.markers,
  };
}

// Long operations run as jobs: the call waits up to WAIT_MS (below common MCP client tool timeouts) and otherwise
// returns the running job for job_status.
const WAIT_MS = 50_000;
function asJob(ctx, kind, label, fn, wait) {
  const job = ctx.jobs.start({ kind, clientId: ctx.clientId, label, run: (j) => fn(j) });
  return wait === false ? ctx.jobs.status(job.jobId, ctx.clientId) : ctx.jobs.wait(job.jobId, WAIT_MS, ctx.clientId);
}
const WAIT = { type: "boolean", description: "Wait for the result (default true, up to 50 s; otherwise poll job_status)" };

/** A graphic's own sound effects, on its motion: in (as it arrives), each (word-stack words), out (as it leaves). */
async function graphicSfx(ctx, timelineId, tpl, params, atUs, durationUs) {
  const s = tpl.sfx;
  if (!s) return;
  if (s.in) await addSfx(ctx, timelineId, s.in, atUs + tpl.inUs * 0.45);
  if (s.each && params.words?.length > 1) {
    const n = params.words.length, span = Math.max(200_000, durationUs - tpl.outUs - tpl.inUs - 300_000);
    for (let i = 1; i < n; i++) await addSfx(ctx, timelineId, s.each, atUs + (params.times?.[i] !== undefined ? params.times[i] * 1000 : (span * i) / (n - 1)) + tpl.inUs * 0.45);
  }
  if (s.out && durationUs > tpl.inUs + tpl.outUs + 300_000) await addSfx(ctx, timelineId, s.out, atUs + durationUs - tpl.outUs * 0.5);
}

/** Person-matte readiness of the videos the cutouts of a timeline use. */
const matteState = (ctx, tl) => cutoutMedia(tl).map((mediaId) => ({ mediaId, ready: svc(ctx).mattes.ready(mediaId) }));

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
  {
    name: "timeline_frames", scope: "read", title: "Look at the timeline",
    description: "Renders frames of the edited timeline exactly as they will be exported (all layers, text, captions, effects) and returns them as JPEG images, at the given TIMELINE times or `count` evenly spaced ones. Use it to check your edit visually.",
    input: obj({ ...TIMELINE, timesUs: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 12, description: "Timeline times (µs)" }, count: { type: "integer", minimum: 1, maximum: 12 }, short: { type: "integer", minimum: 120, maximum: 720 } }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const total = durationOf(tlState(ctx, a.timelineId).timeline);
      if (!total) throw new AppError("VALIDATION", "err.timelineEmpty");
      const n = a.count || 4;
      const times = a.timesUs?.length ? a.timesUs : Array.from({ length: n }, (_, i) => Math.round((total * (i + 0.5)) / n));
      const rendered = await svc(ctx).exporter.renderFrames(a.timelineId, times, { short: a.short || 360 });
      try {
        return { timelineId: a.timelineId, textOmitted: rendered[0]?.textOmitted || undefined, frames: rendered.map((r) => ({ atUs: r.atUs })), images: rendered.map((r) => ({ mimeType: "image/jpeg", data: fs.readFileSync(r.file).toString("base64") })) };
      } finally { for (const r of rendered) fs.rmSync(r.file, { force: true }); }
    },
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
  {
    name: "media_frames", scope: "media", title: "Look at a media file",
    description: "Returns still images (JPEG) of a source media file at the given SOURCE times (or `count` evenly spaced ones), so you can see what is in the footage. short = size of the image's short side in px.",
    input: obj({ mediaId: S.id("Media id"), timesUs: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 12, description: "Source times (µs)" }, count: { type: "integer", minimum: 1, maximum: 12 }, short: { type: "integer", minimum: 120, maximum: 720 } }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: async (ctx, a) => {
      const m = svc(ctx).repos.media.get(a.mediaId);
      if (!m.hasVideo && m.type !== "image") throw new AppError("VALIDATION", "err.noVideo", { mediaId: a.mediaId });
      const dur = m.durationUs || 0;
      const n = a.count || 4;
      const times = a.timesUs?.length ? a.timesUs : m.type === "image" ? [0] : Array.from({ length: n }, (_, i) => Math.round((dur * (i + 0.5)) / n));
      const short = a.short || 360;
      const dir = path.join(svc(ctx).paths.cache, "frames");
      fs.mkdirSync(dir, { recursive: true });
      const frames = [], images = [];
      for (const t of times) {
        const file = path.join(dir, `m-${a.mediaId}-${t}-${Date.now()}.jpg`);
        try {
          await runProcess(binaries().ffmpeg, ["-hide_banner", "-y", ...(m.type === "image" ? [] : ["-ss", String(Math.min(t, Math.max(0, dur - 50_000)) / US)]), "-i", m.path, "-frames:v", "1",
            "-vf", `scale='if(gt(iw,ih),-2,${short})':'if(gt(iw,ih),${short},-2)'`, "-q:v", "4", file], { timeoutMs: 60_000 });
          frames.push({ atUs: t });
          images.push({ mimeType: "image/jpeg", data: fs.readFileSync(file).toString("base64") });
        } finally { fs.rmSync(file, { force: true }); }
      }
      return { mediaId: a.mediaId, frames, images };
    },
  },
  {
    name: "media_transcribe", scope: "media", provider: "whisper", title: "Transcribe speech (word timings)",
    description: "Word-level transcript of a media file in SOURCE time (µs from the start of the file), with sentences. Uses the local speech model (Settings › Providers); cached per file, so repeated calls are instant. Optional window fromUs/toUs. Words are [text, startUs, endUs]. Runs as a job (see wait).",
    input: obj({ mediaId: S.id("Media id"), language: { type: "string", pattern: "^(auto|[a-z]{2})$", description: "Spoken language code or auto" }, fromUs: S.us("Optional window start"), toUs: S.us("Optional window end"), words: { type: "boolean", description: "Include the word list (default true)" }, wait: WAIT }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: (ctx, a) => asJob(ctx, "transcribe", a.mediaId, async () => {
      const tr = await svc(ctx).captions.transcribeWords({ mediaId: a.mediaId, language: a.language || "auto" });
      const from = a.fromUs ?? 0, to = a.toUs ?? Infinity;
      const ws = tr.words.filter((w) => w.startUs >= from && w.endUs <= to);
      return { mediaId: a.mediaId, language: tr.language, engine: tr.engine, model: tr.model, durationUs: tr.durationUs,
        sentences: sentences(ws).map((s) => ({ startUs: s.startUs, endUs: s.endUs, text: s.text })),
        words: a.words === false ? undefined : ws.map((w) => [w.text, w.startUs, w.endUs]) };
    }, a.wait),
  },
  {
    name: "media_analyze_speech", scope: "media", provider: "whisper", title: "Analyze speech for editing",
    description: "From the word transcript: sentences, filler words (sure = hesitation sounds; maybe = words like 'so'/'يعني' that can carry meaning — never cut automatically), pauses, retakes (a sentence restarted by the next one; the first attempt is listed) and suggestedCuts as SOURCE ranges to remove, each with a reason. style: tight (reels) or natural. Runs as a job (see wait).",
    input: obj({ mediaId: S.id("Media id"), language: { type: "string", pattern: "^(auto|[a-z]{2})$" }, style: S.enumOf(["tight", "natural"], "Cut style"), pauseMinS: S.num("Report pauses at least this long (s)", 0.2, 5), wait: WAIT }, ["mediaId"]),
    media: (a) => a.mediaId,
    run: (ctx, a) => asJob(ctx, "speech", a.mediaId, async () => {
      const tr = await svc(ctx).captions.transcribeWords({ mediaId: a.mediaId, language: a.language || "auto" });
      return { mediaId: a.mediaId, ...analyzeSpeech(tr, { style: a.style || "natural", pauseMinUs: Math.round((a.pauseMinS ?? 0.5) * US) }) };
    }, a.wait),
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
    description: "Adds an imported media file to the timeline. Main track (default): appended at the end, or inserted at the clip boundary nearest atUs (later clips move right). toMain=false: an overlay at atUs.",
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
    input: obj({ ...EDIT, clipIds: S.ids("Clips to change (same patch for all)"), patch: { type: "object", description: "Properties to merge into each clip" }, items: { type: "array", maxItems: 500, description: "Or different patches per clip in ONE undo step: [{clipId, patch}]", items: { type: "object", additionalProperties: false, required: ["clipId", "patch"], properties: { clipId: { type: "string", pattern: "^[A-Za-z0-9-]+$" }, patch: { type: "object" } } } } }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const items = a.items?.length ? a.items.map((x) => ({ segId: x.clipId, patch: x.patch })) : (a.clipIds || []).map((segId) => ({ segId, patch: a.patch }));
      if (!items.length || items.some((x) => !x.patch)) throw new AppError("VALIDATION", "err.inputsInvalid", { field: "items", errors: ["give clipIds + patch, or items"] });
      const r = await exec(ctx, a.timelineId, "patchMany", { label: "agent update", items, expectedRevision: a.expectedRevision });
      return { changed: r.result, revision: r.revision };
    },
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

  // ---------------------------------------------------------------- captions & edit plans
  {
    name: "captions_templates", scope: "read", title: "Caption templates",
    description: "Word-timed caption templates (id, name, when to use, how it animates).",
    input: obj({}),
    run: () => Object.entries(CAPTION_TEMPLATES).map(([id, t]) => ({ id, name: t.name, use: t.use, mode: t.mode, highlight: t.highlight, pop: t.pop, maxWords: t.maxWords })),
  },
  {
    name: "timeline_add_captions_pro", scope: "edit", needs: ["media"], provider: "whisper", title: "Animated captions",
    description: "Adds word-timed animated captions for everything spoken on the main track (after cuts), using the local speech model, as one undo step. template: see captions_templates. keywords: words to emphasize in the accent colour (numbers are emphasized automatically). replace (default true) removes earlier captions. Returns pages, words and a reading-speed check (qc). Runs as a job (see wait).",
    input: obj({ ...EDIT, template: S.enumOf(Object.keys(CAPTION_TEMPLATES), "Template"), language: { type: "string", pattern: "^(auto|[a-z]{2})$" }, keywords: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 200 }, autoEmphasis: { type: "boolean" }, reveal: { type: "boolean", description: "Words appear only when spoken (no spoilers); recommended for reveals/punchlines" }, replace: { type: "boolean" }, corrections: { type: "array", maxItems: 300, description: "Fix recognition mistakes (dialect, names): [{ from, to }] word or phrase, punctuation ignored; timing kept", items: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", minLength: 1, maxLength: 120 }, to: { type: "string", maxLength: 120 } } } }, positionY: S.num("Vertical position (fraction of the frame from the centre, + = lower)", -0.45, 0.45), overrides: { type: "object", additionalProperties: false, properties: { color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, active: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, accent: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, activeBox: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, size: { type: "number", minimum: 3, maximum: 30 } } }, wait: WAIT }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => asJob(ctx, "captions", a.template || "captions", () => transact(ctx, a.timelineId, `captions:${a.template || "karaoke-yellow"}`, a.expectedRevision, () => applyCaptions(ctx, a.timelineId, a)), a.wait),
  },
  {
    name: "timeline_captions_style", scope: "edit", title: "Restyle captions",
    description: "Changes the template, colours, size or position of every animated caption page of a timeline (one undo step).",
    input: obj({ ...EDIT, template: S.enumOf(Object.keys(CAPTION_TEMPLATES), "Template"), positionY: S.num("Vertical position", -0.45, 0.45), overrides: { type: "object" }, reveal: { type: "boolean", description: "Words appear only when spoken" } }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => { svc(ctx).timelines.checkRevision(a.timelineId, a.expectedRevision); return restyleCaptions(ctx, a.timelineId, a); },
  },
  {
    name: "graphics_templates", scope: "read", title: "Motion-graphics templates",
    description: "Animated graphics you can add (titles, lower thirds, numbered points, checklists, counters, callout arrows, highlight boxes, 3D emoji, icon badges, big words, quotes, follow CTA, progress bar) and the Remotion kit (engine: remotion — kinetic words, slam stamps, impact numbers, counter rolls, list montages, compare gauges, name tags, chapter cards, phone frames, flashbacks, confetti, speed lines, hand-drawn circles and arrows, stickers, animated emoji…, each with a contract: when it fits, its length and text limits): id, purpose, parameters with defaults, default duration. Emoji may be given as the character (🔥) — see emoji list.",
    input: obj({}),
    run: () => ({ templates: Object.entries(GRAPHIC_TEMPLATES).map(([id, t]) => ({ id, name: t.name, ar: t.ar, use: t.use, durationUs: t.durUs, loop: t.loop, params: t.params })), emoji: Object.keys(EMOJI_ALIASES) }),
  },
  {
    name: "timeline_add_graphic", scope: "edit", title: "Add a motion graphic",
    description: "Adds an animated graphic (see graphics_templates) at a TIMELINE time. params are checked against the template; missing ones take their defaults. Person-aware templates (subject: true — emerge-side, rise-behind, word-stack, pass-behind, head-emoji, head-icon) follow the person's head automatically (the app reads it from the person matte; the first time per video this runs as a job) and the kinetic ones go behind the person unless behindPerson is false. Start them ~0.1 s before the spoken word they show.",
    input: obj({ ...EDIT, template: S.enumOf(Object.keys(GRAPHIC_TEMPLATES), "Template"), params: { type: "object" }, atUs: S.us("Start"), durationUs: S.us("Length (default: the template's)", 200_000), behindPerson: { type: "boolean", description: "Draw it behind the person (default: true for the templates made for it)" }, sfx: { type: "boolean", description: "Add the template's sound effects on its motion (whoosh in, pop, …)" }, wait: WAIT }, ["timelineId", "template"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const tpl = GRAPHIC_TEMPLATES[a.template];
      const params = checkInputs({ type: "object", properties: tpl.params, additionalProperties: false }, a.params || {}, `${a.template}.params`);
      const atUs = a.atUs ?? 0, durationUs = a.durationUs ?? tpl.durUs;
      const behind = a.behindPerson ?? !!tpl.behind;
      const add = async () => {
        if (tpl.subject && !params.subject?.track?.length) params.subject = await subjectTrack(ctx, a.timelineId, atUs, durationUs);
        const label = String(params.text || params.title || params.label || params.words?.join(" ") || params.emoji || tpl.name).slice(0, 40);
        const r = await exec(ctx, a.timelineId, "addSegment", { kind: "text", atUs, durationUs, expectedRevision: a.expectedRevision,
          init: { name: `${tpl.name}: ${label}`, text: { ...DEFAULT_TEXT, content: label, graphic: { template: a.template, params } } } });
        if (a.sfx) await graphicSfx(ctx, a.timelineId, tpl, params, atUs, durationUs);
        if (!behind) return { clipId: r.result, revision: r.revision };
        const b = await exec(ctx, a.timelineId, "setBehindPerson", { ids: [r.result], value: true });
        if (!svc(ctx).exporter.derivedReady(b.timeline)) await svc(ctx).exporter.prepareDerived(b.timeline);
        return { clipId: r.result, revision: b.revision, behindPerson: true, mattes: matteState(ctx, b.timeline) };
      };
      // A person matte still to make (tens of seconds) → a job; inside an edit plan (already a job) → inline.
      const slow = (tpl.subject || behind) && !subjectReady(ctx, a.timelineId, atUs, durationUs);
      return slow && !a.inline ? asJob(ctx, "graphic", tpl.name, add, a.wait) : add();
    },
  },
  {
    name: "sfx_list", scope: "read", title: "Sound effects",
    description: "The bundled sound effects (ids, what each is for, default level). Add them with timeline_add_sfx, or with sfx: true on timeline_add_graphic (each template has its own in/out sounds).",
    input: obj({}),
    run: () => Object.entries(SFX).map(([id, s]) => ({ id, ar: s.ar, use: s.use, volumeDb: s.volumeDb, leadMs: s.leadUs / 1000 })),
  },
  {
    name: "timeline_add_sfx", scope: "edit", title: "Add a sound effect",
    description: "Adds a bundled sound effect (see sfx_list) so that its accent lands on a TIMELINE moment (e.g. a whoosh peaking as text flies in, an impact on a punch-in). It starts a little earlier by itself. One undo step per call.",
    input: obj({ ...EDIT, sound: S.enumOf(Object.keys(SFX), "Sound"), atUs: S.us("The moment the sound marks"), volumeDb: S.num("Level (dB, default: the sound's own)", -40, 6) }, ["timelineId", "sound", "atUs"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => { svc(ctx).timelines.checkRevision(a.timelineId, a.expectedRevision); return addSfx(ctx, a.timelineId, a.sound, a.atUs, { volumeDb: a.volumeDb }); },
  },
  {
    name: "musicbed_place", scope: "edit", title: "Music under the speech",
    description: "Puts a music file under the edit as a music bed: its own music track that is lowered under the speech (ducking by duckDb, sidechain-style from where words are heard), at a level measured against the speech (16 LU under it between phrases; autoLevel false: volumeDb), with fades. mediaId = a sound or video of the project, or libraryId = a music-library item (added to the project first). fromUs / toUs = TIMELINE times (default: the whole edit). One undo step. Change the ducking later with musicbed_set_duck.",
    input: obj({ ...EDIT, mediaId: S.id("A sound or video of the project"), libraryId: S.str("A music-library item id (instead of mediaId)", 80), fromUs: S.us("Timeline time where it starts (default 0)"), toUs: S.us("Timeline time where it ends (default: the end of the edit or of the file)"), offsetUs: S.us("Where in the music file it starts"), duckDb: S.num("How much it is lowered under the speech (dB, default 12; 0 = no ducking)", 0, 40), autoLevel: { type: "boolean", description: "Level measured against the speech (default true)" }, volumeDb: S.num("Level when autoLevel is false (dB, default -18)", -60, 12) }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      if (!a.mediaId && !a.libraryId) throw new AppError("VALIDATION", "err.musicBedMedia");
      svc(ctx).timelines.checkRevision(a.timelineId, a.expectedRevision);
      const r = await svc(ctx).timelines.runAs(ctx.source, () => svc(ctx).music.bed.place(a.timelineId, { mediaId: a.mediaId, libraryId: a.libraryId, projectId: projectOfTimeline(ctx, a.timelineId), fromUs: a.fromUs ?? null, toUs: a.toUs ?? null, offsetUs: a.offsetUs || 0, duckDb: a.duckDb, autoLevel: a.autoLevel, volumeDb: a.volumeDb }));
      return { clipId: r.result, revision: r.revision, level: r.level };
    },
  },
  {
    name: "musicbed_set_duck", scope: "edit", title: "Music ducking",
    description: "Makes a sound clip a music bed lowered under the speech by duckDb (0 = a music track that does not duck), or an ordinary sound again (duckDb null). The setting is the track's: a clip that shares its track with other sounds moves to its own music track first. One undo step.",
    input: obj({ ...EDIT, clipId: S.str("The sound clip", 80), duckDb: { type: ["number", "null"], minimum: 0, maximum: 40, description: "dB under the speech (default 12), or null: not a music bed" } }, ["timelineId", "clipId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => {
      svc(ctx).timelines.checkRevision(a.timelineId, a.expectedRevision);
      const r = svc(ctx).timelines.runAs(ctx.source, () => svc(ctx).music.bed.setDuck(a.timelineId, a.clipId, a.duckDb === undefined ? 12 : a.duckDb));
      return { duckDb: r.result, revision: r.revision };
    },
  },
  {
    name: "timeline_set_jl", scope: "edit", title: "J / L cut",
    description: "Shifts the sound of a main-track joint: jlUs < 0 is a J cut (this clip's sound starts before its picture), > 0 an L cut (the previous clip's sound runs on under this clip's picture), 0 a plain cut. clipId = the main-track clip AFTER the joint. Clamped to half of either clip (at most 0.5 s) and to what the files have. One undo step.",
    input: obj({ ...EDIT, clipId: S.str("The main-track clip after the joint", 80), jlUs: { type: "integer", minimum: -500_000, maximum: 500_000, description: "The shift (microseconds): < 0 J, > 0 L, 0 none" } }, ["timelineId", "clipId", "jlUs"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await exec(ctx, a.timelineId, "setJL", { segId: a.clipId, jlUs: a.jlUs, expectedRevision: a.expectedRevision }); return { jlUs: r.result, revision: r.revision }; },
  },
  {
    name: "timeline_behind_person", scope: "edit", title: "Text behind the person",
    description: "Puts layers (texts, graphics, stickers, images) BEHIND the person, or back in front (behind=false). The person on the main-track video is cut out with a local segmentation model and drawn over them. The first use per video file makes its person matte (~0.4× real time on the CPU); this runs as a job. Best with big titles/words placed where the person's head or body passes in front.",
    input: obj({ ...EDIT, clipIds: { type: "array", minItems: 1, maxItems: 100, items: S.str("Clip id", 80) }, behind: { type: "boolean", description: "true (default) = behind the person" }, wait: WAIT }, ["timelineId", "clipIds"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => {
      const r = await exec(ctx, a.timelineId, "setBehindPerson", { ids: a.clipIds, value: a.behind !== false, expectedRevision: a.expectedRevision });
      if (svc(ctx).exporter.derivedReady(r.timeline)) return { moved: r.result, revision: r.revision, mattes: matteState(ctx, r.timeline) };
      return asJob(ctx, "matte", "person matte", async (j) => {
        await svc(ctx).exporter.prepareDerived(r.timeline, (stage, p) => j.progress?.(p, stage === "matte" ? "person matte" : "stabilization"));
        return { moved: r.result, revision: r.revision, mattes: matteState(ctx, r.timeline) };
      }, a.wait);
    },
  },
  {
    name: "edit_auto", scope: "edit", title: "Edit it for me (director)",
    description: "The built-in director plans a whole edit of a talking video from what is said and where the person is: creator pacing (every pause cut on the words, beats and shown moments kept), alternate framing to hide jump cuts, punch-ins on questions, graphics chosen per sentence (emoji for named concepts, words coming out from behind the person, stacked words), sound effects on every motion, stabilization, voice clean-up, platform loudness, revealed captions. apply=false (default) returns the plan and the reason for each decision — show it, adjust it, then edit_plan_apply; apply=true applies it as one undo step. The result has qa: the quality guards on the plan (speech intact — no cut inside a word, no word lost; a reason to keep watching every 6 s; the head never cropped by a zoom; emoji and sound-effect limits; no word shown before it is said; the hook and the ending) and the pacing stats (cuts/min, shot lengths). The rules and numbers are the edit-hamdy editing skill's. Long videos: targetSec makes a reel; stabilize/person false make it much faster. The result has estimate (the stages and their expected seconds). Phase 7 pipeline: the video becomes numbered moments (sentences AND wordless action / reactions from the perception timeline — perceive: cached by default, run analyses it first, off uses the words only), 3–5 treatments that point only to moment numbers (different hook: the result first, a question, the reaction first, straight into the action; different structure and length — by rules, plus a local Qwen or Claude planner), each one executed and scored on the rubric (hook in the first 3 s, pace, punch with its reaction, no repetition, no cut inside a word), compared two by two (a judge model asked in both orders), the winner given graphics and sounds by meaning; guards that fail when most of a wordless action video is cut. The result has cutSheet (the chosen treatment and its alternatives), moments and links. Phase 8 story order: with two clips or more (story auto) — or one long raw shot out of order (story on) — the moments are grouped into scenes and put in the order that tells the story (cause before reaction, promise before payoff; the clips' recording times as hints unless storyHints off; a planner model proposes the order with storyPlanner), the shooting order stays on the cut sheet as an alternative; the result has story. No spoiler: for the explain style and explainers (spoiler auto; or avoid / allow) the opening never flash-forwards to the ending. Kept wordless action keeps its own sound under the voice clean-up (the plan's audio.keepAmbience), so talking videos keep longer action beats. The main track holds one or several clips (videos and pictures, cut or not); the result is a montaj.editplan/2 plan. Needs the media permission (speech model). Runs as a job.",
    input: obj({ ...EDIT, style: S.enumOf(["energetic", "explain", "calm"], "Pace: energetic (MrBeast rhythm), explain (normal), calm"), keywords: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 60, description: "Words to show/emphasise first" }, cta: S.str("Call to action at the end (empty: none)", 80), captionTemplate: S.enumOf(Object.keys(CAPTION_TEMPLATES), "Caption template"), corrections: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", minLength: 1, maxLength: 120 }, to: { type: "string", maxLength: 120 } } } }, language: { type: "string", pattern: "^(auto|[a-z]{2})$" }, targetSec: { type: "number", minimum: 15, maximum: 600, description: "Make a reel of about this many seconds: the strongest whole sentences, in order (long videos)" }, stabilize: { type: "boolean", description: "Stabilize the picture (default true; the slowest step: ~1.4 × the video's length)" }, person: { type: "boolean", description: "Find the person to place graphics by them (default true; ~0.5 × the video's length)" }, perceive: S.enumOf(["cached", "run", "off"], "The perception timeline (actions, laughs, reactions): cached (default), run it first (≈ 1.3 × the length, GPU), off"), planner: S.enumOf(["rules", "auto", "local", "claude"], "Who proposes treatments besides the rules: rules only (default), auto/local (a Qwen model on this computer, GPU), claude (the stronger director; needs ANTHROPIC_API_KEY in the app's environment)"), plannerModel: S.enumOf(["auto", "qwen3.8-27b", "qwen3.6-35b-a3b"], "The local planner model"), treatment: S.str("Force a treatment by its id (from an earlier cutSheet)", 60), graphics: S.enumOf(["meaning", "words"], "Graphics chosen by the meaning of each moment (default) or the old key-word texts"), sounds: S.enumOf(["library", "bundled"], "Sound effects from the sound library by meaning (default) or the bundled ones"), story: S.enumOf(["auto", "on", "off"], "Story order: auto (default: with two clips or more), on (also one long raw shot out of order), off (keep the timeline order)"), storyHints: S.enumOf(["auto", "off"], "Use the clips' recording times as hints for the story order (default auto)"), storyPlanner: S.enumOf(["rules", "local", "claude"], "Who orders the story when planner is rules: rules (default), local (a Qwen model, GPU), claude"), spoiler: S.enumOf(["auto", "avoid", "allow"], "May the opening flash-forward to the ending? auto (default: not for the explain style or an explainer), avoid, allow"), contentType: S.enumOf(["explainer", "comedy", "interview", "cooking", "challenge", "vlog", "default"], "What the video is (default: from the project and file names)"), apply: { type: "boolean" }, wait: WAIT }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => {
      if (!ctx.guard.hasScope("media")) throw new AppError("FORBIDDEN", "err.scopeMissing", { scope: "media", op: "edit_auto" });
      return asJob(ctx, "director", a.apply ? "auto edit" : "auto edit (plan)", (j) => autoEdit(ctx, a.timelineId, a, j), a.wait);
    },
  },
  {
    name: "edit_dub", scope: "edit", title: "Dub an Arabic video",
    description: "Dubs the Arabic speech of the timeline's video into another language on this computer: the speech is separated from the music and sounds (kept), written down (the Egyptian model), split by speaker (each one's kind — man, woman, child — and a sample of their voice), translated by a local LLM into lines that fit the time each sentence had (with its feeling: neutral, happy, excited, sad, angry, surprised, serious, warm, curious), then spoken in each speaker's own cloned voice with that feeling, every line heard back and re-taken when it was not said as meant, placed at its sentence's moment with no two voices at once. The new voice and the kept background become two audio tracks that follow the video's clips; the clip's own sound is turned off (edit_dub_remove turns it back on). Only Arabic videos (checked first). The result lists the speakers and every line (Arabic, the new words, feeling, speed, check = how closely it was heard back). Needs the media permission. Runs as a job.",
    input: obj({ ...TIMELINE, mediaId: S.id("The video to dub (default: the one video on the main track)"), lang: S.enumOf(DUB_LANGUAGES, "Language to dub into (default en)"), context: S.str("What the video is about (helps names and terms)", 500), duckDb: { type: "number", minimum: 0, maximum: 20, description: "How much the background is lowered under the new voice (dB, default 6)" }, wait: WAIT }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => {
      if (!ctx.guard.hasScope("media")) throw new AppError("FORBIDDEN", "err.scopeMissing", { scope: "media", op: "edit_dub" });
      return asJob(ctx, "dub", `dub (${a.lang || "en"})`, (j) => dubTimeline(ctx, a.timelineId, a, j), a.wait);
    },
  },
  {
    name: "edit_dub_remove", scope: "edit", title: "Remove a dub",
    description: "Removes the dub tracks of the timeline's video and turns its own sound back on (one undo step).",
    input: obj({ ...TIMELINE, mediaId: S.id("The dubbed video (default: the one video on the main track)") }, ["timelineId"]),
    timeline: (a) => a.timelineId,
    run: async (ctx, a) => { const r = await removeDubbing(ctx, a.timelineId, a); return { revision: r.revision }; },
  },
  {
    name: "edit_plan_schema", scope: "read", title: "Edit plan format",
    description: "The JSON Schema of an edit plan with an example. Two versions: montaj.editplan/1 (cuts out of one video) and montaj.editplan/2 (what the director writes): segments = the main track in EDIT order as SOURCE spans of any media of the project (several files, any order; role \"hook\" = a flash-forward copy that also stays in its natural place; jl = a J/L joint in ms before the segment), plus zooms, texts, graphics (with anchor = the word they enter on, and a reason), sfx (a bundled sound, or library = a sound of the sound library, with query/mood = what it means), b-roll, music beds (each on its own music track, lowered under the speech by duckDb at a level measured against it unless autoLevel is false), transitions by segment, retakes (each group's takes and the kept one), a colour look, audio clean-up (audio.keepAmbience = SOURCE spans of kept wordless action whose own sound the clean-up leaves alone) and animated captions. Times are SOURCE times (the times in media_transcribe / media_analyze_speech); overlays land on their natural place unless pinned with segment.",
    input: obj({}),
    run: () => ({ schema: EDIT_PLAN_SCHEMA, example: { schema: "montaj.editplan/1", title: "Reel v1", canvas: { ratio: "9:16", bgType: "blur" }, cuts: [{ mediaId: "<id>", fromUs: 1760000, toUs: 2480000, reason: "filler" }], zooms: [{ mediaId: "<id>", fromUs: 6060000, toUs: 9060000, scale: 1.2, reason: "key sentence" }], texts: [{ mediaId: "<id>", fromUs: 0, toUs: 2500000, content: "3 editing tricks", preset: "outline_white", position: "top" }], transitions: [{ mediaId: "<id>", atUs: 10040000, type: "push_left", durationUs: 250000 }], filter: { preset: "vivid", intensity: 60 }, audio: { denoise: true, enhanceVoice: true, normalizeLufs: -14 }, captions: { template: "karaoke-yellow", keywords: ["three"] } },
      notes: ["Times are SOURCE times of the media file; the plan maps them through the cuts.", "Validate with edit_plan_validate and show the cutSheet to the user before applying.", "edit_plan_apply makes the whole plan ONE undo step and restores everything if a step fails."] }),
  },
  {
    name: "edit_plan_validate", scope: "read", title: "Check an edit plan",
    description: "Validates an edit plan against its schema and the timeline (media on the main track, ranges, presets, speech model for captions) WITHOUT changing anything. Returns valid, errors, warnings, a summary (duration before/after) and a readable cutSheet to show the user for approval.",
    input: obj({ ...TIMELINE, plan: { type: "object", description: "montaj.editplan/1 or montaj.editplan/2 (see edit_plan_schema)" } }, ["timelineId", "plan"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => inspectPlan(ctx, a.timelineId, a.plan),
  },
  {
    name: "edit_plan_apply", scope: "edit", title: "Apply an edit plan",
    description: "Applies a validated edit plan to the timeline as ONE undo step (label plan:<title>); if any step fails the timeline is restored. Pass expectedRevision from timeline_inspect. Captions in the plan need the media permission. Returns what was applied, skipped items, duration before/after. Runs as a job (see wait).",
    input: obj({ ...EDIT, plan: { type: "object", description: "montaj.editplan/1 or montaj.editplan/2 (see edit_plan_schema)" }, wait: WAIT }, ["timelineId", "plan"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => asJob(ctx, "plan", a.plan?.title || "plan", (j) => applyPlan(ctx, a.timelineId, a.plan, { expectedRevision: a.expectedRevision, job: j }), a.wait),
  },

  // ---------------------------------------------------------------- skills
  {
    name: "skills_execute", scope: "skills.run", title: "Run a skill",
    description: "Runs an installed skill on a timeline. All its edits form one undo step; on failure the timeline is restored. Returns a job: wait=true (default) waits up to 50 s, otherwise poll job_status.",
    input: obj({ skillId: S.str("Skill id", 80), version: S.str("Optional version", 40), ...EDIT, inputs: { type: "object", description: "Skill inputs (see skills_inspect)" }, wait: WAIT }, ["skillId", "timelineId"]),
    timeline: (a) => a.timelineId,
    run: (ctx, a) => asJob(ctx, "skill", a.skillId, (j) => ctx.skills.run({ skillId: a.skillId, version: a.version, timelineId: a.timelineId, inputs: a.inputs || {}, ctx, job: j, expectedRevision: a.expectedRevision }), a.wait),
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
