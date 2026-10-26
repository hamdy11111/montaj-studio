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
  tooShort: { minShare: 0.25, minActionS: 30, speechShareMax: 0.6 },     // ≤ 25 % of the raw while ≥ 30 s of action happened
  hookSec: 3,
  line: { coverage: 0.6, lost: 0.34, windowUs: 4_000_000, minAgreement: 0.5 },
  joint: { windowUs: 700_000, margin: 0.3 },
  loudness: { target: -14, tol: 1.5, truePeakMax: -1 },
  black: { minS: 0.12 }, frozen: { minS: 2.0 },
  sound: { same: 0.75, different: 0.6 }, // envelope correlation of an export stretch with its source span
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
 * cuts, durationUs, treatment (optional), targetUs (a reel's length: no «too short») }. Returns { checks: [{ id, level, message, args }],
 * passed: [ids], stats: { speechShare, actionS, keptActionS, keptShare } }.
 */
export function verifyPlan({ moments = [], links = [], cuts = [], durationUs, treatment = null, targetUs = null }, V = VERIFY) {
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
  // 2. An edit far too short for what happened in it (a video carried by its action; never when a length was asked).
  if (!targetUs && D && editUs / D < V.tooShort.minShare && actionUs >= V.tooShort.minActionS * US && speechShare <= V.tooShort.speechShareMax)
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
  const lines = [], joints = [], words = [], sounds = [], segs = [];
  let t = 0;
  for (const [k, sg] of (plan.segments || []).entries()) {
    const ws = (wordsByMedia[sg.mediaId] || []).filter((w) => (w.startUs + w.endUs) / 2 >= sg.fromUs && (w.startUs + w.endUs) / 2 < sg.toUs);
    const at = (src) => t + (src - sg.fromUs);
    // Runs of words with no pause ≥ 0.7 s are one line.
    let run = [];
    const flush = () => { if (run.length) lines.push({ text: run.map((w) => w.text).join(" "), editFromUs: at(run[0].startUs), editToUs: at(run[run.length - 1].endUs), mediaId: sg.mediaId, srcFromUs: run[0].startUs, srcToUs: run[run.length - 1].endUs, segFromUs: t, segToUs: t + (sg.toUs - sg.fromUs), important: !!important(sg.mediaId, run[0].startUs, run[run.length - 1].endUs), segment: k, first: run[0] === ws[0], last: run[run.length - 1] === ws[ws.length - 1] }); run = []; };
    // The sounds the plan adds over this segment (their accent time; a library sound up to ~1.6 s, a bundled one ~1 s).
    for (const x of plan.sfx || []) if (x.mediaId === sg.mediaId && x.atUs >= sg.fromUs && x.atUs < sg.toUs && !sounds.some((y) => y.editUs === at(x.atUs))) sounds.push({ editUs: at(x.atUs), what: x.library?.title || x.sound });
    const lineOf = new Map();
    for (const w of ws) { if (run.length && w.startUs - run[run.length - 1].endUs >= 700_000) flush(); run.push(w); lineOf.set(w, lines.length); }
    flush();
    ws.forEach((w, i) => words.push({ text: w.text, editUs: at(w.startUs), editEndUs: at(w.endUs), segment: k, line: lineOf.get(w), joint: (i === 0 && k > 0) || (i === ws.length - 1 && k < (plan.segments || []).length - 1), first: i === 0, last: i === ws.length - 1 }));
    segs.push({ k, editFromUs: t, editToUs: t + (sg.toUs - sg.fromUs), mediaId: sg.mediaId, srcFromUs: sg.fromUs, srcToUs: sg.toUs });
    if (k) joints.push({ editUs: t, before: joints.pendingBefore ?? null, after: ws[0] ? { text: ws[0].text, editUs: at(ws[0].startUs) } : null, segment: k });
    joints.pendingBefore = ws.length ? { text: ws[ws.length - 1].text, editUs: at(ws[ws.length - 1].endUs) } : null;
    t += sg.toUs - sg.fromUs;
  }
  delete joints.pendingBefore;
  // A line next to a joint (the first or last words of a segment) or under an added sound is where the edit could
  // have broken it; a line inside one continuous segment with nothing on it can only be heard differently.
  const nSeg = (plan.segments || []).length;
  for (const l of lines) {
    l.atJoint = (l.first && l.segment > 0) || (l.last && l.segment < nSeg - 1);
    l.masked = sounds.filter((x) => x.editUs > l.editFromUs - 1_600_000 && x.editUs < l.editToUs + 300_000).map((x) => x.what);
  }
  return { lines, joints, words, sounds, segs, editUs: t };
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
    // Lost (a fail) only where the edit could have broken it: next to a joint or under a sound it added.
    const could = l.atJoint === undefined || l.atJoint || l.masked?.length;
    const lost = trusted && l.important && want.length >= 4 && cov < V.line.lost && could;
    const why = l.masked?.length ? ` — under the sound «${l.masked[0]}»` : l.atJoint ? " — next to a cut" : "";
    add(lost ? "out.lineMissing" : "out.lineWeak", lost ? "fail" : "warn", `«${l.text.slice(0, 60)}» is not heard in the export around ${sec(l.editFromUs)} s (${Math.round(100 * cov)} % of its words)${why}`, { text: l.text.slice(0, 60), at: sec(l.editFromUs), pct: Math.round(100 * cov), editFromUs: l.editFromUs, editToUs: l.editToUs, mediaId: l.mediaId, srcFromUs: l.srcFromUs, segFromUs: l.segFromUs, segToUs: l.segToUs, important: l.important });
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
  const blacks = black.filter((b) => b.endS - b.startS >= V.black.minS && (durationS === null || b.startS < durationS - 0.5)); // the last frames: the encoder's tail
  for (const b of blacks) add("out.black", "fail", `black frames ${b.startS.toFixed(2)}–${b.endS.toFixed(2)} s`, { from: b.startS, to: b.endS });
  if (!blacks.length) passed.push("out.black");
  const frozenLong = frozen.filter((f) => f.endS - f.startS >= V.frozen.minS);
  for (const f of frozenLong) add("out.frozen", "warn", `the picture does not move ${f.startS.toFixed(1)}–${f.endS.toFixed(1)} s (frozen or duplicated frames)`, { from: f.startS, to: f.endS });
  if (!frozenLong.length) passed.push("out.frozen");
  if (durationS !== null && plannedS !== null && Math.abs(durationS - plannedS) > 0.5) add("out.length", "warn", `the export is ${durationS.toFixed(1)} s, the plan ${plannedS.toFixed(1)} s`, { got: durationS, planned: plannedS });
  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return { checks, passed, ok: !checks.some((c) => c.level === "fail"), stats: { lines: expected.lines.length, linesFound: found, important: imp.length, importantFound: impFound, agreement: r2(agreement), joints: jointWords.length, jointRecall: r2(jointRecall) } };
}

