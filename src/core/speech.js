// Speech analysis on a word-level transcript (source time, µs): sentences, filler words, pauses, retakes and the
// cuts they suggest. Pure functions — used by the agent operations and by the edit planner. Nothing here guesses
// meaning: fillers are matched from fixed lists ("sure" = pure hesitation sounds, "maybe" = words that are often
// fillers but can carry meaning), and a retake is a sentence whose opening words are repeated by the next one.

const AR_DIACRITICS = /[ً-ْٰـ]/g;
/** Comparable form of a word: lower case, no punctuation, no Arabic diacritics/tatweel, unified alef/ya/ta marbuta. */
export function normWord(w) {
  return String(w || "").toLowerCase().replace(AR_DIACRITICS, "").replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const SURE_FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "mm", "mmm", "ah", "ahh", "eh",
  "اه", "اهه", "ااه", "ام", "امم", "اممم", "مم", "ممم", "اا", "ااا", "ايه"].map(normWord));
const MAYBE_FILLERS = new Set(["like", "basically", "actually", "literally", "so", "well", "okay", "ok", "right",
  "يعني", "طيب", "بص", "خلاص", "اوكي", "تمام", "فا", "يا", "بقي", "بقى"].map(normWord));
// "ايه" is a hesitation sound in Egyptian speech when it stands alone between pauses; as a question word it is
// followed directly by speech — handled by requiring a pause around it below.
const NEEDS_PAUSE = new Set(["ايه"].map(normWord));

// Hesitation sounds the recogniser glues to a one-letter prefix (Arabic "بأمم", "وااه") — counted only when isolated.
const FUSED_FILLER = /^[بوف]?(?:ا+م+|م{2,}|ا{2,}|ا+ه+)$/;

const endsSentence = (t) => /[.!?؟…]$/.test(String(t).trim());

/** Sentences: split at end punctuation or at a gap of `gapUs`. Returns [{ w0, w1, startUs, endUs, text }]. */
export function sentences(words, { gapUs = 700_000 } = {}) {
  const out = [];
  let w0 = 0;
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (!next || endsSentence(w.text) || next.startUs - w.endUs >= gapUs) {
      out.push({ w0, w1: i, startUs: words[w0].startUs, endUs: w.endUs, text: words.slice(w0, i + 1).map((x) => x.text).join(" ") });
      w0 = i + 1;
    }
  });
  return out;
}

/** Filler words: [{ i, text, startUs, endUs, sure }]. */
export function fillers(words, { pauseUs = 150_000 } = {}) {
  const out = [];
  words.forEach((w, i) => {
    const n = normWord(w.text);
    if (!n) return;
    const gapBefore = i === 0 ? Infinity : w.startUs - words[i - 1].endUs;
    const gapAfter = i === words.length - 1 ? Infinity : words[i + 1].startUs - w.endUs;
    const isolated = gapBefore >= pauseUs || gapAfter >= pauseUs || /,|،/.test(w.text);
    if (/[?؟]$/.test(String(w.text).trim())) return; // "فطبعا إيه؟" — a question, not a hesitation
    if ((SURE_FILLERS.has(n) && (!NEEDS_PAUSE.has(n) || isolated)) || (FUSED_FILLER.test(n) && isolated)) out.push({ i, text: w.text, startUs: w.startUs, endUs: w.endUs, sure: true });
    else if (MAYBE_FILLERS.has(n)) out.push({ i, text: w.text, startUs: w.startUs, endUs: w.endUs, sure: false });
  });
  return out;
}

/** Gaps between words of at least `minUs` (and leading/trailing silence of the media). */
export function pauses(words, { minUs = 500_000, durationUs = null } = {}) {
  const out = [];
  if (!words.length) return out;
  if (words[0].startUs >= minUs) out.push({ fromUs: 0, toUs: words[0].startUs, durUs: words[0].startUs, edge: "start" });
  for (let i = 1; i < words.length; i++) {
    const g = words[i].startUs - words[i - 1].endUs;
    if (g >= minUs) out.push({ fromUs: words[i - 1].endUs, toUs: words[i].startUs, durUs: g, after: i - 1 });
  }
  const last = words[words.length - 1].endUs;
  if (durationUs && durationUs - last >= minUs) out.push({ fromUs: last, toUs: durationUs, durUs: durationUs - last, edge: "end" });
  return out;
}

/**
 * Retakes: (a) a sentence whose first `minWords` words open the next sentence too (a false start — the speaker
 * started again), and (b) a word or short phrase said twice in a row ("the the", "I want to I want to").
 * Returns [{ kind, fromUs, toUs, w0, w1, text, again }] — the range is the FIRST attempt.
 */
