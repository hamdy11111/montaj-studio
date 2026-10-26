// Draws word-timed caption pages (templates in core/captionTemplates.js). The same functions feed the live preview
// and the exporter, so captions look identical in both. Every state of a page is drawn on a canvas of the SAME
// size (room for the pop scale), so the exporter can play the states as one image sequence at a fixed position.
// Words are drawn one by one (each shaped on its own, so Arabic joins correctly) and lines run right-to-left when
// the page is Arabic. The karaoke wipe fills a whole shaped word through a clip rectangle that grows from where the
// word is read first (the right edge in Arabic) — the letters are never split into pieces, so they keep their joins;
// the highlight box is drawn under the words, sliding from the last word's place to the spoken one's. On a vertical
// frame the lines stay inside the platforms' safe zone (core/captionTemplates.js SAFE_ZONES).
import { fontStack } from "../../core/fonts.js";
import { CAPTION_TEMPLATES, captionWords, captionStates, stateKey, isArabicText, emphasisFor, safeZone } from "../../core/captionTemplates.js";

const MAX_POP = 1.25;

function layout(text, W, H) {
  const tpl = CAPTION_TEMPLATES[text.caption.template] || CAPTION_TEMPLATES["bold-classic"];
  const ov = text.caption.overrides || {};
  const words = captionWords(text, 0);
  const rtl = isArabicText(words.map((w) => w.t).join(" "));
  const emph = new Set(text.caption.emphasis ?? emphasisFor(words, [], { auto: true }));
  const fontFamily = fontStack(ov.font || tpl.font);
  const g = document.createElement("canvas").getContext("2d");
  // Vertical: between the safe zone's sides (clear of the platform's buttons), the page centred.
  const safe = safeZone(W, H, text.caption.safe || "all");
  const maxW = W * (safe ? Math.min(0.84, 1 - 2 * Math.max(safe.left, safe.right)) : W < H ? 0.84 : 0.7);
  // Landscape frames get larger captions (≈5–6 % of the height, like professional subtitles on 16:9).
  let px = (((ov.size || tpl.size) * H) / 200) * (W > H ? 1.3 : 1);
  const font = (k) => `${tpl.weight} ${Math.max(4, px * k)}px ${fontFamily}`;
  const wordScale = (i) => (emph.has(i) && tpl.accentScale ? tpl.accentScale : 1);
  const measure = () => words.map((w, i) => { g.font = font(wordScale(i)); return g.measureText(w.t).width; });
  let widths, lines;
  for (let attempt = 0; attempt < 8; attempt++) { // shrink until the page fits its line budget
    widths = measure();
    g.font = font(1);
    // Room for the spoken word's pop (drawn up to ~1.2× its size) so it never touches its neighbours.
    const gap = Math.max(g.measureText(" ").width, px * (tpl.highlight === "box" ? 0.6 : 0.36)); // a box needs its own padding too
    lines = [];
    let cur = [], w = 0;
    words.forEach((_, i) => {
      if (tpl.mode === "word") return;
      const add = (cur.length ? gap : 0) + widths[i];
      if (cur.length && w + add > maxW) { lines.push({ idx: cur, w }); cur = [i]; w = widths[i]; } else { cur.push(i); w += add; }
    });
    if (cur.length) lines.push({ idx: cur, w });
    // Two lines: move the break so both lines are about as long (no lone word on the second line).
    if (lines.length === 2) {
      const all = [...lines[0].idx, ...lines[1].idx];
      const lw = (ids) => ids.reduce((s, i, k) => s + widths[i] + (k ? gap : 0), 0);
      let best = null;
      for (let k = 1; k < all.length; k++) {
        const a = lw(all.slice(0, k)), b = lw(all.slice(k));
        if (a <= maxW && b <= maxW && (!best || Math.max(a, b) < best.m)) best = { k, a, b, m: Math.max(a, b) };
      }
      if (best) { lines[0] = { idx: all.slice(0, best.k), w: best.a }; lines[1] = { idx: all.slice(best.k), w: best.b }; }
    }
    lines.gap = gap;
    if (tpl.mode === "word" || lines.length <= tpl.lines || px < 3) break;
    px *= 0.9;
  }
  const lineH = px * 1.3;
  const pad = Math.ceil(px * 0.6);
  // Each word's centre on the content (relative to the page centre) — the box slides between them.
  const pos = [];
  if (tpl.mode !== "word") lines.forEach((line, li) => {
    const y = (li + 0.5 - lines.length / 2) * lineH;
    let x = rtl ? line.w / 2 : -line.w / 2;
    line.idx.forEach((i, k) => {
      const w = widths[i];
      pos[i] = { x: rtl ? x - w / 2 : x + w / 2, y, w };
      x = rtl ? x - w - (k < line.idx.length - 1 ? lines.gap : 0) : x + w + (k < line.idx.length - 1 ? lines.gap : 0);
    });
  });
  const contentW = tpl.mode === "word" ? Math.max(...widths, 1) * (WORD_SCALE_MAX) : Math.max(...lines.map((l) => l.w), 1);
  const contentH = tpl.mode === "word" ? lineH * WORD_SCALE_MAX : lineH * lines.length;
  return { tpl, ov, words, rtl, emph, px, reveal: !!text.caption.reveal, font, wordScale, widths, lines, pos, lineH, pad, cw: Math.ceil(contentW * MAX_POP + pad * 2), ch: Math.ceil(contentH * MAX_POP + pad * 2) };
}
const WORD_SCALE_MAX = 1.25;

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** The highlight box of word i at scale k, centred on (x, y): { x, y, w, h, r } (a pill: fully rounded ends). */
function boxOf(L, i, x, y, k) {
  const { tpl, px } = L;
  const w = L.widths[i] * k;
  return { x: x - w / 2 - px * (tpl.pill ? 0.34 : 0.22), y: y - px * 0.68 * k, w: w + px * (tpl.pill ? 0.68 : 0.44), h: px * 1.32 * k, r: tpl.pill ? px * 0.66 * k : px * 0.22 };
}
function drawBox(g, L, b) {
  g.save(); g.shadowColor = "rgba(0,0,0,0.35)"; g.shadowBlur = L.px * 0.3; g.shadowOffsetY = L.px * 0.06; g.fillStyle = L.ov.activeBox || L.tpl.activeBox;
  roundRect(g, b.x, b.y, b.w, b.h, Math.min(b.r, b.h / 2, b.w / 2)); g.fill(); g.restore();
}

