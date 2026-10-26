// The «Punchy» kit, ported from the edit-hamdy skill (styles/punchy/kit/Punchy.tsx): designed intro, huge words on the
// beat, tilted photo cards, freeze + stamp. Same motion as the skill; the differences are for the app: sizes scale
// with the frame's short side (k = short/1080 — the kit was drawn on 1080×1920) so 9:16 and 16:9 both work, positions
// are fractions of the frame (the selection system places them away from the face and the platform zones), colours
// come from the style pack, and the time is read from the frame (useClock), not passed in.
import React from "react";
import { Img } from "remotion";
import { CameraMotionBlur } from "@remotion/motion-blur";
import { abs, cl, p, outBack, outCubic, inCubic, lerp, rnd, shakeXY, inWin, outline, useClock, fontStack } from "../motion.js";
import { usePack, useAsset } from "../context.jsx";
import { splitLines } from "../../arabic.js";

const ROW = ({ children, style }) => <div style={{ display: "flex", flexDirection: "column", alignItems: "center", ...style }}>{children}</div>;

/** Motion blur only while something moves fast (the entry): CameraMotionBlur renders its children several times. */
const Blur = ({ on, children }) => (on ? <CameraMotionBlur shutterAngle={200} samples={8}>{children}</CameraMotionBlur> : children);

/* ══ 1. Kinetic word: drops from big, bounces (outBack), shakes on landing, leaves fast. hi = the yellow part ══ */
const KineticWordBody = (P) => {
  const { t, s, e, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const size = 150 * (P.size ?? 1) * K;
  const k = p(t, s, s + pk.motion.enter), out = p(t, e - 0.14, e);
  const sc = lerp(2.3, 1, outBack(k, pk.motion.overshoot.word)) * (1 + 0.25 * out);
  const [sx, sy] = shakeXY(t, s + pk.motion.enter, size * pk.motion.shake.amp);
  const color = P.color || pk.colors.paper, hi = P.hi;
  const paint = (ln) => {
    if (!hi || !ln.includes(hi)) return <span style={{ color }}>{ln}</span>;
    const [a, b] = ln.split(hi);
    return <>{a && <span style={{ color }}>{a}</span>}<span style={{ color: pk.colors.accent }}>{hi}</span>{b && <span style={{ color }}>{b}</span>}</>;
  };
  const lines = splitLines(P.text);
  const top = (P.y ?? 0.3) * H - (lines.length * size * 1.05) / 2;
  return (
    <ROW style={abs({ left: 0, right: 0, top, opacity: (1 - out) * cl(k * 4), transform: `translate(${sx}px,${sy}px) rotate(${P.rot ?? -4}deg) scale(${sc})` })}>
      {lines.map((ln, i) => <div key={i} dir="rtl" style={{ fontFamily: fontStack(P.font || pk.fonts.display), fontSize: size, lineHeight: 1.05, whiteSpace: "nowrap", ...outline(size * pk.stroke.word, pk.colors.ink) }}>{paint(ln)}</div>)}
    </ROW>
  );
};
export const KineticWord = (P) => {
  const { t, s } = useClock(P);
  return <Blur on={P.motionBlur !== false && t >= s && t < s + 0.22}><KineticWordBody {...P} /></Blur>;
};

/* ══ 2. Light streaks (between intro shots): darkens, red/white streaks race across, a flash in the middle ══ */
export const Streak = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  const d = e - s;
  if (!inWin(t, s, e)) return null;
  const k = p(t, s, s + d), dark = Math.sin(Math.PI * k), flash = Math.max(0, 1 - Math.abs(k - 0.5) / 0.08);
  return (
    <div style={abs({ inset: 0, overflow: "hidden" })}>
      <div style={abs({ inset: 0, background: `rgba(10,0,0,${0.82 * dark})` })} />
      {Array.from({ length: 11 }).map((_, i) => {
        const y = H * (0.094 + rnd(i) * 0.8125), h = (6 + rnd(i, 2) * 46) * K, off = rnd(i, 3) * 0.35;
        const x = lerp(-1.6 * W, 1.4 * W, cl((k - off * 0.5) / (1 - off * 0.5)));
        return <div key={i} style={abs({ left: x, top: y, width: W * 1.4, height: h, borderRadius: h, background: `linear-gradient(90deg, transparent, ${i % 3 ? pk.colors.alert : pk.colors.energy} 40%, #fff 70%, transparent)`, filter: "blur(2px)", opacity: 0.9 })} />;
      })}
      <div style={abs({ inset: 0, background: `rgba(255,255,255,${0.85 * flash})` })} />
      {P.word && <div dir="rtl" style={abs({ left: 0, right: 0, top: H * 0.427, textAlign: "center", fontFamily: fontStack(pk.fonts.display), fontSize: 170 * K, color: pk.colors.accent, transform: `rotate(-8deg) translateX(${lerp(260, -260, k) * K}px)`, opacity: dark, ...outline(15 * K, pk.colors.ink) })}>{P.word}</div>}
    </div>
  );
};

