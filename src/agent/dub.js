// Dubbing a timeline's video (services/dubService.js does the speech work): the new voice and the kept background
// become media of the project and two audio tracks that follow the video's clips (applyDub), with the video's own
// sound turned off — one undo step; removing the dub turns it back on.
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../core/validation.js";
import { mainPieces } from "../core/editPlan.js";
import { US } from "../core/util.js";
import { dubLanguages } from "../core/timelineOps.js";

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
    lines: r.lines.map((l, n) => ({ n, spk: l.spk, start: l.start, end: l.end, ar: l.ar, text: l.spoken || l.text, emotion: l.emotion, intensity: l.intensityByUser ? l.intensity : l.arousal ?? l.intensity, speed: l.speed, fill: l.fill ?? null, edited: !!l.edited, check: l.check ?? null })),
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
  // Each line: where its voice is in voice.wav (= the source's time), how long, and the Arabic line it dubs.
  const order = r.speakers.map((sp) => sp.id);
  const lines = r.lines.map((l, n) => ({ n, label: `S${order.indexOf(l.spk) + 1}`, text: l.spoken || l.text || "", ar: l.ar || "",
    arStart: l.start * US, arEnd: l.end * US, at: (l.placed ?? l.start) * US, duration: (l.duration || 0) * US })).filter((l) => l.duration > 0);
  const res = await S.timelines.execAs(ctx.source, timelineId, "applyDub", { mediaId: m.id, lang: r.lang, voiceMediaId: voice.id, backgroundMediaId: background.id, lines });
  return { revision: res.revision, placed: res.result?.placed ?? lines.length, media: { voice: voice.id, background: background.id } };
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

/** Remove one dubbed language (opts.lang) or all of them; with none left, the video's own sound comes back. */
export async function removeDubbing(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  return S.timelines.execAs(ctx.source, timelineId, "removeDub", { mediaId: m.id, lang: opts.lang || null });
}

/**
 * A speaker's voice sample (what the dub copies), as a data: URL the dialog can play — opts: { lang, speaker }. Only a
 * file of this media's dub work folder is read.
 */
export function dubSpeakerSample(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  const last = S.dubber.last(m.id, opts.lang || "en");
  const sp = last?.speakers.find((x) => x.id === Number(opts.speaker));
  const work = S.dubber.workDir(m);
  const file = sp?.ref && path.resolve(sp.ref);
  if (!file || !file.startsWith(path.resolve(work) + path.sep) || !fs.existsSync(file)) throw new AppError("NOT_FOUND", "err.dubNone");
  return `data:audio/wav;base64,${fs.readFileSync(file).toString("base64")}`;
}

/** The dubbed language that is heard (its voice on, its subtitles shown); the others are muted. */
export async function dubSetLanguage(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { m } = theMedia(S, timelineId, opts.mediaId);
  return S.timelines.execAs(ctx.source, timelineId, "setDubLanguage", { mediaId: m.id, lang: String(opts.lang || "") });
}

/** The languages this timeline's video is dubbed into, and the one heard. */
export function dubOnTimeline(ctx, timelineId, opts = {}) {
  const S = ctx.services;
  const { tl, m } = theMedia(S, timelineId, opts.mediaId);
  return dubLanguages(tl, m.id);
}
