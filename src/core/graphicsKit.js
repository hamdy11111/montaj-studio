// The Remotion graphics kit (phase 3): the Punchy components of the edit-hamdy skill and the official Remotion extras,
// as motion-graphic templates of the app. Each template has the same shape as the canvas ones in graphics.js
// (name, use, params as JSON schema, default length, sounds) plus:
//   engine: "remotion"      drawn by React components (src/graphics/remotion), previewed with the Remotion Player and
//                           rendered to a transparent clip at export — never by the canvas rasterizer
//   component               the React component's name (src/graphics/remotion/registry.jsx)
//   family                  sample-video family (punchy, numbers, story, text, extras)
//   contract                when the selection system may pick it (src/graphics/selection.js):
//     tags        what the sentence must need (number, list, compare, quote, memory, phone, peak, chapter, …)
//     minSec/maxSec, maxChars (visible characters of its text params, textKeys), region (where it sits),
//     needsImage (a picture must be supplied), needsCutout (a person cut out), energy 1–5, major (counts for the
//     one-major-graphic-per-8–12 s guard), fullFrame (covers the frame by design: exempt from face/zone checks)
//   box(P, W, H)           the rectangle it is expected to occupy (fractions) — a prediction; the hard checks
//                           measure the real one on the rendered frames.
// Times inside params are milliseconds from the graphic's start (like word-stack's `times`); positions are
// fractions of the frame (x, y: centre unless the parameter says otherwise). Colours default to the Punchy pack.
// Pure data + small functions: loaded by the editor (inspector), the agents (validation) and the Remotion bundle.

const str = (title, def = "", max = 120) => ({ type: "string", maxLength: max, default: def, title });
const color = (title, def) => ({ type: "string", pattern: "^#[0-9A-Fa-f]{6}$", default: def, title });
const num = (title, min, max, def) => ({ type: "number", minimum: min, maximum: max, default: def, title });
const int = (title, min, max, def) => ({ type: "integer", minimum: min, maximum: max, default: def, title });
const bool = (title, def = false) => ({ type: "boolean", default: def, title });
const pick = (title, values, def) => ({ type: "string", enum: values, default: def, title });
const strs = (title, def, maxItems = 6, maxLength = 40) => ({ type: "array", items: { type: "string", maxLength }, maxItems, default: def, title });
const times = (title = "When each item comes (ms from the start; empty = on its own rhythm)", maxItems = 6) => ({ type: "array", items: { type: "number", minimum: 0, maximum: 600_000 }, maxItems, default: [], title });
const image = (title = "Picture (a file or a media:// link)") => str(title, "", 1000);
const font = (def) => ({ type: "string", maxLength: 60, default: def, title: "Font" });

const C = { accent: "#FFD60A", alert: "#FF2D2D", energy: "#FF8A00", ink: "#0B0B0F", paper: "#FFFFFF", info: "#1FB6FF", gain: "#2ED47A", impact: "#FF3D7F" };
const vis = (s) => String(s ?? "").replace(/[ً-ْٰـ\s]/g, "").length;
const lines = (s) => String(s ?? "").split(/\s*(?:\n|\s\|\s)\s*/u).filter(Boolean);
const longest = (s) => Math.max(1, ...lines(s).map(vis));
const short = (W, H) => Math.min(W, H);
/** Width of a line of n visible characters at font size px, as a fraction of W (Arabic display ≈ 0.5 em a char). */
const textW = (n, px, W, em = 0.5) => Math.min(1, (n * px * em) / W);
const centred = (w, h, y, x = 0.5) => ({ x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), w, h });
const full = () => ({ x: 0, y: 0, w: 1, h: 1 });

const contract = (o) => ({ tags: [], minSec: 1, maxSec: 4, maxChars: 0, textKeys: [], region: "center", needsImage: false, needsCutout: false, energy: 3, major: true, fullFrame: false, ...o });

