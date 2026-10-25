// The video studio's rules and ComfyUI graphs (pure functions, ported from the user's H3 Studio: workflow.py,
// prompt_builder.py, enhancement.py). Only ComfyUI's own nodes plus the app's MontajFreeModels: the source segment is
// cut beforehand by the app (exact frames at 24 fps) instead of a third-party video loader, links go straight instead
// of through switch nodes, and the prompt is written here in full.
import { AppError } from "../../core/validation.js";
import { STYLES } from "./presets.js";

export const FPS = 24;
export const MIN_FRAMES = 5;
export const MAX_FRAMES = 362; // ≈ 15 s: the model's limit in this set-up
export const FRAME_OPTIONS = [107, 124, 192, 243, 362];
export const QUALITY_OPTIONS = [0.4, 0.6, 0.98];
export const STEP_OPTIONS = [20, 25, 30];
export const TURBO_STEPS = [4, 6, 8];
export const MAX_REFS = 3;

export const MODELS = {
  unet: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  vae: "minimax_h3_video_vae_fp16.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  sam: "sam3.1_multiplex_fp16.safetensors",
  turbo: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  seedvr: "seedvr2_3b_int8_convrot.safetensors",
  seedvrVae: "seedvr2_ema_vae_fp16.safetensors",
};

export const GENERATE_DEFAULTS = {
  durationMode: "preset", frames: 107, start: 0, megapixels: 0.98, steps: 20, sound: true,
  turbo: false, turboSteps: 4, turboStrength: 1, promptStyle: "reference", characterNotes: "", instructions: "", seed: 150020260820,
};
export const ENHANCE_DEFAULTS = { shortEdge: 1080, strength: 0.6, color: "lab", chunkFrames: 9, tileSize: 512, seed: 42, sound: true, crf: 18 };

const bad = (field, extra = {}) => new AppError("VALIDATION", "err.videoSetting", { field, ...extra });

/** A frame count the model accepts: 17k + 5 (5, 22, 39, …, 362). */
export const snapFrames = (n) => Math.max(MIN_FRAMES, Math.floor((n - 5) / 17) * 17 + 5);

/** The generation settings, checked (unknown keys refused, every value from its allowed set). */
export function generateSettings(raw = {}) {
  const unknown = Object.keys(raw).filter((k) => !(k in GENERATE_DEFAULTS));
  if (unknown.length) throw bad(unknown[0]);
  const s = { ...GENERATE_DEFAULTS, ...raw };
  if (!["preset", "full", "range"].includes(s.durationMode)) throw bad("durationMode");
  if (!Number.isInteger(s.frames) || s.frames < MIN_FRAMES || s.frames > MAX_FRAMES || (s.frames - 5) % 17 !== 0) throw bad("frames");
  if (!QUALITY_OPTIONS.includes(s.megapixels)) throw bad("megapixels");
  if (!STEP_OPTIONS.includes(s.steps)) throw bad("steps");
  if (typeof s.sound !== "boolean" || typeof s.turbo !== "boolean") throw bad("sound");
  if (!TURBO_STEPS.includes(s.turboSteps)) throw bad("turboSteps");
  if (typeof s.turboStrength !== "number" || s.turboStrength < 0.5 || s.turboStrength > 1) throw bad("turboStrength");
  if (s.promptStyle !== "original" && !STYLES.some((x) => x.id === s.promptStyle)) throw bad("promptStyle");
  if (typeof s.start !== "number" || !Number.isFinite(s.start) || s.start < 0 || s.start > 86400) throw bad("start");
  s.start = Math.floor(s.start * FPS + 0.5) / FPS;
  for (const k of ["characterNotes", "instructions"]) {
    if (typeof s[k] !== "string" || s[k].length > 3000) throw bad(k);
    s[k] = s[k].trim();
  }
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 2 ** 53 - 1) throw bad("seed");
  return s;
}

/**
 * How many frames this request makes from a source of `duration` seconds. "preset" must fit (it is refused, never cut
 * short); "full" and "range" take what is there from the start (up to `end` for a range), capped at the model's
 * limit and snapped down to 17k+5 — the result says how much was left out so the UI can show it.
 */