export function retakes(words, sents = sentences(words), { minWords = 3 } = {}) {
  const out = [];
  const n = (i) => normWord(words[i]?.text);
  for (let k = 0; k + 1 < sents.length; k++) {
    const a = sents[k], b = sents[k + 1];
    let same = 0;
    while (a.w0 + same <= a.w1 && b.w0 + same <= b.w1 && n(a.w0 + same) && n(a.w0 + same) === n(b.w0 + same)) same++;
    const lenA = a.w1 - a.w0 + 1;
    if (same >= Math.min(minWords, lenA) && same >= 2) out.push({ kind: "restart", fromUs: a.startUs, toUs: b.startUs, w0: a.w0, w1: a.w1, text: a.text, again: b.text });
  }
  for (let i = 0; i < words.length; i++) {
    for (let len = 4; len >= 1; len--) {
      if (i + 2 * len > words.length) continue;
      let eq = true;
      for (let j = 0; j < len; j++) if (!n(i + j) || n(i + j) !== n(i + len + j)) { eq = false; break; }
      if (!eq) continue;
      if (out.some((r) => r.kind === "restart" && i >= r.w0 && i <= r.w1)) break;
      out.push({ kind: "repeat", fromUs: words[i].startUs, toUs: words[i + len].startUs, w0: i, w1: i + len - 1, text: words.slice(i, i + len).map((w) => w.text).join(" "), again: words.slice(i + len, i + 2 * len).map((w) => w.text).join(" ") });
      i += len - 1;
      break;
    }
  }
  return out.sort((a, b) => a.fromUs - b.fromUs);
}

/** Merge overlapping/adjacent ranges (keeps the first reason). */
export function mergeRanges(ranges, joinUs = 0) {
  const s = [...ranges].filter((r) => r.toUs > r.fromUs).sort((a, b) => a.fromUs - b.fromUs);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.fromUs <= last.toUs + joinUs) { last.toUs = Math.max(last.toUs, r.toUs); if (!last.reasons.includes(r.reason)) last.reasons.push(r.reason); }
    else out.push({ fromUs: r.fromUs, toUs: r.toUs, reasons: [r.reason] });
  }
  return out.map((r) => ({ fromUs: r.fromUs, toUs: r.toUs, reason: r.reasons.join("+") }));
}

export const CUT_STYLES = {
  // keepUs: silence kept on each side of speech at a pause cut; minPauseUs: shortest pause that is cut.
  tight: { minPauseUs: 300_000, keepUs: 80_000 },
  natural: { minPauseUs: 600_000, keepUs: 180_000 },
  // Creator pacing: every pause is cut, but what remains depends on what it is — a beat after a question or an
  // exclamation (comic/dramatic timing), a breath at a sentence end, or a hesitation inside a sentence.
  creator: { minPauseUs: 220_000, keep: { beat: 350_000, sentence: 180_000, mid: 100_000 } },
};

/** What a pause after word `prev` is, for pacing: "beat" (after ?/!), "sentence" (after . or ،) or "mid". */
export const pauseKind = (prev) => (/[?؟!]["»”]?$/.test(prev?.text || "") ? "beat" : /[.،,…:;]["»”]?$/.test(prev?.text || "") ? "sentence" : "mid");

/**
 * Cuts suggested by the analysis, as SOURCE ranges to remove: long pauses (keeping a little air), sure fillers,
 * and retakes (the first attempt). Possible fillers ("maybe") are reported but never cut automatically.
 */
