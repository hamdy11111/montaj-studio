// Speed (FEAT-067..069): standard constant speed and speed curves (piecewise-linear speed over the clip).
// A curve is a list of [x, speed] points with x in 0..1 across the clip's timeline duration.
import { clamp } from "./util.js";

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 100;

/** Curve presets named as in the report (values are this app's own design). */
export const CURVE_PRESETS = {
  none: [],
  custom: [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]],
  montage: [[0, 1], [0.3, 1], [0.4, 3], [0.6, 3], [0.7, 1], [1, 1]],
  hero: [[0, 1], [0.35, 1], [0.45, 0.25], [0.55, 0.25], [0.65, 1], [1, 1]],
  bullet: [[0, 3], [0.4, 3], [0.5, 0.3], [0.6, 3], [1, 3]],
  jump_cut: [[0, 1], [0.45, 1], [0.5, 5], [0.55, 1], [1, 1]],
  flash_in: [[0, 6], [0.35, 1], [1, 1]],
  flash_out: [[0, 1], [0.65, 1], [1, 6]],
};

/** Velocity effects (report FEAT-069) = a speed curve plus a clip effect. */
export const VELOCITY_EFFECTS = {
  none: null,
  flash: { curve: "flash_in", effect: "flash" },
  blur_shake: { curve: "jump_cut", effect: "shake" },
  fade_blur: { curve: "hero", effect: "blur" },
  retro_zoom: { curve: "montage", effect: "zoom_pulse" },
  rainbow: { curve: "bullet", effect: "rgb_split" },
};

export function normalizePoints(points) {
  const pts = (points || []).map(([x, v]) => [clamp(x, 0, 1), clamp(v, SPEED_MIN, SPEED_MAX)]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return [[0, 1], [1, 1]];
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);
  return pts;
}

/** Instantaneous speed at normalized position x. */
export function curveSpeedAt(points, x) {
  const p = normalizePoints(points);
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i][0]) {
      const [x0, v0] = p[i - 1], [x1, v1] = p[i];
      return x1 === x0 ? v1 : v0 + ((v1 - v0) * (x - x0)) / (x1 - x0);
    }
  }
  return p[p.length - 1][1];
}

/** ∫0^x v(u) du for the piecewise-linear curve (exact). */
export function curveIntegral(points, x) {
  const p = normalizePoints(points);
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const [x0, v0] = p[i - 1], [x1, v1] = p[i];
    if (x <= x0) break;
    const xe = Math.min(x, x1);
    const ve = x1 === x0 ? v1 : v0 + ((v1 - v0) * (xe - x0)) / (x1 - x0);
    acc += ((v0 + ve) / 2) * (xe - x0);
    if (x <= x1) break;
  }
  return acc;
}

export const curveMean = (points) => curveIntegral(points, 1);

/** Timeline duration (µs) for a segment showing `sourceDurationUs` of media. */
export function timelineDurationFor(seg, sourceDurationUs) {
  if (seg.speedMode === "curve" && seg.curve?.points?.length) return Math.max(1, Math.round(sourceDurationUs / curveMean(seg.curve.points)));
  return Math.max(1, Math.round(sourceDurationUs / clamp(seg.speed || 1, SPEED_MIN, SPEED_MAX)));
}

/** Source media offset (µs, relative to sourceStart) shown at local timeline time `localUs`. */
export function sourceOffsetAt(seg, localUs) {
  const D = seg.duration;
  if (seg.speedMode === "curve" && seg.curve?.points?.length) {
    const x = clamp(localUs / D, 0, 1);
    return D * curveIntegral(seg.curve.points, x);
  }
  return localUs * (seg.speed || 1);
}

/** Instantaneous playback rate at local time (for the preview <video>.playbackRate). */
export function rateAt(seg, localUs) {
  if (seg.speedMode === "curve" && seg.curve?.points?.length) return curveSpeedAt(seg.curve.points, clamp(localUs / seg.duration, 0, 1));
  return seg.speed || 1;
}

/** Split a curve segment into constant-speed chunks for export (FFmpeg has no variable-speed filter). */
export function curveChunks(seg, chunks = 12) {
  if (!(seg.speedMode === "curve" && seg.curve?.points?.length)) return [{ localStart: 0, localDur: seg.duration, srcStart: 0, srcDur: sourceOffsetAt(seg, seg.duration), speed: seg.speed || 1 }];
  const out = [];
  for (let i = 0; i < chunks; i++) {
    const a = (seg.duration * i) / chunks, b = (seg.duration * (i + 1)) / chunks;
    const sa = sourceOffsetAt(seg, a), sb = sourceOffsetAt(seg, b);
    out.push({ localStart: a, localDur: b - a, srcStart: sa, srcDur: sb - sa, speed: (sb - sa) / (b - a) });
  }
  return out;
}

/** FFmpeg atempo only accepts 0.5..2 per instance (100 in newer builds); chain factors for any speed. */
export function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(Number(s.toFixed(6)));
  return parts.map((p) => `atempo=${p}`).join(",");
}