export function resolveFrames(s, duration, end = null) {
  const until = end === null ? duration : Math.min(end, duration);
  const available = Math.floor((until - s.start) * FPS + 1e-8);
  if (s.durationMode === "preset") {
    if (s.start + s.frames / FPS > duration + 0.035) throw new AppError("VALIDATION", "err.videoTooShort", { need: Math.round((s.start + s.frames / FPS) * 10) / 10, have: Math.round(duration * 10) / 10 });
    return { frames: s.frames, leftOut: 0 };
  }
  if (available < MIN_FRAMES) throw new AppError("VALIDATION", "err.videoSegmentShort");
  const frames = snapFrames(Math.min(MAX_FRAMES, available));
  return { frames, leftOut: Math.max(0, (available - frames) / FPS) };
}

/** The output size: the source's ratio at the chosen megapixels, multiples of 32. */
export function outputDimensions(width, height, megapixels) {
  return [Math.max(32, Math.round(Math.sqrt(megapixels * 1024 * 1024 * width / height) / 32) * 32),
    Math.max(32, Math.round(Math.sqrt(megapixels * 1024 * 1024 * height / width) / 32) * 32)];
}

/** The structured prompt the model reads (subject definitions, summary, what to keep, the shot, the sound). */
export function buildPrompt({ promptStyle, characterNotes, instructions, sound }, refCount) {
  const style = STYLES.find((x) => x.id === promptStyle) || STYLES[0];
  const definitions = ["<Subject 1> is the character depicted in <Picture 1>. Its identity, facial structure, hairstyle, body proportions and visible outfit define the replacement character."];
  if (characterNotes) definitions[0] += ` Character details: ${characterNotes}`;
  if (refCount > 1) {
    const extra = Array.from({ length: refCount - 1 }, (_, i) => `<Picture ${i + 2}>`).join(", ");
    definitions.push(`${extra} provide additional views of the same <Subject 1>, clarifying identity and facial details. <Picture 1> defines the primary outfit and body appearance.`);
  }
  definitions.push("<Video 1> is the source clip to edit. It defines the original environment, lighting, camera framing and movement, and the visible performer's action and timing.");
  const retention = [
    "<Subject 1>: attribute_transfer - transfer the reference identity and visible outfit to the source performer consistently throughout the selected segment.",
    "<Video 1>: partially_preserved - retain the environment, background objects, camera, framing, timing, performance and interactions. Replace the source performer's visual identity and outfit with those of <Subject 1>.",
  ];
  if (sound) {
    definitions.push("<Audio 1> is the synchronized source soundtrack. When the visible performer speaks or sings, that performance belongs to <Subject 1> (S1).");
    retention.push("<Audio 1>: fully_copy - reuse the complete source soundtrack at its original timing.");
  }
  const kind = `video editing + reference generation${sound ? " + audio reuse" : ""}`;
  let detail = `${style.prompt}\n[Shot 1] From the opening frame, <Subject 1> occupies the source performer's place and follows the same pose, trajectory, gestures, head turns, gaze and facial expressions at the corresponding moments in <Video 1>. Keep its identity and outfit consistent throughout the selected segment. Follow the source framing and camera path, preserving the surrounding scene.`;
  detail += sound
    ? " During visible speech or singing, align <Subject 1>'s mouth movements and pauses with the corresponding original performance in <Audio 1>. Other voices and background music retain their original off-screen role."
    : " Follow visible mouth movement and facial expressions from <Video 1>.";
  if (instructions) detail += `\nScene direction: ${instructions}`;
  return [
    `subject_definitions:\n${definitions.join("\n")}`,
    `summary:\n[${kind}] The target video is an edited version of <Video 1>. Replace the visible performer with <Subject 1> throughout the selected segment, retaining the original scene and performance timing.`,
    `retention_analysis:\n${retention.join("\n")}`,
    `detailed_description:\n${detail}`,
    `overall_soundscape:\n${sound ? "Reuse the original ambience and physical sounds from <Audio 1> wherever they occur in the source." : "N/A"}`,
    `non_diegetic_music:\n${sound ? "Reuse any background score already present in <Audio 1> at its original timing; otherwise there is no added score." : "N/A"}`,
  ].join("\n\n");
}

/**
 * The user's own prompt template, from a ComfyUI workflow they have (API format): the text that feeds the
 * reference-to-video node's prompt and the RegexReplace steps on its way there (in order). Kept in the user's data
 * only — never in the app.
 */
