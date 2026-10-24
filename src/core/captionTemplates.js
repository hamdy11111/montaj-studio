// Word-timed caption templates and the pure logic shared by the preview, the exporter and the agents: grouping
// words into pages, the discrete animation states of a page (which word is active, pop frames) and keyword
// emphasis. Drawing lives in renderer/js/editor/captionRaster.js; a caption page is a text segment with
// text.caption = { template, words: [{ t, s, e }] (µs from the segment start), emphasis: [word indices], overrides,
// reveal (words appear only when spoken) }.
import { US } from "./util.js";

const BLACK = "#000000";
/**
 * Template fields: font/weight, size (frame-relative like text.size: px = size × H / 200), color, active (colour of
 * the spoken word), accent (keywords), mode "page" (all words of the page) or "word" (only the spoken word),
 * highlight "color" | "box" | "none", stroke (× font px), shadow, glow, bar (background bar), upper, pop
 * ("page" = the page pops in, "word" = each spoken word pops), maxWords/maxChars per page, lines, posY per
 * orientation (transform.y, fraction of the frame height from the centre; positive = lower).
 */
export const CAPTION_TEMPLATES = {
  "bold-classic": { name: "Bold classic", font: "Segoe UI", weight: 800, size: 9, color: "#FFFFFF", active: null, accent: "#FFE14D", mode: "page", highlight: "none", stroke: 0.14, strokeColor: BLACK, shadow: true, pop: "none", maxWords: 7, maxChars: 34, lines: 2, posY: { portrait: 0.2, landscape: 0.34 }, use: "Readable everywhere; safe default" },
  "karaoke-yellow": { name: "Karaoke yellow", font: "Segoe UI", weight: 900, size: 10, color: "#FFFFFF", active: "#FFE14D", accent: "#FFE14D", mode: "page", highlight: "color", stroke: 0.15, strokeColor: BLACK, shadow: true, pop: "page", maxWords: 5, maxChars: 26, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "Reels/TikTok talking head: the spoken word lights up" },
  "box-highlight": { name: "Box highlight", font: "Segoe UI", weight: 900, size: 10, color: "#FFFFFF", active: "#FFFFFF", activeBox: "#7B2FF7", accent: "#C9A2FF", mode: "page", highlight: "box", stroke: 0.12, strokeColor: BLACK, shadow: true, pop: "word", maxWords: 4, maxChars: 22, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "High-energy shorts: a coloured box jumps to each word" },
  "single-pop": { name: "Single word pop", font: "Segoe UI", weight: 900, size: 15, color: "#FFFFFF", active: "#FFFFFF", accent: "#FFE14D", mode: "word", highlight: "none", stroke: 0.16, strokeColor: BLACK, shadow: true, pop: "word", upper: true, maxWords: 3, maxChars: 18, lines: 1, posY: { portrait: 0.12, landscape: 0.28 }, use: "Fast hooks and punchy edits: one big word at a time" },
  keywords: { name: "Keywords", font: "Segoe UI", weight: 800, size: 9, color: "#FFFFFF", active: null, accent: "#3EE07B", accentScale: 1.18, mode: "page", highlight: "none", stroke: 0.13, strokeColor: BLACK, shadow: true, pop: "page", maxWords: 6, maxChars: 30, lines: 2, posY: { portrait: 0.2, landscape: 0.34 }, use: "Educational: important words in colour" },
  "minimal-lower": { name: "Minimal lower", font: "Segoe UI", weight: 600, size: 6.5, color: "#FFFFFF", active: null, accent: "#FFFFFF", mode: "page", highlight: "none", stroke: 0, shadow: true, softShadow: true, pop: "none", maxWords: 10, maxChars: 44, lines: 2, posY: { portrait: 0.3, landscape: 0.38 }, use: "Calm, interviews, documentary" },
  neon: { name: "Neon", font: "Segoe UI", weight: 800, size: 9.5, color: "#C8FBFF", active: "#FFFFFF", accent: "#FF4FD8", mode: "page", highlight: "color", stroke: 0.05, strokeColor: "#003B44", glow: "#18E4FF", pop: "page", maxWords: 5, maxChars: 26, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "Night, tech, gaming" },
  "subtitle-bar": { name: "Subtitle bar", font: "Segoe UI", weight: 600, size: 6.5, color: "#FFFFFF", active: null, accent: "#FFE14D", mode: "page", highlight: "none", stroke: 0, bar: "rgba(0,0,0,0.62)", pop: "none", maxWords: 12, maxChars: 48, lines: 2, posY: { portrait: 0.3, landscape: 0.38 }, use: "Classic subtitles on a dark bar (long-form, translation)" },
};

