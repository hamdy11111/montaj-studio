// The numbers / HUD / story kit, ported from the edit-hamdy skill (styles/punchy/kit/Graphics.tsx — "every number said
// becomes a graphic, fixed elements show progress, huge chapter cards, a flashback look, what is said made literal").
// These were already drawn in units of the short side (u = 1 %), so they work on 9:16 and 16:9; here they also take
// the pack's colours and fonts, and positions as fractions of the frame.
import React from "react";
import { Img } from "remotion";
import { CameraMotionBlur } from "@remotion/motion-blur";
import { abs, cl, p, outBack, outCubic, inCubic, lerp, inWin, outline, useClock, fontStack } from "../motion.js";
import { usePack, useAsset } from "../context.jsx";
import { formatNumber, hasArabic } from "../../arabic.js";

const rnd = (i, s = 1) => { const x = Math.sin(i * 91.7 + s * 277.3) * 43758.5453; return x - Math.floor(x); };
const COL = { display: "flex", flexDirection: "column", alignItems: "center" };

/* ══ 1. Counter roll: fast then settling on the value (like a machine), a shine when it lands ══ */
export const CounterRoll = (P) => {
  const { t, s, e, W, H, u } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const dur = (P.rollMs ?? 1100) / 1000;
  const k = outCubic(p(t, s + 0.12, s + 0.12 + dur)), v = lerp(P.from ?? 0, P.to ?? 0, k), inK = outBack(p(t, s, s + 0.25), 1.7), out = inCubic(p(t, e - 0.2, e));
  const sz = u * 13 * (P.size ?? 1), done = p(t, s + 0.12 + dur, s + 0.32 + dur), shine = Math.sin(Math.PI * done);
  const color = P.color || pk.colors.accent;
  return (
    <div style={abs({ left: 0, width: W, top: (P.y ?? 0.14) * H, ...COL, transform: `scale(${inK * (1 - 0.3 * out) * (1 + 0.08 * shine)})`, opacity: 1 - out })}>
      <div dir="rtl" style={{ fontFamily: fontStack(pk.fonts.display), fontSize: sz, lineHeight: 1, color, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", filter: `drop-shadow(0 0 ${u * 2 * shine}px ${pk.colors.accent})`, ...outline(sz * pk.stroke.number, pk.colors.ink) }}>
        {P.prefix || ""}{formatNumber(v, P.dec || 0)}{P.suffix || ""}</div>
      {P.label && <div dir="rtl" style={{ marginTop: u * 0.6, background: pk.colors.ink, color: "#fff", fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: sz * 0.3, padding: `${u * 0.4}px ${u * 2.4}px`, borderRadius: u * 1.2, whiteSpace: "nowrap" }}>{P.label}</div>}
    </div>
  );
};

/* ══ 2. Gain/loss pill: pops beside the thing and floats up ══ */
export const DeltaPill = (P) => {
  const { t, s, e, W, H, u } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const k = outBack(p(t, s, s + 0.28), 2.1), out = p(t, e - 0.25, e), rise = (t - s) * u * 2.2;
  const c = P.kind === "gain" ? pk.colors.gain : pk.colors.alert, sz = u * 7.5;
  const m = String(P.text || "").match(/^\s*([+\-−])?\s*([\d٠-٩.,٫٬]+)\s*(.*)$/);
  const st = { fontFamily: fontStack(pk.fonts.display), fontSize: sz, color: c, lineHeight: 1.1, whiteSpace: "nowrap" };
  return (
    <div style={abs({ left: (P.x ?? 0.5) * W, top: (P.y ?? 0.42) * H - rise, transform: `translate(-50%,-50%) scale(${k * (1 - 0.4 * out)})`, opacity: 1 - out })}>
      <div dir="rtl" style={{ display: "flex", alignItems: "center", gap: u * 1.2, background: "#fff", border: `${u * 0.55}px solid ${c}`, borderRadius: 999, padding: `${u * 0.4}px ${u * 2.4}px ${u * 0.9}px`, boxShadow: `0 ${u}px ${u * 2.6}px rgba(0,0,0,.45), 0 0 0 ${u * 0.35}px ${pk.colors.ink}` }}>
        {/* sign · number (isolated, Western or Arabic-Indic) · unit, read right to left: «− ٨٠ جنيه» */}
        {!m ? <span style={st}>{P.text}</span> : <span dir="rtl" style={{ ...st, display: "inline-flex", alignItems: "baseline", gap: sz * 0.12 }}>
          {m[1] && <span>{m[1] === "-" ? "−" : m[1]}</span>}<bdi dir="ltr" style={{ unicodeBidi: "isolate" }}>{m[2]}</bdi>{m[3] && <span>{m[3]}</span>}</span>}
        {P.unit && <span style={{ fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: sz * 0.42, color: pk.colors.ink, background: "#EDEDED", borderRadius: 999, padding: `0 ${u * 1.2}px` }}>{P.unit}</span>}
      </div>
    </div>
  );
};

/* ══ 3. Impact number: slams from close with a coloured 3D depth, shakes, leaves ══ */
const ImpactBody = (P) => {
  const { t, s, e, W, H, u } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const k = p(t, s, s + 0.16), out = p(t, e - 0.16, e), sz = u * 22 * (P.size ?? 1);
  const sh = (t - s - 0.16) > 0 && (t - s - 0.16) < 0.25 ? Math.sin((t - s) * 90) * u * 1.4 * (1 - (t - s - 0.16) / 0.25) : 0;
  const depth = Array.from({ length: 7 }).map((_, i) => `${(i + 1) * sz * 0.008}px ${(i + 1) * sz * 0.012}px 0 ${i < 6 ? pk.colors.impactDepth : "#2a0010"}`).join(",");
  return (
    <div style={abs({ left: 0, width: W, top: (P.y ?? 0.3) * H, ...COL, opacity: 1 - out, transform: `translateX(${sh}px) rotate(${P.rot ?? -5}deg) scale(${lerp(3.2, 1, outCubic(k)) * (1 + 0.2 * out)})` })}>
      {/* A number without Arabic letters keeps its own order («-$80», not «$80-»); with Arabic it reads right to left. */}
      <div dir={hasArabic(P.text) ? "rtl" : "ltr"} style={{ fontFamily: fontStack(pk.fonts.display), fontSize: sz, lineHeight: 1, color: P.color || pk.colors.impact, whiteSpace: "nowrap", textShadow: depth, WebkitTextStroke: `${sz * 0.035}px #fff`, paintOrder: "stroke fill" }}>{P.text}</div>
      {P.sub && <div dir="rtl" style={{ fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: sz * 0.22, color: "#fff", marginTop: u * 0.5, ...outline(sz * 0.02, pk.colors.ink) }}>{P.sub}</div>}
    </div>
  );
};
export const ImpactNumber = (P) => {
  const { t, s } = useClock(P);
  return P.motionBlur !== false && t >= s && t < s + 0.18 ? <CameraMotionBlur shutterAngle={200} samples={8}><ImpactBody {...P} /></CameraMotionBlur> : <ImpactBody {...P} />;
};

/* ══ 4. Progress bar towards the goal (can stay long) ══ */
export const ProgressHUD = (P) => {
  const { t, s, e, W, H, u, wide } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const inK = outCubic(p(t, s, s + 0.3)), out = p(t, e - 0.3, e), fill = lerp(P.prev ?? P.value, P.value, outCubic(p(t, s + 0.3, s + 1.3)));
  const bw = wide ? W * 0.42 : W * 0.86, bh = u * 4.6, x0 = wide ? W * 0.05 : (W - bw) / 2, y0 = P.pos === "top" ? H * 0.06 : H - (wide ? H * 0.12 : H * 0.17) - u * 5;
  const pct = cl(fill / Math.max(1e-6, P.max)), done = !!P.done;
  return (
    <div style={abs({ left: x0, top: y0 + (1 - inK) * u * 8, width: bw, opacity: (1 - out) * inK })}>
      <div dir="rtl" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: u * 0.5 }}>
        <span style={{ fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: u * 2.6, color: "#fff", ...outline(u * 0.28, pk.colors.ink) }}>{P.label}</span>
        <span style={{ fontFamily: fontStack(pk.fonts.display), fontSize: u * 4, color: done ? pk.colors.gain : pk.colors.accent, ...outline(u * 0.35, pk.colors.ink) }}>{formatNumber(fill, P.dec || 0)}{P.unit ? ` ${P.unit}` : ""}{done ? " ✓" : ""}</span>
      </div>
      <div style={{ height: bh, borderRadius: bh, background: "rgba(11,11,15,.78)", border: `${u * 0.4}px solid #fff`, overflow: "hidden", boxShadow: `0 ${u * 0.6}px ${u * 2}px rgba(0,0,0,.5)` }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, marginInlineStart: "auto", borderRadius: bh, background: `linear-gradient(90deg, ${done ? pk.colors.gain : pk.colors.energy}, ${done ? "#8BF5B7" : pk.colors.accent})` }} />
      </div>
    </div>
  );
};

