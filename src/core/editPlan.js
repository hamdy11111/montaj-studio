// Edit plans: a whole edit described as data in SOURCE time — the times an agent reads in a transcript — and compiled
// onto the main track. Two versions:
//  · montaj.editplan/1: cuts removed from the clips already on the main track (one file, source order);
//  · montaj.editplan/2: the main track as an ORDERED list of segments (source spans of any media of the project, in
//    any order: reordered story, a flash-forward hook taken from later and, when the plan says so, kept in its natural
//    place too), the J/L of each joint, and what later stages fill in: music, b-roll, graphics anchored on a word with
//    a written reason, and the retake groups (which take was kept and why).
// Pure helpers: the schemas, mapping source time to timeline time through the main-track clips, predicting the result,
// and the readable cut sheet shown for approval. Applying a plan (one undo step, rollback) lives in src/agent/editPlan.js.
import { SFX } from "./sfx.js";
import { TRANSITIONS } from "./layerMath.js";
import { CANVAS_RATIOS, mainTrack } from "./model.js";
import { FILTER_PRESETS, TEXT_PRESETS } from "./presets.js";
import { US } from "./util.js";
import { GRAPHIC_TEMPLATES } from "./graphics.js";

const MIN_CUT_US = 100_000; // the timeline ignores shorter cuts (removeRanges)

const range = (extra = {}, req = []) => ({
  type: "object", additionalProperties: false, required: ["mediaId", "fromUs", "toUs", ...req],
  properties: { mediaId: { type: "string", pattern: "^[A-Za-z0-9-]+$" }, fromUs: { type: "integer", minimum: 0 }, toUs: { type: "integer", minimum: 1 }, reason: { type: "string", maxLength: 200 }, ...extra },
});

export const EDIT_PLAN_SCHEMA_V1 = {
  $id: "montaj.editplan/1", type: "object", additionalProperties: false, required: ["schema"],
  properties: {
    schema: { const: "montaj.editplan/1" },
    title: { type: "string", maxLength: 120 },
    canvas: { type: "object", additionalProperties: false, properties: { ratio: { enum: Object.keys(CANVAS_RATIOS) }, bgType: { enum: ["color", "blur"] }, bgColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, bgBlur: { type: "number", minimum: 0, maximum: 100 } } },
    cuts: { type: "array", maxItems: 2000, items: range(), description: "SOURCE ranges removed from the main-track clips of that media" },
    zooms: { type: "array", maxItems: 300, items: range({ scale: { type: "number", minimum: 1.02, maximum: 2.5 }, x: { type: "number", minimum: -0.5, maximum: 0.5 }, y: { type: "number", minimum: -0.5, maximum: 0.5 } }, ["scale"]), description: "Punch-in: the main clip is shown larger during a SOURCE span (cut-zoom)" },
    texts: { type: "array", maxItems: 200, items: range({ content: { type: "string", minLength: 1, maxLength: 300 }, preset: { type: "string", maxLength: 40 }, position: { enum: ["top", "center", "bottom"] }, size: { type: "number", minimum: 4, maximum: 60 }, behindPerson: { type: "boolean" } }, ["content"]), description: "On-screen text during a SOURCE span" },
    graphics: { type: "array", maxItems: 200, items: range({ template: { enum: Object.keys(GRAPHIC_TEMPLATES) }, params: { type: "object" }, behindPerson: { type: "boolean", description: "Draw it behind the person (big titles, words)" }, sfx: { type: "boolean", description: "Add the template's own sound effects on its motion" } }, ["template"]), description: "Motion graphics during a SOURCE span (see graphics_templates)" },
    transitions: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["mediaId", "atUs", "type"], properties: { mediaId: { type: "string", pattern: "^[A-Za-z0-9-]+$" }, atUs: { type: "integer", minimum: 0 }, type: { enum: TRANSITIONS }, durationUs: { type: "integer", minimum: 100_000, maximum: 2_000_000 }, reason: { type: "string", maxLength: 200 } } }, description: "A transition at the cut nearest to SOURCE time atUs (typically the fromUs of a cut)" },
    sfx: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["mediaId", "atUs", "sound"], properties: { mediaId: { type: "string", pattern: "^[A-Za-z0-9-]+$" }, atUs: { type: "integer", minimum: 0 }, sound: { enum: Object.keys(SFX) }, volumeDb: { type: "number", minimum: -40, maximum: 6 },
      query: { type: "string", maxLength: 80, description: "What the sound means («قفشة», «صدمة», whoosh…): what the director asks the sound library for" },
      mood: { enum: ["comic", "joy", "shock", "neutral", "tense", "serious", "sad", "emotional", "religious"], description: "The moment's mood (no comic sound in a serious moment)" },
      library: { type: "object", additionalProperties: false, required: ["id", "file"], description: "A sound of the sound library (sfx_search) played instead of the bundled `sound` (the fallback when the file is missing)", properties: { id: { type: "string", maxLength: 200 }, file: { type: "string", maxLength: 1000 }, leadUs: { type: "integer", minimum: 0, maximum: 10_000_000, description: "where its accent is, from its start" }, title: { type: "string", maxLength: 120 } } } } }, description: "Sound effects whose accent lands on a SOURCE moment (see sfx_list)" },
    stabilize: { type: "boolean", description: "Stabilize the handheld main-track video (a stabilized copy is made once)" },
    filter: { type: "object", additionalProperties: false, required: ["preset"], properties: { preset: { enum: Object.keys(FILTER_PRESETS) }, intensity: { type: "number", minimum: 0, maximum: 100 } } },
    audio: { type: "object", additionalProperties: false, properties: { enhanceVoice: { type: "boolean" }, denoise: { type: "boolean" }, normalizeLufs: { type: "number", minimum: -30, maximum: -9 } } },
    captions: { type: "object", description: "Animated word-timed captions (see captions_templates)" },
  },
};

