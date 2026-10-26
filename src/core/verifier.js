// The director's pipeline, part 3 (PLAN_editor_and_graphics.md, item 9 step 6): the verifier — the guards that must
// FAIL when the edit is wrong, on the plan and on the exported video — and the cut sheet for the user.
//  · plan guards: most of a wordless action video cut away (the 02 challenge: 127 s → 17 s, "all passed" before),
//    an edit far too short for what happened in it, a cause separated from its reaction, nothing in the first 3 s;
//  · output checks (the exported file, measured by agent/director.js verifyExport): the output re-transcribed —
//    every important line is still said, the words at each joint survive whole —, the loudness, black frames, frozen
//    or duplicated frames.
// Pure: the caller measures (ffmpeg, the speech model) and passes the numbers in. Times in µs unless named …S.
import { alignToken, alignTokens, sameToken } from "./speech.js";
import { US } from "./util.js";

export const VERIFY = {
  action: { speechShareMax: 0.45, minActionS: 20, keptShareMin: 0.4 }, // a mostly wordless video keeps ≥ 40 % of its action
  tooShort: { minShare: 0.25, minActionS: 30 },                          // ≤ 25 % of the raw while ≥ 30 s of action happened
  hookSec: 3,
  line: { coverage: 0.6, lost: 0.34, windowUs: 4_000_000, minAgreement: 0.5 },
  joint: { windowUs: 700_000, margin: 0.3 },
  loudness: { target: -14, tol: 1.5, truePeakMax: -1 },
  black: { minS: 0.12 }, frozen: { minS: 2.0 },
};
const sec = (us) => Math.round(us / 1e5) / 10;
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Kept length of a virtual span once `cuts` ([{ fromUs, toUs }]) are removed. */
export function keptIn(cuts, a, b) {
  let cut = 0;
  for (const c of cuts) cut += overlap(a, b, c.fromUs, c.toUs);
  return Math.max(0, b - a - cut);
}

/**
 * Guards on a plan, from the moments (core/treatments.js) and the virtual cuts the executor made. Works for any plan —
 * the old single-pass director too (no treatment): that is how the 02 failure is caught. input: { moments, links,
 * cuts, durationUs, treatment (optional) }. Returns { checks: [{ id, level, message, args }],
 * passed: [ids], stats: { speechShare, actionS, keptActionS, keptShare } }.
 */
export function verifyPlan({ moments = [], links = [], cuts = [], durationUs, treatment = null }, V = VERIFY) {
  const checks = [], passed = [];
  const add = (id, level, message, args = {}) => checks.push({ id, level, message, args });
  const D = durationUs || (moments.length ? moments[moments.length - 1].e : 0);
  const speechUs = moments.filter((m) => m.kind === "speech").reduce((n, m) => n + m.e - m.s, 0);
  const action = moments.filter((m) => m.kind === "action");
  const actionUs = action.reduce((n, m) => n + m.e - m.s, 0);
  const keptActionUs = action.reduce((n, m) => n + keptIn(cuts, m.s, m.e), 0);
  const editUs = Math.max(0, D - cuts.reduce((n, c) => n + overlap(0, D, c.fromUs, c.toUs), 0));
  const speechShare = D ? speechUs / D : 0, keptShare = actionUs ? keptActionUs / actionUs : 1;
  // 1. Most of the wordless action cut away.
  if (speechShare <= V.action.speechShareMax && actionUs >= V.action.minActionS * US && keptShare < V.action.keptShareMin)
    add("action.cut", "fail", `most of the wordless action is cut: ${sec(keptActionUs)} of ${sec(actionUs)} s kept (${Math.round(100 * keptShare)} %) in a video that is ${Math.round(100 * (1 - speechShare))} % without words`, { kept: sec(keptActionUs), of: sec(actionUs), pct: Math.round(100 * keptShare) });
  else passed.push("action.cut");
  // 2. An edit far too short for what happened in it.
  if (D && editUs / D < V.tooShort.minShare && actionUs >= V.tooShort.minActionS * US)
    add("edit.tooShort", "fail", `the edit keeps ${sec(editUs)} s of ${sec(D)} s although ${sec(actionUs)} s of action happened`, { edit: sec(editUs), raw: sec(D), action: sec(actionUs) });
  else passed.push("edit.tooShort");
  // 3. A cause separated from its reaction (both kept, not side by side in the edit order).
  if (treatment) {
    const pos = new Map(treatment.order.map((n, i) => [n, i]));
    const apart = links.filter((l) => l.cause !== l.reaction && pos.has(l.cause) && pos.has(l.reaction) && Math.abs(pos.get(l.cause) - pos.get(l.reaction)) !== 1);
    for (const l of apart) add("links.apart", "fail", `moment ${l.cause} and its reaction ${l.reaction} are not side by side`, { cause: l.cause, reaction: l.reaction });
    const lost = links.filter((l) => pos.has(l.reaction) && !pos.has(l.cause));
    for (const l of lost) add("links.lost", "fail", `the reaction in moment ${l.reaction} is kept without its cause (moment ${l.cause})`, { cause: l.cause, reaction: l.reaction });
    if (!apart.length && !lost.length) passed.push("links");
  }
  // 4. Something in the first 3 s: the moment the edit opens with (the hook's, else the first kept) is said or happens.
  if (treatment) {
    const open = moments[(treatment.hook?.moment ?? treatment.order[0]) - 1];
    if (!open || (open.kind !== "speech" && open.kind !== "action")) add("hook.empty", "warn", `nothing said or happening in the first ${V.hookSec} s`, { sec: V.hookSec }); else passed.push("hook.empty");
  }
  return { checks, passed, ok: !checks.some((c) => c.level === "fail"), stats: { speechShare: Math.round(100 * speechShare) / 100, actionS: sec(actionUs), keptActionS: sec(keptActionUs), keptShare: Math.round(100 * keptShare) / 100, editS: sec(editUs), rawS: sec(D) } };
}