/* ══ 3. Title card: video darkens, rays turn, the people cut out slide in from the sides, a huge title, a tilted ribbon ══ */
export const TitleCard = (P) => {
  const { t, s, e, W, H, k: K, wide } = useClock(P);
  const pk = usePack(), asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const u = t - s, out = p(t, e - 0.28, e);
  const kin = (a, dur = 0.35) => outBack(p(u, a, a + dur), 1.7);
  const flashIn = Math.max(0, 1 - u / 0.12), flashOut = p(t, e - 0.1, e);
  const D = fontStack(pk.fonts.display), B = fontStack(pk.fonts.body);
  const ppl = { filter: "drop-shadow(0 0 5px #fff) drop-shadow(0 0 2px #fff) drop-shadow(0 24px 40px rgba(0,0,0,0.6))" };
  const titleTop = wide ? H * 0.12 : H * 0.12;
  return (
    <div style={abs({ inset: 0, overflow: "hidden", transform: `scale(${1 + 0.12 * inCubic(out)})`, opacity: 1 - out * 0.9 })}>
      <div style={abs({ inset: 0, background: "radial-gradient(ellipse at 50% 42%, rgba(70,25,0,0.35), rgba(12,4,0,0.88) 75%)" })} />
      <div style={abs({ left: -0.83 * W, top: -0.21 * H, width: Math.max(W, H) * 1.5 * 1, height: Math.max(W, H) * 1.5, opacity: 0.22, background: `repeating-conic-gradient(from ${u * 25}deg at 50% 40%, ${pk.colors.accent} 0deg 7deg, transparent 7deg 20deg)` })} />
      {Array.from({ length: 36 }).map((_, i) => {
        const x = rnd(i) * W, sp = (60 + rnd(i, 2) * 140) * K, y = (H + 30) - ((u * sp + rnd(i, 3) * (H + 30)) % (H + 30)), r = (4 + rnd(i, 4) * 9) * K;
        return <div key={i} style={abs({ left: x, top: y, width: r, height: r, borderRadius: r, background: i % 4 ? "#fff6dc" : pk.colors.accent, opacity: 0.75 })} />;
      })}
      {P.left && <Img src={asset(P.left)} style={abs({ left: lerp(-0.65 * W, -0.14 * W, kin(0.12, 0.45)), bottom: -40 * K, height: Math.round(H * (wide ? 0.8 : 0.5)), ...ppl })} />}
      {P.right && <Img src={asset(P.right)} style={abs({ right: lerp(-0.65 * W, -0.15 * W, kin(0.28, 0.45)), bottom: -40 * K, height: Math.round(H * (wide ? 0.82 : 0.52)), ...ppl })} />}
      <ROW style={abs({ left: 0, right: 0, top: titleTop, transform: `scale(${lerp(2.6, 1, kin(0.45, 0.3))}) rotate(-3deg)`, opacity: cl((u - 0.45) * 8) })}>
        <div dir="rtl" style={{ fontFamily: D, fontSize: 190 * K, lineHeight: 1, color: pk.colors.paper, ...outline(17 * K, pk.colors.ink) }}>{P.l1}</div>
        <div dir="rtl" style={{ fontFamily: D, fontSize: 230 * K, lineHeight: 1.05, color: pk.colors.accent, ...outline(19 * K, pk.colors.ink) }}>{P.l2}</div>
      </ROW>
      {P.kicker && <div style={abs({ left: 0, right: 0, top: titleTop + 530 * K, display: "flex", justifyContent: "center", opacity: cl((u - 0.75) * 6) })}>
        <div dir="rtl" style={{ background: pk.colors.alert, color: pk.colors.paper, fontFamily: D, fontSize: 78 * K, padding: `${6 * K}px ${46 * K}px ${14 * K}px`, borderRadius: 14 * K, border: `${7 * K}px solid ${pk.colors.ink}`, transform: `rotate(4deg) translateX(${lerp(700, 0, kin(0.75, 0.32)) * K}px)`, boxShadow: pk.shadow.soft }}>{P.kicker}</div>
      </div>}
      {P.sub && <div style={abs({ left: 0, right: 0, top: titleTop + 650 * K, display: "flex", justifyContent: "center", opacity: cl((u - 1.0) * 5) })}>
        <div dir="rtl" style={{ background: "rgba(11,11,15,0.82)", color: "#fff", fontFamily: B, fontWeight: 900, fontSize: 44 * K, padding: `${10 * K}px ${34 * K}px`, borderRadius: 999 }}>{P.sub}</div>
      </div>}
      <div style={abs({ inset: 0, background: `rgba(255,255,255,${0.9 * flashIn + 0.9 * flashOut})` })} />
    </div>
  );
};

