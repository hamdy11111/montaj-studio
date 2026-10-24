// Draws motion-graphics templates (core/graphics.js) on a full-frame transparent canvas at a local time. The same
// code feeds the live preview, the template thumbnails and the exporter (frame sequences), so graphics look the
// same everywhere. Arabic text is laid out right-to-left; emoji are the bundled 3D emoji, icons the bundled
// line icons tinted per use.
import { GRAPHIC_TEMPLATES, EMOJI_ALIASES, graphicParams, graphicStates, prog, EASE, clamp01, subjectAt, freeSide } from "../../core/graphics.js";
import { fontStack } from "../../core/fonts.js";
import { US } from "../../core/util.js";

const AR = /[؀-ۿ]/;
const assets = new Map(); // key → HTMLImageElement (loaded) | Promise

function loadImage(src) {
  return new Promise((resolve, reject) => { const im = new Image(); im.decoding = "async"; im.onload = () => resolve(im); im.onerror = () => reject(new Error(`asset ${src}`)); im.src = src; });
}
export const emojiId = (e) => EMOJI_ALIASES[String(e || "").trim()] || String(e || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
const emojiKey = (e) => `emoji:${emojiId(e)}`;
const iconKey = (name, color) => `icon:${name}:${color}`;

/** Load the emoji/icon images a graphic needs (resolves when ready; missing assets are skipped). */
export async function preloadGraphic(g) {
  const p = graphicParams(g);
  const want = (k, make) => {
    if (!assets.has(k)) assets.set(k, make().then((im) => { assets.set(k, im); }, () => { assets.set(k, null); }));
    const v = assets.get(k);
    return v && typeof v.then === "function" ? v : null; // still loading (this call or an earlier one): wait for it
  };
  const jobs = [];
  if (p.emoji) jobs.push(want(emojiKey(p.emoji), () => loadImage(`assets/emoji/${emojiId(p.emoji)}.png`)));
  if (p.icon) {
    jobs.push(want(iconKey(p.icon, "#FFFFFF"), () => fetch(`assets/icons/${encodeURIComponent(p.icon)}.svg`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("icon"))))
      .then((svg) => loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/currentColor/g, "#FFFFFF"))}`))));
  }
  await Promise.all(jobs.filter(Boolean));
}
const asset = (k) => { const a = assets.get(k); return a && !a.then ? a : null; };

// ------------------------------------------------------------------ drawing helpers
function rr(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const setFont = (g, weight, px, family) => { g.font = `${weight} ${Math.max(4, px)}px ${fontStack(family)}`; };
const shadow = (g, u, a = 0.45, blur = 22, dy = 6) => { g.shadowColor = `rgba(0,0,0,${a})`; g.shadowBlur = blur * u; g.shadowOffsetX = 0; g.shadowOffsetY = dy * u; };
const noShadow = (g) => { g.shadowColor = "transparent"; g.shadowBlur = 0; g.shadowOffsetY = 0; };
const hexA = (hex, a) => { const n = parseInt(String(hex || "#000000").slice(1, 7), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const posY = (p, H) => ({ top: 0.14, center: 0.5, bottom: 0.84, "lower-third": 0.78 }[p] ?? 0.5) * H;
const outFade = (t, D, out) => (out > 0 ? 1 - prog(t, D - out, D, EASE.in) : 1);
const isRtl = (s) => AR.test(String(s));

/** Where a head-anchored badge goes: beside the top of the head, on the free side (or above it). */
function headCorner(s, corner, sz, W, H, side0 = "right", extra = 0) {
  // Beside the head (not far out by the shoulders); the side is decided once per graphic (side0), and a hand or an
  // arm at head height pushes the badge out past it. `extra`: width of a label on the outer side.
  const hl = (s.hx - s.hw / 2) * W, hr = (s.hx + s.hw / 2) * W;
  const side = corner === "left" || corner === "right" || corner === "top" ? corner : side0;
  const clampX = (x) => Math.max(sz * 0.6 + (side === "left" ? extra : 0), Math.min(W - sz * 0.6 - (side === "right" ? extra : 0), x)), clampY = (y) => Math.max(sz * 0.6, Math.min(H - sz * 0.6, y));
  if (side === "top") return { cx: clampX(s.hx * W), cy: clampY((s.hy - s.hh / 2) * H - sz * 0.45), side };
  const edge = side === "right" ? Math.max(hr, s.x1 * W - sz) : Math.min(hl, s.x0 * W + sz);
  return { cx: clampX(side === "right" ? edge + sz * 0.6 : edge - sz * 0.6), cy: clampY((s.hy - s.hh * 0.3) * H), side };
}

/** Words laid out on up to `maxLines` balanced lines within maxW: [{ words: [{ w, width }], width }]. */
function layoutWords(g, text, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const gap = g.measureText(" ").width;
  const ws = words.map((w) => ({ w, width: g.measureText(w).width }));
  const total = ws.reduce((s, x) => s + x.width, 0) + gap * Math.max(0, ws.length - 1);
  if (total <= maxW) return { lines: [{ words: ws, width: total }], gap };
  // two balanced lines
  let best = null;
  for (let k = 1; k < ws.length; k++) {
    const a = ws.slice(0, k).reduce((s, x) => s + x.width, 0) + gap * (k - 1), b = ws.slice(k).reduce((s, x) => s + x.width, 0) + gap * (ws.length - k - 1);
    if (!best || Math.max(a, b) < best.m) best = { k, a, b, m: Math.max(a, b) };
  }
  return { lines: [{ words: ws.slice(0, best.k), width: best.a }, { words: ws.slice(best.k), width: best.b }], gap };
}

/** Draw laid-out lines centred at (cx, cy); per-word callback (index, x, y, word) after positions are known. */
function eachWord(lines, gap, cx, cy, lineH, rtl, fn) {
  const top = cy - (lineH * lines.length) / 2;
  let idx = 0;
  lines.forEach((ln, li) => {
    const y = top + lineH * (li + 0.5);
    let x = rtl ? cx + ln.width / 2 : cx - ln.width / 2;
    for (const w of ln.words) {
      const mid = rtl ? x - w.width / 2 : x + w.width / 2;
      fn(idx++, mid, y, w);
      x = rtl ? x - w.width - gap : x + w.width + gap;
    }
  });
}

// ------------------------------------------------------------------ templates
const DRAW = {
  "title-reveal"(g, W, H, p, t, D, tpl, u) {
    const px = 92 * u * p.size;
    setFont(g, 900, px, p.font);
    const rtl = isRtl(p.text);
    g.direction = rtl ? "rtl" : "ltr";
    const { lines, gap } = layoutWords(g, p.text, W * 0.84);
    const lineH = px * 1.22;
    const cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    const lift = (1 - fade) * px * 0.4;
    const n = lines.reduce((s, l) => s + l.words.length, 0);
    const step = Math.min(0.09, 0.55 / Math.max(1, n));
    if (p.box) {
      const bw = Math.max(...lines.map((l) => l.width)) + px * 0.9, bh = lineH * lines.length + px * 0.5;
      const k = prog(t, 0, 0.45, EASE.out);
      g.globalAlpha = fade; shadow(g, u, 0.35, 30, 10);
      g.fillStyle = "rgba(10,10,16,0.72)"; rr(g, W / 2 - (bw * k) / 2, cy - bh / 2 - lift, bw * k, bh, px * 0.32); g.fill(); noShadow(g);
    }
    g.textAlign = "center"; g.textBaseline = "middle";
    eachWord(lines, gap, W / 2, cy - lift, lineH, rtl, (i, x, y, w) => {
      const k = prog(t, i * step, i * step + 0.5, EASE.back);
      const a = clamp01(prog(t, i * step, i * step + 0.25)) * fade;
      if (a <= 0) return;
      g.save(); g.globalAlpha = a; g.translate(x, y + (1 - k) * px * 0.55); g.scale(0.88 + 0.12 * k, 0.88 + 0.12 * k);
      shadow(g, u, 0.5, 26, 8); g.fillStyle = p.color; g.fillText(w.w, 0, 0); g.restore();
    });
    // accent bar
    const bk = prog(t, 0.35 + n * step * 0.6, 0.85 + n * step * 0.6, EASE.out);
    if (bk > 0) {
      const bw = Math.max(...lines.map((l) => l.width)) * 0.42 * bk, bh = Math.max(4, px * 0.11);
      g.globalAlpha = fade; shadow(g, u, 0.3, 12, 3); g.fillStyle = p.accent;
      rr(g, W / 2 - bw / 2, cy + (lineH * lines.length) / 2 + px * 0.16 - lift, bw, bh, bh / 2); g.fill(); noShadow(g);
    }
    if (p.subtitle) {
      const sk = prog(t, 0.45, 0.9, EASE.out);
      setFont(g, 600, px * 0.42, p.font); g.direction = isRtl(p.subtitle) ? "rtl" : "ltr";
      g.globalAlpha = sk * fade * 0.92; shadow(g, u, 0.5, 18, 5); g.fillStyle = p.color;
      g.fillText(p.subtitle, W / 2, cy + (lineH * lines.length) / 2 + px * 0.62 + (1 - sk) * px * 0.3 - lift); noShadow(g);
    }
  },

  "lower-third"(g, W, H, p, t, D, tpl, u) {
    const rtl = isRtl(p.title + p.subtitle);
    const startRight = (p.side === "start") === rtl; // the reading start side
    const tpx = 66 * u, spx = 42 * u, pad = 36 * u, bar = 12 * u;
    setFont(g, 800, tpx, p.font); const tw = g.measureText(p.title).width;
    setFont(g, 500, spx, p.font); const sw = p.subtitle ? g.measureText(p.subtitle).width : 0;
    const pw = Math.max(tw, sw) + pad * 2 + bar, ph = tpx * 1.25 + (p.subtitle ? spx * 1.35 : 0) + pad * 1.1;
    const fade = outFade(t, D, tpl.outUs / US), drop = (1 - fade) * ph * 0.5;
    const y = H * 0.8 - ph / 2 + drop;
    const x0 = startRight ? W - W * 0.05 : W * 0.05;
    const kb = prog(t, 0, 0.3, EASE.out), kp = prog(t, 0.12, 0.6, EASE.out);
    g.globalAlpha = fade;
    shadow(g, u, 0.35, 30, 10);
    g.fillStyle = "rgba(12,12,18,0.8)";
    const w = (pw - bar) * kp;
    rr(g, startRight ? x0 - bar - w : x0 + bar, y, w, ph, 14 * u); g.fill(); noShadow(g);
    g.fillStyle = p.accent; rr(g, startRight ? x0 - bar : x0, y + ph * (1 - kb) / 2, bar, ph * kb, bar / 2); g.fill();
    g.save(); g.beginPath(); g.rect(startRight ? x0 - bar - w : x0 + bar, y, w, ph); g.clip();
    const tx = startRight ? x0 - bar - pad : x0 + bar + pad;
    g.textAlign = startRight ? "right" : "left"; g.textBaseline = "middle"; g.direction = rtl ? "rtl" : "ltr";
    const kt = prog(t, 0.3, 0.7, EASE.out), ks = prog(t, 0.42, 0.85, EASE.out);
    setFont(g, 800, tpx, p.font); g.fillStyle = p.color; g.globalAlpha = fade * kt;
    g.fillText(p.title, tx + (startRight ? 1 : -1) * (1 - kt) * 40 * u, y + pad * 0.55 + tpx * 0.62);
    if (p.subtitle) { setFont(g, 500, spx, p.font); g.globalAlpha = fade * ks * 0.85; g.fillText(p.subtitle, tx + (startRight ? 1 : -1) * (1 - ks) * 40 * u, y + pad * 0.55 + tpx * 1.25 + spx * 0.68); }
    g.restore();
  },

  "list-item"(g, W, H, p, t, D, tpl, u) {
    const rtl = isRtl(p.text);
    const R = 66 * u, tpx = 66 * u;
    setFont(g, 800, tpx, p.font); const tw = g.measureText(p.text).width;
    const emo = p.emoji ? asset(emojiKey(p.emoji)) : null, es = R * 2.2;
    const pillH = R * 1.7, pillW = tw + R * 2.2 + (emo ? es * 0.85 : 0);
    const total = R * 2 + pillW - R * 0.6;
    const cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    const bx = rtl ? W / 2 + total / 2 - R : W / 2 - total / 2 + R; // badge centre
    const kb = prog(t, 0, 0.38, EASE.back), kp = prog(t, 0.2, 0.62, EASE.out);
    g.globalAlpha = fade;
    // pill grows out of the badge
    const w = pillW * kp;
    shadow(g, u, 0.35, 26, 8); g.fillStyle = "rgba(14,14,20,0.82)";
    rr(g, rtl ? bx - R * 0.4 - w : bx + R * 0.4, cy - pillH / 2, w, pillH, pillH / 2); g.fill(); noShadow(g);
    g.save(); g.beginPath(); g.rect(rtl ? bx - R * 0.4 - w : bx + R * 0.4, cy - pillH / 2, w, pillH); g.clip();
    g.textAlign = rtl ? "right" : "left"; g.textBaseline = "middle"; g.direction = rtl ? "rtl" : "ltr";
    setFont(g, 800, tpx, p.font); g.fillStyle = p.color; g.globalAlpha = fade * prog(t, 0.32, 0.6);
    g.fillText(p.text, rtl ? bx - R * 1.45 : bx + R * 1.45, cy + tpx * 0.04);
    g.restore();
    // badge
    g.save(); g.globalAlpha = fade; g.translate(bx, cy); g.scale(kb, kb);
    shadow(g, u, 0.4, 20, 6); g.fillStyle = p.accent; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill(); noShadow(g);
    g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 4 * u; g.beginPath(); g.arc(0, 0, R - 2 * u, 0, Math.PI * 2); g.stroke();
    setFont(g, 900, R * 1.05, "Alexandria"); g.fillStyle = "#FFFFFF"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(p.number), 0, R * 0.06);
    g.restore();
    if (emo) {
      const ke = prog(t, 0.5, 0.85, EASE.back), bob = Math.sin(t * Math.PI * 1.6) * 4 * u;
      const ex = rtl ? bx - R * 0.4 - pillW + es * 0.35 : bx + R * 0.4 + pillW - es * 0.35;
      g.save(); g.globalAlpha = fade; g.translate(ex, cy - R * 0.25 + bob); g.rotate(-0.12 * (1 - ke)); g.scale(ke, ke);
      shadow(g, u, 0.3, 14, 5); g.drawImage(emo, -es / 2, -es / 2, es, es); g.restore();
    }
  },

  checklist(g, W, H, p, t, D, tpl, u) {
    const items = (p.items || []).slice(0, 6);
    const rtl = isRtl(items.join(" ") + p.title);
    const ipx = 46 * u, rowH = ipx * 1.75, tpx = 54 * u, pad = 40 * u, box = ipx * 0.95;
    setFont(g, 700, ipx, p.font);
    const iw = Math.max(...items.map((s) => g.measureText(s).width), 0);
    setFont(g, 900, tpx, p.font); const tw = p.title ? g.measureText(p.title).width : 0;
    const cw = Math.max(iw + box + pad * 2.5, tw + pad * 2), ch = items.length * rowH + pad * 1.6 + (p.title ? tpx * 1.6 : 0);
    const cx = W / 2, cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    const kc = prog(t, 0, 0.4, EASE.out);
    g.globalAlpha = fade * kc; shadow(g, u, 0.4, 34, 12); g.fillStyle = "rgba(12,12,18,0.8)";
    rr(g, cx - cw / 2, cy - ch / 2 + (1 - kc) * 30 * u, cw, ch, 26 * u); g.fill(); noShadow(g);
    let y = cy - ch / 2 + pad;
    g.direction = rtl ? "rtl" : "ltr"; g.textBaseline = "middle";
    if (p.title) { setFont(g, 900, tpx, p.font); g.textAlign = "center"; g.fillStyle = p.accent; g.globalAlpha = fade * prog(t, 0.15, 0.45); g.fillText(p.title, cx, y + tpx * 0.55); y += tpx * 1.6; }
    items.forEach((s, i) => {
      const a = 0.3 + i * 0.32, k = prog(t, a, a + 0.35, EASE.out);
      const ry = y + rowH * (i + 0.5);
      const bxx = rtl ? cx + cw / 2 - pad - box : cx - cw / 2 + pad;
      g.globalAlpha = fade * k;
      g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 4 * u; rr(g, bxx, ry - box / 2, box, box, 8 * u); g.stroke();
      if (i < (p.checked ?? items.length)) {
        const kk = prog(t, a + 0.18, a + 0.5, EASE.out);
        if (kk > 0) {
          g.fillStyle = p.accent; rr(g, bxx, ry - box / 2, box, box, 8 * u); g.globalAlpha = fade * kk; g.fill();
          g.strokeStyle = "#FFFFFF"; g.lineWidth = 6 * u; g.lineCap = "round"; g.lineJoin = "round";
          const pts = [[0.22, 0.52], [0.43, 0.72], [0.8, 0.3]].map(([px, py]) => [bxx + px * box, ry - box / 2 + py * box]);
          const L1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), L2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
          g.setLineDash([L1 + L2]); g.lineDashOffset = (L1 + L2) * (1 - kk);
          g.beginPath(); g.moveTo(...pts[0]); g.lineTo(...pts[1]); g.lineTo(...pts[2]); g.stroke(); g.setLineDash([]);
        }
      }
      setFont(g, 700, ipx, p.font); g.fillStyle = p.color; g.globalAlpha = fade * k; g.textAlign = rtl ? "right" : "left";
      g.fillText(s, rtl ? bxx - box * 0.45 + (1 - k) * 30 * u : bxx + box * 1.45 - (1 - k) * 30 * u, ry);
    });
  },

  counter(g, W, H, p, t, D, tpl, u) {
    const k = prog(t, 0, 1.2, EASE.inOut);
    const v = p.from + (p.to - p.from) * k;
    const txt = `${p.prefix}${v.toLocaleString("en-US", { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals })}${p.suffix}`;
    const px = 160 * u, cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    const pop = 1 + 0.08 * Math.sin(Math.PI * clamp01((t - 1.15) / 0.3));
    g.save(); g.globalAlpha = fade * prog(t, 0, 0.2); g.translate(W / 2, cy); g.scale(pop, pop);
    setFont(g, 900, px, p.font); g.textAlign = "center"; g.textBaseline = "middle"; g.direction = "ltr";
    shadow(g, u, 0.5, 30, 10); g.fillStyle = p.accent; g.fillText(txt, 0, 0); noShadow(g); g.restore();
    if (p.label) {
      const kl = prog(t, 0.3, 0.7, EASE.out);
      setFont(g, 700, px * 0.3, "Cairo"); g.direction = isRtl(p.label) ? "rtl" : "ltr"; g.textAlign = "center";
      g.globalAlpha = fade * kl; shadow(g, u, 0.5, 18, 5); g.fillStyle = p.color; g.fillText(p.label, W / 2, cy + px * 0.72 + (1 - kl) * 20 * u); noShadow(g);
    }
  },

  callout(g, W, H, p, t, D, tpl, u) {
    const fade = outFade(t, D, tpl.outUs / US);
    const tx = p.x * W, ty = p.y * H;
    const right = p.x < 0.5; // label goes to the open side
    const lx = tx + (right ? 1 : -1) * W * 0.16, ly = ty - H * 0.16;
    // pulsing target
    const ring = (t * 1.2) % 1;
    g.globalAlpha = fade * (1 - ring) * prog(t, 0, 0.3); g.strokeStyle = p.accent; g.lineWidth = 5 * u;
    g.beginPath(); g.arc(tx, ty, 16 * u + ring * 40 * u, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = fade * prog(t, 0, 0.25); g.fillStyle = p.accent; g.beginPath(); g.arc(tx, ty, 12 * u, 0, Math.PI * 2); g.fill();
    // line
    const kl = prog(t, 0.15, 0.55, EASE.out);
    g.globalAlpha = fade; g.strokeStyle = p.accent; g.lineWidth = 6 * u; g.lineCap = "round";
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx + (lx - tx) * kl, ty + (ly - ty) * kl); g.stroke();
    // bubble
    const kb = prog(t, 0.4, 0.8, EASE.back);
    if (kb > 0) {
      setFont(g, 800, 46 * u, p.font); const w = g.measureText(p.text).width + 50 * u, h = 82 * u;
      g.save(); g.translate(lx, ly); g.scale(kb, kb); shadow(g, u, 0.35, 22, 8); g.fillStyle = p.accent; rr(g, -w / 2, -h / 2, w, h, h / 2); g.fill(); noShadow(g);
      g.fillStyle = p.color; g.textAlign = "center"; g.textBaseline = "middle"; g.direction = isRtl(p.text) ? "rtl" : "ltr"; g.fillText(p.text, 0, 2 * u); g.restore();
    }
  },

  "highlight-box"(g, W, H, p, t, D, tpl, u) {
    const fade = outFade(t, D, tpl.outUs / US);
    const x = p.x * W, y = p.y * H, w = p.w * W, h = p.h * H, r = 22 * u;
    const per = 2 * (w + h);
    const k = prog(t, 0, 0.7, EASE.inOut);
    const pulse = 1 + 0.15 * Math.sin(t * Math.PI * 2);
    g.globalAlpha = fade; g.strokeStyle = p.accent; g.lineWidth = 8 * u * pulse; g.shadowColor = hexA(p.accent, 0.8); g.shadowBlur = 24 * u;
    g.setLineDash([per]); g.lineDashOffset = per * (1 - k); rr(g, x, y, w, h, r); g.stroke(); g.setLineDash([]); noShadow(g);
    if (p.text) {
      const kt = prog(t, 0.55, 0.9, EASE.back);
      setFont(g, 800, 40 * u, p.font); const tw = g.measureText(p.text).width + 40 * u, th = 66 * u;
      g.save(); g.translate(x + tw / 2, y - th * 0.7); g.scale(kt, kt); g.fillStyle = p.accent; rr(g, -tw / 2, -th / 2, tw, th, 14 * u); g.fill();
      g.fillStyle = "#FFFFFF"; g.textAlign = "center"; g.textBaseline = "middle"; g.direction = isRtl(p.text) ? "rtl" : "ltr"; g.fillText(p.text, 0, 2 * u); g.restore();
    }
  },

  emoji(g, W, H, p, t, D, tpl, u) {
    const im = asset(emojiKey(p.emoji));
    const S = p.size * Math.min(W, H);
    const fade = outFade(t, D, tpl.outUs / US);
    const kin = prog(t, 0, 0.45, EASE.back), kout = 1 - prog(t, D - tpl.outUs / US, D, EASE.in);
    let dy = 0, rot = 0, sc = 1;
    if (p.motion === "float") dy = Math.sin(t * Math.PI * 1.6) * 0.06 * S;
    if (p.motion === "wiggle") rot = Math.sin(t * Math.PI * 3) * 0.18;
    if (p.motion === "pulse") sc = 1 + 0.07 * Math.sin(t * Math.PI * 3.2);
    if (p.motion === "spin") rot = t * Math.PI;
    g.save(); g.globalAlpha = fade; g.translate(p.x * W, p.y * H + dy); g.rotate(rot); const s = kin * kout * sc; g.scale(s, s);
    shadow(g, u, 0.3, 20, 8);
    if (im) g.drawImage(im, -S / 2, -S / 2, S, S);
    else { g.font = `${S * 0.8}px "Segoe UI Emoji", "Noto Color Emoji", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(p.emoji, 0, 0); }
    g.restore();
  },

  "icon-badge"(g, W, H, p, t, D, tpl, u) {
    const rtl = isRtl(p.text), R = 70 * u, cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    setFont(g, 800, 58 * u, p.font); const tw = p.text ? g.measureText(p.text).width + 70 * u : 0;
    const total = R * 2 + (tw ? tw + 18 * u : 0);
    const cx = rtl ? W / 2 + total / 2 - R : W / 2 - total / 2 + R;
    const kb = prog(t, 0, 0.4, EASE.back), kt = prog(t, 0.22, 0.6, EASE.out);
    if (tw) {
      g.globalAlpha = fade * kt; shadow(g, u, 0.35, 22, 8); g.fillStyle = "rgba(14,14,20,0.82)";
      const w = tw * kt; rr(g, rtl ? cx - R - 18 * u - w : cx + R + 18 * u, cy - R * 0.72, w, R * 1.44, R * 0.72); g.fill(); noShadow(g);
      g.fillStyle = p.color; g.textAlign = rtl ? "right" : "left"; g.textBaseline = "middle"; g.direction = rtl ? "rtl" : "ltr";
      g.fillText(p.text, rtl ? cx - R - 48 * u : cx + R + 48 * u, cy + 2 * u);
    }
    g.save(); g.globalAlpha = fade; g.translate(cx, cy); g.scale(kb, kb); g.rotate((1 - kb) * -0.6);
    shadow(g, u, 0.4, 22, 8); g.fillStyle = p.accent; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill(); noShadow(g);
    const im = asset(iconKey(p.icon, "#FFFFFF")); if (im) g.drawImage(im, -R * 0.55, -R * 0.55, R * 1.1, R * 1.1);
    g.restore();
  },

  "big-word"(g, W, H, p, t, D, tpl, u) {
    const px = 210 * u * p.size, cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    const k = prog(t, 0, 0.5, EASE.out);
    const sc = 1.35 - 0.35 * k;
    g.save(); g.globalAlpha = fade * clamp01(k * 1.5); g.translate(W / 2, cy); g.scale(sc, sc);
    if (k < 0.99) g.filter = `blur(${((1 - k) * 14 * u).toFixed(1)}px)`;
    setFont(g, 900, px, p.font); g.textAlign = "center"; g.textBaseline = "middle"; g.direction = isRtl(p.text) ? "rtl" : "ltr";
    g.shadowColor = hexA(p.accent, 0.85); g.shadowBlur = 40 * u;
    g.lineJoin = "round"; g.lineWidth = px * 0.06; g.strokeStyle = p.accent; g.strokeText(p.text, 0, 0);
    g.fillStyle = p.color; g.fillText(p.text, 0, 0);
    g.restore();
  },

  "behind-title"(g, W, H, p, t, D, tpl, u) {
    // Fitted to `width` of the frame (capped by height): wider than a head, so the person covers only its middle.
    setFont(g, 900, 100, p.font);
    const m = g.measureText(p.text);
    const px = Math.min((100 * W * p.width) / Math.max(1, m.width), H * 0.55);
    const k = prog(t, 0, tpl.inUs / US, EASE.out), fade = outFade(t, D, tpl.outUs / US);
    // Kept inside the frame vertically (tall Arabic letters at the top would be cut off).
    setFont(g, 900, px, p.font); g.textBaseline = "middle";
    const mm = g.measureText(p.text), asc = mm.actualBoundingBoxAscent || px * 0.5, desc = mm.actualBoundingBoxDescent || px * 0.3;
    const cy = Math.max(asc + 0.03 * H, Math.min(H - desc - 0.03 * H, p.y * H)) + (1 - k) * 0.06 * H;
    // Centred on x, but kept inside the frame.
    const half = Math.min(W / 2, (m.width * px) / 200), cx = Math.max(half, Math.min(W - half, p.x * W));
    g.save();
    g.globalAlpha = fade * clamp01(k * 1.4);
    g.translate(cx, cy); g.scale(0.88 + 0.12 * k, 0.88 + 0.12 * k);
    setFont(g, 900, px, p.font); g.textAlign = "center"; g.textBaseline = "middle"; g.direction = isRtl(p.text) ? "rtl" : "ltr";
    g.shadowColor = "rgba(0,0,0,0.35)"; g.shadowBlur = 30 * u; g.shadowOffsetY = 8 * u;
    if (p.style === "outline") {
      g.lineJoin = "round"; g.lineWidth = Math.max(3, px * 0.035); g.strokeStyle = p.color; g.strokeText(p.text, 0, 0);
    } else {
      if (p.style === "gradient") { const gr = g.createLinearGradient(0, -px * 0.45, 0, px * 0.45); gr.addColorStop(0, p.color); gr.addColorStop(1, p.color2); g.fillStyle = gr; } else g.fillStyle = p.color;
      g.fillText(p.text, 0, 0);
    }
    g.restore();
  },

  // ---- kinetic, person-aware (the person is drawn over these: they come out from behind the head)
  "emerge-side"(g, W, H, p, t, D, tpl, u) {
    const s = subjectAt(p.subject, t);
    const L = s.x0 * W, R = s.x1 * W; // the silhouette at head height (a raised arm counts)
    const side = freeSide(p.subject, p.side);
    const free = Math.max(W * 0.18, side === "right" ? W - R : L), gap = 0.02 * W;
    setFont(g, 900, 100, p.font);
    const m100 = g.measureText(p.text).width || 1;
    const pad = p.style === "box" ? 0.3 : 0;
    const px = Math.max(H * 0.05, Math.min(H * 0.17 * p.size, (100 * (free - gap * 2)) / (m100 * (1 + pad * 0.6))));
    setFont(g, 900, px, p.font);
    const tw = g.measureText(p.text).width, bw = tw + px * pad * 2, bh = px * (p.style === "box" ? 1.35 : 1.1);
    // From mostly behind the head to beside it; back again at the end.
    const inFrame = (x) => Math.max(0.02 * W, Math.min(W - bw - 0.02 * W, x));
    const final = inFrame(side === "right" ? R + gap : L - gap - bw), start = side === "right" ? Math.min(final, R - bw * 0.9) : Math.max(final, L - bw * 0.1);
    const kIn = prog(t, 0, tpl.inUs / US), kOut = prog(t, D - tpl.outUs / US, D, EASE.in);
    const xAt = (tt) => { const a = prog(tt, 0, tpl.inUs / US, EASE.back), b = prog(tt, D - tpl.outUs / US, D, EASE.in); return start + (final - start) * a + (start - final) * b; };
    const x = xAt(t), y = Math.max(bh / 2 + 0.03 * H, Math.min(H - bh / 2 - 0.03 * H, (s.hy - s.hh * 0.08) * H));
    const v = Math.abs(xAt(t) - xAt(t - 1 / 30)); // pixels per frame: a light motion trail while moving
    const alpha = clamp01(t / 0.06) * (1 - kOut * 0.25);
    const drawAt = (bx, a) => {
      g.save(); g.globalAlpha = a; g.translate(bx, y);
      if (p.style === "box") { shadow(g, u, 0.35, 26, 8); g.fillStyle = p.accent; rr(g, 0, -bh / 2, bw, bh, bh * 0.22); g.fill(); noShadow(g); }
      else shadow(g, u, 0.4, 22, 6);
      g.textAlign = "center"; g.textBaseline = "middle"; g.direction = isRtl(p.text) ? "rtl" : "ltr";
      if (p.style === "outline") { g.lineJoin = "round"; g.lineWidth = Math.max(3, px * 0.06); g.strokeStyle = p.color; g.strokeText(p.text, bw / 2, px * 0.04); }
      else {
        if (p.style === "gradient") { const gr = g.createLinearGradient(0, -px / 2, 0, px / 2); gr.addColorStop(0, p.color); gr.addColorStop(1, p.accent); g.fillStyle = gr; } else g.fillStyle = p.color;
        g.fillText(p.text, bw / 2, px * 0.04);
      }
      g.restore();
    };
    if (v > 4 && kIn < 1) for (let k = 3; k >= 1; k--) drawAt(x + (side === "right" ? -1 : 1) * v * k * 0.6, alpha * 0.12 * (4 - k));
    drawAt(x, alpha);
  },

  "rise-behind"(g, W, H, p, t, D, tpl, u) {
    const s = subjectAt(p.subject, t);
    setFont(g, 900, 100, p.font);
    const m100 = g.measureText(p.text).width || 1;
    const headTop = (s.hy - s.hh / 2) * H, L = s.x0 * W, R = s.x1 * W;
    // Above the head when there is room for it; otherwise it rises on the free side, beside the head.
    const aboveRoom = headTop - 0.03 * H;
    let px = Math.max(H * 0.08, Math.min(H * 0.3 * p.size, (100 * W * 0.86) / m100, aboveRoom / 0.75));
    const above = aboveRoom >= H * 0.09;
    let cx = s.hx * W;
    if (!above) {
      const right = freeSide(p.subject) === "right", room = Math.max(W * 0.2, right ? W - R : L);
      px = Math.max(H * 0.06, Math.min(H * 0.24 * p.size, (100 * room * 0.86) / m100));
      cx = right ? R + room / 2 : room / 2;
    }
    setFont(g, 900, px, p.font);
    const mm = g.measureText(p.text), tw = mm.width, asc = mm.actualBoundingBoxAscent || px * 0.55, desc = mm.actualBoundingBoxDescent || px * 0.3;
    // Above: stands on the head (its lower edge just behind the hair). Beside: at eye height. Rises from below.
    const finalY = above ? Math.max(asc + 0.03 * H, headTop + desc * 0.15) : Math.max(asc + 0.03 * H, Math.min(H - desc - 0.03 * H, s.hy * H + asc / 2));
    const startY = Math.min(H + asc, (above ? (s.hy + s.hh * 0.75) * H : H) + asc);
    const kIn = prog(t, 0, tpl.inUs / US, EASE.back), kOut = prog(t, D - tpl.outUs / US, D, EASE.in);
    const y = startY + (finalY - startY) * kIn + (startY - finalY) * kOut;
    const x = Math.max(tw / 2 + 0.03 * W, Math.min(W - tw / 2 - 0.03 * W, cx));
    const sc = 0.92 + 0.08 * Math.min(1, kIn);
    g.save(); g.globalAlpha = clamp01(t / 0.08); g.translate(x, y); g.scale(sc, sc);
    g.textAlign = "center"; g.textBaseline = "alphabetic"; g.direction = isRtl(p.text) ? "rtl" : "ltr";
    shadow(g, u, 0.35, 30, 10);
    if (p.style === "outline") { g.lineJoin = "round"; g.lineWidth = Math.max(4, px * 0.045); g.strokeStyle = p.color; g.strokeText(p.text, 0, 0); }
    else {
      if (p.style === "gradient") { const gr = g.createLinearGradient(0, -asc, 0, desc); gr.addColorStop(0, p.color); gr.addColorStop(1, p.color2); g.fillStyle = gr; } else g.fillStyle = p.color;
      g.fillText(p.text, 0, 0);
    }
    g.restore();
  },

  "word-stack"(g, W, H, p, t, D, tpl, u) {
    const s = subjectAt(p.subject, t);
    const L = s.x0 * W, R = s.x1 * W;
    const side = freeSide(p.subject, p.side);
    const free = Math.max(W * 0.2, side === "right" ? W - R : L), gap = 0.022 * W;
    const words = (p.words || []).filter(Boolean).slice(0, 4);
    if (!words.length) return;
    const inS = tpl.inUs / US, outS = tpl.outUs / US;
    const span = Math.max(0.2, D - outS - inS - 0.3);
    const at = words.map((_, i) => (p.times?.[i] !== undefined ? p.times[i] / 1000 : (span * i) / Math.max(1, words.length - 1 || 1)));
    // Each word sized to the free width (short words bigger), stacked as a block centred on the head.
    const sizes = words.map((w) => { setFont(g, 900, 100, p.font); const m = g.measureText(w).width || 1; return Math.max(H * 0.05, Math.min(H * 0.14 * p.size, (100 * (free - gap * 2)) / m)); });
    const lineH = sizes.map((x) => x * 1.12), total = lineH.reduce((a, b) => a + b, 0);
    // From the top of the head down (lower down, the shoulders would hide the last words).
    let y = Math.max(0.04 * H, Math.min(H - total - 0.04 * H, (s.hy - s.hh / 2) * H + 0.02 * H));
    const kOut = prog(t, D - outS, D, EASE.in);
    words.forEach((w, i) => {
      const px = sizes[i];
      setFont(g, 900, px, p.font);
      const tw = g.measureText(w).width;
      const final = Math.max(0.02 * W, Math.min(W - tw - 0.02 * W, side === "right" ? R + gap : L - gap - tw));
      const start = side === "right" ? Math.min(final, R - tw * 0.9) : Math.max(final, L - tw * 0.1);
      const k = prog(t, at[i], at[i] + inS, EASE.back);
      const x = start + (final - start) * k + (start - final) * kOut;
      const cy = y + lineH[i] / 2;
      y += lineH[i];
      if (t < at[i]) return;
      g.save(); g.globalAlpha = clamp01((t - at[i]) / 0.06);
      g.textAlign = "left"; g.textBaseline = "middle"; g.direction = "ltr"; // measured box: draw from its left edge
      shadow(g, u, 0.4, 22, 6);
      g.fillStyle = i % 2 ? p.accent : p.color;
      g.fillText(w, x, cy);
      g.restore();
    });
  },

  "pass-behind"(g, W, H, p, t, D, tpl, u) {
    const s = subjectAt(p.subject, t);
    setFont(g, 900, 100, p.font);
    const px = H * 0.24 * p.size;
    setFont(g, 900, px, p.font);
    const tw = g.measureText(p.text).width;
    const k = clamp01(t / D); // constant speed, on screen from the first frame to the last
    const from = p.direction === "rtl" ? W * 0.82 + tw / 2 : W * 0.18 - tw / 2, to = p.direction === "rtl" ? W * 0.18 - tw / 2 : W * 0.82 + tw / 2;
    const x = from + (to - from) * k, y = Math.max(px * 0.6, Math.min(H - px * 0.6, (s.hy - s.hh * 0.18) * H));
    g.save(); g.translate(x, y);
    g.textAlign = "center"; g.textBaseline = "middle"; g.direction = isRtl(p.text) ? "rtl" : "ltr";
    if (p.style === "outline") { shadow(g, u, 0.3, 18, 4); g.lineJoin = "round"; g.lineWidth = Math.max(4, px * 0.04); g.strokeStyle = p.color; g.strokeText(p.text, 0, 0); }
    else { shadow(g, u, 0.35, 24, 6); g.fillStyle = p.color; g.fillText(p.text, 0, 0); }
    g.restore();
  },

  "head-emoji"(g, W, H, p, t, D, tpl, u) {
    const s = subjectAt(p.subject, t);
    const img = asset(emojiKey(p.emoji));
    const sz = p.size * H;
    const { cx, cy } = headCorner(s, p.corner, sz, W, H, freeSide(p.subject));
    const kIn = prog(t, 0, tpl.inUs / US, EASE.elastic), kOut = prog(t, D - tpl.outUs / US, D, EASE.in);
    let rot = 0, dy = 0, sc = kIn * (1 - kOut);
    if (p.motion === "wiggle") rot = Math.sin(t * 9) * 0.18;
    else if (p.motion === "bounce") dy = -Math.abs(Math.sin(t * 6)) * sz * 0.12;
    else if (p.motion === "float") dy = -t * sz * 0.25;
    else if (p.motion === "spin") rot = t * 4;
    if (sc <= 0.01) return;
    g.save(); g.translate(cx, cy + dy); g.rotate(rot - kOut * 0.6); g.scale(sc, sc);
    shadow(g, u, 0.35, 24, 8);
    if (img) g.drawImage(img, -sz / 2, -sz / 2, sz, sz);
    else { g.font = `${Math.round(sz * 0.8)}px "Segoe UI Emoji", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(p.emoji, 0, 0); }
    g.restore();
  },

  "head-icon"(g, W, H, p, t, D, tpl, u) {
    const s = subjectAt(p.subject, t);
    const sz = p.size * H;
    let labelW = 0;
    if (p.label) { setFont(g, 800, sz * 0.42, p.font); labelW = g.measureText(p.label).width + sz * 0.72; }
    const { cx, cy, side } = headCorner(s, p.corner, sz, W, H, freeSide(p.subject), labelW);
    const kIn = prog(t, 0, tpl.inUs / US, EASE.back), kOut = prog(t, D - tpl.outUs / US, D, EASE.in);
    const sc = Math.max(0, kIn * (1 - kOut));
    if (sc <= 0.01) return;
    g.save(); g.translate(cx, cy); g.scale(sc, sc); g.rotate(Math.sin(t * 5) * 0.05);
    shadow(g, u, 0.35, 24, 8);
    g.fillStyle = p.accent; g.beginPath(); g.arc(0, 0, sz / 2, 0, Math.PI * 2); g.fill(); noShadow(g);
    const ic = asset(iconKey(p.icon, "#FFFFFF"));
    if (ic) g.drawImage(ic, -sz * 0.3, -sz * 0.3, sz * 0.6, sz * 0.6);
    if (p.label) {
      setFont(g, 800, sz * 0.42, p.font); g.textBaseline = "middle"; g.direction = isRtl(p.label) ? "rtl" : "ltr";
      const lw = g.measureText(p.label).width, padX = sz * 0.28, lh = sz * 0.62;
      const lx = side === "left" ? -sz / 2 - sz * 0.15 - lw - padX * 2 : sz / 2 + sz * 0.15;
      g.globalAlpha = clamp01((t - 0.15) / 0.2); shadow(g, u, 0.3, 18, 6);
      g.fillStyle = "rgba(12,12,18,0.82)"; rr(g, lx, -lh / 2, lw + padX * 2, lh, lh / 2); g.fill(); noShadow(g);
      g.fillStyle = p.color; g.textAlign = "center"; g.fillText(p.label, lx + padX + lw / 2, sz * 0.02);
    }
    g.restore();
  },

  quote(g, W, H, p, t, D, tpl, u) {
    const rtl = isRtl(p.text), px = 78 * u, cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    setFont(g, 700, px, p.font); g.direction = rtl ? "rtl" : "ltr";
    const { lines, gap } = layoutWords(g, p.text, W * 0.74);
    const lineH = px * 1.45, n = lines.reduce((s, l) => s + l.words.length, 0);
    const cw = Math.max(...lines.map((l) => l.width)) + px * 1.6, ch = lineH * lines.length + px * (p.author ? 2.4 : 1.6);
    const kc = prog(t, 0, 0.45, EASE.out);
    g.globalAlpha = fade * kc; shadow(g, u, 0.4, 40, 14); g.fillStyle = "rgba(10,10,16,0.62)";
    rr(g, W / 2 - cw / 2, cy - ch / 2 + px * 0.25 + (1 - kc) * 30 * u, cw, ch, 30 * u); g.fill(); noShadow(g);
    const kq = prog(t, 0.1, 0.5, EASE.back);
    g.save(); g.globalAlpha = fade; g.translate(W / 2, cy - ch / 2 + px * 0.2); g.scale(kq, kq);
    shadow(g, u, 0.35, 16, 4); g.fillStyle = p.accent; g.beginPath(); g.arc(0, 0, px * 0.62, 0, Math.PI * 2); g.fill(); noShadow(g);
    setFont(g, 900, px * 1.3, "Alexandria"); g.fillStyle = "#111"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("“", 0, px * 0.32); g.restore();
    const step = Math.min(0.12, 0.9 / Math.max(1, n));
    setFont(g, 700, px, p.font); g.textAlign = "center"; g.textBaseline = "middle";
    eachWord(lines, gap, W / 2, cy + px * 0.35, lineH, rtl, (i, x, y, w) => {
      const k = prog(t, 0.25 + i * step, 0.25 + i * step + 0.35, EASE.out);
      if (k <= 0) return;
      g.globalAlpha = fade * k; shadow(g, u, 0.5, 20, 6); g.fillStyle = p.color; g.fillText(w.w, x, y + (1 - k) * px * 0.35); noShadow(g);
    });
    if (p.author) { setFont(g, 600, px * 0.46, p.font); g.globalAlpha = fade * prog(t, 0.9, 1.2); g.fillStyle = p.accent; g.fillText(`— ${p.author}`, W / 2, cy + px * 0.35 + (lineH * lines.length) / 2 + px * 0.55); }
  },

  "follow-cta"(g, W, H, p, t, D, tpl, u) {
    const rtl = isRtl(p.text), R = 58 * u, cy = posY(p.position, H);
    const fade = outFade(t, D, tpl.outUs / US);
    setFont(g, 800, 56 * u, p.font); const tw = g.measureText(p.text).width;
    const pw = tw + R * 2 + 70 * u, ph = R * 2 + 16 * u;
    const kb = prog(t, 0, 0.5, EASE.back), pulse = 1 + 0.035 * Math.sin(t * Math.PI * 2.4);
    g.save(); g.globalAlpha = fade; g.translate(W / 2, cy); g.scale(kb * pulse, kb * pulse);
    shadow(g, u, 0.4, 26, 8); g.fillStyle = p.accent; rr(g, -pw / 2, -ph / 2, pw, ph, ph / 2); g.fill(); noShadow(g);
    const ix = rtl ? pw / 2 - R - 8 * u : -pw / 2 + R + 8 * u;
    g.fillStyle = "rgba(255,255,255,0.22)"; g.beginPath(); g.arc(ix, 0, R, 0, Math.PI * 2); g.fill();
    const im = asset(iconKey(p.icon, "#FFFFFF"));
    if (im) { g.save(); g.translate(ix, 0); g.rotate(Math.sin(t * Math.PI * 5) * 0.25 * (t % 1.6 < 0.6 ? 1 : 0)); g.drawImage(im, -R * 0.6, -R * 0.6, R * 1.2, R * 1.2); g.restore(); }
    g.fillStyle = p.color; g.textAlign = "center"; g.textBaseline = "middle"; g.direction = rtl ? "rtl" : "ltr";
    g.fillText(p.text, rtl ? -R - 4 * u : R + 4 * u, 2 * u);
    g.restore();
  },

  "progress-bar"(g, W, H, p, t, D) {
    const h = Math.max(3, p.thickness * H), y = p.position === "bottom" ? H - h : 0;
    g.fillStyle = "rgba(255,255,255,0.18)"; g.fillRect(0, y, W, h);
    g.fillStyle = p.accent; g.fillRect(0, y, W * clamp01(t / Math.max(0.001, D)), h);
  },
};

/** Draw one graphic at local time tUs onto a new W×H transparent canvas. */
export function graphicCanvas(graphic, W, H, tUs, durationUs) {
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(W)); c.height = Math.max(2, Math.round(H));
  const tpl = GRAPHIC_TEMPLATES[graphic?.template];
  const draw = DRAW[graphic?.template];
  if (!tpl || !draw) return c;
  const g = c.getContext("2d");
  const u = Math.min(W, H) / 1080;
  try { draw(g, W, H, graphicParams(graphic), tUs / US, durationUs / US, tpl, u); } catch (e) { console.error("graphic", graphic.template, e); }
  return c;
}

/** Export: every distinct frame state as a PNG plus the timed sequence ({ caption: true, images, frames }). */
export async function graphicFrames(graphic, W, H, durationUs, fps) {
  await preloadGraphic(graphic);
  const states = graphicStates(graphic, durationUs, fps);
  const index = new Map(), images = [], frames = [];
  for (const st of states) {
    if (!index.has(st.key)) { index.set(st.key, images.length); images.push(graphicCanvas(graphic, W, H, st.tUs, durationUs).toDataURL("image/png")); }
    frames.push({ img: index.get(st.key), durUs: st.toUs - st.fromUs });
  }
  return { caption: true, images, frames };
}

/** Preview: the state at local time (µs), so a held frame is drawn once and cached. */
export function graphicStateAt(graphic, durationUs, fps, tUs) {
  const states = graphicStates(graphic, durationUs, fps);
  return states.find((s) => tUs >= s.fromUs && tUs < s.toUs) || states[states.length - 1];
}