/**
 * What the output must still say, in EDIT time, from a v2 plan and the source words (per media, source µs):
 * lines: [{ text, editFromUs, editToUs, important }] (one per kept sentence-ish run of words inside a segment) and
 * joints: [{ editUs, before: word | null, after: word | null }] (the words on both sides of every joint).
 * important(word span) → bool marks lines that must survive (the punch / setup / reaction moments).
 */
export function expectedSpeech(plan, wordsByMedia, { important = () => false } = {}) {
  const lines = [], joints = [], words = [];
  let t = 0;
  for (const [k, sg] of (plan.segments || []).entries()) {
    const ws = (wordsByMedia[sg.mediaId] || []).filter((w) => (w.startUs + w.endUs) / 2 >= sg.fromUs && (w.startUs + w.endUs) / 2 < sg.toUs);
    const at = (src) => t + (src - sg.fromUs);
    // Runs of words with no pause ≥ 0.7 s are one line.
    let run = [];
    const flush = () => { if (run.length) lines.push({ text: run.map((w) => w.text).join(" "), editFromUs: at(run[0].startUs), editToUs: at(run[run.length - 1].endUs), important: !!important(sg.mediaId, run[0].startUs, run[run.length - 1].endUs), segment: k }); run = []; };
    for (const w of ws) { if (run.length && w.startUs - run[run.length - 1].endUs >= 700_000) flush(); run.push(w); }
    flush();
    ws.forEach((w, i) => words.push({ text: w.text, editUs: at(w.startUs), joint: (i === 0 && k > 0) || (i === ws.length - 1 && k < (plan.segments || []).length - 1) }));
    if (k) joints.push({ editUs: t, before: joints.pendingBefore ?? null, after: ws[0] ? { text: ws[0].text, editUs: at(ws[0].startUs) } : null, segment: k });
    joints.pendingBefore = ws.length ? { text: ws[ws.length - 1].text, editUs: at(ws[ws.length - 1].endUs) } : null;
    t += sg.toUs - sg.fromUs;
  }
  delete joints.pendingBefore;
  return { lines, joints, words, editUs: t };
}

/**
 * The output checks. input: { expected (expectedSpeech), outWords: [{ text, startUs, endUs }] (the export
 * re-transcribed, edit time), loudness: { i, tp } (LUFS, dBTP), black: [{ startS, endS }], frozen: [{ startS, endS }],
 * durationS, plannedS }. Returns { checks, passed, ok, stats: { lines, linesFound, important, importantFound,
 * agreement (the share of words the speech model hears again), joints, jointRecall } }.
 */