/** Main-track clips with their source spans: [{ id, mediaId, start, end, srcStart, srcEnd, speed, curve }]. */
export function mainPieces(tl) {
  return (mainTrack(tl)?.segments || []).slice().sort((a, b) => a.start - b.start).map((s) => {
    const speed = s.speedMode === "curve" ? 1 : s.speed || 1;
    return { id: s.id, kind: s.kind, mediaId: s.mediaId || null, start: s.start, end: s.start + s.duration, srcStart: s.sourceStart || 0, srcEnd: (s.sourceStart || 0) + s.duration * speed, speed, curve: s.speedMode === "curve" };
  });
}

/** Timeline intervals [{ t0, t1, pieceId }] showing SOURCE [fromUs, toUs) of a media on the main track. */
export function mapSpan(pieces, mediaId, fromUs, toUs) {
  const out = [];
  for (const p of pieces) {
    if (p.mediaId !== mediaId) continue;
    const a = Math.max(fromUs, p.srcStart), b = Math.min(toUs, p.srcEnd);
    if (b - a < 1) continue;
    out.push({ t0: Math.round(p.start + (a - p.srcStart) / p.speed), t1: Math.round(p.start + (b - p.srcStart) / p.speed), pieceId: p.id });
  }
  return out.sort((x, y) => x.t0 - y.t0);
}

/**
 * Timeline time of a SOURCE moment. Inside a kept piece: exact. Inside a removed stretch: the cut point (end of
 * the last kept piece before it, or the start of the next one). null if the media is not on the main track.
 */
export function mapPoint(pieces, mediaId, srcUs) {
  const mine = pieces.filter((p) => p.mediaId === mediaId);
  if (!mine.length) return null;
  const inside = mine.find((p) => srcUs >= p.srcStart && srcUs <= p.srcEnd);
  if (inside) return Math.round(inside.start + (srcUs - inside.srcStart) / inside.speed);
  const before = mine.filter((p) => p.srcEnd <= srcUs).sort((a, b) => b.srcEnd - a.srcEnd)[0];
  if (before) return before.end;
  return mine.sort((a, b) => a.srcStart - b.srcStart)[0].start;
}

/** Cut boundaries on the main track (end of every clip but the last), in timeline time. */
export const cutPoints = (pieces) => pieces.slice(0, -1).map((p) => ({ t: p.end, pieceId: p.id }));

/** Merge overlapping source ranges per media. */
export function normalizeCuts(cuts) {
  const by = new Map();
  for (const c of cuts || []) { if (!by.has(c.mediaId)) by.set(c.mediaId, []); by.get(c.mediaId).push({ ...c }); }
  for (const [m, list] of by) {
    list.sort((a, b) => a.fromUs - b.fromUs);
    const merged = [];
    for (const c of list) { const last = merged[merged.length - 1]; if (last && c.fromUs <= last.toUs) { last.toUs = Math.max(last.toUs, c.toUs); last.reason = [last.reason, c.reason].filter(Boolean).join("+"); } else merged.push(c); }
    by.set(m, merged);
  }
  return by;
}