/* ══ 5. Corner badge: «day 3», pulses when it changes ══ */
export const CornerHUD = (P) => {
  const { t, s, e, H, u, wide } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const corner = P.corner || "tl", pulse = P.pulse >= 0 ? s + P.pulse / 1000 : null;
  const inK = outBack(p(t, s, s + 0.3), 1.6), out = p(t, e - 0.2, e), pk1 = pulse !== null ? Math.max(0, 1 - Math.abs(t - pulse - 0.15) / 0.18) : 0;
  const m = u * 2.6;
  return (
    <div style={abs({ top: corner[0] === "t" ? (wide ? m : H * 0.06) : undefined, bottom: corner[0] === "b" ? m : undefined, left: corner[1] === "l" ? m : undefined, right: corner[1] === "r" ? m : undefined, transform: `scale(${inK * (1 + 0.18 * pk1) * (1 - out)})`, transformOrigin: corner[1] === "r" ? "100% 0" : "0 0" })}>
      <div dir="rtl" style={{ background: pk.colors.ink, color: pk.colors.accent, fontFamily: fontStack(pk.fonts.display), fontSize: u * 4.6, padding: `${u * 0.2}px ${u * 2}px ${u * 0.8}px`, borderRadius: u * 1.4, border: `${u * 0.45}px solid ${pk1 > 0.05 ? pk.colors.accent : "#fff"}`, boxShadow: `0 ${u * 0.6}px ${u * 1.8}px rgba(0,0,0,.45)`, whiteSpace: "nowrap" }}>
        {P.icon ? `${P.icon} ` : ""}{P.text}</div>
    </div>
  );
};

