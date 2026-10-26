// Word-timed caption templates and the pure logic shared by the preview, the exporter and the agents: grouping
// words into pages, the animation state of a page at each frame (the spoken word, how far its karaoke wipe has filled,
// the highlight box sliding from the last word, the spring of a pop), keyword emphasis (one word in 3–5) and the
// platforms' safe zones for vertical video. Drawing lives in renderer/js/editor/captionRaster.js — the preview and the
// export draw the same states with the same code; a caption page is a text segment with text.caption = { template,
// words: [{ t, s, e }] (µs from the segment start), emphasis: [word indices], overrides, reveal (words appear only
// when spoken), safe (platform safe zone: "all" | "tiktok" | "reels" | "shorts" | "none"; default "all" when vertical) }.
import { US } from "./util.js";

const BLACK = "#000000";
/**
 * Template fields: font/weight, size (frame-relative like text.size: px = size × H / 200), color, active (colour of
 * the spoken word), accent (keywords), mode "page" (all words of the page) or "word" (only the spoken word),
 * highlight "color" | "box" | "none", stroke (× font px), shadow, glow, bar (background bar), upper, pop
 * ("page" = the page pops in, "word" = each spoken word pops), wipe (the spoken word fills with `active` in step with
 * its sound, from where it is read first), sung (words already said stay filled), maxWords/maxChars per page, lines,
 * posY per orientation (transform.y, fraction of the frame height from the centre; positive = lower).
 */
