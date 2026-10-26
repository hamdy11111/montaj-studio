# Third-party components

Montaj Studio's own source code is MIT-licensed (see `LICENSE`). The Windows installer bundles the components
below, each under its own license. They are separate programs or libraries; their licenses apply to them, not to
Montaj Studio's code.

| Component | Version | License | Where it is in the installer | Source |
|---|---|---|---|---|
| FFmpeg (via `ffmpeg-static`) | 6.1.1 (ffmpeg-static 5.3.0) | **GNU GPL v3 or later** | `resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe`, license text next to it (`ffmpeg.exe.LICENSE`) | https://ffmpeg.org/download.html · build details in `ffmpeg.exe.README` |
| FFprobe (via `ffprobe-static`) | ffprobe-static 3.1.0 | **GNU GPL v3** (the binary); the npm wrapper is MIT | `resources/app.asar.unpacked/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe` | https://ffmpeg.org/download.html |
| Realm JS | 20.2.0 | Apache License 2.0 | `resources/app.asar.unpacked/node_modules/realm` | https://github.com/realm/realm-js |
| MCP TypeScript SDK (`@modelcontextprotocol/sdk`) | 1.32.0 | MIT | `resources/app.asar/node_modules/@modelcontextprotocol/sdk` | https://github.com/modelcontextprotocol/typescript-sdk |
| Ajv (JSON Schema validator) | 8.17.1 | MIT | `resources/app.asar/node_modules/ajv` | https://github.com/ajv-validator/ajv |
| Zod | 4.6.5 | MIT | `resources/app.asar/node_modules/zod` | https://github.com/colinhacks/zod |
| electron-updater (software updates from this project's GitHub releases) | 6.8.11 | MIT | `resources/app.asar/node_modules/electron-updater` | https://github.com/electron-userland/electron-builder |
| Fonts: Cairo, Alexandria, Readex Pro, IBM Plex Sans Arabic, Tajawal, Lalezar, El Messiri, Changa, Noto Kufi Arabic, Baloo Bhaijaan 2, Marhey, Lemonada, Noto Sans Arabic, Almarai, Zain, Kufam, Reem Kufi, Montserrat, Bebas Neue, Anton, Inter, Poppins, Plus Jakarta Sans | Google Fonts (2026-10) | SIL Open Font License 1.1 | `resources/app.asar/src/renderer/assets/fonts/<family>/`, `OFL.txt` in each folder | https://fonts.google.com |
| Fluent Emoji (3D style), 85 images | microsoft/fluentui-emoji | MIT | `resources/app.asar/src/renderer/assets/emoji/` (`LICENSE.txt`) | https://github.com/microsoft/fluentui-emoji |
| Lucide icons, 86 SVG files | lucide-static 1.61.0 | ISC | `resources/app.asar/src/renderer/assets/icons/` (`LICENSE.txt`) | https://lucide.dev |
| Sound effects: ding, click, impact, thud, confirm | Kenney Interface / Impact Sounds | CC0 1.0 (public domain) | `resources/app.asar.unpacked/src/services/audio/sfx/` (`KENNEY-LICENSE.txt`) | https://kenney.nl/assets |
| Sound effects: whoosh, swish, riser, pop, blip, sparkle | made for Montaj Studio (filtered noise and tones) | MIT (this project) | `resources/app.asar.unpacked/src/services/audio/sfx/` | this repository |
| RNNoise speech model «somnolent-hogwash» (`sh.rnnn`), used by FFmpeg's arnndn | GregorR/rnnoise-models (2018-09-01) | not subject to copyright (per its repository) | `resources/app.asar.unpacked/src/services/audio/models/` | https://github.com/GregorR/rnnoise-models |
| MediaPipe Selfie Multiclass segmentation model (`selfie_multiclass_256x256.tflite`, float32) | latest (2026-10) | Apache License 2.0 | `resources/app.asar.unpacked/src/services/vision/models/` (`NOTICE.txt`) | https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter |
| Electron (Chromium, Node.js) | 45.0.0 | MIT (Chromium and Node.js components under their own licenses, listed in `LICENSES.chromium.html` in the install folder) | install folder | https://github.com/electron/electron |

## FFmpeg / FFprobe (GPL v3)

FFmpeg and FFprobe are invoked as separate executables; they are not linked into Montaj Studio. They are distributed
unmodified, as built by the projects above. Their complete corresponding source code is available from
https://ffmpeg.org/download.html (FFmpeg 6.1.1) and from the build pages referenced in `ffmpeg.exe.README`. If you
need the exact source for the binaries shipped in a Montaj Studio release, open an issue in this repository and it
will be provided.

You can use a different FFmpeg build (for example an LGPL build) in Settings › Performance › FFmpeg program.

## Speech engine (downloaded on request, not in the installer)

Settings › Providers › «Download and prepare» (or the prompt on first launch) downloads into the app's data folder:

- **Egyptian Arabic ASR model** `asr-egyptian-nemo-v2.0.nemo` — a NeMo FastConformer hybrid RNNT-CTC model from
  [Janaymn/asr-egyptian-nemo-v2.0](https://huggingface.co/Janaymn/asr-egyptian-nemo-v2.0), **Apache 2.0**
  (pinned revision, SHA-256 checked). It is too large for git; the source tree keeps a copy in
  `src/services/asr/models` (ignored by git) for development.
- **Python 3.11** from [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  (PSF License; the build's bundled libraries keep their own licences), SHA-256 checked.
- NVIDIA NeMo (Apache 2.0), PyTorch (BSD-3-Clause) and their dependencies, pinned in
  `src/services/asr/requirements-nemo.txt`, installed from PyPI by pip.

## Dubbing tools (downloaded on request, not in the installer)

The Dub dialog's «Download and prepare» (`src/services/dubSetupService.js`) downloads into the app's data folder
(`runtime/`), each from its own source, pinned and SHA-256 checked where the source publishes a fixed file:

| Component | License | Source |
|---|---|---|
| Chatterbox Multilingual V3 (`t3_mtl23ls_v3`, every dub language; voice cloning, emotion control) and the earlier Chatterbox models; its output carries Resemble AI's imperceptible Perth watermark. The package is pinned to resemble-ai/chatterbox@5de7a54 (the PyPI release has no V3) | MIT | [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox), weights [ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox) |
| Mel-Band RoFormer vocals model `vocals_mel_band_roformer.ckpt` (Kimberley Jensen) | MIT | [KimberleyJensen/Mel-Band-Roformer-Vocal-Model](https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model), fetched by audio-separator |
| audio-separator 0.39.1 | MIT | [nomadkaraoke/python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) |
| sherpa-onnx 2.0.0 (speaker diarization) | Apache 2.0 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) |
| pyannote segmentation 3.0 (ONNX export) | MIT | [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), via sherpa-onnx's releases |
| NVIDIA NeMo TitaNet large speaker embeddings (ONNX export) | CC-BY-4.0 | [nvidia/speakerverification_en_titanet_large](https://huggingface.co/nvidia/speakerverification_en_titanet_large), via sherpa-onnx's releases |
| Voice gender classifier (ECAPA-TDNN); `src/services/dub/ecapa_gender.py` is its model code, vendored | MIT | [JaesungHuh/voice-gender-classifier](https://huggingface.co/JaesungHuh/voice-gender-classifier) |
| Adult/child voice classifier | Apache 2.0 | [bookbot/wav2vec2-xls-r-adult-child-cls](https://huggingface.co/bookbot/wav2vec2-xls-r-adult-child-cls) |
| faster-whisper 1.2.1 and Whisper small / large-v3 (language check, hearing each dubbed line back) | MIT | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| llama.cpp b11870 (`llama-server`, the local translator's runtime) | MIT | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) |
| Qwen3.5-35B-A3B, Q4_K_M GGUF (translation) | Apache 2.0 | [Qwen](https://huggingface.co/Qwen), GGUF by [unsloth/Qwen3.5-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF) (pinned revision) |
| PyTorch, transformers, librosa and the other pinned packages of `src/services/dub/requirements-dub.txt` and `requirements-sep.txt` | their own (BSD, Apache 2.0, MIT, ISC) | PyPI, PyTorch's wheel index |

TitaNet (CC-BY-4.0): © NVIDIA, used unmodified as published by sherpa-onnx.

## Music studio (downloaded or imported on request, not in the installer)

The Music studio's «Models and requirements» (`src/services/musicSetupService.js`, catalog in
`src/services/music/catalog.js`) puts these in the app's data folder (the models folder is the user's choice), each
from its own source and checked by SHA-256. The engine is started by the app only when the user asks.

| Component | License | Source |
|---|---|---|
| ComfyUI 0.40.0 (the engine the app starts as a separate program; not linked into the app) | GPL-3.0 | [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) tag v0.40.0 |
| Python 3.12.15 (python-build-standalone 20261009) | PSF License | [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone) |
| PyTorch 2.11.0 + torchaudio + torchvision (CUDA 12.8) | BSD-3-Clause | download.pytorch.org |
| The pinned packages of `src/services/music/requirements-music.txt` | their own (MIT, BSD, Apache-2.0, …) | PyPI |
| ACE-Step 1.5 Turbo, Qwen 0.6B/1.7B ACE text encoders, ACE 1.5 VAE (Comfy-Org repack) | Apache-2.0 (upstream ACE-Step MIT; Qwen Apache-2.0) | [Comfy-Org/ACE-Step-1.5](https://huggingface.co/Comfy-Org/ACE-Step-1.5) (revision 6707deb) |

The music nodes in `src/services/music/engine/montaj_music` are ported from the author's AI Creative Studio (Music Rework
Studio V3: the composition plan and presets, the timbre-only reference adapter, the fixed-loudness export).

## Video studio (downloaded or imported on request, not in the installer)

«توليد الفيديو» — the video studio's «Models and requirements» (`src/services/videoSetupService.js`, catalog in
`src/services/video/catalog.js`) puts these in the app's data folder (the models folder is the user's choice), each
from its own source at a pinned revision and checked by SHA-256. Its environment is separate from the music studio's.
The engine is started by the app only when the user asks. The MiniMax H3 models are used only after the user accepts
their licence in the model manager.

| Component | License | Source |
|---|---|---|
| ComfyUI 0.40.0 (the engine the app starts as a separate program; not linked into the app) | GPL-3.0 | [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) tag v0.40.0 |
| Python 3.12.15 (python-build-standalone 20261009, shared with the music studio) | PSF License | [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone) |
| PyTorch 2.11.0 + torchaudio + torchvision (CUDA 13.0) | BSD-3-Clause | download.pytorch.org |
| The pinned packages of `src/services/video/requirements-video.txt` | their own (MIT, BSD, Apache-2.0, …) | PyPI |
| MiniMax H3 reference-to-video: diffusion model (INT8), Qwen3-VL 32B text encoder (NVFP4), video and audio VAEs, Turbo LoRA (Comfy-Org repack) | MiniMax H3 Community License — not for use in the EU, the UK, South Korea or the US; companies above USD 20M yearly revenue need MiniMax's written permission; interfaces built on it show «MiniMax H3»; Acceptable Use Policy | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) (revision e5eb578), licence: [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) |
| SAM 3.1 multiplex (FP16) | SAM License (Meta) | [Comfy-Org/sam3.1](https://huggingface.co/Comfy-Org/sam3.1) (revision 7bb8374) |
| SeedVR2 3B (INT8) and its VAE | Apache-2.0 | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2) (revision df48879) |

No third-party ComfyUI node packages are used: the graphs use ComfyUI's own nodes and the app's `montaj_video` package.
The video studio's rules and its description helper (scenes, styles, extra attention) are ported from the author's
H3 Studio; the prompt is the helper's own structured text.

## Installed by the user, not bundled

Local speech recognition and the person cut-out ("text behind the person") run with the user's own Python
(Settings › Providers). These packages are not part of the installer: faster-whisper (MIT) and its Whisper models
(MIT), MediaPipe (Apache 2.0), OpenCV (`opencv-python`, Apache 2.0) and NumPy (BSD-3-Clause).


## Graphics layer (phase 3: Remotion graphics, VFX library)

Bundled in the installer (the prebuilt graphics bundle `src/graphics/build/remotion`, the editor's Player module
`src/renderer/js/editor/graphicsPlayer.js`, and the renderer):

| Component | Version | License | Where | Source |
|---|---|---|---|---|
| Remotion (`remotion`, `@remotion/renderer`, `@remotion/player`, `@remotion/bundler` at build time, `@remotion/gsap`, `@remotion/rough-notation`, `@remotion/motion-blur`, `@remotion/transitions`, `@remotion/paths`, `@remotion/shapes`, `@remotion/lottie`, `@remotion/animated-emoji`, `@remotion/fonts`, `@remotion/layout-utils`, `@remotion/noise`) | 4.0.538 | **Remotion License** — free for individuals and companies of up to 3 people (this app is for personal use); larger companies need a company license | `node_modules/@remotion/*`, the bundles above | https://www.remotion.dev/license |
| Remotion compositor (`@remotion/compositor-win32-x64-msvc`, includes an FFmpeg build) | 4.0.538 | Remotion License; its FFmpeg under the LGPL/GPL terms stated in the package | `resources/app.asar.unpacked/node_modules/@remotion/compositor-win32-x64-msvc` | https://github.com/remotion-dev/remotion |
| React, React DOM | 18.3.1 | MIT | inside the bundles | https://react.dev |
| GSAP | 3.15.0 | GSAP Standard "no charge" License (free, including commercial use) | inside the bundles | https://gsap.com/standard-license |
| lottie-web | 5.13.0 | MIT | inside the bundles | https://github.com/airbnb/lottie-web |
| Rough.js (via `@remotion/rough-notation`) | 4.6.6 | MIT | inside the bundles | https://github.com/rough-stuff/rough |

Downloaded on request, not in the installer (`npm run setup:graphics` or the app's graphics setup):

| Item | License | Where | Source |
|---|---|---|---|
| Chrome Headless Shell 157.0.8080.0 (win64, ~280 MB unpacked) — the browser Remotion renders with | Chromium / Chrome for Testing terms (BSD-style, third-party notices inside its folder) | `runtime/remotion/chrome-headless-shell-157.0.8080.0/` | https://storage.googleapis.com/chrome-for-testing-public/ |

The asset library lives outside the app and git (`D:\capcut new\assets-library`):

| Item | License | Where | Source |
|---|---|---|---|
| Noto Animated Emoji, 80 Lottie files | CC BY 4.0 (Google) — credit "Animated emoji: Noto Emoji Animation by Google, CC BY 4.0" | `assets-library/emoji/noto-lottie/` | https://googlefonts.github.io/noto-emoji-animation/ |
| Noto Animated Emoji as transparent video, 30 files | CC BY 4.0 (Google) | `assets-library/emoji/animated-webm/` | https://github.com/remotion-dev/animated-emoji |
| VFX/overlay clips (smoke, fire, sparks, light leaks, ink, bubbles…), 46 clips | Mixkit Stock Video Free License (each clip's licence — Free or Restricted — is in `vfx/index.json`) | `assets-library/vfx/<category>/` | https://mixkit.co/license/#videoFree |

## Phase 10 — Easy Cover (music studio)

Downloaded on request by the music studio's model manager (or imported from a folder), into the music models folder;
never in the installer or in git. Each file is pinned to a revision and checked by its SHA-256.

| Item | License | Where | Source |
|---|---|---|---|
| YuE2 3B bf16 (`checkpoints/yue2_3b_bf16.safetensors`, 7.8 GB) | CC BY-NC 4.0 — non-commercial | `<models>/checkpoints` | https://huggingface.co/Comfy-Org/YuE2 (revision 2f76ca7) |
| SheetSage2 bf16 (`audio_encoders/sheetsage2_bf16.safetensors`, 1.4 GB) | CC BY-NC 4.0 — non-commercial | `<models>/audio_encoders` | https://huggingface.co/Comfy-Org/YuE2 (revision 2f76ca7) |
| YuE2 instrumental LoRA `ar_lora_inst_v3abc_comfyui.safetensors` (0.2 GB) | CC BY-NC 4.0 — non-commercial | `<models>/loras` | https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras (revision 947f2f4) |
| Plenio Music Production System 0.7.0 (its `plenio` Python package: SheetSage2 transcription grid, ABC score rules) | Apache-2.0 (Johannes Plenio) | `<models>/packages/plenio-0.7.0.zip`, unpacked beside it | https://github.com/jplenio/Plenio-Music-Production-System (tag v0.7.0) |

The 27 arranging styles (`src/services/music/engine/montaj_music/cover_presets.json`) are the user's own Music Rework
Studio V3 recipes, compacted.
