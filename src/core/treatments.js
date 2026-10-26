// The director's pipeline, part 1 (PLAN_editor_and_graphics.md, item 9 steps 3–5): the raw video as numbered MOMENTS,
// and TREATMENTS that point only to moment numbers — never free timestamps, so no treatment can invent a time that
// is not in the footage.
//  · moments tile the (virtual) time axis: every sentence said is one; the wordless stretches between them are cut
//    into action / still moments from perception's event timeline (shot log energy, laughter, applause, screams,
//    loudness and pitch spikes) — the 02 challenge (a game with little speech) is mostly action moments;
//  · links: a cause and its reaction (phase 6 when merged: `montaj.links/1`; until then derived here: every reaction
//    → the moment just before it, all marked unsure) and roles (setup · build · punch · reaction · filler);
//  · best take (phase 5 when merged: `montaj.takes/1` or a score function) through `takeScorer`;
//  · treatments: 3–5 different edits — the hook (the result first, a question, the reaction first, or straight into
//    the action), the structure and the length — as { hook: { kind, moment }, order: [moment numbers] };
//  · the executor's spec: what a treatment means for the deterministic executor (core/director.js): words to drop,
//    wordless spans to cut or protect, the edit order and the hook span.
// Pure; times in µs on the director's virtual axis (the clips one after another), perception's seconds mapped onto it.
import { sentences, alignToken, alignTokens } from "./speech.js";
import { detectMoments, isPunch, isReaction } from "./moments.js";
import { storyRole, ROLE_VALUE } from "./reel.js";
import { directorView } from "./causeLinks.js";
import { US } from "./util.js";

const S = (s) => Math.round(s * US);
const WORD_TAIL = 120_000, WORD_HEAD = 80_000; // what a kept word keeps around it when the treatment cuts next to it
const r2 = (x) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ perception events on the virtual axis
/** AudioSet tags that are a reaction of the people in the video (not chatter or music). */
const REACTION_TAG = [["applause", /applause|clapping|cheer|crowd|whoop|hubbub/i], ["scream", /scream|shout|yell|children shouting|battle cry/i], ["gasp", /gasp/i], ["laughter", /laugh|giggle|chuckle|snicker/i]];
export const REACTION_TYPES = ["laughter", "applause", "scream", "gasp", "loudness", "pitch"];

/** The reaction an event is ({ type, conf }) or null. Loudness/pitch spikes count only when clear (≥ 0.6). */
export function reactionOf(e) {
  if (e.type === "laughter") return { type: "laughter", conf: e.confidence ?? 0.7 };
  if (e.type === "audio_tag") { const hit = REACTION_TAG.find(([, re]) => re.test(e.text || "")); return hit && (e.confidence ?? 0) >= 0.2 ? { type: hit[0], conf: e.confidence } : null; }
  if (e.type === "loudness_spike" && (e.confidence ?? 0) >= 0.6) return { type: "loudness", conf: e.confidence };
  if (e.type === "pitch_spike" && (e.confidence ?? 0) >= 0.6) return { type: "pitch", conf: e.confidence };
  return null;
}

/**
 * Perception's events (seconds of media time, per file) on the virtual axis (µs): every event of a file is laid on
 * each clip of that file it falls in. timelines: Map | object mediaId → timeline ({ events }); clips: [{ mediaId,
 * srcStart, srcEnd, vStart, speed }] (µs). Returns [{ t0, t1, type, confidence, speaker, entity, text, extra, mediaId }].
 */
export function eventsOnAxis(timelines, clips) {
  const get = (id) => (timelines instanceof Map ? timelines.get(id) : timelines?.[id]);
  const out = [];
  for (const c of clips) {
    const tl = get(c.mediaId);
    if (!tl?.events?.length) continue;
    const sp = c.speed || 1, a = c.srcStart || 0, b = c.srcEnd ?? Infinity;
    for (const e of tl.events) {
      const s = S(e.t0), f = S(e.t1 ?? e.t0);
      if (f < a || s > b) continue;
      out.push({ ...e, mediaId: c.mediaId, t0: Math.round(c.vStart + (Math.max(s, a) - a) / sp), t1: Math.round(c.vStart + (Math.min(f, b) - a) / sp) });
    }
  }
  return out.sort((x, y) => x.t0 - y.t0);
}

/**
 * A media time (seconds) on the virtual axis (µs) through the clip that holds it — a file cut into several clips
 * (or pieces shot out of order) maps each time through its own piece; a time no clip shows → null.
 * clips: [{ mediaId, srcStart, srcEnd, vStart, speed }] (µs).
 */
export function mediaToAxis(clips) {
  return (mediaId, sec) => {
    const t = S(sec);
    const c = clips.find((k) => k.mediaId === mediaId && t >= (k.srcStart || 0) && t < (k.srcEnd ?? Infinity)) || clips.find((k) => k.mediaId === mediaId && t === k.srcEnd);
    return c ? Math.round(c.vStart + (t - (c.srcStart || 0)) / (c.speed || 1)) : null;
  };
}

/**
 * A media span (seconds) on the virtual axis (µs): the part of it inside the clip that shows most of it (a span that
 * runs across two pieces placed apart keeps its larger piece); null when no clip shows it. → { t0, t1 } (µs).
 */
export function mediaSpanToAxis(clips) {
  return (mediaId, t0, t1 = t0) => {
    const a = S(t0), b = S(Math.max(t0, t1));
    let best = null, bo = -1;
    for (const c of clips) {
      if (c.mediaId !== mediaId) continue;
      const x = Math.max(a, c.srcStart || 0), y = Math.min(b, c.srcEnd ?? Infinity);
      if (y >= x && y - x > bo) { bo = y - x; best = { c, x, y }; }
    }
    if (!best) return null;
    const v = (t) => Math.round(best.c.vStart + (t - (best.c.srcStart || 0)) / (best.c.speed || 1));
    return { t0: v(best.x), t1: v(best.y) };
  };
}