export const KIT_TEMPLATES = {
  // ───────── Punchy (edit-hamdy styles/punchy/kit/Punchy.tsx) ─────────
  "kinetic-word": {
    name: "Kinetic word", ar: "كلمة ضخمة على الضربة", use: "The punch or reaction: one or two huge words drop in, bounce and shake on landing; part of it in yellow",
    component: "KineticWord", family: "punchy", inUs: 200_000, outUs: 140_000, durUs: 1_600_000, sfx: { in: "impact" },
    params: { text: str("Text (| for a second line)", "واااو!", 40), hi: str("Yellow part", "", 24), y: num("Height (centre)", 0.1, 0.9, 0.3), size: num("Size", 0.5, 2, 1), rot: num("Tilt (°)", -15, 15, -4), color: color("Colour", C.paper), font: font("Lalezar"), motionBlur: bool("Motion blur on the drop", true) },
    contract: contract({ tags: ["peak", "reaction", "punchline", "hook", "surprise"], minSec: 0.8, maxSec: 2.5, maxChars: 24, textKeys: ["text"], region: "upper-third", energy: 5 }),
    reach: 2.6,
    box: (P, W, H) => { const px = 150 * P.size * short(W, H) / 1080, n = lines(P.text).length; return centred(textW(longest(P.text), px, W), (n * px * 1.15) / H, P.y); },
  },
  streak: {
    name: "Light streaks", ar: "خطوط ضوء (انتقال)", use: "Between the shots of a designed intro: the picture darkens, red/white streaks race across, a flash in the middle, an optional word",
    component: "Streak", family: "punchy", inUs: 0, outUs: 0, durUs: 550_000, sfx: { in: "whoosh" },
    params: { word: str("Word (optional)", "", 16) },
    contract: contract({ tags: ["transition", "hook"], minSec: 0.35, maxSec: 0.8, maxChars: 12, textKeys: ["word"], region: "full", energy: 4, major: false, fullFrame: true }),
    box: full,
  },
  "title-card": {
    name: "Title card", ar: "كارت عنوان الحلقة", use: "The episode title after the intro hits: rays, the people cut out on both sides, a huge two-line title, a tilted red ribbon",
    component: "TitleCard", family: "punchy", inUs: 450_000, outUs: 280_000, durUs: 3_800_000, sfx: { in: "riser", out: "whoosh" },
    params: { l1: str("Line 1", "تحدي", 24), l2: str("Line 2 (yellow)", "الـ٢٠ كيلو", 24), kicker: str("Ribbon", "يوم الخبيز 🔥", 30), sub: str("One-line description", "", 60), left: image("Person on the left (cut out PNG)"), right: image("Person on the right (cut out PNG)") },
    contract: contract({ tags: ["title", "hook"], minSec: 2.5, maxSec: 4.5, maxChars: 40, textKeys: ["l1", "l2"], region: "full", energy: 5, fullFrame: true }),
    box: full,
  },
  "photo-card": {
    name: "Tilted photo card", ar: "كارت صورة مايل", use: "Anything mentioned (a place, a dish, a person): a white-framed photo flies in tilted with a yellow name tag",
    component: "PhotoCard", family: "punchy", inUs: 320_000, outUs: 200_000, durUs: 3_000_000, sfx: { in: "whoosh", out: "swish" },
    params: { src: image(), label: str("Name tag", "الماركت", 18), x: num("Left edge", 0, 0.8, 0.5), y: num("Top edge", 0, 0.8, 0.16), w: num("Width", 0.2, 0.7, 0.4), rot: num("Tilt (°)", -20, 20, -6), from: pick("Comes from", ["left", "right", "top"], "right"), cutout: bool("Cut-out picture on a colour", false), bg: color("Background (cut-out)", C.energy), badge: str("Badge emoji", "", 8) },
    contract: contract({ tags: ["memory", "thing", "place", "food", "name"], minSec: 2, maxSec: 4, maxChars: 14, textKeys: ["label"], region: "side", needsImage: true, energy: 3 }),
    reach: 1.35,
    box: (P, W, H) => { const w = P.w * 1080 / W * (short(W, H) / 1080), h = (w * W + 60) / H; return { x: P.x, y: P.y, w, h: h + 0.03 }; },
  },
  "chapter-banner": {
    name: "Chapter banner", ar: "بانر فصل", use: "The start of a story or chapter: a black tag and a tilted yellow banner slide in from both sides",
    component: "ChapterBanner", family: "punchy", inUs: 420_000, outUs: 200_000, durUs: 3_200_000, sfx: { in: "whoosh", out: "swish" },
    params: { tag: str("Small tag", "الفصل التاني", 20), text: str("Banner", "المقلب الكوري", 22), emoji: str("Emoji", "", 8), y: num("Top edge", 0.05, 0.8, 0.11) },
    contract: contract({ tags: ["chapter"], minSec: 2.5, maxSec: 4, maxChars: 22, textKeys: ["text"], region: "top", energy: 3 }),
    reach: 1.4,
    box: (P, W, H) => { const px = 104 * short(W, H) / 1080; return { x: 0.5 - textW(vis(P.text) + 2, px, W) / 2, y: P.y, w: textW(vis(P.text) + 2, px, W), h: (px * 1.5 + 50) / H }; },
  },
  "slam-stamp": {
    name: "Slam stamp", ar: "ختم الضربة", use: "The big hit (with a freeze): a red stamp slams from huge, shakes, a ring spreads",
    component: "SlamStamp", family: "punchy", inUs: 120_000, outUs: 150_000, durUs: 1_500_000, sfx: { in: "impact" },
    params: { text: str("Text", "مفيهاش فراخ!!", 18), y: num("Height (centre)", 0.1, 0.9, 0.33), color: color("Colour", C.alert), size: num("Size", 0.5, 2, 1) },
    contract: contract({ tags: ["peak", "punchline", "verdict"], minSec: 1, maxSec: 2, maxChars: 16, textKeys: ["text"], region: "center", energy: 5 }),
    reach: 5.2,
    box: (P, W, H) => { const px = 116 * P.size * short(W, H) / 1080; return centred(textW(vis(P.text) + 2, px, W), (px * 1.6) / H, P.y); },
  },
  "freeze-fx": {
    name: "Freeze frame", ar: "تجميد أبيض وأسود", use: "The big hit: the picture freezes black-and-white with a vignette, a push-in and a flash (the app grabs the frame)",
    component: "FreezeFx", family: "punchy", inUs: 100_000, outUs: 0, durUs: 1_000_000, sfx: { in: "flash" },
    params: { still: image("Frozen frame (filled by the app from the video)") },
    contract: contract({ tags: ["peak"], minSec: 0.8, maxSec: 1.4, region: "full", needsImage: true, energy: 5, fullFrame: true }),
    box: full,
  },
  confetti: {
    name: "Confetti", ar: "قصاصات احتفال", use: "A celebration: confetti bursts from the middle and falls",
    component: "Confetti", family: "punchy", inUs: 0, outUs: 400_000, durUs: 1_800_000, sfx: { in: "pop" },
    params: { n: int("Pieces", 20, 160, 70) },
    contract: contract({ tags: ["celebrate"], minSec: 1.2, maxSec: 2.5, region: "full", energy: 4, major: false, fullFrame: true }),
    box: full,
  },
  "speed-lines": {
    name: "Speed lines", ar: "خطوط سرعة", use: "Running away or a shock: radial lines spin around a point",
    component: "SpeedLines", family: "punchy", inUs: 0, outUs: 0, durUs: 900_000, sfx: { in: "whoosh" },
    params: { cx: num("Centre across", 0, 1, 0.5), cy: num("Centre down", 0, 1, 0.42) },
    contract: contract({ tags: ["run", "surprise"], minSec: 0.6, maxSec: 1.4, region: "full", energy: 4, major: false, fullFrame: true }),
    box: full,
  },
  "name-tag": {
    name: "Name tag", ar: "اسم بسهم", use: "Who someone (or something) is: a short bold name with a role and an arrow pointing at them",
    component: "NameTag", family: "punchy", inUs: 300_000, outUs: 180_000, durUs: 2_500_000, sfx: { in: "pop" },
    params: { name: str("Name", "ماما", 14), role: str("Role", "", 20), x: num("Across (centre)", 0.15, 0.85, 0.5), y: num("Top edge", 0.05, 0.85, 0.2), arrow: pick("Arrow", ["down", "up", "none"], "down") },
    contract: contract({ tags: ["name"], minSec: 1.8, maxSec: 3, maxChars: 14, textKeys: ["name"], region: "person", energy: 2, major: false }),
    reach: 1.5,
    box: (P, W, H) => { const px = 104 * short(W, H) / 1080, w = textW(vis(P.name) + 2, px, W); return { x: P.x - w / 2, y: P.y, w, h: (px * (P.role ? 2 : 1.4) + 40) / H }; },
  },
  "joke-math": {
    name: "Joke sum", ar: "حسبة النكتة", use: "A sum that is said: lines appear on their words on a note card, the last one red",
    component: "JokeMath", family: "punchy", inUs: 300_000, outUs: 200_000, durUs: 6_000_000, sfx: { in: "pop", each: "click" },
    params: { title: str("Title", "حسبة ماما", 20), lines: strs("Lines", ["٥ علب", "العلبة تكفي ٣–٤", "الواحد فينا = ٢ 😂"], 5, 26), times: times(undefined, 5), hotLast: bool("Last line red", true), y: num("Top edge", 0.05, 0.6, 0.12) },
    contract: contract({ tags: ["math", "list", "number"], minSec: 3, maxSec: 12, maxChars: 22, textKeys: ["lines"], region: "top", energy: 3 }),
    reach: 1.3,
    box: (P, W, H) => { const n = (P.lines || []).length + (P.title ? 1 : 0); return { x: 0.11, y: P.y, w: 0.78, h: Math.min(0.8, (n * 92 + 60) * short(W, H) / 1080 / H) }; },
  },
  "weather-swap": {
    name: "Weather swap", ar: "تبديل الطقس", use: "Weather changing: a pill with an icon that swaps (rain → sun) and a line",
    component: "WeatherSwap", family: "punchy", inUs: 300_000, outUs: 200_000, durUs: 2_600_000, sfx: { in: "pop", each: "sparkle" },
    params: { text: str("Text", "أخيراً الشمس طلعت!", 22), from: str("From", "🌧️", 8), to: str("To", "☀️", 8), swapAt: num("Swap at (ms)", 0, 10_000, 700), y: num("Top edge", 0.05, 0.8, 0.12) },
    contract: contract({ tags: ["weather"], minSec: 2, maxSec: 3.5, maxChars: 18, textKeys: ["text"], region: "top", energy: 2, major: false }),
    reach: 1.5,
    box: (P, W, H) => { const px = 92 * short(W, H) / 1080, w = textW(vis(P.text), px, W) + 0.2; return { x: 0.5 - w / 2, y: P.y, w, h: 170 * short(W, H) / 1080 / H }; },
  },
  // ───────── Numbers & HUD (edit-hamdy styles/punchy/kit/Graphics.tsx) ─────────
  "counter-roll": {
    name: "Counter roll", ar: "عدّاد بيعدّ", use: "A number that matters: rolls fast and settles on the value (like a machine), shines when it lands",
    component: "CounterRoll", family: "numbers", inUs: 250_000, outUs: 200_000, durUs: 2_200_000, sfx: { in: "click", each: "ding" },
    params: { to: num("To", -1e9, 1e9, 20), from: num("From", -1e9, 1e9, 0), dec: int("Decimals", 0, 3, 0), prefix: str("Before", "", 8), suffix: str("After", " كيلو", 12), label: str("Label", "", 26), y: num("Top edge", 0.03, 0.85, 0.14), size: num("Size", 0.5, 2, 1), color: color("Colour", C.accent), rollMs: num("Roll length (ms)", 300, 4000, 1100) },
    contract: contract({ tags: ["number", "count", "money"], minSec: 1.6, maxSec: 3, maxChars: 26, textKeys: ["label"], region: "top", energy: 4 }),
    reach: 1.7,
    box: (P, W, H) => { const px = 0.13 * short(W, H) * P.size, n = String(Math.round(P.to)).length + vis(P.prefix) + vis(P.suffix) + 1; return centred(textW(n, px, W, 0.55), (px * 1.1 + (P.label ? px * 0.5 : 0)) / H, P.y + (px * 0.6) / H); },
  },
  "delta-pill": {
    name: "Gain / loss pill", ar: "علامة مكسب / خسارة", use: "Money or points won or lost: a pill (+ green, − red) pops beside the thing and floats up",
    component: "DeltaPill", family: "numbers", inUs: 280_000, outUs: 250_000, durUs: 1_600_000, sfx: { in: "pop" },
    params: { text: str("Text", "-٨٠ جنيه", 16), unit: str("Unit tag", "", 10), kind: pick("Kind", ["gain", "loss"], "loss"), x: num("Across (centre)", 0.1, 0.9, 0.5), y: num("Down (centre)", 0.1, 0.9, 0.42) },
    contract: contract({ tags: ["delta", "money"], minSec: 1, maxSec: 2.2, maxChars: 12, textKeys: ["text"], region: "side", energy: 3, major: false }),
    reach: 2.0,
    box: (P, W, H) => { const px = 0.075 * short(W, H); return centred(textW(vis(P.text) + vis(P.unit) + 3, px, W, 0.42), (px * 1.6) / H, P.y - 0.02, P.x); },
  },
  "impact-number": {
    name: "Impact number", ar: "رقم ضخم على الضربة", use: "A shocking number: slams from close with a coloured 3D depth, shakes, leaves",
    component: "ImpactNumber", family: "numbers", inUs: 160_000, outUs: 160_000, durUs: 1_500_000, sfx: { in: "impact" },
    params: { text: str("Number", "-$80", 10), sub: str("Under it", "", 24), color: color("Colour", C.impact), y: num("Top edge", 0.05, 0.8, 0.3), size: num("Size", 0.5, 1.6, 1), rot: num("Tilt (°)", -15, 15, -5), motionBlur: bool("Motion blur", true) },
    contract: contract({ tags: ["number", "money", "peak"], minSec: 1, maxSec: 2, maxChars: 8, textKeys: ["text"], region: "upper-third", energy: 5 }),
    reach: 3.5,
    box: (P, W, H) => { const px = 0.22 * short(W, H) * P.size; return { x: 0.5 - textW(vis(P.text), px, W, 0.55) / 2, y: P.y, w: textW(vis(P.text), px, W, 0.55), h: (px * (P.sub ? 1.35 : 1.05)) / H }; },
  },
  "progress-hud": {
    name: "Progress bar (goal)", ar: "شريط تقدّم للهدف", use: "The big goal: a bar fills from the previous value to the new one; can stay on screen a long time",
    component: "ProgressHUD", family: "numbers", inUs: 300_000, outUs: 300_000, durUs: 4_000_000, sfx: { in: "click" },
    params: { label: str("Label", "فاضل", 20), value: num("Value", -1e9, 1e9, 5), max: num("Goal", 0.001, 1e9, 20), prev: num("Previous value", -1e9, 1e9, 0), unit: str("Unit", "كيلو", 10), dec: int("Decimals", 0, 2, 0), pos: pick("Position", ["bottom", "top"], "bottom"), done: bool("Reached", false) },
    contract: contract({ tags: ["progress"], minSec: 2, maxSec: 60, maxChars: 20, textKeys: ["label"], region: "bottom", energy: 1, major: false }),
    reach: 2.2,
    box: (P, W, H) => { const wide = W > H, bw = wide ? 0.42 : 0.86, u = short(W, H) / 100; return { x: wide ? 0.05 : 0.07, y: P.pos === "bottom" ? 1 - (wide ? 0.12 : 0.17) - u * 5 / H : 0.06, w: bw, h: (u * 10.5) / H }; },
  },
  "corner-hud": {
    name: "Corner badge", ar: "عدّاد ركني ثابت", use: "Where we are (day 3, round 2): a small clear badge in a corner, pulses when it changes",
    component: "CornerHUD", family: "numbers", inUs: 300_000, outUs: 200_000, durUs: 5_000_000, sfx: { in: "pop" },
    params: { text: str("Text", "اليوم ٣", 14), corner: pick("Corner", ["tl", "tr", "bl", "br"], "tl"), pulse: num("Pulse at (ms, -1 = none)", -1, 600_000, -1), icon: str("Emoji", "", 8) },
    contract: contract({ tags: ["round", "day", "score"], minSec: 2, maxSec: 300, maxChars: 12, textKeys: ["text"], region: "corner", energy: 1, major: false }),
    reach: 1.6,
    box: (P, W, H) => { const u = short(W, H) / 100, w = textW(vis(P.text) + 2, u * 4.6, W, 0.55) + (u * 4) / W, h = (u * 7) / H, m = (u * 2.6); const top = P.corner[0] === "t" ? (W > H ? m / H : 0.06) : 1 - m / H - h; return { x: P.corner[1] === "l" ? m / W : 1 - m / W - w, y: top, w, h }; },
  },
  "timer-hud": {
    name: "Countdown", ar: "عدّاد تنازلي", use: "A timed challenge: 0:58 … 0:00 in a corner, the last 3 s red and beating, a red flash at zero",
    component: "TimerHUD", family: "numbers", inUs: 0, outUs: 600_000, durUs: 10_000_000, sfx: { in: "click" },
    params: { from: num("From (seconds)", 1, 3600, 10), corner: pick("Corner", ["tl", "tr"], "tl") },
    contract: contract({ tags: ["countdown"], minSec: 3, maxSec: 600, region: "corner", energy: 2, major: false }),
    reach: 1.6,
    box: (P, W, H) => { const u = short(W, H) / 100, w = (u * 22) / W, h = (u * 10) / H, m = u * 2.6; return { x: P.corner === "tl" ? m / W : 1 - m / W - w, y: W > H ? m / H : 0.06, w, h }; },
  },
  "chapter-card": {
    name: "Chapter card", ar: "كارت فصل ضخم", use: "«Day 3» in huge metallic letters over the darkened video: zooms through, leaves with a flash",
    component: "ChapterCard", family: "numbers", inUs: 450_000, outUs: 220_000, durUs: 2_000_000, sfx: { in: "whoosh", out: "flash" },
    params: { text: str("Text", "اليوم ٣", 12), sub: str("Under it", "", 30), dim: num("Darken the video", 0, 0.9, 0.55) },
    contract: contract({ tags: ["chapter", "day"], minSec: 1.5, maxSec: 3, maxChars: 12, textKeys: ["text"], region: "full", energy: 4, fullFrame: true }),
    box: full,
  },
  flashback: {
    name: "Flashback", ar: "فلاش باك", use: "A memory: grain, scan lines, dark edges and a red «95 days ago…» (pair it with black-and-white on the clip)",
    component: "Flashback", family: "story", inUs: 250_000, outUs: 200_000, durUs: 4_000_000, sfx: { in: "riser" },
    params: { label: str("Label", "من ٩٥ يوم…", 24) },
    contract: contract({ tags: ["memory", "flashback"], minSec: 2, maxSec: 20, maxChars: 20, textKeys: ["label"], region: "full", energy: 2, fullFrame: true }),
    box: full,
  },
  "cctv-wall": {
    name: "CCTV wall", ar: "جدار كاميرات مراقبة", use: "«We watch them 24 hours»: a grid of stills (from the same day) with REC, camera numbers and scan lines",
    component: "CCTVWall", family: "story", inUs: 400_000, outUs: 200_000, durUs: 3_000_000, sfx: { in: "click" },
    params: { stills: strs("Stills (files or media:// links)", [], 12, 1000), cols: int("Columns (0 = auto)", 0, 4, 0) },
    contract: contract({ tags: ["watch"], minSec: 2, maxSec: 4, region: "full", needsImage: true, energy: 3, fullFrame: true }),
    box: full,
  },
  "phone-frame": {
    name: "Phone", ar: "موبايل", use: "A message, an app or a sent photo: a screenshot inside a phone rises from the bottom",
    component: "PhoneFrame", family: "story", inUs: 380_000, outUs: 220_000, durUs: 3_000_000, sfx: { in: "whoosh", out: "swish" },
    params: { src: image("Screenshot"), title: str("Title above", "", 24), x: num("Across (centre)", 0.15, 0.85, 0.5), y: num("Top edge", 0.05, 0.6, 0.22), h: num("Height", 0.25, 0.8, 0.55), rot: num("Tilt (°)", -15, 15, 6) },
    contract: contract({ tags: ["phone"], minSec: 2, maxSec: 4.5, maxChars: 20, textKeys: ["title"], region: "center", needsImage: true, energy: 3 }),
    box: (P, W, H) => { const ph = P.h, pw = (ph * H * 0.49) / W; return { x: P.x - pw / 2, y: P.y - (P.title ? 0.07 : 0), w: pw, h: ph + (P.title ? 0.07 : 0) }; },
  },
  "compare-gauge": {
    name: "Comparison", ar: "مقارنة نسب", use: "Two sides compared (only values that were said): each side fills from its edge",
    component: "CompareGauge", family: "numbers", inUs: 300_000, outUs: 200_000, durUs: 3_000_000, sfx: { in: "click" },
    params: { leftLabel: str("Left label", "حمدي", 14), leftValue: num("Left value (%)", 0, 100, 57), rightLabel: str("Right label", "وفاء", 14), rightValue: num("Right value (%)", 0, 100, 60), prevL: num("Left before", 0, 100, 0), prevR: num("Right before", 0, 100, 0) },
    contract: contract({ tags: ["compare", "percent"], minSec: 2, maxSec: 4, maxChars: 14, textKeys: ["leftLabel", "rightLabel"], region: "bottom", energy: 3 }),
    reach: 1.8,
    box: (P, W, H) => { const wide = W > H, u = short(W, H) / 100, h = (u * 16) / H; return { x: 0.04, y: 1 - (wide ? 0.12 : 0.26) - h, w: wide ? 0.92 : 0.78, h }; },
  },
  "list-montage": {
    name: "List montage", ar: "مونتاج قايمة", use: "A list said aloud: each item slams in as a card on its word and stacks, the older ones shrink",
    component: "ListMontage", family: "numbers", inUs: 220_000, outUs: 220_000, durUs: 4_000_000, sfx: { in: "pop", each: "pop" },
    params: { title: str("Title", "", 20), items: strs("Items", ["١٠٥ رغيف", "٣٤ علبة", "٩٦ عصير"], 6, 20), times: times(), y: num("Top edge", 0.05, 0.75, 0.18) },
    contract: contract({ tags: ["list"], minSec: 2, maxSec: 8, maxChars: 18, textKeys: ["items"], region: "center", energy: 3 }),
    reach: 1.3,
    box: (P, W, H) => { const wide = W > H, u = short(W, H) / 100, n = (P.items || []).length, cw = wide ? 0.2 : 0.6; return { x: wide ? 0.06 : 0.2, y: P.y - (P.title ? (u * 8) / H : 0), w: cw, h: (n * u * 10.7 + (P.title ? u * 8 : 0)) / H }; },
  },
  "narrator-card": {
    name: "Narrator line", ar: "كارت الراوي", use: "«3 hours of kneading later…»: a cinematic bar where the words type in (when there is no narrator voice)",
    component: "NarratorCard", family: "story", inUs: 300_000, outUs: 250_000, durUs: 2_500_000, sfx: { in: "click" },
    params: { text: str("Text", "وبعد ٣ ساعات عجن…", 40), pos: pick("Position", ["top", "bottom"], "top") },
    contract: contract({ tags: ["narration"], minSec: 1.5, maxSec: 4, maxChars: 34, textKeys: ["text"], region: "top", energy: 1, major: false }),
    reach: 1.8,
    box: (P, W, H) => { const wide = W > H, u = short(W, H) / 100, w = Math.min(0.86, textW(vis(P.text) + 4, u * 4.4, W, 0.5)); return { x: 0.5 - w / 2, y: P.pos === "top" ? (wide ? 0.06 : 0.11) : (wide ? 0.8 : 0.7), w, h: (u * 7.2) / H }; },
  },
  "tint-fx": {
    name: "Colour tint", ar: "صبغة لون", use: "A mood over the picture for a moment: night (purple), danger (red), dream (glow) or warmth",
    component: "TintFx", family: "story", inUs: 250_000, outUs: 250_000, durUs: 2_000_000, sfx: {},
    params: { kind: pick("Kind", ["night", "red", "dream", "warm"], "night"), fadeMs: num("Fade (ms)", 0, 2000, 250) },
    contract: contract({ tags: ["mood"], minSec: 1, maxSec: 12, region: "full", energy: 2, major: false, fullFrame: true }),
    box: full,
    blend: (P) => (P.kind === "dream" ? "screen" : "multiply"), // the layer's blend mode over the picture
  },
  // ───────── Arabic text: the default animated reveal ─────────
  "word-reveal": {
    name: "Arabic word reveal", ar: "كشف الكلام بالكلمة", use: "A sentence that matters: words appear one by one (or a right-to-left wipe), the key word bigger — letters always joined",
    component: "WordReveal", family: "text", inUs: 600_000, outUs: 300_000, durUs: 3_000_000, sfx: { in: "whoosh" },
    params: { text: str("Text", "الفكرة كلها في التوقيت", 60), mode: pick("Reveal", ["words", "wipe", "pop"], "words"), emphasis: strs("Bigger words", [], 4, 24), times: times("When each word comes (ms; empty = evenly)", 12), font: font("Alexandria"), weight: int("Weight", 300, 900, 800), color: color("Text colour", C.paper), accent: color("Key word colour", C.accent), box: bool("Dark plate behind", false), y: num("Height (centre)", 0.1, 0.9, 0.3), size: num("Size", 0.5, 2, 1) },
    contract: contract({ tags: ["quote", "point", "title", "hook"], minSec: 1.5, maxSec: 5, maxChars: 48, textKeys: ["text"], region: "upper-third", energy: 2 }),
    reach: 1.8,
    box: (P, W, H) => { const px = 0.085 * short(W, H) * P.size, n = vis(P.text), perLine = Math.max(8, Math.floor((W * 0.84) / (px * 0.5))), ln = Math.ceil(n / perLine); return centred(Math.min(0.88, textW(n, px, W)), (ln * px * 1.45) / H, P.y); },
  },
  // ───────── Official Remotion extras ─────────
  "hand-drawn": {
    name: "Hand-drawn mark", ar: "علامة مرسومة بإيد", use: "«Look here»: a hand-drawn circle, underline, highlight, box or cross draws itself around a spot (@remotion/rough-notation)",
    component: "HandDrawn", family: "extras", inUs: 700_000, outUs: 250_000, durUs: 2_200_000, sfx: { in: "swish" },
    params: { type: pick("Mark", ["circle", "underline", "highlight", "box", "strike-through", "crossed-off", "bracket"], "circle"), x: num("Left", 0, 1, 0.3), y: num("Top", 0, 1, 0.45), w: num("Width", 0.02, 1, 0.4), h: num("Height", 0.02, 1, 0.12), label: str("Label (optional)", "بص هنا 👀", 20), color: color("Colour", C.accent), strokeWidth: num("Line width", 1, 20, 7) },
    contract: contract({ tags: ["point", "look"], minSec: 1.2, maxSec: 3.5, maxChars: 16, textKeys: ["label"], region: "target", energy: 3, major: false }),
    reach: 1.3,
    box: (P) => ({ x: P.x - 0.03, y: P.y - (P.label ? 0.08 : 0.02), w: P.w + 0.06, h: P.h + (P.label ? 0.1 : 0.04) }),
  },
  "gsap-title": {
    name: "GSAP title", ar: "عنوان بحركة GSAP", use: "A title whose words fly in on a GSAP timeline (frame-exact through @remotion/gsap), with an underline sweep",
    component: "GsapTitle", family: "extras", inUs: 900_000, outUs: 350_000, durUs: 3_000_000, sfx: { in: "whoosh" },
    params: { text: str("Title", "سر المونتاج الخارق", 40), sub: str("Subtitle", "", 50), font: font("Alexandria"), color: color("Colour", C.paper), accent: color("Accent", C.accent), y: num("Height (centre)", 0.1, 0.9, 0.3) },
    contract: contract({ tags: ["title", "chapter", "hook"], minSec: 2, maxSec: 4.5, maxChars: 30, textKeys: ["text"], region: "upper-third", energy: 3 }),
    reach: 2.2,
    box: (P, W, H) => { const px = 0.1 * short(W, H); return centred(Math.min(0.9, textW(vis(P.text), px, W)), (px * (P.sub ? 2.2 : 1.4)) / H, P.y); },
  },
  "path-arrow": {
    name: "Drawn arrow", ar: "سهم بيترسم", use: "An arrow draws itself along a curve to a spot (@remotion/paths evolvePath), with a label at its tail",
    component: "PathArrow", family: "extras", inUs: 600_000, outUs: 250_000, durUs: 2_000_000, sfx: { in: "swish" },
    params: { x1: num("From across", 0, 1, 0.25), y1: num("From down", 0, 1, 0.3), x2: num("To across", 0, 1, 0.6), y2: num("To down", 0, 1, 0.5), bend: num("Bend", -1, 1, 0.35), label: str("Label", "هنا!", 16), color: color("Colour", C.accent), width: num("Line width", 2, 24, 10) },
    contract: contract({ tags: ["point", "look"], minSec: 1, maxSec: 3, maxChars: 14, textKeys: ["label"], region: "target", energy: 3, major: false }),
    reach: 1.2,
    box: (P) => ({ x: Math.min(P.x1, P.x2) - 0.08, y: Math.min(P.y1, P.y2) - 0.08, w: Math.abs(P.x2 - P.x1) + 0.16, h: Math.abs(P.y2 - P.y1) + 0.16 }),
  },
  "shape-burst": {
    name: "Burst badge", ar: "شارة نجمة", use: "A star/burst badge spins in with a short word («جديد!» · «مجاناً») (@remotion/shapes)",
    component: "ShapeBurst", family: "extras", inUs: 350_000, outUs: 200_000, durUs: 1_800_000, sfx: { in: "pop" },
    params: { shape: pick("Shape", ["star", "burst", "circle", "triangle"], "burst"), text: str("Text", "جديد!", 10), x: num("Across (centre)", 0.1, 0.9, 0.75), y: num("Down (centre)", 0.1, 0.9, 0.25), size: num("Size", 0.08, 0.5, 0.24), color: color("Colour", C.alert), textColor: color("Text colour", C.paper) },
    contract: contract({ tags: ["surprise", "offer"], minSec: 1, maxSec: 2.5, maxChars: 8, textKeys: ["text"], region: "side", energy: 4, major: false }),
    reach: 1.8,
    box: (P, W, H) => { const s = P.size * short(W, H); return centred(s / W, s / H, P.y, P.x); },
  },
  "lottie-sticker": {
    name: "Animated emoji (Lottie)", ar: "إيموجي متحرك (Lottie)", use: "A reaction emoji from the pack's family (Noto Animated, Lottie): pops in by a spot and plays (@remotion/lottie)",
    component: "LottieSticker", family: "extras", inUs: 300_000, outUs: 250_000, durUs: 1_800_000, sfx: { in: "pop" },
    params: { emoji: str("Emoji (character or code, e.g. 😂 or 1f602)", "😂", 24), src: image("Or a Lottie JSON file"), x: num("Across (centre)", 0.05, 0.95, 0.78), y: num("Down (centre)", 0.05, 0.95, 0.24), size: num("Size", 0.06, 0.5, 0.2) },
    contract: contract({ tags: ["reaction"], minSec: 1, maxSec: 3, region: "side", energy: 3, major: false }),
    reach: 1.6,
    box: (P, W, H) => { const s = P.size * short(W, H); return centred(s / W, s / H, P.y, P.x); },
  },
  "animated-emoji": {
    name: "Animated emoji (video)", ar: "إيموجي متحرك (فيديو)", use: "Google's animated emoji as a transparent video (@remotion/animated-emoji) by a spot",
    component: "AnimatedEmojiSticker", family: "extras", inUs: 300_000, outUs: 250_000, durUs: 2_000_000, sfx: { in: "pop" },
    params: { emoji: str("Emoji name (e.g. joy, fire, mind-blown)", "joy", 40), src: image("Video file (filled by the app from the emoji family)"), x: num("Across (centre)", 0.05, 0.95, 0.78), y: num("Down (centre)", 0.05, 0.95, 0.24), size: num("Size", 0.06, 0.5, 0.2) },
    contract: contract({ tags: ["reaction"], minSec: 1, maxSec: 3, region: "side", energy: 3, major: false }),
    reach: 1.6,
    box: (P, W, H) => { const s = P.size * short(W, H); return centred(s / W, s / H, P.y, P.x); },
  },
  "swap-card": {
    name: "Before → after", ar: "قبل ← بعد", use: "A correction or a before/after: one card wipes or slides into the next (@remotion/transitions)",
    component: "SwapCard", family: "extras", inUs: 300_000, outUs: 250_000, durUs: 3_000_000, sfx: { in: "whoosh", each: "swish" },
    params: { before: str("Before", "كنت فاكر", 24), after: str("After", "طلع العكس!", 24), swapAt: num("Swap at (ms)", 200, 20_000, 1300), transition: pick("Transition", ["wipe", "slide", "flip", "clock"], "wipe"), y: num("Height (centre)", 0.1, 0.9, 0.3) },
    contract: contract({ tags: ["compare", "correction"], minSec: 2, maxSec: 4.5, maxChars: 20, textKeys: ["before", "after"], region: "upper-third", energy: 3 }),
    reach: 1.7,
    box: (P, W, H) => { const px = 0.1 * short(W, H), n = Math.max(vis(P.before), vis(P.after)) + 2; return centred(Math.min(0.9, textW(n, px, W)), (px * 1.8) / H, P.y); },
  },
};

