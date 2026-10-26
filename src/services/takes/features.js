// Per-take measurements for the best-take scorer (core/takeScore.js), from what is already known:
//  · the words of the take (any transcript in source µs: { text, startUs, endUs, conf | confidence | p | probability }):
//    filler words, in-sentence pauses, recogniser confidence, speaking-rate steadiness, the beat before the punchline;
//  · perception's event timeline of the media (phase 4, seconds): who speaks the take, the emotion2vec+ scores, the
//    laughter after it, whether the speaker's face is on screen — and that face's boxes, handed to the Python worker;
//  · the Python worker's measurements (workers/take_features.py): openSMILE voice, DNSMOS, LibreFace / MediaPipe face,
//    L2CS gaze, picture brightness and shake.
// Pure functions; a value that cannot be measured is null (never a guess), so the scorer leaves that signal out.
import { fillers, normWord } from "../../core/speech.js";

const US = 1e6;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const letters = (t) => String(t || "").replace(/[^\p{L}\p{N}]/gu, "").length;

export const wordConf = (w) => num(w.conf ?? w.confidence ?? w.p ?? w.probability);

/** Gaps between the words of a take (s), in order. */
export function gapsOf(ws) {
  const out = [];
  for (let i = 1; i < ws.length; i++) out.push(Math.max(0, (ws[i].startUs - ws[i - 1].endUs) / US));
  return out;
}

/**
 * The beat before the punchline: the longest gap in the second half of the take (the punchline is its last words),
 * minus the typical hesitation gap of the rest of the take — a deliberate beat stands out, an even stammer does not.
 * Capped at 1.2 s, and a gap over 1.5 s counts against (dead air, not a beat). null under 4 words.
 */
export function punchBeat(ws, { minBeat = 0.15 } = {}) {
  if (ws.length < 4) return null;
  const gaps = gapsOf(ws);
  const half = Math.floor(gaps.length / 2);
  const tail = gaps.slice(half);
  const beat = Math.max(...tail);
  const rest = gaps.filter((_, i) => i !== half + tail.indexOf(beat));
  const typical = median(rest) ?? 0;
  if (beat < minBeat) return -typical;
  return Math.min(beat, 1.2) - typical - Math.max(0, beat - 1.5);
}

/**
 * Signals from the words of one take: { fillers, pauses, asrConf, rateSteady, timing }. words: the whole transcript,
 * w0…w1: the take — fillers are found in context (a word is a hesitation only with a pause around it, and the take's
 * edges are not pauses).
 */
export function wordSignals(words, w0 = 0, w1 = words.length - 1, { pauseMin = 0.25 } = {}) {
  const ws = words.slice(w0, w1 + 1);
  if (!ws.length) return { fillers: null, pauses: null, asrConf: null, rateSteady: null, timing: null };
  // «ايه» glued to the word before it is the question word («عايز ايه»), not a hesitation — the recogniser writes no «؟».
  const f = fillers(words).filter((x) => x.i >= w0 && x.i <= w1 && !(normWord(x.text) === "ايه" && x.i > 0 && words[x.i].startUs - words[x.i - 1].endUs < 150_000));
  const fill = (f.filter((x) => x.sure).length + 0.5 * f.filter((x) => !x.sure).length) / ws.length;
  const spoken = Math.max(0.2, (ws[ws.length - 1].endUs - ws[0].startUs) / US);
  const paused = gapsOf(ws).filter((g) => g >= pauseMin).reduce((a, b) => a + b, 0);
  const confs = ws.map(wordConf).filter((c) => c !== null);
  const rates = ws.map((w) => ({ d: (w.endUs - w.startUs) / US, n: letters(w.text) })).filter((x) => x.d >= 0.08 && x.n > 0).map((x) => x.n / x.d);
  const m = mean(rates);
  const cv = rates.length >= 4 && m ? Math.sqrt(mean(rates.map((r) => (r - m) ** 2))) / m : null;
  return { fillers: fill, pauses: paused / spoken, asrConf: confs.length ? mean(confs) : null, rateSteady: cv, timing: punchBeat(ws) };
}

/** Which stages a timeline has (a stage that did not run means "unknown", not "nothing found"). */
export function timelineHas(tl, stage) {
  if (!tl) return false;
  if (tl.report?.stages?.[stage]) return true;
  const types = { audio: ["laughter", "audio_tag", "loudness_spike"], emotion: ["emotion"], faces: ["face_track"], words: ["word"], asd: ["active_speaker"] }[stage] || [];
  return (tl.events || []).some((e) => types.includes(e.type));
}

