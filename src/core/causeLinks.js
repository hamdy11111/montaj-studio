// Cause ↔ reaction links (Phase 6 of PLAN_editor_and_graphics.md, item 9 step 2, «الربط المرن»): every reaction the
// perception timeline heard or saw (a laugh, applause, a scream, a gasp, a sudden silence, a face that changes, a
// sudden loud burst, an exclamation) gets its possible causes, looked for in a window that depends on the kind of
// content — talk and comedy: about −2…+8 s around the line; pranks, challenges and reveals: back to the start of the
// scene and on to its end, including the promise said at the start («لو عملتها هاخد…»). A reaction may also come
// BEFORE its cause (someone laughing while the punchline is still coming, the tension before a reveal).
//
// Proximity only proposes; the relation is then checked: the same people (face identity / voice), the same scene
// (no change of place between them), and the meaning (a vision model looks at the span and answers yes/no with a
// confidence — the service's worker; here only the merge of its answers). Every link keeps its direction, distance
// and confidence; weak links are never dropped, they are marked «مش متأكد» for the cut sheet. Finally the protection
// rule the director applies: a cause and its reaction are never separated by a cut that loses the relation, and when
// a hook borrows the reaction, the cause still plays in its natural place.
//
// Pure functions only, times in seconds of the media (as the perception timeline). The output document's shape —
// schema "montaj.links/1" — is the contract the director (phase 7) reads; it is documented in HANDOFF.md.
import { detectMoments, normAr } from "./moments.js";

export const LINKS_SCHEMA = "montaj.links/1";

export const REACTION_KINDS = Object.freeze(["laughter", "applause", "cheer", "scream", "gasp", "verbal", "sudden_silence", "face_change", "loud_spike", "pitch_spike"]);
export const CAUSE_KINDS = Object.freeze(["speech", "promise", "action", "sound"]);
export const PROFILES = Object.freeze(["speech", "event"]);

/** Default knobs (tunable against the user's labelled links; no model re-run needed). */
export const LINK_DEFAULTS = Object.freeze({
  mergeS: 0.6,            // reaction evidence closer than this is one reaction
  minReaction: 0.3,       // reactions weaker than this are not linked (a lone small loudness bump)
  speechBackS: 8,         // speech profile: a cause may end up to 8 s before the reaction…
  speechFwdS: 2,          // …or start up to 2 s after it (the laugh that comes before the punchline ends)
  eventBackS: 300,        // event profile: back to the scene's start, at most this far
  eventFwdS: 30,          // …and forward to the scene's end, at most this far
  eventTauS: 20,          // event profile: how slowly the time prior decays
  topK: { speech: 4, event: 5 }, // candidates per reaction kept (and sent to the semantic check)
  sureAt: 0.65,           // final confidence from which a link is «متأكد»…
  sureSemantic: 0.5,      // …when the model's (calibrated) yes is at least this sure
  unverifiedCap: 0.6,     // a link nobody checked for meaning can never be «متأكد»
  nearGapS: 3,            // cause and reaction closer than this: the gap between them is part of the relation
});

const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const overlapS = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const byType = (tl, ...types) => (tl.events || []).filter((e) => types.includes(e.type));

// AudioSet (PANNs) labels that are reactions, and the ones that are sudden sounds that can cause one.
const TAG_REACTION = [
  [/laugh|giggle|snicker|chuckle|chortle|belly laugh/i, "laughter", 0.75],
  [/applause|clapping/i, "applause", 0.8],
  [/cheering|whoop|crowd|children shouting/i, "cheer", 0.75],
  [/scream|shout|yell|bellow|wail/i, "scream", 0.7],
  [/gasp/i, "gasp", 0.7],
];
const TAG_CAUSE = /explosion|bang|slam|smash|crash|thump|thud|glass|shatter|whistle|buzzer|alarm|bell|splash|pop|burst|firecracker|gunshot|whip|squeak|fart|burp|boing|honk/i;

// What a promise / the stakes of a challenge sounds like (Egyptian first): «لو عملتها هاخد…», «اللي يكسب ياخد…».
const PROMISE = [
  /(^| )لو [^ ]+( [^ ]+){0,6} (ه|ح|هت|حت|هن|حن|هي|حي)[^ ]{2,}/, // «لو عملتها هاخد», «لو كسبت هديك»
  /(^| )(اللي|الي|مين) (يكسب|يخسر|يفوز|يوقع|يضحك|يتكلم|يعملها|يقدر)/,
  /(رهان|نتراهن|اتراهن|مراهن|التحدي|تحدي|اتحداك|اتحداكم|عقاب|العقاب|الجايزه|جايزه|هديه|الخسران|الكسبان|مقلب)/,
  /(^| )(هديك|هديكي|هديكم|هتاخد|هتاخدي|هتاخدوا|هاخد) /,
];
export const isPromise = (text) => { const t = ` ${normAr(text)} `; return PROMISE.some((re) => re.test(t)); };

// What the vision model's "change" sentence says when a face reacts.
const FACE_CHANGE = /\b(smil\w*|laugh\w*|grin\w*|surpris\w*|shock\w*|gasp\w*|frown\w*|cover\w* (his|her|their) (face|mouth)|hands? (from|to|over|on) (his|her|their) (face|mouth)|jaw drop\w*|cheer\w*|jump\w* up)\b/i;

// ---------------------------------------------------------------------------------------------- the sound's envelope

/** RMS level in dB per `hopS` window of 16-bit PCM samples (the service reads the cached 16 kHz WAV). */
export function envelopeDb(samples, sampleRate, hopS = 0.1) {
  const hop = Math.max(1, Math.round(sampleRate * hopS));
  const out = new Float32Array(Math.floor(samples.length / hop));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) { const v = samples[k] / 32768; s += v * v; }
    out[i] = 20 * Math.log10(Math.sqrt(s / hop) + 1e-9);
  }
  return out;
}