for (const [id, t] of Object.entries(KIT_TEMPLATES)) Object.assign(t, { engine: "remotion", loop: true, id });

export const KIT_IDS = Object.keys(KIT_TEMPLATES);
/** The 27 components brought over from the edit-hamdy skill (26 of Punchy.tsx/Graphics.tsx + the Arabic word reveal). */
export const PUNCHY_COMPONENTS = KIT_IDS.filter((id) => ["punchy", "numbers", "story", "text"].includes(KIT_TEMPLATES[id].family));
export const EXTRA_COMPONENTS = KIT_IDS.filter((id) => KIT_TEMPLATES[id].family === "extras");

/** Is this template drawn by the Remotion layer? */
export const isRemotionTemplate = (id) => KIT_TEMPLATES[id]?.engine === "remotion";

/** Parameters with defaults applied (unknown keys dropped) — same rule as graphics.js graphicParams. */
export function kitParams(template, params = {}) {
  const tpl = KIT_TEMPLATES[template];
  if (!tpl) return {};
  const out = {};
  for (const [k, sch] of Object.entries(tpl.params)) out[k] = params?.[k] !== undefined ? params[k] : Array.isArray(sch.default) ? [...sch.default] : sch.default;
  return out;
}

/** The text a template shows (its contract's text keys), as one string per item — for character and reading checks. */
export function kitTexts(template, params = {}) {
  const tpl = KIT_TEMPLATES[template];
  if (!tpl) return [];
  const P = kitParams(template, params);
  return tpl.contract.textKeys.flatMap((k) => (Array.isArray(P[k]) ? P[k] : [P[k]])).map((s) => String(s ?? "")).filter(Boolean);
}