/**
 * One word, shaped whole. active: the spoken word (its colour, its box when the box is not drawn by the page);
 * wipe (0–1): only that share of the word, from where it is read first, takes the active colour (karaoke).
 */
function drawWord(g, L, i, x, y, k, active, { wipe = 1, box = true, sung = false } = {}) {
  const { tpl, ov, px } = L;
  const t = L.words[i].t;
  g.font = L.font(L.wordScale(i) * k);
  const rtl = isArabicText(t);
  g.direction = rtl ? "rtl" : "ltr";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const w = g.measureText(t).width;
  if (active && box && tpl.highlight === "box") drawBox(g, L, boxOf(L, i, x, y, k));
  if (tpl.extrude) { // a hard 3D shadow: the word stacked down-right in the extrude colour
    g.save(); g.fillStyle = tpl.extrude; g.shadowColor = "transparent";
    const steps = Math.max(3, Math.round(px * 0.09 * k));
    for (let s = steps; s >= 1; s--) g.fillText(t, x + s * 0.7, y + s);
    g.restore();
  }
  const lit = ov.active || tpl.active;
  let color = ov.color || tpl.color;
  if (L.emph.has(i)) color = ov.accent || tpl.accent;
  const filled = (active || sung) && tpl.active && tpl.highlight !== "none";
  // Not wiping: the whole word in its colour. Wiping: the base colour, then the said share in the active colour.
  if (filled && (!active || !tpl.wipe || wipe >= 1)) color = lit;
  if (tpl.glow) { g.shadowColor = tpl.glow; g.shadowBlur = px * 0.55; g.shadowOffsetX = 0; g.shadowOffsetY = 0; }
  else if (tpl.shadow) { g.shadowColor = "rgba(0,0,0,0.55)"; g.shadowBlur = px * (tpl.softShadow ? 0.3 : 0.12); g.shadowOffsetX = tpl.softShadow ? 0 : px * 0.04; g.shadowOffsetY = tpl.softShadow ? px * 0.03 : px * 0.05; }
  if (tpl.stroke > 0 && !(active && tpl.highlight === "box")) {
    g.lineJoin = "round"; g.lineWidth = tpl.stroke * px * 2 * k; g.strokeStyle = tpl.strokeColor || "#000"; g.strokeText(t, x, y);
    g.shadowColor = "transparent";
  }
  g.fillStyle = color;
  g.fillText(t, x, y);
  if (tpl.glow) g.fillText(t, x, y);
  g.shadowColor = "transparent";
  if (filled && active && tpl.wipe && wipe > 0 && wipe < 1) {
    const h = px * 1.6 * k, cw = (w + px * 0.2) * wipe;
    g.save();
    g.beginPath();
    g.rect(rtl ? x + w / 2 + px * 0.1 - cw : x - w / 2 - px * 0.1, y - h / 2, cw, h);
    g.clip();
    g.fillStyle = lit;
    g.fillText(t, x, y);
    g.restore();
  }
}