/** Predicted main track after the cuts (pieces packed from the first clip's start, as the magnet main track does). */
export function predictCuts(pieces, cutsByMedia) {
  const out = [];
  for (const p of pieces) {
    let keep = [[p.srcStart, p.srcEnd]];
    for (const c of cutsByMedia.get(p.mediaId) || []) {
      const a = Math.max(c.fromUs, p.srcStart), b = Math.min(c.toUs, p.srcEnd);
      if ((b - a) / p.speed <= MIN_CUT_US) continue;
      keep = keep.flatMap(([s, e]) => (b <= s || a >= e ? [[s, e]] : [[s, a], [b, e]].filter(([x, y]) => y - x > 1)));
    }
    for (const [s, e] of keep) out.push({ ...p, srcStart: s, srcEnd: e, duration: (e - s) / p.speed });
  }
  let t = pieces.length ? pieces[0].start : 0;
  return out.map((p) => { const q = { ...p, start: t, end: t + p.duration }; t = q.end; return q; });
}

export const fmtTime = (us) => { const s = Math.max(0, us) / US; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };

/** Semantic checks of a v1 plan against the timeline: { errors, warnings, summary, cutSheet }. */
function checkPlanV1(plan, tl, { mediaDurations = {} } = {}) {
  const errors = [], warnings = [];
  const pieces = mainPieces(tl);
  const onMain = new Set(pieces.map((p) => p.mediaId).filter(Boolean));
  const refs = [...(plan.cuts || []), ...(plan.zooms || []), ...(plan.texts || []), ...(plan.graphics || []), ...(plan.transitions || [])];
  for (const m of new Set(refs.map((r) => r.mediaId))) if (!onMain.has(m)) errors.push({ path: "mediaId", message: `media ${m} is not on the main track` });
  if (pieces.some((p) => p.curve)) warnings.push({ path: "timeline", message: "main-track clips with a speed curve are mapped at speed 1 (times may be off)" });
  const check = (list, name) => (list || []).forEach((r, i) => {
    if (r.toUs <= r.fromUs) errors.push({ path: `${name}/${i}`, message: "toUs must be after fromUs" });
    const d = mediaDurations[r.mediaId];
    if (d && r.fromUs >= d) errors.push({ path: `${name}/${i}`, message: `starts after the end of the media (${fmtTime(d)})` });
  });
  check(plan.cuts, "cuts"); check(plan.zooms, "zooms"); check(plan.texts, "texts");
  for (const [i, x] of (plan.texts || []).entries()) if (x.preset && !TEXT_PRESETS[x.preset]) errors.push({ path: `texts/${i}/preset`, message: `unknown text preset ${x.preset}` });
  const cuts = normalizeCuts(plan.cuts);
  const after = predictCuts(pieces, cuts);
  const removedPieces = [];
  for (const [i, z] of (plan.zooms || []).entries()) if (!mapSpan(after, z.mediaId, z.fromUs, z.toUs).length) { warnings.push({ path: `zooms/${i}`, message: "the whole span is cut out — skipped" }); removedPieces.push(`zooms/${i}`); }
  for (const [i, x] of (plan.texts || []).entries()) if (!mapSpan(after, x.mediaId, x.fromUs, x.toUs).length) { warnings.push({ path: `texts/${i}`, message: "the whole span is cut out — skipped" }); removedPieces.push(`texts/${i}`); }
  for (const [i, x] of (plan.graphics || []).entries()) if (!mapSpan(after, x.mediaId, x.fromUs, x.toUs).length) warnings.push({ path: `graphics/${i}`, message: "the whole span is cut out — skipped" });
  const beforeUs = pieces.length ? pieces[pieces.length - 1].end : 0;
  const afterUs = after.length ? after[after.length - 1].end : 0;
  if (beforeUs && afterUs < beforeUs * 0.25) warnings.push({ path: "cuts", message: `the cuts remove ${Math.round(100 - (100 * afterUs) / beforeUs)}% of the main track` });

  const sheet = [];
  if (plan.canvas?.ratio) sheet.push({ at: null, kind: "canvas", text: `canvas ${plan.canvas.ratio}${plan.canvas.bgType ? ` (${plan.canvas.bgType})` : ""}` });
  for (const [m, list] of cuts) for (const c of list) sheet.push({ at: c.fromUs, mediaId: m, kind: "cut", text: `cut ${fmtTime(c.fromUs)}–${fmtTime(c.toUs)} (${((c.toUs - c.fromUs) / US).toFixed(1)}s)${c.reason ? ` — ${c.reason}` : ""}` });
  for (const z of plan.zooms || []) sheet.push({ at: z.fromUs, mediaId: z.mediaId, kind: "zoom", text: `zoom ×${z.scale} ${fmtTime(z.fromUs)}–${fmtTime(z.toUs)}${z.reason ? ` — ${z.reason}` : ""}` });
  for (const x of plan.texts || []) sheet.push({ at: x.fromUs, mediaId: x.mediaId, kind: "text", text: `text "${x.content}" ${fmtTime(x.fromUs)}–${fmtTime(x.toUs)}${x.reason ? ` — ${x.reason}` : ""}` });
  for (const x of plan.graphics || []) sheet.push({ at: x.fromUs, mediaId: x.mediaId, kind: "graphic", text: `graphic ${x.template} "${String(x.params?.text || x.params?.title || x.params?.emoji || "").slice(0, 40)}" ${fmtTime(x.fromUs)}–${fmtTime(x.toUs)}${x.reason ? ` — ${x.reason}` : ""}` });
  for (const x of plan.transitions || []) sheet.push({ at: x.atUs, mediaId: x.mediaId, kind: "transition", text: `transition ${x.type} at ${fmtTime(x.atUs)}${x.reason ? ` — ${x.reason}` : ""}` });
  if (plan.filter) sheet.push({ at: null, kind: "look", text: `look ${plan.filter.preset} ${plan.filter.intensity ?? 80}%` });
  if (plan.audio) sheet.push({ at: null, kind: "audio", text: `audio${plan.audio.denoise || plan.audio.enhanceVoice ? " clean-up" : ""}${plan.audio.normalizeLufs ? ` ${plan.audio.normalizeLufs} LUFS` : ""}` });
  if (plan.captions) sheet.push({ at: null, kind: "captions", text: `captions ${plan.captions.template || ""}`.trim() });
  sheet.sort((a, b) => (a.at ?? -1) - (b.at ?? -1));
  return {
    errors, warnings,
    summary: { beforeUs, afterUs, cuts: [...cuts.values()].reduce((n, l) => n + l.length, 0), removedUs: beforeUs - afterUs, zooms: (plan.zooms || []).length, texts: (plan.texts || []).length, graphics: (plan.graphics || []).length, transitions: (plan.transitions || []).length },
    cutSheet: sheet.map((x) => x.text),
  };
}

