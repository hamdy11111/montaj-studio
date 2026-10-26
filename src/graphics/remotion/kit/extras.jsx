// Components built on the official Remotion extras — each one exists to prove its package renders frame-exact here:
//   HandDrawn           @remotion/rough-notation   hand-drawn circle/underline/highlight/box that draws itself
//   GsapTitle           @remotion/gsap             a GSAP timeline seeked from the frame (never GSAP's own ticker)
//   PathArrow           @remotion/paths            an arrow drawn along a curve (evolvePath + tangent for the head)
//   ShapeBurst          @remotion/shapes           a star/burst badge
//   LottieSticker       @remotion/lottie           the pack's Lottie emoji family (Noto Animated)
//   AnimatedEmojiSticker @remotion/animated-emoji  Google's animated emoji as transparent video
//   SwapCard            @remotion/transitions      before → after with a wipe/slide/flip/clock transition
// (@remotion/motion-blur is used by KineticWord and ImpactNumber.)
import React, { useEffect, useState } from "react";
import { continueRender, delayRender, useCurrentFrame } from "remotion";
import { Circle as RCircle, Underline, Highlight, Box as RBox, StrikeThrough, CrossedOff, Bracket } from "@remotion/rough-notation";
import { useGsapTimeline } from "@remotion/gsap";
import { evolvePath, getLength, getPointAtLength, getTangentAtLength } from "@remotion/paths";
import { Star, Circle as SCircle, Triangle } from "@remotion/shapes";
import { Lottie } from "@remotion/lottie";
import { AnimatedEmoji } from "@remotion/animated-emoji";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { wipe } from "@remotion/transitions/wipe";
import { slide } from "@remotion/transitions/slide";
import { flip } from "@remotion/transitions/flip";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { abs, cl, p, outBack, outCubic, inCubic, inWin, outline, useClock, fontStack } from "../motion.js";
import { usePack, useAsset } from "../context.jsx";
import { splitWords } from "../../arabic.js";

const MARKS = { circle: RCircle, underline: Underline, highlight: Highlight, box: RBox, "strike-through": StrikeThrough, "crossed-off": CrossedOff, bracket: Bracket };
const exitOf = (t, e, len = 0.25) => inCubic(p(t, e - len, e));

/* ══ Hand-drawn mark around a spot (draws on over 0.7 s) ══ */
export const HandDrawn = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const Mark = MARKS[P.type] || RCircle;
  const progress = outCubic(p(t, s, s + 0.7)), out = exitOf(t, e);
  const x = P.x * W, y = P.y * H, w = P.w * W, h = P.h * H, color = P.color || pk.colors.accent;
  const extra = P.type === "highlight" ? { color: `${color}88` } : { color, strokeWidth: (P.strokeWidth ?? 7) * K };
  return (
    <div style={{ opacity: 1 - out }}>
      <div style={abs({ left: x, top: y, width: w, height: h })}>
        <Mark progress={progress} seed={7} {...extra} {...(P.type === "bracket" ? { brackets: ["left", "right"] } : {})} {...(P.type === "circle" ? { padding: { left: 18 * K, right: 18 * K, top: 14 * K, bottom: 14 * K } } : {})}>
          <div style={{ width: w, height: h }} />
        </Mark>
      </div>
      {P.label && <div dir="rtl" style={abs({ left: x + w / 2, top: y - 96 * K, transform: `translate(-50%,0) rotate(-4deg) scale(${outBack(p(t, s + 0.45, s + 0.75), 2.2)})`, fontFamily: fontStack(pk.fonts.display), fontSize: 72 * K, color, whiteSpace: "nowrap", ...outline(6 * K, pk.colors.ink) })}>{P.label}</div>}
    </div>
  );
};

/* ══ GSAP title: words fly in with a stagger, an underline sweeps from the right ══ */
export const GsapTitle = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  const words = splitWords(P.text);
  const ref = useGsapTimeline(({ timeline, selector }) => {
    timeline.from(selector(".gw"), { y: 120 * K, opacity: 0, rotate: 8, duration: 0.55, ease: "back.out(2.2)", stagger: 0.09 })
      .from(selector(".gbar"), { scaleX: 0, duration: 0.45, ease: "power3.out" }, "-=0.25")
      .from(selector(".gsub"), { opacity: 0, y: 30 * K, duration: 0.35, ease: "power2.out" }, "-=0.2");
  }, { dependencies: [P.text, P.sub, K] });
  const out = exitOf(t, e, 0.35), color = P.color || pk.colors.paper, accent = P.accent || pk.colors.accent, size = 104 * K;
  return (
    <div ref={ref} style={abs({ left: W * 0.06, right: W * 0.06, top: (P.y ?? 0.3) * H, transform: `translateY(-50%) scale(${1 + 0.1 * out})`, opacity: inWin(t, s, e) ? 1 - out : 0, display: "flex", flexDirection: "column", alignItems: "center" })}>
      <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: size * 0.28 }}>
        {words.map((w, i) => <span key={i} className="gw" style={{ display: "inline-block", fontFamily: fontStack(P.font || "Alexandria"), fontWeight: 900, fontSize: size, color, lineHeight: 1.25, ...outline(size * 0.05, pk.colors.ink) }}>{w}</span>)}
      </div>
      <div className="gbar" style={{ width: "62%", height: 14 * K, borderRadius: 99, background: accent, transformOrigin: "100% 50%", marginTop: 10 * K, boxShadow: "0 6px 16px rgba(0,0,0,.4)" }} />
      {P.sub && <div className="gsub" dir="rtl" style={{ marginTop: 18 * K, fontFamily: fontStack(pk.fonts.body), fontWeight: 700, fontSize: 46 * K, color: "#fff", ...outline(4 * K, pk.colors.ink) }}>{P.sub}</div>}
    </div>
  );
};