// ------------------------------------------------------------------ moments
const MOOD_OF_EMOTION = { happy: "joy", sad: "sad", angry: "tense", fearful: "tense", surprised: "shock", disgusted: "tense" };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * The video as numbered moments that tile [fromUs, durationUs). input: { words: [{ text, startUs, endUs }] (virtual axis),
 * events (eventsOnAxis), durationUs, protect: [[a, b]] (spans that must stay: clips without speech), beats: [[a, b]]
 * (wordless moments the person track found), keywords }. Options: minGapUs (a wordless stretch shorter than this
 * belongs to the moment before it), chunkUs (the longest wordless moment), peak window around a reaction.
 * Returns [{ n, kind: speech|action|still|gap, s, e, w0?, w1?, text, energy, reactions, role, strength, mood, lex,
 * story, question }] — `gap` = a wordless stretch with nothing known about it (no perception).
 */
export function buildMoments({ words = [], events = [], durationUs, protect = [], beats = [], keywords = [], fromUs = 0 }, { minGapUs = 1_200_000, chunkUs = 6_000_000, before = 3_500_000, after = 1_500_000 } = {}) {
  const D = durationUs ?? (words.length ? words[words.length - 1].endUs : 0);
  const perceived = events.length > 0;
  const logs = events.filter((e) => e.type === "shot_log");
  const reactions = events.map((e) => ({ e, r: reactionOf(e) })).filter((x) => x.r).map(({ e, r }) => ({ t: e.t0, t1: e.t1, type: r.type, conf: Math.round((r.conf ?? 0.5) * 100) / 100 }));
  // 1. Speech: sentences (a one- or two-word sentence right after another joins it).
  const sents = [];
  for (const sn of sentences(words)) {
    const prev = sents[sents.length - 1];
    const short = sn.w1 - sn.w0 < 2 || sn.endUs - sn.startUs < 800_000;
    if (prev && short && sn.startUs - prev.e < 500_000) { prev.w1 = sn.w1; prev.e = sn.endUs; continue; }
    sents.push({ w0: sn.w0, w1: sn.w1, s: sn.startUs, e: sn.endUs });
  }
  // 2. Spans: speech moments and the wordless stretches between them (a short stretch goes with the moment before).
  const spans = [];
  let t = fromUs;
  const wordless = (a, b) => {
    if (b - a <= 0) return;
    if (b - a < minGapUs) { if (spans.length) spans[spans.length - 1].e = b; return; } // (before the first sentence: it opens that one)
    // Reactions inside: each group (reactions < 2.5 s apart) is one moment with its lead-in (the cause) and its tail.
    const rs = reactions.filter((x) => x.t >= a && x.t < b && x.type !== "pitch");
    const groups = [];
    for (const x of rs) { const g = groups[groups.length - 1]; if (g && x.t - g.t1 < 2_500_000) g.t1 = Math.max(g.t1, x.t1); else groups.push({ t0: x.t, t1: x.t1 }); }
    const peaks = [];
    for (const g of groups) {
      const p0 = Math.max(a, g.t0 - before), p1 = Math.min(b, g.t1 + after);
      const last = peaks[peaks.length - 1];
      if (last && p0 <= last[1]) last[1] = Math.max(last[1], p1); else peaks.push([p0, p1]);
    }
    // The rest: even pieces of at most chunkUs (a piece shorter than minGapUs joins its neighbour).
    const pieces = [];
    let c = a;
    for (const [p0, p1] of [...peaks, [b, b]]) {
      if (p0 - c > 0) {
        const n = Math.max(1, Math.ceil((p0 - c) / chunkUs)), len = (p0 - c) / n;
        for (let k = 0; k < n; k++) pieces.push({ s: Math.round(c + k * len), e: Math.round(c + (k + 1) * len), peak: false });
      }
      if (p1 > p0) pieces.push({ s: p0, e: p1, peak: true });
      c = Math.max(c, p1);
    }
    for (const p of pieces) {
      const last = spans[spans.length - 1];
      if (p.e - p.s < minGapUs && last) { last.e = p.e; continue; }
      spans.push({ kind: "wordless", s: p.s, e: p.e, peak: p.peak });
    }
  };
  for (const sn of sents) {
    const s = Math.max(t, sn.s - 100_000);
    wordless(t, s);
    if (spans.length && s > spans[spans.length - 1].e) spans[spans.length - 1].e = s;
    spans.push({ kind: "speech", s: spans.length ? spans[spans.length - 1].e : fromUs, e: sn.e, w0: sn.w0, w1: sn.w1 });
    t = sn.e;
  }
  wordless(t, D);
  if (spans.length) { spans[0].s = fromUs; spans[spans.length - 1].e = Math.max(spans[spans.length - 1].e, D); }
  for (let i = 1; i < spans.length; i++) spans[i].s = spans[i - 1].e; // a tiling: no holes, no overlaps
  // 3. What each moment is.
  const lex = detectMoments(words, { keywords });
  const emotions = events.filter((e) => e.type === "emotion");
  const out = spans.filter((x) => x.e - x.s > 0).map((x, i) => {
    const logHere = logs.map((l) => ({ l, o: overlap(x.s, x.e, l.t0, l.t1) })).filter((y) => y.o > 0).sort((p, q) => q.o - p.o);
    const energy = logHere.length ? Math.max(...logHere.map((y) => y.l.extra?.energy || 0)) || null : null;
    const reacts = reactions.filter((r) => r.t >= x.s && r.t < x.e);
    const ws = x.kind === "speech" ? words.slice(x.w0, x.w1 + 1) : [];
    const text = ws.map((w) => w.text).join(" ");
    const lx = lex.filter((m) => m.s >= x.s && m.s < x.e);
    const inBeat = beats.some(([a, b]) => overlap(a, b, x.s, x.e) > 0) || protect.some(([a, b]) => overlap(a, b, x.s, x.e) > 0);
    const kind = x.kind === "speech" ? "speech" : !perceived ? (inBeat ? "action" : "gap") : (energy ?? 0) >= 3 || reacts.some((r) => r.type !== "pitch") || inBeat ? "action" : "still";
    const summary = logHere[0]?.l.extra?.summary_ar || logHere[0]?.l.extra?.action || logHere[0]?.l.text || "";
    const emo = emotions.filter((e) => overlap(x.s, x.e, e.t0, e.t1) > 0).map((e) => MOOD_OF_EMOTION[String(e.text || e.extra?.label || "").toLowerCase()]).find(Boolean);
    const mood = lx.some((m) => m.type === "laugh") || reacts.some((r) => r.type === "laughter") ? "comic" : emo || "neutral";
    return {
      n: i + 1, kind, s: x.s, e: x.e, ...(x.kind === "speech" ? { w0: x.w0, w1: x.w1 } : {}),
      text: kind === "speech" ? text : "", summary: kind === "speech" ? "" : String(summary).slice(0, 160),
      energy, reactions: reacts, lex: lx.map((m) => ({ type: m.type, s: m.s, score: m.score })), mood,
      story: kind === "speech" ? storyRole(text) : null, question: /[?؟]/.test(text) || lx.some((m) => m.type === "question" && m.score >= 1),
      peak: !!x.peak, protected: protect.some(([a, b]) => overlap(a, b, x.s, x.e) > 0.5 * (x.e - x.s)),
    };
  });
  for (const m of out) m.role = defaultRole(m);
  return out;
}

