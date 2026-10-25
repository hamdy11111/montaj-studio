// What the video engine needs, from its official sources (pinned revisions, SHA-256 checked): the runtime (the shared
// portable Python and ComfyUI release, torch's CUDA 13.0 build) and the model sets. Sizes, licences and sources are
// shown in the model manager before anything is downloaded; the MiniMax H3 sets are used only after the user accepts
// their licence there. The hashes are the ones the Hugging Face repositories publish (git LFS oid).
import { COMFYUI, PYTHON312 } from "../music/catalog.js";

export { COMFYUI, PYTHON312 };
const HF = "https://huggingface.co";

/** torch's CUDA 13.0 wheels (the INT8 models' fast kernels in comfy-kitchen need it), fetched by the app itself. */
const PT = "https://download-r2.pytorch.org/whl/cu130";
export const TORCH_INDEX = "https://download.pytorch.org/whl/cu130";
export const TORCH_WHEELS = [
  { url: `${PT}/torch-2.11.0%2Bcu130-cp312-cp312-win_amd64.whl`, file: "torch-2.11.0+cu130-cp312-cp312-win_amd64.whl", sha256: "ef8beae16d781c3244ef28dc7bee6d8871c26bbde65d5bf66e902cb61972c4ab", size: 1_915_224_818 },
  { url: `${PT}/torchaudio-2.11.0%2Bcu130-cp312-cp312-win_amd64.whl`, file: "torchaudio-2.11.0+cu130-cp312-cp312-win_amd64.whl", sha256: "f74949f9ace1e4a6cf9468bdb3211b9cfa0af6ea348125471ac71c8621d6c77d", size: 1_722_734 },
  { url: `${PT}/torchvision-0.26.0%2Bcu130-cp312-cp312-win_amd64.whl`, file: "torchvision-0.26.0+cu130-cp312-cp312-win_amd64.whl", sha256: "a3578f7c8e8a2724306c68c56873a1675fa7ce45471e18235c720a2ed242fe44", size: 8_885_056 },
];

/** CUDA 13.0 needs NVIDIA's R580 driver or newer (and a Turing or newer GPU). */
export const MIN_DRIVER = 580;
/** The runtime on disk besides the models (an estimate until measured after a clean install). */
export const RUNTIME_BYTES = 6_000_000_000;

const H3_REV = "e5eb578a89295337b8ff433a035929ce0279e0b6";
const SAM_REV = "7bb8374780a725b4353ed31f3a9395c9742b5621";
const SEEDVR_REV = "df48879708206a403d2a61acd55578c2e80fd233";
const file = (repo, rev, dir, name, sha256, size) => ({ url: `${HF}/${repo}/resolve/${rev}/${dir}/${name}`, file: name, dir, sha256, size });

const MINIMAX = {
  key: "minimax-h3",
  url: `${HF}/MiniMaxAI/MiniMax-H3/blob/main/LICENSE`,
  summary: "MiniMax H3 Community License: not for use in the EU, the UK, South Korea or the US; companies above USD 20M yearly revenue need MiniMax's written permission; an interface built on it shows «MiniMax H3»; the Acceptable Use Policy applies.",
};

export const MODEL_SETS = [
  {
    id: "h3", name: "MiniMax H3 (Reference → Video)", version: `Comfy-Org repack, revision ${H3_REV.slice(0, 7)}`, engine: "MiniMax H3",
    paths: ["replace"], status: "experimental",
    license: "MiniMax H3 Community License", licenseUrl: MINIMAX.url, accept: MINIMAX, restrictions: MINIMAX.summary,
    needs: "NVIDIA GPU with 24 GB (RTX 4090 class), 64 GB RAM recommended, driver 580+",
    source: `${HF}/Comfy-Org/MiniMax-H3`,
    files: [
      file("Comfy-Org/MiniMax-H3", H3_REV, "diffusion_models", "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779", 20_970_379_616),
      file("Comfy-Org/MiniMax-H3", H3_REV, "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6", 15_687_142_551),
      file("Comfy-Org/MiniMax-H3", H3_REV, "vae", "minimax_h3_video_vae_fp16.safetensors", "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522", 5_207_808_496),
      file("Comfy-Org/MiniMax-H3", H3_REV, "vae", "minimax_h3_audio_vae_fp32.safetensors", "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48", 605_254_808),
    ],
  },
  {
    id: "sam31", name: "SAM 3.1 (finding the person)", version: `Comfy-Org repack, revision ${SAM_REV.slice(0, 7)}`, engine: "SAM 3.1",
    paths: ["replace"], status: "experimental",
    license: "SAM License (Meta)", licenseUrl: `${HF}/Comfy-Org/sam3.1`, restrictions: "Passed on with its licence; no military or weapons use.",
    needs: "Part of video generation", source: `${HF}/Comfy-Org/sam3.1`,
    files: [file("Comfy-Org/sam3.1", SAM_REV, "checkpoints", "sam3.1_multiplex_fp16.safetensors", "9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03", 1_745_546_848)],
  },
  {
    id: "h3turbo", name: "MiniMax H3 Turbo (fast generation, 4–8 steps)", version: "v0.1", engine: "MiniMax H3",
    paths: ["turbo"], status: "experimental", optional: true,
    license: "MiniMax H3 Community License", licenseUrl: MINIMAX.url, accept: MINIMAX, restrictions: MINIMAX.summary,
    needs: "Optional: only for the fast mode", source: `${HF}/Comfy-Org/MiniMax-H3`,
    files: [file("Comfy-Org/MiniMax-H3", H3_REV, "loras", "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "5b9ab5ade15d0775676d01a907268a69a1468dc6033b3b0d3ded5502f3ebb84c", 1_956_193_000)],
  },
  {
    id: "seedvr2", name: "SeedVR2 3B (video quality enhancement)", version: `INT8, revision ${SEEDVR_REV.slice(0, 7)}`, engine: "SeedVR2",
    paths: ["enhance"], status: "experimental",
    license: "Apache-2.0", licenseUrl: `${HF}/Comfy-Org/SeedVR2`, restrictions: "",
    needs: "NVIDIA GPU with 12 GB+ (24 GB for 1440/2160)", source: `${HF}/Comfy-Org/SeedVR2`,
    files: [
      file("Comfy-Org/SeedVR2", SEEDVR_REV, "diffusion_models", "seedvr2_3b_int8_convrot.safetensors", "c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157", 3_458_259_704),
      file("Comfy-Org/SeedVR2", SEEDVR_REV, "vae", "seedvr2_ema_vae_fp16.safetensors", "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1", 501_324_814),
    ],
  },
];

export const modelSet = (id) => MODEL_SETS.find((s) => s.id === id) || null;
