// Everything the phase-9 media tools download, with pinned revisions, sizes and licences — the list the HANDOFF and a
// model manager show, and what setupMedia.js fetches. Weights live under runtime/models/media (git-ignored), the
// image models under runtime/models/media/comfy/<folder>. Gated or paid items are listed with why they are not here.
export const MEDIA_MODELS = [
  { id: "clap", repo: "laion/larger_clap_general", rev: "ada0c23a36c4e8582805bb38fec3905903f18b41", bytes: 779_818_459, license: "Apache-2.0", use: "sound library: text → audio search, meaning tags" },
  { id: "siglip2", repo: "google/siglip2-so400m-patch16-naflex", rev: "cc24074f717b612951c2dead130904ab9b65a81e", bytes: 4_581_439_785, license: "Apache-2.0", use: "B-roll: keyframe embeddings (English queries)" },
  { id: "metaclip2", repo: "facebook/metaclip-2-worldwide-huge-quickgelu", rev: "c139061af7b10fdb2e754b60d2b1182a3d5526c2", bytes: 7_514_916_713, license: "CC-BY-NC-4.0", use: "B-roll: keyframe embeddings, native Arabic queries" },
  { id: "qwen3vl-emb", repo: "Qwen/Qwen3-VL-Embedding-2B", rev: "9f2f7e710d6d81056aa5c0a4f04764fec6bb7bda", bytes: 4_271_073_261, license: "Apache-2.0", use: "B-roll: the shot as a video" },
  { id: "qwen3vl-rerank", repo: "Qwen/Qwen3-VL-Reranker-2B", rev: "4bd860ac4f15ad1897a214615cccc700f8f71818", bytes: 4_271_061_541, license: "Apache-2.0", use: "B-roll: reranking the top 30" },
  { id: "bge-m3", repo: "BAAI/bge-m3", rev: "5617a9f61b028005a4858fdac845db406aefb181", bytes: 2_310_424_236, license: "MIT", use: "B-roll: caption text index", allow: ["pytorch_model.bin", "*.json", "sentencepiece.bpe.model", "*.md", "1_Pooling/*"] },
  { id: "qwen35-mmproj", repo: "unsloth/Qwen3.5-35B-A3B-GGUF", rev: "bc014a17be43adabd7066b7a86075ff935c6a4e2", bytes: 899_283_648, license: "Apache-2.0", use: "B-roll captions: the vision projector of the dubbing translator (runtime/models/translate)", allow: ["mmproj-F16.gguf"] },
  { id: "matanyone2", repo: "PeiqingYang/MatAnyone2", rev: "40c894a6f68d1f55c86ab0de838d89dc61587930", bytes: 141_208_798, license: "S-Lab License 1.0 (non-commercial)", use: "person matte" },
  { id: "birefnet", repo: "ZhengPeng7/BiRefNet", rev: "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4", bytes: 444_586_831, license: "MIT", use: "still-image background removal (in place of the gated RMBG-2.0)" },
  { id: "cotracker3", repo: "facebook/cotracker3", rev: "bf55ea50d4390e1820a267f131cd6587240fb2c5", bytes: 203_590_987, license: "CC-BY-NC-4.0", use: "point tracks", allow: ["scaled_offline.pth", "scaled_online.pth", "*.md", "*.json"] },
];

/** ComfyUI single files (Comfy-Org repacks) → runtime/models/media/comfy/<dir>/<name>. */
export const MEDIA_COMFY_FILES = [
  { repo: "Comfy-Org/Qwen-Image-2.1", rev: "0217efd1d9c9452e84f6448903d6e21bfa171ffd", path: "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors", bytes: 7_256_787_829, license: "Qwen Research License (non-commercial)" },
  { repo: "Comfy-Org/Qwen-Image-2.1", rev: "0217efd1d9c9452e84f6448903d6e21bfa171ffd", path: "text_encoders/qwen3vl_8b_int8_convrot.safetensors", bytes: 9_350_798_360, license: "Qwen Research License (non-commercial)" },
  { repo: "Comfy-Org/Qwen-Image-2.1", rev: "0217efd1d9c9452e84f6448903d6e21bfa171ffd", path: "vae/qwen_image_2.1_vae_bf16.safetensors", bytes: 675_509_688, license: "Qwen Research License (non-commercial)" },
  { repo: "Comfy-Org/Z-Image-Turbo", rev: "6fc90a3b1b653e935a0d175e260736de25b84df5", path: "split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors", bytes: 6_201_001_296, license: "Apache-2.0" },
  { repo: "Comfy-Org/Z-Image-Turbo", rev: "6fc90a3b1b653e935a0d175e260736de25b84df5", path: "split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors", bytes: 5_631_994_051, license: "Apache-2.0" },
  { repo: "Comfy-Org/Z-Image-Turbo", rev: "6fc90a3b1b653e935a0d175e260736de25b84df5", path: "split_files/vae/ae.safetensors", bytes: 335_304_388, license: "Apache-2.0" },
];

/** Code that is not on PyPI, unpacked under runtime/media/src and put on the path by a .pth file. */
export const MEDIA_SOURCES = [
  { name: "MatAnyone2", url: "https://github.com/pq-yang/MatAnyone2/archive/0079197acd6d16a741f71558809c06c586c579e0.zip", license: "S-Lab License 1.0 (non-commercial)" },
  { name: "co-tracker", url: "https://github.com/facebookresearch/co-tracker/archive/82e02e8029753ad4ef13cf06be7f4fc5facdda4d.zip", license: "CC-BY-NC-4.0" },
];

/** Not downloaded, and why (the user can provide them). */
export const MEDIA_NOT_FETCHED = [
  { name: "FLUX 3 Image Klein (INT8 ComfyUI build + prompt upsampler)", why: "black-forest-labs/flux-3-image-klein-comfy is gated (accept the FLUX Kommunity License with a Hugging Face login) and needs ComfyUI 0.41; the video runtime has 0.40" },
  { name: "RMBG-2.0", why: "briaai/RMBG-2.0 is gated (licence form); BiRefNet (MIT), its architecture, is used instead" },
  { name: "VideoMaMa", why: "SammyLim/VideoMaMa (6.1 GB UNet, Stability Community License, code CC-BY-NC) + stable-video-diffusion-img2vid-xt; not installed in this pass — see HANDOFF" },
  { name: "TAPNext", why: "not installed: CoTracker3 covers the point tracks" },
  { name: "Freesound", why: "its API needs a personal key" },
  { name: "Pixabay sound effects", why: "the site refuses scripted downloads (HTTP 403 behind a browser check); download by hand and use import folder" },
  { name: "BOOM Toons, Sonniss, ProductionCrate", why: "paid or sign-up: the user's own packs, indexed in place with import folder" },
];
