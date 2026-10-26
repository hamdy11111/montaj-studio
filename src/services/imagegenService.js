// Images for coverage (B-roll stills, stickers, backgrounds) made locally in the video runtime's ComfyUI, in an engine
// of its own ("imagegen"): Qwen-Image-2.1 Turbo for text→image, edits and transparent (RGBA) stickers, Z-Image-Turbo as
// the fast fallback (imagegen/graphs.js). FLUX 3 Image Klein is not here yet: its weights are gated behind a licence
// click on Hugging Face and it needs ComfyUI 0.41 (the runtime has 0.40) — see HANDOFF.md.
// An optional prompt upsampler runs FIRST and alone (the local LLM, broll/llm.js), then is stopped, then the image
// model loads: they never share the GPU. Every run records its time and the GPU memory it took (nvidia-smi sampled).
// Still-image background removal (a photo → a cutout PNG) uses BiRefNet in the media runtime (imagegen/cutout.py),
// RMBG-2.0's open architecture; RMBG-2.0's own weights are gated.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ComfyEngine } from "./comfyEngine.js";
import { videoRuntime, VIDEO_NODE_PACKAGE } from "./videoSetupService.js";
import { mediaRuntime, runPy } from "./sfxLibrary/mediaRuntime.js";
import { LlamaServer } from "./broll/llm.js";
import { AppError } from "../core/validation.js";
import { qwenGraph, zimageGraph, samDetectGraph, cleanPrompt, sizeFor, MODELS } from "./imagegen/graphs.js";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "imagegen").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const CUTOUT_PY = path.join(HERE, "cutout.py");
const FOLDERS = ["diffusion_models", "text_encoders", "vae", "checkpoints", "loras"];