/**
 * The moments of several clips (phase 8: the story order moves clips apart, so a sentence or a wordless stretch never
 * runs across a clip joint): built clip by clip, numbered once, each with `clip` (its piece's index). joints: the
 * virtual times where one clip ends and the next begins. Word indices (w0, w1) stay indices of input.words.
 */
export function clipMoments(input, joints = [], opts = {}) {
  const words = input.words || [];
  const D = input.durationUs ?? (words.length ? words[words.length - 1].endUs : 0);
  const edges = [0, ...[...new Set(joints)].filter((j) => j > 0 && j < D).sort((a, b) => a - b), D];
  const out = [];
  for (let k = 1; k < edges.length; k++) {
    const a = edges[k - 1], b = edges[k];
    if (b - a <= 0) continue;
    const idx = [];
    words.forEach((w, i) => { const mid = (w.startUs + w.endUs) / 2; if (mid >= a && mid < b) idx.push(i); });
    const i0 = idx.length ? idx[0] : 0;
    const slice = idx.map((i) => ({ ...words[i], startUs: Math.max(a, words[i].startUs), endUs: Math.min(b, words[i].endUs) }));
    const inside = ([x, y]) => y > a && x < b;
    const ms = buildMoments({ ...input, words: slice, events: (input.events || []).filter((e) => (e.t1 ?? e.t0) >= a && e.t0 < b), durationUs: b, fromUs: a, protect: (input.protect || []).filter(inside), beats: (input.beats || []).filter(inside) }, opts);
    for (const m of ms) { if (m.w0 !== undefined) { m.w0 += i0; m.w1 += i0; } m.clip = k - 1; out.push(m); }
  }
  out.forEach((m, i) => { m.n = i + 1; });
  return out;
}

/**
 * Phase 6's document (`montaj.links/1`: links by id, roles on its own moments, promises among its causes) in the
 * adapter's shape ({ links: [{ cause: { t0, t1, text }, reaction: { t0, t1, type }, direction, confidence, unsure,
 * why }], roles, promises }, seconds of media time) through its `directorView`; anything else is returned as it is.
 */
export function phase6Shape(doc) {
  if (!doc || doc.schema !== "montaj.links/1" || !Array.isArray(doc.reactions)) return doc;
  const v = directorView(doc);
  const why = new Map((doc.links || []).map((l) => [l.id, l.checks?.semantic?.reason || ""]));
  const links = v.links.map((l) => ({ cause: { t0: l.cause.t0, t1: l.cause.t1, text: l.cause.text || "" }, reaction: { t0: l.reaction.t0, t1: l.reaction.t1, type: l.reaction.kind }, direction: l.direction, gapS: l.gap, confidence: l.confidence, unsure: l.status !== "sure" || l.reaction.real === false, why: why.get(l.id) || l.reaction.kind }));
  const roles = v.moments.filter((m) => m.role).map((m) => ({ t0: m.t0, t1: m.t1, role: m.role === "build_up" ? "build" : m.role, confidence: m.roleConfidence }));
  const promises = (doc.causes || []).filter((c) => c.kind === "promise").map((c) => {
    const pay = v.links.filter((l) => l.cause.id === c.id && l.direction !== "before").sort((p, q) => q.confidence - p.confidence)[0];
    return { t0: c.t0, t1: c.t1, text: c.text || "", ...(pay ? { payoff: { t0: pay.reaction.t0, t1: pay.reaction.t1 } } : {}) };
  });
  return { links, roles, promises };
}

/** Role of a moment from its own signals (phase 6 replaces it): setup · build · punch · reaction · filler. */
export function defaultRole(m) {
  const big = m.reactions.filter((r) => r.type !== "pitch" && r.type !== "loudness");
  if (big.length && (m.kind !== "speech" || m.lex.some((x) => isReaction(x)))) return "reaction";
  if (m.lex.some((x) => isPunch(x) && x.score >= 1.8) || m.story === "result") return "punch";
  if (m.kind === "speech" && (m.story === "stakes" || m.story === "setup")) return "setup";
  if (m.kind === "still" || m.kind === "gap") return m.energy && m.energy >= 3 ? "build" : "filler";
  if (m.kind === "speech" && m.story === "bridge" && m.e - m.s < 1_500_000 && !m.lex.length) return "filler";
  if (m.kind === "action" && big.length) return "reaction";
  return "build";
}

