// Realm object schemas (schemaVersion 2). Relationships:
//   Project 1─n Timeline 1─n Track 1─n Segment n─1 MediaAsset;  Project 1─n MediaAsset;
//   Segment n─1 Timeline (compound clips);  Workspace n─n Project;  ExportRecord/ShareRecord n─1 Project.
// Embedded objects hold value-typed parameter blocks (transform, adjust, effects...).

export const SCHEMA_VERSION = 5;

const emb = (name, properties) => ({ name, embedded: true, properties });

export const Transform = emb("Transform", {
  x: { type: "double", default: 0 }, y: { type: "double", default: 0 }, scale: { type: "double", default: 1 },
  scaleX: { type: "double", default: 1 }, scaleY: { type: "double", default: 1 }, uniform: { type: "bool", default: true },
  rotation: { type: "double", default: 0 }, flipH: { type: "bool", default: false }, flipV: { type: "bool", default: false },
  opacity: { type: "double", default: 1 }, blend: { type: "string", default: "normal" },
});
export const Crop = emb("Crop", { x: { type: "double", default: 0 }, y: { type: "double", default: 0 }, w: { type: "double", default: 1 }, h: { type: "double", default: 1 } });
export const HslChannel = emb("HslChannel", { channel: "string", h: { type: "double", default: 0 }, s: { type: "double", default: 0 }, l: { type: "double", default: 0 } });
export const CurveChannel = emb("CurveChannel", { channel: "string", points: "double[]" }); // flattened [x0,y0,x1,y1,...]
export const WheelRange = emb("WheelRange", { range: "string", r: { type: "double", default: 0 }, g: { type: "double", default: 0 }, b: { type: "double", default: 0 } });
export const Adjust = emb("Adjust", {
  enabled: { type: "bool", default: true },
  brightness: { type: "double", default: 0 }, contrast: { type: "double", default: 0 }, saturation: { type: "double", default: 0 },
  exposure: { type: "double", default: 0 }, temperature: { type: "double", default: 0 }, tint: { type: "double", default: 0 },
  hue: { type: "double", default: 0 }, sharpen: { type: "double", default: 0 }, vignette: { type: "double", default: 0 },
  highlights: { type: "double", default: 0 }, shadows: { type: "double", default: 0 },
  lutAssetId: "string?", lutIntensity: { type: "double", default: 100 },
  hsl: "HslChannel[]", curves: "CurveChannel[]", wheels: "WheelRange[]", wheelsIntensity: { type: "double", default: 100 },
});
export const VideoFx = emb("VideoFx", {
  stabilize: { type: "bool", default: false }, stabilizeLevel: { type: "string", default: "recommended" },
  denoise: { type: "bool", default: false }, denoiseLevel: { type: "double", default: 50 },
  motionBlur: { type: "bool", default: false }, motionBlurAmount: { type: "double", default: 3 },
  chroma: { type: "bool", default: false }, chromaColor: { type: "string", default: "#00FF00" }, chromaIntensity: { type: "double", default: 30 }, chromaShadow: { type: "double", default: 0 },
  maskType: { type: "string", default: "none" }, maskX: { type: "double", default: 0 }, maskY: { type: "double", default: 0 },
  maskW: { type: "double", default: 0.6 }, maskH: { type: "double", default: 0.6 }, maskRotation: { type: "double", default: 0 },
  maskFeather: { type: "double", default: 0 }, maskInvert: { type: "bool", default: false },
  matte: { type: "string", default: "none" }, // v5: "person" = keep only the person (cutout over text placed beneath)
});
export const AudioFx = emb("AudioFx", {
  normalize: { type: "bool", default: false }, targetLufs: { type: "double", default: -23 },
  denoise: { type: "bool", default: false }, enhanceVoice: { type: "bool", default: false },
  isolate: { type: "string", default: "none" }, voiceChanger: { type: "string", default: "none" },
});
export const AnimSpec = emb("AnimSpec", { type: { type: "string", default: "none" }, durationUs: { type: "int", default: 500000 } });
export const ClipEffect = emb("ClipEffect", { type: "string", intensity: { type: "double", default: 50 }, velocity: { type: "bool", default: false } });
export const Keyframe = emb("Keyframe", { id: "string", prop: "string", timeUs: "int", value: "double", easing: { type: "string", default: "linear" } });
export const Marker = emb("Marker", { id: "string", timeUs: "int", color: { type: "string", default: "#00C1CD" }, note: { type: "string", default: "" } });
export const TextStyle = emb("TextStyle", {
  content: { type: "string", default: "" }, font: { type: "string", default: "Segoe UI" }, size: { type: "double", default: 15 },
  color: { type: "string", default: "#FFFFFF" }, bold: { type: "bool", default: false }, italic: { type: "bool", default: false },
  underline: { type: "bool", default: false }, textCase: { type: "string", default: "none" }, letterSpacing: { type: "double", default: 0 },
  lineSpacing: { type: "double", default: 0 }, align: { type: "string", default: "center" }, direction: { type: "string", default: "auto" },
  strokeColor: { type: "string", default: "#000000" }, strokeWidth: { type: "double", default: 0 }, bgColor: { type: "string", default: "#000000" },
  bgOpacity: { type: "double", default: 0 }, shadow: { type: "bool", default: false }, preset: { type: "string", default: "none" },
  isCaption: { type: "bool", default: false },
  caption: "string?", // v3: word-timed caption page (template, words, emphasis) as JSON — see core/captionTemplates.js
  graphic: "string?", // v4: motion-graphics template + parameters as JSON — see core/graphics.js
});
export const CanvasSpec = emb("CanvasSpec", {
  ratio: { type: "string", default: "original" }, width: { type: "int", default: 1920 }, height: { type: "int", default: 1080 },
  bgType: { type: "string", default: "color" }, bgColor: { type: "string", default: "#000000" }, bgBlur: { type: "double", default: 0 },
});
export const TemplateInfo = emb("TemplateInfo", {
  category: { type: "string", default: "general" }, description: { type: "string", default: "" },
  orientation: { type: "string", default: "landscape" }, clipCount: { type: "int", default: 0 }, usageCount: { type: "int", default: 0 },
  favorite: { type: "bool", default: false },
});

