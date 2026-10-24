// Converts between Realm objects and the plain domain model (src/core/model.js). The rest of the app only
// sees plain objects; Realm objects never cross the IPC boundary.
import { DEFAULT_ADJUST, DEFAULT_AUDIO_FX, DEFAULT_TEXT, DEFAULT_TRANSFORM, DEFAULT_CROP, HSL_CHANNELS } from "../core/model.js";

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const flat = (pts) => pts.flatMap(([x, y]) => [x, y]);
const unflat = (arr) => { const out = []; for (let i = 0; i + 1 < arr.length; i += 2) out.push([arr[i], arr[i + 1]]); return out; };

// ---------------------------------------------------------------- adjust
export function adjustToRealm(a) {
  if (!a) return null;
  return {
    ...pick(a, ["enabled", "brightness", "contrast", "saturation", "exposure", "temperature", "tint", "hue", "sharpen", "vignette", "highlights", "shadows"]),
    lutAssetId: a.lut?.assetId ?? null, lutIntensity: a.lut?.intensity ?? 100,
    hsl: HSL_CHANNELS.map((c) => ({ channel: c, h: a.hsl?.[c]?.h || 0, s: a.hsl?.[c]?.s || 0, l: a.hsl?.[c]?.l || 0 })),
    curves: ["master", "r", "g", "b"].map((c) => ({ channel: c, points: flat(a.curves?.[c] || [[0, 0], [1, 1]]) })),
    wheels: ["shadows", "midtones", "highlights", "offset"].map((r) => ({ range: r, ...(a.wheels?.[r] || { r: 0, g: 0, b: 0 }) })),
    wheelsIntensity: a.wheels?.intensity ?? 100,
  };
}
export function adjustFromRealm(r) {
  if (!r) return null;
  const a = { ...pick(r, ["enabled", "brightness", "contrast", "saturation", "exposure", "temperature", "tint", "hue", "sharpen", "vignette", "highlights", "shadows"]) };
  a.lut = { assetId: r.lutAssetId ?? null, intensity: r.lutIntensity };
  a.hsl = Object.fromEntries(HSL_CHANNELS.map((c) => [c, { h: 0, s: 0, l: 0 }]));
  for (const h of r.hsl) a.hsl[h.channel] = { h: h.h, s: h.s, l: h.l };
  a.curves = { ...DEFAULT_ADJUST.curves };
  for (const c of r.curves) a.curves[c.channel] = unflat([...c.points]);
  a.wheels = { ...DEFAULT_ADJUST.wheels, intensity: r.wheelsIntensity };
  for (const w of r.wheels) a.wheels[w.range] = { r: w.r, g: w.g, b: w.b };
  return a;
}

// ---------------------------------------------------------------- video / audio fx
export function videoFxToRealm(v) {
  if (!v) return null;
  return {
    stabilize: v.stabilize.enabled, stabilizeLevel: v.stabilize.level, denoise: v.denoise.enabled, denoiseLevel: v.denoise.level,
    motionBlur: v.motionBlur.enabled, motionBlurAmount: v.motionBlur.amount,
    chroma: v.chroma.enabled, chromaColor: v.chroma.color, chromaIntensity: v.chroma.intensity, chromaShadow: v.chroma.shadow,
    maskType: v.mask.type, maskX: v.mask.x, maskY: v.mask.y, maskW: v.mask.w, maskH: v.mask.h, maskRotation: v.mask.rotation, maskFeather: v.mask.feather, maskInvert: v.mask.invert,
  };
}
export function videoFxFromRealm(r) {
  if (!r) return null;
  return {
    stabilize: { enabled: r.stabilize, level: r.stabilizeLevel }, denoise: { enabled: r.denoise, level: r.denoiseLevel },
    motionBlur: { enabled: r.motionBlur, amount: r.motionBlurAmount },
    chroma: { enabled: r.chroma, color: r.chromaColor, intensity: r.chromaIntensity, shadow: r.chromaShadow },
    mask: { type: r.maskType, x: r.maskX, y: r.maskY, w: r.maskW, h: r.maskH, rotation: r.maskRotation, feather: r.maskFeather, invert: r.maskInvert },
  };
}
export function audioFxToRealm(a) {
  if (!a) return null;
  return { normalize: a.normalize.enabled, targetLufs: a.normalize.targetLufs, denoise: a.denoise.enabled, enhanceVoice: a.enhanceVoice.enabled, isolate: a.isolate, voiceChanger: a.voiceChanger };
}
export function audioFxFromRealm(r) {
  if (!r) return null;
  return { ...DEFAULT_AUDIO_FX, normalize: { enabled: r.normalize, targetLufs: r.targetLufs }, denoise: { enabled: r.denoise }, enhanceVoice: { enabled: r.enhanceVoice }, isolate: r.isolate, voiceChanger: r.voiceChanger };
}