/** The layer blend mode a template asks for (transform.blend): "normal" unless it is a tint. */
export const kitBlend = (template, params) => KIT_TEMPLATES[template]?.blend?.(kitParams(template, params)) || "normal";

/**
 * The band of the frame a graphic is rendered in (pixels: { x, y, w, h }, even numbers), or null for the whole frame.
 * Rendering only that band is the main speed-up of the export (the browser's cost grows with the pixels it captures):
 * the full width (entries slide in from the sides) and the predicted box's height times the template's `reach` (how
 * far its motion overshoots: a word that drops from 2.3× its size reaches 2.6), plus a margin. The render worker
 * checks the result and renders the whole frame again when anything touches the band's edge.
 */
export function kitCrop(template, params, W, H) {
  const tpl = KIT_TEMPLATES[template];
  if (!tpl || tpl.contract.fullFrame || !tpl.reach) return null;
  const b = kitBox(template, params, W, H);
  if (!b) return null;
  const cy = (b.y + b.h / 2) * H, half = (b.h * H * tpl.reach) / 2 + 0.05 * Math.max(W, H);
  const y0 = Math.max(0, Math.floor((cy - half) / 2) * 2), y1 = Math.min(H, Math.ceil((cy + half) / 2) * 2);
  if (y1 - y0 > H * 0.8) return null; // nearly the whole frame: not worth a band
  return { x: 0, y: y0, w: W, h: y1 - y0 };
}

/** Predicted box (fractions) of a template with its parameters on a W×H frame. */
export function kitBox(template, params, W, H) {
  const tpl = KIT_TEMPLATES[template];
  if (!tpl) return null;
  const r = tpl.box(kitParams(template, params), W, H);
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.min(1, r.x + r.w) - x, h: Math.min(1, r.y + r.h) - y };
}