/* ══ Arrow drawn along a curve, the head follows the tip ══ */
export const PathArrow = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const x1 = P.x1 * W, y1 = P.y1 * H, x2 = P.x2 * W, y2 = P.y2 * H, bend = P.bend ?? 0.35;
  const mx = (x1 + x2) / 2 - (y2 - y1) * bend, my = (y1 + y2) / 2 + (x2 - x1) * bend;
  const d = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
  const k = outCubic(p(t, s, s + 0.6)), out = exitOf(t, e);
  const { strokeDasharray, strokeDashoffset } = evolvePath(k, d);
  const len = getLength(d), tip = getPointAtLength(d, Math.max(0.001, len * k)), tan = getTangentAtLength(d, Math.max(0.001, len * k));
  const ang = (Math.atan2(tan.y, tan.x) * 180) / Math.PI, color = P.color || pk.colors.accent, sw = (P.width ?? 10) * K, hd = sw * 3.2;
  return (
    <div style={{ opacity: 1 - out }}>
      <svg width={W} height={H} style={abs({ left: 0, top: 0, overflow: "visible", filter: "drop-shadow(0 6px 10px rgba(0,0,0,.45))" })}>
        <path d={d} fill="none" stroke={pk.colors.ink} strokeWidth={sw + 8 * K} strokeLinecap="round" strokeDasharray={strokeDasharray} strokeDashoffset={strokeDashoffset} />
        <path d={d} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeDasharray={strokeDasharray} strokeDashoffset={strokeDashoffset} />
        {k > 0.05 && <polygon points={`0,${-hd / 2} ${hd},0 0,${hd / 2}`} fill={color} stroke={pk.colors.ink} strokeWidth={4 * K} transform={`translate(${tip.x},${tip.y}) rotate(${ang}) translate(${-hd * 0.4},0)`} />}
      </svg>
      {P.label && <div dir="rtl" style={abs({ left: x1, top: y1, transform: `translate(-50%,-115%) rotate(-5deg) scale(${outBack(p(t, s, s + 0.3), 2)})`, fontFamily: fontStack(pk.fonts.display), fontSize: 74 * K, color, whiteSpace: "nowrap", ...outline(6 * K, pk.colors.ink) })}>{P.label}</div>}
    </div>
  );
};

/* ══ Star / burst badge with a short word ══ */
export const ShapeBurst = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const size = (P.size ?? 0.24) * Math.min(W, H), k = outBack(p(t, s, s + 0.35), 2.2), out = exitOf(t, e, 0.2), spin = (t - s) * 25;
  const fill = P.color || pk.colors.alert, stroke = { stroke: pk.colors.ink, strokeWidth: 8 * K };
  const shape = P.shape === "star" ? <Star points={5} innerRadius={size * 0.24} outerRadius={size * 0.5} fill={fill} {...stroke} cornerRadius={6 * K} />
    : P.shape === "circle" ? <SCircle radius={size * 0.46} fill={fill} {...stroke} />
    : P.shape === "triangle" ? <Triangle length={size * 0.95} direction="up" fill={fill} {...stroke} cornerRadius={10 * K} />
    : <Star points={14} innerRadius={size * 0.38} outerRadius={size * 0.5} fill={fill} {...stroke} />;
  return (
    <div style={abs({ left: P.x * W - size / 2, top: P.y * H - size / 2, width: size, height: size, transform: `scale(${k * (1 - out)}) rotate(${(1 - k) * -120 - 8}deg)` })}>
      <div style={abs({ inset: 0, display: "flex", alignItems: "center", justifyContent: "center", transform: `rotate(${spin}deg)`, filter: "drop-shadow(0 10px 18px rgba(0,0,0,.45))" })}>{shape}</div>
      <div dir="rtl" style={abs({ inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: fontStack(pk.fonts.display), fontSize: size * 0.24, color: P.textColor || pk.colors.paper, ...outline(size * 0.018, pk.colors.ink) })}>{P.text}</div>
    </div>
  );
};

