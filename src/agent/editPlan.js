// Applying an edit plan (montaj.editplan/1 or /2, see src/core/editPlan.js) through the Editing API as ONE transaction:
// the revision is checked first, every edit goes through the normal timeline commands inside one timeline batch (no
// copy/save/window update per edit — a long video's plan makes hundreds), the whole plan becomes a single undo step
// "plan:<title>", and any failure restores the timeline as it was. Every 20 edits it lets the app breathe, so the
// window never freezes. A v1 plan cuts the clips already on the main track; a v2 plan lays the main track out as its
// ordered segments (several files, any order, J/L joints), then both place the same zooms, texts, graphics, sounds…
// — a v2 overlay lands on its natural place (not a hook copy) unless it is pinned to a segment.
import { AppError } from "../core/validation.js";
import { US } from "../core/util.js";
import { DEFAULT_TEXT, newSegment } from "../core/model.js";
import { TEXT_PRESETS } from "../core/presets.js";
import { GRAPHIC_TEMPLATES } from "../core/graphics.js";
import * as ops from "../core/timelineOps.js";
import { addSfx } from "./sfx.js";
import { planSchemaOf, checkPlan, mainPieces, mapSpan, mapPoint, normalizeCuts, fmtTime, layoutSegments, occurrence } from "../core/editPlan.js";
import { OPERATION_INDEX } from "./operations.js";
import { ajv } from "./skills/registry.js";
import { applyCaptions, checkCaptions } from "./captions.js";

const validators = new Map(); // compiled lazily (module cycle: operations → editPlan → registry → operations)
const TEXT_Y = { top: -0.32, center: 0, bottom: 0.3 };
const LOOK = ["transform", "crop", "adjust", "videoFx", "audioFx", "volumeDb"]; // what a v2 segment takes from the clip it replaces
const isV2 = (plan) => plan?.schema === "montaj.editplan/2";

/** The media a plan may use: v1 — the main track's; v2 — every media of the timeline's project. { [id]: { durationUs, type, name } } */
function mediaInfo(ctx, tl, plan) {
  const S = ctx.services, out = {};
  const add = (m) => { out[m.id] = { durationUs: m.durationUs, type: m.type, name: m.name, hasAudio: m.hasAudio }; };
  if (isV2(plan) && tl.projectId) { try { for (const m of S.repos.media.listByProject(tl.projectId)) add(m); } catch { /* no project: main-track media only */ } }
  for (const p of mainPieces(tl)) if (p.mediaId && !out[p.mediaId]) { try { add(S.repos.media.get(p.mediaId)); } catch { /* missing media: reported by the export */ } }
  return out;
}

