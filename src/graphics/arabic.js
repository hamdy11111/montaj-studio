// Arabic text for graphics. The rule (plan §5, "Arabic font"): letters stay joined in every frame, so text is only
// ever split at word boundaries — a word is the smallest unit that animates (a word reveal, an RTL mask wipe, a
// bigger key word). Letter-by-letter motion is not offered. These helpers are shared by the Remotion components
// (which split, emphasise and time words) and by the selection checks (characters, reading time).

const MARKS = /[ً-ْٰـ]/g; // harakat, dagger alef, tatweel: not counted as characters
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Words of a text, never inside a word: spaces split; punctuation stays attached to its word ("فراخ!!"). */
export function splitWords(text) {
  return String(text ?? "").split(/\s+/u).filter(Boolean);
}

/** Lines of a text: an explicit "\n" or " | " starts a new line (inspector fields are one line). */
export const splitLines = (text) => String(text ?? "").split(/\s*(?:\n|\s\|\s)\s*/u).filter(Boolean);

/** Visible characters (no diacritics, no spaces) — what "max characters" in a component contract counts. */
export const visibleChars = (text) => String(text ?? "").replace(MARKS, "").replace(/\s+/gu, "").length;

export const hasArabic = (text) => ARABIC.test(String(text ?? ""));

/** Comparable form of a word (no diacritics/tatweel/punctuation, unified alef/ya/ta marbuta). */
export const normWord = (w) => String(w ?? "").replace(MARKS, "").replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Seconds a viewer needs to read a text on a phone: a fixed glance plus a rate per character (≈ 15 visible Arabic
 * characters a second for short display words, slower for long lines). A component must hold at least this long.
 */
export function readSeconds(text) {
  const n = visibleChars(text);
  if (!n) return 0;
  return Math.round((0.45 + n / (n > 30 ? 12 : 15)) * 100) / 100;
}

const EAST = "٠١٢٣٤٥٦٧٨٩";
/** Western digits → Arabic-Indic digits ("20" → "٢٠"), leaving everything else. */
export const toArabicDigits = (s) => String(s ?? "").replace(/[0-9]/g, (d) => EAST[+d]);
/** A number with thousands separators in Arabic-Indic digits (1234.5 → "١٬٢٣٤٫٥"). */
export function formatNumber(v, dec = 0) {
  const s = (dec ? Number(v).toFixed(dec) : String(Math.round(Number(v) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, "٬").replace(".", "٫");
  return toArabicDigits(s);
}

/**
 * Word timings for a reveal: each word's start (seconds from the graphic start). Given spoken times (ms, one per
 * word) they are used as they are; otherwise the words are spread over `span` seconds.
 */
export function wordTimes(words, { times = [], span = 0.6, start = 0 } = {}) {
  const n = words.length;
  return words.map((_, i) => (Number.isFinite(times[i]) ? times[i] / 1000 : start + (n > 1 ? (span * i) / (n - 1) : 0)));
}

/** Indexes of the words to emphasise: the given words (compared normalised) or, if none, the longest word. */
export function emphasisIndexes(words, emphasis = []) {
  const want = new Set((emphasis || []).map(normWord).filter(Boolean));
  const out = words.map((w, i) => (want.has(normWord(w)) ? i : -1)).filter((i) => i >= 0);
  if (out.length || want.size) return out;
  let best = -1, len = 0;
  words.forEach((w, i) => { const l = visibleChars(w); if (l > len) { len = l; best = i; } });
  return words.length > 2 && best >= 0 ? [best] : [];
}
