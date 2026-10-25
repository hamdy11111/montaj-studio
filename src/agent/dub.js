// Dubbing a timeline's video (services/dubService.js does the speech work): the new voice and the kept background
// become media of the project and two audio tracks that follow the video's clips (applyDub), with the video's own
// sound turned off — one undo step; removing the dub turns it back on.
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../core/validation.js";
import { mainPieces } from "../core/editPlan.js";
import { US } from "../core/util.js";

/** The video the dub is for: the given media, or the one video (with sound) on the main track. */
function theMedia(S, timelineId, mediaId) {
  const tl = S.timelines.get(timelineId).timeline;
  const ids = [...new Set(mainPieces(tl).filter((p) => p.mediaId && p.kind === "video").map((p) => p.mediaId))];
  const pick = mediaId ? ids.find((x) => x === mediaId) : ids.length === 1 ? ids[0] : null;
  if (!pick) throw new AppError("VALIDATION", "err.dubOneVideo", { videos: ids.length });
  const m = S.repos.media.get(pick);
  if (!m.hasAudio) throw new AppError("VALIDATION", "err.noAudio");
  return { tl, m };
}

/** What a run costs: { mediaId, durationS, totalSec, stages, ready, missing, languages, last }. */
export function dubEstimate(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  const st = S.dubber.status();
  const est = S.dubber.estimate(m.durationUs / US, S.dubber.cachedFor(m));
  const last = st.ready ? S.dubber.last(m.id, opts.lang || "en") : null;
  return { mediaId: m.id, durationS: m.durationUs / US, ...est, ready: st.ready, missing: st.missing, languages: st.languages, spoken: S.dubber.knownLanguage(m), last: last && brief(last) };
}

/** What the dialog shows of a dub. */
function brief(r) {
  return {
    lang: r.lang, summary: r.summary,
    speakers: r.speakers.map((s) => ({ id: s.id, kind: s.kind, gender: s.gender, child: !!s.child, speech: s.speech })),
    lines: r.lines.map((l, n) => ({ n, spk: l.spk, start: l.start, end: l.end, ar: l.ar, text: l.spoken || l.text, emotion: l.emotion, intensity: l.intensity, speed: l.speed, edited: !!l.edited, check: l.check ?? null })),
  };
}

/** The voice and background files as project media (a fresh copy per run, so caches never mix two dubs). */
async function placeDub(ctx, timelineId, m, r) {
  const S = ctx.services;
  const tl = S.timelines.get(timelineId).timeline;
  const stamp = Date.now().toString(36);
  const files = ["voice", "background"].map((k) => {
    const to = path.join(S.paths.media, `Dub ${r.lang.toUpperCase()} ${k} ${stamp}-${String(m.id).slice(0, 6)}.wav`);
    fs.copyFileSync(r.files[k], to);
    return to;
  });
  const { imported, errors } = await S.media.importFiles(tl.projectId, files, { origin: "dub", derivedFromId: m.id });
  if (imported.length !== 2) throw new AppError("IO", "err.dubFailed", { message: errors?.[0]?.message || "import" });
  const [voice, background] = imported;
  const name = (k) => `${k === "voice" ? "Dub" : "Background"} (${r.lang.toUpperCase()})`;
  const res = await S.timelines.execAs(ctx.source, timelineId, "applyDub", {
    mediaId: m.id,
    layers: [{ mediaId: voice.id, name: name("voice"), volumeDb: 0 }, { mediaId: background.id, name: name("background"), volumeDb: 0 }],
  });
  return { revision: res.revision, media: { voice: voice.id, background: background.id } };
}

/** A cancel signal for a job: its own, or one raised when an agent job is cancelled (job.cancelled). */
function signalOf(job) {
  if (job?.signal) return { signal: job.signal, done: () => {} };
  if (!job || !("cancelled" in job)) return { signal: undefined, done: () => {} };
  const ac = new AbortController();
  const timer = setInterval(() => { if (job.cancelled) ac.abort(); }, 1000);
  return { signal: ac.signal, done: () => clearInterval(timer) };
}

/** opts: { mediaId, lang, context, duckDb }. job: { progress(p, label), signal | cancelled }. */
export async function dubTimeline(ctx, timelineId, opts = {}, job = null) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  const sig = signalOf(job);
  try {
    const r = await S.dubber.dub(m.id, opts, { onProgress: job?.progress, signal: sig.signal });
    const placed = await placeDub(ctx, timelineId, m, r);
    job?.progress?.(1, "timeline");
    return { ...brief(r), ...placed, mediaId: m.id };
  } finally { sig.done(); }
}

/** Voice again after the user changed lines (edits: [{ n, text, emotion, intensity, speaker }]) and place it again. */
export async function redubLines(ctx, timelineId, opts = {}, job = null) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  const sig = signalOf(job);
  try {
    const r = await S.dubber.revoice(m.id, opts.lang || "en", opts.edits || [], opts, { onProgress: job?.progress, signal: sig.signal });
    const placed = await placeDub(ctx, timelineId, m, r);
    job?.progress?.(1, "timeline");
    return { ...brief(r), ...placed, mediaId: m.id };
  } finally { sig.done(); }
}

/** The spoken language of the timeline's video: { language, p, arabic } (cached after the first time). */
export async function dubDetect(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  return { mediaId: m.id, ...(await S.dubber.detect(m.id)) };
}

/** Back to the video's own sound. */
export async function removeDubbing(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  return S.timelines.execAs(ctx.source, timelineId, "removeDub", { mediaId: m.id });
}
