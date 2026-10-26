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


// ------------------------------------------------------------------ the edit-hamdy pacing (its 26_pace "smart")
// What is taken out of the speech, each with its reason: only stretched hesitations (in Egyptian «اه/أيوه» means yes
// and «يعني/بس» are speech — never removed), a stutter on a function word, a restarted sentence (the first attempt
// broke off and the second one goes on — a deliberate repetition is kept), and the recogniser's known hallucinations.
export const STRETCHED_FILLER = /^[\s.,،…]*(آ{2,}|ا{3,}|إ{2,}|ا?مم+|م{3,}|ه+م{2,}|أ?ه{3,}|uh+|um+|hmm+)[\s.,،…؟?!]*$/i;
const FUNCTION_WORDS = new Set("انا احنا انت انتي هو هي هم في اللي ده دي بس و ف عشان لما يعني كان كنت اه لا ما مش".split(" ").map(normWord));
export const HALLUCINATION = /(ترجمة\s*نانسي|نانسي\s*قنقر|اشتركوا\s*في\s*القناة|اشترك\s*في\s*القناة|لا\s*تنس[وى]ا?\s*الاشتراك|شكرا\s*(لكم\s*)?(على\s*المشاهدة|للمشاهده|للمشاهدة)|تابعونا\s*على|مرحبا\s*بكم\s*في\s*(هذا\s*)?ال?فيديو|[اأ]تمنى\s*[اأ]ن\s*تكون\s*ممتاز|ترجمة\s*و?تدقيق|هل\s*تريد\s*[اأ]ن\s*ترسل|subscribe|thanks\s*for\s*watching)/i;

/** Words removed from the speech: Map(word index → reason). */
export function speechRemovals(words, P = { stutterGap: 0.9, retake: { within: 2.5, pauseBefore: 0.2, flowAfter: 0.4 } }) {
  const out = new Map();
  const n = (i) => normWord(words[i]?.text);
  const S = (s) => s * 1e6;
  words.forEach((w, k) => { if (STRETCHED_FILLER.test(w.text)) out.set(k, "filler"); });
  for (let k = 0; k + 1 < words.length; k++) {
    if (n(k) && n(k) === n(k + 1) && FUNCTION_WORDS.has(n(k)) && words[k + 1].startUs - words[k].endUs < S(P.stutterGap)) out.set(k, "stutter");
  }
  for (let k = 0; k + 3 < words.length; k++) {
    const g1 = [n(k), n(k + 1)];
    if (!g1[0] || !g1[1]) continue;
    for (const j of [k + 2, k + 3]) {
      if (j + 2 >= words.length) continue;
      if (n(j) !== g1[0] || n(j + 1) !== g1[1]) continue;
      if (words[j].startUs - words[k].startUs >= S(P.retake.within)) continue;
      if (endsSentence(words[j - 1].text) || words[j].startUs - words[j - 1].endUs < S(P.retake.pauseBefore)) continue;
      if (!n(j + 2) || words[j + 2].startUs - words[j + 1].endUs >= S(P.retake.flowAfter) || n(j + 2) === n(k + 2)) continue;
      for (let m = k; m < j; m++) if (!out.has(m)) out.set(m, "retake");
      break;
    }
  }
  for (const sn of sentences(words)) if (HALLUCINATION.test(sn.text)) for (let i = sn.w0; i <= sn.w1; i++) out.set(i, "hallucination");
  return out;
}

/**
 * Cuts for the creator rhythm, as the skill paces: the silence kept between two words is baseGap × rhythm, glued after a
 * question (≤ 0.16 s), faster in the 8 s before a punchline/reveal (× 0.7), a breath after a reaction (≥ 0.32 s),
 * never above maxGap; +0.12 s after a sentence end. A longer gap is cut down to that, half kept on each side.
 * pace: POLICY.pace; moments: [{ s, e, punch, reaction }] (µs); keep: protected [[a, b]] (never cut).
 * Returns { cuts: [{ fromUs, toUs, reason }], removed: Map }.
 */