export const MediaAsset = {
  name: "MediaAsset", primaryKey: "_id",
  properties: {
    _id: "string", name: "string", path: { type: "string", indexed: true }, type: "string", // video | image | audio
    durationUs: { type: "int", default: 0 }, width: { type: "int", default: 0 }, height: { type: "int", default: 0 }, fps: { type: "double", default: 0 },
    hasAudio: { type: "bool", default: false }, hasVideo: { type: "bool", default: false }, videoCodec: { type: "string", default: "" }, audioCodec: { type: "string", default: "" },
    sampleRate: { type: "int", default: 0 }, channels: { type: "int", default: 0 }, sizeBytes: { type: "int", default: 0 },
    importedAt: "date", status: { type: "string", default: "ready" }, // ready | missing | failed
    thumbPath: "string?", thumbCount: { type: "int", default: 0 }, waveformPath: "string?", proxyPath: "string?",
    favorite: { type: "bool", default: false }, origin: { type: "string", default: "import" }, // import | reverse | freeze | tts | record | compound
    derivedFrom: "MediaAsset?",
    projects: { type: "linkingObjects", objectType: "Project", property: "media" },
  },
};

export const Segment = {
  name: "Segment", primaryKey: "_id",
  properties: {
    _id: "string", kind: "string", name: { type: "string", default: "" },
    start: "int", duration: "int", sourceStart: { type: "int", default: 0 }, sourceDuration: { type: "int", default: 0 },
    speed: { type: "double", default: 1 }, speedMode: { type: "string", default: "standard" }, curvePreset: { type: "string", default: "none" }, curvePoints: "double[]",
    changePitch: { type: "bool", default: false }, volumeDb: { type: "double", default: 0 }, fadeInUs: { type: "int", default: 0 }, fadeOutUs: { type: "int", default: 0 },
    disabled: { type: "bool", default: false }, groupId: "string?", colorTag: { type: "string", default: "" }, // colorTag added in schema v2
    audioDetached: { type: "bool", default: false }, // Extract audio (FEAT-066): the clip keeps its video, audio lives on an audio track
    transform: "Transform?", crop: "Crop?", adjust: "Adjust?", videoFx: "VideoFx?", audioFx: "AudioFx?",
    animIn: "AnimSpec?", animOut: "AnimSpec?", animCombo: "AnimSpec?", transitionOut: "AnimSpec?",
    clipEffects: "ClipEffect[]", keyframes: "Keyframe[]", text: "TextStyle?",
    effectType: "string?", effectIntensity: { type: "double", default: 50 }, filterPreset: "string?", filterIntensity: { type: "double", default: 100 },
    stickerAssetId: "string?", stickerBuiltin: "string?",
    media: "MediaAsset?", compoundTimeline: "Timeline?",
    track: { type: "linkingObjects", objectType: "Track", property: "segments" },
  },
};

