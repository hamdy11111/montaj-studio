// Best take by performance (Phase 5 of PLAN_editor_and_graphics.md, item 4). The retake groups come from
// core/speech.js (retakeGroups: the same line said again, found by meaning); this file only JUDGES the takes of a group.
// Pure functions — the measurements themselves (voice, face, gaze, sound quality…) are made by services/takes/**.
//
// The rules the plan sets, and how they are kept here:
//  · every signal is compared BETWEEN THE TAKES OF ONE GROUP only, never against an absolute scale: a value becomes
//    0…1 around the group's mean, saturating at about one "just noticeable difference" (jnd) away — two takes that
//    differ by less than a jnd score almost the same, so noise in a measurement cannot flip a choice by itself;
//  · a signal a take cannot have (no face on screen, no perception timeline, a model not installed) is left out for
//    the whole group and the weights of the others are renormalised — nothing is guessed;
//  · gates, not scores, for what models trained on other material cannot rank (DNSMOS sound quality, dark/shaky
//    picture — DOVER's job in the plan): a take that fails a gate is kept only when every take fails it;
//  · a false start / incomplete take is never kept while a complete one exists (what phase 2 did);
//  · weights differ per content type (comedy: timing + expression + laughter; explainer: fluency + gaze);
//  · close calls only (margin below `tieMargin`) may go to an AI judge, asked in both orders (A/B then B/A) — its
//    answer counts only when it agrees with itself (judges are weak on comedy: ~60 % agreement with people);
//  · the user's own picks (from a published video matched to its raw, or picked by hand) adjust the weights
//    (learnWeights: pairwise logistic, pulled towards the defaults so a handful of picks cannot run away).

export const TAKES_VERSION = "montaj.takes/1";

/**
 * The signals. better: which way is good. jnd: the difference that matters (in the raw unit). source: what measures it.
 * group: shown together in the cut sheet.
 */
export const SIGNALS = Object.freeze({
  fillers: { group: "fluency", better: "low", jnd: 0.08, source: "words", en: "filler words (يعني، امم، بص…) per word", ar: "حشو أقل" },
  pauses: { group: "fluency", better: "low", jnd: 0.12, source: "words", en: "in-sentence pause per second of speech", ar: "سكتات أقل جوه الجملة" },
  asrConf: { group: "fluency", better: "high", jnd: 0.06, source: "words", en: "speech recogniser confidence (clear words)", ar: "كلام أوضح" },
  rateSteady: { group: "fluency", better: "low", jnd: 0.12, source: "words", en: "speaking-rate variation (CV of letters per second)", ar: "سرعة كلام ثابتة" },
  pitchVar: { group: "voice", better: "high", jnd: 0.04, source: "openSMILE eGeMAPSv02", en: "pitch variety (F0 stddevNorm)", ar: "نبرة متنوعة" },
  loudness: { group: "voice", better: "high", jnd: 0.25, source: "openSMILE eGeMAPSv02", en: "loudness (log2 of mean)", ar: "صوت أعلى وأقوى" },
  emotion: { group: "voice", better: "high", jnd: 0.12, source: "emotion2vec+ large", en: "energy of the emotion (happy+surprised+angry − neutral − sad)", ar: "إحساس وطاقة أكتر" },
  quality: { group: "sound", better: "high", jnd: 0.2, source: "DNSMOS P.835", en: "sound quality (DNSMOS overall)", ar: "صوت أنضف" },
  smile: { group: "face", better: "high", jnd: 0.25, source: "LibreFace (AU6+AU12)", en: "real smile (cheek raiser + lip corners)", ar: "ابتسامة حقيقية" },
  brows: { group: "face", better: "high", jnd: 0.12, source: "LibreFace (AU1+AU2)", en: "brow movement (expressiveness)", ar: "تعبير بالحواجب" },
  blinks: { group: "face", better: "low", jnd: 0.25, source: "MediaPipe Face Landmarker", en: "blinks in the middle of a word per second", ar: "رمش أقل وسط الكلام" },
  onScreen: { group: "face", better: "high", jnd: 0.15, source: "perception (faces + LR-ASD) / MediaPipe", en: "share of the take the speaker is on screen", ar: "باين في الكادر أكتر" },
  gaze: { group: "face", better: "high", jnd: 0.15, source: "L2CS-Net (Gaze360)", en: "share of the take looking at the camera", ar: "بيبص للكاميرا أكتر" },
  laughter: { group: "reaction", better: "high", jnd: 0.3, source: "perception (laughter-detection + PANNs)", en: "laughter after the line (seconds, others count double)", ar: "ضحك بعد الجملة" },
  timing: { group: "timing", better: "high", jnd: 0.12, source: "words", en: "a beat before the punchline that stands out from hesitations (s)", ar: "توقيت الإفيه (سكتة قبل القفلة)" },
});
export const SIGNAL_NAMES = Object.freeze(Object.keys(SIGNALS));