export function smartCuts(words, { pace, rhythm = "mrbeast", durationUs = null, moments = [], keep = [], drop = null } = {}) {
  const S = (s) => Math.round(s * 1e6);
  const removed = speechRemovals(words, pace);
  for (const [i, r] of drop || []) if (!removed.has(i)) removed.set(i, r); // e.g. the sentences a reel leaves out
  const kept = words.map((w, i) => ({ w, i })).filter((x) => !removed.has(x.i));
  const ranges = [];
  if (!kept.length) return { cuts: durationUs ? [{ fromUs: 0, toUs: durationUs, reason: "no speech" }] : [], removed };
  const punches = moments.filter((m) => m.punch).map((m) => m.s);
  const after = moments.filter((m) => m.reaction).map((m) => m.e);
  const rhy = pace.rhythm[rhythm] ?? 1;
  const span = (x) => [Math.max(0, x.w.startUs - S(pace.wordPad.before)), x.w.endUs + S(pace.wordPad.after)];
  const reasonOf = (a, b) => [...new Set(words.map((w, i) => (removed.has(i) && w.startUs < b && w.endUs > a ? removed.get(i) : null)).filter(Boolean))].join("+") || "pause";
  let [, prevEnd] = span(kept[0]);
  const first = span(kept[0])[0];
  if (first > 80_000) ranges.push({ fromUs: 0, toUs: first, reason: reasonOf(0, first) === "pause" ? "pause" : reasonOf(0, first) });
  for (let k = 1; k < kept.length; k++) {
    const [a, b] = span(kept[k]);
    const prevWord = kept[k - 1].w;
    let g = S(pace.baseGap) * rhy;
    if (/[?؟]/.test(prevWord.text)) g = Math.min(g, S(pace.questionGap));
    if (punches.some((p) => p - a > 0 && p - a < S(pace.beforePunch.window))) g *= pace.beforePunch.factor;
    if (after.some((e) => prevEnd - e >= 0 && prevEnd - e < S(pace.afterReaction.window))) g = Math.max(g, S(pace.afterReaction.gap));
    g = Math.min(g, S(pace.maxGap));
    const limit = g + (endsSentence(prevWord.text) ? S(pace.sentenceExtra) : 0);
    const gap = a - prevEnd;
    if (gap > limit) {
      const half = Math.round(g / 2);
      ranges.push({ fromUs: prevEnd + half, toUs: a - half, reason: reasonOf(prevEnd, a) });
    }
    prevEnd = Math.max(prevEnd, b);
  }
  if (durationUs && durationUs - prevEnd > 80_000) ranges.push({ fromUs: prevEnd, toUs: durationUs, reason: reasonOf(prevEnd, durationUs) });
  // Protected moments (something shown without words) are never cut.
  const cuts = [];
  for (const r of ranges.filter((x) => x.toUs - x.fromUs > 80_000)) {
    let parts = [r];
    for (const [a, b] of keep) parts = parts.flatMap((x) => (b <= x.fromUs || a >= x.toUs ? [x] : [{ ...x, toUs: a }, { ...x, fromUs: b }].filter((y) => y.toUs - y.fromUs > 80_000)));
    cuts.push(...parts);
  }
  return { cuts, removed };
}

// ------------------------------------------------------------------ retake groups (by meaning, no performance judging)
// Repeated attempts of the same line, found from the words alone: sentence units, compared by a local alignment of
// their normalised tokens (Smith–Waterman — the same line said again with a word changed, added or dropped still
// aligns), a short attempt whose opening matches a later longer one (a false start / a partial take), and only between
// nearby units with nothing but short asides («تاني», «استنى») between them. The default choice is the LAST complete
// take (what the speaker settled on); phase 5 replaces it with a performance score over the same groups (chooseTake).

/** Token form for alignment: normWord, then a leading «و»/«ف» and the article «ال» dropped (when a stem is left). */
export function alignToken(w) {
  let n = normWord(w);
  if (/^[وف]/.test(n) && n.length >= 5) n = n.slice(1);
  if (n.startsWith("ال") && n.length >= 5) n = n.slice(2);
  return n;
}
function lev1(a, b) { // edit distance ≤ 1?
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
/** Same token: equal, or one letter apart when both have at least 4 letters (recognition / dialect spelling). */
export const sameToken = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 4 && lev1(a, b)));

