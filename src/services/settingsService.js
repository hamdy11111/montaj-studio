// Settings (FEAT-009, FEAT-129..135, FEAT-147). Stored per section in Realm (Setting key/value), validated on write.
import { AppError, validateEnum, validateNumber } from "../core/validation.js";
import { FPS_OPTIONS } from "../core/model.js";
import { deepMerge } from "../core/util.js";

export const LANGUAGES = ["ar", "en"];

export function defaultSettings(paths) {
  return {
    draft: { mediaDir: paths.media, recordDir: paths.media, downloadDir: paths.media, cachePolicy: "keep", cacheDays: 30, autoBackup: false, presetDir: paths.library },
    edit: {
      stepFrames: 10, valueStep: 10, imageDurationS: 5, targetLufs: -23, scrubAudio: false,
      linkageEnabled: true, linkage: ["text", "effect", "sticker", "filter", "adjust", "sfx", "tts"], arrangeLayers: true,
      fps: 30, timecode: "HH:MM:SS+frame", exportSound: false, dreaminaSync: false, magnet: true, snapping: true, previewAxis: false,
    },
    performance: { hwEncode: true, hwDecode: true, gpuUI: true, autoOptimize: "smart", proxy: false, autoClearGB: 10, autoRender: false, outputDevice: "default", ffmpegPath: "", ffprobePath: "" },
    general: { language: "ar", notifications: true, updates: "notify", shellMenu: false, layout: "default", onboarded: false },
    providers: { whisperPath: "", whisperModel: "", whisperLanguage: "auto" },
    export: { resolution: "1080p", bitrate: "recommended", codec: "h264", format: "mp4", fps: 30, audioFormat: "flac", gifResolution: "320p", captionsFormat: "srt", dir: paths.media },
    ui: { lastShortcutPreset: 1, recentColors: [], presets: [] }, // presets: JSON strings {name, attrs} from "Save preset"
  };
}

const RULES = {
  "draft.cachePolicy": (v) => validateEnum(v, ["keep", "auto"], "cachePolicy"),
  "draft.cacheDays": (v) => validateEnum(Number(v), [7, 15, 30, 60, 90], "cacheDays"),
  "edit.stepFrames": (v) => validateNumber(v, { field: "stepFrames", min: 1, max: 300, integer: true }),
  "edit.valueStep": (v) => validateNumber(v, { field: "valueStep", min: 1, max: 100, integer: true }),
  "edit.imageDurationS": (v) => validateNumber(v, { field: "imageDurationS", min: 0.1, max: 600 }),
  "edit.targetLufs": (v) => validateEnum(Number(v), [-23, -14, -12], "targetLufs"),
  "edit.fps": (v) => validateEnum(Number(v), FPS_OPTIONS, "fps"),
  "edit.timecode": (v) => validateEnum(v, ["HH:MM:SS+frame", "HH:MM:SS.ms"], "timecode"),
  "performance.autoOptimize": (v) => validateEnum(v, ["none", "smart"], "autoOptimize"),
  "performance.autoClearGB": (v) => validateNumber(v, { field: "autoClearGB", min: 1, max: 500, integer: true }),
  "general.language": (v) => validateEnum(v, LANGUAGES, "language"),
  "general.updates": (v) => validateEnum(v, ["auto", "notify"], "updates"),
  "general.layout": (v) => validateEnum(v, ["default", "media", "attributes", "vertical"], "layout"),
  "export.resolution": (v) => validateEnum(v, ["480p", "720p", "1080p", "2k", "4k", "8k"], "resolution"),
  "export.codec": (v) => validateEnum(v, ["h264", "hevc", "av1", "prores", "prores_alpha"], "codec"),
  "export.format": (v) => validateEnum(v, ["mp4", "mov"], "format"),
  "export.audioFormat": (v) => validateEnum(v, ["flac", "mp3", "wav", "aac"], "audioFormat"),
  "providers.whisperLanguage": (v) => String(v).slice(0, 12),
};

export class SettingsService {
  constructor({ repos, paths }) {
    this.repos = repos;
    this.defaults = defaultSettings(paths);
    this.listeners = new Set();
  }

  get(section) {
    if (!(section in this.defaults)) throw new AppError("VALIDATION", "err.settingsSection", { section });
    return deepMerge(this.defaults[section], this.repos.settings.get(section, {}));
  }

  all() { return Object.fromEntries(Object.keys(this.defaults).map((k) => [k, this.get(k)])); }

  /** Validate and save a partial section; returns the merged section. */
  set(section, patch) {
    const current = this.get(section);
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in this.defaults[section])) throw new AppError("VALIDATION", "err.settingUnknown", { key: `${section}.${k}` });
      const rule = RULES[`${section}.${k}`];
      const def = this.defaults[section][k];
      if (rule) clean[k] = rule(v);
      else if (typeof def === "boolean") clean[k] = !!v;
      else if (typeof def === "number") clean[k] = validateNumber(v, { field: k });
      else if (Array.isArray(def)) { if (!Array.isArray(v)) throw new AppError("VALIDATION", "err.array", { field: k }); clean[k] = v.map(String); }
      else clean[k] = String(v ?? "");
    }
    const merged = { ...current, ...clean };
    this.repos.settings.set(section, merged);
    for (const fn of this.listeners) fn(section, merged, clean);
    return merged;
  }

  reset(section) { this.repos.settings.set(section, {}); return this.get(section); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