export const CAPTION_TEMPLATES = {
  // Premium looks (2026-10): clean creator, bold 3D, punchy one-two words, the active word in a pill.
  "clean-pro": { name: "Clean pro", font: "Noto Sans Arabic", weight: 800, size: 8.6, color: "#FFFFFF", active: "#FFD84D", accent: "#FFD84D", mode: "page", highlight: "color", wipe: true, stroke: 0, shadow: true, softShadow: true, pop: "word", maxWords: 5, maxChars: 28, lines: 2, posY: { portrait: 0.2, landscape: 0.34 }, use: "Premium creator look: clean white, the spoken word in gold, a soft shadow" },
  "bold-3d": { name: "Bold 3D", font: "Alexandria", weight: 900, size: 10, color: "#FFFFFF", active: "#FFE14D", accent: "#FFE14D", mode: "page", highlight: "color", wipe: true, stroke: 0.05, strokeColor: "#1A1033", extrude: "#6C2BD9", pop: "word", maxWords: 4, maxChars: 22, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "Energetic: chunky white letters on a purple 3D shadow" },
  punch: { name: "Punch", font: "Zain", weight: 900, size: 12.5, color: "#FFFFFF", active: "#3EE07B", accent: "#3EE07B", mode: "page", highlight: "color", stroke: 0.2, strokeColor: BLACK, shadow: true, pop: "word", upper: true, maxWords: 3, maxChars: 16, lines: 1, posY: { portrait: 0.16, landscape: 0.3 }, use: "Fast, punchy (Hormozi-style): two or three big words, the spoken one in green" },
  "pill-pop": { name: "Pill pop", font: "Almarai", weight: 800, size: 9.5, color: "#FFFFFF", active: "#FFFFFF", activeBox: "#FF2E63", accent: "#FFD84D", mode: "page", highlight: "box", pill: true, stroke: 0.1, strokeColor: BLACK, shadow: true, pop: "word", maxWords: 4, maxChars: 24, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "Playful: the spoken word jumps into a pink pill" },
  "bold-classic": { name: "Bold classic", font: "Cairo", weight: 800, size: 9, color: "#FFFFFF", active: null, accent: "#FFE14D", mode: "page", highlight: "none", stroke: 0.14, strokeColor: BLACK, shadow: true, pop: "none", maxWords: 7, maxChars: 34, lines: 2, posY: { portrait: 0.2, landscape: 0.34 }, use: "Readable everywhere; safe default" },
  "karaoke-yellow": { name: "Karaoke yellow", font: "Alexandria", weight: 900, size: 10, color: "#FFFFFF", active: "#FFE14D", accent: "#FFE14D", mode: "page", highlight: "color", wipe: true, sung: true, stroke: 0.15, strokeColor: BLACK, shadow: true, pop: "page", maxWords: 5, maxChars: 26, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "Reels/TikTok talking head: the spoken word lights up" },
  "box-highlight": { name: "Box highlight", font: "Readex Pro", weight: 900, size: 10, color: "#FFFFFF", active: "#FFFFFF", activeBox: "#7B2FF7", accent: "#C9A2FF", mode: "page", highlight: "box", stroke: 0.12, strokeColor: BLACK, shadow: true, pop: "word", maxWords: 4, maxChars: 22, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "High-energy shorts: a coloured box jumps to each word" },
  "single-pop": { name: "Single word pop", font: "Lalezar", weight: 400, size: 15, color: "#FFFFFF", active: "#FFFFFF", accent: "#FFE14D", mode: "word", highlight: "none", stroke: 0.16, strokeColor: BLACK, shadow: true, pop: "word", upper: true, maxWords: 3, maxChars: 18, lines: 1, posY: { portrait: 0.12, landscape: 0.28 }, use: "Fast hooks and punchy edits: one big word at a time" },
  keywords: { name: "Keywords", font: "Tajawal", weight: 800, size: 9, color: "#FFFFFF", active: null, accent: "#3EE07B", accentScale: 1.18, mode: "page", highlight: "none", stroke: 0.13, strokeColor: BLACK, shadow: true, pop: "page", maxWords: 6, maxChars: 30, lines: 2, posY: { portrait: 0.2, landscape: 0.34 }, use: "Educational: important words in colour" },
  "minimal-lower": { name: "Minimal lower", font: "IBM Plex Sans Arabic", weight: 700, size: 6.5, color: "#FFFFFF", active: null, accent: "#FFFFFF", mode: "page", highlight: "none", stroke: 0, shadow: true, softShadow: true, pop: "none", maxWords: 10, maxChars: 44, lines: 2, posY: { portrait: 0.3, landscape: 0.38 }, use: "Calm, interviews, documentary" },
  neon: { name: "Neon", font: "Changa", weight: 800, size: 9.5, color: "#C8FBFF", active: "#FFFFFF", accent: "#FF4FD8", mode: "page", highlight: "color", wipe: true, stroke: 0.05, strokeColor: "#003B44", glow: "#18E4FF", pop: "page", maxWords: 5, maxChars: 26, lines: 2, posY: { portrait: 0.18, landscape: 0.32 }, use: "Night, tech, gaming" },
  "subtitle-bar": { name: "Subtitle bar", font: "IBM Plex Sans Arabic", weight: 500, size: 6.5, color: "#FFFFFF", active: null, accent: "#FFE14D", mode: "page", highlight: "none", stroke: 0, bar: "rgba(0,0,0,0.62)", pop: "none", maxWords: 12, maxChars: 48, lines: 2, posY: { portrait: 0.3, landscape: 0.38 }, use: "Classic subtitles on a dark bar (long-form, translation)" },
};