// ---------------------------------------------------------------- segment
const SEG_SCALARS = ["kind", "name", "start", "duration", "sourceStart", "sourceDuration", "speed", "speedMode", "changePitch", "volumeDb", "fadeInUs", "fadeOutUs", "disabled", "groupId", "colorTag", "audioDetached"];

export function segmentToRealm(s, realm) {
  return {
    _id: s.id,
    ...pick(s, SEG_SCALARS),
    start: Math.round(s.start), duration: Math.round(s.duration), sourceStart: Math.round(s.sourceStart || 0), sourceDuration: Math.round(s.sourceDuration || 0),
    groupId: s.groupId || null, colorTag: s.colorTag || "",
    curvePreset: s.curve?.preset || "none", curvePoints: flat(s.curve?.points || []),
    transform: { ...DEFAULT_TRANSFORM, ...(s.transform || {}) }, crop: { ...DEFAULT_CROP, ...(s.crop || {}) },
    adjust: adjustToRealm(s.adjust), videoFx: videoFxToRealm(s.videoFx), audioFx: audioFxToRealm(s.audioFx),
    animIn: s.animation?.in, animOut: s.animation?.out, animCombo: s.animation?.combo, transitionOut: s.transitionOut,
    clipEffects: (s.clipEffects || []).map((e) => ({ type: e.type, intensity: e.intensity ?? 50, velocity: !!e.velocity })),
    keyframes: (s.keyframes || []).map((k) => ({ id: k.id, prop: k.prop, timeUs: Math.round(k.timeUs), value: k.value, easing: k.easing || "linear" })),
    text: s.text ? { ...DEFAULT_TEXT, ...s.text, caption: s.text.caption ? JSON.stringify(s.text.caption) : null } : null,
    effectType: s.effect?.type ?? null, effectIntensity: s.effect?.intensity ?? 50,
    filterPreset: s.filter?.preset ?? null, filterIntensity: s.filter?.intensity ?? 100,
    stickerAssetId: s.sticker?.assetId ?? null, stickerBuiltin: s.sticker?.builtin ?? null,
    media: s.mediaId ? realm.objectForPrimaryKey("MediaAsset", s.mediaId) : null,
    compoundTimeline: s.compoundTimelineId ? realm.objectForPrimaryKey("Timeline", s.compoundTimelineId) : null,
  };
}

const anim = (a) => (a ? { type: a.type, durationUs: a.durationUs } : { type: "none", durationUs: 500_000 });

function textFromRealm(t) {
  const out = pick(t, Object.keys(DEFAULT_TEXT));
  if (t.caption) { try { out.caption = JSON.parse(t.caption); } catch { /* unreadable caption data: plain text */ } }
  return out;
}