// ------------------------------------------------------------------ the precise check: forced alignment
// The re-transcription above hears only ~70–77 % of a talking video's words again (a second NeMo pass hears mumbled and
// short words differently), so it can only catch gross losses: one clipped word at a joint stays inside its noise.
// Here the words the plan keeps are FORCE-ALIGNED onto the export's own sound (perception's wav2vec2 worker, align.py):
// every expected letter must be found, in order, inside its own segment. The export's audio is laid out with a short
// silence after every segment, so a word whose sound was cut at a joint cannot borrow the next segment's sound: its
// letters are dragged into the silence (the aligned word spills past its segment). A single word's letter probability is
// no test (a misheard word matches at 0 % in a perfect export); lines are judged by their words' median against the
// file's own (the inside words), never an absolute number — a noisy street and a studio both pass when nothing is lost.
export const ALIGN = {
  gapUs: 600_000,                  // silence put after every segment in the aligned audio
  pad: 0.3,                        // s of sound around each line the worker may use (stays inside the silence)
  spillUs: 90_000,                 // a word reaching this far into the silence after its segment lost sound at the cut
  lineRatio: 0.45, lineMin: 3,     // a line (≥ 3 aligned words) under 45 % of the median: not heard (masked or lost)
  minWords: 8,                     // fewer aligned inside words than this: no reference, nothing judged
};

