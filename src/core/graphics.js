// Motion graphics: the template catalogue (parameters, timing) and the frame-state logic shared by the preview,
// the exporter, the agents and the UI. Drawing lives in renderer/js/editor/graphicsRaster.js. A graphic is a text
// segment with text.graphic = { template, params } drawn full-frame (W×H, transparent) at its local time, so
// positions are part of the template parameters rather than the segment transform.
import { US } from "./util.js";
import { KIT_TEMPLATES } from "./graphicsKit.js";

const str = (title, def = "", max = 120) => ({ type: "string", maxLength: max, default: def, title });
const color = (title, def) => ({ type: "string", pattern: "^#[0-9A-Fa-f]{6}$", default: def, title });
const num = (title, min, max, def) => ({ type: "number", minimum: min, maximum: max, default: def, title });
const pos = (def, values = ["top", "center", "bottom", "lower-third"]) => ({ type: "string", enum: values, default: def, title: "Position" });
const font = (def) => ({ type: "string", maxLength: 60, default: def, title: "Font" });
const side = () => ({ type: "string", enum: ["auto", "left", "right"], default: "auto", title: "Side (auto = the free side)" });
// Filled by the app: { track: [[ms, hx, hy, hw, hh, x0, x1], …] } — head centre/size and person extent, fractions of
// the frame, 10 samples a second from the graphic's start. Empty: a centred person is assumed.
const subj = () => ({ type: "object", default: {}, title: "Person track (filled by the app)", properties: { track: { type: "array", maxItems: 2000, items: { type: "array", items: { type: "number" }, minItems: 7, maxItems: 7 } } } });

/**
 * The side with more free room beside the person over the whole graphic ("left" | "right"), so a graphic does not
 * jump sides while the person moves. `forced` ("left"/"right") wins.
 */
export function freeSide(subject, forced = "auto") {
  if (forced === "left" || forced === "right") return forced;
  const tr = subject?.track;
  if (!tr?.length) return "right";
  let score = 0;
  for (const f of tr) score += (1 - f[6]) - f[5]; // room right − room left
  return score >= 0 ? "right" : "left";
}

/** Head and person extent at local time t (seconds) from a graphic's subject track, interpolated. */
export function subjectAt(subject, t) {
  const tr = subject?.track;
  if (!tr?.length) return { hx: 0.5, hy: 0.4, hw: 0.26, hh: 0.5, x0: 0.25, x1: 0.75 };
  const ms = t * 1000;
  let i = 0;
  while (i < tr.length - 2 && tr[i + 1][0] <= ms) i++;
  const a = tr[i], b = tr[Math.min(i + 1, tr.length - 1)];
  const f = b[0] > a[0] ? Math.max(0, Math.min(1, (ms - a[0]) / (b[0] - a[0]))) : 0;
  const v = (k) => a[k] + (b[k] - a[k]) * f;
  return { hx: v(1), hy: v(2), hw: v(3), hh: v(4), x0: v(5), x1: v(6) };
}

/**
 * Templates. inUs/outUs: intro/outro animation lengths (frames are rendered one by one there; the hold between
 * is drawn once). loop: animated for its whole duration (every frame rendered).
 */