/* ══ 4. Tilted photo card: white frame, yellow name tag, flies in from a side, wobbles a little ══ */
export const PhotoCard = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack(), asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const w = (P.w ?? 0.4) * Math.min(W, H); // a share of the short side: the same card on 9:16 and 16:9
  const k = outBack(p(t, s, s + pk.motion.enterCard), pk.motion.overshoot.card), out = inCubic(p(t, e - pk.motion.exitCard, e));
  const from = P.from || "right", dx = from === "left" ? -W * 0.85 : from === "right" ? W * 0.85 : 0, dy = from === "top" ? -H * 0.47 : 0;
  const wob = Math.sin((t - s) * 3.2) * pk.motion.wobbleDeg, rot = P.rot ?? -6;
  const src = asset(P.src);
  return (
    <div style={abs({ left: (P.x ?? 0.5) * W, top: (P.y ?? 0.16) * H, width: w, transform: `translate(${dx * (1 - k)}px,${dy * (1 - k)}px) rotate(${rot + wob + (1 - k) * 25}deg) scale(${1 - out})`, transformOrigin: "50% 50%" })}>
      <div style={{ background: "#fff", padding: 14 * K, borderRadius: 10 * K, boxShadow: pk.shadow.card }}>
        <div style={{ width: w - 28 * K, height: w - 28 * K, overflow: "hidden", borderRadius: 4 * K, background: P.cutout ? (P.bg || pk.colors.energy) : "#222", position: "relative" }}>
          {P.cutout && <div style={abs({ inset: 0, background: "repeating-conic-gradient(from 0deg at 50% 60%, rgba(255,255,255,0.18) 0deg 10deg, transparent 10deg 22deg)" })} />}
          {src ? <Img src={src} style={P.cutout ? abs({ left: "50%", bottom: 0, height: "96%", transform: "translateX(-50%)" }) : { width: "100%", height: "100%", objectFit: "cover" }} />
            : <div style={abs({ inset: 0, background: "repeating-linear-gradient(45deg,#333 0 18px,#2a2a2a 18px 36px)" })} />}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginTop: -34 * K }}>
        <div dir="rtl" style={{ background: pk.colors.accent, color: pk.colors.ink, fontFamily: fontStack(pk.fonts.display), fontSize: Math.max(54 * K, Math.round(w * 0.14)), padding: `${2 * K}px ${28 * K}px ${10 * K}px`, borderRadius: 10 * K, border: `${5 * K}px solid ${pk.colors.ink}`, transform: "rotate(3deg)", whiteSpace: "nowrap", boxShadow: pk.shadow.tag }}>{P.label}</div>
      </div>
      {P.badge && <div style={abs({ right: -34 * K, top: -38 * K, fontSize: w * 0.22, transform: `rotate(12deg) scale(${outBack(p(t, s + 0.25, s + 0.5), 2.5)})` })}>{P.badge}</div>}
    </div>
  );
};