const median = (a) => { if (!a.length) return -120; const s = Array.from(a).sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * Sudden silences: the sound was lively (above the file's median) and drops by ≥ `dropDb` within a moment and stays
 * down for ≥ `holdS` — the hush after a reveal, the beat before everyone bursts. [{t0, t1, dropDb}].
 */
export function suddenSilences(envDb, { hopS = 0.1, beforeS = 1.5, holdS = 0.8, dropDb = 12, minGapS = 3 } = {}) {
  const nb = Math.round(beforeS / hopS), nh = Math.round(holdS / hopS);
  const fileMed = median(envDb);
  const out = [];
  for (let i = nb; i + nh <= envDb.length; i++) {
    const before = median(envDb.subarray(i - nb, i)), after = median(envDb.subarray(i, i + nh));
    const peakAfter = Math.max(...envDb.subarray(i, i + nh));
    if (before > fileMed && before - after >= dropDb && peakAfter < before - dropDb / 2) {
      const t = i * hopS;
      if (out.length && t - out[out.length - 1].t0 < minGapS) continue;
      let j = i + nh;
      while (j < envDb.length && envDb[j] < before - dropDb / 2) j++;
      out.push({ t0: r3(t), t1: r3(j * hopS), dropDb: Math.round((before - after) * 10) / 10 });
      i = j;
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------------- the reactions

/** The timeline's words in the core's shape (µs, text) for the moments lexicon. */
const coreWords = (tl) => byType(tl, "word").map((w) => ({ text: w.text || "", startUs: Math.round(w.t0 * 1e6), endUs: Math.round(w.t1 * 1e6), speaker: w.speaker }));

/** Inside how much of a span someone is talking (utterances), and who. */
function speechIn(tl, t0, t1) {
  let s = 0; const who = new Set();
  for (const u of byType(tl, "utterance")) { const o = overlapS(t0, t1, u.t0, u.t1); if (o > 0) { s += o; if (u.speaker) who.add(u.speaker); } }
  return { share: t1 > t0 ? Math.min(1, s / (t1 - t0)) : 0, who: [...who] };
}

/**
 * Every reaction in the timeline, evidence merged when closer than `mergeS`:
 * [{id, t0, t1, kind, kinds, strength, speakers, evidence: [{type, id, kind, w}]}] with strength 1 − Π(1 − w).
 * `silences`: suddenSilences(…) of the sound (optional — the service computes them from the WAV).
 */
export function findReactions(tl, { silences = [], ...opts } = {}) {
  const o = { ...LINK_DEFAULTS, ...opts };
  const raw = [];
  const add = (t0, t1, kind, w, src, speaker = null) => raw.push({ t0, t1, kind, w: clamp01(w), speaker, src });
  for (const e of byType(tl, "laughter")) add(e.t0, e.t1, "laughter", e.confidence ?? 0.7, e, e.speaker);
  for (const e of byType(tl, "audio_tag")) {
    const hit = TAG_REACTION.find(([re]) => re.test(e.text || ""));
    if (hit) add(e.t0, e.t1, hit[1], hit[2] * Math.min(1, 0.4 + (e.confidence ?? 0.3)), e);
  }
  for (const e of byType(tl, "loudness_spike")) {
    // A burst inside someone's sentence is mostly emphasis (that line may be the cause, not a reaction).
    const sp = speechIn(tl, e.t0, e.t1);
    const above = e.extra?.aboveDb ?? 10;
    const w = (0.3 + Math.min(0.35, (above - 9) / 25)) * (sp.share > 0.6 ? 0.5 : 1);
    add(e.t0, e.t1, "loud_spike", w, e, sp.share > 0.6 ? sp.who[0] || null : null);
  }
  for (const e of byType(tl, "pitch_spike")) add(e.t0, e.t1, "pitch_spike", 0.35 + 0.1 * Math.min(1, ((e.extra?.ratio ?? 1.5) - 1.3) / 0.7), e, e.speaker);
  for (const s of silences) add(s.t0, Math.min(s.t1, s.t0 + 2), "sudden_silence", 0.3 + Math.min(0.25, (s.dropDb - 12) / 40), { type: "silence", id: null });
  // An exclamation said out loud («يا نهار!», «ههههه», «مستحيل») is a reaction too.
  for (const m of detectMoments(coreWords(tl))) {
    if (!["laugh", "shock", "oops", "win"].includes(m.type)) continue;
    const t0 = m.s / 1e6, t1 = m.e / 1e6;
    const w = byType(tl, "word").find((x) => Math.abs(x.t0 - t0) < 0.05);
    add(t0, t1, "verbal", m.type === "win" ? 0.4 : 0.5, { type: "word", id: w?.id ?? null, text: m.text }, w?.speaker ?? null);
  }
  // A face that changes (from the vision model's shot log): placed on the last keyframe of its window.
  for (const e of byType(tl, "shot_log")) {
    const ch = e.extra?.change || "";
    if (!FACE_CHANGE.test(ch)) continue;
    const kf = e.extra?.keyframes || [];
    const t = kf.length ? kf[kf.length - 1] : (e.t0 + e.t1) / 2;
    add(Math.max(e.t0, t - 1), Math.min(e.t1, t + 1), "face_change", 0.3, e);
  }
  raw.sort((a, b) => a.t0 - b.t0);
  const groups = [];
  for (const x of raw) {
    const g = groups[groups.length - 1];
    if (g && x.t0 - g.t1 <= o.mergeS) { g.items.push(x); g.t1 = Math.max(g.t1, x.t1); } else groups.push({ t0: x.t0, t1: x.t1, items: [x] });
  }
  const out = [];
  for (const g of groups) {
    const best = new Map();
    for (const x of g.items) best.set(x.kind, Math.max(best.get(x.kind) || 0, x.w));
    const strength = 1 - [...best.values()].reduce((p, w) => p * (1 - w), 1);
    if (strength < o.minReaction) continue;
    const kinds = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    out.push({
      id: null, t0: r3(g.t0), t1: r3(g.t1), kind: kinds[0], kinds, strength: r3(strength),
      speakers: [...new Set(g.items.map((x) => x.speaker).filter(Boolean))],
      evidence: g.items.map((x) => ({ type: x.src.type, id: x.src.id ?? null, kind: x.kind, w: r3(x.w), ...(x.src.text && x.kind === "verbal" ? { text: x.src.text } : {}) })),
    });
  }
  out.forEach((r, i) => { r.id = `R${String(i + 1).padStart(3, "0")}`; });
  return out;
}

// ------------------------------------------------------------------------------------------ scenes and the profile

/**
 * Scenes: the shots (camera cuts), further split where a continuous take changes place — the vision model's
 * indoor/outdoor flips and stays flipped for `stable` windows (one window inside a van's open door is not a new
 * scene; its free-text "where" is too noisy to compare). [{id, t0, t1, why}].
 */
export function findScenes(tl, { stable = 2 } = {}) {
  const dur = tl.media?.duration || Math.max(0, ...(tl.events || []).map((e) => e.t1));
  const cuts = new Map();
  for (const s of byType(tl, "shot")) if (s.t0 > 0.05) cuts.set(r3(s.t0), "cut");
  const logs = byType(tl, "shot_log").filter((e) => typeof e.extra?.indoor === "boolean");
  let cur = logs[0]?.extra.indoor;
  for (let i = 1; i < logs.length; i++) {
    const v = logs[i].extra.indoor;
    if (v === cur) continue;
    const run = logs.slice(i, i + stable);
    if (run.length === stable && run.every((e) => e.extra.indoor === v)) { cur = v; if (!cuts.has(r3(logs[i].t0))) cuts.set(r3(logs[i].t0), "place"); }
  }
  const edges = [...cuts.entries()].sort((a, b) => a[0] - b[0]);
  const out = [];
  let t = 0, why = "start";
  for (const [c, w] of edges) { if (c - t >= 1) { out.push({ t0: r3(t), t1: c, why }); t = c; why = w; } }
  out.push({ t0: r3(t), t1: r3(dur), why });
  out.forEach((s, i) => { s.id = `SC${i + 1}`; });
  return out;
}

const sceneAt = (scenes, t) => scenes.find((s) => t >= s.t0 && t < s.t1) || scenes[scenes.length - 1];

const EVENT_HINT = /^(challenge|prank|reveal|game|تحدي|مقلب|كشف|لعبه|لعبة)$/i;
const SPEECH_HINT = /^(comedy|vlog|talk|explainer|interview|cooking|كوميديا|فلوق|شرح|مقابله|مقابلة|طبخ)$/i;

/**
 * Speech or event content: from the user's hint (content type) when given, else from how much is said (a group
 * game with little talk is an event) and whether a challenge/prank is announced. {kind, source, reason}.
 */
export function contentProfile(tl, hint = null) {
  if (hint && EVENT_HINT.test(String(hint).trim())) return { kind: "event", source: "hint", reason: `content type «${hint}»` };
  if (hint && SPEECH_HINT.test(String(hint).trim())) return { kind: "speech", source: "hint", reason: `content type «${hint}»` };
  const dur = tl.media?.duration || 1;
  const talk = byType(tl, "utterance").reduce((s, u) => s + (u.t1 - u.t0), 0);
  const share = talk / dur;
  const promised = byType(tl, "utterance").some((u) => isPromise(u.text));
  if (share < 0.25) return { kind: "event", source: "auto", reason: `speech covers ${Math.round(share * 100)} % of the file` };
  if (promised) return { kind: "event", source: "auto", reason: "a challenge / promise is said" };
  return { kind: "speech", source: "auto", reason: `speech covers ${Math.round(share * 100)} % of the file` };
}

// ------------------------------------------------------------------------------------------------------ the causes

/**
 * Everything that can cause a reaction: what is said (one per utterance; promises marked), what happens on screen
 * (vision windows with movement or energy), sudden sounds (non-reaction tags, bursts outside speech).
 * [{id, t0, t1, kind, text, speaker, energy, evidence: [ids]}].
 */
export function findCauses(tl, reactions = []) {
  const out = [];
  for (const u of byType(tl, "utterance")) {
    out.push({ t0: u.t0, t1: u.t1, kind: isPromise(u.text) ? "promise" : "speech", text: u.text, speaker: u.speaker, energy: null, evidence: [u.id] });
  }
  for (const e of byType(tl, "shot_log")) {
    const x = e.extra || {};
    const moving = x.change && !/^none\.?$/i.test(String(x.change).trim());
    if ((x.energy ?? 0) >= 3 || moving) out.push({ t0: e.t0, t1: e.t1, kind: "action", text: x.summary || e.text || null, speaker: null, energy: x.energy ?? null, evidence: [e.id] });
  }
  const isReactionTime = (e) => reactions.some((r) => overlapS(r.t0 - 0.1, r.t1 + 0.1, e.t0, e.t1) > 0 && r.evidence.some((v) => v.id === e.id));
  for (const e of byType(tl, "audio_tag")) if (TAG_CAUSE.test(e.text || "")) out.push({ t0: e.t0, t1: e.t1, kind: "sound", text: e.text, speaker: null, energy: null, evidence: [e.id] });
  for (const e of byType(tl, "loudness_spike")) {
    if (speechIn(tl, e.t0, e.t1).share > 0.3 || isReactionTime(e)) continue;
    out.push({ t0: e.t0, t1: e.t1, kind: "sound", text: `loud +${e.extra?.aboveDb ?? "?"} dB`, speaker: null, energy: null, evidence: [e.id] });
  }
  out.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  out.forEach((c, i) => { c.id = `C${String(i + 1).padStart(3, "0")}`; c.t0 = r3(c.t0); c.t1 = r3(c.t1); });
  return out;
}

// ------------------------------------------------------------------------------------- people in a span (identity)

/** Who is in a span: face identities on screen (≥ 30 % of it, or ≥ 0.5 s) and the voices heard, with their faces. */
export function peopleIn(tl, t0, t1) {
  const faces = new Map();
  for (const f of byType(tl, "face_track")) { const o = overlapS(t0, t1, f.t0, f.t1); if (o > 0 && f.entity) faces.set(f.entity, (faces.get(f.entity) || 0) + o); }
  const need = Math.min(0.5, 0.3 * Math.max(0.1, t1 - t0));
  const entities = [...faces.entries()].filter(([, s]) => s >= need).map(([p]) => p);
  const voices = new Set(speechIn(tl, t0, t1).who);
  for (const e of byType(tl, "laughter", "pitch_spike")) if (e.speaker && overlapS(t0, t1, e.t0, e.t1) > 0) voices.add(e.speaker);
  const faceOf = new Map((tl.speakers || []).map((s) => [s.id, s.face || null]));
  for (const v of voices) { const p = faceOf.get(v); if (p && !entities.includes(p)) entities.push(p); }
  return { entities, voices: [...voices] };
}

/** true: the reaction and the cause share someone · false: both known and disjoint · null: not enough to tell. */
export function samePeople(a, b) {
  const known = (p) => p.entities.length + p.voices.length > 0;
  if (!known(a) || !known(b)) return null;
  if (a.entities.some((x) => b.entities.includes(x)) || a.voices.some((x) => b.voices.includes(x))) return true;
  return false;
}

// ----------------------------------------------------------------------------------------- candidates and the prior

/** Where a reaction sits relative to a cause: direction (cause first → "after"), start-to-start offset, the gap. */
export function relation(reaction, cause) {
  const direction = reaction.t0 >= cause.t0 ? "after" : "before";
  const gap = direction === "after" ? reaction.t0 - cause.t1 : cause.t0 - reaction.t1;
  return { direction, offsetS: r3(reaction.t0 - cause.t0), gapS: r3(Math.max(0, gap)) };
}

/** The time prior: how plausible this distance is for this profile and cause kind (0..1). */
export function timePrior(profile, cause, reaction, o = LINK_DEFAULTS) {
  const { direction, gapS } = relation(reaction, cause);
  const overl = overlapS(reaction.t0, reaction.t1, cause.t0, cause.t1) > 0;
  if (profile === "speech") {
    if (direction === "after") {
      if (overl) return 0.85; // laughing while the line ends
      if (gapS <= 3) return 1;
      return gapS <= o.speechBackS ? 1 - 0.65 * (gapS - 3) / (o.speechBackS - 3) : 0;
    }
    return gapS <= o.speechFwdS ? 0.55 - 0.15 * gapS / o.speechFwdS : 0; // reaction first (anticipation)
  }
  if (cause.kind === "promise") return direction === "after" ? 0.6 : 0.05; // the stakes said earlier, any distance in the scene
  if (direction === "after") return overl ? 0.9 : Math.max(0.15, Math.exp(-Math.max(0, gapS - 3) / o.eventTauS));
  return Math.max(0.05, 0.45 * Math.exp(-gapS / 10)); // tension before the reveal
}

const KIND_WEIGHT = { speech: { speech: 1, promise: 0.9, action: 0.6, sound: 0.9 }, event: { speech: 0.7, promise: 0.9, action: 1, sound: 0.9 } };

/** May this cause explain this reaction at all (the profile's window, and not the reaction itself)? */
function inWindow(profile, scenes, cause, reaction, o) {
  if (overlapS(cause.t0, cause.t1, reaction.t0, reaction.t1) >= 0.9 * (reaction.t1 - reaction.t0) && cause.kind === "sound") return false;
  if (profile === "speech") return cause.t1 >= reaction.t0 - o.speechBackS && cause.t0 <= reaction.t1 + o.speechFwdS;
  const sc = sceneAt(scenes, reaction.t0);
  const from = Math.max(sc.t0, reaction.t0 - o.eventBackS), to = Math.min(sc.t1, reaction.t1 + o.eventFwdS);
  if (cause.kind === "promise") return cause.t0 >= sc.t0 - 0.01 && cause.t0 <= reaction.t1; // the whole segment back
  return cause.t1 >= from && cause.t0 <= to;
}

/**
 * Candidate causes per reaction with their prior (time × kind × same people × same scene × a punchline bonus),
 * the best `topK` kept (in the event profile the best promise of the scene is always kept).
 * [{reaction, cause, rank, prior, direction, offsetS, gapS, checks: {samePeople, sameScene}}].
 */
export function candidates(tl, reactions, causes, { profile = "speech", scenes = findScenes(tl), ...opts } = {}) {
  const o = { ...LINK_DEFAULTS, ...opts };
  const pp = new Map();
  const people = (x) => { const k = `${x.t0}|${x.t1}`; if (!pp.has(k)) pp.set(k, peopleIn(tl, x.t0, x.t1)); return pp.get(k); };
  const out = [];
  for (const r of reactions) {
    const rs = sceneAt(scenes, r.t0);
    const list = [];
    for (const c of causes) {
      if (!inWindow(profile, scenes, c, r, o)) continue;
      const tp = timePrior(profile, c, r, o);
      if (tp <= 0) continue;
      const same = samePeople(people(r), people(c));
      const sameScene = sceneAt(scenes, c.t0) === rs && sceneAt(scenes, Math.max(c.t0, c.t1 - 0.01)) === rs;
      let punch = 1;
      if (c.kind === "speech" || c.kind === "promise") {
        const n = String(c.text || "").split(/\s+/).filter(Boolean).length;
        if (n <= 1) punch = 0.7;
        else if (detectMoments(c.text.split(/\s+/).map((t, i) => ({ text: t, startUs: i, endUs: i }))).length) punch = 1.1;
      }
      if (c.kind === "action" && (c.energy ?? 3) >= 4) punch = 1.1;
      const prior = clamp01(tp * KIND_WEIGHT[profile][c.kind] * (same === true ? 1 : same === null ? 0.85 : 0.6) * (sameScene ? 1 : c.kind === "promise" ? 0.8 : 0.5) * punch);
      list.push({ reaction: r.id, cause: c.id, prior: r3(prior), ...relation(r, c), checks: { samePeople: same, sameScene } });
    }
    list.sort((a, b) => b.prior - a.prior);
    const k = o.topK[profile] ?? 4;
    const kept = list.slice(0, k);
    if (profile === "event") {
      const promise = list.find((x) => causes.find((c) => c.id === x.cause)?.kind === "promise");
      if (promise && !kept.includes(promise)) kept.push(promise);
    }
    kept.forEach((x, i) => { x.rank = i + 1; out.push(x); });
  }
  return out;
}

// ------------------------------------------------------------------------------------- the verdicts and the result

/** The semantic answer as a probability that the relation holds (no answer → null). */
export const semanticP = (v) => (!v || typeof v.yes !== "boolean" ? null : clamp01(v.yes ? 0.5 + 0.5 * (v.confidence ?? 0.5) : 0.5 - 0.5 * (v.confidence ?? 0.5)));

/**
 * The final links: each candidate's confidence from its prior and (when checked) the model's yes/no — a link nobody
 * checked stays under `unverifiedCap`, so it is «مش متأكد». The best link of each reaction is marked `best`; the
 * others stay as alternatives. Nothing is dropped. verdicts: Map/obj "R001|C003" → {yes, confidence, reason, engine}.
 */
export function finalizeLinks(cands, verdicts = {}, { reactionChecks = {}, ...opts } = {}) {
  const o = { ...LINK_DEFAULTS, ...opts };
  const get = (k) => (verdicts instanceof Map ? verdicts.get(k) : verdicts[k]) || null;
  const links = cands.map((c) => {
    const v = get(`${c.reaction}|${c.cause}`);
    const p = semanticP(v);
    let conf = p === null ? Math.min(o.unverifiedCap, 0.6 * c.prior) : clamp01(0.35 * c.prior + 0.65 * p);
    // A reaction the model says is not one: its links lose most of their weight (kept, «مش متأكد»).
    const rc = reactionChecks[c.reaction];
    if (rc && rc.real === false) conf *= 1 - 0.7 * (rc.confidence ?? 0.5);
    return {
      ...c, confidence: r3(conf), checks: { ...c.checks, semantic: v ? { yes: v.yes, confidence: v.confidence ?? null, reason: v.reason ?? "", engine: v.engine ?? null } : null },
    };
  });
  const byR = new Map();
  for (const l of links) { if (!byR.has(l.reaction)) byR.set(l.reaction, []); byR.get(l.reaction).push(l); }
  for (const list of byR.values()) {
    list.sort((a, b) => b.confidence - a.confidence || b.prior - a.prior);
    list.forEach((l, i) => { l.rank = i + 1; l.best = i === 0; });
  }
  const out = [...byR.values()].flat();
  out.forEach((l, i) => {
    l.id = `L${String(i + 1).padStart(3, "0")}`;
    l.status = l.best && l.confidence >= o.sureAt && l.checks.semantic?.yes === true && (l.checks.semantic.confidence ?? 1) >= o.sureSemantic && reactionChecks[l.reaction]?.real !== false ? "sure" : "unsure";
    l.label_ar = l.status === "sure" ? "متأكد" : "مش متأكد";
    l.keepGap = l.gapS <= o.nearGapS;
  });
  return out.map(({ id, reaction, cause, rank, best, direction, offsetS, gapS, prior, confidence, status, label_ar, keepGap, checks }) =>
    ({ id, reaction, cause, rank, best, direction, offsetS, gapS, prior, confidence, status, label_ar, keepGap, checks }));
}

/** Frames, words and lettered candidates for one reaction (real, or a decoy control). Candidates in time order. */
function queryFor(tl, doc, r, cands, { maxFrames = 12, denseS = 10, speechDenseS = 8 } = {}) {
  const event = doc.profile.kind === "event";
  const sc = sceneAt(doc.scenes, r.t0);
  const a = Math.max(sc.t0, r.t0 - (event ? denseS : speechDenseS)), b = Math.min(sc.t1, r.t1 + 1.5);
  const far = cands.filter((c) => c.t1 < a - 0.5 && c.kind !== "speech" && c.kind !== "promise");
  const nDense = Math.max(4, maxFrames - Math.min(3, far.length));
  const frames = [];
  for (let k = 0; k < nDense; k++) frames.push(r3(a + (b - a) * (k + 0.5) / nDense));
  for (const c of far.slice(0, 3)) frames.push(r3((c.t0 + c.t1) / 2));
  frames.sort((x, y) => x - y);
  const lo = Math.min(a, ...cands.map((c) => c.t0));
  const said = byType(tl, "utterance").filter((u) => u.t1 >= lo - 0.5 && u.t0 <= b).map((u) => [r3(u.t0), r3(u.t1), u.speaker, u.text]);
  // Time order, not prior order: the model tends to pick the first letter.
  const ordered = cands.slice().sort((x, y) => x.t0 - y.t0 || x.t1 - y.t1);
  return {
    reaction: r.id, t0: r.t0, t1: r.t1, kinds: r.kinds, profile: doc.profile.kind, span: [r3(a), r3(b)], frames, said,
    heard: r.evidence.map((v) => `${v.kind}${v.text ? ` «${v.text}»` : ""} (${v.w})`),
    candidates: ordered.map((c, i) => ({ key: String.fromCharCode(65 + i), cause: c.id, kind: c.kind, t0: c.t0, t1: c.t1, text: c.text || "", far: c.t1 < a - 0.5 })),
    ...(r.control ? { control: true } : {}),
  };
}

/**
 * The questions for the semantic check, one per reaction (a multiple choice is cheaper than one call per pair and
 * lets the model compare): the span to look at, the frame times (dense just before and during the reaction, one
 * frame on each far candidate), what is said in it, what the sound models heard, and the candidates lettered A, B…
 * in time order. The vision model does not hear, so the reaction's sound is described in words.
 */
export function verifyQueries(tl, doc, opts = {}) {
  const C = new Map(doc.causes.map((c) => [c.id, c]));
  const out = [];
  for (const r of doc.reactions) {
    const cands = doc.links.filter((l) => l.reaction === r.id).map((l) => C.get(l.cause)).filter(Boolean);
    if (cands.length) out.push(queryFor(tl, doc, r, cands, opts));
  }
  return out;
}

/**
 * Decoy questions: the same question asked at calm moments where nothing was heard (≥ `awayS` from every reaction,
 * vision energy ≤ 3, no burst within 2 s; the evidence text borrowed from a real reaction). How often the model still says "a real reaction" and names a cause
 * there is its false-yes rate — the calibration that discounts its confidence (applyAnswers). Deterministic.
 */
export function controlQueries(tl, doc, { n = 6, awayS = 4, ...opts } = {}) {
  const dur = doc.media?.duration || tl.media?.duration || 0;
  const busy = (t) => doc.reactions.some((r) => t > r.t0 - awayS && t < r.t1 + awayS);
  // Calm moments only: a "quiet" second inside a lively stretch may still be a reaction nobody flagged.
  const energy = (t) => byType(tl, "shot_log").find((e) => t >= e.t0 && t < e.t1)?.extra?.energy ?? null;
  const loud = (t) => byType(tl, "loudness_spike", "laughter", "audio_tag").some((e) => e.t1 >= t - 2 && e.t0 <= t + 2 && e.type !== "audio_tag" || (e.type === "audio_tag" && TAG_REACTION.some(([re]) => re.test(e.text || "")) && e.t1 >= t - 2 && e.t0 <= t + 2));
  const free = [];
  for (let t = 3; t < dur - 2; t += 0.5) if (!busy(t)) free.push(r3(t));
  const calm = free.filter((t) => (energy(t) ?? 3) <= 3 && !loud(t));
  const slots = calm.length >= n ? calm : free;
  const real = doc.reactions.filter((r) => r.evidence.length);
  if (!slots.length || !real.length) return [];
  const out = [];
  const step = slots.length / n;
  for (let i = 0; i < n && i * step < slots.length; i++) {
    const t = slots[Math.floor(i * step + step / 2)];
    const like = real[i % real.length];
    const r = { id: `X${String(i + 1).padStart(2, "0")}`, t0: t, t1: r3(t + Math.min(1.2, like.t1 - like.t0)), kind: like.kind, kinds: like.kinds, strength: like.strength, speakers: [], evidence: like.evidence, control: true };
    const cs = candidates(tl, [r], doc.causes.filter((c) => !c.placedBy), { profile: doc.profile.kind, scenes: doc.scenes, ...opts });
    const C = new Map(doc.causes.map((c) => [c.id, c]));
    const cands = cs.map((x) => C.get(x.cause)).filter(Boolean);
    if (cands.length) out.push(queryFor(tl, doc, r, cands, opts));
  }
  return out;
}

const SOUND_REACTION = new Set(["laughter", "cheering", "applause", "screaming", "gasp"]);
const SOUND_NOT = new Set(["crying", "talking", "shouting_words", "music", "noise"]);
const SEEN_STRONG = new Set(["laughing", "cheering", "clapping", "shocked", "hands_on_head", "covering_face", "screaming", "jumping"]);

/**
 * One answer per question from the eye (Qwen3.6: frames) and the ear (Qwen3-Omni: the clip + a few frames).
 * Real reaction: the ear hears one (a laugh, a cheer…), or the eye sees one and the ear does not contradict it — a
 * crying child, talk or a shouted call heard there leaves only a strong visible reaction (laughing, hands on head…),
 * not a mere smile. The cause: both naming the same one raises the confidence; when they differ, the surer one is
 * kept at 0.7 of its confidence and the other becomes also_related. Either side may be missing. Pure.
 */
export function mergeAnswers(vision, audio) {
  if (!vision && !audio) return null;
  const out = {};
  for (const id of new Set([...Object.keys(vision || {}), ...Object.keys(audio || {})])) {
    const v = vision?.[id] || null, a = audio?.[id] || null;
    if (!v || !a) { out[id] = { ...(v || a), engines: { vision: v, audio: a } }; continue; }
    const heard = a.sound_heard ?? null, seen = v.reaction_seen ?? null;
    const vReal = v.reaction_real !== false && !["nothing_visible", "camera_away"].includes(seen);
    const aReal = SOUND_REACTION.has(heard) || (a.reaction_real !== false && !SOUND_NOT.has(heard) && heard !== "silence");
    const real = SOUND_REACTION.has(heard) || (vReal && (!SOUND_NOT.has(heard) || SEEN_STRONG.has(seen)));
    const rc = real ? (vReal && aReal ? Math.max(v.reaction_confidence ?? 0.5, a.reaction_confidence ?? 0.5) : 0.8 * ((aReal ? a : v).reaction_confidence ?? 0.5))
      : Math.max(vReal ? 0 : v.reaction_confidence ?? 0.5, aReal ? 0 : a.reaction_confidence ?? 0.5);
    const cv = String(v.cause || "none").toUpperCase(), ca = String(a.cause || "none").toUpperCase();
    const same = cv === ca || (v._map && a._map && v._map[cv] && v._map[cv] === a._map[ca]);
    let pick, conf, time, also = [];
    if (same) { pick = v.cause; conf = Math.min(1, Math.max(v.confidence ?? 0.5, a.confidence ?? 0.5) + 0.1); time = Number.isFinite(Number(v.cause_time)) ? v.cause_time : a.cause_time; also = [...new Set([...(v.also_related || []), ...(a.also_related || [])])]; }
    else {
      // The side that found no reaction has no cause to offer; otherwise the surer one wins.
      const [w, l] = vReal !== aReal ? (vReal ? [v, a] : [a, v]) : (v.confidence ?? 0) >= (a.confidence ?? 0) ? [v, a] : [a, v];
      pick = w.cause; conf = 0.7 * (w.confidence ?? 0.5); time = w.cause_time; also = [...(w.also_related || [])];
      if (!["NONE", "OTHER"].includes(String(l.cause || "none").toUpperCase())) also.push(l.cause);
    }
    if (!real) { pick = "none"; conf = Math.max(v.confidence ?? 0.5, a.confidence ?? 0.5); }
    out[id] = {
      reaction_real: real, reaction_confidence: r3(rc), reaction_seen: !real ? "nothing_visible" : vReal ? seen : `heard_${heard}`, sound_heard: heard,
      cause: pick, cause_time: time, confidence: r3(conf), also_related: also, reason: `eye: ${v.reason || ""} | ear: ${a.reason || ""}`,
      _map: v._map || a._map, engines: { vision: v, audio: a },
    };
  }
  return out;
}

/** The model's false-yes rates on the decoys: {n, realRate, causeRate} (null when there were no decoys). */
export function calibrationFrom(controlAnswers) {
  const a = Object.values(controlAnswers || {});
  if (!a.length) return null;
  const real = a.filter((x) => x.reaction_real !== false && x.reaction_seen !== "nothing_visible").length;
  const cause = a.filter((x) => x.cause && !["none", "NONE"].includes(x.cause)).length;
  return { n: a.length, realRate: r3(real / a.length), causeRate: r3(cause / a.length) };
}

/**
 * The model's answers → per-pair verdicts, reaction checks and vision-placed causes. Answer per reaction:
 * {reaction_real, reaction_confidence, cause: "A"… | "other" | "none", cause_time, confidence, reason, also_related,
 *  _map?: {A: "C003"…}} (_map, added by the service, pins the letters to the causes they meant when asked).
 * The chosen letter is a yes; the others a soft no (half the confidence) unless listed in also_related. "other" — or
 * a long action window chosen with a cause_time well inside it — adds a ~2 s cause at that time, linked with a yes
 * (the narrowed window keeps its link as an alternative, at half the confidence). `calibration` (calibrationFrom of
 * the decoys) discounts the confidences: a model that says yes to decoys as often as to real reactions says nothing.
 */
export function applyAnswers(queries, answers, causes, { engine = null, calibration = null } = {}) {
  const verdicts = {}, reactionChecks = {}, extra = [];
  const kReal = calibration ? clamp01(1 - calibration.realRate) : 1, kCause = calibration ? clamp01(1 - calibration.causeRate) : 1;
  let n = causes.length;
  for (const q of queries) {
    const ans = answers[q.reaction];
    if (!ans) continue;
    const map = ans._map || null;
    const keyOf = (c) => (map ? Object.keys(map).find((k) => map[k] === c.cause) ?? null : c.key);
    const conf = clamp01(Number(ans.confidence ?? 0.5)) * kCause;
    const seenNothing = ans.reaction_seen === "nothing_visible";
    const real = ans.reaction_real !== false && !seenNothing;
    reactionChecks[q.reaction] = { real, confidence: r3(clamp01(Number(ans.reaction_confidence ?? 0.5)) * (real ? kReal : 1)), seen: ans.reaction_seen ?? null };
    const pick = String(ans.cause || "none").trim().toUpperCase();
    const also = new Set((ans.also_related || []).map((x) => String(x).trim().toUpperCase()));
    const tc = Number(ans.cause_time);
    const place = (from) => {
      const t = Math.max(0, tc);
      const c = {
        id: `C${String(++n).padStart(3, "0")}`, t0: r3(Math.max(from ? from.t0 : 0, t - 1.5)), t1: r3(Math.min(from ? from.t1 : t + 0.5, t + 0.5)),
        kind: from?.kind === "sound" ? "sound" : "action", text: ans.reason || null, speaker: null, energy: from?.energy ?? null,
        evidence: from ? [...from.evidence] : [], placedBy: engine, refines: from?.id ?? null,
      };
      if (c.t1 - c.t0 < 0.3) c.t1 = r3(c.t0 + 0.5);
      extra.push({ reaction: q.reaction, cause: c });
      verdicts[`${q.reaction}|${c.id}`] = { yes: true, confidence: r3(conf), reason: ans.reason || "", engine };
    };
    for (const c of q.candidates) {
      const k = keyOf(c);
      const chosen = k !== null && pick === k, rel = k !== null && also.has(k);
      let v = chosen ? { yes: true, confidence: conf } : rel ? { yes: true, confidence: 0.7 * conf } : { yes: false, confidence: 0.5 * clamp01(Number(ans.confidence ?? 0.5)) };
      // Narrow a long window only to a time well inside it (a time at its edge is the model echoing the window).
      if (chosen && Number.isFinite(tc) && c.kind === "action" && c.t1 - c.t0 > 4 && tc >= c.t0 + 0.75 && tc <= c.t1 - 0.25) {
        place(causes.find((x) => x.id === c.cause) || c);
        v = { yes: true, confidence: 0.5 * conf };
      }
      verdicts[`${q.reaction}|${c.cause}`] = { ...v, confidence: r3(v.confidence), reason: chosen || rel ? ans.reason || "" : "", engine };
    }
    if (pick === "OTHER" && Number.isFinite(tc) && tc >= 0) place(null);
  }
  return { verdicts, reactionChecks, extra };
}

/**
 * The whole document (schema montaj.links/1) from a perception timeline. Without `answers` (the semantic check's
 * reply per reaction, from the service's worker) every link stays «مش متأكد»; with them the links are re-scored.
 * `silences`: suddenSilences of the sound; `hint`: the content type ("challenge", "comedy"…); `verify`: the check's
 * run report ({engine, available, ms…}). The answers are kept in the document so new knobs need no model re-run.
 */
export function buildLinks(tl, { answers = null, controls = null, silences = [], hint = null, verify = null, ...opts } = {}) {
  const o = { ...LINK_DEFAULTS, ...opts };
  const profile = contentProfile(tl, hint);
  const scenes = findScenes(tl);
  const reactions = findReactions(tl, { silences, ...opts });
  const causes = findCauses(tl, reactions);
  const cands = candidates(tl, reactions, causes, { profile: profile.kind, scenes, ...opts });
  let verdicts = {}, reactionChecks = {};
  if (answers) {
    const queries = verifyQueries(tl, { profile, scenes, reactions, causes, links: cands });
    const got = applyAnswers(queries, answers, causes, { engine: verify?.engine ?? null, calibration: calibrationFrom(controls) });
    ({ verdicts, reactionChecks } = got);
    for (const { reaction, cause } of got.extra) {
      causes.push(cause);
      const r = reactions.find((x) => x.id === reaction);
      const tp = Math.max(0.3, timePrior(profile.kind, cause, r, o));
      cands.push({
        reaction, cause: cause.id, prior: r3(clamp01(tp * KIND_WEIGHT[profile.kind][cause.kind])), ...relation(r, cause),
        checks: { samePeople: samePeople(peopleIn(tl, r.t0, r.t1), peopleIn(tl, cause.t0, cause.t1)), sameScene: sceneAt(scenes, cause.t0) === sceneAt(scenes, r.t0) },
      });
    }
  }
  for (const r of reactions) { const rc = reactionChecks[r.id]; r.verified = rc ? { real: rc.real, confidence: rc.confidence } : null; }
  const links = finalizeLinks(cands, verdicts, { ...o, reactionChecks });
  causes.sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  const counts = { reactions: reactions.length, causes: causes.length, links: links.length, best: links.filter((l) => l.best).length, sure: links.filter((l) => l.status === "sure").length };
  return {
    schema: LINKS_SCHEMA,
    media: tl.media ? { path: tl.media.path, name: tl.media.name, hash: tl.media.hash ?? null, duration: tl.media.duration } : null,
    profile, scenes, reactions, causes, links,
    report: { counts, verify: { engine: null, available: false, ...(verify || {}), calibration: calibrationFrom(controls), answers: answers || null, controls: controls || null } },
  };
}

/** The best link of every reaction (what the director uses by default), optionally only from a confidence. */
export const bestLinks = (doc, minConfidence = 0) => (doc?.links || []).filter((l) => l.best && l.confidence >= minConfidence);

// --------------------------------------------------------------------------------------------- the protection rule

const covered = (ranges, t0, t1) => { let s = 0; for (const [a, b] of ranges) s += overlapS(a, b, t0, t1); return t1 > t0 ? s / (t1 - t0) : 1; };

/** Sorted, merged [t0, t1] ranges. */
export function mergeRanges(ranges, joinS = 0) {
  const s = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) { const l = out[out.length - 1]; if (l && a <= l[1] + joinS) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}

/** The links the director protects: best links from `minConfidence` (by default the «متأكد» ones only). */
export function protectedLinks(doc, { minConfidence = LINK_DEFAULTS.sureAt, includeUnsure = false } = {}) {
  const R = new Map(doc.reactions.map((r) => [r.id, r])), C = new Map(doc.causes.map((c) => [c.id, c]));
  return bestLinks(doc).filter((l) => includeUnsure ? l.confidence >= Math.min(minConfidence, 0.3) : l.status === "sure" && l.confidence >= minConfidence)
    .map((l) => ({ link: l, reaction: R.get(l.reaction), cause: C.get(l.cause) })).filter((x) => x.reaction && x.cause);
}

/**
 * Apply the rule to a set of kept source ranges ([[t0, t1]…], seconds; `scale` 1e6 for µs): every protected link
 * whose cause OR reaction is (mostly) kept gets the other one back, and a near link (gap ≤ nearGapS) its gap too.
 * Returns {keeps (merged), added: [{link, t0, t1, why}]}. Long causes (a 12 s action window) are trimmed to the
 * part nearest the reaction (`maxCauseS`), a promise is kept whole.
 */
export function protectKeeps(doc, keeps, { scale = 1, maxCauseS = 6, ...opts } = {}) {
  let ks = mergeRanges(keeps.map(([a, b]) => [a / scale, b / scale]));
  const added = [];
  for (const { link, reaction: r, cause: c } of protectedLinks(doc, opts)) {
    let c0 = c.t0, c1 = c.t1;
    if (c.kind !== "promise" && c1 - c0 > maxCauseS) { if (link.direction === "after") c0 = c1 - maxCauseS; else c1 = c0 + maxCauseS; }
    const rKept = covered(ks, r.t0, r.t1) >= 0.5, cKept = covered(ks, c0, c1) >= 0.5;
    if (!rKept && !cKept) continue;
    const need = [];
    if (!rKept) need.push([r.t0, r.t1, "reaction"]);
    if (covered(ks, c0, c1) < 0.95) need.push([c0, c1, "cause"]);
    if (link.keepGap) {
      const g0 = link.direction === "after" ? c1 : r.t1, g1 = link.direction === "after" ? r.t0 : c0;
      if (g1 > g0 && covered(ks, g0, g1) < 0.95) need.push([g0, g1, "gap"]);
    }
    for (const [a, b, why] of need) { added.push({ link: link.id, t0: r3(a * scale), t1: r3(b * scale), why }); ks = mergeRanges([...ks, [a, b]]); }
  }
  return { keeps: ks.map(([a, b]) => [r3(a * scale), r3(b * scale)]), added };
}

/**
 * Check an edit against the protected links. segments: the output in order, [{t0, t1, hook?}] source spans of this
 * media (seconds; `scale` 1e6 for µs). Violations: cause_lost (the reaction plays, its cause does not play in the
 * body), reaction_lost (the cause plays, the reaction is cut), split (a near link's gap is cut), order (the body plays
 * the reaction before a cause that comes first), hook_cause_missing (the hook borrows a reaction whose cause never
 * plays in its natural place). [{type, link, reaction, cause, message_ar}].
 */
export function checkEdit(doc, segments, { scale = 1, ...opts } = {}) {
  const seg = segments.map((s, i) => ({ t0: s.t0 / scale, t1: s.t1 / scale, hook: !!s.hook, i }));
  const body = seg.filter((s) => !s.hook), hook = seg.filter((s) => s.hook);
  const bodyR = body.map((s) => [s.t0, s.t1]), hookR = hook.map((s) => [s.t0, s.t1]);
  const pos = (t0, t1) => { const s = body.find((x) => overlapS(x.t0, x.t1, t0, t1) > 0); return s ? s.i + (Math.max(t0, s.t0) - s.t0) / Math.max(1e-6, s.t1 - s.t0) : null; };
  const out = [];
  for (const { link, reaction: r, cause: c } of protectedLinks(doc, opts)) {
    const rBody = covered(bodyR, r.t0, r.t1) >= 0.5, rHook = covered(hookR, r.t0, r.t1) >= 0.5, cBody = covered(bodyR, c.t0, c.t1) >= 0.5;
    const v = (type, message_ar) => out.push({ type, link: link.id, reaction: r.id, cause: c.id, message_ar });
    if (rHook && !cBody) v("hook_cause_missing", "الهوك استخدم رد الفعل، والسبب مش راجع في مكانه الطبيعي");
    if (rBody && !cBody) v("cause_lost", "رد الفعل موجود والسبب اتقص");
    if (cBody && !rBody && !rHook) v("reaction_lost", "السبب موجود ورد الفعل اتقص");
    if (rBody && cBody) {
      if (link.keepGap) {
        const g0 = link.direction === "after" ? c.t1 : r.t1, g1 = link.direction === "after" ? r.t0 : c.t0;
        const contiguous = g1 <= g0 || body.some((s) => s.t0 <= g0 + 0.05 && s.t1 >= g1 - 0.05);
        if (!contiguous) v("split", "قطع بين السبب ورد الفعل ضيّع العلاقة");
      }
      const pr = pos(r.t0, r.t1), pc = pos(c.t0, c.t1);
      if (pr !== null && pc !== null && link.direction === "after" && pr < pc) v("order", "رد الفعل بييجي قبل سببه في المونتاج");
    }
  }
  return out;
}

/**
 * The compact view the director (phase 7) reads: the best link of every reaction with its cause and reaction spans
 * inline, and the moments with their roles, in the director's units (`scale` 1e6 = µs of source time). Links under
 * `minConfidence` are left out; «مش متأكد» ones stay unless `sureOnly`.
 */
export function directorView(doc, { scale = 1, minConfidence = 0, sureOnly = false } = {}) {
  const R = new Map(doc.reactions.map((r) => [r.id, r])), C = new Map(doc.causes.map((c) => [c.id, c]));
  const t = (x) => Math.round(x * scale * 1000) / 1000;
  return {
    schema: doc.schema, media: doc.media, profile: doc.profile?.kind ?? null, unit: scale === 1 ? "s" : scale === 1e6 ? "us" : `x${scale}`,
    links: bestLinks(doc, minConfidence).filter((l) => !sureOnly || l.status === "sure").map((l) => {
      const r = R.get(l.reaction), c = C.get(l.cause);
      return {
        id: l.id, status: l.status, label_ar: l.label_ar, confidence: l.confidence, direction: l.direction, gap: t(l.gapS), keepGap: l.keepGap,
        cause: { id: c.id, t0: t(c.t0), t1: t(c.t1), kind: c.kind, text: c.text ?? null },
        reaction: { id: r.id, t0: t(r.t0), t1: t(r.t1), kind: r.kind, kinds: r.kinds, strength: r.strength, real: r.verified?.real ?? null },
      };
    }),
    moments: (doc.moments || []).map((m) => ({ id: m.id, t0: t(m.t0), t1: t(m.t1), role: m.role, roleConfidence: m.roleConfidence, links: m.links })),
  };
}
