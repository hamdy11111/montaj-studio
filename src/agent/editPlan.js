// Applying an edit plan (montaj.editplan/1, see src/core/editPlan.js) through the Editing API as ONE transaction:
// the revision is checked first, every edit goes through the normal timeline commands, the whole plan becomes a
// single undo step "plan:<title>", and any failure restores the timeline as it was.
import { AppError } from "../core/validation.js";
import { deepClone, US } from "../core/util.js";
import { DEFAULT_TEXT } from "../core/model.js";
import { TEXT_PRESETS } from "../core/presets.js";
import { EDIT_PLAN_SCHEMA, checkPlan, mainPieces, mapSpan, mapPoint, normalizeCuts, fmtTime } from "../core/editPlan.js";
import { OPERATION_INDEX } from "./operations.js";
import { ajv } from "./skills/registry.js";
import { applyCaptions, checkCaptions } from "./captions.js";

let validator = null; // compiled lazily (module cycle: operations → editPlan → registry → operations)
const TEXT_Y = { top: -0.32, center: 0, bottom: 0.3 };

/** Schema + semantic checks. { valid, errors, warnings, summary, cutSheet } — never throws for plan problems. */
export async function inspectPlan(ctx, timelineId, plan) {
  validator ||= ajv.compile(EDIT_PLAN_SCHEMA);
  if (!validator(plan)) return { valid: false, errors: (validator.errors || []).slice(0, 20).map((e) => ({ path: e.instancePath || "/", message: e.message })), warnings: [] };
  const tl = ctx.services.timelines.get(timelineId).timeline;
  const mediaDurations = {};
  for (const p of mainPieces(tl)) if (p.mediaId) { try { mediaDurations[p.mediaId] = ctx.services.repos.media.get(p.mediaId).durationUs; } catch { /* missing media: reported by the export */ } }
  const r = checkPlan(plan, tl, { mediaDurations });
  if (plan.captions) r.errors.push(...(await checkCaptions(ctx, plan.captions)));
  return { valid: r.errors.length === 0, ...r };
}

