// Plain-object domain model shared by main and renderer. Mirrors the Realm schemas (src/db/schemas) and the
// report's observed draft model: tracks[] › segments[] referencing media, time in microseconds.
import { uid, US, deepMerge } from "./util.js";

export const TRACK_TYPES = ["video", "audio", "text", "sticker", "effect", "filter", "adjust"];

/** Which segment kinds a track type accepts. */
export const TRACK_ACCEPTS = {
  video: ["video", "image", "compound"],
  audio: ["audio"],
  text: ["text"],
  sticker: ["sticker"],
  effect: ["effect"],
  filter: ["filter"],
  adjust: ["adjust"],
};

export const KIND_TO_TRACK = { video: "video", image: "video", compound: "video", audio: "audio", text: "text", sticker: "sticker", effect: "effect", filter: "filter", adjust: "adjust" };

/** Track colours measured from CapCut 9.6 (report chapter 6, color.track.*). */
export const TRACK_COLORS = {
  video: "#1A5F64", audio: "#0E3058", text: "#9C4937", sticker: "#D69329", effect: "#744A82", filter: "#47418B", adjust: "#AB8636", tts: "#003A4C", overlay: "#014A51",
};

export const CANVAS_RATIOS = {
  original: null, "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:3": [4, 3], "3:4": [3, 4], "21:9": [21, 9], "4:5": [4, 5], "2:1": [2, 1], "2.35:1": [2.35, 1],
};

export const RESOLUTIONS = { "480p": 480, "720p": 720, "1080p": 1080, "2k": 1440, "4k": 2160, "8k": 4320 };
export const FPS_OPTIONS = [24, 25, 29.97, 30, 50, 59.94, 60];

export function canvasSize(ratio, shortSide = 1080, original = { width: 1920, height: 1080 }) {
  const r = CANVAS_RATIOS[ratio];
  let w, h;
  if (!r) { w = original.width || 1920; h = original.height || 1080; const s = shortSide / Math.min(w, h); w *= s; h *= s; }
  else if (r[0] >= r[1]) { h = shortSide; w = (shortSide * r[0]) / r[1]; }
  else { w = shortSide; h = (shortSide * r[1]) / r[0]; }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w), height: even(h) };
}

export const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, uniform: true, rotation: 0, flipH: false, flipV: false, opacity: 1, blend: "normal" };
export const DEFAULT_CROP = { x: 0, y: 0, w: 1, h: 1 };
export const HSL_CHANNELS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"];
export const DEFAULT_ADJUST = {
  enabled: true,
  brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, hue: 0, sharpen: 0, vignette: 0, highlights: 0, shadows: 0,
  lut: { assetId: null, intensity: 100 },
  hsl: Object.fromEntries(HSL_CHANNELS.map((c) => [c, { h: 0, s: 0, l: 0 }])),
  curves: { master: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
  wheels: { shadows: { r: 0, g: 0, b: 0 }, midtones: { r: 0, g: 0, b: 0 }, highlights: { r: 0, g: 0, b: 0 }, offset: { r: 0, g: 0, b: 0 }, intensity: 100 },
};
export const DEFAULT_VIDEO_FX = {
  stabilize: { enabled: false, level: "recommended" },
  denoise: { enabled: false, level: 50 },
  motionBlur: { enabled: false, amount: 3 },
  chroma: { enabled: false, color: "#00FF00", intensity: 30, shadow: 0 },
  mask: { type: "none", x: 0, y: 0, w: 0.6, h: 0.6, rotation: 0, feather: 0, invert: false },
  matte: { type: "none" }, // "person": only the person shows (a cutout layer above text = text behind the person)
};
export const DEFAULT_AUDIO_FX = {
  normalize: { enabled: false, targetLufs: -23 },
  denoise: { enabled: false },
  enhanceVoice: { enabled: false },
  isolate: "none", // none | remove_vocal | keep_vocal  (local approximation, see report FEAT-063)
  voiceChanger: "none",
};
export const DEFAULT_TEXT = {
  content: "Default text", font: "Cairo", size: 15, color: "#FFFFFF", bold: false, italic: false, underline: false,
  textCase: "none", letterSpacing: 0, lineSpacing: 0, align: "center", direction: "auto",
  strokeColor: "#000000", strokeWidth: 0, bgColor: "#000000", bgOpacity: 0, shadow: false, preset: "none", isCaption: false,
};

export function newTrack(type, { isMain = false, order = 0, name, role = "" } = {}) {
  return { id: uid(), type, order, isMain, locked: false, hidden: false, muted: false, name: name || "", role, segments: [] };
}

export function newSegment(kind, init = {}) {
  const base = {
    id: uid(), kind, mediaId: null, name: "", start: 0, duration: 3 * US, sourceStart: 0, sourceDuration: 0,
    speed: 1, speedMode: "standard", curve: { preset: "none", points: [] }, changePitch: false,
    volumeDb: 0, fadeInUs: 0, fadeOutUs: 0, disabled: false, groupId: null, colorTag: "", audioDetached: false,
    transform: { ...DEFAULT_TRANSFORM }, crop: { ...DEFAULT_CROP },
    adjust: null, videoFx: null, audioFx: null,
    animation: { in: { type: "none", durationUs: 500_000 }, out: { type: "none", durationUs: 500_000 }, combo: { type: "none", durationUs: 1_000_000 } },
    transitionOut: { type: "none", durationUs: 500_000 },
    clipEffects: [],
    keyframes: [],
    text: null, effect: null, filter: null, sticker: null, compoundTimelineId: null,
  };
  if (["video", "image", "compound"].includes(kind)) { base.adjust = deepMerge(DEFAULT_ADJUST, {}); base.videoFx = deepMerge(DEFAULT_VIDEO_FX, {}); }
  if (["video", "audio", "compound"].includes(kind)) base.audioFx = deepMerge(DEFAULT_AUDIO_FX, {});
  if (kind === "text") base.text = { ...DEFAULT_TEXT };
  if (kind === "adjust") base.adjust = deepMerge(DEFAULT_ADJUST, {});
  if (kind === "effect") base.effect = { type: "blur", intensity: 50 };
  if (kind === "filter") base.filter = { preset: "vivid", intensity: 100 };
  if (kind === "sticker") base.sticker = { assetId: null, builtin: null };
  return deepMerge(base, init);
}

export function newTimeline(projectId, { name = "Timeline 01", ratio = "original", width = 1920, height = 1080, fps = 30 } = {}) {
  const main = newTrack("video", { isMain: true, order: 0 });
  return {
    id: uid(), projectId, name, fps, isCompound: false,
    canvas: { ratio, width, height, bgType: "color", bgColor: "#000000", bgBlur: 0 },
    markers: [],
    tracks: [main],
  };
}

export function timelineDuration(tl) {
  let end = 0;
  for (const t of tl.tracks) for (const s of t.segments) end = Math.max(end, s.start + s.duration);
  return end;
}

export function findSegment(tl, segId) {
  for (const t of tl.tracks) {
    const i = t.segments.findIndex((s) => s.id === segId);
    if (i >= 0) return { track: t, segment: t.segments[i], index: i };
  }
  return null;
}

export const mainTrack = (tl) => tl.tracks.find((t) => t.isMain);
export const sortSegments = (track) => track.segments.sort((a, b) => a.start - b.start);
