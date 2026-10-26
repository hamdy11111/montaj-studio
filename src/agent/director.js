// Runs the director (core/director.js) on a timeline: gathers what it needs — the words (local speech model), the
// stabilized picture, where the person is in it (person matte → track), the media facts — and returns the plan with the
// reasons for each decision, or applies it as one undo step (edit_plan_apply's code path). The stages are weighted
// by their expected time (estimateWork), so the progress it reports moves steadily and a remaining time can be shown.
// Several clips on the main track are planned together, in their timeline order: each clip's words and person track
// are laid on one virtual time axis (the clips one after another) and the v2 plan maps everything back to each file.
//
// Phase 7 — the director as a pipeline (PLAN_editor_and_graphics.md, item 9 steps 3–6):
//  1. perception's event timeline per file (cached, or run when asked) → numbered moments, links and roles
//     (core/treatments.js; phase 5's takes and phase 6's links through the adapters when they are there);
//  2. 3–5 treatments: by rules, plus a planner model's (local Qwen, or Claude when the user turns it on);
//  3. every treatment EXECUTED by the deterministic executor (directPlan with its spec) and scored on the rubric;
//     the critic compares them two by two (a judge model asked in both orders, the rubric otherwise);
//  4. the winner gets graphics by meaning (graphics/selection.js planGraphics + the wordless reactions, the model as
//     ranker, perception's faces, measured on the real render) and sounds by meaning (the sound library, its rules);
//  5. the verifier's plan guards (the 02 failure: most of a wordless action video cut) join the quality guards, and
//     the cut sheet lists the chosen treatment with its alternatives. After an export, verifyExport re-transcribes
//     the file and measures loudness, black and frozen frames.
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../core/validation.js";
import { mainPieces } from "../core/editPlan.js";
import { directPlan, estimateWork, visualBeats, srcAt } from "../core/director.js";
import { editTime, editAt, srcAfter } from "../core/qa.js";
import { correctWords } from "../core/speech.js";
import { US } from "../core/util.js";
import { eventsOnAxis, momentsWithLinks, ruleTreatments, validateTreatment, executionSpec, takeScorer, reactionOf } from "../core/treatments.js";
import { rubric, rankTreatments } from "../core/critic.js";
import { verifyPlan, verifyOutput, expectedSpeech, parseFfmpegChecks, cutSheet } from "../core/verifier.js";
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