/** How much a moment carries the video (higher = more worth keeping / showing first). */
export function strengthOf(m) {
  let s = m.kind === "speech" ? 1 + 0.6 * (ROLE_VALUE[m.story] ?? 1) + 0.5 * Math.max(0, ...m.lex.map((x) => x.score)) : m.kind === "action" ? 0.6 + 0.35 * (m.energy ?? 3) : m.kind === "still" ? 0.2 + 0.1 * (m.energy ?? 1) : 0.1;
  s += Math.min(3, m.reactions.filter((r) => r.type !== "pitch").reduce((n, r) => n + (r.type === "loudness" ? 0.5 : 1.2) * (r.conf ?? 0.5), 0));
  s += { punch: 1.0, reaction: 0.8, setup: 0.3, build: 0, filler: -1.0 }[m.role] ?? 0;
  return r2(s);
}

// ------------------------------------------------------------------ phase 5 / phase 6 adapters
/** The moment a span [t0, t1] (µs) belongs to: the one it overlaps most (or the one around its centre). */
export function momentAt(moments, t0, t1 = t0) {
  let best = null, bo = -1;
  for (const m of moments) { const o = overlap(t0, Math.max(t1, t0 + 1), m.s, m.e); if (o > bo) { bo = o; best = m; } }
  if (bo > 0) return best;
  const c = (t0 + t1) / 2;
  return moments.find((m) => c >= m.s && c < m.e) || null;
}

/**
 * Links (cause → reaction) between moments. With phase 6 (`montaj.links/1`, seconds of MEDIA time — pass `toAxis` to
 * map a media time to the virtual axis), its links and roles; without it, derived: a reaction at the very start of
 * its moment (< 2 s in) is caused by the moment before it (confidence 0.4, unsure) — a reaction later in its own
 * moment has its cause inside it already. Returns { links: [{ cause, reaction, direction, confidence, unsure, source,
 * why }] (moment numbers), roles: Map(n → role) (phase 6 roles only), promises }.
 */
export function linkMoments(moments, phase6 = null, { toAxis = (sec) => S(sec) } = {}) {
  const links = [], roles = new Map(), promises = [];
  if (phase6 && (phase6.links || phase6.roles)) {
    for (const l of phase6.links || []) {
      if (!l?.cause || !l?.reaction) continue;
      const c = momentAt(moments, toAxis(l.cause.t0), toAxis(l.cause.t1 ?? l.cause.t0)), r = momentAt(moments, toAxis(l.reaction.t0), toAxis(l.reaction.t1 ?? l.reaction.t0));
      if (!c || !r) continue;
      links.push({ cause: c.n, reaction: r.n, direction: l.direction === "before" ? "before" : "after", confidence: Math.max(0, Math.min(1, Number(l.confidence ?? 0.5))), unsure: !!l.unsure, source: "links", why: String(l.why || l.reaction.type || "").slice(0, 120) });
    }
    const ROLES = new Set(["setup", "build", "punch", "reaction", "filler"]);
    for (const x of phase6.roles || []) { const m = ROLES.has(x?.role) ? momentAt(moments, toAxis(x.t0), toAxis(x.t1 ?? x.t0)) : null; if (m) roles.set(m.n, x.role); }
    for (const p of phase6.promises || []) {
      const m = momentAt(moments, toAxis(p.t0), toAxis(p.t1 ?? p.t0)), pay = p.payoff ? momentAt(moments, toAxis(p.payoff.t0), toAxis(p.payoff.t1 ?? p.payoff.t0)) : null;
      if (m) promises.push({ promise: m.n, payoff: pay?.n ?? null, text: String(p.text || "").slice(0, 120) });
    }
    return { links: dedupeLinks(links), roles, promises };
  }
  for (const m of moments) {
    const r = m.reactions.find((x) => BIG.has(x.type)); // a loudness or pitch spike alone is too weak to link
    if (!r) continue;
    const prev = moments[m.n - 2];
    if (prev && r.t - m.s < 2_000_000 && prev.kind !== "still" && prev.kind !== "gap" && prev.clip === m.clip) links.push({ cause: prev.n, reaction: m.n, direction: "after", confidence: 0.4, unsure: true, source: "rules", why: r.type });
  }
  return { links: dedupeLinks(links), roles, promises };
}
const BIG = new Set(["laughter", "applause", "scream", "gasp"]);
const dedupeLinks = (ls) => [...new Map(ls.filter((l) => l.cause !== l.reaction || l.source === "links").map((l) => [`${l.cause}>${l.reaction}`, l])).values()];

/**
 * Moments with their links and final roles and strengths — the one call the director makes. Roles from phase 6 win
 * over the rules; a moment that causes a reaction is at least a punch.
 */
export function momentsWithLinks(input, phase6 = null, opts = {}) {
  const moments = input.joints?.length ? clipMoments(input, input.joints, opts) : buildMoments(input, opts);
  const { links, roles, promises } = linkMoments(moments, phase6Shape(phase6), opts);
  for (const m of moments) {
    if (roles.has(m.n)) { m.role = roles.get(m.n); m.roleSource = "links"; } else m.roleSource = "rules";
    if (m.roleSource === "rules" && links.some((l) => l.cause === m.n && l.reaction !== m.n) && (m.role === "build" || m.role === "filler")) m.role = "punch";
    m.strength = strengthOf(m);
  }
  return { moments, links, promises };
}

/**
 * A take scorer for core/speech.js (retakeGroups / chooseTake take `score(take, group)`) from phase 5's output:
 * a function is used as it is; `montaj.takes/1` (seconds of media time; `toAxis` maps to the virtual axis) gives each
 * director take the score of the phase-5 take it overlaps most (IoU ≥ 0.5); unmatched takes rank below scored ones.
 */
export function takeScorer(phase5, { toAxis = (sec) => S(sec) } = {}) {
  if (!phase5) return null;
  if (typeof phase5 === "function") return phase5;
  const takes = (phase5.groups || []).flatMap((g) => (g.takes || []).map((tk) => ({ a: toAxis(tk.t0), b: toAxis(tk.t1), score: Number(tk.score) }))).filter((x) => Number.isFinite(x.score) && x.b > x.a);
  if (!takes.length) return null;
  const of = (take) => {
    let best = null, bi = 0;
    for (const x of takes) { const o = overlap(take.fromUs, take.toUs, x.a, x.b), iou = o / (Math.max(take.toUs, x.b) - Math.min(take.fromUs, x.a) || 1); if (iou > bi) { bi = iou; best = x; } }
    return best && bi >= 0.5 ? best.score : null;
  };
  // A take phase 5 did not score ranks below every scored one; among those, the last complete take (today's rule).
  return (take, group) => of(take) ?? -10 + (take.complete ? 1 : 0) + (group?.takes?.indexOf(take) ?? 0) * 1e-3;
}