// Egyptian speech says a word-final ه / ة as a vowel («التركيه» torkeyya, «عنده» 3ando), but the Arabic wav2vec2
// aligns the letter ه to breath and room noise: on a cut after such a word it drags the ه across the silence and the
// word looks cut. The final ه is left out of the text the aligner gets (never in the few words that say a real h).
// The same for the adverbs written with a final ا and said with -an («مثلا» masalan, «طبعا» tab3an): their ا is read as n.
const REAL_H = new Set(["الله", "والله", "بالله", "لله", "عليه", "فيه", "ليه", "وجه", "شبه", "اتجاه", "انتباه"]);
const TANWEEN = new Set(["مثلا", "طبعا", "جدا", "ابدا", "شكرا", "عفوا", "اصلا", "فعلا", "تماما", "حالا", "دايما", "دائما", "غالبا", "احيانا", "اولا", "ثانيا", "اخيرا", "حرفيا", "تقريبا", "فورا", "سريعا", "اكيدا", "عموما", "خصوصا", "نهائيا", "مبدئيا", "حاليا", "يوميا", "اساسا", "قريبا", "مؤخرا", "سابقا", "لاحقا", "اهلا", "سهلا"]);
export function alignText(text) {
  const t = String(text || "").replace(/[ً-ْـٰ]/g, "");
  if (TANWEEN.has(t)) return `${t.slice(0, -1)}ن`;
  return t.length >= 4 && /[هة]$/.test(t) && !REAL_H.has(t) ? t.slice(0, -1) : t;
}

/**
 * Where each segment's sound goes in the aligned audio and the job for align.py. expected: expectedSpeech's result.
 * Returns { pieces: [{ k, editFromUs, editToUs, wavFromUs }], totalUs, asr: { segments: [{ start, end, words: [{ start,
 * end, word }] }] } (seconds of the aligned audio, one per line), index: [expected word index, in the order the worker
 * returns them] }.
 */
