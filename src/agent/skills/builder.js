// Skill Builder (rule-based, offline): turns a description in Arabic or English into a draft skill made only of
// real operations. Requests it cannot map to an existing operation are reported in `unsupported` — they are
// never silently dropped or faked. An LLM provider can later produce the same draft shape.
import { FILTER_PRESETS } from "../../core/presets.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[ً-ْ]/g, "");
const has = (t, ...words) => words.some((w) => t.includes(norm(w)));

const LOOKS = {
  cinematic: ["سينمائي", "سينما", "cinematic", "film"], warm: ["دافئ", "دافي", "warm"], cool: ["بارد", "cool"], vivid: ["حيوي", "زاهي", "vivid", "punchy"],
  teal: ["تيل", "teal"], golden: ["ذهبي", "golden"], vintage: ["قديم", "كلاسيك", "vintage", "retro"], noir: ["نوار", "noir"], mono: ["ابيض واسود", "black and white", "mono"],
  dramatic: ["درامي", "dramatic"], pastel: ["باستيل", "pastel"], portrait: ["بورتريه", "portrait"],
};
const TRANSITION_WORDS = [
  ["push_left", ["سريعه", "سريع", "quick", "fast", "push"]], ["fade_black", ["اسود", "black"]], ["zoom_in", ["زوم", "zoom"]],
  ["slide_left", ["انزلاق", "slide"]], ["dissolve", ["تلاشي", "ذوبان", "dissolve", "crossfade", "ناعم", "smooth"]],
];

// Things people ask for that have no operation yet — reported, not faked.
const UNSUPPORTED = [
  [["زوم عند", "زوما عند", "زووم عند", "زوم على", "zoom on important", "zoom in on key", "punch in"], "Automatic zoom on important sentences (needs speech understanding)"],
  [["الوجه", "تجميل", "بشره", "face", "beauty", "skin"], "Face / beauty retouch (no face model yet)"],
  [["ايموجي", "emoji"], "Emoji captions"],
  [["اصفر", "yellow", "ابيض", "white", "متحرك", "animated"], "Caption colours and animation styles (caption templates are not an operation yet)"],
  [["بي رول", "b-roll", "broll"], "Automatic B-roll"],
  [["موسيقى", "music"], "Automatic background music"],
];

const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