/** Schema + semantic checks. { valid, errors, warnings, summary, cutSheet } — never throws for plan problems. */
export async function inspectPlan(ctx, timelineId, plan) {
  const schema = planSchemaOf(plan);
  if (!validators.has(schema.$id)) validators.set(schema.$id, ajv.compile(schema));
  const validator = validators.get(schema.$id);
  if (!validator(plan)) return { valid: false, errors: (validator.errors || []).slice(0, 20).map((e) => ({ path: e.instancePath || "/", message: e.message })), warnings: [] };
  const tl = ctx.services.timelines.get(timelineId).timeline;
  const media = mediaInfo(ctx, tl, plan);
  const mediaDurations = Object.fromEntries(Object.entries(media).map(([id, m]) => [id, m.durationUs]));
  const r = checkPlan(plan, tl, { media, mediaDurations });
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
  const v2 = isV2(plan);
  // v2: every piece knows the segment it belongs to (zooms split them later), so overlays find their occurrence.
  const layout = v2 ? layoutSegments(plan) : null;
  const segOf = (t) => layout.find((p) => t >= p.start - 1 && t < p.end - 1) || layout[layout.length - 1];
  const pieces = () => {
    const ps = mainPieces(T.get(timelineId).timeline);
    return v2 ? ps.map((p) => { const L = segOf(p.start); return { ...p, seg: L.seg, role: L.role }; }) : ps;
  };
  const on = (x) => (v2 ? occurrence(pieces(), x) : pieces());
  let edits = 0;
  const breathe = async () => { if (++edits % 20 === 0) await new Promise((r) => setImmediate(r)); };
  const exec = async (cmd, args) => { await breathe(); return T.execAs(ctx.source, timelineId, cmd, args); };
  const commit = async (label, fn) => { await breathe(); return T.commit(timelineId, label, fn, { source: ctx.source }).result; };
  const op = async (name, args) => { await breathe(); return OPERATION_INDEX.get(name).run(ctx, { timelineId, ...args }); };
  const done = [], skipped = [];
  const step = (p, label) => job?.progress?.(p, label);
  try {
    return await T.batch(timelineId, `plan:${(plan.title || "edit").slice(0, 40)}`, async () => {
    if (plan.canvas) { step(0.05, "canvas"); await op("timeline_set_canvas", plan.canvas); done.push("canvas"); }

    if (v2) {
      // The main track as the plan's segments: each takes the look of a clip of its media already there.
      step(0.15, "segments");
      const tl = T.get(timelineId).timeline;
      const looks = new Map();
      for (const s of (tl.tracks.find((t) => t.isMain)?.segments || [])) if (s.mediaId && !looks.has(s.mediaId)) looks.set(s.mediaId, s);
      const items = plan.segments.map((x, i) => {
        const media = ctx.services.repos.media.get(x.mediaId), from = looks.get(x.mediaId);
        const attrs = from ? Object.fromEntries(LOOK.filter((k) => from[k] !== undefined).map((k) => [k, from[k]])) : {};
        return { media, fromUs: x.fromUs, toUs: media.type === "image" ? x.toUs : Math.min(x.toUs, media.durationUs || x.toUs), jlUs: i ? (x.jl || 0) * 1000 : 0, attrs };
      });
      await commit("layout", (t) => ops.layoutMain(t, items));
      const jl = T.get(timelineId).timeline.tracks.find((t) => t.isMain).segments.filter((s) => s.jlUs).length;
      done.push(`segments (${plan.segments.length}${check.summary.media > 1 ? ` from ${check.summary.media} files` : ""}${check.summary.reordered ? ", story order" : ""}${check.summary.hooks ? `, ${check.summary.hooks} hook` : ""})`);
      if (jl) done.push(`J/L cuts (${jl})`);
    } else {
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
    }

    // Zooms (cut-zoom / punch-in): split the main clip at the span edges and enlarge the piece in between.
    step(0.4, "zooms");
    const FRAME = Math.round(US / (start.timeline.fps || 30));
    const splitAt = async (t) => {
      const seg = pieces().find((p) => t > p.start + FRAME && t < p.end - FRAME);
      if (seg) await exec("split", { atUs: Math.round(t), ids: [seg.id] });
    };
    let zooms = 0;
    for (const [i, z] of (plan.zooms || []).entries()) {
      // A zoom is part of the picture: every occurrence of its span (a hook copy too) unless pinned.
      const spans = mapSpan(v2 && Number.isInteger(z.segment) ? on(z) : pieces(), z.mediaId, z.fromUs, z.toUs).filter((s) => s.t1 - s.t0 >= 150_000);
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
    const realCuts = (ps) => ps.slice(0, -1).map((p, k) => ({ p, next: ps[k + 1] })).filter(({ p, next }) => !(p.mediaId === next.mediaId && Math.abs(p.srcEnd - next.srcStart) < 2000));
    for (const [i, x] of (plan.transitions || []).entries()) {
      const ps = pieces();
      let best = null;
      if (v2 && Number.isInteger(x.segment)) {
        const t0 = layout[x.segment].start;
        best = realCuts(ps).map((c) => ({ ...c, d: Math.abs(c.p.end - t0) })).filter((c) => c.d <= FRAME).sort((a, b) => a.d - b.d)[0];
        if (!best) { skipped.push(`transitions/${i}: no cut before segment ${x.segment}`); continue; }
      } else {
        const t = mapPoint(on(x), x.mediaId, x.atUs);
        best = t === null ? null : realCuts(ps).map((c) => ({ ...c, d: Math.abs(c.p.end - t) })).sort((a, b) => a.d - b.d)[0];
        if (!best || best.d > 400_000) { skipped.push(`transitions/${i}: no cut near ${fmtTime(x.atUs)}`); continue; }
      }
      await exec("setTransition", { segId: best.p.id, type: x.type, durationUs: x.durationUs ?? 300_000 });
      transitions++;
    }
    if (transitions) done.push(`transitions (${transitions})`);

    // Stabilize before graphics: person-aware graphics read the head from the stabilized picture.
    if (plan.stabilize) {
      const ids = pieces().filter((p) => p.kind === "video").map((p) => p.id);
      if (ids.length) { await exec("updateSegments", { ids, patch: { videoFx: { stabilize: { enabled: true } } } }); done.push(`stabilized (${ids.length} clips)`); }
    }
    // On-screen text tied to source spans.
    step(0.7, "texts");
    let texts = 0;
    const behind = []; // texts / graphics drawn behind the person
    for (const [i, x] of (plan.texts || []).entries()) {
      const spans = mapSpan(on(x), x.mediaId, x.fromUs, x.toUs);
      if (!spans.length) { skipped.push(`texts/${i}: span cut out`); continue; }
      const t0 = spans[0].t0, t1 = spans[spans.length - 1].t1;
      const r = await exec("addSegment", { kind: "text", atUs: t0, durationUs: Math.max(300_000, t1 - t0), init: { name: x.content.slice(0, 40), text: { ...DEFAULT_TEXT, ...(TEXT_PRESETS[x.preset] || {}), content: x.content, ...(x.size ? { size: x.size } : {}) }, transform: { y: TEXT_Y[x.position || "center"] } } });
      if (x.behindPerson) behind.push(r.result);
      texts++;
    }
    if (texts) done.push(`texts (${texts})`);

    // Motion graphics tied to source spans (validated by the timeline_add_graphic operation).
    let graphics = 0;
    for (const [i, x] of (plan.graphics || []).entries()) {
      const spans = mapSpan(on(x), x.mediaId, x.fromUs, x.toUs);
      if (!spans.length) { skipped.push(`graphics/${i}: span cut out`); continue; }
      const t0 = spans[0].t0, t1 = spans[spans.length - 1].t1;
      const r = await op("timeline_add_graphic", { template: x.template, params: x.params || {}, atUs: t0, durationUs: Math.max(400_000, t1 - t0), behindPerson: false, sfx: !!x.sfx, inline: true });
      if (x.behindPerson ?? !!GRAPHIC_TEMPLATES[x.template]?.behind) behind.push(r.clipId);
      graphics++;
    }
    if (graphics) done.push(`graphics (${graphics})`);
    if (behind.length) { await exec("setBehindPerson", { ids: behind, value: true }); done.push(`behind the person (${behind.length})`); }

    // B-roll (v2): a silent clip on a track above the main track over the span of the speech it illustrates.
    let broll = 0;
    for (const [i, x] of (plan.broll || []).entries()) {
      const spans = mapSpan(on(x), x.mediaId, x.fromUs, x.toUs);
      if (!spans.length) { skipped.push(`broll/${i}: span cut out`); continue; }
      const t0 = spans[0].t0, t1 = spans[spans.length - 1].t1;
      const m = ctx.services.repos.media.get(x.brollMediaId);
      const kind = m.type === "image" ? "image" : "video";
      const dur = kind === "video" ? Math.min(t1 - t0, Math.max(100_000, (m.durationUs || Infinity) - (x.brollFromUs || 0))) : t1 - t0;
      await commit("broll", (t) => ops.addSegment(t, newSegment(kind, { mediaId: m.id, name: m.name, start: t0, duration: dur, sourceStart: kind === "video" ? x.brollFromUs || 0 : 0, sourceDuration: kind === "video" ? dur : 0, audioDetached: true,
        ...(x.mode === "pip" ? { transform: { scale: 0.42, x: 0.26, y: -0.27 } } : {}) })).id);
      broll++;
    }
    if (broll) done.push(`b-roll (${broll})`);

    // Sound effects on source moments (skipped when the moment was cut out).
    let sounds = 0;
    for (const [i, x] of (plan.sfx || []).entries()) {
      const t = mapPoint(on(x), x.mediaId, x.atUs);
      if (t === null || (v2 && !on(x).some((p) => x.atUs >= p.srcStart - 1 && x.atUs <= p.srcEnd + 1))) { skipped.push(`sfx/${i}: moment cut out`); continue; }
      await addSfx(ctx, timelineId, x.sound, t, { volumeDb: x.volumeDb });
      sounds++;
    }
    if (sounds) done.push(`sound effects (${sounds})`);

    // Music beds (v2), in EDIT time, on audio tracks.
    let music = 0;
    const endUs = () => { const ps = pieces(); return ps.length ? ps[ps.length - 1].end : 0; };
    for (const x of plan.music || []) {
      const m = ctx.services.repos.media.get(x.mediaId);
      const until = Math.min(x.editToUs ?? endUs(), x.editFromUs + Math.max(0, (m.durationUs || Infinity) - (x.offsetUs || 0)));
      if (until - x.editFromUs < 100_000) { skipped.push(`music: ${m.name} too short`); continue; }
      const fade = x.fadeUs ?? 0;
      await commit("music", (t) => ops.addSegment(t, newSegment("audio", { mediaId: m.id, name: m.name, start: x.editFromUs, duration: until - x.editFromUs, sourceStart: x.offsetUs || 0, sourceDuration: until - x.editFromUs, volumeDb: x.volumeDb ?? -18, fadeInUs: fade, fadeOutUs: fade })).id);
      music++;
    }
    if (music) done.push(`music (${music})`);

    step(0.8, "look & audio");
    if (plan.filter) { await op("timeline_add_layer", { kind: "filter", settings: { preset: plan.filter.preset, intensity: plan.filter.intensity ?? 80 } }); done.push(`look ${plan.filter.preset}`); }
    if (plan.audio?.denoise || plan.audio?.enhanceVoice) { await op("audio_enhance_voice", { denoise: !!plan.audio.denoise, enhanceVoice: !!plan.audio.enhanceVoice }); done.push("voice clean-up"); }
    if (plan.audio?.normalizeLufs) { await op("audio_normalize", { targetLufs: plan.audio.normalizeLufs }); done.push(`loudness ${plan.audio.normalizeLufs} LUFS`); }
    if (plan.captions) { step(0.85, "captions"); const c = await applyCaptions(ctx, timelineId, plan.captions); done.push(`captions (${c.pages} pages, ${c.words} words)`); }
    if (plan.retakes?.length) done.push(`retakes (${plan.retakes.length} lines, ${plan.retakes.reduce((n, g) => n + g.takes.length - 1, 0)} takes left out)`);

    const end = pieces();
    return { applied: done, skipped, warnings: check.warnings, cutSheet: check.cutSheet, before: { durationUs: check.summary.beforeUs }, after: { durationUs: end.length ? end[end.length - 1].end : 0 } };
    }, ctx.source).then((r) => { const now = T.get(timelineId); step(1, "done"); return { ...r, revision: now.revision, undoLabel: now.history.undoLabel }; });
  } catch (err) {
    err.details = { ...(err.details || {}), rolledBack: true }; // the batch put the timeline back
    throw err;
  }
}
