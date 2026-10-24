// Word-timed captions from the local transcript: the words spoken on the main track (after any cuts, mapped to
// timeline time), grouped into pages by the chosen template, added as caption text clips in ONE undo step.
// Used by the agent operations, edit plans and the editor's Captions panel (through the user context).
import { AppError } from "../core/validation.js";
import { deepClone } from "../core/util.js";
import { DEFAULT_TEXT } from "../core/model.js";
import { mainPieces } from "../core/editPlan.js";
import { CAPTION_TEMPLATES, paginate, emphasisFor, captionPosY, captionQc, isArabicText } from "../core/captionTemplates.js";

export async function checkCaptions(ctx, opts = {}) {
  const errors = [];
  if (opts.template && !CAPTION_TEMPLATES[opts.template]) errors.push({ path: "captions/template", message: `unknown template ${opts.template} (see captions_templates)` });
  if (!(await ctx.services.captions.status()).words) errors.push({ path: "captions", message: "no local speech model is configured (Settings › Providers)" });
  return errors;
}

/** Spoken words on the main track in timeline time: [{ t, s, e }] (µs). */
export async function timelineWords(ctx, timelineId, { language = "auto" } = {}) {
  const tl = ctx.services.timelines.get(timelineId).timeline;
  const pieces = mainPieces(tl).filter((p) => p.mediaId && (p.kind === "video" || p.kind === "audio"));
  const transcripts = new Map();
  for (const id of new Set(pieces.map((p) => p.mediaId))) {
    const m = ctx.services.repos.media.get(id);
    if (m.hasAudio) transcripts.set(id, await ctx.services.captions.transcribeWords({ mediaId: id, language }));
  }
  const out = [];
  for (const p of pieces) {
    const tr = transcripts.get(p.mediaId);
    if (!tr) continue;
    for (const w of tr.words) {
      const mid = (w.startUs + w.endUs) / 2;
      if (mid < p.srcStart || mid > p.srcEnd) continue; // the word was cut out
      const s = Math.max(p.start, Math.round(p.start + (w.startUs - p.srcStart) / p.speed));
      const e = Math.min(p.end, Math.round(p.start + (w.endUs - p.srcStart) / p.speed));
      if (e > s) out.push({ t: w.text, s, e });
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Replace (or add) word-timed captions. Returns { pages, words, template, qc }. Caller handles the transaction. */
export async function applyCaptions(ctx, timelineId, opts = {}) {
  const template = opts.template || "karaoke-yellow";
  const errors = await checkCaptions(ctx, { ...opts, template });
  if (errors.length) throw new AppError(errors.some((e) => e.path === "captions") ? "PROVIDER" : "VALIDATION", errors.some((e) => e.path === "captions") ? "err.whisperNotConfigured" : "err.planInvalid", { errors });
  const T = ctx.services.timelines;
  const exec = (cmd, args) => T.execAs(ctx.source, timelineId, cmd, args);
  const words = await timelineWords(ctx, timelineId, { language: opts.language || "auto" });
  if (!words.length) throw new AppError("VALIDATION", "err.noSpeech");
  const tl = T.get(timelineId).timeline;
  if (opts.replace !== false) {
    const old = tl.tracks.flatMap((t) => t.segments).filter((s) => s.kind === "text" && s.text?.isCaption).map((s) => s.id);
    if (old.length) await exec("delete", { ids: old });
  }
  const breaksUs = mainPieces(tl).slice(1).map((p) => p.start); // clip boundaries on the main track
  const pages = paginate(words, template, { breaksUs });
  const y = opts.positionY ?? captionPosY(template, tl.canvas);
  let trackId = null;
  for (const pg of pages) {
    const content = pg.words.map((w) => w.t).join(" ");
    const r = await exec("addSegment", {
      kind: "text", atUs: pg.startUs, durationUs: pg.endUs - pg.startUs, trackId,
      init: {
        name: content.slice(0, 40),
        text: { ...DEFAULT_TEXT, content, isCaption: true, direction: isArabicText(content) ? "rtl" : "auto",
          caption: { template, words: pg.words.map((w) => ({ t: w.t, s: w.s - pg.startUs, e: w.e - pg.startUs })), emphasis: emphasisFor(pg.words, opts.keywords || [], { auto: opts.autoEmphasis !== false }), overrides: opts.overrides || {}, reveal: !!opts.reveal } },
        transform: { y },
      },
    });
    if (!trackId) trackId = T.get(timelineId).timeline.tracks.find((t) => t.segments.some((s) => s.id === r.result))?.id || null;
  }
  return { template, pages: pages.length, words: words.length, qc: captionQc(pages) };
}

/** Run `fn` as one undo step with rollback on failure. */
export async function transact(ctx, timelineId, label, expectedRevision, fn) {
  const T = ctx.services.timelines;
  T.checkRevision(timelineId, expectedRevision);
  const start = T.get(timelineId);
  const depth = start.history.depth, snapshot = deepClone(start.timeline);
  try {
    const result = await fn();
    T.squash(timelineId, depth, label);
    const now = T.get(timelineId);
    return { ...result, revision: now.revision, undoLabel: now.history.undoLabel };
  } catch (err) {
    T.restore(timelineId, snapshot, depth, ctx.source);
    err.details = { ...(err.details || {}), rolledBack: true };
    throw err;
  }
}

/** Change the template / colours of every caption page of a timeline (one undo step). */
export async function restyleCaptions(ctx, timelineId, { template, overrides, positionY, reveal } = {}) {
  if (template && !CAPTION_TEMPLATES[template]) throw new AppError("VALIDATION", "err.enum", { field: "template", allowed: Object.keys(CAPTION_TEMPLATES) });
  const T = ctx.services.timelines;
  const tl = T.get(timelineId).timeline;
  const segs = tl.tracks.flatMap((t) => t.segments).filter((s) => s.kind === "text" && s.text?.caption);
  if (!segs.length) throw new AppError("VALIDATION", "err.noCaptions");
  const items = segs.map((s) => ({ segId: s.id, patch: { text: { caption: { ...s.text.caption, ...(template ? { template } : {}), ...(overrides ? { overrides: { ...(s.text.caption.overrides || {}), ...overrides } } : {}), ...(reveal !== undefined ? { reveal: !!reveal } : {}) } }, ...(positionY !== undefined || template ? { transform: { y: positionY ?? captionPosY(template, tl.canvas) } } : {}) } }));
  const r = await T.execAs(ctx.source, timelineId, "patchMany", { label: "captions style", items });
  return { changed: r.result, revision: r.revision };
}