/** Pop-in / pop-out wrapper for stickers by a point (x, y centre fractions, size share of the short side). */
const Pop = ({ P, children }) => {
  const { t, s, e, W, H } = useClock(P);
  const size = (P.size ?? 0.2) * Math.min(W, H), k = outBack(p(t, s, s + 0.3), 2.4), out = exitOf(t, e, 0.22), bob = Math.sin((t - s) * 5) * size * 0.03;
  return <div style={abs({ left: P.x * W - size / 2, top: P.y * H - size / 2 + bob, width: size, height: size, transform: `scale(${k * (1 - out)}) rotate(${(1 - k) * -25}deg)` })}>{children(size)}</div>;
};

/** Lottie JSON loaded once per URL (the render waits for it). */
function useLottieData(url) {
  const [data, setData] = useState(null);
  const [handle] = useState(() => (url ? delayRender(`lottie ${url}`, { timeoutInMilliseconds: 20000 }) : null));
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url).then((r) => r.json()).then((j) => { if (alive) setData(j); continueRender(handle); }).catch(() => continueRender(handle));
    return () => { alive = false; };
  }, [url, handle]);
  return data;
}

/* ══ Lottie emoji from the pack's family (Noto Animated); without a file: the emoji character pops ══ */
export const LottieSticker = (P) => {
  const { t, s, e } = useClock(P);
  const asset = useAsset();
  const data = useLottieData(asset(P.src));
  if (!inWin(t, s, e)) return null;
  return <Pop P={P}>{(size) => (data ? <Lottie animationData={data} loop style={{ width: size, height: size }} /> : <div style={{ fontSize: size * 0.82, lineHeight: 1, textAlign: "center" }}>{P.emoji}</div>)}</Pop>;
};

/* ══ Google's animated emoji as transparent video (@remotion/animated-emoji); the host supplies the file ══ */
export const AnimatedEmojiSticker = (P) => {
  const { t, s, e } = useClock(P);
  const asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const src = asset(P.src);
  return <Pop P={P}>{(size) => (src ? <AnimatedEmoji emoji={P.emoji} calculateSrc={() => src} style={{ width: size, height: size }} /> : <div style={{ fontSize: size * 0.4, color: "#fff" }}>{P.emoji}</div>)}</Pop>;
};

/* ══ Before → after: a card replaced by the next one through a Remotion transition ══ */
const Card = ({ text, tone, size, pk }) => (
  <div style={abs({ inset: 0, display: "flex", alignItems: "center", justifyContent: "center" })}>
    <div dir="rtl" style={{ background: tone === "after" ? pk.colors.accent : pk.colors.ink, color: tone === "after" ? pk.colors.ink : pk.colors.paper, fontFamily: fontStack(pk.fonts.display), fontSize: size, padding: `${size * 0.08}px ${size * 0.45}px ${size * 0.16}px`, borderRadius: size * 0.2, border: `${size * 0.07}px solid ${tone === "after" ? pk.colors.ink : pk.colors.accent}`, whiteSpace: "nowrap", boxShadow: pk.shadow.card, textDecoration: tone === "before" ? `line-through ${pk.colors.alert} ${size * 0.06}px` : "none" }}>{text}</div>
  </div>
);
const PRESENT = { wipe: () => wipe({ direction: "from-right" }), slide: () => slide({ direction: "from-right" }), flip: () => flip({ direction: "from-right" }), clock: () => clockWipe({ width: 1080, height: 1920 }) };
export const SwapCard = (P) => {
  const { t, s, e, W, H, k: K, fps } = useClock(P);
  const pk = usePack();
  const frame = useCurrentFrame();
  const total = Math.max(2, Math.round((e - s) * fps)), tr = Math.round(0.4 * fps);
  const first = Math.min(total - tr - 1, Math.max(tr + 1, Math.round(((P.swapAt ?? 1300) / 1000) * fps) + tr));
  const second = Math.max(1, total - first + tr);
  const size = 96 * K, inK = outBack(p(t, s, s + 0.3), 1.8), out = exitOf(t, e);
  const make = PRESENT[P.transition] || PRESENT.wipe;
  const pres = P.transition === "clock" ? clockWipe({ width: W, height: size * 2.2 }) : make();
  return (
    <div style={abs({ left: 0, width: W, top: (P.y ?? 0.3) * H - size * 1.1, height: size * 2.2, transform: `scale(${inK * (1 - out)})`, opacity: frame >= 0 ? 1 : 0 })}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={first}><Card text={P.before} tone="before" size={size} pk={pk} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={pres} timing={linearTiming({ durationInFrames: tr })} />
        <TransitionSeries.Sequence durationInFrames={second}><Card text={P.after} tone="after" size={size} pk={pk} /></TransitionSeries.Sequence>
      </TransitionSeries>
    </div>
  );
};