export const GRAPHIC_TEMPLATES = {
  "title-reveal": {
    name: "Title reveal", ar: "عنوان متحرك", use: "Hook titles and section titles: words rise in one by one with an accent bar",
    inUs: 900_000, outUs: 350_000, loop: false, durUs: 3_000_000,
    params: { text: str("Title", "عنوان قوي هنا", 80), subtitle: str("Subtitle", "", 100), font: font("Alexandria"), color: color("Text colour", "#FFFFFF"), accent: color("Accent", "#FFD84D"), position: pos("center"), size: num("Size", 0.5, 2, 1), box: { type: "boolean", default: false, title: "Solid background" } },
  },
  "lower-third": {
    name: "Lower third", ar: "شريط تعريفي", use: "Name/role, a key point, or a source under the speaker",
    inUs: 700_000, outUs: 400_000, loop: false, durUs: 4_000_000,
    params: { title: str("Title", "الاسم هنا", 60), subtitle: str("Subtitle", "الوصف أو الدور", 80), font: font("Cairo"), accent: color("Accent", "#3EE07B"), color: color("Text colour", "#FFFFFF"), side: { type: "string", enum: ["start", "end"], default: "start", title: "Side" } },
  },
  "list-item": {
    name: "Numbered point", ar: "نقطة مرقّمة", use: "Lists and steps: a number badge pops, the point slides out of it, optional emoji",
    inUs: 650_000, outUs: 300_000, loop: false, durUs: 3_000_000,
    params: { number: str("Number", "1", 4), text: str("Text", "النقطة الأولى", 60), emoji: str("Emoji (🔥 or name)", "", 40), font: font("Cairo"), accent: color("Accent", "#FF4D6D"), color: color("Text colour", "#FFFFFF"), position: pos("top") },
  },
  checklist: {
    name: "Checklist", ar: "قائمة مهام", use: "Summary of points; each item appears and gets a drawn check mark",
    inUs: 2_400_000, outUs: 350_000, loop: false, durUs: 5_000_000,
    params: { title: str("Title", "", 60), items: { type: "array", items: { type: "string", maxLength: 50 }, maxItems: 6, default: ["النقطة الأولى", "النقطة الثانية", "النقطة الثالثة"], title: "Items" }, checked: { type: "integer", minimum: 0, maximum: 6, default: 6, title: "Items checked" }, font: font("Cairo"), accent: color("Accent", "#3EE07B"), color: color("Text colour", "#FFFFFF"), position: pos("center") },
  },
  counter: {
    name: "Counter", ar: "عدّاد رقمي", use: "Numbers that matter: counts up to the value with a label",
    inUs: 1_400_000, outUs: 300_000, loop: false, durUs: 3_000_000,
    params: { from: num("From", -1e9, 1e9, 0), to: num("To", -1e9, 1e9, 100), decimals: { type: "integer", minimum: 0, maximum: 3, default: 0, title: "Decimals" }, prefix: str("Prefix", "", 8), suffix: str("Suffix", "%", 8), label: str("Label", "", 50), font: font("Alexandria"), accent: color("Accent", "#FFD84D"), color: color("Text colour", "#FFFFFF"), position: pos("center") },
  },
  callout: {
    name: "Callout arrow", ar: "سهم توضيحي", use: "Point at something in the picture (x, y as fractions of the frame) with a label",
    inUs: 800_000, outUs: 300_000, loop: true, durUs: 3_000_000,
    params: { x: num("Target x", 0, 1, 0.7), y: num("Target y", 0, 1, 0.55), text: str("Label", "هنا!", 40), font: font("Cairo"), accent: color("Accent", "#FFD84D"), color: color("Label text", "#111111") },
  },
  "highlight-box": {
    name: "Highlight box", ar: "إطار تمييز", use: "Draw a rounded frame around a region (x, y, w, h fractions) with a tag",
    inUs: 800_000, outUs: 300_000, loop: true, durUs: 3_000_000,
    params: { x: num("Left", 0, 1, 0.55), y: num("Top", 0, 1, 0.35), w: num("Width", 0.02, 1, 0.3), h: num("Height", 0.02, 1, 0.4), text: str("Tag", "", 40), font: font("Cairo"), accent: color("Accent", "#FF4D6D") },
  },
  emoji: {
    name: "Animated emoji", ar: "إيموجي متحرك", use: "A 3D emoji that pops in and keeps moving (float, wiggle, pulse, spin)",
    inUs: 450_000, outUs: 250_000, loop: true, durUs: 2_000_000,
    params: { emoji: str("Emoji (🔥 or name)", "🔥", 40), x: num("x", 0, 1, 0.8), y: num("y", 0, 1, 0.25), size: num("Size", 0.05, 0.6, 0.18), motion: { type: "string", enum: ["float", "wiggle", "pulse", "spin", "none"], default: "float", title: "Motion" } },
  },
  "icon-badge": {
    name: "Icon badge", ar: "أيقونة مع نص", use: "An icon in a circle with a short label (tips, warnings, likes)",
    inUs: 600_000, outUs: 300_000, loop: false, durUs: 2_500_000,
    params: { icon: str("Icon", "lightbulb", 40), text: str("Label", "نصيحة", 40), font: font("Cairo"), accent: color("Accent", "#7B5CFF"), color: color("Text colour", "#FFFFFF"), position: pos("top") },
  },
  "big-word": {
    name: "Big word", ar: "كلمة ضخمة", use: "One or two huge words for impact; best behind the person",
    inUs: 500_000, outUs: 300_000, loop: false, durUs: 2_000_000,
    params: { text: str("Text", "واو", 24), font: font("Lalezar"), color: color("Colour", "#FFFFFF"), accent: color("Outline / glow", "#FF4D6D"), position: pos("center"), size: num("Size", 0.5, 3, 1.4) },
  },
  "behind-title": {
    name: "Title behind the person", ar: "عنوان خلف الشخص", use: "A huge word across the frame with the person in front of it (put it behind the person); the head covers its middle",
    inUs: 650_000, outUs: 350_000, loop: false, durUs: 3_000_000,
    params: { text: str("Text", "خارق", 24), font: font("Lalezar"), color: color("Colour", "#FFFFFF"), color2: color("Lower colour (gradient)", "#FFD84D"), style: { type: "string", enum: ["solid", "gradient", "outline"], default: "gradient", title: "Style" }, x: num("Centre across (0 = left, 1 = right): put it on the head", 0.1, 0.9, 0.5), y: num("Centre down (0 = top, 1 = bottom)", 0.1, 0.9, 0.3), width: num("Width of the frame", 0.4, 0.98, 0.9) },
  },
  // ---- Kinetic, person-aware templates. `subject` is filled by the app (see agent/subject.js): the head's position
  // over the graphic's time, from the person matte. `behind`: they are meant to play behind the person.
  "emerge-side": {
    name: "Word out from behind the person", ar: "كلمة تطلع من ورا الشخص", use: "A word slides out from behind the head to the free side (overshoot, motion trail), holds, then slides back. Time it to the spoken word (start ~0.1 s before)",
    inUs: 450_000, outUs: 350_000, loop: true, durUs: 1_600_000, subject: true, behind: true, sfx: { in: "whoosh", out: "swish" },
    params: { text: str("Text", "فكرة", 30), font: font("Lalezar"), color: color("Text colour", "#FFFFFF"), accent: color("Box colour", "#FF2E63"), style: { type: "string", enum: ["box", "solid", "gradient", "outline"], default: "box", title: "Style" }, side: side(), size: num("Size", 0.5, 2, 1), subject: subj() },
  },
  "rise-behind": {
    name: "Word rising from behind the person", ar: "كلمة تطلع من ورا الكتف لفوق", use: "A big word rises from behind the shoulders and stands above the head, then sinks back. For the key word of a sentence",
    inUs: 500_000, outUs: 350_000, loop: true, durUs: 1_800_000, subject: true, behind: true, sfx: { in: "riser", out: "swish" },
    params: { text: str("Text", "واو", 24), font: font("Lalezar"), color: color("Colour", "#FFFFFF"), color2: color("Lower colour (gradient)", "#FFD84D"), style: { type: "string", enum: ["gradient", "solid", "outline"], default: "gradient", title: "Style" }, size: num("Size", 0.5, 2, 1), subject: subj() },
  },
  "word-stack": {
    name: "Words stacking beside the person", ar: "كلمات تتراص جنب الشخص", use: "Up to 4 words come out from behind the head one after another (on the spoken words) and stack on the free side",
    inUs: 400_000, outUs: 350_000, loop: true, durUs: 3_000_000, subject: true, behind: true, sfx: { in: "pop", each: "pop", out: "swish" },
    params: { words: { type: "array", items: { type: "string", maxLength: 24 }, minItems: 1, maxItems: 4, default: ["كل", "حاجة", "هنا"], title: "Words" }, times: { type: "array", items: { type: "number", minimum: 0, maximum: 600_000 }, maxItems: 4, default: [], title: "When each word comes (ms from the start; empty = evenly)" }, font: font("Alexandria"), color: color("Text colour", "#FFFFFF"), accent: color("Accent", "#FFD84D"), side: side(), size: num("Size", 0.5, 2, 1), subject: subj() },
  },
  "pass-behind": {
    name: "Text passing behind the person", ar: "نص يعدّي ورا الشخص", use: "Big text travels across the frame at head height and passes behind the person. For a title or a punchline",
    inUs: 0, outUs: 0, loop: true, durUs: 2_500_000, subject: true, behind: true, sfx: { in: "whoosh" },
    params: { text: str("Text", "المونتاج الخارق", 40), font: font("Lalezar"), color: color("Colour", "#FFFFFF"), style: { type: "string", enum: ["outline", "solid"], default: "outline", title: "Style" }, direction: { type: "string", enum: ["rtl", "ltr"], default: "rtl", title: "Direction" }, size: num("Size", 0.5, 2, 1), subject: subj() },
  },
  "head-emoji": {
    name: "Emoji by the head", ar: "إيموجي جنب الراس", use: "A 3D emoji pops next to the head and follows it (bounce in, wiggle, pop out). For a reaction on a word",
    inUs: 350_000, outUs: 250_000, loop: true, durUs: 1_500_000, subject: true, sfx: { in: "pop", out: "blip" },
    params: { emoji: str("Emoji (🔥 or name)", "🔥", 40), corner: { type: "string", enum: ["auto", "left", "right", "top"], default: "auto", title: "Where" }, size: num("Size", 0.05, 0.4, 0.2), motion: { type: "string", enum: ["wiggle", "bounce", "float", "spin"], default: "wiggle", title: "Motion" }, subject: subj() },
  },
  "head-icon": {
    name: "Icon by the head", ar: "أيقونة جنب الراس", use: "An icon badge (with an optional label) pops next to the head and follows it",
    inUs: 350_000, outUs: 250_000, loop: true, durUs: 1_800_000, subject: true, sfx: { in: "pop", out: "blip" },
    params: { icon: str("Icon", "lightbulb", 40), label: str("Label", "", 30), font: font("Cairo"), accent: color("Badge colour", "#7B5CFF"), color: color("Label colour", "#FFFFFF"), corner: { type: "string", enum: ["auto", "left", "right", "top"], default: "auto", title: "Where" }, size: num("Size", 0.05, 0.3, 0.14), subject: subj() },
  },
  quote: {
    name: "Quote", ar: "اقتباس", use: "A key sentence on a card with large quote marks; words appear as spoken",
    inUs: 1_200_000, outUs: 350_000, loop: false, durUs: 4_000_000,
    params: { text: str("Quote", "الجملة الأهم في الفيديو", 120), author: str("Author", "", 40), font: font("El Messiri"), accent: color("Accent", "#FFD84D"), color: color("Text colour", "#FFFFFF"), position: pos("center") },
  },
  "follow-cta": {
    name: "Follow call-to-action", ar: "دعوة للمتابعة", use: "Ask to follow/like/comment at the end",
    inUs: 700_000, outUs: 300_000, loop: true, durUs: 3_000_000,
    params: { text: str("Text", "تابعني لأفكار أكتر", 40), icon: str("Icon", "bell-ring", 30), font: font("Cairo"), accent: color("Accent", "#FF2D55"), color: color("Text colour", "#FFFFFF"), position: pos("bottom", ["top", "center", "bottom"]) },
  },
  "progress-bar": {
    name: "Progress bar", ar: "شريط تقدّم", use: "A thin bar that fills over the segment (keeps viewers to the end)",
    inUs: 0, outUs: 0, loop: true, durUs: 10_000_000,
    params: { accent: color("Colour", "#FFD84D"), position: { type: "string", enum: ["top", "bottom"], default: "top", title: "Position" }, thickness: num("Thickness", 0.002, 0.03, 0.008) },
  },
};