export function verifyOutput({ expected, outWords = [], loudness = null, black = [], frozen = [], durationS = null, plannedS = null }, V = VERIFY) {
  const checks = [], passed = [];
  const add = (id, level, message, args = {}) => checks.push({ id, level, message, args });
  const toks = outWords.map((w) => ({ t: alignToken(w.text), s: w.startUs, e: w.endUs })).filter((x) => x.t);
  // No transcript of the export (the speech model failed or heard nothing at all): the speech checks cannot run —
  // say so, never fail every line for it.
  const heard = toks.length > 0 || !expected.lines.some((l) => l.text.split(/\s+/).length >= 2);
  if (!heard) add("out.noTranscript", "warn", "the export could not be transcribed: lines and joints not checked", {});
  const near = (a, b) => toks.filter((x) => x.e >= a && x.s <= b).map((x) => x.t);
  // The speech model never hears a stretch the same way twice (short and mumbled words above all), so the checks are
  // measured against its own agreement on this file: the share of all expected words heard again near their place.
  const heardAt = (w) => { const t = alignToken(w.text); return near(w.editUs - V.joint.windowUs, w.editUs + V.joint.windowUs).some((g) => sameToken(g, t)); };
  const content = (expected.words || []).filter((w) => alignToken(w.text).length >= 3);
  const recallOf = (ws) => (ws.length ? ws.filter(heardAt).length / ws.length : null);
  const agreement = heard ? recallOf(content.filter((w) => !w.joint)) : null;
  const trusted = agreement !== null && agreement >= V.line.minAgreement;
  if (heard && !trusted && content.length >= 10) add("out.lowAgreement", "warn", `the speech model hears only ${Math.round(100 * (agreement ?? 0))} % of the words again (noisy sound): lines and joints not judged`, { pct: Math.round(100 * (agreement ?? 0)) });
  // 1. Every line still said: a line is heard when ≥ 60 % of its words come back near its place; an important line
  // (≥ 4 words) under a third of its words is lost — that fails.
  let found = 0, impFound = 0;
  const imp = expected.lines.filter((l) => l.important);
  for (const l of heard ? expected.lines : []) {
    const want = l.text.split(/\s+/).map(alignToken).filter(Boolean);
    if (want.length < 3) { found++; if (l.important) impFound++; continue; } // a short fragment: not a fair test
    const got = near(l.editFromUs - V.line.windowUs, l.editToUs + V.line.windowUs);
    const cov = (alignTokens(want, got)?.matches ?? 0) / want.length;
    if (cov >= V.line.coverage) { found++; if (l.important) impFound++; continue; }
    const lost = trusted && l.important && want.length >= 4 && cov < V.line.lost;
    add(lost ? "out.lineMissing" : "out.lineWeak", lost ? "fail" : "warn", `«${l.text.slice(0, 60)}» is not heard in the export around ${sec(l.editFromUs)} s (${Math.round(100 * cov)} % of its words)`, { text: l.text.slice(0, 60), at: sec(l.editFromUs), pct: Math.round(100 * cov) });
  }
  if (!checks.some((c) => c.id === "out.lineMissing")) passed.push("out.lineMissing");
  // 2. No word cut at a joint: the words on both sides of the joints come back about as often as the other words
  // (a cut inside a word loses or garbles it, so joints would fall well below the file's own agreement).
  const jointWords = content.filter((w) => w.joint);
  const jointRecall = heard ? recallOf(jointWords) : null;
  for (const w of jointWords.filter((x) => heard && !heardAt(x)).slice(0, 12)) add("out.jointWord", "warn", `the word «${w.text}» at a joint (${sec(w.editUs)} s) is not heard again`, { word: w.text, at: sec(w.editUs) });
  if (trusted && jointWords.length >= 6 && jointRecall < agreement - V.joint.margin) add("out.cutWords", "fail", `words at the joints come back ${Math.round(100 * jointRecall)} % of the time, the other words ${Math.round(100 * agreement)} %: words are probably cut`, { joint: Math.round(100 * jointRecall), other: Math.round(100 * agreement) });
  else passed.push("out.cutWords");
  // 3. Loudness (the platforms' −14 LUFS) and the true peak.
  if (loudness && Number.isFinite(loudness.i)) {
    if (Math.abs(loudness.i - V.loudness.target) > V.loudness.tol) add("out.loudness", "fail", `loudness ${loudness.i} LUFS (target ${V.loudness.target} ± ${V.loudness.tol})`, { i: loudness.i, target: V.loudness.target });
    else passed.push("out.loudness");
    if (Number.isFinite(loudness.tp) && loudness.tp > V.loudness.truePeakMax) add("out.truePeak", "warn", `true peak ${loudness.tp} dBTP (at most ${V.loudness.truePeakMax})`, { tp: loudness.tp });
  }
  // 4. Black frames and frozen / duplicated frames.
  const blacks = black.filter((b) => b.endS - b.startS >= V.black.minS && (durationS === null || b.startS < durationS - 0.3));
  for (const b of blacks) add("out.black", "fail", `black frames ${b.startS.toFixed(2)}–${b.endS.toFixed(2)} s`, { from: b.startS, to: b.endS });
  if (!blacks.length) passed.push("out.black");
  const frozenLong = frozen.filter((f) => f.endS - f.startS >= V.frozen.minS);
  for (const f of frozenLong) add("out.frozen", "warn", `the picture does not move ${f.startS.toFixed(1)}–${f.endS.toFixed(1)} s (frozen or duplicated frames)`, { from: f.startS, to: f.endS });
  if (!frozenLong.length) passed.push("out.frozen");
  if (durationS !== null && plannedS !== null && Math.abs(durationS - plannedS) > 0.5) add("out.length", "warn", `the export is ${durationS.toFixed(1)} s, the plan ${plannedS.toFixed(1)} s`, { got: durationS, planned: plannedS });
  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return { checks, passed, ok: !checks.some((c) => c.level === "fail"), stats: { lines: expected.lines.length, linesFound: found, important: imp.length, importantFound: impFound, agreement: r2(agreement), joints: jointWords.length, jointRecall: r2(jointRecall) } };
}