export const CAPTION_TEMPLATE_IDS = Object.keys(CAPTION_TEMPLATES);
// Motion, eased per frame (never two or three hard frames): a spoken word springs 1.0 → 1.15 → 1.0 over 120 ms, a page
// comes in 0.86 → 1.04 → 1.0 over 160 ms, the highlight box slides to the next word in 110 ms, a wipe fills in 8 steps.
export const SPRING = { word: { from: 1, peak: 1.15, ms: 120 }, page: { from: 0.86, peak: 1.04, ms: 160 }, rise: 0.35 };
export const BOX_SLIDE_MS = 110;
const WIPE_STEPS = 8; // each step is an image of the page in the export: 8 fill a 0.3–0.6 s word every frame or two
const easeOut = (u) => 1 - (1 - u) ** 3;
const easeInOut = (u) => 0.5 - Math.cos(Math.PI * u) / 2;
const r3 = (v) => Math.round(v * 1000) / 1000;
/** Scale of a spring `ms` after it starts: from → peak (ease-out, the first 35 %) → 1 (ease-in-out). */
export function spring(ms, { from, peak, ms: dur } = SPRING.word) {
  if (ms <= 0) return from;
  const u = ms / dur;
  if (u >= 1) return 1;
  return r3(u < SPRING.rise ? from + (peak - from) * easeOut(u / SPRING.rise) : peak + (1 - peak) * easeInOut((u - SPRING.rise) / (1 - SPRING.rise)));
}
/** How far the highlight box has slid from the previous word (0–1, eased) `ms` after the new word starts. */
export const boxSlide = (ms) => (ms <= 0 ? 0 : ms >= BOX_SLIDE_MS ? 1 : r3(easeInOut(ms / BOX_SLIDE_MS)));

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

