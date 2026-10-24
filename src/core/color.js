// Colour adjustment (FEAT-071..075, FEAT-094 filters). One parameter model, two implementations:
//  * adjustToFfmpeg(): FFmpeg filter chain for export
//  * makePixelProcessor(): per-pixel function used by the preview compositor
// Parameter ranges: brightness/contrast/saturation/exposure/temperature/tint/highlights/shadows −100..100,
// hue −180..180°, sharpen/vignette 0..100, HSL h −180..180 / s,l −100..100, wheels r,g,b −1..1.
import { DEFAULT_ADJUST, HSL_CHANNELS } from "./model.js";
import { FILTER_PRESETS } from "./presets.js";
import { sampleLut } from "./lut.js";

const f3 = (v) => Number(v.toFixed(4));
const isIdentityCurve = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);

/** Merge a filter preset (scaled by intensity) into an adjust block. */
export function applyFilterPreset(adjust, preset, intensity = 100) {
  const base = { ...DEFAULT_ADJUST, ...(adjust || {}) };
  const p = FILTER_PRESETS[preset];
  if (!p) return base;
  const k = intensity / 100;
  for (const [key, v] of Object.entries(p.adjust)) base[key] = (base[key] || 0) + v * k;
  return base;
}

export function isDefaultAdjust(a) {
  if (!a || a.enabled === false) return true;
  const scalars = ["brightness", "contrast", "saturation", "exposure", "temperature", "tint", "hue", "sharpen", "vignette", "highlights", "shadows"];
  if (scalars.some((k) => Math.abs(a[k] || 0) > 1e-6)) return false;
  if (a.lut?.assetId) return false;
  if (HSL_CHANNELS.some((c) => a.hsl?.[c] && (a.hsl[c].h || a.hsl[c].s || a.hsl[c].l))) return false;
  if (["master", "r", "g", "b"].some((c) => !isIdentityCurve(a.curves?.[c]))) return false;
  if (["shadows", "midtones", "highlights", "offset"].some((r) => a.wheels?.[r] && (a.wheels[r].r || a.wheels[r].g || a.wheels[r].b))) return false;
  return true;
}

const HUESAT_COLORS = { red: "r", orange: "r+y", yellow: "y", green: "g", cyan: "c", blue: "b", purple: "b+m", magenta: "m" };

// eq / hue / unsharp only process YUV. The export chain is RGBA by then, and FFmpeg's implicit conversion would
// use BT.601 (desaturation, for example, then weighted greens/blues by the wrong luma coefficients). Convert
// explicitly with BT.709 — yuva444p keeps the alpha channel of transparent layers.
const inYuv709 = (filter) => `scale=out_color_matrix=bt709:out_range=tv,format=yuva444p,${filter},scale=in_color_matrix=bt709:in_range=tv,format=rgba`;