// The Remotion kit (core/graphicsKit.js): same template shape, engine "remotion" — drawn by React components and
// rendered to a transparent clip at export (src/graphics), not by the canvas rasterizer below.
Object.assign(GRAPHIC_TEMPLATES, KIT_TEMPLATES);

export const GRAPHIC_TEMPLATE_IDS = Object.keys(GRAPHIC_TEMPLATES);

/** Emoji characters → bundled 3D emoji (assets/emoji/<id>.png). */
export const EMOJI_ALIASES = {
  "🔥": "fire", "🤔": "thinking-face", "❤️": "red-heart", "❤": "red-heart", "👍": "thumbs-up", "👏": "clapping-hands", "🚀": "rocket", "⭐": "star", "✨": "sparkles",
  "✅": "check-mark-button", "❌": "cross-mark", "⚠️": "warning", "⚠": "warning", "💡": "light-bulb", "💰": "money-bag", "💯": "hundred-points", "😂": "face-with-tears-of-joy",
  "🤯": "exploding-head", "😱": "face-screaming-in-fear", "🥺": "pleading-face", "🎉": "party-popper", "🏆": "trophy", "👀": "eyes", "👇": "backhand-index-pointing-down",
  "👉": "backhand-index-pointing-right", "👈": "backhand-index-pointing-left", "👆": "backhand-index-pointing-up", "🙌": "raising-hands", "💪": "flexed-biceps", "🧠": "brain",
  "⏰": "alarm-clock", "⌛": "hourglass-done", "📈": "chart-increasing", "📉": "chart-decreasing", "💎": "gem-stone", "👑": "crown", "📷": "camera", "🎥": "movie-camera",
  "🎬": "clapper-board", "✂️": "scissors", "✂": "scissors", "💖": "sparkling-heart", "💥": "collision", "🤪": "zany-face", "😎": "smiling-face-with-sunglasses", "🤓": "nerd-face",
  "😭": "loudly-crying-face", "🧐": "face-with-monocle", "✌️": "victory-hand", "👋": "waving-hand", "🙏": "folded-hands", "❓": "red-question-mark", "❗": "red-exclamation-mark",
  "🔔": "bell", "🎁": "wrapped-gift", "⚡": "high-voltage", "☀️": "sun", "🌈": "rainbow", "🌟": "glowing-star", "🔒": "locked", "🔓": "unlocked", "📱": "mobile-phone",
  "💻": "laptop", "🎤": "microphone", "🎧": "headphone", "🎶": "musical-notes", "😅": "grinning-face-with-sweat", "😮": "face-with-open-mouth", "🤫": "shushing-face",
  "🥳": "partying-face", "🥰": "smiling-face-with-hearts", "💄": "lipstick", "💈": "barber-pole", "🧹": "broom", "🖌️": "paintbrush", "🎨": "artist-palette", "🪄": "magic-wand",
  "🛠️": "hammer-and-wrench", "⚙️": "gear", "⏱️": "stopwatch", "📅": "calendar", "📌": "pushpin", "📣": "megaphone", "💬": "speech-balloon", "💭": "thought-balloon",
  "🤷": "woman-shrugging", "🤦": "man-facepalming",
};