export const CAPTION_TEMPLATE_IDS = Object.keys(CAPTION_TEMPLATES);
export const POP_FRAMES = [0.82, 1.08]; // scales of the frames before the settled state (then 1.0)
export const WORD_POP = [1.22, 1.1];

const PUNCT_END = /[.!?؟…,،:;]$/;
const AR = /[؀-ۿ]/;
export const isArabicText = (s) => AR.test(String(s));
const normKey = (w) => String(w || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Group timed words into caption pages: [{ startUs, endUs, words: [{ t, s, e }] (absolute µs) }].
 * A page ends at sentence/clause punctuation, at a pause ≥ pauseUs, or when it would exceed the template's
 * word/character budget or maxPageUs.
 */
export function paginate(words, tplId, { pauseUs = 350_000, maxPageUs = 3_000_000, upper = null, breaksUs = [] } = {}) {
  const tpl = CAPTION_TEMPLATES[tplId] || CAPTION_TEMPLATES["bold-classic"];
  const pages = [];
  let cur = [];
  const chars = (ws) => ws.reduce((n, w) => n + w.t.length + 1, 0);
  const flush = () => { if (cur.length) pages.push({ words: cur }); cur = []; };
  // A cut on the main track also ends a page: words on both sides of a cut are not one thought on screen.
  const cutBetween = (a, b) => breaksUs.some((t) => t > a.s && t <= b.s);
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    const over = prev && (cur.length >= tpl.maxWords || chars(cur) + w.t.length > tpl.maxChars || w.e - cur[0].s > maxPageUs);
    // Over budget but this word closes the sentence: keep it on the page rather than leave it alone on the next.
    const closesSentence = PUNCT_END.test(w.t) && !cutBetween(prev || w, w) && chars(cur) + w.t.length <= tpl.maxChars + 8 && cur.length <= tpl.maxWords;
    if (prev && (w.s - prev.e >= pauseUs || cutBetween(prev, w) || (over && !closesSentence))) flush();
    cur.push(w);
    const next = words[i + 1];
    if (PUNCT_END.test(w.t) && (cur.length >= 2 || !next || cutBetween(w, next))) flush();
  });
  flush();
  // Timing: a page shows from its first word to just before the next page (gaps < 0.6 s are bridged, so the text
  // does not flicker between pages), and at least 0.3 s.
  return pages.map((p, i) => {
    const next = pages[i + 1];
    const startUs = p.words[0].s;
    let endUs = p.words[p.words.length - 1].e;
    const cut = breaksUs.filter((t) => t > endUs - 1 && (!next || t <= next.words[0].s)).sort((a, b) => a - b)[0];
    if (cut !== undefined) endUs = Math.min(endUs + 150_000, cut); // never runs over a cut into the next clip
    else if (next && next.words[0].s - endUs < 600_000) endUs = next.words[0].s;
    else endUs += 150_000;
    return { startUs, endUs: Math.max(endUs, startUs + 300_000), words: p.words.map((w) => ({ ...w, t: upper ?? tpl.upper ? w.t.toUpperCase() : w.t })) };
  });
}

/** Indices of emphasized words of a page: explicit keyword list (normalized match) and, if `auto`, numbers. */
export function emphasisFor(words, keywords = [], { auto = true } = {}) {
  const keys = new Set(keywords.map(normKey).filter(Boolean));
  const out = [];
  words.forEach((w, i) => { const k = normKey(w.t); if (keys.has(k) || (auto && /\d/.test(w.t))) out.push(i); });
  return out;
}

/**
 * The caption words of a segment, kept in step with text.content: if the user edited the text, the new words take
 * the old words' times when the count matches, otherwise the page time is shared by length.
 */
