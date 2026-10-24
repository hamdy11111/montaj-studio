// Edit plans (montaj.editplan/1): a whole edit described as data in SOURCE time — the times an agent reads in a
// transcript — and compiled onto the main track. Pure helpers: the plan schema, mapping source time to timeline
// time through the main-track clips, predicting the result of cuts, and the readable cut sheet shown for approval.
// Applying a plan (with undo/rollback) lives in src/agent/editPlan.js.
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

export const EDIT_PLAN_SCHEMA = {
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
    sfx: { type: "array", maxItems: 300, items: { type: "object", additionalProperties: false, required: ["mediaId", "atUs", "sound"], properties: { mediaId: { type: "string", pattern: "^[A-Za-z0-9-]+$" }, atUs: { type: "integer", minimum: 0 }, sound: { enum: Object.keys(SFX) }, volumeDb: { type: "number", minimum: -40, maximum: 6 } } }, description: "Sound effects whose accent lands on a SOURCE moment (see sfx_list)" },
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

/** Semantic checks against the timeline: { errors, warnings, summary, cutSheet }. */
export function checkPlan(plan, tl, { mediaDurations = {} } = {}) {
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
