// What the music engine needs, from its official sources (pinned, SHA-256 checked): the runtime (portable Python,
// ComfyUI) and the models of each music path. Sizes and licences are shown in the model manager before anything is
// downloaded. The hashes of the ACE-Step files are the ones the Hugging Face repository publishes (git LFS oid).
const HF = "https://huggingface.co";

export const COMFYUI = {
  version: "0.40.0",
  url: "https://codeload.github.com/Comfy-Org/ComfyUI/zip/refs/tags/v0.40.0",
  sha256: "98fb2a3341a8e9e8c77954606f18f04cd5acb856ec86a7d0fc9b2b4f8d51b2f7",
  size: 13_372_834,
  root: "ComfyUI-0.40.0",
  license: "GPL-3.0 (a separate program the app starts; not linked into it)",
};

export const PYTHON312 = {
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-x86_64-pc-windows-msvc-install_only.tar.gz",
  sha256: "194c8f0d9e0de6f1c4576e5dfa67819a48c764be87608b74b8ad43387a57b93b",
  size: 46_352_482,
};

/**
 * torch's CUDA 12.8 wheels, fetched by the app itself (resumable, progress shown, SHA-256 from PyTorch's index) and
 * installed from the local file: pip downloading the 2.75 GB wheel itself showed no progress and stalled.
 */
const PT = "https://download-r2.pytorch.org/whl/cu128";
export const TORCH_WHEELS = [
  { url: `${PT}/torch-2.11.0%2Bcu128-cp312-cp312-win_amd64.whl`, file: "torch-2.11.0+cu128-cp312-cp312-win_amd64.whl", sha256: "7c78215c3af4f62e63f2b2e360f1722fc719b0853c7ac22666483d9810613a4c", size: 2_753_189_216 },
  { url: `${PT}/torchaudio-2.11.0%2Bcu128-cp312-cp312-win_amd64.whl`, file: "torchaudio-2.11.0+cu128-cp312-cp312-win_amd64.whl", sha256: "e0203d44b6dcf4c59f2ce38f997616e663b2a23a9e0b20ebb90ea0c787b5e86a", size: 1_671_595 },
  { url: `${PT}/torchvision-0.26.0%2Bcu128-cp312-cp312-win_amd64.whl`, file: "torchvision-0.26.0+cu128-cp312-cp312-win_amd64.whl", sha256: "8c0d1c4fbb2c9a4d5d41d0aaa87da20e525bcb2a154ce405725b0be59456804b", size: 9_585_013 },
];

/** The runtime on disk besides the models (torch with CUDA, ComfyUI and their packages): 6.3 GB measured after a clean
 * install; the torch wheels (≈2.8 GB) also sit on disk while it installs. */
export const RUNTIME_BYTES = 6_300_000_000;

const ACE_REV = "6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc";
const ace = (sub, file, sha256, size) => ({ url: `${HF}/Comfy-Org/ACE-Step-1.5/resolve/${ACE_REV}/split_files/${sub}/${file}`, file, dir: sub, sha256, size });

/**
 * Model sets, one per engine. `paths` = the music paths that need it. `status` = what the source studio proved:
 * "proven" (a real run made a valid file), "experimental" (works, listening review needed).
 */
export const MODEL_SETS = [
  {
    id: "ace15",
    name: "ACE-Step 1.5 Turbo",
    version: "1.5 turbo (Comfy-Org repack, revision 6707deb)",
    engine: "ACE-Step 1.5 (ComfyUI)",
    paths: ["compose", "inspired"],
    license: "Apache-2.0 (Comfy-Org repack; ACE-Step upstream MIT) · Qwen text encoders Apache-2.0",
    restrictions: "",
    needs: "NVIDIA GPU with 8 GB+ (24 GB recommended), 16 GB RAM",
    source: `${HF}/Comfy-Org/ACE-Step-1.5`,
    status: "proven",
    files: [
      ace("diffusion_models", "acestep_v1.5_turbo.safetensors", "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7", 4_787_825_604),
      ace("text_encoders", "qwen_0.6b_ace15.safetensors", "fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7", 1_191_588_248),
      ace("text_encoders", "qwen_1.7b_ace15.safetensors", "ed63e9247d1f55f3ace04fa11e95b085fc82d459c82c5626f0b2e37b91ebd710", 3_708_523_360),
      ace("vae", "ace_1.5_vae.safetensors", "6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb", 337_431_732),
    ],
  },
  {
    // Easy Cover (re-arrange a song on its own melody). Hashes = the Hugging Face LFS oids at the pinned revisions;
    // Plenio is the GitHub release zip of its v0.7.0 tag (unpacked by the engine on first use, imported as a library).
    id: "yue2cover",
    name: "YuE2 Cover (YuE2 3B + SheetSage2 + instrumental LoRA)",
    version: "YuE2 3B bf16 (Comfy-Org repack 2f76ca7) · LoRA ar_inst_v3abc (947f2f4) · Plenio 0.7.0",
    engine: "YuE2 + SheetSage2 (ComfyUI) · Plenio",
    paths: ["cover"],
    license: "CC BY-NC 4.0 (YuE2, SheetSage2, instrumental LoRA: non-commercial) · Plenio Apache-2.0",
    restrictions: "Non-commercial use only (CC BY-NC 4.0).",
    needs: "NVIDIA GPU with 12 GB+ (24 GB recommended), 16 GB RAM",
    source: `${HF}/Comfy-Org/YuE2`,
    status: "experimental",
    files: [
      { url: `${HF}/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/checkpoints/yue2_3b_bf16.safetensors`, file: "yue2_3b_bf16.safetensors", dir: "checkpoints", sha256: "33765adbf9813c9a50318218760b2fd819a319862460a04884607581961c6fee", size: 7_799_983_228 },
      { url: `${HF}/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/audio_encoders/sheetsage2_bf16.safetensors`, file: "sheetsage2_bf16.safetensors", dir: "audio_encoders", sha256: "5fd960ce3df281e3f3a889d174584d88f96247711480cf96377b12d7e8b6adc5", size: 1_386_868_122 },
      { url: `${HF}/Mothersuperior/YuE2-instrumental-cot-full-loras/resolve/947f2f4b28978b2b6c3e316e6a87925c76bf3c4b/ar_lora_inst_v3abc_comfyui.safetensors`, file: "ar_lora_inst_v3abc_comfyui.safetensors", dir: "loras", sha256: "de6a11d5701df103a191c87dc73115266e2420f3834739319dec5c24d2119f31", size: 212_891_736 },
      { url: "https://codeload.github.com/jplenio/Plenio-Music-Production-System/zip/refs/tags/v0.7.0", file: "plenio-0.7.0.zip", dir: "packages", sha256: "eb6206181ed910681a33bad46c676593954f4ef926c9e2cf9bb049d8ec725af5", size: 39_148_456 },
    ],
  },
];

/** Where the cover engine finds Plenio (the model set's zip) in a models folder. */
export const plenioZip = (modelsDir) => `${modelsDir}/packages/plenio-0.7.0.zip`;

export const modelSet = (id) => MODEL_SETS.find((m) => m.id === id);
export const setBytes = (set) => set.files.reduce((n, f) => n + f.size, 0);