// ------------------------------------------------------------------ montaj.editplan/2
const MEDIA_ID = { type: "string", pattern: "^[A-Za-z0-9-]+$" };
const PIN = { segment: { type: "integer", minimum: 0, maximum: 1999, description: "Pin it to one occurrence: the index in segments (default: its natural place, not a hook copy)" } };
const ANCHOR = { anchor: { type: "object", additionalProperties: false, required: ["word"], properties: { word: { type: "string", minLength: 1, maxLength: 60 }, atUs: { type: "integer", minimum: 0, description: "SOURCE time of the word" } }, description: "The word it lands on" } };
export const JL_LIMIT_MS = 500;
const v1 = EDIT_PLAN_SCHEMA_V1.properties;
const pinned = (schema, extra = {}) => ({ ...schema, properties: { ...schema.properties, ...PIN, ...extra } });

export const EDIT_PLAN_SCHEMA_V2 = {
  $id: "montaj.editplan/2", type: "object", additionalProperties: false, required: ["schema", "segments"],
  properties: {
    schema: { const: "montaj.editplan/2" },
    title: v1.title, canvas: v1.canvas,
    segments: {
      type: "array", minItems: 1, maxItems: 2000, description: "The main track in EDIT order: SOURCE spans of the project's media, any order, a span may repeat (a hook)",
      items: { type: "object", additionalProperties: false, required: ["mediaId", "fromUs", "toUs"], properties: {
        mediaId: MEDIA_ID, fromUs: { type: "integer", minimum: 0 }, toUs: { type: "integer", minimum: 1 },
        role: { enum: ["hook", "body", "outro"], description: "hook: a flash-forward / cold open (its span may also be kept in its natural place)" },
        jl: { type: "integer", minimum: -JL_LIMIT_MS, maximum: JL_LIMIT_MS, description: "ms, the joint BEFORE this segment: < 0 J (its sound starts before its picture), > 0 L (the previous sound runs on under its picture)" },
        reason: { type: "string", maxLength: 200 },
      } },
    },
    zooms: { ...v1.zooms, items: pinned(v1.zooms.items) },
    texts: { ...v1.texts, items: pinned(v1.texts.items) },
    graphics: { ...v1.graphics, items: pinned(v1.graphics.items, ANCHOR), description: "Motion graphics during a SOURCE span, each with the word it lands on (anchor) and a written reason" },
    transitions: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["type"], properties: { mediaId: MEDIA_ID, atUs: { type: "integer", minimum: 0 }, ...PIN, type: v1.transitions.items.properties.type, durationUs: v1.transitions.items.properties.durationUs, reason: { type: "string", maxLength: 200 } } }, description: "A transition at the joint before segments[segment], or at the joint nearest SOURCE time atUs of mediaId" },
    sfx: { ...v1.sfx, items: pinned(v1.sfx.items) },
    music: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["mediaId", "editFromUs"], properties: {
      mediaId: MEDIA_ID, editFromUs: { type: "integer", minimum: 0, description: "EDIT time (after the segments are laid out) where it starts" }, editToUs: { type: "integer", minimum: 1, description: "EDIT time where it ends (default: the end of the edit or of the file)" },
      offsetUs: { type: "integer", minimum: 0, description: "Where in the music file it starts" }, volumeDb: { type: "number", minimum: -40, maximum: 6 }, fadeUs: { type: "integer", minimum: 0, maximum: 5_000_000 }, reason: { type: "string", maxLength: 200 },
    } }, description: "Music beds (later phases choose them)" },
    broll: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["mediaId", "fromUs", "toUs", "brollMediaId"], properties: {
      mediaId: MEDIA_ID, fromUs: { type: "integer", minimum: 0 }, toUs: { type: "integer", minimum: 1 }, ...PIN, brollMediaId: MEDIA_ID, brollFromUs: { type: "integer", minimum: 0, description: "Where in the b-roll file it starts" },
      mode: { enum: ["cover", "pip"] }, ...ANCHOR, reason: { type: "string", maxLength: 200 },
    } }, description: "B-roll over a SOURCE span of the speech (silent, on a track above the main track)" },
    retakes: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["takes", "kept"], properties: {
      line: { type: "string", maxLength: 300 }, kept: { type: "integer", minimum: 0 }, reason: { type: "string", maxLength: 200 },
      takes: { type: "array", minItems: 2, maxItems: 30, items: { type: "object", additionalProperties: false, required: ["mediaId", "fromUs", "toUs"], properties: { mediaId: MEDIA_ID, fromUs: { type: "integer", minimum: 0 }, toUs: { type: "integer", minimum: 1 }, text: { type: "string", maxLength: 300 }, complete: { type: "boolean" }, kind: { enum: ["full", "partial", "false-start"] } } } },
    } }, description: "Repeated attempts of the same line (for the cut sheet): the takes and the one kept" },
    stabilize: v1.stabilize, filter: v1.filter, audio: v1.audio, captions: v1.captions,
  },
};