/* ══ 6. Countdown: 0:58 … 0:00, the last 3 s red and beating, a red flash at zero ══ */
export const TimerHUD = (P) => {
  const { t, s, e, H, u, wide } = useClock(P);
  const pk = usePack();
  const end = e - 0.6; // the last 0.6 s is the red flash at zero (outUs of the template)
  if (!inWin(t, s, e)) return null;
  const from = P.from ?? 10;
  const left = Math.max(0, from - (t - s) * (from / Math.max(0.01, end - s))), sec = Math.ceil(left - 1e-6);
  const mm = Math.floor(sec / 60), ss = sec % 60, hot = left <= 3.0, zero = t > end;
  const beat = hot ? 1 + 0.12 * Math.max(0, Math.cos((left % 1) * Math.PI * 2)) : 1;
  const m = u * 2.6, corner = P.corner || "tl";
  return (
    <>
      {zero && <div style={abs({ inset: 0, background: `rgba(255,30,30,${0.38 * (1 - p(t, end, e))})` })} />}
      <div style={abs({ top: wide ? m : H * 0.06, [corner === "tr" ? "right" : "left"]: m, transform: `scale(${beat})`, transformOrigin: corner === "tr" ? "100% 0" : "0 0" })}>
        <div style={{ fontFamily: fontStack(pk.fonts.display), fontSize: u * 9, color: hot ? pk.colors.alert : "#fff", fontVariantNumeric: "tabular-nums", ...outline(u * 0.7, pk.colors.ink) }}>
          {formatNumber(mm)}:{formatNumber(ss).padStart(2, "٠")}</div>
      </div>
    </>
  );
};