/* ══ 5. Chapter banner: black tag + tilted yellow banner from both sides ══ */
export const ChapterBanner = (P) => {
  const { t, s, e, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const k1 = outBack(p(t, s, s + 0.3), 1.8), k2 = outBack(p(t, s + 0.12, s + 0.42), 1.8), out = inCubic(p(t, e - 0.2, e));
  return (
    <ROW style={abs({ left: 0, right: 0, top: (P.y ?? 0.11) * H, opacity: 1 - out, transform: `translateY(${-120 * K * out}px)` })}>
      {P.tag && <div dir="rtl" style={{ background: pk.colors.ink, color: pk.colors.accent, fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: 40 * K, padding: `${6 * K}px ${28 * K}px`, borderRadius: 8 * K, transform: `rotate(-4deg) translateX(${lerp(-800, 0, k1) * K}px)` }}>{P.tag}</div>}
      <div dir="rtl" style={{ marginTop: -6 * K, background: pk.colors.accent, color: pk.colors.ink, fontFamily: fontStack(pk.fonts.display), fontSize: 104 * K, padding: `0 ${44 * K}px ${12 * K}px`, borderRadius: 14 * K, border: `${7 * K}px solid ${pk.colors.ink}`, transform: `rotate(-4deg) translateX(${lerp(800, 0, k2) * K}px)`, boxShadow: "0 16px 34px rgba(0,0,0,0.45)", whiteSpace: "nowrap" }}>
        {P.text}{P.emoji ? ` ${P.emoji}` : ""}</div>
    </ROW>
  );
};

/* ══ 6. Slam stamp: red, slams from 3×, shakes, a white ring spreads ══ */
export const SlamStamp = (P) => {
  const { t, s, e, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const size = 116 * (P.size ?? 1) * K;
  const k = p(t, s, s + 0.12), out = p(t, e - 0.15, e), [sx, sy] = shakeXY(t, s + 0.12, 22 * K, 0.3), ring = p(t, s + 0.1, s + 0.55);
  return (
    <div style={abs({ left: 0, right: 0, top: (P.y ?? 0.33) * H - size * 0.8, display: "flex", justifyContent: "center", opacity: 1 - out })}>
      <div style={abs({ top: 40 * K, width: 700 * K * (0.5 + ring), height: 220 * K * (0.5 + ring), borderRadius: "50%", border: `${10 * K}px solid rgba(255,255,255,${0.6 * (1 - ring)})` })} />
      <div dir="rtl" style={{ background: P.color || pk.colors.alert, color: "#fff", fontFamily: fontStack(pk.fonts.display), fontSize: size, padding: `0 ${46 * K}px ${14 * K}px`, borderRadius: 22 * K, border: `${9 * K}px solid #fff`, outline: `${6 * K}px solid ${pk.colors.ink}`, transform: `translate(${sx}px,${sy}px) rotate(-8deg) scale(${lerp(3, 1, outCubic(k)) * (1 + 0.15 * out)})`, boxShadow: "0 24px 50px rgba(0,0,0,0.55)", whiteSpace: "nowrap", ...outline(size * 0.05, pk.colors.ink) }}>{P.text}</div>
    </div>
  );
};

/* ══ 7. Freeze: black-and-white still + vignette + push-in + flash ══ */
export const FreezeFx = (P) => {
  const { t, s, e } = useClock(P);
  const asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const u = p(t, s, e), flash = Math.max(0, 1 - (t - s) / 0.1), src = asset(P.still);
  return (
    <div style={abs({ inset: 0, overflow: "hidden" })}>
      {src && <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(1) contrast(1.35) brightness(0.95)", transform: `scale(${1.04 + 0.06 * u})` }} />}
      <div style={abs({ inset: 0, background: "radial-gradient(ellipse at 50% 40%, transparent 35%, rgba(0,0,0,0.75) 100%)" })} />
      <div style={abs({ inset: 0, background: `rgba(255,255,255,${flash})` })} />
    </div>
  );
};

/* ══ 8. Confetti ══ */
export const Confetti = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  const d = e - s;
  if (!inWin(t, s, e)) return null;
  const u = t - s, cols = [pk.colors.accent, pk.colors.alert, pk.colors.info, pk.colors.gain, "#fff", pk.colors.energy];
  return (
    <div style={abs({ inset: 0, overflow: "hidden" })}>{Array.from({ length: P.n ?? 70 }).map((_, i) => {
      const x0 = W / 2 + (rnd(i) - 0.5) * 300 * K, vx = (rnd(i, 2) - 0.5) * 1500 * K, vy = (-900 - rnd(i, 3) * 900) * K;
      const x = x0 + vx * u, y = H * 0.47 + vy * u + 1400 * K * u * u, r = rnd(i, 4) * 720 * u, w = (14 + rnd(i, 5) * 14) * K;
      return <div key={i} style={abs({ left: x, top: y, width: w, height: w * 0.45, background: cols[i % cols.length], transform: `rotate(${r}deg)`, opacity: 1 - p(u, d - 0.4, d) })} />;
    })}</div>
  );
};

/* ══ 9. Speed lines (running / shock) ══ */
export const SpeedLines = (P) => {
  const { t, s, e, W, H } = useClock(P);
  if (!inWin(t, s, e)) return null;
  const cx = (P.cx ?? 0.5) * W, cy = (P.cy ?? 0.42) * H;
  const k = p(t, s, e), a = Math.sin(Math.PI * k) * 0.85, rotA = (t * 40) % 360;
  return <div style={abs({ inset: 0, opacity: a, background: `repeating-conic-gradient(from ${rotA}deg at ${cx}px ${cy}px, rgba(255,255,255,0.9) 0deg 1.4deg, transparent 1.4deg 9deg)`, WebkitMaskImage: `radial-gradient(circle at ${cx}px ${cy}px, transparent 32%, #000 62%)` })} />;
};

/* ══ 10. Name tag with an arrow ══ */
export const NameTag = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const k = outBack(p(t, s, s + 0.3), pk.motion.overshoot.tag), out = inCubic(p(t, e - 0.18, e));
  const x = Math.max(0.15 * W, Math.min(0.85 * W, (P.x ?? 0.5) * W)), tri = (dir) => ({ width: 0, height: 0, borderLeft: `${22 * K}px solid transparent`, borderRight: `${22 * K}px solid transparent`, [dir === "up" ? "borderBottom" : "borderTop"]: `${28 * K}px solid ${pk.colors.ink}` });
  return (
    <ROW style={abs({ left: x, top: (P.y ?? 0.2) * H, transform: `translate(-50%,0) scale(${k * (1 - out)}) rotate(-3deg)` })}>
      {P.arrow === "up" && <div style={tri("up")} />}
      <div dir="rtl" style={{ background: pk.colors.ink, borderRadius: 20 * K, padding: `${8 * K}px ${40 * K}px ${18 * K}px`, textAlign: "center", border: `${7 * K}px solid ${pk.colors.accent}`, boxShadow: pk.shadow.soft }}>
        <div style={{ fontFamily: fontStack(pk.fonts.display), fontSize: 104 * K, color: pk.colors.accent, lineHeight: 1.1, whiteSpace: "nowrap" }}>{P.name}</div>
        {P.role && <div style={{ fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: 46 * K, color: "#fff", marginTop: -4 * K, whiteSpace: "nowrap" }}>{P.role}</div>}
      </div>
      {(P.arrow ?? "down") === "down" && <div style={tri("down")} />}
    </ROW>
  );
};

/* ══ 11. Joke sum: lines appear on their words, the last one red ══ */
export const JokeMath = (P) => {
  const { t, s, e, W, H, k: K, wide } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const items = P.lines || [], n = items.length;
  const at = (i) => (Number.isFinite(P.times?.[i]) ? s + P.times[i] / 1000 : s + 0.35 + i * Math.min(1.2, Math.max(0.4, (e - s - 1) / Math.max(1, n))));
  const k = outBack(p(t, s, s + 0.3), 1.6), out = inCubic(p(t, e - 0.2, e));
  const side = wide ? W * 0.28 : W * 0.11;
  return (
    <div dir="rtl" style={abs({ left: side, right: side, top: (P.y ?? 0.12) * H, transform: `rotate(-2deg) scale(${k * (1 - out)})`, background: pk.colors.cream, borderRadius: 22 * K, border: `${7 * K}px solid ${pk.colors.ink}`, padding: `${20 * K}px ${34 * K}px ${26 * K}px`, boxShadow: pk.shadow.card })}>
      {P.title && <div style={{ fontFamily: fontStack(pk.fonts.display), fontSize: 84 * K, color: pk.colors.ink, marginBottom: 6 * K }}>{P.title}</div>}
      {items.map((text, i) => {
        const hot = P.hotLast !== false && i === n - 1 && n > 1;
        const a = outBack(p(t, at(i), at(i) + 0.25), 2);
        return <div key={i} style={{ fontFamily: fontStack(hot ? pk.fonts.display : pk.fonts.body), fontWeight: 900, fontSize: (hot ? 92 : 64) * K, color: hot ? pk.colors.alert : pk.colors.ink, opacity: cl(a), transform: `translateX(${(1 - a) * -60 * K}px) scale(${0.6 + 0.4 * a})`, transformOrigin: "100% 50%", lineHeight: 1.25 }}>{text}</div>;
      })}
    </div>
  );
};

/* ══ 12. Weather swap (rain → sun) ══ */
export const WeatherSwap = (P) => {
  const { t, s, e, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const swapAt = s + (P.swapAt ?? 700) / 1000;
  const k = outBack(p(t, s, s + 0.3), 1.8), sw = p(t, swapAt, swapAt + 0.35), out = inCubic(p(t, e - 0.2, e));
  return (
    <div style={abs({ left: 0, right: 0, top: (P.y ?? 0.12) * H, display: "flex", justifyContent: "center", transform: `scale(${k * (1 - out)})` })}>
      <div dir="rtl" style={{ display: "flex", alignItems: "center", gap: 22 * K, background: pk.colors.ink, borderRadius: 999, padding: `${12 * K}px ${40 * K}px ${12 * K}px ${22 * K}px`, border: `${6 * K}px solid ${pk.colors.accent}`, boxShadow: "0 16px 34px rgba(0,0,0,0.45)" }}>
        <div style={{ position: "relative", width: 140 * K, height: 140 * K }}>
          <div style={abs({ inset: 0, fontSize: 122 * K, lineHeight: 1.1, textAlign: "center", opacity: 1 - sw, transform: `translateY(${60 * K * sw}px)` })}>{P.from || "🌧️"}</div>
          <div style={abs({ inset: 0, fontSize: 122 * K, lineHeight: 1.1, textAlign: "center", opacity: sw, transform: `scale(${outBack(sw, 2.4)}) rotate(${(1 - sw) * -90}deg)` })}>{P.to || "☀️"}</div>
        </div>
        <div style={{ fontFamily: fontStack(pk.fonts.display), fontSize: 92 * K, color: "#fff", whiteSpace: "nowrap" }}>{P.text}</div>
      </div>
    </div>
  );
};
