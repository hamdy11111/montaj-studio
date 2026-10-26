// Time and motion helpers shared by the components (the edit-hamdy kit's own helpers, unchanged in behaviour): every
// motion is a pure function of the current frame, so the Player preview and the render are the same picture.
import { createContext, useContext } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

/** The full frame a graphic is laid out on when only a band of it is rendered ({ W, H } or null: the composition). */
export const FrameContext = createContext(null);

export const cl = (x) => Math.max(0, Math.min(1, x));
/** Progress of the window [a, b] at time t (0..1, linear). */
export const p = (t, a, b) => cl((t - a) / Math.max(1e-6, b - a));
export const outBack = (k, s = 1.9) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
export const outCubic = (k) => 1 - Math.pow(1 - k, 3);
export const inCubic = (k) => k * k * k;
export const lerp = (a, b, k) => a + (b - a) * k;
/** Deterministic noise in [0, 1) (same value for the same i, s on every frame and machine). */
export const rnd = (i, s = 1) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
/** A landing shake: [dx, dy] for `len` seconds after `at`. */
export const shakeXY = (t, at, amp = 18, len = 0.28) => {
  const u = t - at;
  if (u < 0 || u > len) return [0, 0];
  const k = (1 - u / len) * amp;
  return [Math.sin(u * 95) * k, Math.cos(u * 77) * k * 0.6];
};
export const inWin = (t, s, e) => t >= s - 0.001 && t <= e;
export const abs = (s) => ({ position: "absolute", ...s });

/**
 * Seconds since the graphic's start and its window: { t, s, e, W, H, u, k, wide }. W×H is the full frame (also when
 * only a band of it is rendered — FrameContext). u = 1 % of the short side
 * (the numbers kit's unit), k = short side / 1080 (the Punchy kit was designed on 1080×1920 pixels).
 * Components read the frame themselves (never a `t` prop) so wrappers that re-render children at sub-frame times
 * (@remotion/motion-blur) move them correctly.
 */
export function useClock(props = {}) {
  const frame = useCurrentFrame();
  const cfg = useVideoConfig(), frameSize = useContext(FrameContext);
  const { fps, durationInFrames } = cfg, W = frameSize?.W ?? cfg.width, H = frameSize?.H ?? cfg.height;
  const short = Math.min(W, H);
  return { t: frame / fps, s: props.s ?? 0, e: props.e ?? durationInFrames / fps, fps, W, H, u: short / 100, k: short / 1080, wide: W > H };
}

/** Big Arabic text with a thick outline drawn behind the fill (paint-order) and a drop. */
export const outline = (px, stroke = "#0B0B0F") => ({
  WebkitTextStroke: `${px}px ${stroke}`, paintOrder: "stroke fill",
  textShadow: `0 ${px * 0.6}px 0 ${stroke}, 0 ${px * 1.4}px ${px * 2}px rgba(0,0,0,0.45)`,
});

/** CSS font stack for a family: the family, then Arabic-capable fallbacks. */
export const fontStack = (family) => `"${String(family || "Cairo").replace(/"/g, "")}", "Cairo", "Tajawal", "Segoe UI", Tahoma, sans-serif`;