/** ffmpeg's blackdetect / freezedetect / ebur128 output → { black, frozen, loudness }. */
export function parseFfmpegChecks(stderr) {
  const black = [...String(stderr).matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ startS: Number(m[1]), endS: Number(m[2]) }));
  const frozen = [];
  let start = null;
  for (const m of String(stderr).matchAll(/lavfi\.freezedetect\.freeze_(start|end):\s*([\d.]+)/g)) {
    if (m[1] === "start") start = Number(m[2]); else if (start !== null) { frozen.push({ startS: start, endS: Number(m[2]) }); start = null; }
  }
  const sum = String(stderr).split("Summary:").pop();
  const i = /I:\s*(-?[\d.]+)\s*LUFS/.exec(sum), tp = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(sum);
  return { black, frozen, openFreezeS: start, loudness: i ? { i: Number(i[1]), tp: tp ? Number(tp[1]) : null } : null };
}

/**
 * The cut sheet: the chosen treatment and its alternatives, side by side — for the app (structured) and as a short
 * Arabic text. input: { chosen, items: [{ id, treatment, rubric, plan }], ranking, pairs, moments, links, planner,
 * verify (verifyPlan), output (verifyOutput, optional) }.
 */
export function cutSheet({ chosen, items, ranking, pairs = [], moments, links = [], planner = "rules", verify = null, output = null }) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const c = byId.get(chosen);
  const sec = (us) => (us / US).toFixed(1);
  const hookName = { result: "النتيجة الأول", question: "سؤال", reaction: "رد الفعل الأول", action: "من وسط الأحداث", none: "بدون" };
  const show = (n) => { const m = moments[n - 1]; return { n, at: Number(sec(m.s)), kind: m.kind, role: m.role, text: m.kind === "speech" ? m.text.slice(0, 80) : (m.summary || "").slice(0, 80) }; };
  const alt = ranking.map((r) => { const x = byId.get(r.id); return { id: r.id, title: x.treatment.title, source: x.treatment.source, hook: x.treatment.hook?.kind || "none", lengthS: x.rubric.facts.editSec, total: x.rubric.total, scores: x.rubric.scores, wins: r.wins, losses: r.losses, why: x.treatment.why, fixes: x.treatment.fixes || [] }; });
  const unsure = links.filter((l) => l.unsure).map((l) => ({ cause: l.cause, reaction: l.reaction, why: l.why }));
  const sheet = {
    planner, chosen: alt.find((a) => a.id === chosen), alternatives: alt.filter((a) => a.id !== chosen),
    order: c.treatment.order.map(show), hook: c.treatment.hook ? { ...show(c.treatment.hook.moment), kind: c.treatment.hook.kind } : null,
    unsureLinks: unsure, pairs, guards: verify, output,
  };
  const L = [];
  L.push(`المعالجة المختارة: «${sheet.chosen.title}» — ${sheet.chosen.lengthS} ث، الهوك: ${hookName[sheet.chosen.hook] || sheet.chosen.hook}، التقييم ${sheet.chosen.total} (فاز ${sheet.chosen.wins} وخسر ${sheet.chosen.losses})`);
  if (sheet.hook) L.push(`بتبدأ بـ: لحظة ${sheet.hook.n} (${sheet.hook.at} ث) ${sheet.hook.text ? `«${sheet.hook.text}»` : ""}`);
  L.push(`الترتيب: ${sheet.order.map((o) => o.n).join(" ← ")}`);
  for (const a of sheet.alternatives) L.push(`بديل: «${a.title}» — ${a.lengthS} ث، الهوك: ${hookName[a.hook] || a.hook}، التقييم ${a.total}`);
  if (unsure.length) L.push(`روابط «مش متأكد»: ${unsure.map((u) => `${u.cause} ← ${u.reaction}`).join("، ")}`);
  if (verify) for (const ch of verify.checks) L.push(`${ch.level === "fail" ? "✗" : "!"} ${ch.message}`);
  sheet.text = L;
  return sheet;
}
