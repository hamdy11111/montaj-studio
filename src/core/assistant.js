// EditPilot (FEAT-098) — local, rule-based natural-language command planner (Arabic + English).
// It never edits directly: it returns a plan of editor actions that the renderer executes through the normal
// (undoable) commands and shows to the user. An optional user-configured LLM endpoint can produce the same plan.
import { FILTER_PRESETS } from "./presets.js";
import { TRANSITIONS } from "./layerMath.js";

const norm = (s) => s.toLowerCase().replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[ً-ْ]/g, "").trim();
const has = (t, ...words) => words.some((w) => t.includes(norm(w)));

const FILTER_SYNONYMS = {
  warm: ["دافئ", "دافي", "warm"], cool: ["بارد", "cool", "cold"], mono: ["ابيض واسود", "أبيض وأسود", "mono", "black and white", "b&w"],
  vintage: ["قديم", "كلاسيكي", "vintage", "retro"], cinematic: ["سينمائي", "سينما", "cinematic", "movie"], vivid: ["حيوي", "زاهي", "vivid"],
  noir: ["نوار", "noir"], golden: ["ذهبي", "golden"], teal: ["تيل", "teal"], pastel: ["باستيل", "pastel"], dramatic: ["درامي", "dramatic"], night: ["ليلي", "night"],
};

const RATIO_WORDS = [
  ["9:16", ["9:16", "عمودي", "طولي", "بالطول", "vertical", "portrait", "reel", "ريل", "شورت", "tiktok", "تيك توك"]],
  ["16:9", ["16:9", "افقي", "أفقي", "بالعرض", "landscape", "youtube", "يوتيوب", "horizontal"]],
  ["1:1", ["1:1", "مربع", "square"]], ["4:3", ["4:3"]], ["3:4", ["3:4"]], ["4:5", ["4:5"]], ["21:9", ["21:9"]],
];

export const SUGGESTIONS = [
  { ar: "اجعل الفيديو عموديًا 9:16", en: "Make it vertical 9:16" },
  { ar: "احذف السكتات", en: "Remove silences" },
  { ar: "وحّد مستوى الصوت", en: "Make volume consistent" },
  { ar: "حسّن الألوان", en: "Make colors better" },
  { ar: "أضف انتقال تلاشي بين كل المقاطع", en: "Add a dissolve transition between all clips" },
  { ar: "أضف نص \"مرحبا\"", en: "Add text \"Hello\"" },
];

/**
 * @param {string} text user request
 * @param {{ hasSelection: boolean }} ctx
 * @returns {{ actions: Array<{type: string, args?: object}>, understood: boolean }}
 */