/** Perception's timeline of a file: this app's cache, then the shared runtime cache (the bench, other tools). */
async function cachedTimeline(S, file) {
  try { const t = S.perception?.cached?.(file); if (t) return t; } catch { /* unreadable */ }
  try {
    const { fileHash } = await import("../services/perception/perceptionService.js");
    const f = path.join(S.perception?.runtime || "", "perception-cache", fileHash(file), "timeline.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { /* none */ }
  return null;
}

/** The GPU lock for the planner model: the app's queue, and the machine-wide lock file when one is set (shared card). */
async function directorGpuLock(S) {
  const { makeGpuLock } = await import("../services/perception/perceptionService.js");
  const queue = S.gpu ? makeGpuLock({ queue: S.gpu, name: "director" }) : null;
  const script = process.env.DIRECTOR_GPU_LOCK || process.env.PERCEPTION_GPU_LOCK || null;
  const file = script && fs.existsSync(script) ? makeGpuLock({ script, name: "director" }) : null;
  return { acquire: async (id) => { const a = queue ? await queue.acquire(id) : null; try { const b = file ? await file.acquire(id) : null; return async () => { if (b) await b(); if (a) await a(); }; } catch (e) { if (a) await a(); throw e; } } };
}

/** The planner model of a run: null (rules only), a local Qwen or Claude (the user's key, this run only). */
async function plannerFor(S, opts, log) {
  const want = opts.planner || "rules";
  if (want === "rules") return null;
  const { LocalDirectorLLM, ClaudeDirectorLLM } = await import("../services/directorLLM.js");
  if (want === "claude") return new ClaudeDirectorLLM({ key: opts.claudeKey || undefined, log });
  const runtime = S.perception?.runtime || path.join(process.cwd(), "runtime");
  const llm = new LocalDirectorLLM({ runtime, model: opts.plannerModel || "auto", gpuLock: await directorGpuLock(S), log, think: !!opts.plannerThink, logFile: opts.llmLog || null });
  if (!llm.available) { if (want === "local") throw new AppError("PROVIDER", "err.mediaModelMissing", { model: opts.plannerModel || "Qwen planner" }); return null; }
  return llm;
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
  return { durationS: durationUs / US, cached, ...estimateWork({ durationS: Math.max(durationUs / US, fileS), width: big.width, height: big.height, cached, stabilize, person, perceive: opts.perceive === "run", planner: (opts.planner || "rules") !== "rules" }) };
}

// The last run per timeline: what verifyExport needs to check the exported file.
const LAST = new Map();

/**
 * opts: { style, keywords, cta, captionTemplate, corrections, language, apply, expectedRevision, targetSec (a reel of
 * that length), stabilize (default true), person (default true: graphics placed by the person), retakes (default true),
 * perceive ("cached" default | "run" | "off"), planner ("rules" default | "auto" | "local" | "claude"), plannerModel
 * ("auto" | "qwen3.8-27b" | "qwen3.6-35b-a3b"), claudeKey (this run only, never stored), judge (default true with a
 * planner), treatment (an id to force), links / takes (phase 6 / phase 5 results: one object for a single file, or
 * { [mediaId]: … }), graphics ("meaning" default | "words": the old key-word texts), measureGraphics (default true),
 * sounds ("library" default | "bundled") }.
 * The main track holds the clips to edit — one or several videos (and pictures), cut or not; the plan replaces it.
 */
export async function autoEdit(ctx, timelineId, opts = {}, job = null) {
  const S = ctx.services;
  const { tl, clips, media, durationUs } = theClips(S, timelineId);
  const est = directorEstimate(ctx, timelineId, opts);
  const stabilize = est.stages.some((x) => x.key === "stabilize"), person = est.stages.some((x) => x.key === "person");
  const log = (l) => (S.log ? S.log("director", l) : console.log(`[director] ${l}`));
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
  // Perception: one event timeline per file (cached unless asked to run; nothing when turned off).
  const perceive = opts.perceive || "cached";
  const timelines = perceive === "off" ? new Map() : perceive === "run" && S.perception
    ? await perFile("perceive", videos, (m, p) => S.perception.analyze(m.path, { onProgress: (e) => p(e?.progress ?? 0) }).catch((e) => { log(`perception failed: ${e.message}`); return null; }))
    : new Map(await Promise.all(videos.map(async (m) => [m.id, await cachedTimeline(S, m.path)])));
  const reportPlan = stage("plan");
  // The clips on one virtual axis: their words, their person track, and the clips without speech (never cut).
  const vWords = [], vTrack = [], protect = [];
  const toV = (c, s) => Math.round(c.vStart + (s - c.srcStart) / c.speed);
  for (const c of clips) {
    const len = (c.srcEnd - c.srcStart) / c.speed;
    const mine = (words.get(c.mediaId) || []).filter((w) => { const mid = (w.startUs + w.endUs) / 2; return mid >= c.srcStart && mid < c.srcEnd; });
    for (const w of mine) vWords.push({ ...w, startUs: Math.max(c.vStart, toV(c, w.startUs)), endUs: Math.min(c.vStart + len, toV(c, w.endUs)) });
    for (const f of tracks.get(c.mediaId) || []) if (f[0] >= c.srcStart && f[0] < c.srcEnd) vTrack.push([toV(c, f[0]), ...f.slice(1)]);
    if (!mine.length) protect.push([c.vStart, c.vStart + len]);
  }
  vWords.sort((a, b) => a.startUs - b.startUs);
  // The recognition fixes once, here: the moments and the executor then count the same words.
  const cWords = correctWords(vWords.map((w) => ({ t: w.text, s: w.startUs, e: w.endUs })), opts.corrections || []).map((w) => ({ text: w.t, startUs: w.s, endUs: w.e }));
  const first = clips.find((c) => c.kind === "video").m;
  const multi = clips.length > 1 || clips[0].srcStart > 0 || clips[0].speed !== 1;
  const base = {
    mediaId: clips[0].mediaId, ...(multi ? { clips: clips.map(({ m, ...c }) => c), protect } : {}),
    words: cWords, wordsCorrected: true, durationUs, track: vTrack, style: opts.style || "energetic", keywords: opts.keywords || [],
    media: { width: first.width, height: first.height }, canvas: { width: tl.canvas?.width, height: tl.canvas?.height },
    cta: opts.cta || "", captionTemplate: opts.captionTemplate, corrections: opts.corrections || [], title: opts.title || "Auto edit",
    targetUs: opts.targetSec ? Math.round(opts.targetSec * US) : null, stabilize, retakes: opts.retakes !== false,
  };
  // Phase 5 / phase 6 results (when given, or when their services are there) on the virtual axis (seconds).
  const firstClipOf = (mid) => clips.find((c) => c.mediaId === mid) || clips[0];
  const toAxisSec = (mid) => (sec) => toV(firstClipOf(mid), Math.round(sec * US)) / US;
  const perMedia = (given, svc) => {
    const out = [];
    for (const m of videos) {
      const x = given?.[m.id] ?? (videos.length === 1 && given && !given[m.id] && (given.links || given.roles || given.groups || typeof given === "function") ? given : null) ?? svc?.cached?.(m.path) ?? null;
      if (x) out.push({ m, x });
    }
    return out;
  };
  const shift = (o, f) => (o ? { ...o, t0: f(o.t0), t1: f(o.t1 ?? o.t0) } : o);
  const p6 = perMedia(opts.links, S.links);
  const phase6 = p6.length ? { links: p6.flatMap(({ m, x }) => (x.links || []).map((l) => ({ ...l, cause: shift(l.cause, toAxisSec(m.id)), reaction: shift(l.reaction, toAxisSec(m.id)) }))), roles: p6.flatMap(({ m, x }) => (x.roles || []).map((r) => shift(r, toAxisSec(m.id)))), promises: p6.flatMap(({ m, x }) => (x.promises || []).map((p) => ({ ...shift(p, toAxisSec(m.id)), payoff: shift(p.payoff, toAxisSec(m.id)) }))) } : null;
  const p5 = perMedia(opts.takes, S.takes);
  const takeScore = p5.length === 1 && typeof p5[0].x === "function" ? p5[0].x : p5.length ? takeScorer({ groups: p5.flatMap(({ m, x }) => (x.groups || []).map((g) => ({ ...g, takes: (g.takes || []).map((tk) => shift(tk, toAxisSec(m.id))) }))) }) : null;
  if (takeScore) base.takeScore = takeScore;

  // 1. Moments, links, roles.
  const events = eventsOnAxis(timelines, clips);
  const beats = visualBeats(cWords, vTrack);
  const { moments, links, promises } = momentsWithLinks({ words: cWords, events, durationUs, protect, beats, keywords: opts.keywords || [] }, phase6);
  reportPlan(0.1, "moments");
  // 2. Treatments: the rules' and the planner's.
  const planner = await plannerFor(S, opts, log).catch((e) => { log(`planner unavailable: ${e.message}`); if (opts.planner === "local" || opts.planner === "claude") throw e; return null; });
  const notesExtra = [], decisionsExtra = [];
  let treatments = ruleTreatments(moments, { durationUs, targetUs: base.targetUs, links, promises });
  let plannerInfo = { planner: "rules" };
  try {
    if (planner) {
      reportPlan(0.15, "planner");
      const { llmTreatments } = await import("../services/directorLLM.js");
      const kind = first.height > first.width ? "vertical phone video" : "horizontal video";
      const got = await llmTreatments(planner, { moments, links, durationS: durationUs / US, targetS: opts.targetSec || null, kind });
      const valid = got.treatments.map((t) => { const v = validateTreatment(t, moments, links, promises); return { ...v.treatment, fixes: v.fixes, source: t.source }; }).filter((t) => t.order.length);
      plannerInfo = { planner: planner.info?.id || "local", model: planner.info?.name, loadMs: planner.info?.loadMs ?? null, ms: got.ms, tokens: got.tokens, proposed: got.treatments.length, valid: valid.length, raw: got.raw };
      treatments = [...valid, ...treatments];
      notesExtra.push(`planner ${plannerInfo.model}: ${valid.length} treatment(s) in ${(got.ms / 1000).toFixed(1)} s`);
    }
    // 3. Execute each treatment, score it, compare them two by two.
    const items = [];
    for (const t of treatments) {
      const spec = executionSpec(t, moments, cWords);
      const r = directPlan({ ...base, spec });
      const guards = verifyPlan({ moments, links, cuts: r.virtual.cuts, durationUs, treatment: t, targetUs: base.targetUs });
      items.push({ id: t.id, treatment: t, spec, plan: r.plan, qa: r.qa, out: r, guards, rubric: rubric({ treatment: t, plan: r.plan, qa: r.qa, moments, links, targetUs: base.targetUs }) });
    }
    reportPlan(0.4, "critic");
    const { llmJudge } = planner && opts.judge !== false ? await import("../services/directorLLM.js") : {};
    // A treatment that fails a guard never wins over one that passes.
    const passing = items.filter((x) => x.guards.ok && (x.qa?.ok ?? true));
    const pool = passing.length ? passing : items;
    const ranked = await rankTreatments(pool, { judge: llmJudge ? llmJudge(planner) : null, moments });
    const chosenId = opts.treatment && items.some((x) => x.id === opts.treatment) ? opts.treatment : ranked.ranking[0].id;
    const chosen = items.find((x) => x.id === chosenId);
    // 4. Graphics and sounds by meaning on the winner (a second, deterministic pass of the executor).
    let final = chosen.out;
    const graphicsMode = opts.graphics || "meaning";
    let graphicsInfo = null;
    if (graphicsMode === "meaning") {
      reportPlan(0.6, "graphics");
      const g = await meaningGraphics(S, { out: chosen.out, moments, chosenSpec: chosen.spec, timelines, clips, tl, keywords: opts.keywords || [], planner, measure: opts.measureGraphics !== false, log });
      graphicsInfo = g.info;
      final = directPlan({ ...base, spec: chosen.spec, kit: g.kit });
    }
    reportPlan(0.85, "sounds");
    const soundInfo = await meaningSounds(S, final.plan, { moments, clips, log, bundled: opts.sounds === "bundled" });
    const guards = verifyPlan({ moments, links, cuts: final.virtual.cuts, durationUs, treatment: chosen.treatment, targetUs: base.targetUs });
    const { plan, notes, decisions } = final;
    let qa = final.qa;
    // The verifier's guards join the quality guards (one verdict for the app).
    if (qa) qa = { ...qa, checks: [...guards.checks, ...qa.checks], passed: [...guards.passed, ...qa.passed], ok: qa.ok && guards.ok };
    else qa = { checks: guards.checks, passed: guards.passed, ok: guards.ok, stats: {} };
    const sheet = cutSheet({ chosen: chosenId, items, ranking: ranked.ranking.concat(items.filter((x) => !pool.includes(x)).map((x) => ({ id: x.id, wins: 0, losses: 0, ties: 0, total: x.rubric.total }))), pairs: ranked.pairs, moments, links, planner: plannerInfo.planner, verify: guards });
    sheet.graphics = graphicsInfo; sheet.sounds = soundInfo; sheet.plannerInfo = plannerInfo;
    decisionsExtra.push({ k: "treatment", title: chosen.treatment.title, hook: chosen.treatment.hook?.kind || "none", moments: chosen.treatment.order.length, of: moments.length, alternatives: items.length - 1, planner: plannerInfo.planner, length: chosen.rubric.facts.editSec });
    if (chosen.spec.hook) decisionsExtra.push({ k: "hook", kind: chosen.spec.hook.kind, moment: chosen.spec.hook.moment, from: Math.round(chosen.spec.hook.fromUs / 1e5) / 10, to: Math.round(chosen.spec.hook.toUs / 1e5) / 10 });
    notesExtra.push(`treatment «${chosen.treatment.title}» (${chosen.treatment.source}): ${chosen.treatment.order.length} of ${moments.length} moments, hook ${chosen.treatment.hook?.kind || "none"}; ${items.length - 1} alternative(s) on the cut sheet`);
    if (person && !vTrack.length) { notes.push("the person model is not installed: no graphics behind the person (Settings › Providers)"); decisions.unshift({ k: "noPersonModel" }); }
    if (!person) { notes.push("person tracking was turned off: no graphics placed by the person"); decisions.unshift({ k: "personOff" }); }
    if (!events.length && perceive !== "off") { notes.push("no perception timeline for this video: moments from the words only (run «فهم الفيديو» for the action and reactions)"); decisions.unshift({ k: "noPerception" }); }
    notes.unshift(...notesExtra); decisions.unshift(...decisionsExtra);
    // What verifyExport needs later: the words per file (source time) and the moments that must still be heard.
    const wordsByMedia = Object.fromEntries([...words.entries()]);
    const importantV = moments.filter((m) => m.kind === "speech" && chosen.treatment.order.includes(m.n) && (m.role === "punch" || m.role === "reaction" || m.role === "setup"));
    LAST.set(timelineId, { plan, wordsByMedia, importantV, clips: clips.map(({ m, ...c }) => c), at: Date.now() });
    if (!opts.apply) return { plan, notes, qa, decisions, estimate: est, cutSheet: sheet, moments: momentsOut(moments), links };
    const apply = stage("apply");
    const r = await applyPlan(ctx, timelineId, plan, { expectedRevision: opts.expectedRevision, job: { progress: (p, label) => apply(p, label) } });
    return { ...r, notes, plan, qa, decisions, estimate: est, cutSheet: sheet, moments: momentsOut(moments), links };
  } finally { await planner?.stop?.(); }
}

/** Moments as the app shows them (no word indices). */
const momentsOut = (ms) => ms.map(({ w0, w1, lex, ...m }) => ({ ...m, s: m.s, e: m.e }));

// ------------------------------------------------------------------ graphics by meaning
const TEXT_TEMPLATES = new Set(["kinetic-word", "slam-stamp", "word-reveal", "gsap-title", "title-card", "chapter-banner", "chapter-card", "narrator-card", "flashback", "weather-swap", "name-tag", "shape-burst", "swap-card"]);
const WORDLESS_NEED = { laughter: [["reaction", "peak", "punchline"], "laugh", 5], applause: [["celebrate", "reaction"], "win", 4], scream: [["surprise", "peak", "reaction"], "shock", 5], gasp: [["surprise", "peak", "reaction"], "shock", 5] };

/**
 * Graphics for the chosen cut by meaning: graphics/selection.js on the kept words in EDIT time (sentence needs:
 * numbers, lists, punchlines, quotes…) plus one need per wordless reaction kept (a laugh, applause, a scream), the
 * model as the ranker when there is one, perception's faces to stay off them; the density guard over all; each pick
 * rendered and measured (measuredChecks) when the renderer is there — a pick that fails gives way to its
 * alternative. Returns { kit: [graphic in virtual source time], info } for the executor's second pass.
 */
async function meaningGraphics(S, { out, moments, chosenSpec, timelines, clips, tl, keywords, planner, measure, log }) {
  const sel = await import("../graphics/selection.js");
  const { cuts, kept, total } = out.virtual;
  const W = tl.canvas?.width || 1080, H = tl.canvas?.height || 1920, fps = tl.fps || 30;
  const editWords = kept.map((w) => ({ text: w.text, startUs: editTime(cuts, w.startUs), endUs: editAt(cuts, w.endUs) })).filter((w) => w.startUs !== null);
  // Faces (perception, normalised boxes) in edit time.
  const faces = [];
  for (const c of clips) {
    const tlm = timelines.get(c.mediaId);
    for (const e of (tlm?.events || []).filter((x) => x.type === "face_track")) for (const [k, b] of (e.extra?.boxes || []).entries()) {
      if (k % 2) continue;
      const src = Math.round(b[0] * US);
      if (src < c.srcStart || src >= c.srcEnd) continue;
      const t = editTime(cuts, Math.round(c.vStart + (src - c.srcStart) / (c.speed || 1)));
      if (t !== null) faces.push({ t: t / US, x: b[1], y: b[2], w: b[3], h: b[4] });
    }
  }
  let vfx = null;
  try { const { VfxLibraryService } = await import("../services/vfxLibraryService.js"); vfx = new VfxLibraryService({ repos: S.repos }); } catch { /* no emoji refs */ }
  const { animatedFor } = await import("../graphics/emoji.js").catch(() => ({}));
  const gctx = vfx ? { emojiFor: (e, tpl) => vfx.emojiRef(e, { video: tpl === "animated-emoji" }), emojiName: (e) => animatedFor?.(e)?.name || null } : {};
  const fctx = sel.frameCtx({ width: W, height: H, fps, faces });
  // Wordless needs: the reactions kept in the action.
  const wordless = [];
  for (const m of moments) {
    if (m.kind === "speech") continue;
    for (const r of m.reactions) {
      const def = WORDLESS_NEED[r.type];
      const at = editTime(cuts, r.t);
      if (!def || at === null || wordless.some((x) => Math.abs(x.startUs - at) < 3 * US)) continue;
      const end = editAt(cuts, m.e);
      wordless.push({ i: 10_000 + wordless.length, startUs: at, endUs: Math.max(at + 1, end), roomUs: Math.max(1_500_000, end - at), text: "", w0: 0, w1: -1, tags: def[0], anchors: Object.fromEntries(def[0].map((t) => [t, { w: 0, atUs: at }])), energy: def[2], numbers: [], moments: [{ type: def[1], score: 3, text: "" }], wordless: true, moment: m.n });
    }
  }
  // The model ranks every need in one call (seen first through the deterministic pass).
  let ranker = sel.heuristicRanker, rankInfo = { ranker: "heuristic" };
  const textless = (r) => async (args) => (await r(args)).filter((x) => !args.need.wordless || !TEXT_TEMPLATES.has(x.template));
  if (planner) {
    try {
      const seen = [];
      const spy = async (args) => { seen.push({ i: args.need.i, startUs: args.need.startUs, text: args.need.text, tags: args.need.tags, energy: args.need.energy, candidates: args.candidates }); return sel.heuristicRanker(args); };
      await sel.planGraphics(editWords, { width: W, height: H, fps, faces, totalUs: total, keywords, ctx: gctx, ranker: spy });
      for (const n of wordless) await sel.rankNeed(n, editWords, { ranker: textless(spy), fctx, ctx: gctx });
      const { llmGraphicsRanker } = await import("../services/directorLLM.js");
      const got = await llmGraphicsRanker(planner, seen, sel.heuristicRanker);
      ranker = got.ranker; rankInfo = { ranker: planner.info?.name || "model", ms: got.ms, needs: seen.length, answered: got.answered };
    } catch (e) { log(`graphics ranker: ${e.message}`); rankInfo = { ranker: "heuristic", error: String(e.message).slice(0, 120) }; }
  }
  const speech = await sel.planGraphics(editWords, { width: W, height: H, fps, faces, totalUs: total, keywords, ctx: gctx, ranker });
  const firsts = speech.items.map((it) => ({ ...it, alternatives: (speech.alternatives[it.needIndex] || []).filter((p) => p.template !== it.template) }));
  for (const n of wordless) {
    const picks = await sel.rankNeed(n, editWords, { ranker: textless(ranker), fctx, ctx: gctx });
    if (picks.length) firsts.push({ ...picks[0], alternatives: picks.slice(1), moment: n.moment });
  }
  const dens = sel.densityGuard(firsts, total);
  // Measured on the real render (entry on the word, off the face, inside the safe area, long enough to read).
  const measured = [];
  const { measuredChecks } = await import("../graphics/measure.js");
  let renderer = null;
  try { renderer = measure ? S.exporter?.graphics || null : null; if (renderer && !renderer.runtime?.().bundle) renderer = null; } catch { renderer = null; }
  const final = [];
  for (const it of dens.kept) {
    let pick = it;
    if (renderer) {
      for (const cand of [it, ...(it.alternatives || [])]) {
        try { const res = await measuredChecks(cand, renderer, fctx); measured.push({ template: cand.template, ok: res.ok }); if (res.ok) { pick = cand; break; } pick = null; }
        catch (e) { log(`measure ${cand.template}: ${e.message}`); pick = cand; break; } // the renderer failed: keep the predicted checks
      }
    }
    if (pick) final.push({ ...pick, alternatives: it.alternatives || [] });
  }
  // Back to the virtual source axis for the executor.
  const kit = final.map((it) => {
    const fromUs = srcAt(cuts, it.atUs), toUs = srcAfter(cuts, fromUs, it.durUs, out.virtual.durationUs);
    const w = editWords.find((x) => Math.abs(x.startUs - it.anchorUs) < 1000);
    return { template: it.template, params: it.params, fromUs, toUs, ...(w ? { anchor: { word: w.text.slice(0, 60), atUs: srcAt(cuts, it.anchorUs) } } : {}), reason: `${it.why || "by meaning"}${it.alternatives?.length ? ` (alternatives: ${it.alternatives.map((a) => a.template).join(", ")})` : ""}`.slice(0, 200), sfx: true };
  });
  return { kit, info: { ...rankInfo, picked: kit.map((k) => k.template), dropped: dens.dropped.length, coverage: Math.round(dens.coverage * 100) / 100, measured, wordlessNeeds: wordless.length, faces: faces.length } };
}

// ------------------------------------------------------------------ sounds by meaning
/**
 * The plan's sounds that carry a meaning (`query`, `mood`) get a file from the sound library through its director
 * tools (SFX_TOOLS: `sfx_search` by the moment's meaning and mood, `sfx_check_plan` over the result — no comic sound in
 * a serious moment, comic sounds spaced); the bundled sound stays as the fallback when the library is missing or finds
 * nothing. Changes plan.sfx in place.
 */
async function meaningSounds(S, plan, { moments, clips, log, bundled = false }) {
  const lib = bundled ? null : S.sfxLib;
  const want = (plan.sfx || []).filter((x) => x.query);
  if (!lib || !want.length) return { library: false, n: 0 };
  const { sfxToolHandlers } = await import("../services/sfxLibrary.js");
  const tools = sfxToolHandlers(lib);
  const used = [], events = [], info = { library: true, n: 0, picked: [] };
  const vOf = (x) => { const c = clips.find((k) => k.mediaId === x.mediaId) || clips[0]; return Math.round(c.vStart + (x.atUs - c.srcStart) / (c.speed || 1)); };
  const moodMoments = moments.map((m) => ({ startUs: m.s, endUs: m.e, mood: m.mood }));
  for (const x of want) {
    try {
      // Over speech a sound is a short accent: a long one (a crowd cheering, a cinematic whoosh) masks the words — the
      // verifier heard it on the interview (a «هيصة» cheer and a 2 s whoosh over a line). Wordless action allows more.
      const m = moments.find((k) => vOf(x) >= k.s && vOf(x) < k.e);
      const overSpeech = m?.kind === "speech" || moments.some((k) => k.kind === "speech" && vOf(x) + 1_500_000 > k.s && vOf(x) < k.e);
      const maxS = x.query === "whoosh" ? 1.2 : overSpeech ? 1.6 : 3.5;
      const r = await tools.sfx_search({ query: x.query, mood: x.mood || "neutral", limit: 10 });
      // …and never a human voice (a gasp, a laugh track) on top of someone speaking.
      const fit = (r.results || []).filter((k) => (k.durationS === null || k.durationS === undefined || k.durationS <= maxS) && !(overSpeech && k.category === "reactions"));
      const s = fit.find((k) => !used.slice(-6).includes(k.id)) || fit[0]; // not the same file again and again
      if (s) { x.library = { id: s.id, file: s.file, leadUs: s.leadUs || 0, title: String(s.title || "").slice(0, 80) }; if (overSpeech) x.volumeDb = Math.min(x.volumeDb ?? -10, -10); used.push(s.id); events.push({ atUs: vOf(x), sound: { id: s.id, comic: s.comic, cartoon: s.cartoon }, priority: 1, x }); info.picked.push(`${x.query} → ${s.title} (${s.durationS ?? "?"} s)`); }
      else info.picked.push(`${x.query}: nothing short enough (≤ ${maxS} s), the bundled sound`);
    } catch (e) { log(`sfx search «${x.query}»: ${e.message}`); }
  }
  // The library's rules over what was picked (a sound that breaks one falls back to the plain bundled sound).
  try {
    const { kept } = await tools.sfx_check_plan({ events: events.map((e, i) => ({ atUs: e.atUs, soundId: e.sound.id, priority: e.priority, i })), moments: moodMoments });
    const keep = new Set((kept || []).map((k) => k.i));
    events.forEach((e, i) => { if (!keep.has(i)) { delete e.x.library; info.picked.push(`dropped by the rules: ${e.sound.id}`); } });
  } catch (e) { log(`sfx check: ${e.message}`); }
  info.n = (plan.sfx || []).filter((x) => x.library).length;
  return info;
}

// ------------------------------------------------------------------ the verifier on the exported file
/**
 * Checks an exported file of this timeline's last director run: the file re-transcribed (every important line still
 * said, the words at the joints heard whole), its loudness, black and frozen frames. Returns verifyOutput's result.
 */
export async function verifyExport(ctx, timelineId, file, { language = "auto" } = {}) {
  const S = ctx.services;
  const last = LAST.get(timelineId);
  if (!last) throw new AppError("VALIDATION", "err.directorNoRun");
  if (!fs.existsSync(file)) throw new AppError("IO", "err.fileNotFound", { file: path.basename(file) });
  const tl = S.timelines.get(timelineId).timeline;
  const { binaries, run } = await import("../services/ffmpeg.js");
  // One pass: black frames, frozen frames, loudness (the summary of ebur128).
  const { stderr } = await run(binaries().ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vf", "blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-50dB:d=2", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], { timeoutMs: 30 * 60_000 }).catch((e) => ({ stderr: String(e.details?.stderr || e.message || "") }));
  const ff = parseFfmpegChecks(stderr);
  // The export re-transcribed by the same speech model (imported for it, then taken out of the project again).
  const imp = await S.media.importFiles(tl.projectId, [file], { origin: "verify" });
  const om = imp.imported?.[0];
  let outWords = [], transcriptError = null;
  try { if (om) outWords = (await S.captions.transcribeWords({ mediaId: om.id, language })).words || []; }
  catch (e) { transcriptError = String(e.messageKey || e.message || e).slice(0, 200); }
  finally { if (om) try { S.repos.media.detach(tl.projectId, om.id); } catch { /* kept */ } }
  const important = (mid, a, b) => last.importantV.some((m) => { const c = last.clips.find((k) => k.mediaId === mid) || last.clips[0]; const va = c.vStart + (a - c.srcStart) / (c.speed || 1), vb = c.vStart + (b - c.srcStart) / (c.speed || 1); return Math.min(vb, m.e) - Math.max(va, m.s) > 0.5 * (vb - va); });
  const expected = expectedSpeech(last.plan, last.wordsByMedia, { important });
  const durationS = om?.durationUs ? om.durationUs / US : null;
  const frozen = [...ff.frozen, ...(ff.openFreezeS !== null && durationS ? [{ startS: ff.openFreezeS, endS: durationS }] : [])];
  return { ...verifyOutput({ expected, outWords, loudness: ff.loudness, black: ff.black, frozen, durationS, plannedS: expected.editUs / US }), measured: { loudness: ff.loudness, black: ff.black, frozen, words: outWords.length, transcriptError, imported: !!om } };
}