const W = (o) => ({ fillers: 1, pauses: 1, asrConf: 0.6, rateSteady: 0.5, pitchVar: 0.7, loudness: 0.5, emotion: 0.7, quality: 0.5, smile: 0.5, brows: 0.3, blinks: 0.3, onScreen: 0.5, gaze: 0.7, laughter: 1, timing: 0.4, ...o });
/** Default weights per content type (the plan: comedy → timing and expression; explainer → fluency and gaze). */
export const TYPE_WEIGHTS = Object.freeze({
  default: W({}),
  comedy: W({ timing: 2, laughter: 2, smile: 1.2, brows: 0.8, emotion: 1, pitchVar: 1, pauses: 0.3, fillers: 0.6, rateSteady: 0.3, gaze: 0.4 }),
  explainer: W({ fillers: 2, pauses: 1.5, asrConf: 1.2, rateSteady: 1, gaze: 1.8, onScreen: 1, smile: 0.3, laughter: 0.3, timing: 0, emotion: 0.4 }),
  vlog: W({ emotion: 1, smile: 0.8, gaze: 1, laughter: 0.8 }),
  interview: W({ fillers: 1.5, pauses: 1.2, asrConf: 1, gaze: 0, onScreen: 0.8, timing: 0.2, smile: 0.3 }), // the guest looks at the host, not the lens
  cooking: W({ fillers: 1.2, gaze: 0.6, onScreen: 0.3 }),
  challenge: W({ emotion: 1.2, loudness: 1, laughter: 1.5, timing: 0.6 }),
});
export const CONTENT_TYPES = Object.freeze(Object.keys(TYPE_WEIGHTS));

/** Content type from a word in a name (bench folders «06-كوميديا», a project tag…): one of CONTENT_TYPES. */
export function typeFromName(name) {
  const s = String(name || "").toLowerCase();
  const table = [["comedy", /كوميد|ضحك|اسكتش|مقلب|comedy|sketch|prank/], ["explainer", /شرح|تعليم|explain|tutorial|lesson/], ["interview", /مقابل|حوار|بودكاست|interview|podcast/],
    ["cooking", /طبخ|اكل|أكل|مطبخ|cook|recipe|food/], ["challenge", /تحدي|challenge/], ["vlog", /فلوق|فلوج|vlog/]];
  return (table.find(([, re]) => re.test(s)) || ["default"])[0];
}