/** FFmpeg filter strings (comma-joinable, labels already unique via `uid`). */
export function adjustToFfmpeg(a, { lutPath = null, uid = "x", caps = null } = {}) {
  if (isDefaultAdjust(a)) return [];
  const has = (f) => !caps || caps.filters.has(f);
  const out = [];
  if (a.exposure && has("exposure")) out.push(`exposure=exposure=${f3(a.exposure / 50)}`);
  // Brightness / contrast / saturation in RGB with the preview's exact formulas (makePixelProcessor):
  // (c − 0.5)·k + 0.5 + b, then grey = BT.709 luma, c' = grey + s·(c − grey). No YUV round-trip needed.
  if (a.brightness || a.contrast) {
    const k = f3(1 + (a.contrast || 0) / 100), b = f3((a.brightness || 0) / 333);
    const e = `'clip((val/255-0.5)*${k}+0.5+${b},0,1)*255'`;
    out.push(`lutrgb=r=${e}:g=${e}:b=${e}`);
  }
  if (a.saturation) {
    const sat = Math.max(0, 1 + a.saturation / 100), L = [0.2126, 0.7152, 0.0722];
    const row = (i) => L.map((l, j) => f3(l * (1 - sat) + (i === j ? sat : 0)));
    const [r, g, bb] = [row(0), row(1), row(2)];
    out.push(`colorchannelmixer=rr=${r[0]}:rg=${r[1]}:rb=${r[2]}:gr=${g[0]}:gg=${g[1]}:gb=${g[2]}:br=${bb[0]}:bg=${bb[1]}:bb=${bb[2]}`);
  }
  if (a.temperature && has("colortemperature")) out.push(`colortemperature=temperature=${Math.round(6500 - a.temperature * 40)}`);
  if (a.tint) { const k = f3(a.tint / 250); out.push(`colorbalance=rm=${k}:gm=${f3(-a.tint / 250)}:bm=${k}`); }
  if (a.hue) out.push(has("huesaturation") ? `huesaturation=hue=${f3(a.hue)}` : inYuv709(`hue=h=${f3(a.hue)}`));
  if (has("huesaturation")) {
    for (const c of HSL_CHANNELS) {
      const v = a.hsl?.[c];
      if (v && (v.h || v.s || v.l)) out.push(`huesaturation=colors=${HUESAT_COLORS[c]}:hue=${f3(v.h)}:saturation=${f3(v.s / 100)}:intensity=${f3(v.l / 100)}`);
    }
  }
  // Highlights/shadows are folded into the master curve.
  const master = toneCurve(a);
  const curveArgs = [];
  if (!isIdentityCurve(master)) curveArgs.push(`master='${master.map(([x, y]) => `${f3(x)}/${f3(y)}`).join(" ")}'`);
  for (const ch of ["r", "g", "b"]) if (!isIdentityCurve(a.curves?.[ch])) curveArgs.push(`${ch === "r" ? "red" : ch === "g" ? "green" : "blue"}='${a.curves[ch].map(([x, y]) => `${f3(x)}/${f3(y)}`).join(" ")}'`);
  if (curveArgs.length) out.push(`curves=${curveArgs.join(":")}`);
  const w = a.wheels || {};
  const wk = (w.intensity ?? 100) / 100;
  const cb = [];
  for (const [range, p] of [["shadows", "s"], ["midtones", "m"], ["highlights", "h"]]) {
    const v = w[range];
    if (v && (v.r || v.g || v.b)) cb.push(`r${p}=${f3(v.r * wk)}:g${p}=${f3(v.g * wk)}:b${p}=${f3(v.b * wk)}`);
  }
  if (cb.length) out.push(`colorbalance=${cb.join(":")}`);
  if (w.offset && (w.offset.r || w.offset.g || w.offset.b)) out.push(`lutrgb=r='clipval+${f3(w.offset.r * 64 * wk)}':g='clipval+${f3(w.offset.g * 64 * wk)}':b='clipval+${f3(w.offset.b * 64 * wk)}'`);
  if (a.lut?.assetId && lutPath && has("lut3d")) {
    const esc = lutPath.replace(/\\/g, "/").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
    const k = (a.lut.intensity ?? 100) / 100;
    if (k >= 0.999) out.push(`lut3d=file='${esc}':interp=trilinear`);
    else out.push(`split[lA${uid}][lB${uid}];[lB${uid}]lut3d=file='${esc}':interp=trilinear[lC${uid}];[lA${uid}][lC${uid}]blend=all_expr='A*${f3(1 - k)}+B*${f3(k)}'`);
  }
  if (a.sharpen) out.push(inYuv709(`unsharp=5:5:${f3((a.sharpen / 100) * 1.5)}`));
  if (a.vignette) out.push(`vignette=angle=${f3(0.15 + (a.vignette / 100) * 0.6)}`);
  return out;
}

