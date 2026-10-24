// Layer math shared by the preview compositor (numbers) and the exporter (FFmpeg expressions).
// Every formula is written once against an "algebra" so preview and export cannot drift apart.
// Covers: keyframes with easing (FEAT-037), in/out/combo animations (FEAT-070, FEAT-079), main-track
// transitions (FEAT-093) and transform/opacity (FEAT-036/038).
import { US } from "./util.js";

const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) < 1e-9 ? "0" : String(Number(v.toFixed(6)))) : "0");

/** Numeric backend: values are numbers, `t` is local seconds. */
export const NUM = {
  c: (v) => v,
  add: (...a) => a.reduce((x, y) => x + y, 0),
  sub: (a, b) => a - b,
  mul: (...a) => a.reduce((x, y) => x * y, 1),
  div: (a, b) => a / b,
  sin: Math.sin, abs: Math.abs,
  min: Math.min, max: Math.max,
  clamp01: (a) => Math.min(1, Math.max(0, a)),
  pow2: (a) => a * a,
  when: (cond, yes, no) => (cond ? yes : no),
  lt: (a, b) => a < b,
  between: (x, a, b) => x >= a && x <= b,
};

/** Expression backend: values are FFmpeg expression strings. */
export const EXPR = {
  c: (v) => fmt(v),
  add: (...a) => `(${a.join("+")})`,
  sub: (a, b) => `(${a}-(${b}))`,
  mul: (...a) => `(${a.join("*")})`,
  div: (a, b) => `(${a}/(${b}))`,
  sin: (a) => `sin(${a})`, abs: (a) => `abs(${a})`,
  min: (a, b) => `min(${a},${b})`, max: (a, b) => `max(${a},${b})`,
  clamp01: (a) => `clip(${a},0,1)`,
  pow2: (a) => `pow(${a},2)`,
  when: (cond, yes, no) => `if(${cond},${yes},${no})`,
  lt: (a, b) => `lt(${a},${b})`,
  between: (x, a, b) => `between(${x},${a},${b})`,
};

export const EASINGS = ["linear", "easeIn", "easeOut", "easeInOut"];

function ease(A, name, p) {
  switch (name) {
    case "easeIn": return A.pow2(p);
    case "easeOut": return A.sub(A.c(1), A.pow2(A.sub(A.c(1), p)));
    case "easeInOut": return A.when(A.lt(p, A.c(0.5)), A.mul(A.c(2), A.pow2(p)), A.sub(A.c(1), A.mul(A.c(2), A.pow2(A.sub(A.c(1), p)))));
    default: return p;
  }
}

export const KEYFRAME_PROPS = ["x", "y", "scale", "rotation", "opacity", "volumeDb"];

/** Piecewise keyframe interpolation; returns null when the prop has no keyframes. */
export function keyframeValue(A, seg, prop, t) {
  const ks = (seg.keyframes || []).filter((k) => k.prop === prop).sort((a, b) => a.timeUs - b.timeUs);
  if (!ks.length) return null;
  const sec = (us) => us / US;
  let expr = A.c(ks[ks.length - 1].value);
  for (let i = ks.length - 1; i >= 1; i--) {
    const a = ks[i - 1], b = ks[i];
    const span = Math.max(1e-6, sec(b.timeUs) - sec(a.timeUs));
    const p = A.clamp01(A.div(A.sub(t, A.c(sec(a.timeUs))), A.c(span)));
    const v = A.add(A.c(a.value), A.mul(A.c(b.value - a.value), ease(A, a.easing || "linear", p)));
    expr = A.when(A.lt(t, A.c(sec(b.timeUs))), v, expr);
  }
  return A.when(A.lt(t, A.c(sec(ks[0].timeUs))), A.c(ks[0].value), expr);
}

// ---------------------------------------------------------------- animations
export const ANIMATIONS_IN = ["none", "fade", "zoom_in", "zoom_out", "slide_left", "slide_right", "slide_up", "slide_down", "spin", "pop"];
export const ANIMATIONS_OUT = ANIMATIONS_IN;
export const ANIMATIONS_COMBO = ["none", "pulse", "swing", "bounce", "wobble"];