/** @returns {{ skill, understood: string[], unsupported: string[] }} */
export function buildSkillFromText(text, { name = "" } = {}) {
  const t = norm(text);
  const steps = [];
  const understood = [];
  const permissions = new Set(["read", "edit"]);
  const settings = {};
  const fast = has(t, "سريع", "ريلز", "ريل", "شورت", "تيك توك", "fast", "reel", "short", "tiktok", "dynamic", "ديناميك");

  let ratio = null;
  if (has(t, "9:16", "عمودي", "طولي", "بالطول", "ريلز", "ريل", "شورت", "تيك توك", "vertical", "reel", "short", "tiktok", "story")) ratio = "9:16";
  else if (has(t, "16:9", "افقي", "بالعرض", "يوتيوب", "landscape", "youtube")) ratio = "16:9";
  else if (has(t, "1:1", "مربع", "square")) ratio = "1:1";
  if (ratio) {
    steps.push({ id: "frame", title: `Canvas ${ratio}`, op: "timeline_set_canvas", with: { timelineId: "{{ctx.timelineId}}", ratio, bgType: ratio === "16:9" ? "color" : "blur" } });
    understood.push(`canvas ${ratio}`); settings["canvas.ratio"] = ratio;
  }
  if (has(t, "صمت", "سكت", "سكتات", "السكوت", "الوقفات", "silence", "pause", "dead air")) {
    steps.push({ id: "silences", title: "Remove pauses", op: "timeline_remove_silences", with: { timelineId: "{{ctx.timelineId}}", minDurS: fast ? 0.35 : 0.7, paddingMs: fast ? 60 : 150 } });
    permissions.add("media"); understood.push(`remove silences (${fast ? "tight" : "natural"})`);
  }
  if (has(t, "ضوضاء", "ضجيج", "نظف الصوت", "حسن الصوت", "تحسين الصوت", "الصوت واضح", "noise", "clean audio", "clean up audio", "enhance voice", "improve audio", "voice")) {
    steps.push({ id: "voice", title: "Clean up voice", op: "audio_enhance_voice", with: { timelineId: "{{ctx.timelineId}}", denoise: true, enhanceVoice: true } });
    understood.push("noise reduction + voice enhancement");
  }
  if (has(t, "مستوى الصوت", "وحد الصوت", "توحيد الصوت", "ارفع الصوت", "loudness", "normalize", "volume consistent", "even out", "تحسين الصوت", "حسن الصوت")) {
    const lufs = fast || ratio === "9:16" ? -14 : -16;
    steps.push({ id: "loudness", title: `Loudness ${lufs} LUFS`, op: "audio_normalize", with: { timelineId: "{{ctx.timelineId}}", targetLufs: "{{settings.audio.loudness}}" } });
    understood.push(`loudness ${lufs} LUFS`); settings["audio.loudness"] = lufs;
  }
  const look = Object.entries(LOOKS).find(([, words]) => has(t, ...words))?.[0];
  if (look && FILTER_PRESETS[look]) {
    steps.push({ id: "look", title: `Look: ${look}`, op: "timeline_add_layer", with: { timelineId: "{{ctx.timelineId}}", kind: "filter", settings: { preset: look, intensity: 75 } } });
    understood.push(`colour look ${look}`); settings["look.filter"] = look;
  }
  if (has(t, "شرائط", "letterbox", "widescreen bars", "اطار سينمائي")) {
    steps.push({ id: "bars", title: "Letterbox", op: "timeline_add_layer", with: { timelineId: "{{ctx.timelineId}}", kind: "effect", settings: { type: "letterbox", intensity: 50 } } });
    understood.push("letterbox bars");
  }
  if (has(t, "انتقال", "انتقالات", "transition")) {
    const type = TRANSITION_WORDS.find(([, words]) => has(t, ...words))?.[0] || (fast ? "push_left" : "dissolve");
    steps.push({ id: "cuts", title: `Transitions: ${type}`, op: "timeline_transition_all", when: "ctx.hasCuts", with: { timelineId: "{{ctx.timelineId}}", type, durationUs: fast ? 250000 : 500000 } });
    understood.push(`transitions ${type}`);
  }
  let requires;
  if (has(t, "كابشن", "كابشنز", "ترجمه", "ترجمات", "تفريغ", "caption", "subtitle", "transcri")) {
    const language = has(t, "عربي", "arabic", "مصري", "خليجي") ? "ar" : has(t, "english", "انجليزي") ? "en" : "auto";
    steps.push({ id: "captions", title: `Captions (${language})`, op: "timeline_add_captions", with: { timelineId: "{{ctx.timelineId}}", language } });
    permissions.add("media"); requires = { providers: ["whisper"] }; understood.push(`auto captions (${language}, local whisper model)`);
  }
  const unsupported = UNSUPPORTED.filter(([words]) => has(t, ...words)).map(([, label]) => label);

  const title = name || (understood.length ? `Custom: ${understood.slice(0, 3).join(", ")}` : "Custom skill");
  const id = slug(name) || `custom-${Date.now().toString(36)}`;
  const skill = {
    schema: "montaj.skill/1", id: /^[a-z]/.test(id) ? id : `s-${id}`, name: title.slice(0, 80), version: "1.0.0",
    description: String(text).slice(0, 1000) || "Custom skill", author: "skill builder", source: "skills_build_from_text",
    category: ratio === "9:16" || fast ? "social" : "custom", tags: [], capabilities: understood,
    inputs: { type: "object", properties: {}, additionalProperties: false },
    permissions: [...permissions], settings, steps: steps.length ? steps : [{ id: "inspect", title: "Nothing recognised", op: "timeline_inspect", with: { timelineId: "{{ctx.timelineId}}" } }],
    success: ["timeline_not_empty"], rollback: "restore", examples: [String(text).slice(0, 300)],
  };
  if (requires) skill.requires = requires;
  return { skill, understood, unsupported };
}