export function segmentFromRealm(r) {
  return {
    id: r._id, ...pick(r, SEG_SCALARS), groupId: r.groupId ?? null,
    mediaId: r.media?._id ?? null, compoundTimelineId: r.compoundTimeline?._id ?? null,
    curve: { preset: r.curvePreset, points: unflat([...r.curvePoints]) },
    transform: r.transform ? pick(r.transform, Object.keys(DEFAULT_TRANSFORM)) : { ...DEFAULT_TRANSFORM },
    crop: r.crop ? pick(r.crop, ["x", "y", "w", "h"]) : { ...DEFAULT_CROP },
    adjust: adjustFromRealm(r.adjust), videoFx: videoFxFromRealm(r.videoFx), audioFx: audioFxFromRealm(r.audioFx),
    animation: { in: anim(r.animIn), out: anim(r.animOut), combo: anim(r.animCombo) },
    transitionOut: anim(r.transitionOut),
    clipEffects: r.clipEffects.map((e) => ({ type: e.type, intensity: e.intensity, velocity: e.velocity })),
    keyframes: r.keyframes.map((k) => ({ id: k.id, prop: k.prop, timeUs: k.timeUs, value: k.value, easing: k.easing })),
    text: r.text ? textFromRealm(r.text) : null,
    effect: r.effectType ? { type: r.effectType, intensity: r.effectIntensity } : null,
    filter: r.filterPreset ? { preset: r.filterPreset, intensity: r.filterIntensity } : null,
    sticker: r.kind === "sticker" ? { assetId: r.stickerAssetId ?? null, builtin: r.stickerBuiltin ?? null } : null,
  };
}

// ---------------------------------------------------------------- track / timeline / project / media
export function timelineFromRealm(t) {
  return {
    id: t._id, name: t.name, order: t.order, fps: t.fps, isCompound: t.isCompound,
    projectId: t.project?.[0]?._id ?? null,
    canvas: t.canvas ? pick(t.canvas, ["ratio", "width", "height", "bgType", "bgColor", "bgBlur"]) : { ratio: "original", width: 1920, height: 1080, bgType: "color", bgColor: "#000000", bgBlur: 0 },
    markers: t.markers.map((m) => ({ id: m.id, timeUs: m.timeUs, color: m.color, note: m.note })),
    tracks: [...t.tracks].sort((a, b) => a.order - b.order).map((tr) => ({
      id: tr._id, type: tr.type, order: tr.order, isMain: tr.isMain, name: tr.name, locked: tr.locked, hidden: tr.hidden, muted: tr.muted,
      segments: [...tr.segments].map(segmentFromRealm).sort((a, b) => a.start - b.start),
    })),
  };
}

export function mediaFromRealm(m) {
  return {
    id: m._id, ...pick(m, ["name", "path", "type", "durationUs", "width", "height", "fps", "hasAudio", "hasVideo", "videoCodec", "audioCodec", "sampleRate", "channels", "sizeBytes", "status", "thumbPath", "thumbCount", "waveformPath", "proxyPath", "favorite", "origin"]),
    importedAt: m.importedAt?.toISOString?.() ?? null, derivedFromId: m.derivedFrom?._id ?? null,
  };
}

export function projectFromRealm(p) {
  return {
    id: p._id, name: p.name, status: p.status, isTemplate: p.isTemplate,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), lastOpenedAt: p.lastOpenedAt?.toISOString() ?? null,
    trashedAt: p.trashedAt?.toISOString() ?? null, durationUs: p.durationUs, sizeBytes: p.sizeBytes, realEditSeconds: p.realEditSeconds,
    coverPath: p.coverPath ?? null, mainTimelineId: p.mainTimelineId, tags: [...p.tags],
    timelines: [...p.timelines].sort((a, b) => a.order - b.order).map((t) => ({ id: t._id, name: t.name, isCompound: t.isCompound })),
    mediaCount: p.media.length,
    template: p.template ? pick(p.template, ["category", "description", "orientation", "clipCount", "usageCount", "favorite"]) : null,
    workspaceIds: p.workspaces.map((w) => w._id),
  };
}
