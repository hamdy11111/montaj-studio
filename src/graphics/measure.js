// Measured hard checks: what a rendered graphic really draws, read from its transparent clip (the alpha plane, decoded
// small by FFmpeg). Gives the first visible frame (the sync check), the box it covers while it holds, the drawn pixels
// inside the platforms' block zones (scaled to 1080×1920, the policy's unit) and how much of the face box it covers —
// the numbers selection.hardChecks() uses instead of its predictions.
import { spawn } from "node:child_process";
import { binaries } from "../services/ffmpeg.js";
import { intersect } from "./layout.js";

/** Alpha above this (0–255) counts as drawn — soft shadows and glows below it do not. */
export const ALPHA_ON = 40;

/**
 * Decode the alpha plane of a clip at w×h: Promise<{ frames: Uint8Array[], w, h }>. band ({ x, y, w, h } of a frame
 * W×H, as render.js returns it): the clip is a band of that frame — it is put back in place first, so the numbers
 * are about the whole frame.
 */
export function decodeAlpha(file, { w = 270, h = 480, band = null, W, H, ffmpeg = binaries().ffmpeg } = {}) {
  const place = band && W && H && (band.w !== W || band.h !== H) ? `format=rgba,pad=${W}:${H}:${band.x || 0}:${band.y || 0}:color=black@0,` : "";
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-i", file, "-vf", `${place}scale=${w}:${h}:flags=area,format=rgba,alphaextract`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { windowsHide: true });
    const chunks = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code) return reject(new Error(`ffmpeg alpha decode failed (${code}): ${err.slice(-500)}`));
      const buf = Buffer.concat(chunks), n = Math.floor(buf.length / (w * h));
      resolve({ frames: Array.from({ length: n }, (_, i) => buf.subarray(i * w * h, (i + 1) * w * h)), w, h });
    });
  });
}

/** Box (fractions) and share of drawn pixels of one alpha frame; null box when nothing is drawn. */
export function alphaStats(a, w, h, on = ALPHA_ON) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (a[row + x] > on) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { coverage: n / (w * h), box: n ? { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h } : null };
}

/** Drawn pixels of a frame inside a rectangle (fractions), counted at the frame's size. */
export function drawnIn(a, w, h, r, on = ALPHA_ON) {
  const [X0, X1, Y0, Y1] = pixelRect(r, w, h);
  let n = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) if (a[y * w + x] > on) n++;
  return n;
}
/** Pixel bounds [x0, x1, y0, y1) of a rectangle in fractions (rounding noise of 0.4 + 0.2 does not add a column). */
const pixelRect = (r, w, h) => [Math.max(0, Math.floor(r.x * w + 1e-6)), Math.min(w, Math.ceil((r.x + r.w) * w - 1e-6)), Math.max(0, Math.floor(r.y * h + 1e-6)), Math.min(h, Math.ceil((r.y + r.h) * h - 1e-6))];

/**
 * Measure a decoded clip against a frame context (selection.frameCtx) for an item ({ template, atUs, durUs }) whose
 * template enters over inUs and leaves over outUs. Returns { entryFrame, bbox, zonePixels, faceOverlap, frames }.
 * zones: block rectangles shrunk by the edge tolerance; faces: [{ t, x, y, w, h }] (t seconds from the timeline 0).
 */
export function measureAlpha({ frames, w, h }, { fps, inUs = 0, outUs = 0, atUs = 0, zones = [], faces = [] }) {
  const stats = frames.map((a) => alphaStats(a, w, h));
  const entryFrame = stats.findIndex((s) => s.coverage > 0.0005);
  const holdFrom = Math.max(0, Math.round((inUs / 1e6) * fps)), holdTo = Math.max(holdFrom + 1, frames.length - Math.round((outUs / 1e6) * fps));
  let bbox = null, zonePixels = 0, faceOverlap = 0;
  const scale = (1080 * 1920) / (w * h);
  for (let i = holdFrom; i < holdTo && i < frames.length; i++) {
    const b = stats[i].box;
    if (b) bbox = bbox ? { x: Math.min(bbox.x, b.x), y: Math.min(bbox.y, b.y), w: Math.max(bbox.x + bbox.w, b.x + b.w) - Math.min(bbox.x, b.x), h: Math.max(bbox.y + bbox.h, b.y + b.h) - Math.min(bbox.y, b.y) } : b;
    let z = 0;
    for (const r of zones) z += drawnIn(frames[i], w, h, r);
    zonePixels = Math.max(zonePixels, z * scale);
    const t = atUs / 1e6 + i / fps;
    for (const f of faces) {
      if (f.t !== undefined && Math.abs(f.t - t) > 0.5 / fps + 0.05) continue;
      const fr = { x: f.x, y: f.y, w: f.w, h: f.h }, cut = intersect(fr, { x: 0, y: 0, w: 1, h: 1 });
      if (!cut) continue;
      const [a0, a1, b0, b1] = pixelRect(cut, w, h);
      const covered = drawnIn(frames[i], w, h, cut) / Math.max(1, (a1 - a0) * (b1 - b0));
      faceOverlap = Math.max(faceOverlap, covered);
    }
  }
  return { entryFrame: entryFrame < 0 ? null : entryFrame, bbox, zonePixels: Math.round(zonePixels), faceOverlap: Math.round(faceOverlap * 1000) / 1000, frames: frames.length, coverage: stats.map((s) => s.coverage) };
}

/** Decode + measure a rendered clip. */
export async function measureClip(file, opts) {
  return measureAlpha(await decodeAlpha(file, opts), opts);
}

/**
 * Hard checks on the real picture: render an item (selection.rankNeed's pick: { template, params, atUs, durUs,
 * anchorUs }) with the graphics renderer at the frame's size, measure its clip and run selection.hardChecks with the
 * measured entry, box, drawn pixels in the platform zones and face cover. Returns { ok, checks, measured, clip }.
 */
export async function measuredChecks(item, renderer, fctx) {
  const { hardChecks } = await import("./selection.js");
  const { segmentJob } = await import("./render.js");
  const { KIT_TEMPLATES } = await import("../core/graphicsKit.js");
  const tpl = KIT_TEMPLATES[item.template];
  const job = segmentJob({ seg: { duration: item.durUs }, template: item.template, params: item.params, pack: item.pack || "punchy" }, { width: fctx.W, height: fctx.H, fps: fctx.fps });
  const clip = await renderer.renderJob(job);
  const w = 216, h = Math.round((216 * fctx.H) / fctx.W / 2) * 2;
  const faces = (fctx.faces || []).map((f) => ({ ...f, t: f.t === undefined ? undefined : f.t }));
  const measured = await measureClip(clip.path, { w, h, band: clip, W: fctx.W, H: fctx.H, fps: fctx.fps, inUs: tpl.inUs, outUs: tpl.outUs, atUs: item.atUs, zones: fctx.zones.block, faces });
  const res = hardChecks(item, fctx, measured.entryFrame === null ? { ...measured, entryFrame: undefined } : measured);
  return { ...res, measured: { entryFrame: measured.entryFrame, bbox: measured.bbox, zonePixels: measured.zonePixels, faceOverlap: measured.faceOverlap }, clip };
}