const easeOut = (x) => 1 - Math.pow(1 - x, 3);
export const EASE = {
  out: easeOut,
  in: (x) => x * x * x,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  elastic: (x) => (x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Progress of an animation window [a, b] (seconds) at time t, eased. */
export const prog = (t, a, b, ease = easeOut) => ease(clamp01((t - a) / Math.max(1e-6, b - a)));

/** Template parameters with defaults applied (unknown keys dropped). */
export function graphicParams(g) {
  const tpl = GRAPHIC_TEMPLATES[g?.template];
  if (!tpl) return {};
  const out = {};
  for (const [k, sch] of Object.entries(tpl.params)) out[k] = g.params?.[k] !== undefined ? g.params[k] : sch.default;
  return out;
}

/**
 * Discrete frame states of a graphic over its duration (µs from the segment start): [{ fromUs, toUs, key, tUs }].
 * Intro and outro are one state per frame; the hold between them is one state (drawn once); loop templates are
 * one state per frame throughout. key identifies identical pictures (used to draw each only once).
 */
export function graphicStates(g, durationUs, fps = 30) {
  const tpl = GRAPHIC_TEMPLATES[g?.template];
  const FRAME = US / fps;
  const n = Math.max(1, Math.round(durationUs / FRAME));
  if (!tpl) return [{ fromUs: 0, toUs: durationUs, key: "none", tUs: 0 }];
  // Remotion graphics are not drawn state by state: one state (the editor shows the Player, the export a clip).
  if (tpl.engine === "remotion") return [{ fromUs: 0, toUs: durationUs, key: "remotion", tUs: 0 }];
  const inN = Math.ceil(Math.min(tpl.inUs, durationUs / 2) / FRAME), outN = Math.ceil(Math.min(tpl.outUs, durationUs / 2) / FRAME);
  const states = [];
  for (let i = 0; i < n; i++) {
    const tUs = Math.round(i * FRAME);
    const animated = tpl.loop || i < inN || i >= n - outN;
    const key = animated ? `f${i}` : "hold";
    const last = states[states.length - 1];
    if (last && last.key === key) { last.toUs = Math.min(durationUs, Math.round((i + 1) * FRAME)); continue; }
    states.push({ fromUs: tUs, toUs: Math.min(durationUs, Math.round((i + 1) * FRAME)), key, tUs: key === "hold" ? Math.round(inN * FRAME) : tUs });
  }
  states[states.length - 1].toUs = durationUs;
  return states;
}