/** Defaults: margin under which a group is a close call; gate limits; the small edge the last complete take keeps. */
export const TAKE_POLICY = Object.freeze({
  tieMargin: 0.06,
  lastBonus: 0.01, // equal performances → the last complete take (what the speaker settled on, phase 2's default)
  gate: { ovrlBelowBest: 0.8, ovrlMin: 2.0, ovrlFine: 2.6, lumaShare: 0.6, lumaMin: 28, shakeRatio: 2.5, shakeMin: 2.0 },
  learn: { lambda: 1, steps: 600, rate: 0.02, scale: 6, minExamples: 3 },
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

/**
 * Relative 0…1 scores of one signal across the takes of a group: 0.5 at the group mean, ± 0.5·tanh(diff / jnd), flipped
 * when lower is better. null for a take without the value; all null when fewer than two takes have it.
 */
export function relativeScores(values, { better = "high", jnd = 1 } = {}) {
  const have = values.map(num);
  const xs = have.filter((v) => v !== null);
  if (xs.length < 2) return values.map(() => null);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const dir = better === "low" ? -1 : 1;
  return have.map((v) => (v === null ? null : 0.5 + 0.5 * Math.tanh((dir * (v - mean)) / jnd)));
}

/**
 * Gates of each take (sound quality, dark, shaky), each judged against the other takes of the group: { fails: [names],
 * passes } per take. A gate only counts when at least one take passes it.
 * gate input per take: { ovrl (DNSMOS overall 1…5), luma (mean 0…255), shake (px of jitter at 320 px wide) } — any may be null.
 */
export function gateTakes(gates, P = TAKE_POLICY.gate) {
  const g = gates.map((x) => x || {});
  const vals = (k) => g.map((x) => num(x[k])).filter((v) => v !== null);
  const ov = vals("ovrl"), lu = vals("luma"), sh = vals("shake");
  const bestOv = ov.length ? Math.max(...ov) : null, bestLu = lu.length ? Math.max(...lu) : null, minSh = sh.length ? Math.min(...sh) : null;
  const out = g.map((x) => {
    const fails = [];
    if (num(x.ovrl) !== null && ov.length > 1 && ((x.ovrl < bestOv - P.ovrlBelowBest && x.ovrl < P.ovrlFine) || (x.ovrl < P.ovrlMin && bestOv >= P.ovrlFine))) fails.push("sound");
    if (num(x.luma) !== null && lu.length > 1 && (x.luma < bestLu * P.lumaShare || (x.luma < P.lumaMin && bestLu >= 1.5 * P.lumaMin))) fails.push("dark");
    if (num(x.shake) !== null && sh.length > 1 && x.shake > Math.max(minSh * P.shakeRatio, P.shakeMin)) fails.push("shaky");
    return { fails };
  });
  for (const name of ["sound", "dark", "shaky"]) if (out.every((o) => o.fails.includes(name))) for (const o of out) o.fails = o.fails.filter((f) => f !== name);
  return out.map((o) => ({ ...o, passes: o.fails.length === 0 }));
}

/** Weights to use: a content type's defaults, overridden by learned ones (per type) when given. */
export function weightsFor(type = "default", learned = null) {
  const base = TYPE_WEIGHTS[type] || TYPE_WEIGHTS.default;
  const l = learned?.[type]?.weights || learned?.default?.weights || null;
  return { ...base, ...(l || {}) };
}

/**
 * Scores the takes of one group.
 * group: a retakeGroups group ({ takes: [{ fromUs, toUs, text, kind, complete }], kept, line }).
 * feats: one entry per take: { signals: { name: raw | null }, gate: { ovrl, luma, shake } }.
 * Returns the group in the output contract (see HANDOFF.md): takes with per-signal { raw, rel }, total, eligible,
 * kept, keptBy, margin, closeCall, reason / reasonAr. Does not ask any judge — see judgeVerdict / applyJudge.
 */
export function scoreGroup(group, feats, { type = "default", weights = weightsFor(type), policy = TAKE_POLICY } = {}) {
  const n = group.takes.length;
  const sig = {};
  for (const name of SIGNAL_NAMES) {
    const raw = group.takes.map((_, i) => num(feats[i]?.signals?.[name]));
    sig[name] = { raw, rel: relativeScores(raw, SIGNALS[name]) };
  }
  const used = SIGNAL_NAMES.filter((s) => (weights[s] || 0) > 0 && sig[s].rel.every((v) => v !== null));
  const partial = SIGNAL_NAMES.filter((s) => (weights[s] || 0) > 0 && !used.includes(s) && sig[s].rel.some((v) => v !== null));
  const wsum = used.reduce((a, s) => a + weights[s], 0);
  const gates = gateTakes(group.takes.map((_, i) => feats[i]?.gate));
  const anyComplete = group.takes.some((t) => t.complete);
  const anyPass = group.takes.some((t, i) => gates[i].passes && (t.complete || !anyComplete));
  const lastComplete = (() => { for (let i = n - 1; i >= 0; i--) if (group.takes[i].complete) return i; return n - 1; })();
  const takes = group.takes.map((t, i) => {
    const scores = {};
    for (const s of SIGNAL_NAMES) scores[s] = { raw: r3(sig[s].raw[i]), rel: r3(sig[s].rel[i]) };
    const perf = wsum ? used.reduce((a, s) => a + weights[s] * (sig[s].rel[i] - 0.5), 0) / wsum : 0;
    const total = perf + (i === lastComplete ? policy.lastBonus : 0);
    const why = [];
    if (anyComplete && !t.complete) why.push(t.kind === "false-start" ? "false start" : "incomplete");
    if (anyPass && !gates[i].passes) why.push(...gates[i].fails);
    return { index: i, fromUs: t.fromUs, toUs: t.toUs, text: t.text, kind: t.kind, complete: !!t.complete, scores, gates: gates[i].fails, perf: r3(perf), total: r3(total), eligible: why.length === 0, ineligible: why };
  });
  const ranked = takes.filter((t) => t.eligible).sort((a, b) => b.total - a.total || b.index - a.index);
  const pool = ranked.length ? ranked : [...takes].sort((a, b) => b.total - a.total || b.index - a.index);
  const best = pool[0], second = pool[1] || null;
  const margin = second ? r3(best.total - second.total) : null;
  const out = {
    line: group.line ?? group.takes[group.kept ?? n - 1]?.text ?? "", fromUs: group.takes[0].fromUs, toUs: group.takes[n - 1].toUs,
    type, signalsUsed: used, signalsPartial: partial, weights: Object.fromEntries(used.map((s) => [s, weights[s]])),
    takes, defaultKept: group.kept ?? lastComplete, kept: best.index, runnerUp: second ? second.index : null, margin,
    closeCall: !!second && margin < policy.tieMargin, keptBy: used.length ? "score" : "last-complete", judge: null,
  };
  Object.assign(out, explain(out));
  return out;
}

/** Reason (English + Egyptian Arabic) for the kept take: the signals that put it ahead of the runner-up. */
export function explain(g) {
  const k = g.takes[g.kept];
  if (g.takes.length < 2) return { reason: "only take", reasonAr: "إعادة واحدة بس" };
  if (g.keptBy === "judge") return { reason: `close call (margin ${g.margin}); the AI judge preferred take ${g.kept + 1} in both orders`, reasonAr: `الفرق صغير، والحكم بالذكاء الاصطناعي اختار الإعادة ${g.kept + 1} بالترتيبين` };
  const out = [];
  const ineligible = g.takes.filter((t) => !t.eligible);
  if (ineligible.length) out.push([`left out: ${ineligible.map((t) => `take ${t.index + 1} (${t.ineligible.join(", ")})`).join("; ")}`, `اتشالت: ${ineligible.map((t) => `${t.index + 1} (${t.ineligible.map(arGate).join("، ")})`).join("؛ ")}`]);
  if (!g.signalsUsed.length) {
    out.unshift(["no performance signal could be measured — the last complete take", "مفيش إشارة أداء اتقاست — آخر إعادة كاملة"]);
  } else if (g.runnerUp !== null) {
    const o = g.takes[g.runnerUp];
    const lead = g.signalsUsed.map((s) => ({ s, d: g.weights[s] * (k.scores[s].rel - o.scores[s].rel) })).filter((x) => x.d > 0.02).sort((a, b) => b.d - a.d).slice(0, 3);
    if (lead.length) out.unshift([`take ${g.kept + 1} over take ${g.runnerUp + 1}: ${lead.map((x) => SIGNALS[x.s].en.split(" (")[0]).join(", ")}`, `الإعادة ${g.kept + 1} أحسن من ${g.runnerUp + 1}: ${lead.map((x) => SIGNALS[x.s].ar).join("، ")}`]);
    else out.unshift([`takes ${g.kept + 1} and ${g.runnerUp + 1} perform the same — the later complete one`, `الإعادتين ${g.kept + 1} و${g.runnerUp + 1} زي بعض — الأحدث`]);
    if (g.closeCall) out.push([`close call (margin ${g.margin})`, `الفرق صغير (${g.margin})`]);
  }
  return { reason: out.map((x) => x[0]).join("; "), reasonAr: out.map((x) => x[1]).join("؛ ") };
}
export const arGate = (f) => ({ "false start": "بداية غلط", incomplete: "ناقصة", sound: "الصوت وحش", dark: "ضلمة", shaky: "مهزوزة" })[f] || f;

/**
 * The AI judge's verdict from both orders. ab: its answer with the leader shown as A and the runner-up as B; ba: with
 * them swapped. Answers "A" | "B" | anything else (same / unsure). Returns "leader" | "runnerUp" | null (inconsistent).
 */
export function judgeVerdict(ab, ba) {
  const a = String(ab || "").trim().toUpperCase(), b = String(ba || "").trim().toUpperCase();
  if (a === "A" && b === "B") return "leader";
  if (a === "B" && b === "A") return "runnerUp";
  return null;
}

/** Applies a judge's two answers to a close call; the score stands when the judge contradicts itself. */
export function applyJudge(g, { ab, ba, model = null } = {}) {
  if (!g.closeCall || g.runnerUp === null) return g;
  const verdict = judgeVerdict(ab, ba);
  const out = { ...g, judge: { model, ab: ab ?? null, ba: ba ?? null, consistent: verdict !== null, verdict } };
  if (verdict === "runnerUp") Object.assign(out, { kept: g.runnerUp, runnerUp: g.kept, keptBy: "judge" });
  else if (verdict === "leader") out.keptBy = "judge";
  return { ...out, ...explain(out) };
}

/**
 * The whole result for one media (the stable JSON contract, see HANDOFF.md). Each group also carries the fields the
 * director's adapter reads (phase 7, director-notes.md): `best` (= kept) and per take `t0`/`t1` (seconds of media
 * time) and `score` 0…1 — 1 for the kept take, total + 0.5 (≤ 0.99) for the other eligible ones, 0 for a left-out one —
 * plus `why` (the Arabic reason on the kept take).
 */
export function takesResult({ media = null, type = "default", weightsSource = "default", groups = [], missing = [], timings = null } = {}) {
  const r3s = (v) => Math.round(v * 1000) / 1000;
  const out = groups.map((g) => ({
    ...g, best: g.kept,
    takes: g.takes.map((t) => ({ ...t, t0: r3s(t.fromUs / 1e6), t1: r3s(t.toUs / 1e6), score: t.index === g.kept ? 1 : t.eligible ? r3s(clamp(t.total + 0.5, 0, 0.99)) : 0, ...(t.index === g.kept ? { why: g.reasonAr } : {}) })),
  }));
  return { version: TAKES_VERSION, schema: TAKES_VERSION, media, type, weightsSource, signals: SIGNALS, missing, groups: out, timings };
}

/**
 * A `score(take, group)` for core/speech.js retakeGroups / chooseTake that reproduces a result's choices: the kept take
 * scores 1, the others their total (< 1). Takes are matched by time (± toleranceUs).
 */
export function scoreFn(result, { toleranceUs = 200_000 } = {}) {
  const all = (result?.groups || []).flatMap((g) => g.takes.map((t) => ({ g, t })));
  return (take) => {
    const m = all.find(({ t }) => Math.abs(t.fromUs - take.fromUs) <= toleranceUs && Math.abs(t.toUs - take.toUs) <= toleranceUs);
    if (!m) return 0;
    return m.t.index === m.g.kept ? 1 : m.t.total;
  };
}

// ------------------------------------------------------------------ learning from the user's own picks
// An example is one group the user decided: { type, rel: [ { signal: rel 0…1 | null } per take ], picked, eligible }.
// Pairwise (Bradley–Terry) logistic loss over (picked, other) pairs on the signals both takes have, plus λ·‖w − w0‖²
// towards the type's defaults — a few picks nudge the weights, many picks can move them a lot. Weights stay ≥ 0.

/** One example from a scored group and the index the user picked. */
export function exampleFrom(g, picked) {
  return { type: g.type || "default", picked, rel: g.takes.map((t) => Object.fromEntries(SIGNAL_NAMES.map((s) => [s, t.scores[s].rel]))), eligible: g.takes.map((t) => t.eligible), n: g.takes.length };
}

export function learnWeights(examples, { type = "default", prior = TYPE_WEIGHTS[type] || TYPE_WEIGHTS.default, P = TAKE_POLICY.learn } = {}) {
  const ex = examples.filter((e) => (e.type || "default") === type || type === "*");
  const w = { ...prior };
  const pairs = [];
  for (const e of ex) e.rel.forEach((_, j) => { if (j !== e.picked && e.eligible?.[j] !== false) pairs.push([e.rel[e.picked], e.rel[j]]); });
  if (ex.length < P.minExamples || !pairs.length) return { type, weights: w, examples: ex.length, pairs: pairs.length, learned: false };
  for (let step = 0; step < P.steps; step++) {
    const grad = Object.fromEntries(SIGNAL_NAMES.map((s) => [s, 2 * P.lambda * (w[s] - prior[s])]));
    for (const [a, b] of pairs) {
      const ds = SIGNAL_NAMES.filter((s) => num(a[s]) !== null && num(b[s]) !== null);
      const wsum = ds.reduce((x, s) => x + w[s], 0) || 1;
      const z = P.scale * ds.reduce((x, s) => x + w[s] * (a[s] - b[s]), 0) / wsum;
      const p = 1 / (1 + Math.exp(-z));
      for (const s of ds) grad[s] -= ((1 - p) * P.scale * (a[s] - b[s])) / wsum; // summed: more picks, more pull
    }
    for (const s of SIGNAL_NAMES) w[s] = clamp(w[s] - P.rate * grad[s], 0, 5);
  }
  return { type, weights: Object.fromEntries(SIGNAL_NAMES.map((s) => [s, r3(w[s])])), examples: ex.length, pairs: pairs.length, learned: true };
}

/** Chooses a take from an example's rel scores with given weights (eligible takes only; ties → the later one). */
export function chooseByWeights(e, weights) {
  const used = SIGNAL_NAMES.filter((s) => (weights[s] || 0) > 0 && e.rel.every((r) => num(r[s]) !== null));
  const wsum = used.reduce((a, s) => a + weights[s], 0) || 1;
  const tot = e.rel.map((r, i) => ({ i, s: e.eligible?.[i] === false ? -Infinity : used.reduce((a, s) => a + weights[s] * (r[s] - 0.5), 0) / wsum }));
  return tot.sort((a, b) => b.s - a.s || b.i - a.i)[0].i;
}

/**
 * Agreement of a chooser with the user's picks, next to the baselines the plan asks for: random (expected 1/n over the
 * takes) and "always the last take" (what Descript does). examples need { picked, n }; chosen: the chooser's index per example.
 */
export function agreement(examples, chosen) {
  const n = examples.length;
  if (!n) return { n: 0, chooser: null, random: null, last: null };
  const hit = examples.filter((e, i) => chosen[i] === e.picked).length;
  const last = examples.filter((e) => e.picked === e.n - 1).length;
  const random = examples.reduce((a, e) => a + 1 / e.n, 0);
  return { n, chooser: r3(hit / n), chooserHits: hit, random: r3(random / n), last: r3(last / n), lastHits: last };
}

/** Leave-one-out check of learning: learn on all picks but one, choose that one; the honest number for a small set. */
export function leaveOneOut(examples, { type = "*", prior = TYPE_WEIGHTS.default } = {}) {
  return examples.map((e, i) => {
    const rest = examples.filter((_, j) => j !== i);
    const { weights } = learnWeights(rest, { type, prior, P: { ...TAKE_POLICY.learn, minExamples: 1 } });
    return chooseByWeights(e, weights);
  });
}