/** Used GPU memory (MiB) sampled every `everyMs` until stop(): { stop() → { baseMiB, peakMiB, deltaMiB } }. */
export function gpuSampler(everyMs = 500, read = () => {
  const r = spawnSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { windowsHide: true, encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? Number(r.stdout.split("\n")[0]) : null;
}) {
  const base = read();
  let peak = base ?? 0;
  const t = setInterval(() => { const v = read(); if (v != null && v > peak) peak = v; }, everyMs);
  return { stop: () => { clearInterval(t); const v = read(); if (v != null && v > peak) peak = v; return { baseMiB: base, peakMiB: peak, deltaMiB: base == null ? null : peak - base }; } };
}

/** ComfyUI with two model folders: the media models (image models) and the video models (SAM 3.1). */
class ImageEngine extends ComfyEngine {
  constructor(o) { super(o); this.bases = o.bases; }
  modelPathsFile() {
    const f = path.join(this.dir, "model-paths.yaml");
    const q = (p) => JSON.stringify(p.replace(/\\/g, "/"));
    fs.writeFileSync(f, this.bases().map((b, i) => `montaj${i}:\n  base_path: ${q(b)}\n${FOLDERS.map((x) => `  ${x}: ${x}\n`).join("")}`).join(""));
    return f;
  }
}

export class ImagegenService {
  constructor({ paths, gpu = null, log = () => {}, notify = () => {} }) {
    Object.assign(this, { paths, gpu, log, notify });
    this.dir = path.join(paths.root, "imagegen");
    fs.mkdirSync(this.dir, { recursive: true });
    const rt = () => mediaRuntime(paths.root);
    this.engine = new ImageEngine({
      name: "imagegen", dir: this.dir, logs: paths.logs, runtime: () => videoRuntime(paths.root),
      modelsDir: () => path.join(rt()?.models || "", "comfy"), modelFolders: FOLDERS,
      bases: () => { const m = rt()?.models; return [path.join(m, "comfy"), path.join(path.dirname(m), "video")]; },
      nodePackages: [{ name: "montaj_video", src: VIDEO_NODE_PACKAGE }], readyNode: "MontajFreeModels",
      env: { PYTHONNOUSERSITE: "1", CUDA_CACHE_PATH: path.join(this.dir, "cache", "cuda"), TORCH_HOME: path.join(this.dir, "cache", "torch") },
      notify: () => this.notify("imagegen:engine", this.engine.status()),
    });
    this.gpu?.register?.("imagegen", this.engine);
    this.seq = 0;
  }

  /** Which image models are on disk. */
  status() {
    const m = mediaRuntime(this.paths.root)?.models;
    const has = (sub, f) => !!m && fs.existsSync(path.join(m, "comfy", sub, f));
    return {
      engine: this.engine.status(),
      qwen: has("diffusion_models", MODELS.qwen.unet) && has("text_encoders", MODELS.qwen.clip) && has("vae", MODELS.qwen.vae),
      zimage: has("diffusion_models", MODELS.zimage.unet) && has("text_encoders", MODELS.zimage.clip) && has("vae", MODELS.zimage.vae),
      flux3: { available: false, reason: "gated licence on Hugging Face + needs ComfyUI 0.41" },
    };
  }

  async withGpu(id, fn) {
    if (!this.gpu) return fn();
    const release = await this.gpu.acquire("imagegen", id);
    try { return await fn(); } finally { release(); }
  }

  /** The upsampler: a short request → one long English description (the LLM runs alone and is stopped after). */
  async upsample(prompt, { transparent = false } = {}) {
    const llm = new LlamaServer({ runtime: path.dirname(mediaRuntime(this.paths.root).dir), log: this.log, ctx: 4096 });
    try {
      await llm.start();
      const ask = `Rewrite this request as ONE detailed English paragraph (60-120 words) describing the finished photo for an image generator: subject, setting, light, lens, composition, colours. ${transparent ? "The subject is isolated on a transparent background (a sticker)." : ""} Never mention writing, letters, words, calligraphy, logos or what a sign says: any sign or label in the scene is blank. Request: «${prompt}». Answer with the paragraph only.`;
      return (await llm.chat(ask, { maxTokens: 300, temperature: 0.4 })).trim().replace(/^["']|["']$/g, "");
    } finally { llm.stop(); }
  }

  /** Copy inputs into the engine's input folder; returns their names there. */
  stage(files) {
    const dir = path.join(this.dir, "engine-in");
    fs.mkdirSync(dir, { recursive: true });
    return files.map((f, i) => { const name = `montaj-${Date.now()}-${i}${path.extname(f) || ".png"}`; fs.copyFileSync(f, path.join(dir, name)); return name; });
  }

  async run(graph, prefix, { id = `img-${++this.seq}` } = {}) {
    const t0 = Date.now();
    const vram = gpuSampler();
    let started = 0, mem = null;
    try {
      this.engine.checkResources({ ramMB: 8000, vramMB: 9000, diskMB: 2000 });
      await this.engine.start();
      started = Date.now();
      await this.engine.runPrompt(graph, { clientId: id, failKey: "err.imagegenFailed" });
    } finally { mem = vram.stop(); }
    const dir = path.join(this.dir, "engine-out", path.dirname(prefix));
    const base = path.basename(prefix);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}_`) && f.endsWith(".png")).map((f) => path.join(dir, f));
    return { files, seconds: (Date.now() - t0) / 1000, engineStartS: started ? (started - t0) / 1000 : null, vram: mem };
  }

  /**
   * Text → image. model "qwen" (default; the only one with transparency) or "zimage" (fast). width/height: the wanted
   * aspect (made a multiple of 32 at ~1 MP unless `exact`). transparent: a sticker with alpha (qwen only).
   */
  async generate({ prompt, model = "qwen", width = 1024, height = 1024, megapixels = 1, transparent = false, seed = Math.floor(Math.random() * 2 ** 31), upsample = false, keepEngine = false }) {
    if (transparent && model !== "qwen") throw new AppError("VALIDATION", "err.imagegenAlphaQwenOnly");
    let text = prompt, upsampled = null;
    // An Arabic request goes through the upsampler, which writes it in English (a model never sees Arabic letters).
    if (/[؀-ۿ]/.test(prompt)) upsample = true;
    if (upsample) { upsampled = await this.withGpu("imagegen-upsample", () => this.upsample(prompt, { transparent })); text = upsampled; }
    const clean = cleanPrompt(text, { transparent, blankSigns: /[؀-ۿ]/.test(prompt) });
    const size = sizeFor(width, height, megapixels);
    const prefix = `montaj/${model}-${Date.now()}`;
    const g = model === "zimage" ? zimageGraph({ prompt: clean, ...size, seed, prefix }) : qwenGraph({ prompt: clean, ...size, seed, prefix });
    const r = await this.withGpu("imagegen", async () => { try { return await this.run(g, prefix); } finally { if (!keepEngine) this.engine.stop(); } });
    return { ...r, model, prompt: clean, upsampled, seed, ...size };
  }

  /** Edit with Qwen-Image-2.1 (1–10 reference images; the first one sets the size). */
  async edit({ prompt, images, transparent = false, seed = Math.floor(Math.random() * 2 ** 31), keepEngine = false }) {
    if (!images?.length || images.length > 10) throw new AppError("VALIDATION", "err.imagegenRefs");
    const names = this.stage(images);
    const clean = cleanPrompt(prompt, { transparent });
    const prefix = `montaj/edit-${Date.now()}`;
    const g = qwenGraph({ prompt: clean, images: names, seed, prefix });
    const r = await this.withGpu("imagegen-edit", async () => { try { return await this.run(g, prefix); } finally { if (!keepEngine) this.engine.stop(); } });
    return { ...r, model: "qwen", prompt: clean, seed };
  }

  /** A still photo → a cutout PNG with alpha: BiRefNet (fast, ~1 GB), or Qwen-Image-2.1 ("Remove the background"). */
  async removeBackground(image, { out = null, method = "birefnet" } = {}) {
    if (method === "qwen") return this.edit({ prompt: "Remove the background, and output a PNG image", images: [image], transparent: true });
    const rt = mediaRuntime(this.paths.root);
    const dest = out || path.join(this.dir, `cutout-${Date.now()}.png`);
    const r = await this.withGpu("imagegen-cutout", () => runPy(rt, CUTOUT_PY, ["--model", path.join(rt.models, "ZhengPeng7__BiRefNet"), "--out", dest, image]));
    return { files: [dest], ...r };
  }

  /** SAM 3.1 person mask of still images (white = the concept), through this engine. */
  async samMasks(images, { concept = "person", keepEngine = true } = {}) {
    const names = this.stage(images);
    const out = [];
    for (const [i, name] of names.entries()) {
      const prefix = `montaj/sam-${Date.now()}-${i}`;
      const r = await this.run(samDetectGraph({ image: name, concept, prefix }), prefix);
      out.push(r.files[0]);
    }
    if (!keepEngine) this.engine.stop();
    return out;
  }

  stop() { this.engine.stop(); }
}