// Words that are never the emphasis of a page (function words, Egyptian fillers, short English words).
const PLAIN = new Set(["من", "في", "على", "علي", "الى", "الي", "عن", "مع", "ده", "دي", "دا", "كده", "كدا", "انا", "انت", "احنا", "هو", "هي", "هم", "اللي", "ان", "انه", "ما", "لا", "مش", "يعني", "طيب", "بس", "كمان", "برضه", "عشان", "علشان", "لان", "لو", "كل", "هنا", "اه", "ايوه", "كان", "كانت", "ممكن", "لازم", "جدا", "اوي", "زي", "حاجه", "طبعا", "ايه", "و", "ف", "يا", "the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "are", "it", "this", "that", "i", "you", "we", "so", "but", "with", "for", "my", "your"].map((w) => plainKey(w)));
function plainKey(w) { return normKey(w).replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه"); }
/**
 * Indices of the emphasized words of a page — one word in every 3–5: a page of n words gets round(n / 4), at least one
 * from 3 words up; a shorter page only for a keyword or a number. Chosen by an explicit keyword, then (auto) a number,
 * then the longest content word; two emphasized words are never side by side.
 */
export function emphasisFor(words, keywords = [], { auto = true } = {}) {
  const keys = new Set(keywords.map(normKey).filter(Boolean));
  const n = words.length;
  const score = words.map((w) => {
    const k = normKey(w.t);
    if (!k) return -1;
    if (keys.has(k)) return 100 + k.length;
    if (auto && /\d/.test(w.t)) return 50;
    if (!auto || PLAIN.has(plainKey(w.t)) || k.length < 3) return -1;
    return Math.min(k.length, 9);
  });
  const want = n < 3 ? 1 : Math.max(1, Math.round(n / 4));
  const out = [];
  for (const i of score.map((_, i) => i).filter((i) => score[i] > 0).sort((a, b) => score[b] - score[a] || a - b)) {
    if (out.length >= want) break;
    if (n < 3 && score[i] < 50) continue; // a one- or two-word page: only a keyword or a number stands out
    if (out.some((j) => Math.abs(j - i) < 2)) continue;
    out.push(i);
  }
  return out.sort((a, b) => a - b);
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
 * Visual states of a caption segment over its duration, sampled per frame and merged where nothing changes:
 * [{ fromUs, toUs, active, pop, wordPop, wipe, boxFrom, boxK }] (µs from the segment start). active = index of the
 * spoken word (-1 before the first); pop = the page's spring scale; wordPop = the active word's spring; wipe = how much
 * of the active word is filled (0–1, karaoke templates); boxFrom / boxK = the word the highlight box slides from and
 * how far it has gone (box templates). The preview and the export play exactly these states.
 */
export function captionStates(text, durationUs, fps = 30) {
  const tpl = CAPTION_TEMPLATES[text?.caption?.template] || CAPTION_TEMPLATES["bold-classic"];
  const words = captionWords(text, durationUs);
  const FRAME = US / fps;
  // reveal: a word appears only once it is spoken (no spoilers); its place on the line is kept.
  const perWord = tpl.highlight !== "none" || tpl.mode === "word" || tpl.pop === "word" || !!text?.caption?.reveal;
  const frames = Math.max(1, Math.ceil(durationUs / FRAME - 1e-6));
  const states = [];
  for (let f = 0; f < frames; f++) {
    const t = f * FRAME;
    let active = -1;
    if (perWord) words.forEach((w, k) => { if (w.s <= t + 1) active = k; });
    if (perWord && active < 0 && words.length) active = 0;
    const w = active >= 0 ? words[active] : null, since = w ? (t - Math.max(0, w.s)) / 1000 : 0;
    const st = {
      fromUs: Math.round(t), toUs: Math.min(durationUs, Math.round((f + 1) * FRAME)), active: perWord ? active : -1,
      pop: tpl.pop === "page" ? spring(t / 1000, SPRING.page) : 1,
      wordPop: tpl.pop === "word" && w ? spring(since, SPRING.word) : 1,
      wipe: tpl.wipe && w ? Math.round(Math.max(0, Math.min(1, (t - w.s) / Math.max(FRAME, w.e - w.s))) * WIPE_STEPS) / WIPE_STEPS : 1,
      boxFrom: -1, boxK: 1,
    };
    if (tpl.highlight === "box" && tpl.mode !== "word" && active > 0) { const k = boxSlide(since); if (k < 1) { st.boxFrom = active - 1; st.boxK = k; } }
    const last = states[states.length - 1];
    if (last && stateKey(last) === stateKey(st)) last.toUs = st.toUs;
    else states.push(st);
  }
  states[states.length - 1].toUs = durationUs;
  return states;
}

export const stateKey = (s) => `${s.active}|${s.pop}|${s.wordPop}|${s.wipe ?? 1}|${s.boxFrom ?? -1}|${s.boxK ?? 1}`;

// Safe zones of the vertical platforms (fractions of a 9:16 frame kept clear of their buttons, captions and bars): the
// common creator guides' numbers for 1080×1920 — TikTok 150 px top, 440 bottom, 60 left, 120 right; Reels 220, 420,
// 60, 120; Shorts 150, 400, 60, 140. "all" is the union (safe on the three). Needs a check on the apps themselves.
export const SAFE_ZONES = {
  tiktok: { top: 0.078, bottom: 0.229, left: 0.056, right: 0.111 },
  reels: { top: 0.115, bottom: 0.219, left: 0.056, right: 0.111 },
  shorts: { top: 0.078, bottom: 0.208, left: 0.056, right: 0.13 },
};
SAFE_ZONES.all = Object.fromEntries(["top", "bottom", "left", "right"].map((k) => [k, Math.max(...Object.values(SAFE_ZONES).map((z) => z[k]))]));
/** The safe zone of a caption on a W×H frame: the platform's on a vertical frame (default "all"), none otherwise. */
export const safeZone = (W, H, platform = "all") => (H > W && platform !== "none" ? SAFE_ZONES[platform] || SAFE_ZONES.all : null);

/**
 * transform.y for a template on a canvas (portrait = taller than wide). On a vertical canvas the page (its lines at
 * their largest pop) is kept inside the platform's safe zone: above the bottom bar, below the top bar.
 */
export const captionPosY = (tplId, canvas, { platform = "all" } = {}) => {
  const tpl = CAPTION_TEMPLATES[tplId] || CAPTION_TEMPLATES["bold-classic"];
  if (!(canvas && canvas.height > canvas.width)) return tpl.posY.landscape;
  const z = safeZone(canvas.width, canvas.height, platform);
  if (!z) return tpl.posY.portrait;
  const half = ((tpl.mode === "word" ? 1 : tpl.lines) * tpl.size * 1.3 * Math.max(SPRING.word.peak, tpl.accentScale || 1)) / 200 / 2; // of the height
  return Math.round(Math.max(z.top - 0.5 + half, Math.min(tpl.posY.portrait, 0.5 - z.bottom - half)) * 1000) / 1000;
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