/** The voice that says most of [t0, t1] (by word time), or null. */
export function takeSpeaker(tl, t0, t1) {
  const by = new Map();
  for (const e of tl?.events || []) if (e.type === "word" && e.speaker && e.t1 > t0 && e.t0 < t1) by.set(e.speaker, (by.get(e.speaker) || 0) + overlap(e.t0, e.t1, t0, t1));
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** The on-screen identity (P1…) of a voice from the timeline's links, or null when off-screen / not linked. */
export function faceOfSpeaker(tl, speaker) {
  if (!tl || !speaker) return null;
  const s = (tl.speakers || []).find((x) => x.id === speaker);
  return s?.face || tl.links?.[speaker]?.face || null;
}

/** Arousal of the emotion2vec+ scores: happy + surprised + angry − neutral − sad (−1…1). */
export const arousal = (sc) => (sc ? (sc.happy || 0) + (sc.surprised || 0) + (sc.angry || 0) - (sc.neutral || 0) - (sc.sad || 0) : null);

const LAUGH_TAGS = /^(laughter|giggle|chuckle|belly laugh|baby laughter|snicker)/i;

/**
 * Signals and context from the event timeline for a take [t0, t1] (s). next: start of the next take (laughter after
 * this one is looked for until shortly after it starts). Returns { signals: { emotion, laughter, onScreen }, speaker,
 * entity, faceBoxes }.
 */
export function timelineSignals(tl, t0, t1, { next = null, after = 3 } = {}) {
  const out = { signals: { emotion: null, laughter: null, onScreen: null }, speaker: null, entity: null, faceBoxes: [] };
  if (!tl) return out;
  const ev = tl.events || [];
  out.speaker = takeSpeaker(tl, t0, t1);
  if (timelineHas(tl, "emotion")) {
    const em = ev.filter((e) => e.type === "emotion" && overlap(e.t0, e.t1, t0, t1) > 0);
    const wsum = em.reduce((a, e) => a + overlap(e.t0, e.t1, t0, t1), 0);
    out.signals.emotion = wsum ? em.reduce((a, e) => a + overlap(e.t0, e.t1, t0, t1) * arousal(e.extra?.scores), 0) / wsum : null;
  }
  if (timelineHas(tl, "audio")) {
    const w0 = t1 - 0.3, w1 = Math.min(t1 + after, next === null ? Infinity : next + 0.5);
    let sec = 0;
    for (const e of ev) {
      if (e.t1 <= w0 || e.t0 >= w1) continue;
      const d = overlap(e.t0, e.t1, w0, w1);
      if (e.type === "laughter") sec += d * (out.speaker && e.speaker === out.speaker ? 1 : 2); // the people around laughing count double
      else if (e.type === "audio_tag" && LAUGH_TAGS.test(String(e.text)) && (e.confidence ?? 0) >= 0.3) sec += d;
    }
    out.signals.laughter = sec;
  }
  out.entity = faceOfSpeaker(tl, out.speaker);
  if (timelineHas(tl, "faces")) {
    if (!out.entity) out.signals.onScreen = out.speaker ? 0 : null;
    else {
      const tracks = ev.filter((e) => e.type === "face_track" && e.entity === out.entity && overlap(e.t0, e.t1, t0, t1) > 0);
      const spans = tracks.map((e) => [Math.max(t0, e.t0), Math.min(t1, e.t1)]).sort((a, b) => a[0] - b[0]);
      let covered = 0, end = t0;
      for (const [a, b] of spans) { if (b > end) { covered += b - Math.max(a, end); end = b; } }
      out.signals.onScreen = covered / Math.max(0.05, t1 - t0);
      out.faceBoxes = tracks.flatMap((e) => (e.extra?.boxes || []).filter((b) => b[0] >= t0 - 0.5 && b[0] <= t1 + 0.5));
    }
  }
  return out;
}

/**
 * Everything the scorer needs for one take: { signals, gate, info }.
 * words: the transcript (µs), w0…w1: the take. tlPart: timelineSignals(…). worker: the Python worker's result for this take (or null).
 */
export function takeFeatures({ words = [], w0 = 0, w1 = words.length - 1, tlPart = null, worker = null } = {}) {
  const w = wordSignals(words, w0, w1);
  const t = tlPart?.signals || {};
  const pr = worker?.prosody || {}, fa = worker?.face || {}, vi = worker?.video || {}, dn = worker?.dnsmos || {};
  const loud = num(pr.loudnessMean);
  const face = fa.frames > 0 && fa.faceFrames > 0;
  const signals = {
    ...w,
    pitchVar: num(pr.pitchVar),
    loudness: loud !== null && loud > 0 ? Math.log2(loud) : null,
    emotion: num(t.emotion),
    quality: num(dn.ovrl),
    smile: face ? num(fa.smile) : null,
    brows: face ? num(fa.brows) : null,
    blinks: face ? num(fa.blinksMidWord) : null,
    onScreen: num(t.onScreen) ?? (fa.frames > 0 && fa.mode === "largest" ? num(fa.faceShare) : null),
    gaze: face ? num(fa.gazeShare) : null,
    laughter: num(t.laughter),
  };
  return {
    signals,
    gate: { ovrl: num(dn.ovrl), luma: num(vi.luma), shake: num(vi.shake) },
    info: { speaker: tlPart?.speaker ?? null, entity: tlPart?.entity ?? null, faceMode: fa.mode ?? null, faceFrames: fa.faceFrames ?? null, frames: fa.frames ?? null, aus: fa.aus ?? null, gazeDeg: fa.gazeDeg ?? null, dnsmos: worker?.dnsmos ?? null, prosody: worker?.prosody ?? null, video: worker?.video ?? null },
  };
}