/** Both versions (edit_plan_schema shows it); validation picks the version the plan names. */
export const EDIT_PLAN_SCHEMA = { $id: "montaj.editplan", description: "An edit plan: montaj.editplan/1 (cuts on the clips already on the main track) or montaj.editplan/2 (the main track as ordered segments of several files)", oneOf: [EDIT_PLAN_SCHEMA_V1, EDIT_PLAN_SCHEMA_V2] };
export const planSchemaOf = (plan) => (plan?.schema === "montaj.editplan/2" ? EDIT_PLAN_SCHEMA_V2 : EDIT_PLAN_SCHEMA_V1);

/**
 * The main track a v2 plan lays out, packed from 0: [{ id, seg (index), role, kind, mediaId, start, end, srcStart,
 * srcEnd, speed, jlUs }] — the same shape as mainPieces, so mapSpan / mapPoint work on it.
 */
export function layoutSegments(plan) {
  let t = 0;
  return (plan.segments || []).map((x, i) => {
    const p = { id: `seg${i}`, seg: i, role: x.role || "body", kind: "video", mediaId: x.mediaId, start: t, end: t + (x.toUs - x.fromUs), srcStart: x.fromUs, srcEnd: x.toUs, speed: 1, curve: false, jlUs: i ? (x.jl || 0) * 1000 : 0 };
    t = p.end;
    return p;
  });
}

