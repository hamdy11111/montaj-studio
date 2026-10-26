// Arabic text, the default animated reveal (plan §5): the smallest unit that moves is a whole word, so the letters are
// shaped by the browser exactly as in a static line — every frame. Three reveals:
//   words  each word rises in on its spoken time (or evenly), the key words bigger in the accent colour
//   wipe   the line is uncovered by a soft mask travelling right → left (the reading direction)
//   pop    each word pops with an overshoot
// Words sit in a right-to-left flex row that wraps, so a long sentence breaks between words, never inside one.
import React from "react";
import { abs, cl, p, outBack, outCubic, inCubic, lerp, inWin, useClock, fontStack } from "../motion.js";
import { usePack } from "../context.jsx";
import { splitWords, wordTimes, emphasisIndexes } from "../../arabic.js";

export const WordReveal = (P) => {
  const { t, s, e, W, H, k: K } = useClock(P);
  const pk = usePack();
  if (!inWin(t, s, e)) return null;
  const words = splitWords(P.text);
  const mode = P.mode || "words";
  const span = Math.min(1.6, Math.max(0.35, (e - s) * 0.35));
  const at = wordTimes(words, { times: P.times, span, start: 0.05 }).map((x) => s + x);
  const hot = new Set(emphasisIndexes(words, P.emphasis));
  const size = 92 * (P.size ?? 1) * K, out = inCubic(p(t, e - 0.3, e));
  const color = P.color || pk.colors.paper, accent = P.accent || pk.colors.accent, fam = fontStack(P.font || "Alexandria"), weight = P.weight ?? 800;
  // The wipe: a mask edge from the right edge to past the left one; 10 % of soft edge.
  const wk = outCubic(p(t, s, s + Math.max(0.4, span + 0.2)));
  const mask = mode === "wipe" ? { WebkitMaskImage: `linear-gradient(to left, #000 ${lerp(-10, 110, wk)}%, transparent ${lerp(0, 120, wk)}%)` } : {};
  const stroke = { WebkitTextStroke: `${size * 0.05}px ${pk.colors.ink}`, paintOrder: "stroke fill", textShadow: `0 ${size * 0.06}px ${size * 0.12}px rgba(0,0,0,.55)` };
  return (
    <div style={abs({ left: W * 0.07, right: W * 0.07, top: (P.y ?? 0.3) * H, transform: `translateY(-50%) translateY(${-out * size * 0.4}px)`, opacity: 1 - out, display: "flex", justifyContent: "center" })}>
      <div dir="rtl" style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "baseline", columnGap: size * 0.28, rowGap: size * 0.1, padding: P.box ? `${size * 0.22}px ${size * 0.45}px ${size * 0.3}px` : 0, background: P.box ? "rgba(11,11,15,0.78)" : "transparent", borderRadius: size * 0.22, ...mask }}>
        {words.map((w, i) => {
          const big = hot.has(i);
          let op = 1, ty = 0, sc = 1;
          if (mode === "words") { const k = p(t, at[i], at[i] + 0.22); op = cl(k * 1.6); ty = (1 - outCubic(k)) * size * 0.45; sc = big ? lerp(0.6, 1, outBack(k, 2.4)) : 1; }
          if (mode === "pop") { const k = p(t, at[i], at[i] + 0.2); op = cl(k * 3); sc = outBack(k, big ? 2.8 : 2); }
          return (
            <span key={i} style={{ display: "inline-block", fontFamily: fam, fontWeight: weight, fontSize: big ? size * 1.28 : size, lineHeight: 1.25, color: big ? accent : color, whiteSpace: "nowrap", opacity: op, transform: `translateY(${ty}px) scale(${sc})`, transformOrigin: "50% 80%", ...stroke }}>{w}</span>
          );
        })}
      </div>
    </div>
  );
};