// ------------------------------------------------------------------ treatments
export const HOOK_KINDS = ["result", "question", "reaction", "action", "none"];
const lenOf = (moments, ns) => ns.reduce((n, k) => n + (moments[k - 1].e - moments[k - 1].s), 0);

/**
 * A treatment made valid against the moments: unknown and repeated numbers dropped, a kept reaction gets its cause
 * (put right before it; a "before" link: right after), a promise its payoff, and the hook must be a moment. Returns
 * { treatment, fixes: [text] } — the fixes go on the cut sheet. Never adds a time that is not a moment.
 */
export function validateTreatment(t, moments, links = [], promises = [], { rank = null } = {}) {
  const fixes = [], N = moments.length;
  // Sorting puts moments in the story's order when there is one (phase 8), else in the footage's.
  const byRank = (a, b) => (rank ? (rank.get(a) ?? 1e6 + a) - (rank.get(b) ?? 1e6 + b) : a - b);
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= N;
  let order = [];
  for (const n of t.order || []) { if (!ok(n)) { fixes.push(`moment ${n} does not exist`); continue; } if (order.includes(n)) { fixes.push(`moment ${n} twice`); continue; } order.push(n); }
  for (const l of links) {
    if (!order.includes(l.reaction) || order.includes(l.cause) || l.cause === l.reaction) continue;
    const i = order.indexOf(l.reaction);
    order.splice(l.direction === "before" ? i + 1 : i, 0, l.cause);
    fixes.push(`moment ${l.cause} added: it causes the reaction in ${l.reaction}`);
  }
  for (const p of promises) if (p.payoff && order.includes(p.promise) && !order.includes(p.payoff)) { order.push(p.payoff); fixes.push(`moment ${p.payoff} added: it pays off the promise in ${p.promise}`); }
  // A cause and its reaction stay together, in their order.
  for (const l of links) {
    const a = order.indexOf(l.cause), b = order.indexOf(l.reaction);
    if (a < 0 || b < 0 || l.cause === l.reaction) continue;
    const want = l.direction === "before" ? b + 1 : b - 1;
    if (a !== want) { order.splice(a, 1); const nb = order.indexOf(l.reaction); order.splice(l.direction === "before" ? nb + 1 : nb, 0, l.cause); fixes.push(`moment ${l.cause} moved next to its reaction ${l.reaction}`); }
  }
  if (!order.length) { order = moments.filter((m) => m.role !== "filler").map((m) => m.n); fixes.push("empty order: every non-filler moment"); }
  // What the user placed without speech (a picture, a silent clip) is never left out.
  for (const m of moments) if (m.protected && !order.includes(m.n)) { order.push(m.n); fixes.push(`moment ${m.n} kept: a clip without speech`); }
  if (fixes.some((f) => f.endsWith("a clip without speech"))) order.sort(byRank);
  let hook = t.hook && ok(t.hook.moment) && HOOK_KINDS.includes(t.hook.kind) && t.hook.kind !== "none" ? { kind: t.hook.kind, moment: t.hook.moment } : null;
  if (t.hook?.moment && !hook) fixes.push(`hook moment ${t.hook.moment} is not valid`);
  if (hook && !order.includes(hook.moment)) { order.push(hook.moment); order.sort(byRank); fixes.push(`hook moment ${hook.moment} also kept in its place`); }
  return { treatment: { ...t, order, hook }, fixes };
}

/** The strongest moment of a kind that is worth showing first (null when none). */
function hookMoment(moments, kind, { durationUs, pos = null }) {
  // How far into the story a moment is (0–1): its place in the story order (phase 8), else its time.
  const at = (m) => (pos ? pos(m.n) / Math.max(1, moments.length) : m.s / Math.max(1, durationUs));
  // A moment people react to (laughter, applause, a scream) opens better than a line alone.
  const pull = (m) => m.strength + (m.reactions.some((r) => BIG.has(r.type)) ? 1.5 : 0);
  const by = (list) => [...list].sort((a, b) => pull(b) - pull(a))[0] || null;
  if (kind === "reaction") return by(moments.filter((m) => m.reactions.some((r) => ["laughter", "applause", "scream", "gasp"].includes(r.type))));
  if (kind === "question") return [...moments].sort((a, b) => at(a) - at(b)).find((m) => m.kind === "speech" && (m.question || m.story === "stakes") && at(m) < 0.6) || null;
  if (kind === "result") {
    const late = moments.filter((m) => at(m) >= 0.35 && (m.role === "punch" || m.role === "reaction"));
    const opening = [...moments].sort((a, b) => at(a) - at(b))[0];
    return by(late) || by(moments.filter((m) => m !== opening && m.role !== "filler"));
  }
  return null;
}

/** Moments in time (or story) order that fit `budgetUs`: the strongest first (the opening setup and every hook kept). */
function pickWithin(moments, budgetUs, must = [], pos = (n) => n) {
  const cand = moments.filter((m) => m.role !== "filler" && m.kind !== "gap");
  const chosen = new Set(must.filter(Boolean));
  let used = lenOf(moments, [...chosen]);
  const worth = (m) => m.strength / Math.sqrt((m.e - m.s) / US + 1); // strong for its length
  for (const m of [...cand].sort((a, b) => worth(b) - worth(a) || a.n - b.n)) {
    if (chosen.has(m.n)) continue;
    if (used + (m.e - m.s) > budgetUs) continue;
    chosen.add(m.n); used += m.e - m.s;
  }
  return [...chosen].sort((a, b) => pos(a) - pos(b));
}