/** The pieces an overlay item lands on: its pinned segment, else its natural place (not a hook copy), else any. */
export function occurrence(pieces, item) {
  if (Number.isInteger(item.segment)) return pieces.filter((p) => p.seg === item.segment);
  const natural = pieces.filter((p) => p.role !== "hook" && p.mediaId === item.mediaId);
  const any = pieces.filter((p) => p.mediaId === item.mediaId);
  const atNatural = natural.length && (item.fromUs === undefined ? natural.some((p) => item.atUs >= p.srcStart && item.atUs <= p.srcEnd) : mapSpan(natural, item.mediaId, item.fromUs, item.toUs).length);
  return atNatural ? natural : any;
}

/** Spans of the footage shown twice (two segments of one media overlap by > 0.1 s): [[i, j]]. */
export function repeatedSpans(segments) {
  const out = [];
  segments.forEach((a, i) => segments.forEach((b, j) => { if (j > i && a.mediaId === b.mediaId && Math.min(a.toUs, b.toUs) - Math.max(a.fromUs, b.fromUs) > 100_000) out.push([i, j]); }));
  return out;
}

/** One line of the cut sheet for a retake group: every take, the one kept and why. */
export function retakeLine(g, names = {}) {
  const k = Math.min(g.kept, g.takes.length - 1), kept = g.takes[k];
  const label = (t) => `${names[t.mediaId] ? `${names[t.mediaId]} ` : ""}${fmtTime(t.fromUs)}–${fmtTime(t.toUs)}`;
  const dropped = g.takes.map((t, i) => (i === k ? null : `take ${i + 1} ${label(t)}${t.kind === "false-start" ? " (false start)" : t.complete === false ? " (incomplete)" : ""}`)).filter(Boolean);
  return `retake ×${g.takes.length} «${String(g.line || kept.text || "").slice(0, 60)}» — kept take ${k + 1} (${label(kept)}${g.reason ? `, ${g.reason}` : ""}); dropped: ${dropped.join(", ")}`;
}

/**
 * Semantic checks of a v2 plan. opts.media: { [id]: { durationUs, type, name } } — the media of the timeline's
 * project (a segment may use any of them). Returns { errors, warnings, summary, cutSheet }.
 */