/** Master curve including highlights/shadows offsets. */
export function toneCurve(a) {
  const master = a.curves?.master && !isIdentityCurve(a.curves.master) ? a.curves.master.map((p) => [...p]) : [[0, 0], [1, 1]];
  if (!a.shadows && !a.highlights) return master;
  const at = (x) => evalCurve(master, x);
  const pts = [[0, at(0)], [0.25, clamp01(at(0.25) + (a.shadows || 0) / 400)], [0.5, at(0.5)], [0.75, clamp01(at(0.75) + (a.highlights || 0) / 400)], [1, at(1)]];
  return pts;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Monotone piecewise-linear curve evaluation (used by preview; FFmpeg uses a spline, close enough). */
export function evalCurve(pts, x) {
  if (!pts?.length) return x;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
  return pts[pts.length - 1][1];
}

function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const HSL_CENTERS = { red: 0, orange: 30, yellow: 60, green: 120, cyan: 180, blue: 240, purple: 280, magenta: 310 };

/**
 * Build a fast per-pixel processor for the preview. Returns null when the adjust block is neutral.
 * The processor mutates an RGBA Uint8ClampedArray in place.
 */
export function makePixelProcessor(a, { lut = null, width = 0, height = 0 } = {}) {
  if (isDefaultAdjust(a)) return null;
  const exp = 2 ** ((a.exposure || 0) / 50);
  const bri = (a.brightness || 0) / 333, con = 1 + (a.contrast || 0) / 100, sat = Math.max(0, 1 + (a.saturation || 0) / 100);
  const temp = (a.temperature || 0) / 100, tint = (a.tint || 0) / 250;
  const hueRot = (a.hue || 0) / 360;
  const master = toneCurve(a);
  const curves = { m: master, r: a.curves?.r, g: a.curves?.g, b: a.curves?.b };
  // 256-entry lookup tables for the tone curves.
  const lutM = new Float32Array(256), lutR = new Float32Array(256), lutG = new Float32Array(256), lutB = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const x = i / 255; lutM[i] = evalCurve(curves.m, x); lutR[i] = evalCurve(curves.r, x); lutG[i] = evalCurve(curves.g, x); lutB[i] = evalCurve(curves.b, x); }
  const hslAdj = HSL_CHANNELS.map((c) => ({ c, ...(a.hsl?.[c] || { h: 0, s: 0, l: 0 }) })).filter((v) => v.h || v.s || v.l);
  const w = a.wheels || {}, wk = (w.intensity ?? 100) / 100;
  const wh = ["shadows", "midtones", "highlights"].map((r) => w[r] || { r: 0, g: 0, b: 0 });
  const off = w.offset || { r: 0, g: 0, b: 0 };
  const lutK = (a.lut?.intensity ?? 100) / 100;
  const vig = (a.vignette || 0) / 100;
  return function process(px) {
    for (let i = 0; i < px.length; i += 4) {
      let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      r *= exp; g *= exp; b *= exp;
      r = (r - 0.5) * con + 0.5 + bri; g = (g - 0.5) * con + 0.5 + bri; b = (b - 0.5) * con + 0.5 + bri;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum + (r - lum) * sat; g = lum + (g - lum) * sat; b = lum + (b - lum) * sat;
      if (temp) { r += temp * 0.12; b -= temp * 0.12; }
      if (tint) { r += tint; g -= tint; b += tint; }
      if (hueRot || hslAdj.length) {
        let [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
        h = (h + hueRot + 1) % 1;
        for (const v of hslAdj) {
          const center = HSL_CENTERS[v.c] / 360;
          let d = Math.abs(h - center); d = Math.min(d, 1 - d);
          const wgt = Math.max(0, 1 - d / (30 / 360)) * s;
          if (wgt > 0) { h = (h + (v.h / 360) * wgt + 1) % 1; s = clamp01(s * (1 + (v.s / 100) * wgt)); l = clamp01(l + (v.l / 100) * 0.3 * wgt); }
        }
        [r, g, b] = hslToRgb(h, s, l);
      }
      r = lutM[Math.round(clamp01(r) * 255)]; g = lutM[Math.round(clamp01(g) * 255)]; b = lutM[Math.round(clamp01(b) * 255)];
      r = lutR[Math.round(clamp01(r) * 255)]; g = lutG[Math.round(clamp01(g) * 255)]; b = lutB[Math.round(clamp01(b) * 255)];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const ws = Math.max(0, 1 - L * 2), wm = 1 - Math.abs(L - 0.5) * 2, whh = Math.max(0, L * 2 - 1);
      r += (wh[0].r * ws + wh[1].r * wm + wh[2].r * whh) * 0.25 * wk + off.r * 0.25 * wk;
      g += (wh[0].g * ws + wh[1].g * wm + wh[2].g * whh) * 0.25 * wk + off.g * 0.25 * wk;
      b += (wh[0].b * ws + wh[1].b * wm + wh[2].b * whh) * 0.25 * wk + off.b * 0.25 * wk;
      if (lut) {
        const o = sampleLut(lut, clamp01(r), clamp01(g), clamp01(b));
        r += (o[0] - r) * lutK; g += (o[1] - g) * lutK; b += (o[2] - b) * lutK;
      }
      if (vig && width) {
        const p = i / 4, x = (p % width) / width - 0.5, y = Math.floor(p / width) / height - 0.5;
        const v = 1 - vig * Math.min(1, (x * x + y * y) * 2.2);
        r *= v; g *= v; b *= v;
      }
      px[i] = r * 255; px[i + 1] = g * 255; px[i + 2] = b * 255;
    }
  };
}