/* ══ 7. Chapter card: huge metallic «day 3» over the darkened video, zoom through, out with a flash ══ */
export const ChapterCard = (P) => {
  const { t, s, e, W, H, u } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const k = outCubic(p(t, s, s + 0.45)), out = p(t, e - 0.22, e), flash = Math.max(0, 1 - (t - s) / 0.12) * 0.7 + p(t, e - 0.08, e) * 0.8, sz = u * 24;
  return (
    <div style={abs({ inset: 0, overflow: "hidden" })}>
      <div style={abs({ inset: 0, background: `rgba(5,5,10,${(P.dim ?? 0.55) * (1 - out)})` })} />
      <div style={abs({ left: 0, width: W, top: H * 0.5 - sz * 0.62, ...COL, transform: `scale(${lerp(1.9, 1, k) * (1 + 0.6 * inCubic(out))})`, opacity: cl(k * 3) * (1 - out) })}>
        <div dir="rtl" style={{ fontFamily: fontStack(pk.fonts.display), fontSize: sz, lineHeight: 1.15, whiteSpace: "nowrap", background: "linear-gradient(180deg,#ffffff 0%,#d9dde3 42%,#7c8592 52%,#f4f6f8 70%,#aab2bd 100%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 ${u * 0.5}px 0 #3b414b) drop-shadow(0 ${u * 1.4}px ${u * 2}px rgba(0,0,0,.7))` }}>{P.text}</div>
        {P.sub && <div dir="rtl" style={{ fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: sz * 0.2, color: "#fff", marginTop: u, ...outline(u * 0.3, pk.colors.ink) }}>{P.sub}</div>}
      </div>
      <div style={abs({ inset: 0, background: `rgba(255,255,255,${flash})` })} />
    </div>
  );
};

/* ══ 8. Flashback look: grain, scan lines, dark edges, a red label (the black-and-white itself is a clip filter) ══ */
export const Flashback = (P) => {
  const { t, s, e, W, H, u } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const inK = p(t, s, s + 0.25), out = p(t, e - 0.2, e), fr = Math.floor(t * 24);
  const glitch = (t - s) < 0.3 || (e - t) < 0.25 ? (rnd(fr) - 0.5) * u * 3 : 0;
  return (
    <div style={abs({ inset: 0, overflow: "hidden", opacity: inK * (1 - out) })}>
      <div style={abs({ inset: 0, background: "radial-gradient(ellipse at 50% 50%, transparent 45%, rgba(0,0,0,.72) 100%)" })} />
      <div style={abs({ inset: 0, opacity: 0.16, backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,.5) 0 1px, transparent 1px 4px)" })} />
      {Array.from({ length: 26 }).map((_, i) => <div key={i} style={abs({ left: rnd(i, fr) * W, top: rnd(i + 9, fr) * H, width: u * 0.25, height: u * 0.25, background: "#fff", opacity: 0.5 })} />)}
      {P.label && <div dir="rtl" style={abs({ left: 0, width: W, bottom: H * 0.24, textAlign: "center", fontFamily: fontStack(pk.fonts.display), fontSize: u * 9, color: pk.colors.alert, transform: `translateX(${glitch}px)`, textShadow: `${u * 0.4}px 0 rgba(0,255,255,.55), ${-u * 0.4}px 0 rgba(255,0,0,.55)`, ...outline(u * 0.5, pk.colors.ink) })}>{P.label}</div>}
    </div>
  );
};

/* ══ 9. CCTV wall: a grid of stills + REC + camera numbers + scan lines ══ */
export const CCTVWall = (P) => {
  const { t, s, e, W, H, u, wide } = useClock(P);
  const asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const stills = (P.stills || []).length ? P.stills : Array.from({ length: 6 }, () => "");
  const c = P.cols || Math.min(wide ? 4 : 3, Math.max(1, Math.ceil(Math.sqrt(stills.length)))), r = Math.ceil(stills.length / c), k = outCubic(p(t, s, s + 0.4)), out = p(t, e - 0.2, e);
  const gw = W * 0.94, gh = Math.min(H * 0.86, (gw / c) * (wide ? 9 / 16 : 16 / 9) * r), cw = gw / c, ch = gh / r;
  return (
    <div style={abs({ inset: 0, background: `rgba(0,0,0,${0.9 * k * (1 - out)})` })}>
      <div style={abs({ left: (W - gw) / 2, top: (H - gh) / 2, width: gw, height: gh, transform: `perspective(${u * 120}px) rotateY(${lerp(-18, -6, k)}deg) scale(${lerp(1.25, 1, k)})`, opacity: 1 - out })}>
        {stills.map((src, i) => {
          const url = asset(src);
          return (
            <div key={i} style={abs({ left: (i % c) * cw + u * 0.4, top: Math.floor(i / c) * ch + u * 0.4, width: cw - u * 0.8, height: ch - u * 0.8, overflow: "hidden", border: `${u * 0.25}px solid #2b2b2b`, background: "#111", opacity: cl((t - s - i * 0.04) * 6) })}>
              {url && <Img src={url} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "saturate(.6) contrast(1.1) brightness(.9)" }} />}
              <div style={abs({ inset: 0, backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,.25) 0 2px, transparent 2px 5px)" })} />
              <div style={abs({ left: u * 0.8, top: u * 0.6, fontFamily: "Consolas, monospace", fontSize: u * 1.6, color: "#fff", textShadow: "0 0 4px #000" })}>
                <span style={{ color: Math.floor((t - s) * 2) % 2 ? "#ff3030" : "transparent" }}>●</span> CAM {String(i + 1).padStart(2, "0")}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ══ 10. Phone: a screenshot inside a phone rises from the bottom ══ */
export const PhoneFrame = (P) => {
  const { t, s, e, W, H, u } = useClock(P);
  const pk = usePack(), asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const k = outBack(p(t, s, s + 0.38), 1.4), out = inCubic(p(t, e - 0.22, e)), ph = (P.h ?? 0.55) * H, pw = ph * 0.49, rot = P.rot ?? 6, src = asset(P.src);
  return (
    <div style={abs({ left: (P.x ?? 0.5) * W - pw / 2, top: (P.y ?? 0.22) * H + (1 - k) * H * 0.8 + out * H * 0.8, width: pw, height: ph, transform: `rotate(${rot * (1 - 0.5 * k)}deg)` })}>
      <div style={{ width: "100%", height: "100%", borderRadius: pw * 0.13, background: "#0d0d0f", padding: pw * 0.035, boxShadow: `0 ${u * 2}px ${u * 5}px rgba(0,0,0,.6)`, boxSizing: "border-box" }}>
        <div style={{ width: "100%", height: "100%", borderRadius: pw * 0.1, overflow: "hidden", background: "#fff", position: "relative" }}>
          {src && <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          <div style={abs({ left: "50%", top: pw * 0.03, width: pw * 0.3, height: pw * 0.07, borderRadius: 99, background: "#0d0d0f", transform: "translateX(-50%)" })} />
        </div>
      </div>
      {P.title && <div dir="rtl" style={abs({ left: -pw * 0.3, right: -pw * 0.3, top: -u * 7, textAlign: "center", fontFamily: fontStack(pk.fonts.display), fontSize: u * 5.4, color: "#fff", ...outline(u * 0.5, pk.colors.ink) })}>{P.title}</div>}
    </div>
  );
};

/* ══ 11. Comparison: each side fills from its own edge (values that were said) ══ */
export const CompareGauge = (P) => {
  const { t, s, e, W, H, u, wide } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const k = outCubic(p(t, s + 0.15, s + 1.0)), inK = outBack(p(t, s, s + 0.3), 1.5), out = p(t, e - 0.2, e);
  const side = (lab, v, pv, al) => {
    const val = lerp(pv ?? 0, v, k);
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: al === "left" ? "flex-start" : "flex-end", gap: u * 0.4 }}>
        <div style={{ fontFamily: fontStack(pk.fonts.display), fontSize: u * 7, color: "#fff", ...outline(u * 0.55, pk.colors.ink) }}>{formatNumber(val)}٪</div>
        <div style={{ width: wide ? W * 0.22 : W * 0.38, height: u * 2.6, borderRadius: 99, background: "rgba(0,0,0,.65)", border: `${u * 0.35}px solid #fff`, overflow: "hidden", direction: al === "left" ? "ltr" : "rtl" }}>
          <div style={{ width: `${cl(val / 100) * 100}%`, height: "100%", background: al === "left" ? pk.colors.info : pk.colors.energy }} /></div>
        <div dir="rtl" style={{ fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: u * 3, color: "#fff", ...outline(u * 0.3, pk.colors.ink) }}>{lab}</div>
      </div>
    );
  };
  return (
    // Vertical: clear of the platforms' button column on the right (Reels/TikTok/Shorts) and of the caption band.
    <div style={abs({ left: W * 0.04, right: wide ? W * 0.04 : W * 0.18, bottom: wide ? H * 0.12 : H * 0.26, display: "flex", justifyContent: "space-between", transform: `scale(${inK})`, opacity: 1 - out })}>
      {side(P.leftLabel, P.leftValue, P.prevL, "left")}{side(P.rightLabel, P.rightValue, P.prevR, "right")}
    </div>
  );
};

/* ══ 12. List montage: each item slams in on its word as a card and stacks, the older ones shrink ══ */
export const ListMontage = (P) => {
  const { t, s, e, W, H, u, wide } = useClock(P);
  const pk = usePack(), asset = useAsset();
  if (!inWin(t, s, e)) return null;
  const items = (P.items || []).map((text, i) => ({ text, at: Number.isFinite(P.times?.[i]) ? s + P.times[i] / 1000 : s + 0.15 + i * Math.min(0.9, Math.max(0.35, (e - s - 1) / Math.max(1, (P.items || []).length))) }));
  const out = p(t, e - 0.22, e), shown = items.filter((it) => t >= it.at - 0.02);
  const cw = wide ? W * 0.2 : W * 0.6, chh = u * 9.5, x0 = wide ? W * 0.06 : (W - cw) / 2, y0 = (P.y ?? 0.18) * H;
  return (
    <div style={abs({ inset: 0, opacity: 1 - out })}>
      {P.title && <div dir="rtl" style={abs({ left: x0, width: cw, top: y0 - u * 8, textAlign: "center", fontFamily: fontStack(pk.fonts.display), fontSize: u * 5.4, color: pk.colors.accent, ...outline(u * 0.5, pk.colors.ink) })}>{P.title}</div>}
      {shown.map((it, i) => {
        const age = shown.length - 1 - i, k = outBack(p(t, it.at, it.at + 0.22), 2.2);
        return (
          <div key={i} dir="rtl" style={abs({ left: x0, top: y0 + i * (chh + u * 1.2), width: cw, height: chh, display: "flex", alignItems: "center", gap: u * 1.5, background: age === 0 ? pk.colors.accent : "#fff", border: `${u * 0.45}px solid ${pk.colors.ink}`, borderRadius: u * 1.6, padding: `0 ${u * 1.8}px`, boxSizing: "border-box", transform: `translateX(${(1 - k) * (i % 2 ? 1 : -1) * W * 0.7}px) rotate(${(i % 2 ? 2 : -2) * (age === 0 ? 1 : 0.4)}deg) scale(${age === 0 ? 1.04 : 0.96})`, boxShadow: `0 ${u * 0.8}px ${u * 2}px rgba(0,0,0,.45)` })}>
            <span style={{ fontFamily: fontStack(pk.fonts.display), fontSize: chh * 0.56, color: pk.colors.ink, whiteSpace: "nowrap" }}>{it.text}</span>
          </div>
        );
      })}
    </div>
  );
};

/* ══ 13. Narrator line: a cinematic bar, the words type in — whole words only (letters stay joined) ══ */
export const NarratorCard = (P) => {
  const { t, s, e, W, H, u, wide } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const words = String(P.text || "").split(/\s+/).filter(Boolean);
  const k = outCubic(p(t, s, s + 0.3)), out = p(t, e - 0.25, e), n = Math.ceil(words.length * cl((t - s - 0.15) / Math.max(0.4, Math.min(1.2, (e - s) * 0.5))));
  const y = P.pos === "bottom" ? (wide ? H * 0.8 : H * 0.7) : (wide ? H * 0.06 : H * 0.11);
  return (
    <div style={abs({ left: 0, width: W, top: y, display: "flex", justifyContent: "center", opacity: k * (1 - out), transform: `translateY(${(1 - k) * -u * 4}px)` })}>
      <div dir="rtl" style={{ background: "rgba(8,8,12,.86)", color: "#fff", fontFamily: fontStack(pk.fonts.body), fontWeight: 900, fontSize: u * 4.4, padding: `${u * 1}px ${u * 3}px ${u * 1.4}px`, borderRadius: u * 1.2, borderInlineStart: `${u * 0.9}px solid ${pk.colors.accent}`, maxWidth: W * 0.86, whiteSpace: "nowrap", overflow: "hidden" }}>
        {words.map((w, i) => <span key={i} style={{ opacity: i < n ? 1 : 0 }}>{w}{i < words.length - 1 ? " " : ""}</span>)}
      </div>
    </div>
  );
};

/* ══ 14. Colour tint over the picture for a moment (night · red · dream · warm) ══ */
export const TintFx = (P) => {
  const { t, s, e } = useClock(P);
  if (!inWin(t, s, e)) return null;
  const fade = (P.fadeMs ?? 250) / 1000, a = Math.min(p(t, s, s + fade), 1 - p(t, e - fade, e));
  const kind = P.kind || "night";
  const bg = kind === "night" ? "rgba(88,40,190,.38)" : kind === "red" ? "rgba(255,20,20,.42)" : kind === "warm" ? "rgba(255,150,40,.16)" : "radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.0) 30%, rgba(255,240,255,.55) 100%)";
  // The blend with the picture is the layer's own blend mode (kit: tint-fx blend → transform.blend), so the preview
  // and the export both multiply/screen it over the video; drawn here as a plain colour.
  return <div style={abs({ inset: 0, background: bg, opacity: a })} />;
};