/**
 * Smith–Waterman local alignment of two token lists (match +2, mismatch −1, gap −1). Returns { score, matches,
 * a: [start, end], b: [start, end] } — the aligned region (inclusive token indices) — or null when nothing aligns.
 */
export function alignTokens(A, B, { match = 2, mismatch = -1, gap = -1 } = {}) {
  const n = A.length, m = B.length;
  if (!n || !m) return null;
  const H = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const v = Math.max(0, H[i - 1][j - 1] + (sameToken(A[i - 1], B[j - 1]) ? match : mismatch), H[i - 1][j] + gap, H[i][j - 1] + gap);
    H[i][j] = v;
    if (v > best) { best = v; bi = i; bj = j; }
  }
  if (!best) return null;
  let i = bi, j = bj, matches = 0, a0 = bi, b0 = bj;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    const same = sameToken(A[i - 1], B[j - 1]);
    if (H[i][j] === H[i - 1][j - 1] + (same ? match : mismatch)) { if (same) matches++; a0 = i; b0 = j; i--; j--; }
    else if (H[i][j] === H[i - 1][j] + gap) { a0 = i; i--; }
    else { b0 = j; j--; }
  }
  return { score: best, matches, a: [a0 - 1, bi - 1], b: [b0 - 1, bj - 1] };
}

/**
 * Sentence units: sentences (end punctuation or a pause ≥ gapUs), each also split where it starts its own opening
 * again after a short pause (a restart inside one breath). [{ w0, w1, startUs, endUs, text, toks }].
 */
export function speechUnits(words, { gapUs = 600_000, restartPauseUs = 150_000 } = {}) {
  const out = [];
  for (const sn of sentences(words, { gapUs })) {
    let w0 = sn.w0;
    for (let j = sn.w0 + 2; j < sn.w1; j++) {
      const a0 = alignToken(words[w0].text), a1 = alignToken(words[w0 + 1].text);
      if (j - w0 >= 2 && a0 && sameToken(alignToken(words[j].text), a0) && sameToken(alignToken(words[j + 1].text), a1) && words[j].startUs - words[j - 1].endUs >= restartPauseUs) {
        out.push({ w0, w1: j - 1 });
        w0 = j;
      }
    }
    out.push({ w0, w1: sn.w1 });
  }
  return out.map((u) => {
    const ws = words.slice(u.w0, u.w1 + 1);
    return { ...u, startUs: ws[0].startUs, endUs: ws[ws.length - 1].endUs, text: ws.map((w) => w.text).join(" "), toks: ws.map((w) => alignToken(w.text)).filter(Boolean) };
  });
}

// Asides between two attempts: a short unit of only these words («تاني», «استنى», «لا لا», «من الأول»…) goes with the retake.
const ASIDE = new Set(["تاني", "تانى", "استني", "استنى", "استنا", "لا", "لأ", "معلش", "خليني", "خلينا", "اعيد", "اعيدها", "هعيد", "نعيد", "نعيدها", "من", "الاول", "الأول", "اول", "كده", "مش", "صح", "اسف", "sorry", "again", "wait", "cut", "اوكي", "طيب", "امم", "اه", "ok", "okay"].map(alignToken));
const isAside = (u) => u.toks.length <= 3 && u.toks.every((t) => ASIDE.has(t) || t.length <= 1);

/**
 * How unit `a` (earlier) relates to unit `b` (later): "full" (the same line again), "partial" / "false-start" (a
 * shorter attempt whose opening matches b's opening), or null.
 */
export function retakeKind(a, b) {
  const la = a.toks.length, lb = b.toks.length;
  if (!la || !lb) return null;
  const al = alignTokens(a.toks, b.toks);
  if (!al || al.matches < 2) return null;
  const short = Math.min(la, lb), long = Math.max(la, lb);
  if (short >= 3 && al.matches >= 3 && al.matches / short >= 0.6 && al.matches / long >= 0.5 && la >= 0.6 * lb) return "full";
  if (la < lb && al.a[0] <= 1 && al.b[0] <= 1 && al.matches / la >= 0.7) return la <= 3 || la <= 0.5 * lb ? "false-start" : "partial";
  return null;
}