/** Contribution of an entering (q: 0→1) or leaving (q: 1→0) animation. */
function enterContribution(A, type, q, W, H) {
  const e = ease(A, "easeOut", q);
  const inv = A.sub(A.c(1), e);
  switch (type) {
    case "fade": return { opacity: q };
    case "zoom_in": return { scale: A.add(A.c(0.5), A.mul(A.c(0.5), e)), opacity: q };
    case "zoom_out": return { scale: A.sub(A.c(1.5), A.mul(A.c(0.5), e)), opacity: q };
    case "slide_left": return { dx: A.mul(inv, A.c(W)) };
    case "slide_right": return { dx: A.mul(inv, A.c(-W)) };
    case "slide_up": return { dy: A.mul(inv, A.c(H)) };
    case "slide_down": return { dy: A.mul(inv, A.c(-H)) };
    case "spin": return { rotation: A.mul(inv, A.c(-180)), scale: A.add(A.c(0.3), A.mul(A.c(0.7), e)) };
    case "pop": return { scale: A.when(A.lt(q, A.c(0.7)), A.mul(A.c(1.15 / 0.7), q), A.sub(A.c(1.15), A.mul(A.c(0.15 / 0.3), A.sub(q, A.c(0.7))))) };
    default: return {};
  }
}

function comboContribution(A, type, t, W, H) {
  const TAU = 2 * Math.PI;
  switch (type) {
    case "pulse": return { scale: A.add(A.c(1), A.mul(A.c(0.06), A.sin(A.mul(A.c(TAU), t)))) };
    case "swing": return { rotation: A.mul(A.c(6), A.sin(A.mul(A.c(TAU / 1.2), t))) };
    case "bounce": return { dy: A.mul(A.c(-0.03 * H), A.abs(A.sin(A.mul(A.c(Math.PI / 0.6), t)))) };
    case "wobble": return { dx: A.mul(A.c(0.02 * W), A.sin(A.mul(A.c(TAU / 0.8), t))) };
    default: return {};
  }
}

// ---------------------------------------------------------------- transitions
export const TRANSITIONS = ["none", "dissolve", "fade_black", "slide_left", "slide_right", "slide_up", "slide_down", "push_left", "push_right", "zoom_in", "zoom_out", "spin"];

/** Contribution to the outgoing clip A (role "out") or incoming clip B (role "in") with progress p∈[0,1]. */
function transitionContribution(A, type, role, p, W, H) {
  const e = ease(A, "easeInOut", p);
  const inv = A.sub(A.c(1), e);
  if (role === "in") {
    switch (type) {
      case "dissolve": return { opacity: p };
      case "fade_black": return { opacity: A.clamp01(A.sub(A.mul(A.c(2), p), A.c(1))) };
      case "slide_left": case "push_left": return { dx: A.mul(inv, A.c(W)) };
      case "slide_right": case "push_right": return { dx: A.mul(inv, A.c(-W)) };
      case "slide_up": return { dy: A.mul(inv, A.c(H)) };
      case "slide_down": return { dy: A.mul(inv, A.c(-H)) };
      case "zoom_in": return { scale: A.add(A.c(0.6), A.mul(A.c(0.4), e)), opacity: p };
      case "spin": return { rotation: A.mul(inv, A.c(90)), opacity: p };
      default: return {};
    }
  }
  switch (type) {
    case "fade_black": return { opacity: A.clamp01(A.sub(A.c(1), A.mul(A.c(2), p))) };
    case "push_left": return { dx: A.mul(e, A.c(-W)) };
    case "push_right": return { dx: A.mul(e, A.c(W)) };
    case "zoom_out": return { scale: A.add(A.c(1), A.mul(A.c(0.5), e)), opacity: A.sub(A.c(1), p) };
    default: return {};
  }
}

/**
 * Full layer state at local time t (seconds since the layer's visible start).
 * ctx: { W, H, visibleStart (s, relative to seg.start; negative when a transition pre-roll applies),
 *        transIn: {type, d} | null, transOut: {type, d} | null }
 * transform.x / transform.y (and their keyframes) are stored as fractions of the canvas width / height so the
 * same project renders identically at any preview or export resolution.
 * Returns { x, y, scale, scaleX, scaleY, rotation, opacity } in output pixels / degrees / 0..1.
 */