export function captionWords(text, durationUs) {
  const cap = text?.caption;
  if (!cap) return [];
  const words = cap.words || [];
  const parts = String(text.content ?? "").split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  if (parts.length === words.length) return words.map((w, i) => ({ ...w, t: parts[i] }));
  const span0 = words[0]?.s ?? 0, span1 = words.length ? words[words.length - 1].e : durationUs;
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  let at = span0;
  return parts.map((p) => { const d = ((span1 - span0) * (p.length + 1)) / total; const w = { t: p, s: Math.round(at), e: Math.round(at + d) }; at += d; return w; });
}

/**
 * Discrete visual states of a caption segment over its duration: [{ fromUs, toUs, active, pop, wordPop }]
 * (µs from the segment start). active = index of the spoken word (-1 before the first), pop = page pop scale,
 * wordPop = scale of the active word. Consecutive identical states are merged.
 */
export function captionStates(text, durationUs, fps = 30) {
  const tpl = CAPTION_TEMPLATES[text?.caption?.template] || CAPTION_TEMPLATES["bold-classic"];
  const words = captionWords(text, durationUs);
  const FRAME = US / fps;
  const cuts = new Set([0, durationUs]);
  // reveal: a word appears only once it is spoken (no spoilers); its place on the line is kept.
  const perWord = tpl.highlight !== "none" || tpl.mode === "word" || tpl.pop === "word" || !!text?.caption?.reveal;
  if (perWord) for (const w of words) if (w.s > 0 && w.s < durationUs) cuts.add(w.s);
  if (tpl.pop === "page") POP_FRAMES.forEach((_, k) => cuts.add(Math.min(durationUs, Math.round((k + 1) * FRAME))));
  if (tpl.pop === "word") for (const w of words) WORD_POP.forEach((_, k) => { const t = Math.max(0, w.s) + Math.round((k + 1) * FRAME); if (t < durationUs) cuts.add(t); });
  const times = [...cuts].sort((a, b) => a - b);
  const states = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const t = times[i];
    let active = -1;
    if (perWord) words.forEach((w, k) => { if (w.s <= t + 1) active = k; });
    if (perWord && active < 0 && words.length) active = 0;
    const pageFrame = Math.round(t / FRAME);
    const pop = tpl.pop === "page" && pageFrame < POP_FRAMES.length ? POP_FRAMES[pageFrame] : 1;
    let wordPop = 1;
    if (tpl.pop === "word" && active >= 0) { const f = Math.round((t - Math.max(0, words[active].s)) / FRAME); if (f >= 0 && f < WORD_POP.length) wordPop = WORD_POP[f]; }
    const st = { fromUs: t, toUs: times[i + 1], active: perWord ? active : -1, pop, wordPop };
    const last = states[states.length - 1];
    if (last && last.active === st.active && last.pop === st.pop && last.wordPop === st.wordPop) last.toUs = st.toUs;
    else states.push(st);
  }
  return states;
}

export const stateKey = (s) => `${s.active}|${s.pop}|${s.wordPop}`;

/** transform.y for a template on a canvas (portrait = taller than wide). */
export const captionPosY = (tplId, canvas) => {
  const tpl = CAPTION_TEMPLATES[tplId] || CAPTION_TEMPLATES["bold-classic"];
  return canvas && canvas.height > canvas.width ? tpl.posY.portrait : tpl.posY.landscape;
};

/** Reading-speed and layout checks for caption pages: characters per second, words per page, duration. */
export function captionQc(pages) {
  const issues = [];
  let maxCps = 0;
  pages.forEach((p, i) => {
    const chars = p.words.reduce((n, w) => n + w.t.length, 0) + p.words.length - 1;
    const dur = (p.endUs - p.startUs) / US;
    const cps = dur > 0 ? chars / dur : Infinity;
    maxCps = Math.max(maxCps, cps);
    if (cps > 20) issues.push({ page: i, kind: "fast", message: `${cps.toFixed(1)} characters/s (over 20)` });
    if (dur < 0.3) issues.push({ page: i, kind: "short", message: `on screen ${dur.toFixed(2)} s` });
  });
  return { pages: pages.length, maxCps: Math.round(maxCps * 10) / 10, issues };
}