export function extractPromptTemplate(workflow) {
  const nodes = workflow && typeof workflow === "object" && !Array.isArray(workflow.nodes) ? workflow : null;
  if (!nodes) throw new AppError("VALIDATION", "err.videoTemplateFormat");
  const target = Object.values(nodes).find((n) => n?.class_type === "MiniMaxH3ReferenceToVideo");
  if (!target) throw new AppError("VALIDATION", "err.videoTemplateNone");
  const steps = [];
  let link = target.inputs?.prompt;
  for (let guard = 0; guard < 50 && Array.isArray(link); guard++) {
    const n = nodes[link[0]];
    if (!n) break;
    if (n.class_type === "RegexReplace") {
      const { regex_pattern, replace, case_insensitive = true, multiline = false, dotall = false, count = 0 } = n.inputs;
      steps.unshift({ regex_pattern: String(regex_pattern), replace: String(replace), case_insensitive: !!case_insensitive, multiline: !!multiline, dotall: !!dotall, count: Number(count) || 0 });
      link = n.inputs.string;
    } else if (/^Primitive(String|StringMultiline)$/.test(n.class_type)) {
      const text = String(n.inputs.value || "");
      if (!/subject_definitions\s*:/i.test(text)) break;
      return { text, steps };
    } else link = Object.values(n.inputs || {}).find(Array.isArray); // a switch or a reroute: follow its input
  }
  throw new AppError("VALIDATION", "err.videoTemplateNone");
}

/** The user's template with this request's references, sound and notes (as the original studio fills it). */
export function templatePrompt(text, { characterNotes, instructions, sound }, refCount) {
  let prompt = text;
  if (refCount > 1) {
    const refs = Array.from({ length: refCount - 1 }, (_, i) => `<Picture ${i + 2}>`).join(", ");
    const note = `${refs} show additional views of the same <Subject 1>, not additional people. Use these only to clarify identity and facial details. <Picture 1> remains the primary reference for outfit and body appearance.\n`;
    prompt = prompt.replace("<Video 1> is the source clip;", `${note}<Video 1> is the source clip;`);
  }
  if (!sound) {
    prompt = prompt.split("\n").filter((l) => !l.startsWith("<Audio 1>")).join("\n")
      .replace(" Match the timing of mouth movement to the visible performer and the original speech or singing in <Audio 1>.", "")
      .replace(" Do not invent dialogue or add mouth movements for background music or off-screen voices.", "")
      .replace("Natural ambience and physical sounds matching the source clip. No invented dialogue.", "N/A");
  }
  const notes = [];
  if (characterNotes) notes.push(`User-specified character details: ${characterNotes}`);
  if (instructions) notes.push(`Additional user direction: ${instructions}`);
  if (notes.length) prompt = prompt.replace("\n\noverall_soundscape:", `\n${notes.join("\n")}\n\noverall_soundscape:`);
  return prompt;
}

/**
 * The generation graph: the cut source (`video`, a file in the engine's input folder, exactly `frames` frames at 24 fps,
 * `width`×`height`), 1–3 reference images, the settings. The person in the source is found (SAM 3.1) and inverted
 * into a small motion guide; MiniMax H3 makes the new video with the source's sound.
 */
