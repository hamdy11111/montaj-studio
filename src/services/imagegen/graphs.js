// ComfyUI workflows (API format) of the image tools, after Comfy-Org's own templates (workflow_templates:
// image_qwen_image_2_1_turbo_t2i / _turbo_image_edit / _background_removal, image_z_image_turbo):
//   qwen   Qwen-Image-2.1 Turbo INT8 (ConvRot), 8 steps, cfg 1 — text→image, edits with up to 10 reference images, and
//          native transparency: its VAE is RGBA, so a prompt that asks for "an RGBA image with an alpha channel and a
//          transparent background" decodes straight to a PNG with alpha (a sticker over the video), no matting.
//   zimage Z-Image-Turbo INT8, 8 steps, cfg 1 — the fast fallback for plain coverage images.
// No Arabic text is ever drawn by a model (no open model writes correct Arabic): prompts are cleaned of Arabic script
// and every image is asked for "no text, no letters"; Arabic words go on top as real text in the graphics layer.

export const MODELS = {
  qwen: { unet: "qwen_image_2.1_turbo_int8_convrot.safetensors", clip: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" },
  zimage: { unet: "z_image_turbo_int8_convrot.safetensors", clip: "qwen_3_4b_fp8_mixed.safetensors", vae: "ae.safetensors" },
};
const QWEN_TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";
export const NO_TEXT = "no text, no letters, no words, no captions, no watermark, no logo";
export const RGBA_PHRASE = "The result is an RGBA image with an alpha channel and a fully transparent background; only the subject is opaque, with clean soft edges.";

/** A prompt the models may receive: no Arabic script (it would come out as fake letters), "no text" asked for. */
export function cleanPrompt(prompt, { transparent = false, allowText = false } = {}) {
  let p = String(prompt || "").replace(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g, " ")
    .replace(/["«»“”']\s*["«»“”']/g, " ").replace(/\s+/g, " ").trim();
  if (!p) throw Object.assign(new Error("empty prompt after removing Arabic text"), { code: "err.imagePromptEmpty" });
  if (transparent && !/alpha channel|transparent background/i.test(p)) p = `${p} ${RGBA_PHRASE}`;
  if (!allowText && !/no text/i.test(p)) p = `${p} ${NO_TEXT}.`;
  return p;
}

/** Sizes a multiple of 32 near the requested aspect at about `mp` megapixels (portrait stays portrait). */
export function sizeFor(width, height, mp = 1.0) {
  const ar = width / height;
  const h = Math.sqrt((mp * 1024 * 1024) / ar), w = h * ar; // megapixels as ComfyUI counts them (1024²)
  const r = (x) => Math.max(256, Math.round(x / 32) * 32);
  return { width: r(w), height: r(h) };
}

const graph = () => {
  const g = {};
  const node = (id, class_type, inputs) => { g[id] = { class_type, inputs }; return [id, 0]; };
  return { g, node };
};

/** Qwen-Image-2.1 Turbo: text→image (no `images`) or an edit of the given images (ComfyUI input file names). */
export function qwenGraph({ prompt, negative = "", width = 1024, height = 1024, seed = 0, images = [], resolution = 1024, prefix = "montaj/img" }) {
  const { g, node } = graph();
  node("1", "UNETLoader", { unet_name: MODELS.qwen.unet, weight_dtype: "default" });
  node("2", "QwenImage21Cache", { model: ["1", 0], device: "auto", dtype: "default" });
  node("3", "CLIPLoader", { clip_name: MODELS.qwen.clip, type: "qwen_image", device: "default" });
  node("4", "VAELoader", { vae_name: MODELS.qwen.vae });
  const enc = { clip: ["3", 0], prompt, negative_prompt: negative, vae: ["4", 0], resolution };
  images.forEach((name, i) => { node(`L${i}`, "LoadImage", { image: name }); enc[`images.image_${i + 1}`] = [`L${i}`, 0]; });
  node("5", "TextEncodeQwenImage21", enc);
  // An edit samples on the first reference's size (another size shifts the edit); text→image on the asked size.
  if (!images.length) node("6", "EmptyLatentImage", { width, height, batch_size: 1 });
  node("7", "CFGGuider", { model: ["2", 0], positive: ["5", 0], negative: ["5", 1], cfg: 1 });
  node("8", "KSamplerSelect", { sampler_name: "euler" });
  node("9", "ManualSigmas", { sigmas: QWEN_TURBO_SIGMAS });
  node("10", "RandomNoise", { noise_seed: seed });
  node("11", "SamplerCustomAdvanced", { noise: ["10", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: images.length ? ["5", 2] : ["6", 0] });
  node("12", "VAEDecode", { samples: ["11", 0], vae: ["4", 0] });
  node("13", "SaveImage", { images: ["12", 0], filename_prefix: prefix });
  return g;
}

/** Z-Image-Turbo text→image (8 steps, res_multistep, shift 3, empty negative). */
export function zimageGraph({ prompt, width = 1024, height = 1024, seed = 0, prefix = "montaj/img" }) {
  const { g, node } = graph();
  node("1", "UNETLoader", { unet_name: MODELS.zimage.unet, weight_dtype: "default" });
  node("2", "ModelSamplingAuraFlow", { model: ["1", 0], shift: 3 });
  node("3", "CLIPLoader", { clip_name: MODELS.zimage.clip, type: "lumina2", device: "default" });
  node("4", "VAELoader", { vae_name: MODELS.zimage.vae });
  node("5", "CLIPTextEncode", { clip: ["3", 0], text: prompt });
  node("6", "ConditioningZeroOut", { conditioning: ["5", 0] });
  node("7", "EmptySD3LatentImage", { width, height, batch_size: 1 });
  node("8", "KSampler", { model: ["2", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed, steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1 });
  node("9", "VAEDecode", { samples: ["8", 0], vae: ["4", 0] });
  node("10", "SaveImage", { images: ["9", 0], filename_prefix: prefix });
  return g;
}

/** SAM 3.1 on still frames: the person mask(s) of each image (the matting pipeline's first-frame masks). */
export function samDetectGraph({ image, concept = "person", threshold = 0.5, prefix = "montaj/sam" }) {
  const { g, node } = graph();
  node("1", "CheckpointLoaderSimple", { ckpt_name: "sam3.1_multiplex_fp16.safetensors" });
  node("2", "LoadImage", { image });
  node("3", "CLIPTextEncode", { clip: ["1", 1], text: concept });
  node("4", "SAM3_Detect", { model: ["1", 0], image: ["2", 0], conditioning: ["3", 0], threshold, refine_iterations: 2, individual_masks: false });
  node("5", "MaskToImage", { mask: ["4", 0] });
  node("6", "SaveImage", { images: ["5", 0], filename_prefix: prefix });
  return g;
}