/**
 * 3–5 treatments by rules (the local or cloud planner proposes its own; both go to the critic). Each: { id, title,
 * hook: { kind, moment } | null, order, length: full|medium|short, why }. opts: { durationUs, targetUs (a reel's
 * length), links, promises, story }. story (phase 8, core/story.js): { rank: Map(moment → place in the story) } — the
 * treatments then follow the story order instead of the footage's, the pure story is one of them, and the footage's
 * own order comes last as an alternative (`alternative: true`: listed on the cut sheet, not a candidate).
 */
export function ruleTreatments(moments, { durationUs, targetUs = null, links = [], promises = [], story = null } = {}) {
  const D = durationUs ?? (moments.length ? moments[moments.length - 1].e : 0);
  const rank = story?.rank || null;
  const pos = rank ? (n) => rank.get(n) ?? 1e6 + n : (n) => n;
  const inStory = (ns) => [...ns].sort((a, b) => pos(a) - pos(b));
  const useful = inStory(moments.filter((m) => m.role !== "filler" && m.kind !== "gap").map((m) => m.n));
  const fullUs = lenOf(moments, useful);
  const short = Math.min(targetUs || 60 * US, Math.max(15 * US, 0.45 * fullUs));
  const medium = targetUs ? Math.min(fullUs, targetUs * 1.4) : 0.68 * fullUs;
  const out = [];
  const add = (t, r = rank) => {
    const v = validateTreatment(t, moments, links, promises, { rank: r });
    const key = JSON.stringify([v.treatment.order, v.treatment.hook]);
    if (out.some((x) => x.key === key)) return;
    out.push({ ...v.treatment, fixes: v.fixes, source: "rules", key });
  };
  const hp = { durationUs: D, pos: rank ? pos : null };
  const result = hookMoment(moments, "result", hp), reaction = hookMoment(moments, "reaction", hp), question = hookMoment(moments, "question", hp);
  const first = useful[0];
  const pick = (budget, must) => pickWithin(moments, budget, must, pos);
  if (targetUs) {
    add({ id: "reel-result", title: "ريل: النتيجة الأول", length: "short", hook: result && { kind: "result", moment: result.n }, order: pick(targetUs, [first, result?.n]), why: `the strongest moments within ${Math.round(targetUs / US)} s, opened by the result`, whyAr: `أقوى اللحظات في ${Math.round(targetUs / US)} ث، وبتفتح بالنتيجة` });
    if (reaction) add({ id: "reel-reaction", title: "ريل: رد الفعل الأول", length: "short", hook: { kind: "reaction", moment: reaction.n }, order: pick(targetUs, [reaction.n]), why: "the reaction first, then the moments that lead to it", whyAr: "رد الفعل الأول، وبعده اللحظات اللي وصّلت له" });
  }
  add({ id: "result-full", title: "النتيجة الأول، الحكاية كاملة", length: "full", hook: result && { kind: "result", moment: result.n }, order: useful, why: `a flash-forward of the strongest late moment, then everything worth keeping in ${rank ? "story " : ""}order`, whyAr: `فلاش قدام من أقوى لحظة متأخرة، وبعده كل اللي يستاهل ${rank ? "بترتيب القصة" : "بالترتيب"}` });
  if (rank) add({ id: "story-full", title: "ترتيب القصة", length: "full", hook: null, order: useful, why: "the story order (setup, promise, build-up, conflict, payoff, ending), no flash-forward", whyAr: "بترتيب الحكاية (تمهيد، وعد، تصاعد، مشكلة، نتيجة، نهاية) من غير فلاش قدام" });
  if (reaction) add({ id: "reaction-medium", title: "رد الفعل الأول، نسخة متوسطة", length: "medium", hook: { kind: "reaction", moment: reaction.n }, order: pick(medium, [first, reaction.n]), why: "the biggest reaction as the cold open, the strongest two thirds of the story", whyAr: "أكبر رد فعل في الأول، وأقوى تلتين الحكاية" });
  if (question) add({ id: "question-medium", title: "سؤال في الأول", length: "medium", hook: { kind: "question", moment: question.n }, order: pick(medium, [question.n]), why: `opens on «${question.text.slice(0, 40)}» — the question the video answers`, whyAr: `بيفتح بـ«${question.text.slice(0, 40)}»: السؤال اللي الفيديو بيجاوبه` });
  // Straight into the action: the slow opening goes (everything before the first build / punch / action moment).
  const seq = inStory(moments.map((m) => m.n)).map((n) => moments[n - 1]);
  const start = seq.find((m) => m.role === "punch" || m.role === "reaction" || m.kind === "action" || (m.role === "build" && m.kind === "speech" && m !== seq[0]));
  if (start && start !== seq[0]) add({ id: "in-medias-res", title: "من وسط الأحداث", length: "full", hook: { kind: "action", moment: start.n }, order: useful.filter((n) => pos(n) >= pos(start.n) || moments[n - 1].role === "setup"), why: `starts at moment ${start.n}, the opening before it goes`, whyAr: `بيبدأ من لحظة ${start.n}، والبداية البطيئة قبلها بتتشال` });
  add({ id: "short-result", title: "نسخة قصيرة", length: "short", hook: result && { kind: "result", moment: result.n }, order: pick(short, [result?.n]), why: `the strongest moments within ${Math.round(short / US)} s`, whyAr: `أقوى اللحظات في ${Math.round(short / US)} ث` });
  // At least three: lengths of the plain story.
  if (out.length < 3) add({ id: "plain-medium", title: "الحكاية بترتيبها، متوسطة", length: "medium", hook: null, order: pick(medium, [first]), why: `in ${rank ? "story" : "shooting"} order, the weakest third out`, whyAr: `${rank ? "بترتيب القصة" : "بترتيب التصوير"}، من غير أضعف تلت` });
  if (out.length < 3) add({ id: "plain-full", title: "الحكاية بترتيبها", length: "full", hook: null, order: useful.length ? useful : moments.map((m) => m.n), why: `in ${rank ? "story" : "shooting"} order, fillers out`, whyAr: `${rank ? "بترتيب القصة" : "بترتيب التصوير"}، من غير الحشو` });
  const list = out.slice(0, 5);
  // The footage as it was given (the shooting order), for the cut sheet: the user can pick it instead of the story.
  if (rank) {
    const n0 = out.length;
    add({ id: "shooting-order", title: "بترتيب التصوير", length: "full", hook: null, order: [...useful].sort((a, b) => a - b), why: "the clips in the order they were given, fillers out (the alternative to the story order)", whyAr: "الكليبات بالترتيب اللي اتحطت بيه، من غير الحشو (البديل لترتيب القصة)" }, null);
    if (out.length > n0) list.push({ ...out[out.length - 1], alternative: true });
  }
  return list.map(({ key, ...t }) => t);
}

