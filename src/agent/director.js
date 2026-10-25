// Runs the director (core/director.js) on a timeline: gathers what it needs — the words (local speech model), the
// stabilized picture, where the person is in it (person matte → track), the media facts — and returns the plan with the
// reasons for each decision, or applies it as one undo step (edit_plan_apply's code path). The stages are weighted
// by their expected time (estimateWork), so the progress it reports moves steadily and a remaining time can be shown.
import { AppError } from "../core/validation.js";
import { mainPieces } from "../core/editPlan.js";
import { directPlan, estimateWork } from "../core/director.js";
import { US } from "../core/util.js";
import { applyPlan } from "./editPlan.js";

/** The one uncut video the director works on, or an error. */
function theClip(S, timelineId) {
  const tl = S.timelines.get(timelineId).timeline;
  const pieces = mainPieces(tl).filter((p) => p.mediaId);
  const media = [...new Set(pieces.map((p) => p.mediaId))];
  if (media.length !== 1 || pieces.length !== 1 || pieces[0].kind !== "video") throw new AppError("VALIDATION", "err.directorOneClip", { clips: pieces.length, media: media.length });
  return { tl, mediaId: media[0], m: S.repos.media.get(media[0]) };
}

/** What a run would cost: { durationS, stages, totalSec, cached } (the dialog shows it before starting). */
export function directorEstimate(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { tl, mediaId, m } = theClip(S, timelineId);
  const stabilize = opts.stabilize !== false && !!S.stabilizer, person = opts.person !== false;
  const cached = {
    words: !!S.captions.cachedWords?.(mediaId),
    stabilize: stabilize && S.stabilizer.ready(mediaId, tl.fps || 30),
    person: person && S.mattes.ready(mediaId, stabilize ? "stab" : ""),
  };
  return { durationS: m.durationUs / US, cached, ...estimateWork({ durationS: m.durationUs / US, width: m.width, height: m.height, cached, stabilize, person }) };
}

/**
 * opts: { style, keywords, cta, captionTemplate, corrections, language, apply, expectedRevision, targetSec (a reel of
 * that length), stabilize (default true), person (default true: graphics placed by the person) }.
 * The timeline must hold one video on its main track, not yet cut (the director plans the whole edit).
 */
export async function autoEdit(ctx, timelineId, opts = {}, job = null) {
  const S = ctx.services;
  const { tl, mediaId, m } = theClip(S, timelineId);
  const est = directorEstimate(ctx, timelineId, opts);
  const stabilize = est.stages.some((x) => x.key === "stabilize"), person = est.stages.some((x) => x.key === "person");
  let done = 0, sent = { p: -1, label: "", at: 0 };
  // At most ~5 messages a second (a stage's own progress can come per frame).
  const send = (p, label) => {
    const now = Date.now();
    if (label === sent.label && p - sent.p < 0.002 && now - sent.at < 200) return;
    sent = { p, label, at: now };
    job?.progress?.(p, label);
  };
  const stage = (key) => {
    const w = est.stages.find((x) => x.key === key)?.sec || 0, base = done;
    done += w;
    const report = (p, label = key) => send(Math.min(0.995, (base + w * Math.max(0, Math.min(1, p || 0))) / est.totalSec), label);
    report(0);
    return report;
  };
  const tr = await S.captions.transcribeWords({ mediaId, language: opts.language || "auto", onProgress: stage("words") });
  // Stabilized first, then the person is found once — in the stabilized picture the edit will show.
  let source = null;
  if (stabilize) source = await S.stabilizer.ensure(mediaId, { fps: tl.fps || 30, onProgress: stage("stabilize") });
  let track = [];
  if (person) {
    const p = stage("person");
    try { track = await S.mattes.track(mediaId, { ...(source ? { variant: "stab", source } : {}), onProgress: (x) => p(x * 0.9) }); }
    catch (e) { if (e.messageKey !== "err.matteUnavailable") throw e; } // no person model: plan without it
  }
  stage("plan");
  const { plan, notes, qa, decisions } = directPlan({
    mediaId, words: tr.words, durationUs: m.durationUs, track, style: opts.style || "energetic", keywords: opts.keywords || [],
    media: { width: m.width, height: m.height }, canvas: { width: tl.canvas?.width, height: tl.canvas?.height },
    cta: opts.cta || "", captionTemplate: opts.captionTemplate, corrections: opts.corrections || [], title: opts.title || "Auto edit",
    targetUs: opts.targetSec ? Math.round(opts.targetSec * US) : null, stabilize,
  });
  if (person && !track.length) { notes.push("the person model is not installed: no graphics behind the person (Settings › Providers)"); decisions.unshift({ k: "noPersonModel" }); }
  if (!person) { notes.push("person tracking was turned off: no graphics placed by the person"); decisions.unshift({ k: "personOff" }); }
  if (!opts.apply) return { plan, notes, qa, decisions, estimate: est };
  const apply = stage("apply");
  const r = await applyPlan(ctx, timelineId, plan, { expectedRevision: opts.expectedRevision, job: { progress: (p, label) => apply(p, label) } });
  return { ...r, notes, plan, qa, decisions, estimate: est };
}
