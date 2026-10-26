// Runs the director (core/director.js) on a timeline: gathers what it needs — the words (local speech model), the
// stabilized picture, where the person is in it (person matte → track), the media facts — and returns the plan with the
// reasons for each decision, or applies it as one undo step (edit_plan_apply's code path). The stages are weighted
// by their expected time (estimateWork), so the progress it reports moves steadily and a remaining time can be shown.
// Several clips on the main track are planned together, in their timeline order: each clip's words and person track
// are laid on one virtual time axis (the clips one after another) and the v2 plan maps everything back to each file.
import { AppError } from "../core/validation.js";
import { mainPieces } from "../core/editPlan.js";
import { directPlan, estimateWork } from "../core/director.js";
import { US } from "../core/util.js";
import { applyPlan } from "./editPlan.js";

/** The main-track clips the director works on, laid on the virtual axis, or an error. */
function theClips(S, timelineId) {
  const tl = S.timelines.get(timelineId).timeline;
  const pieces = mainPieces(tl);
  // The plan rebuilds the whole main track: every clip must be a video or a picture at a constant speed.
  if (!pieces.length || pieces.some((p) => !p.mediaId || !["video", "image"].includes(p.kind) || p.curve) || !pieces.some((p) => p.kind === "video"))
    throw new AppError("VALIDATION", "err.directorClips", { clips: pieces.length });
  let v = 0;
  const clips = pieces.map((p) => {
    const m = S.repos.media.get(p.mediaId);
    const c = { mediaId: p.mediaId, kind: p.kind, srcStart: p.srcStart, srcEnd: p.srcEnd, speed: p.speed, vStart: v, m };
    v += p.end - p.start;
    return c;
  });
  const media = [...new Map(clips.map((c) => [c.mediaId, c.m])).values()];
  return { tl, clips, media, durationUs: v };
}

/** What a run would cost: { durationS, stages, totalSec, cached } (the dialog shows it before starting). */
export function directorEstimate(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { tl, media, durationUs } = theClips(S, timelineId);
  const videos = media.filter((m) => m.type === "video");
  const stabilize = opts.stabilize !== false && !!S.stabilizer, person = opts.person !== false;
  const cached = {
    words: media.every((m) => !m.hasAudio || !!S.captions.cachedWords?.(m.id)),
    stabilize: stabilize && videos.every((m) => S.stabilizer.ready(m.id, tl.fps || 30)),
    person: person && videos.every((m) => S.mattes.ready(m.id, stabilize ? "stab" : "")),
  };
  // The work is per file (each is read whole once); its size: the largest of them.
  const big = videos.reduce((a, m) => ((m.width || 0) * (m.height || 0) > (a.width || 0) * (a.height || 0) ? m : a), videos[0] || {});
  const fileS = videos.reduce((n, m) => n + (m.durationUs || 0) / US, 0);
  return { durationS: durationUs / US, cached, ...estimateWork({ durationS: Math.max(durationUs / US, fileS), width: big.width, height: big.height, cached, stabilize, person }) };
}

/**
 * opts: { style, keywords, cta, captionTemplate, corrections, language, apply, expectedRevision, targetSec (a reel of
 * that length), stabilize (default true), person (default true: graphics placed by the person), retakes (default true) }.
 * The main track holds the clips to edit — one or several videos (and pictures), cut or not; the plan replaces it.
 */
export async function autoEdit(ctx, timelineId, opts = {}, job = null) {
  const S = ctx.services;
  const { tl, clips, media, durationUs } = theClips(S, timelineId);
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
  // Per file, each stage once (a file used by two clips is read once), the progress shared by the files.
  const perFile = async (key, list, fn) => {
    const report = stage(key), out = new Map();
    for (const [k, m] of list.entries()) out.set(m.id, await fn(m, (x) => report((k + Math.max(0, Math.min(1, x || 0))) / list.length)));
    return out;
  };
  const videos = media.filter((m) => m.type === "video");
  const words = await perFile("words", media.filter((m) => m.hasAudio), (m, p) => S.captions.transcribeWords({ mediaId: m.id, language: opts.language || "auto", onProgress: p }).then((r) => r.words));
  // Stabilized first, then the person is found once — in the stabilized picture the edit will show.
  const sources = stabilize ? await perFile("stabilize", videos, (m, p) => S.stabilizer.ensure(m.id, { fps: tl.fps || 30, onProgress: p })) : new Map();
  let tracks = new Map(), noPersonModel = false;
  if (person) {
    tracks = await perFile("person", videos, async (m, p) => {
      if (noPersonModel) return [];
      const source = sources.get(m.id);
      try { return await S.mattes.track(m.id, { ...(source ? { variant: "stab", source } : {}), onProgress: (x) => p(x * 0.9) }); }
      catch (e) { if (e.messageKey !== "err.matteUnavailable") throw e; noPersonModel = true; return []; } // no person model: plan without it
    });
  }
  stage("plan");
  // The clips on one virtual axis: their words, their person track, and the clips without speech (never cut).
  const vWords = [], vTrack = [], protect = [];
  for (const c of clips) {
    const len = (c.srcEnd - c.srcStart) / c.speed, toV = (s) => Math.round(c.vStart + (s - c.srcStart) / c.speed);
    const mine = (words.get(c.mediaId) || []).filter((w) => { const mid = (w.startUs + w.endUs) / 2; return mid >= c.srcStart && mid < c.srcEnd; });
    for (const w of mine) vWords.push({ ...w, startUs: Math.max(c.vStart, toV(w.startUs)), endUs: Math.min(c.vStart + len, toV(w.endUs)) });
    for (const f of tracks.get(c.mediaId) || []) if (f[0] >= c.srcStart && f[0] < c.srcEnd) vTrack.push([toV(f[0]), ...f.slice(1)]);
    if (!mine.length) protect.push([c.vStart, c.vStart + len]);
  }
  vWords.sort((a, b) => a.startUs - b.startUs);
  const first = clips.find((c) => c.kind === "video").m;
  const { plan, notes, qa, decisions } = directPlan({
    mediaId: clips[0].mediaId, ...(clips.length > 1 || clips[0].srcStart > 0 || clips[0].speed !== 1 ? { clips: clips.map(({ m, ...c }) => c), protect } : {}),
    words: vWords, durationUs, track: vTrack, style: opts.style || "energetic", keywords: opts.keywords || [],
    media: { width: first.width, height: first.height }, canvas: { width: tl.canvas?.width, height: tl.canvas?.height },
    cta: opts.cta || "", captionTemplate: opts.captionTemplate, corrections: opts.corrections || [], title: opts.title || "Auto edit",
    targetUs: opts.targetSec ? Math.round(opts.targetSec * US) : null, stabilize, retakes: opts.retakes !== false,
  });
  if (person && !vTrack.length) { notes.push("the person model is not installed: no graphics behind the person (Settings › Providers)"); decisions.unshift({ k: "noPersonModel" }); }
  if (!person) { notes.push("person tracking was turned off: no graphics placed by the person"); decisions.unshift({ k: "personOff" }); }
  if (!opts.apply) return { plan, notes, qa, decisions, estimate: est };
  const apply = stage("apply");
  const r = await applyPlan(ctx, timelineId, plan, { expectedRevision: opts.expectedRevision, job: { progress: (p, label) => apply(p, label) } });
  return { ...r, notes, plan, qa, decisions, estimate: est };
}