/** Canvas for one state { active, pop, wordPop, wipe, boxFrom, boxK } of a caption page. */
export function captionCanvas(text, W, H, state, L = layout(text, W, H)) {
  const c = document.createElement("canvas");
  c.width = Math.max(2, L.cw); c.height = Math.max(2, L.ch);
  const g = c.getContext("2d");
  const cx = c.width / 2, cy = c.height / 2;
  g.translate(cx, cy); g.scale(state.pop, state.pop); g.translate(-cx, -cy);
  if (L.tpl.mode === "word") {
    const i = Math.max(0, state.active);
    if (L.words[i]) drawWord(g, L, i, cx, cy, state.wordPop, true, { wipe: state.wipe ?? 1 });
    return c;
  }
  const top = cy - (L.lineH * L.lines.length) / 2;
  if (L.tpl.bar) {
    const bw = Math.max(...L.lines.map((l) => l.w)) + L.px * 0.9;
    g.fillStyle = L.tpl.bar; roundRect(g, cx - bw / 2, top - L.px * 0.25, bw, L.lineH * L.lines.length + L.px * 0.5, L.px * 0.3); g.fill();
  }
  // The highlight box, under the words: at the spoken word, or on its way there from the last one.
  const a = state.active, P = (i) => L.pos[i];
  if (L.tpl.highlight === "box" && a >= 0 && P(a)) {
    const to = boxOf(L, a, cx + P(a).x, cy + P(a).y, state.wordPop);
    const fromI = state.boxFrom ?? -1, k = state.boxK ?? 1;
    if (fromI >= 0 && P(fromI) && k < 1) {
      const from = boxOf(L, fromI, cx + P(fromI).x, cy + P(fromI).y, 1);
      const mix = (u, v) => u + (v - u) * k;
      drawBox(g, L, { x: mix(from.x, to.x), y: mix(from.y, to.y), w: mix(from.w, to.w), h: mix(from.h, to.h), r: mix(from.r, to.r) });
    } else drawBox(g, L, to);
  }
  L.lines.forEach((line) => line.idx.forEach((i) => {
    const active = i === a;
    if (L.reveal && i > a) return; // not said yet: keep its place
    drawWord(g, L, i, cx + P(i).x, cy + P(i).y, active ? state.wordPop : 1, active, { wipe: active ? state.wipe ?? 1 : 1, box: false, sung: !!L.tpl.sung && i < a });
  }));
  return c;
}

/** Export: every distinct state of the page as a PNG plus the timed sequence. { caption: true, images, frames: [{ img, durUs }] } */
export function captionFrames(text, W, H, durationUs, fps) {
  const L = layout(text, W, H);
  const states = captionStates(text, durationUs, fps);
  const index = new Map(), images = [], frames = [];
  for (const st of states) {
    const key = stateKey(st);
    if (!index.has(key)) { index.set(key, images.length); images.push(captionCanvas(text, W, H, st, L).toDataURL("image/png")); }
    frames.push({ img: index.get(key), durUs: st.toUs - st.fromUs });
  }
  return { caption: true, images, frames };
}

/** Preview: the state at local time t (µs from the segment start), cached per segment state. */
export function captionStateAt(text, durationUs, fps, tUs) {
  const states = captionStates(text, durationUs, fps);
  return states.find((s) => tUs >= s.fromUs && tUs < s.toUs) || states[states.length - 1] || { active: -1, pop: 1, wordPop: 1 };
}
export { layout as captionLayout, stateKey };
