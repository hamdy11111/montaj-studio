// Runs the director (core/director.js) on a timeline: gathers what it needs — the words (local speech model), where
// the person is (person matte → track), the media facts — and returns the plan with the reasons for each decision,
// or applies it as one undo step (edit_plan_apply's code path).
import { AppError } from "../core/validation.js";
import { mainPieces } from "../core/editPlan.js";
import { directPlan } from "../core/director.js";
import { applyPlan } from "./editPlan.js";

/**
 * opts: { style, keywords, cta, captionTemplate, corrections, language, apply, expectedRevision }.
 * The timeline must hold one video on its main track, not yet cut (the director plans the whole edit).
 */
export async function autoEdit(ctx, timelineId, opts = {}, job = null) {
  const S = ctx.services;
  const tl = S.timelines.get(timelineId).timeline;
  const pieces = mainPieces(tl).filter((p) => p.mediaId);
  const media = [...new Set(pieces.map((p) => p.mediaId))];
  if (media.length !== 1 || pieces.length !== 1 || pieces[0].kind !== "video") throw new AppError("VALIDATION", "err.directorOneClip", { clips: pieces.length, media: media.length });
  const mediaId = media[0];
  const m = S.repos.media.get(mediaId);
  job?.progress?.(0.05, "words");
  const tr = await S.captions.transcribeWords({ mediaId, language: opts.language || "auto" });
  job?.progress?.(0.4, "person");
  let track = [];
  try { track = await S.mattes.track(mediaId); } catch (e) { if (e.messageKey !== "err.matteUnavailable") throw e; } // no person model: plan without it
  job?.progress?.(0.6, "plan");
  const { plan, notes } = directPlan({
    mediaId, words: tr.words, durationUs: m.durationUs, track, style: opts.style || "energetic", keywords: opts.keywords || [],
    cta: opts.cta || "", captionTemplate: opts.captionTemplate, corrections: opts.corrections || [], title: opts.title || "Auto edit",
  });
  if (!track.length) notes.push("the person model is not installed: no graphics behind the person (Settings › Providers)");
  if (!opts.apply) return { plan, notes };
  const r = await applyPlan(ctx, timelineId, plan, { expectedRevision: opts.expectedRevision, job: { progress: (p, label) => job?.progress?.(0.6 + p * 0.4, label) } });
  return { ...r, notes, plan };
}