export function buildGenerateGraph({ video, images, frames, width, height, hasAudio, settings, prefix, template = null }) {
  const s = generateSettings(settings);
  if (!images?.length || images.length > MAX_REFS) throw new AppError("VALIDATION", "err.videoRefs");
  const sound = s.sound && hasAudio;
  const [w, h] = outputDimensions(width, height, s.megapixels);
  const g = {};
  const node = (id, class_type, inputs) => { g[id] = { class_type, inputs }; };
  node("1", "LoadVideo", { file: video });
  node("2", "GetVideoComponents", { video: ["1", 0] });
  // The motion guide: the source with the person inverted, at 0.15 MP.
  node("3", "CheckpointLoaderSimple", { ckpt_name: MODELS.sam });
  node("4", "CLIPTextEncode", { text: "person", clip: ["3", 1] });
  node("5", "SAM3_Detect", { threshold: 0.5, refine_iterations: 2, individual_masks: false, model: ["3", 0], image: ["2", 0], conditioning: ["4", 0] });
  node("6", "ImageInvert", { image: ["2", 0] });
  node("7", "ImageCompositeMasked", { x: 0, y: 0, resize_source: false, destination: ["2", 0], source: ["6", 0], mask: ["5", 0] });
  node("8", "ImageScaleToTotalPixels", { upscale_method: "nearest-exact", megapixels: 0.15, resolution_steps: 1, image: ["7", 0] });
  // The models.
  node("10", "UNETLoader", { unet_name: MODELS.unet, weight_dtype: "default" });
  node("11", "CLIPLoader", { clip_name: MODELS.clip, type: "minimax", device: "default" });
  node("12", "VAELoader", { vae_name: MODELS.vae });
  node("13", "VAELoader", { vae_name: MODELS.audioVae });
  let model = ["10", 0];
  if (s.turbo) { node("30", "LoraLoaderModelOnly", { model, lora_name: MODELS.turbo, strength_model: s.turboStrength }); model = ["30", 0]; }
  // The references and the source's sound.
  images.forEach((img, i) => node(String(14 + i), "LoadImage", { image: img }));
  if (sound) node("17", "AudioAdjustVolume", { volume: 0, audio: ["2", 1] });
  // The prompt: the helper's own text, or the user's template through its own regex steps (ComfyUI's RegexReplace).
  let prompt, promptIn;
  if (s.promptStyle === "original") {
    if (!template?.text) throw new AppError("VALIDATION", "err.videoNoTemplate");
    prompt = templatePrompt(template.text, { ...s, sound }, images.length);
    promptIn = prompt;
    template.steps.forEach((st, i) => { node(String(40 + i), "RegexReplace", { ...st, string: promptIn }); promptIn = [String(40 + i), 0]; });
  } else promptIn = prompt = buildPrompt({ ...s, sound }, images.length);
  const ref = {
    prompt: promptIn, width: w, height: h, length: frames, ref_image_size: "match",
    clip: ["11", 0], vae: ["12", 0], audio_vae: ["13", 0], "ref_videos.ref_video_0": ["8", 0],
    ...Object.fromEntries(images.map((_, i) => [`ref_images.ref_image_${i}`, [String(14 + i), 0]])),
    ...(sound ? { "ref_audios.ref_audio_0": ["17", 0] } : {}),
  };
  node("20", "MiniMaxH3ReferenceToVideo", ref);
  node("21", "BasicGuider", { model, conditioning: ["20", 0] });
  node("22", "RandomNoise", { noise_seed: s.seed });
  node("23", "KSamplerSelect", { sampler_name: "res_multistep" });
  node("24", "BasicScheduler", { scheduler: "simple", steps: s.turbo ? s.turboSteps : s.steps, denoise: 1, model });
  node("25", "SamplerCustomAdvanced", { noise: ["22", 0], guider: ["21", 0], sampler: ["23", 0], sigmas: ["24", 0], latent_image: ["20", 1] });
  node("26", "MontajFreeModels", { value: ["25", 0] }); // the GPU's memory for the decoder
  node("27", "VAEDecode", { samples: ["26", 0], vae: ["12", 0] });
  node("28", "CreateVideo", { fps: FPS, bit_depth: 8, color_space: "sRGB", codec: "none", images: ["27", 0], ...(sound ? { audio: ["17", 0] } : {}) });
  node("29", "SaveVideo", { video: ["28", 0], filename_prefix: prefix, format: "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16 });
  return { graph: g, width: w, height: h, sound, steps: s.turbo ? s.turboSteps : s.steps, prompt };
}

/** The stage each node belongs to (the progress the user sees). */
export const GENERATE_STAGES = { 1: "source", 2: "source", 3: "load", 4: "findPerson", 5: "findPerson", 6: "guide", 7: "guide", 8: "guide",
  10: "load", 11: "load", 12: "load", 13: "load", 30: "load", 14: "refs", 15: "refs", 16: "refs", 17: "source", 20: "prepare", 21: "prepare",
  24: "prepare", 25: "generate", 26: "decode", 27: "decode", 28: "save", 29: "save" };

/** The enhancement settings, checked. */
export function enhanceSettings(raw = {}) {
  const unknown = Object.keys(raw).filter((k) => !(k in ENHANCE_DEFAULTS));
  if (unknown.length) throw bad(unknown[0]);
  const s = { ...ENHANCE_DEFAULTS, ...raw };
  const options = { shortEdge: [1080, 1440, 2160], chunkFrames: [0, 9, 17, 33], tileSize: [512, 768, 1024], crf: [16, 18, 20] };
  for (const [k, o] of Object.entries(options)) if (!o.includes(s[k])) throw bad(k);
  if (typeof s.strength !== "number" || s.strength < 0.25 || s.strength > 1) throw bad("strength");
  if (!["lab", "wavelet", "adain", "none"].includes(s.color)) throw bad("color");
  if (typeof s.sound !== "boolean") throw bad("sound");
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 4294967295) throw bad("seed");
  return s;
}

/** The enhanced size: the short edge at the chosen size, even sides, the source's ratio, at most 10 MP. */
export function enhanceDimensions(width, height, shortEdge) {
  if (!(width > 0 && height > 0)) throw bad("dimensions");
  const scale = shortEdge / Math.min(width, height);
  const w = Math.max(2, Math.round(width * scale / 2) * 2), h = Math.max(2, Math.round(height * scale / 2) * 2);
  if (Math.max(w, h) > 8192 || w * h > 10_000_000) throw new AppError("VALIDATION", "err.videoEnhanceTooBig");
  return [w, h];
}

/** The quality enhancement graph (SeedVR2): the result upscaled, blended with the original by `strength`. */
export function buildEnhanceGraph({ video, width, height, hasAudio, settings, prefix }) {
  const s = enhanceSettings(settings);
  const [w, h] = enhanceDimensions(width, height, s.shortEdge);
  const g = {};
  const node = (id, class_type, inputs) => { g[id] = { class_type, inputs }; };
  node("1", "LoadVideo", { file: video });
  node("2", "GetVideoComponents", { video: ["1", 0] });
  node("3", "ResizeImageMaskNode", { input: ["2", 0], scale_method: "lanczos", resize_type: "scale dimensions", "resize_type.width": w, "resize_type.height": h, "resize_type.crop": "disabled" });
  node("4", "SeedVR2Preprocess", { resized_images: ["3", 0] });
  node("5", "UNETLoader", { unet_name: MODELS.seedvr, weight_dtype: "default" });
  node("6", "VAELoader", { vae_name: MODELS.seedvrVae });
  node("7", "VAEEncodeTiled", { pixels: ["4", 0], vae: ["6", 0], tile_size: s.tileSize, overlap: 128, temporal_size: 16, temporal_overlap: 4 });
  node("8", "SeedVR2TemporalChunk", { latent: ["7", 0], temporal_overlap: 1, ...(s.chunkFrames ? { chunking_mode: "manual", "chunking_mode.frames_per_chunk": s.chunkFrames } : { chunking_mode: "auto" }) });
  node("9", "SeedVR2Conditioning", { model: ["5", 0], vae_conditioning: ["8", 0] });
  node("10", "KSampler", { model: ["5", 0], seed: s.seed, steps: 1, cfg: 1.0, sampler_name: "euler", scheduler: "simple", positive: ["9", 0], negative: ["9", 1], latent_image: ["8", 0], denoise: 1.0 });
  node("11", "SeedVR2TemporalMerge", { latents: ["10", 0], temporal_overlap: ["8", 1] });
  node("12", "VAEDecodeTiled", { samples: ["11", 0], vae: ["6", 0], tile_size: s.tileSize, overlap: 128, temporal_size: 16, temporal_overlap: 4 });
  node("13", "SeedVR2PostProcessing", { images: ["12", 0], original_resized_images: ["3", 0], color_correction_method: s.color });
  node("14", "ImageBlend", { image1: ["3", 0], image2: ["13", 0], blend_factor: s.strength, blend_mode: "normal" });
  node("15", "CreateVideo", { images: ["14", 0], fps: ["2", 2], bit_depth: 8, color_space: "sRGB", codec: "none", ...(s.sound && hasAudio ? { audio: ["2", 1] } : {}) });
  node("16", "SaveVideo", { video: ["15", 0], filename_prefix: prefix, format: "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": s.crf });
  return { graph: g, width: w, height: h };
}

/** The order stages are shown in: a stage never goes back (models load as each node needs them). */
export const GENERATE_ORDER = ["queued", "waitExport", "waitQueue", "cut", "engine", "load", "source", "refs", "findPerson", "guide", "prepare", "generate", "decode", "save"];
export const ENHANCE_ORDER = ["queued", "waitExport", "waitQueue", "engine", "load", "source", "prepare", "encode", "enhance", "decode", "save"];

export const ENHANCE_STAGES = { 1: "source", 2: "source", 3: "prepare", 4: "prepare", 5: "load", 6: "load", 7: "encode", 8: "encode", 9: "encode",
  10: "enhance", 11: "decode", 12: "decode", 13: "decode", 14: "decode", 15: "save", 16: "save" };