export function planFromText(text, ctx = {}) {
  const t = norm(String(text || ""));
  const actions = [];
  if (!t) return { actions, understood: false };
  const scope = ctx.hasSelection && has(t, "المحدد", "هذا المقطع", "selected", "this clip") ? "selection" : "all";

  for (const [ratio, words] of RATIO_WORDS) if (has(t, ...words)) { actions.push({ type: "setRatio", args: { ratio } }); break; }

  const speed = /(\d+(?:[.,]\d+)?)\s*(?:x|×|اضعاف|مرات|مره)/.exec(t) || /(?:speed|سرعه)\s*(\d+(?:[.,]\d+)?)/.exec(t);
  if (speed) actions.push({ type: "setSpeed", args: { speed: Number(speed[1].replace(",", ".")), scope } });
  else if (has(t, "ابطاء", "بطيء", "slow motion", "slow down")) actions.push({ type: "setSpeed", args: { speed: 0.5, scope } });
  else if (has(t, "تسريع", "اسرع", "speed up", "faster")) actions.push({ type: "setSpeed", args: { speed: 2, scope } });

  if (has(t, "سكت", "صمت", "silence", "pauses", "الفراغات الصوتيه", "dead air")) actions.push({ type: "removeSilences", args: { scope } });
  if (has(t, "مشاهد", "المشاهد", "scene")) actions.push({ type: "splitScenes", args: { scope } });
  if (has(t, "وحد", "توحيد", "consistent", "normalize", "same volume", "مستوي الصوت") && has(t, "صوت", "volume", "loudness")) actions.push({ type: "globalEdit", args: { kind: "volumeConsistent" } });
  if (has(t, "وضوح الصوت", "صوت اوضح", "voice clearer", "clear voice", "ازاله الضوضاء", "noise")) actions.push({ type: "globalEdit", args: { kind: "voiceClearer" } });
  if (has(t, "حسن الالوان", "تحسين الالوان", "colors better", "better colors", "enhance color", "colour")) actions.push({ type: "globalEdit", args: { kind: "colorsBetter" } });
  if (has(t, "توحيد الالوان", "الوان موحده", "colors consistent", "match colors")) actions.push({ type: "globalEdit", args: { kind: "colorsConsistent" } });
  if (has(t, "اوضح", "حده", "sharper", "clearer video", "video clearer", "جوده الفيديو")) actions.push({ type: "globalEdit", args: { kind: "videoClearer" } });

  for (const [preset, words] of Object.entries(FILTER_SYNONYMS)) if (has(t, ...words) && (has(t, "فلتر", "فلاتر", "filter", "look", "مظهر", "لون") || words.some((w) => norm(w) === t))) { actions.push({ type: "addFilter", args: { preset } }); break; }

  if (has(t, "انتقال", "transition")) {
    const type = has(t, "اسود", "black") ? "fade_black" : has(t, "انزلاق", "slide") ? "slide_left" : has(t, "تكبير", "zoom") ? "zoom_in" : has(t, "دفع", "push") ? "push_left" : "dissolve";
    actions.push({ type: "transitionAll", args: { type: TRANSITIONS.includes(type) ? type : "dissolve" } });
  }
  if (has(t, "fade in", "ظهور تدريجي", "تلاشي دخول")) actions.push({ type: "animate", args: { which: "in", anim: "fade", scope } });
  if (has(t, "fade out", "اختفاء تدريجي", "تلاشي خروج")) actions.push({ type: "animate", args: { which: "out", anim: "fade", scope } });

  const quoted = /["“”«»'](.+?)["“”«»']/.exec(String(text));
  if (has(t, "اضف نص", "اكتب", "add text", "add title", "عنوان")) actions.push({ type: "addText", args: { content: quoted ? quoted[1] : String(text).replace(/.*(?:نص|text|title|عنوان)\s*[:：]?\s*/i, "").trim() || "Text" } });

  if (has(t, "خلفيه ضبابيه", "blur background", "background blur")) actions.push({ type: "canvasBlur", args: {} });
  if (has(t, "كتم", "mute")) actions.push({ type: "mute", args: { scope } });
  if (has(t, "ترجمه تلقائيه", "ترجمات", "captions", "subtitles")) actions.push({ type: "autoCaptions", args: {} });
  if (has(t, "عكس", "reverse")) actions.push({ type: "reverse", args: { scope: "selection" } });
  if (has(t, "تجميد", "freeze")) actions.push({ type: "freeze", args: {} });
  if (has(t, "مرآه", "مرايه", "mirror", "flip")) actions.push({ type: "mirror", args: { scope } });
  if (has(t, "تصدير", "export", "احفظ الفيديو", "save video")) actions.push({ type: "openExport", args: {} });

  return { actions, understood: actions.length > 0 };
}

/** JSON schema of actions for an optional LLM provider (same plan format). */
export const ACTION_TYPES = ["setRatio", "setSpeed", "removeSilences", "splitScenes", "globalEdit", "addFilter", "transitionAll", "animate", "addText", "canvasBlur", "mute", "autoCaptions", "reverse", "freeze", "mirror", "openExport"];
export const FILTER_NAMES = Object.keys(FILTER_PRESETS);