export async function applyPlan(ctx, timelineId, plan, { expectedRevision, job } = {}) {
  const check = await inspectPlan(ctx, timelineId, plan);
  if (!check.valid) throw new AppError("VALIDATION", "err.planInvalid", { errors: check.errors });
  if (plan.captions && !ctx.guard.hasScope("media")) throw new AppError("FORBIDDEN", "err.scopeMissing", { scope: "media", op: "edit_plan_apply (captions)" });
  const T = ctx.services.timelines;
  T.checkRevision(timelineId, expectedRevision);
  const start = T.get(timelineId);
  const depth = start.history.depth, snapshot = deepClone(start.timeline);
  const pieces = () => mainPieces(T.get(timelineId).timeline);
  const exec = (cmd, args) => T.execAs(ctx.source, timelineId, cmd, args);
  const op = (name, args) => OPERATION_INDEX.get(name).run(ctx, { timelineId, ...args });
  const done = [], skipped = [];
  const step = (p, label) => job?.progress?.(p, label);
  try {
    if (plan.canvas) { step(0.05, "canvas"); await op("timeline_set_canvas", plan.canvas); done.push("canvas"); }

    // Cuts: per original main-track clip of each media, every cut that overlaps its source span.
    step(0.15, "cuts");
    let removedUs = 0;
    for (const [mediaId, list] of normalizeCuts(plan.cuts)) {
      for (const id of pieces().filter((p) => p.mediaId === mediaId).map((p) => p.id)) {
        const p = pieces().find((x) => x.id === id);
        if (!p) continue;
        const ranges = list.filter((c) => c.toUs > p.srcStart && c.fromUs < p.srcEnd).map((c) => [Math.max(c.fromUs, p.srcStart), Math.min(c.toUs, p.srcEnd)]);
        if (ranges.length) removedUs += (await exec("removeRanges", { segId: id, ranges })).result || 0;
      }
    }
    if (plan.cuts?.length) done.push(`cuts (${(removedUs / US).toFixed(1)}s removed)`);

    // Zooms (cut-zoom / punch-in): split the main clip at the span edges and enlarge the piece in between.
    step(0.4, "zooms");
    const FRAME = Math.round(US / (start.timeline.fps || 30));
    const splitAt = async (t) => {
      const seg = pieces().find((p) => t > p.start + FRAME && t < p.end - FRAME);
      if (seg) await exec("split", { atUs: Math.round(t), ids: [seg.id] });
    };
    let zooms = 0;
    for (const [i, z] of (plan.zooms || []).entries()) {
      const spans = mapSpan(pieces(), z.mediaId, z.fromUs, z.toUs).filter((s) => s.t1 - s.t0 >= 150_000);
      if (!spans.length) { skipped.push(`zooms/${i}: span cut out`); continue; }
      for (const sp of spans) {
        await splitAt(sp.t0); await splitAt(sp.t1);
        const mid = pieces().find((p) => Math.abs(p.start - sp.t0) <= FRAME && p.mediaId === z.mediaId);
        if (!mid) { skipped.push(`zooms/${i}: no clip at ${fmtTime(sp.t0)}`); continue; }
        const cur = T.get(timelineId).timeline.tracks.flatMap((t) => t.segments).find((s) => s.id === mid.id);
        const base = cur.transform?.scale || 1;
        await exec("updateSegment", { segId: mid.id, patch: { transform: { scale: Math.round(base * z.scale * 1000) / 1000, ...(z.x !== undefined ? { x: z.x } : {}), ...(z.y !== undefined ? { y: z.y } : {}) } } });
        zooms++;
      }
    }
    if (zooms) done.push(`zooms (${zooms})`);

    // Transitions at real cuts (not at the continuous splits made for zooms).
    step(0.6, "transitions");
    let transitions = 0;
    for (const [i, x] of (plan.transitions || []).entries()) {
      const ps = pieces();
      const t = mapPoint(ps, x.mediaId, x.atUs);
      const cuts = ps.slice(0, -1).map((p, k) => ({ p, next: ps[k + 1] })).filter(({ p, next }) => !(p.mediaId === next.mediaId && Math.abs(p.srcEnd - next.srcStart) < 2000));
      const best = cuts.map((c) => ({ ...c, d: Math.abs(c.p.end - t) })).sort((a, b) => a.d - b.d)[0];
      if (t === null || !best || best.d > 400_000) { skipped.push(`transitions/${i}: no cut near ${fmtTime(x.atUs)}`); continue; }
      await exec("setTransition", { segId: best.p.id, type: x.type, durationUs: x.durationUs ?? 300_000 });
      transitions++;
    }
    if (transitions) done.push(`transitions (${transitions})`);

    // On-screen text tied to source spans.
    step(0.7, "texts");
    let texts = 0;
    for (const [i, x] of (plan.texts || []).entries()) {
      const spans = mapSpan(pieces(), x.mediaId, x.fromUs, x.toUs);
      if (!spans.length) { skipped.push(`texts/${i}: span cut out`); continue; }
      const t0 = spans[0].t0, t1 = spans[spans.length - 1].t1;
      await exec("addSegment", { kind: "text", atUs: t0, durationUs: Math.max(300_000, t1 - t0), init: { name: x.content.slice(0, 40), text: { ...DEFAULT_TEXT, ...(TEXT_PRESETS[x.preset] || {}), content: x.content, ...(x.size ? { size: x.size } : {}) }, transform: { y: TEXT_Y[x.position || "center"] } } });
      texts++;
    }
    if (texts) done.push(`texts (${texts})`);

    step(0.8, "look & audio");
    if (plan.filter) { await op("timeline_add_layer", { kind: "filter", settings: { preset: plan.filter.preset, intensity: plan.filter.intensity ?? 80 } }); done.push(`look ${plan.filter.preset}`); }
    if (plan.audio?.denoise || plan.audio?.enhanceVoice) { await op("audio_enhance_voice", { denoise: !!plan.audio.denoise, enhanceVoice: !!plan.audio.enhanceVoice }); done.push("voice clean-up"); }
    if (plan.audio?.normalizeLufs) { await op("audio_normalize", { targetLufs: plan.audio.normalizeLufs }); done.push(`loudness ${plan.audio.normalizeLufs} LUFS`); }
    if (plan.captions) { step(0.85, "captions"); const c = await applyCaptions(ctx, timelineId, plan.captions); done.push(`captions (${c.pages} pages, ${c.words} words)`); }

    T.squash(timelineId, depth, `plan:${(plan.title || "edit").slice(0, 40)}`);
    const now = T.get(timelineId);
    const end = pieces();
    step(1, "done");
    return { applied: done, skipped, warnings: check.warnings, before: { durationUs: check.summary.beforeUs }, after: { durationUs: end.length ? end[end.length - 1].end : 0 }, revision: now.revision, undoLabel: now.history.undoLabel };
  } catch (err) {
    T.restore(timelineId, snapshot, depth, ctx.source);
    err.details = { ...(err.details || {}), rolledBack: true };
    throw err;
  }
}