// ------------------------------------------------------------------ the executor's spec
/** A span inside a moment, at most maxUs long, that starts and ends between words (never inside one). */
export function hookSpan(m, words, kind, { maxUs = 3_200_000, lead = 1_000_000, tail = 2_000_000 } = {}) {
  const r = m.reactions.find((x) => ["laughter", "applause", "scream", "gasp"].includes(x.type)) || m.reactions[0];
  let a, b;
  if ((kind === "reaction" || m.kind !== "speech") && r) { a = Math.max(m.s, r.t - lead); b = Math.min(m.e, r.t + tail); }
  else if (m.kind === "speech") {
    // Around the strongest word moment (or from the start): its word, then the words before it (the setup), then the
    // words after it — whole words, within maxUs, never across a pause of 0.4 s or more.
    const ws = words.slice(m.w0, m.w1 + 1);
    const at = [...m.lex].sort((p, q) => q.score - p.score)[0]?.s ?? ws[0].startUs;
    const k = Math.max(0, ws.findIndex((w) => w.endUs > at));
    let k0 = k, k1 = k;
    while (k0 > 0 && ws[k1].endUs - ws[k0 - 1].startUs <= maxUs && ws[k0].startUs - ws[k0 - 1].endUs < 400_000) k0--;
    while (k1 + 1 < ws.length && ws[k1 + 1].endUs - ws[k0].startUs <= maxUs && ws[k1 + 1].startUs - ws[k1].endUs < 400_000) k1++;
    a = Math.max(m.s, ws[k0].startUs - 80_000); b = Math.min(m.e, ws[k1].endUs + 120_000);
  } else { const mid = (m.s + m.e) / 2; a = Math.max(m.s, mid - maxUs / 2); b = Math.min(m.e, a + maxUs); }
  // Never inside a word: widen to the word's edges.
  for (const w of words) { if (w.startUs < a && w.endUs > a) a = w.startUs - 40_000; if (w.startUs < b && w.endUs > b) b = w.endUs + 60_000; }
  return { fromUs: Math.max(m.s, Math.round(a)), toUs: Math.min(m.e, Math.round(b)) };
}

/**
 * What a (valid) treatment means for the executor. Returns { dropWords: Map(word index → "treatment"), cutSpans:
 * [{ fromUs, toUs, reason }] (wordless moments left out, and the quiet ends of kept wordless moments in a short cut),
 * keepSpans: [[a, b]] (kept wordless moments: never cut by the pacing), angleBreaks: [µs] (moment edges inside a
 * wordless run: the angle changes there), order: [[s, e]] (kept moments in edit order), hook: { fromUs, toUs, kind,
 * moment } | null (a flash-forward; null when the hook moment opens the edit anyway), actionAt: [µs] (kept action:
 * reasons to keep watching), reactionSfx: [{ atUs, sound, query, mood, why }] (sounds by meaning on wordless reactions),
 * actionVideo + audio (a mostly wordless video keeps its own sound: no voice clean-up) }.
 */
