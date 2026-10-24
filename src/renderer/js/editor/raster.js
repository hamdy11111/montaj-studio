// Rasterizes text and sticker layers to bitmaps. The same function feeds the live preview and the exporter
// (PNG overlays at the export resolution), so text looks identical in both. Sizes are relative to the frame:
// font px = text.size × H / 200, sticker box = 25 % of the frame's short side, both × the layer scale.
import { stickerUrl, libUrl } from "../api.js";

export const textFontPx = (text, H) => Math.max(4, (text.size || 15) * H / 200);
export const stickerBasePx = (W, H) => Math.round(Math.min(W, H) * 0.25);

function applyCase(s, c) {
  if (c === "upper") return s.toUpperCase();
  if (c === "lower") return s.toLowerCase();
  if (c === "title") return s.replace(/\b\p{L}/gu, (m) => m.toUpperCase());
  return s;
}
const hexA = (hex, a) => { const n = parseInt((hex || "#000000").slice(1, 7), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const isRtl = (s) => /[֐-ࣿיִ-ﻼ]/.test(s);

/** Draw a text block into a new canvas sized to its content. Returns null for empty text. */
export function rasterText(text, W, H) {
  const content = applyCase(String(text?.content ?? ""), text.textCase);
  if (!content.trim()) return null;
  const px = textFontPx(text, H);
  const font = `${text.italic ? "italic " : ""}${text.bold ? "700 " : "400 "}${px}px "${(text.font || "Segoe UI").replace(/"/g, "")}", "Segoe UI", Tahoma, Arial, sans-serif`;
  const lines = content.split(/\r?\n/);
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = font;
  if ("letterSpacing" in meas) meas.letterSpacing = `${(text.letterSpacing || 0) * px / 20}px`;
  const widths = lines.map((l) => meas.measureText(l || " ").width);
  const lineH = px * (1.25 + (text.lineSpacing || 0) / 20);
  const stroke = (text.strokeWidth || 0) * px / 30;
  const pad = Math.ceil(px * 0.25 + stroke + (text.shadow ? px * 0.15 : 0));
  const w = Math.ceil(Math.max(...widths) + pad * 2), hgt = Math.ceil(lineH * lines.length + pad * 2);
  const c = document.createElement("canvas");
  c.width = Math.max(2, w); c.height = Math.max(2, hgt);
  const g = c.getContext("2d");
  g.font = font;
  if ("letterSpacing" in g) g.letterSpacing = meas.letterSpacing;
  g.textBaseline = "middle";
  const dir = text.direction === "rtl" || (text.direction !== "ltr" && isRtl(content)) ? "rtl" : "ltr";
  g.direction = dir;
  if (text.bgOpacity > 0) { g.fillStyle = hexA(text.bgColor, text.bgOpacity / 100); roundRect(g, 0, 0, c.width, c.height, px * 0.2); g.fill(); }
  const align = text.align || "center";
  lines.forEach((line, i) => {
    const y = pad + lineH * (i + 0.5);
    let x;
    if (align === "left") { g.textAlign = "left"; x = pad; } else if (align === "right") { g.textAlign = "right"; x = c.width - pad; } else { g.textAlign = "center"; x = c.width / 2; }
    if (text.shadow) { g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = px * 0.12; g.shadowOffsetX = px * 0.05; g.shadowOffsetY = px * 0.05; }
    if (stroke > 0) { g.lineJoin = "round"; g.lineWidth = stroke * 2; g.strokeStyle = text.strokeColor || "#000"; g.strokeText(line, x, y); }
    g.fillStyle = text.color || "#FFFFFF";
    g.fillText(line, x, y);
    g.shadowColor = "transparent";
    if (text.underline) {
      const lw = widths[i];
      const x0 = g.textAlign === "center" ? x - lw / 2 : g.textAlign === "left" ? x : x - lw;
      g.fillRect(x0, y + px * 0.55, lw, Math.max(1, px / 15));
    }
  });
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

const imageCache = new Map();
/** Load (and cache) an image element with CORS so it can be drawn and read back. */
export function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => { imageCache.delete(src); reject(new Error(`image failed: ${src}`)); };
    img.src = src;
  });
  imageCache.set(src, p);
  return p;
}
export const stickerSrc = (sticker) => (sticker?.assetId ? libUrl(sticker.assetId) : sticker?.builtin ? stickerUrl(sticker.builtin) : null);

/** Sticker bitmap at the frame-relative base size (keeps aspect ratio). */
export async function rasterSticker(sticker, W, H) {
  const src = stickerSrc(sticker);
  if (!src) return null;
  const img = await loadImage(src);
  const base = stickerBasePx(W, H);
  const iw = img.naturalWidth || base, ih = img.naturalHeight || base;
  const k = base / Math.max(iw, ih);
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(iw * k)); c.height = Math.max(2, Math.round(ih * k));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** PNG data URLs for every text / sticker segment of a timeline, rendered at the export size. */
export async function buildOverlays(timeline, W, H, { onlyIds = null } = {}) {
  const out = {};
  for (const tr of timeline.tracks) for (const s of tr.segments) {
    if (onlyIds && !onlyIds.includes(s.id)) continue;
    if (s.kind === "text" && s.text) { const c = rasterText(s.text, W, H); if (c) out[s.id] = c.toDataURL("image/png"); else out[s.id] = blankPng(); }
    else if (s.kind === "sticker" && s.sticker) { try { const c = await rasterSticker(s.sticker, W, H); out[s.id] = c ? c.toDataURL("image/png") : blankPng(); } catch { out[s.id] = blankPng(); } }
  }
  return out;
}
function blankPng() { const c = document.createElement("canvas"); c.width = 2; c.height = 2; return c.toDataURL("image/png"); }