export function layerState(A, seg, t, ctx) {
  const { W, H } = ctx;
  const tr = seg.transform || {};
  const segDur = seg.duration / US;
  // t is local to seg.start (can be negative during an incoming transition pre-roll).
  const kx = keyframeValue(A, seg, "x", t), ky = keyframeValue(A, seg, "y", t);
  const ks = keyframeValue(A, seg, "scale", t), kr = keyframeValue(A, seg, "rotation", t), ko = keyframeValue(A, seg, "opacity", t);
  let x = A.mul(kx ?? A.c(tr.x || 0), A.c(W));
  let y = A.mul(ky ?? A.c(tr.y || 0), A.c(H));
  let scale = ks ?? A.c(tr.scale ?? 1);
  let rotation = kr ?? A.c(tr.rotation || 0);
  let opacity = ko ?? A.c(tr.opacity ?? 1);
  const apply = (c) => {
    if (c.dx !== undefined) x = A.add(x, c.dx);
    if (c.dy !== undefined) y = A.add(y, c.dy);
    if (c.scale !== undefined) scale = A.mul(scale, c.scale);
    if (c.rotation !== undefined) rotation = A.add(rotation, c.rotation);
    if (c.opacity !== undefined) opacity = A.mul(opacity, c.opacity);
  };
  const an = seg.animation || {};
  if (an.in && an.in.type !== "none") {
    const d = Math.max(0.05, Math.min(segDur, an.in.durationUs / US));
    apply(enterContribution(A, an.in.type, A.clamp01(A.div(t, A.c(d))), W, H));
  }
  if (an.out && an.out.type !== "none") {
    const d = Math.max(0.05, Math.min(segDur, an.out.durationUs / US));
    apply(enterContribution(A, an.out.type, A.clamp01(A.div(A.sub(A.c(segDur), t), A.c(d))), W, H));
  }
  if (an.combo && an.combo.type !== "none") apply(comboContribution(A, an.combo.type, t, W, H));
  if (ctx.transIn && ctx.transIn.type !== "none") {
    const d = ctx.transIn.d;
    apply(transitionContribution(A, ctx.transIn.type, "in", A.clamp01(A.div(A.add(t, A.c(d / 2)), A.c(d))), W, H));
  }
  if (ctx.transOut && ctx.transOut.type !== "none") {
    const d = ctx.transOut.d;
    apply(transitionContribution(A, ctx.transOut.type, "out", A.clamp01(A.div(A.sub(t, A.c(segDur - d / 2)), A.c(d))), W, H));
  }
  const sx = tr.uniform === false ? tr.scaleX ?? 1 : 1, sy = tr.uniform === false ? tr.scaleY ?? 1 : 1;
  return { x, y, scale, scaleX: A.mul(scale, A.c(sx)), scaleY: A.mul(scale, A.c(sy)), rotation, opacity: A.clamp01(opacity) };
}

/** Transition windows for main-track neighbours: returns {transIn, transOut} for the clip at index i. */
export function transitionsFor(mainSegments, i) {
  const seg = mainSegments[i];
  const prev = mainSegments[i - 1];
  const tOut = seg.transitionOut && seg.transitionOut.type !== "none" && mainSegments[i + 1] && Math.abs(mainSegments[i + 1].start - (seg.start + seg.duration)) < 2000
    ? { type: seg.transitionOut.type, d: clampTransition(seg, mainSegments[i + 1]) } : null;
  const tIn = prev && prev.transitionOut && prev.transitionOut.type !== "none" && Math.abs(seg.start - (prev.start + prev.duration)) < 2000
    ? { type: prev.transitionOut.type, d: clampTransition(prev, seg) } : null;
  return { transIn: tIn, transOut: tOut };
}

/** Transition duration (s) may not exceed either neighbour's length. */
export function clampTransition(a, b) {
  return Math.max(0.1, Math.min(a.transitionOut.durationUs / US, a.duration / US, b.duration / US));
}

/** Audio gain (linear) at local time t, combining volume, keyframes and fades (FEAT-058). */
export function gainAt(A, seg, t) {
  const kv = keyframeValue(A, seg, "volumeDb", t);
  const db = kv ?? A.c(seg.volumeDb || 0);
  // 10^(db/20) — in EXPR use pow; in NUM use Math.pow via mul of exp is not available, so special-case.
  let g = A === NUM ? 10 ** (db / 20) : `pow(10,(${db})/20)`;
  const dur = seg.duration / US;
  if (seg.fadeInUs > 0) g = A.mul(g, A.clamp01(A.div(t, A.c(seg.fadeInUs / US))));
  if (seg.fadeOutUs > 0) g = A.mul(g, A.clamp01(A.div(A.sub(A.c(dur), t), A.c(seg.fadeOutUs / US))));
  return g;
}