export function executionSpec(treatment, moments, words, { angleEveryUs = 2_500_000 } = {}) {
  const kept = new Set(treatment.order);
  const dropWords = new Map(), cutSpans = [], keepSpans = [], angleBreaks = [], actionAt = [], reactionSfx = [];
  // A kept wordless moment is cut to its core — the reaction with its lead-in, the middle of a long action stretch —
  // tighter in shorter treatments, so a run of action becomes jump cuts, not one long shot (the cut reaction video's
  // rhythm), and the angle changes every ~2.5 s inside what is kept.
  // A video mostly without words (a game, a challenge): its own sound IS the content — no voice clean-up, which
  // lowers everything between words (it made the 02 challenge's crowd silent: dead air, −17.5 LUFS). In a talking
  // video the clean-up stays, so a wordless moment kept there is a short beat (< 2 s): longer, it reads as dead air
  // (01 and 05: 2–15 silences ≥ 2 s).
  const D = moments.length ? moments[moments.length - 1].e : 0;
  const speechUs = moments.filter((m) => m.kind === "speech").reduce((n, m) => n + m.e - m.s, 0);
  const actionUs = moments.filter((m) => m.kind === "action").reduce((n, m) => n + m.e - m.s, 0);
  const actionVideo = D > 0 && speechUs / D < 0.45 && actionUs >= 20 * US;
  const CORE = !actionVideo ? { core: 1_800_000, lead: 1_200_000, tail: 600_000 } : ({ full: { core: 5_000_000, lead: 3_000_000 }, medium: { core: 4_000_000, lead: 2_500_000 }, short: { core: 3_000_000, lead: 2_000_000 } }[treatment.length] || { core: 5_000_000, lead: 3_000_000 });
  let lastKept = null;
  for (const m of moments) {
    // A sentence left out: its words go (the pacing then closes the gap) and its whole stretch is cut.
    if (m.kind === "speech") { if (!kept.has(m.n)) { for (let i = m.w0; i <= m.w1; i++) dropWords.set(i, "treatment"); cutSpans.push({ fromUs: m.s, toUs: m.e, reason: `treatment: moment ${m.n} (speech)` }); } else lastKept = "speech"; continue; }
    if (!kept.has(m.n)) { cutSpans.push({ fromUs: m.s, toUs: m.e, reason: `treatment: moment ${m.n} (${m.kind})` }); continue; }
    // In a talking video one beat per wordless run: two beats side by side are 3–4 s of near silence (05's dead air).
    if (!actionVideo && lastKept === "wordless" && !m.reactions.some((x) => BIG.has(x.type)) && !m.protected) { cutSpans.push({ fromUs: m.s, toUs: m.e, reason: `treatment: one beat per quiet stretch (moment ${m.n})` }); continue; }
    lastKept = "wordless";
    let a = m.s, b = m.e;
    const r = m.reactions.find((x) => BIG.has(x.type));
    if (m.peak && r) { a = Math.max(m.s, r.t - CORE.lead); b = Math.min(m.e, Math.max(r.t1 ?? r.t, r.t) + (CORE.tail ?? 1_500_000)); }
    else if (!m.protected && m.e - m.s > CORE.core + (actionVideo ? 500_000 : 0)) { const mid = (m.s + m.e) / 2; a = Math.round(mid - CORE.core / 2); b = Math.round(mid + CORE.core / 2); }
    // Never inside a word said in the action.
    for (const w of words) { if (w.startUs < a && w.endUs > a) a = w.startUs - 40_000; if (w.startUs < b && w.endUs > b) b = w.endUs + 60_000; }
    a = Math.max(m.s, Math.round(a)); b = Math.min(m.e, Math.round(b));
    if (a > m.s) cutSpans.push({ fromUs: m.s, toUs: a, reason: `treatment: the quiet start of moment ${m.n}` });
    if (b < m.e) cutSpans.push({ fromUs: b, toUs: m.e, reason: `treatment: the quiet end of moment ${m.n}` });
    keepSpans.push([a, b]);
    for (let t = a; t < b - 1_200_000; t += angleEveryUs) angleBreaks.push(Math.round(t));
    if (m.kind === "action") actionAt.push(a, ...m.reactions.filter((x) => x.t >= a && x.t < b).map((x) => x.t));
    // A laugh, applause or a scream in the action gets a sound of the same meaning (the library picks the file).
    if (r && r.t >= a && r.t < b) reactionSfx.push({ atUs: r.t, sound: r.type === "applause" ? "ding" : "pop", query: { laughter: "قفشة", applause: "هيصة", scream: "صدمة", gasp: "صدمة" }[r.type], mood: r.type === "laughter" ? "comic" : r.type === "applause" ? "joy" : "shock", why: `${r.type} in moment ${m.n}` });
  }
  // A cut the treatment adds never touches a kept word: a moment's edge is the previous sentence's recognised last-word
  // end, and cutting there ate that word's release (the verifier heard it: in the short cuts the words at the joints
  // came back 34–45 % of the time against 78–80 % for the others). The kept words keep their pads.
  const keptWords = words.filter((_, i) => !dropWords.has(i));
  const safe = (c) => {
    let { fromUs: a, toUs: b } = c;
    for (const w of keptWords) {
      if (w.startUs < a + 1 && w.endUs + WORD_TAIL > a) a = w.endUs + WORD_TAIL;
      if (w.endUs > b - 1 && w.startUs - WORD_HEAD < b) b = w.startUs - WORD_HEAD;
    }
    return b - a > 40_000 ? { ...c, fromUs: Math.round(a), toUs: Math.round(b) } : null;
  };
  const safeCuts = cutSpans.map(safe).filter(Boolean);
  cutSpans.splice(0, cutSpans.length, ...safeCuts);
  const order = treatment.order.map((n) => [moments[n - 1].s, moments[n - 1].e]);
  let hook = null;
  if (treatment.hook && treatment.hook.kind !== "none") {
    const m = moments[treatment.hook.moment - 1];
    const firstKept = treatment.order[0];
    // The hook moment already opens the edit (or the cut starts straight at it): no flash-forward copy needed.
    if (m && !(firstKept === m.n && treatment.hook.kind !== "reaction")) hook = { ...hookSpan(m, words, treatment.hook.kind), kind: treatment.hook.kind, moment: m.n };
    if (m && treatment.hook.kind === "action") hook = null; // «من وسط الأحداث»: the order itself is the hook
  }
  return { dropWords, cutSpans, keepSpans, angleBreaks, order, hook, actionAt, reactionSfx, actionVideo, ...(actionVideo ? { audio: { denoise: false, enhanceVoice: false, normalizeLufs: -14 } } : {}) };
}

/** Do two lines say the same thing? (≥ 70 % of the shorter one aligns) — the critic's repetition check. */
export function sameLine(a, b) {
  const A = String(a).split(/\s+/).map(alignToken).filter(Boolean), B = String(b).split(/\s+/).map(alignToken).filter(Boolean);
  if (A.length < 3 || B.length < 3) return false;
  const al = alignTokens(A, B);
  return (al?.matches ?? 0) / Math.min(A.length, B.length) >= 0.7;
}

/** A compact table of the moments for a planner / critic prompt (one line each). */
export function momentsTable(moments, links = []) {
  const sec = (us) => (us / US).toFixed(1);
  const lines = moments.map((m) => {
    const rx = m.reactions.filter((r) => r.type !== "pitch").map((r) => r.type);
    const what = m.kind === "speech" ? `«${m.text.slice(0, 110)}»` : m.summary ? `[${m.summary.slice(0, 110)}]` : "[no words]";
    return `${m.n} | ${sec(m.s)}–${sec(m.e)} s | ${m.kind} | ${m.role} | energy ${m.energy ?? "?"} | strength ${m.strength}${rx.length ? ` | reactions: ${[...new Set(rx)].join(",")}` : ""} | ${what}`;
  });
  const ls = links.map((l) => `${l.cause} → ${l.reaction}${l.unsure ? " (unsure)" : ""}`);
  return `${lines.join("\n")}${ls.length ? `\nLinks (cause → reaction, never separate them): ${ls.join("; ")}` : ""}`;
}
