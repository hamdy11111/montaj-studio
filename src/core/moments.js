// Moments in what is said (from the edit-hamdy skill's 28_moments scan): words of the moments lexicon (longest phrase
// first, a word may be the start of a longer one), a real question («؟» after 3+ words), an exclamation, and the words
// the user marked. Each moment has a type (laugh, shock, win…) and a score — the strength used for zooms, emoji and
// the pacing around punchlines. Pure; times in µs (source time, as the words).
import { MOMENT_TYPES, MOMENT_WORDS } from "./momentsLexicon.js";
import { sentences } from "./speech.js";

/** Comparable Arabic form: no diacritics/tatweel, unified alef/ya/ta marbuta, no punctuation. */
export const normAr = (w) => String(w || "").replace(/[ً-ْـٰ]/g, "").replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
  .replace(/[^\p{L}\p{N}\s]/gu, "").trim();

const PHRASES = Object.entries(MOMENT_WORDS).flatMap(([type, list]) => list.map((p) => [normAr(p), type]))
  .filter(([p]) => p).sort((a, b) => b[0].length - a[0].length);

/** [{ type, s, e, text, score, why }] sorted by time. keywords: words the user marked (scored as "key", 3.0). */
export function detectMoments(words, { keywords = [] } = {}) {
  const out = [];
  const all = ` ${words.map((w) => normAr(w.text)).join(" ")} `;
  const freq = (ph) => Math.max(1, all.split(` ${ph} `).length - 1); // a phrase said 20 times is not a moment
  for (const sn of sentences(words)) {
    const ws = words.slice(sn.w0, sn.w1 + 1);
    const toks = ws.map((w) => normAr(w.text));
    const used = new Set();
    for (const [ph, type] of PHRASES) {
      const pt = ph.split(" ");
      for (let k = 0; k + pt.length <= toks.length; k++) {
        if (pt.some((_, j) => used.has(k + j))) continue;
        if (!pt.every((p, j) => toks[k + j] === p || (p.length > 3 && toks[k + j].startsWith(p)))) continue;
        const w0 = ws[k], w1 = ws[k + pt.length - 1];
        let score = MOMENT_TYPES[type].hook / (1 + 0.5 * Math.log(freq(ph)));
        // A question word counts only at the end of its sentence or with «؟».
        if (type === "question" && !(k + pt.length === ws.length || /[?؟]/.test(w1.text))) score *= 0.4;
        out.push({ type, s: w0.startUs, e: w1.endUs, text: ws.slice(k, k + pt.length).map((w) => w.text).join(" "), score: Math.round(score * 100) / 100, why: `«${ph}»` });
        for (let j = 0; j < pt.length; j++) used.add(k + j);
      }
    }
    let run = 0;
    for (const w of ws) {
      run++;
      if (/[?؟]/.test(w.text)) {
        // A name called out («وفاء؟») or «اه؟» is not a question: a real one is a phrase of 3+ words.
        if (run >= 3 && !out.some((m) => m.s <= w.startUs && w.startUs <= m.e)) out.push({ type: "question", s: w.startUs, e: w.endUs, text: w.text, score: 1.4, why: "«؟»" });
        run = 0;
      } else if (/[.!…،,]/.test(w.text)) run = 0;
      if (w.text.includes("!")) out.push({ type: "shock", s: w.startUs, e: w.endUs, text: w.text, score: 2.0, why: "«!»" });
    }
  }
  const marked = new Set(keywords.map(normAr).filter(Boolean));
  for (const w of words) if (marked.has(normAr(w.text))) out.push({ type: "key", s: w.startUs, e: w.endUs, text: w.text, score: 3.0, why: "a word you marked" });
  return out.sort((a, b) => a.s - b.s);
}

/** Moment types whose zoom is a punch (the "punch/reveal" beats the pacing speeds up to). */
export const isPunch = (m) => MOMENT_TYPES[m.type]?.zoom === "punch" || m.type === "key";
/** Reactions: a breath is kept after them. */
export const isReaction = (m) => m.type === "laugh" || m.type === "shock" || m.type === "oops";