/** The take a group keeps: the last complete one; with `score` (phase 5: a performance score per take), the best. */
export function chooseTake(g, score = null) {
  if (score) return g.takes.map((t, i) => ({ i, s: score(t, g) })).sort((x, y) => y.s - x.s || y.i - x.i)[0].i;
  for (let i = g.takes.length - 1; i >= 0; i--) if (g.takes[i].complete) return i;
  return g.takes.length - 1;
}

/**
 * Retake groups of a transcript: [{ line, takes: [{ w0, w1, fromUs, toUs, text, kind, complete }], asides: [{ w0, w1 }],
 * kept, reason }] — takes in time order, kept = chooseTake. A full retake may come up to `withinUs` after the previous
 * attempt, a false start is redone within `falseStartWithinUs`; at most `maxBetween` short asides between attempts.
 */
export function retakeGroups(words, { withinUs = 20_000_000, falseStartWithinUs = 4_000_000, maxBetween = 2, maxTakes = 8, maxSpanUs = 60_000_000, score = null, units = speechUnits(words) } = {}) {
  const parent = units.map((_, i) => i), size = units.map(() => 1), first = units.map((u) => u.startUs);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const link = (i, j) => { // a group stays a handful of attempts within a minute (a line said over and over is a refrain)
    const a = root(i), b = root(j);
    if (a === b) return true;
    if (size[a] + size[b] > maxTakes || units[j].endUs - Math.min(first[a], first[b]) > maxSpanUs) return false;
    parent[a] = b; size[b] += size[a]; first[b] = Math.min(first[a], first[b]);
    return true;
  };
  const linked = new Set();
  const fits = (a, b) => { const kind = retakeKind(a, b); return kind && (kind === "full" || b.startUs - a.endUs <= falseStartWithinUs); };
  for (let j = 1; j < units.length; j++) {
    // Every earlier attempt of the same line, back across other attempts and a few short asides; anything else
    // said in between ends the search (a line said again much later is a deliberate repetition, not a retake).
    for (let i = j - 1, between = 0; i >= 0 && units[j].startUs - units[i].endUs <= withinUs; i--) {
      if (fits(units[i], units[j]) && link(i, j)) { linked.add(i).add(j); continue; }
      if (linked.has(i) && root(i) === root(j)) continue;
      if (!isAside(units[i]) || ++between > maxBetween) break;
    }
  }
  const byRoot = new Map();
  for (const i of [...linked].sort((x, y) => x - y)) { const r = root(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(i); }
  return [...byRoot.values()].map((idx) => {
    const longest = Math.max(...idx.map((i) => units[i].toks.length));
    const last = units[idx[idx.length - 1]];
    const takes = idx.map((i, k) => {
      const u = units[i];
      const kind = k === idx.length - 1 ? "full" : retakeKind(u, units[idx[k + 1]]) || retakeKind(u, last) || "full";
      return { w0: u.w0, w1: u.w1, fromUs: u.startUs, toUs: u.endUs, text: u.text, kind, complete: kind !== "false-start" && u.toks.length >= 0.8 * longest };
    });
    const asides = [];
    for (let i = idx[0] + 1; i < idx[idx.length - 1]; i++) if (!idx.includes(i)) asides.push({ w0: units[i].w0, w1: units[i].w1 });
    const out = { takes, asides };
    out.kept = chooseTake(out, score);
    out.line = takes[out.kept].text;
    out.reason = score ? "best performance" : takes[out.kept].complete ? "last complete take" : "last take (none complete)";
    return out;
  });
}

/** The words retake groups leave out: Map(word index → "retake") — every take but the kept one, and the asides. */
export function retakeDrops(groups) {
  const out = new Map();
  for (const g of groups) {
    g.takes.forEach((t, i) => { if (i !== g.kept) for (let w = t.w0; w <= t.w1; w++) out.set(w, "retake"); });
    for (const a of g.asides) for (let w = a.w0; w <= a.w1; w++) out.set(w, "retake");
  }
  return out;
}
