// Where a graphic may sit: the platforms' button/caption zones (the same numbers as the edit-hamdy skill's policy,
// platforms.*), the person's face over time, and simple rectangle maths. Rectangles are fractions of the frame
// ({ x, y, w, h }, 0..1) so one rule serves 9:16 and 16:9; pixel rectangles appear only where a frame is measured.

/** Platform zones. block: the app's own buttons/text (a graphic must not draw there); caution: ad margins (a warning).
 * Vertical ones were measured on 1080×1920 (pixels); YouTube's are fractions of a 16:9 frame. */
const PX = (r) => [r[0] / 1080, r[1] / 1920, r[2] / 1080, r[3] / 1920];
export const PLATFORM_ZONES = {
  reels: { block: [[0, 0, 1080, 150], [0, 1620, 1080, 300], [900, 1100, 180, 650]].map(PX), caution: [[0, 0, 1080, 269], [0, 1248, 1080, 672]].map(PX) },
  tiktok: { block: [[0, 0, 1080, 130], [0, 1580, 1080, 340], [940, 840, 140, 860]].map(PX), caution: [[0, 0, 1080, 240], [0, 1260, 1080, 660], [960, 0, 120, 1920]].map(PX) },
  shorts: { block: [[0, 0, 1080, 140], [0, 1580, 1080, 340], [930, 900, 150, 850]].map(PX), caution: [[0, 0, 1080, 288], [0, 1248, 1080, 672], [888, 0, 192, 1920]].map(PX) },
  youtube: { block: [[0, 0.9, 1, 0.1], [0.86, 0, 0.14, 0.12]], caution: [[0, 0, 0.05, 1], [0.95, 0, 0.05, 1], [0, 0, 1, 0.05]] },
};
/** Platforms checked by default: the union of all three for vertical (the safest), YouTube for horizontal. */
export const DEFAULT_PLATFORMS = { vertical: ["reels", "tiktok", "shorts"], horizontal: ["youtube"] };
/** A graphic may touch a block zone's inner edge by this much (fraction of the short side; 40 px on 1080). */
export const EDGE_TOLERANCE = 40 / 1080;
/** Drawn pixels allowed inside a block zone in one frame before it counts (soft edges, shadows), at 1080×1920. */
export const MAX_BLOCK_PIXELS = 400;

export const orientation = (W, H) => (W >= H ? "horizontal" : "vertical");

const asRect = (r) => (Array.isArray(r) ? { x: r[0], y: r[1], w: r[2], h: r[3] } : r);

/** { block: [rect], caution: [rect], platforms } for a frame size and an optional platform list. */
export function platformZones(W, H, platforms) {
  const names = platforms?.length ? platforms : DEFAULT_PLATFORMS[orientation(W, H)];
  const out = { block: [], caution: [], platforms: names };
  for (const n of names) {
    const z = PLATFORM_ZONES[n];
    if (!z) continue;
    out.block.push(...z.block.map(asRect));
    out.caution.push(...z.caution.map(asRect));
  }
  return out;
}

/**
 * The content-safe rectangle: the frame minus the block bands at the top and bottom and the button column — the
 * largest rectangle a graphic may use freely. (Block zones that are columns shave the side they are on.)
 */
export function safeRect(W, H, platforms) {
  const { block } = platformZones(W, H, platforms);
  let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
  for (const r of block) {
    const full = r.w >= 0.99, col = r.h >= 0.3 && r.w < 0.5;
    if (full && r.y <= 0.001) y0 = Math.max(y0, r.y + r.h);
    else if (full && r.y + r.h >= 0.999) y1 = Math.min(y1, r.y);
    else if (col && r.x + r.w >= 0.999) x1 = Math.min(x1, r.x);
    else if (col && r.x <= 0.001) x0 = Math.max(x0, r.x + r.w);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export const overlapArea = (a, b) => { const i = intersect(a, b); return i ? area(i) : 0; };
export const union = (a, b) => (!a ? b : !b ? a : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
/** Is a inside b (with a tolerance, fraction of the frame)? */
export const inside = (a, b, tol = 0) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
export const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/**
 * Face boxes over a span. faces: [{ t (s, from the span start), x, y, w, h }] from perception (phase 4), or the app's
 * person track (graphics.js subject.track rows [ms, hx, hy, hw, hh, x0, x1] — head centre and size). Returns the
 * union of the face boxes inside [t0, t1] (null: no face known).
 */
export function faceUnion(faces, t0 = 0, t1 = Infinity) {
  let u = null;
  for (const f of faces || []) {
    const r = Array.isArray(f) ? { t: f[0] / 1000, x: f[1] - f[3] / 2, y: f[2] - f[4] / 2, w: f[3], h: f[4] } : f;
    if (r.t !== undefined && (r.t < t0 - 0.05 || r.t > t1 + 0.05)) continue;
    u = union(u, { x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return u;
}

/**
 * Vertical placement for a box of height h (fraction) in a region, away from the face: the first candidate band
 * (in the region's order of preference) that stays inside the safe rectangle and does not touch the face box.
 * Returns the top y (fraction) and whether it had to give in (no free band).
 */
export function placeY(h, region, { safe, face, margin = 0.02 } = {}) {
  safe = safe || { x: 0, y: 0, w: 1, h: 1 };
  const top = safe.y + margin, bottom = safe.y + safe.h - margin - h, mid = 0.5 - h / 2;
  const prefs = { top: [top, mid, bottom], center: [mid, top, bottom], bottom: [bottom, mid, top], "upper-third": [safe.y + safe.h * 0.22 - h / 2, top, mid, bottom], "lower-third": [safe.y + safe.h * 0.72 - h / 2, bottom, mid, top] }[region] || [mid, top, bottom];
  for (const y of prefs) {
    const yy = Math.max(top, Math.min(bottom, y));
    if (!face || !intersect({ x: 0, y: yy, w: 1, h }, grow(face, margin))) return { y: yy, forced: false };
  }
  // No band free of the face: the band farthest from it.
  const fc = face.y + face.h / 2;
  return { y: fc > 0.5 ? top : bottom, forced: true };
}