export function alignLayout(expected, A = ALIGN) {
  const segs = expected.segs || [];
  const pieces = segs.map((s, i) => ({ k: s.k, editFromUs: s.editFromUs, editToUs: s.editToUs, wavFromUs: s.editFromUs + i * A.gapUs }));
  const wav = (k, us) => us + k * A.gapUs;
  const groups = new Map();
  (expected.words || []).forEach((w, i) => { const key = `${w.segment}:${w.line}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i); });
  const segments = [], index = [];
  for (const ids of groups.values()) {
    const ws = ids.map((i) => expected.words[i]);
    const k = ws[0].segment;
    segments.push({ start: wav(k, ws[0].editUs) / US, end: wav(k, ws[ws.length - 1].editEndUs ?? ws[ws.length - 1].editUs) / US, words: ws.map((w) => ({ start: wav(k, w.editUs) / US, end: wav(k, w.editEndUs ?? w.editUs) / US, word: alignText(w.text) })) });
    index.push(...ids);
  }
  const last = pieces[pieces.length - 1];
  return { pieces, totalUs: last ? last.wavFromUs + (last.editToUs - last.editFromUs) + A.gapUs : 0, asr: { segments }, index };
}

/** The aligned audio: each piece of the export's PCM (`rate` Hz mono Int16Array, edit time) at its place, silence between. */
export function layoutAudio(pcm, rate, layout) {
  const at = (us) => Math.round((us * rate) / US);
  const out = new Int16Array(at(layout.totalUs));
  for (const p of layout.pieces) {
    const a = at(p.editFromUs), b = Math.min(pcm.length, at(p.editToUs)), o = at(p.wavFromUs);
    if (b > a && o < out.length) out.set(pcm.subarray(a, Math.min(b, a + out.length - o)), o);
  }
  return out;
}

/** A mono 16-bit WAV file's bytes (for the worker, which reads files). */
export function wavBytes(pcm, rate) {
  const h = Buffer.alloc(44), n = pcm.length * 2;
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, n)]);
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * The output's speech checks by forced alignment. aligned: align.py's `words` (same order as layout.index). Every word:
 * its letter probability (`align_conf`) and where its letters landed. Fails: a word at a joint whose sound is cut
 * («out.clippedWord»: its letters spill into the silence around its segment), an important line that is not there
 * («out.lineMissing»). Returns { checks, passed, ok, stats: { median, words, aligned,
 * jointWords, clipped, lines, linesFound, important, importantFound }, words: [per expected word { text, editUs, conf,
 * spillUs, joint }], judged } — the speech part of verifyOutput, so the two can stand in for each other.
 */
export function verifyAligned({ expected, layout, aligned }, A = ALIGN) {
  const checks = [], passed = [];
  const add = (id, level, message, args = {}) => checks.push({ id, level, message, args });
  const segOf = new Map((layout.pieces || []).map((p) => [p.k, p]));
  const per = expected.words.map((w) => ({ text: w.text, editUs: w.editUs, segment: w.segment, line: w.line, joint: w.joint, first: w.first, last: w.last, conf: null, spillUs: 0 }));
  layout.index.forEach((i, j) => {
    const r = aligned[j], p = segOf.get(per[i].segment);
    if (!r || r.align_conf === null || r.align_conf === undefined || !p) return;
    const off = p.wavFromUs - p.editFromUs, s = Math.round(r.start * US) - off, e = Math.round(r.end * US) - off;
    per[i].conf = r.align_conf; per[i].fromUs = s; per[i].toUs = e;
    // Letters outside the segment's own sound: after its end (a word cut at the joint after it) or before its start;
    // and how much sound is left between the word and its cut (the director keeps a margin around every kept word).
    per[i].spillUs = Math.max(0, e - p.editToUs, p.editFromUs - s);
    per[i].edgeUs = per[i].last && !per[i].first ? p.editToUs - e : per[i].first && !per[i].last ? s - p.editFromUs : Math.min(p.editToUs - e, s - p.editFromUs);
  });
  const content = per.filter((w) => w.conf !== null && alignToken(w.text).length >= 3);
  const inside = content.filter((w) => !w.joint);
  const med = median(inside.map((w) => w.conf));
  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
  if (med === null || inside.length < A.minWords) {
    if (content.length) add("out.alignFew", "warn", `too few words to align (${inside.length}): lines and joints not judged`, { n: inside.length });
    return { checks, passed, ok: true, stats: { median: r2(med), words: per.length, aligned: content.length }, words: per, judged: false };
  }
  // 1. Words cut at a joint: their letters dragged past the cut into the silence.
  const jointWords = per.filter((w) => w.joint && w.conf !== null && alignToken(w.text).length >= 2);
  const clipped = jointWords.filter((w) => w.spillUs >= A.spillUs);
  for (const w of clipped) add("out.clippedWord", "fail", `the word «${w.text}» at a joint (${sec(w.editUs)} s) is cut: its letters run ${Math.round(w.spillUs / 1000)} ms past the cut`, { word: w.text, at: sec(w.editUs), conf: r2(w.conf), spillMs: Math.round(w.spillUs / 1000), median: r2(med), side: w.last && !w.first ? "end" : w.first && !w.last ? "start" : "both" });
  if (!clipped.length) passed.push("out.clippedWord");
  // 2. Every line still there: its words' median letter probability against the file's.
  let found = 0, impFound = 0;
  const imp = expected.lines.filter((l) => l.important);
  expected.lines.forEach((l, li) => {
    const ws = per.filter((w) => w.line === li && w.conf !== null);
    if (ws.length < A.lineMin) { found++; if (l.important) impFound++; return; } // a short fragment: not a fair test
    const m = median(ws.map((w) => w.conf));
    if (m >= med * A.lineRatio) { found++; if (l.important) impFound++; return; }
    const why = l.masked?.length ? ` — under the sound «${l.masked[0]}»` : l.atJoint ? " — next to a cut" : "";
    add(l.important ? "out.lineMissing" : "out.lineWeak", l.important ? "fail" : "warn", `«${l.text.slice(0, 60)}» is not there in the export around ${sec(l.editFromUs)} s (its letters match at ${Math.round(100 * m)} %, the file ${Math.round(100 * med)} %)${why}`, { text: l.text.slice(0, 60), at: sec(l.editFromUs), conf: r2(m), median: r2(med), important: l.important, editFromUs: l.editFromUs, editToUs: l.editToUs, mediaId: l.mediaId, srcFromUs: l.srcFromUs, segFromUs: l.segFromUs, segToUs: l.segToUs });
  });
  if (!checks.some((c) => c.id === "out.lineMissing")) passed.push("out.lineMissing");
  return { checks, passed, ok: !checks.some((c) => c.level === "fail"), stats: { median: r2(med), words: per.length, aligned: content.length, jointWords: jointWords.length, clipped: clipped.length, lines: expected.lines.length, linesFound: found, important: imp.length, importantFound: impFound }, words: per, judged: true };
}

const SPEECH_IDS = new Set(["out.noTranscript", "out.lowAgreement", "out.lineMissing", "out.lineWeak", "out.lineHeardDifferently", "out.jointWord", "out.cutWords"]);
/**
 * verifyOutput's result with its speech part (re-transcription) replaced by verifyAligned's (forced alignment), when
 * the alignment could judge the file. The transcription's numbers stay in stats.transcript for comparison.
 */
export function withAlignment(out, al) {
  if (!al?.judged) return { ...out, stats: { ...out.stats, method: "transcribe", align: al?.stats || null } };
  const checks = [...out.checks.filter((c) => !SPEECH_IDS.has(c.id)), ...al.checks];
  const passed = [...out.passed.filter((id) => !SPEECH_IDS.has(id)), ...al.passed];
  const { lines, linesFound, important, importantFound, agreement, joints, jointRecall } = out.stats;
  return { ...out, checks, passed, ok: !checks.some((c) => c.level === "fail"), stats: { method: "align", lines: al.stats.lines, linesFound: al.stats.linesFound, important: al.stats.important, importantFound: al.stats.importantFound, median: al.stats.median, aligned: al.stats.aligned, jointWords: al.stats.jointWords, clipped: al.stats.clipped, transcript: { lines, linesFound, important, importantFound, agreement, joints, jointRecall } } };
}

/** The loudness envelope of mono 16-bit PCM (an Int16Array): one RMS value per `winMs`. */
export function envelope(pcm, rate = 8000, winMs = 10) {
  const n = Math.max(1, Math.round((rate * winMs) / 1000)), out = new Float64Array(Math.floor(pcm.length / n));
  for (let k = 0; k < out.length; k++) { let s = 0; for (let j = k * n; j < (k + 1) * n; j++) s += pcm[j] * pcm[j]; out[k] = Math.sqrt(s / n); }
  return out;
}

/** The best Pearson correlation of two envelopes within ±maxLag windows: { r, lag } (r 1 = the same sound). */
export function bestCorrelation(a, b, maxLag = 30) {
  let best = { r: -1, lag: 0 };
  for (let L = -maxLag; L <= maxLag; L++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < a.length; i++) { const j = i + L; if (j < 0 || j >= b.length) continue; const x = a[i], y = b[j]; n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
    const d = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    const r = d > 0 ? (n * sxy - sx * sy) / d : 0;
    if (r > best.r) best = { r, lag: L };
  }
  return { r: Math.round(best.r * 1000) / 1000, lag: best.lag };
}

/**
 * The stretch of an export to compare with the source for a line (args of its check): the line ± 0.1 s, never past
 * its own segment (beyond the joint the export shows other footage). { editFromUs, srcFromUs, durUs }.
 */
export function soundWindow(a) {
  const from = Math.max(a.segFromUs ?? -Infinity, a.editFromUs - 100_000), to = Math.min(a.segToUs ?? Infinity, a.editToUs + 100_000);
  return { editFromUs: from, srcFromUs: a.srcFromUs + (from - a.editFromUs), durUs: Math.max(300_000, to - from) };
}

/**
 * A line the speech model did not hear again, settled by its sound: the export's stretch against its source span.
 * check: the out.lineMissing / out.lineWeak check; r: their envelope correlation. The same sound (r ≥ 0.75) means the
 * words are there (the model heard them differently: a warning); a different sound (r < 0.6) means masked, cut or
 * silent — an important line then fails, an ordinary one stays a warning with its r.
 */
export function settleLine(check, r, V = VERIFY) {
  if (r >= V.sound.same) return { ...check, id: "out.lineHeardDifferently", level: "warn", message: `${check.message} — but its sound matches the source (r = ${r}): the speech model heard it differently`, args: { ...check.args, r } };
  // Only an important line fails (the clean-up changes the sound's shape where it removes heavy noise — wind, a
  // crowd: r 0.5–0.7 there — so a different sound alone is a warning for an ordinary line).
  if (r < V.sound.different) return { ...check, id: check.args?.important ? "out.lineMissing" : "out.lineWeak", level: check.args?.important ? "fail" : "warn", message: `${check.message} — and its sound differs from the source (r = ${r})`, args: { ...check.args, r } };
  return { ...check, args: { ...check.args, r } };
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
  const alt = ranking.map((r) => { const x = byId.get(r.id); return { id: r.id, title: x.treatment.title, source: x.treatment.source, hook: x.treatment.hook?.kind || "none", lengthS: x.rubric.facts.editSec, total: x.rubric.total, scores: x.rubric.scores, wins: r.wins, losses: r.losses, why: x.treatment.whyAr || x.treatment.why, fixes: x.treatment.fixes || [] }; });
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