export const Track = {
  name: "Track", primaryKey: "_id",
  properties: {
    _id: "string", type: "string", order: "int", isMain: { type: "bool", default: false }, name: { type: "string", default: "" },
    locked: { type: "bool", default: false }, hidden: { type: "bool", default: false }, muted: { type: "bool", default: false },
    role: { type: "string", default: "" }, // v5: "behind" = its layers show behind the person (core/cutout.js)
    segments: "Segment[]",
    timeline: { type: "linkingObjects", objectType: "Timeline", property: "tracks" },
  },
};

export const Timeline = {
  name: "Timeline", primaryKey: "_id",
  properties: {
    _id: "string", name: "string", order: { type: "int", default: 0 }, fps: { type: "double", default: 30 },
    isCompound: { type: "bool", default: false }, canvas: "CanvasSpec?", markers: "Marker[]", tracks: "Track[]",
    createdAt: "date", updatedAt: "date",
    project: { type: "linkingObjects", objectType: "Project", property: "timelines" },
  },
};

export const Project = {
  name: "Project", primaryKey: "_id",
  properties: {
    _id: "string", name: { type: "string", indexed: true }, createdAt: "date", updatedAt: "date",
    lastOpenedAt: "date?", // added in schema v2
    status: { type: "string", default: "active", indexed: true }, trashedAt: "date?",
    durationUs: { type: "int", default: 0 }, sizeBytes: { type: "int", default: 0 }, realEditSeconds: { type: "int", default: 0 },
    coverPath: "string?", mainTimelineId: "string",
    isTemplate: { type: "bool", default: false }, template: "TemplateInfo?",
    timelines: "Timeline[]", media: "MediaAsset[]", tags: "string[]",
    workspaces: { type: "linkingObjects", objectType: "Workspace", property: "projects" },
  },
};

export const Workspace = {
  name: "Workspace", primaryKey: "_id",
  properties: { _id: "string", name: "string", color: { type: "string", default: "#00C1CD" }, createdAt: "date", quotaBytes: { type: "int", default: 0 }, projects: "Project[]" },
};

export const LibraryItem = {
  name: "LibraryItem", primaryKey: "_id",
  properties: {
    _id: "string", kind: { type: "string", indexed: true }, // audio | sticker | lut | element | generated | font
    category: { type: "string", default: "yours" }, name: "string", path: "string", favorite: { type: "bool", default: false },
    createdAt: "date", durationUs: { type: "int", default: 0 }, sizeBytes: { type: "int", default: 0 }, meta: { type: "string", default: "{}" },
  },
};

export const ExportRecord = {
  name: "ExportRecord", primaryKey: "_id",
  properties: {
    _id: "string", project: "Project?", projectName: "string", path: "string", kind: { type: "string", default: "video" }, // video | audio | gif | captions | still | package
    settings: { type: "string", default: "{}" }, status: "string", progress: { type: "double", default: 0 },
    startedAt: "date", finishedAt: "date?", sizeBytes: { type: "int", default: 0 }, error: "string?",
  },
};

export const ShareRecord = {
  name: "ShareRecord", primaryKey: "_id",
  properties: { _id: "string", project: "Project?", projectName: "string", packagePath: "string", createdAt: "date", direction: { type: "string", default: "out" } },
};

export const Setting = { name: "Setting", primaryKey: "key", properties: { key: "string", value: "string", updatedAt: "date" } };

export const ShortcutPreset = { name: "ShortcutPreset", primaryKey: "id", properties: { id: "int", name: "string", bindings: "string{}" } };

export const ALL_SCHEMAS = [
  Transform, Crop, HslChannel, CurveChannel, WheelRange, Adjust, VideoFx, AudioFx, AnimSpec, ClipEffect, Keyframe, Marker, TextStyle, CanvasSpec, TemplateInfo,
  MediaAsset, Segment, Track, Timeline, Project, Workspace, LibraryItem, ExportRecord, ShareRecord, Setting, ShortcutPreset,
];