export function suggestCuts(words, { style = "natural", durationUs = null, removeFillers = true, removeRetakes = true, keep = [] } = {}) {
  const st = CUT_STYLES[style] || CUT_STYLES.natural;
  const ranges = [];
  for (const p of pauses(words, { minUs: st.minPauseUs, durationUs })) {
    let from, to, reason = "pause";
    if (st.keep && !p.edge) {
      // Keep 40 % of the air after the word and 60 % before the next (its onset is never clipped).
      const kind = pauseKind(words[p.after]), k = st.keep[kind];
      from = p.fromUs + Math.round(k * 0.4); to = p.toUs - Math.round(k * 0.6);
      if (kind === "beat") reason = "pause (beat kept)";
    } else {
      from = p.edge === "start" ? 0 : p.fromUs + (st.keepUs ?? 80_000);
      to = p.edge === "end" ? p.toUs : p.toUs - (st.keepUs ?? 120_000);
    }
    if (to - from > 80_000) ranges.push({ fromUs: from, toUs: to, reason });
  }
  if (removeFillers) for (const f of fillers(words)) if (f.sure) {
    const prevEnd = f.i > 0 ? words[f.i - 1].endUs : 0, nextStart = f.i < words.length - 1 ? words[f.i + 1].startUs : f.endUs;
    // Cut from just after the previous word to just before the next one, so no half-breath remains.
    ranges.push({ fromUs: Math.max(prevEnd + 20_000, f.startUs - 120_000), toUs: Math.min(nextStart - 20_000, f.endUs + 120_000), reason: "filler" });
  }
  if (removeRetakes) for (const r of retakes(words)) ranges.push({ fromUs: Math.max(0, r.fromUs - 20_000), toUs: r.toUs - 20_000, reason: r.kind === "restart" ? "retake" : "repeat" });
  // Moments the director protects (an action, a reaction, a reveal) are never cut.
  const out = [];
  for (const r of mergeRanges(ranges, 40_000)) {
    let parts = [r];
    for (const [a, b] of keep) parts = parts.flatMap((x) => (b <= x.fromUs || a >= x.toUs ? [x] : [{ ...x, toUs: a }, { ...x, fromUs: b }].filter((y) => y.toUs - y.fromUs > 80_000)));
    out.push(...parts);
  }
  return out;
}

/** Everything at once (what media_analyze_speech returns). */
export function analyzeSpeech(tr, { style = "natural", pauseMinUs = 500_000 } = {}) {
  const words = tr.words || [];
  const sents = sentences(words);
  const speechUs = words.reduce((a, w) => a + (w.endUs - w.startUs), 0);
  const spanUs = words.length ? words[words.length - 1].endUs - words[0].startUs : 0;
  const cuts = suggestCuts(words, { style, durationUs: tr.durationUs });
  const removedUs = cuts.reduce((a, c) => a + (c.toUs - c.fromUs), 0);
  return {
    language: tr.language,
    stats: { words: words.length, sentences: sents.length, durationUs: tr.durationUs, speechUs, wordsPerMinute: spanUs ? Math.round(words.length / (spanUs / 60e6)) : 0, afterCutsUs: tr.durationUs ? tr.durationUs - removedUs : null },
    sentences: sents.map((s, i) => ({ i, startUs: s.startUs, endUs: s.endUs, text: s.text })),
    fillers: fillers(words).map(({ i, ...f }) => ({ word: i, ...f })),
    pauses: pauses(words, { minUs: pauseMinUs, durationUs: tr.durationUs }).map(({ after, ...p }) => p),
    retakes: retakes(words, sents).map(({ w0, w1, ...r }) => r),
    suggestedCuts: cuts,
  };
}

/**
 * Fix recognition mistakes in timed words ([{ t, s, e }]) before captions are built: corrections are
 * [{ from, to }] — a word or phrase matched ignoring case, diacritics and punctuation. The replacement takes the
 * matched words' time span (split evenly between its words) and keeps the sentence-ending punctuation.
 */
export function correctWords(words, corrections = []) {
  let out = words.slice();
  for (const c of corrections) {
    const from = String(c.from || "").split(/\s+/).map(normWord).filter(Boolean);
    const to = String(c.to ?? "").split(/\s+/).filter(Boolean);
    if (!from.length) continue;
    const next = [];
    for (let i = 0; i < out.length;) {
      if (from.every((f, k) => out[i + k] && normWord(out[i + k].t) === f)) {
        const last = out[i + from.length - 1], s = out[i].s, e = last.e;
        const end = /[.!?؟،,…]+$/.exec(last.t)?.[0] || "";
        to.forEach((w, k) => next.push({ ...out[i], t: k === to.length - 1 && end && !/[.!?؟،,…]$/.test(w) ? w + end : w, s: Math.round(s + ((e - s) * k) / to.length), e: Math.round(s + ((e - s) * (k + 1)) / to.length) }));
        i += from.length;
      } else next.push(out[i++]);
    }
    out = next;
  }
  return out;
}

/**
 * Where someone is speaking, in source time: words padded by `padUs` and joined across gaps under `joinUs`.
 * [[fromUs, toUs]] sorted. Used to keep the voice and lower everything between words (breaths, handling noise).
 */
export function speechRegions(words, { padUs = 120_000, joinUs = 350_000 } = {}) {
  const out = [];
  for (const w of [...words].sort((a, b) => a.startUs - b.startUs)) {
    const a = Math.max(0, w.startUs - padUs), b = w.endUs + padUs;
    const last = out[out.length - 1];
    if (last && a - last[1] < joinUs) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