function checkPlanV2(plan, tl, { media = {}, mediaDurations = {} } = {}) {
  const errors = [], warnings = [];
  const info = (id) => media[id] || (mediaDurations[id] ? { durationUs: mediaDurations[id] } : null);
  const names = Object.fromEntries(Object.entries(media).map(([id, m]) => [id, m.name || ""]));
  const segs = plan.segments || [];
  segs.forEach((x, i) => {
    const m = info(x.mediaId);
    if (!m) { errors.push({ path: `segments/${i}/mediaId`, message: `media ${x.mediaId} is not in the project` }); return; }
    if (m.type === "audio") errors.push({ path: `segments/${i}`, message: "a sound file cannot be a main-track segment (use music)" });
    if (x.toUs <= x.fromUs) errors.push({ path: `segments/${i}`, message: "toUs must be after fromUs" });
    else if (x.toUs - x.fromUs < 100_000) warnings.push({ path: `segments/${i}`, message: "shorter than 0.1 s" });
    if (m.durationUs && m.type !== "image" && x.toUs > m.durationUs + 50_000) errors.push({ path: `segments/${i}`, message: `ends after the end of the media (${fmtTime(m.durationUs)})` });
    if (x.jl && i === 0) warnings.push({ path: "segments/0/jl", message: "the first segment has no joint before it — jl ignored" });
    else if (x.jl && Math.abs(x.jl) * 1000 > (x.toUs - x.fromUs) / 2) warnings.push({ path: `segments/${i}/jl`, message: "the J/L is longer than half the segment — shortened" });
  });
  for (const [i, j] of repeatedSpans(segs)) if (segs[i].role !== "hook" && segs[j].role !== "hook") warnings.push({ path: `segments/${j}`, message: `shows the same footage as segments/${i} (mark one role "hook" if it is meant)` });
  const pieces = layoutSegments(plan);
  const inPlan = new Set(segs.map((x) => x.mediaId));
  const lists = { zooms: plan.zooms, texts: plan.texts, graphics: plan.graphics, sfx: plan.sfx, broll: plan.broll, transitions: plan.transitions };
  for (const [name, list] of Object.entries(lists)) for (const [i, x] of (list || []).entries()) {
    if (Number.isInteger(x.segment) && x.segment >= segs.length) { errors.push({ path: `${name}/${i}/segment`, message: `there is no segments/${x.segment}` }); continue; }
    if (name === "transitions") {
      if (!Number.isInteger(x.segment) && (x.mediaId === undefined || x.atUs === undefined)) errors.push({ path: `${name}/${i}`, message: "a transition needs segment, or mediaId + atUs" });
      else if (x.segment === 0) errors.push({ path: `${name}/${i}/segment`, message: "there is no joint before the first segment" });
      continue;
    }
    if (!inPlan.has(x.mediaId)) { errors.push({ path: `${name}/${i}/mediaId`, message: `media ${x.mediaId} is in none of the segments` }); continue; }
    if (x.fromUs !== undefined && x.toUs <= x.fromUs) { errors.push({ path: `${name}/${i}`, message: "toUs must be after fromUs" }); continue; }
    const on = occurrence(pieces, x);
    if (x.fromUs !== undefined ? !mapSpan(on, x.mediaId, x.fromUs, x.toUs).length : !on.some((p) => x.atUs >= p.srcStart && x.atUs <= p.srcEnd)) warnings.push({ path: `${name}/${i}`, message: "it is in none of the segments — skipped" });
  }
  for (const [i, x] of (plan.texts || []).entries()) if (x.preset && !TEXT_PRESETS[x.preset]) errors.push({ path: `texts/${i}/preset`, message: `unknown text preset ${x.preset}` });
  for (const [i, x] of (plan.graphics || []).entries()) if (!x.reason && x.template !== "progress-bar") warnings.push({ path: `graphics/${i}`, message: "no written reason" });
  for (const [i, x] of (plan.broll || []).entries()) { const m = info(x.brollMediaId); if (!m) errors.push({ path: `broll/${i}/brollMediaId`, message: `media ${x.brollMediaId} is not in the project` }); else if (m.type === "audio") errors.push({ path: `broll/${i}`, message: "b-roll must be a video or a picture" }); }
  const afterUs = pieces.length ? pieces[pieces.length - 1].end : 0;
  for (const [i, x] of (plan.music || []).entries()) {
    const m = info(x.mediaId);
    if (!m) errors.push({ path: `music/${i}/mediaId`, message: `media ${x.mediaId} is not in the project` });
    else if (m.type === "image") errors.push({ path: `music/${i}`, message: "music must be a sound or a video file" });
    if (x.editFromUs >= afterUs) errors.push({ path: `music/${i}`, message: `starts after the end of the edit (${fmtTime(afterUs)})` });
    if (x.editToUs !== undefined && x.editToUs <= x.editFromUs) errors.push({ path: `music/${i}`, message: "editToUs must be after editFromUs" });
  }
  for (const [i, g] of (plan.retakes || []).entries()) if (g.kept >= g.takes.length) errors.push({ path: `retakes/${i}/kept`, message: "kept is not one of the takes" });
  const before = mainPieces(tl);
  const beforeUs = before.length ? before[before.length - 1].end : 0;
  // Reordered: a body segment starts in its file before an earlier body segment of the same file (hooks aside).
  const body = segs.filter((x) => x.role !== "hook");
  const reordered = body.some((x, k) => body.slice(0, k).some((y) => y.mediaId === x.mediaId && y.fromUs > x.fromUs));

  const sheet = [];
  const push = (at, text) => sheet.push({ at: at ?? 0, n: sheet.length, text });
  if (plan.canvas?.ratio) push(-2, `canvas ${plan.canvas.ratio}${plan.canvas.bgType ? ` (${plan.canvas.bgType})` : ""}`);
  if (reordered) push(-1, "story order: segments are not in the order they were filmed");
  pieces.forEach((p, i) => {
    const x = segs[i];
    push(p.start, `#${i + 1} ${fmtTime(p.start)}–${fmtTime(p.end)} ▸ ${names[p.mediaId] || p.mediaId} ${fmtTime(p.srcStart)}–${fmtTime(p.srcEnd)} (${((p.end - p.start) / US).toFixed(1)}s)${p.role !== "body" ? ` [${p.role}]` : ""}${x.reason ? ` — ${x.reason}` : ""}`);
    if (p.jlUs) push(p.start, `   ${p.jlUs < 0 ? `J-cut ${(-p.jlUs / US).toFixed(2)}s: its sound starts before its picture` : `L-cut ${(p.jlUs / US).toFixed(2)}s: the previous sound runs on under its picture`}`);
  });
  const at = (x) => { const s = mapSpan(occurrence(pieces, x), x.mediaId, x.fromUs ?? x.atUs, x.toUs ?? x.atUs + 1); return s.length ? s[0].t0 : null; };
  const when = (t) => (t === null ? "(skipped)" : `at ${fmtTime(t)}`);
  for (const z of plan.zooms || []) push(at(z), `zoom ×${z.scale} ${when(at(z))}${z.reason ? ` — ${z.reason}` : ""}`);
  for (const x of plan.texts || []) push(at(x), `text "${x.content}" ${when(at(x))}${x.reason ? ` — ${x.reason}` : ""}`);
  for (const x of plan.graphics || []) push(at(x), `graphic ${x.template} "${String(x.params?.text || x.params?.title || x.params?.emoji || "").slice(0, 40)}" ${when(at(x))}${x.anchor ? ` on «${x.anchor.word}»` : ""}${x.reason ? ` — ${x.reason}` : ""}`);
  for (const x of plan.broll || []) push(at(x), `b-roll ${names[x.brollMediaId] || x.brollMediaId} ${when(at(x))} (${((x.toUs - x.fromUs) / US).toFixed(1)}s, ${x.mode || "cover"})${x.anchor ? ` on «${x.anchor.word}»` : ""}${x.reason ? ` — ${x.reason}` : ""}`);
  for (const x of plan.transitions || []) { const t = Number.isInteger(x.segment) ? pieces[x.segment]?.start ?? null : at(x); push(t, `transition ${x.type} ${when(t)}${x.reason ? ` — ${x.reason}` : ""}`); }
  for (const x of plan.sfx || []) push(at(x), `sound ${x.sound} ${when(at(x))}`);
  for (const x of plan.music || []) push(x.editFromUs, `music ${names[x.mediaId] || x.mediaId} ${fmtTime(x.editFromUs)}–${fmtTime(x.editToUs ?? afterUs)}${x.volumeDb !== undefined ? ` ${x.volumeDb} dB` : ""}${x.reason ? ` — ${x.reason}` : ""}`);
  sheet.sort((a, b) => a.at - b.at || a.n - b.n);
  for (const g of plan.retakes || []) sheet.push({ text: retakeLine(g, names) });
  if (plan.filter) sheet.push({ text: `look ${plan.filter.preset} ${plan.filter.intensity ?? 80}%` });
  if (plan.audio) sheet.push({ text: `audio${plan.audio.denoise || plan.audio.enhanceVoice ? " clean-up" : ""}${plan.audio.normalizeLufs ? ` ${plan.audio.normalizeLufs} LUFS` : ""}` });
  if (plan.captions) sheet.push({ text: `captions ${plan.captions.template || ""}`.trim() });
  return {
    errors, warnings,
    summary: { beforeUs, afterUs, segments: segs.length, media: inPlan.size, reordered, hooks: segs.filter((x) => x.role === "hook").length, jl: pieces.filter((p) => p.jlUs).length, retakes: (plan.retakes || []).length, removedUs: Math.max(0, beforeUs - afterUs), zooms: (plan.zooms || []).length, texts: (plan.texts || []).length, graphics: (plan.graphics || []).length, transitions: (plan.transitions || []).length, music: (plan.music || []).length, broll: (plan.broll || []).length },
    cutSheet: sheet.map((x) => x.text),
  };
}

/** Semantic checks against the timeline (either version): { errors, warnings, summary, cutSheet }. */
export function checkPlan(plan, tl, opts = {}) {
  return plan?.schema === "montaj.editplan/2" ? checkPlanV2(plan, tl, opts) : checkPlanV1(plan, tl, opts);
}
