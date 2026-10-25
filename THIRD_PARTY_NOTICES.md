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

## Installed by the user, not bundled

Local speech recognition and the person cut-out ("text behind the person") run with the user's own Python
(Settings › Providers). These packages are not part of the installer: faster-whisper (MIT) and its Whisper models
(MIT), MediaPipe (Apache 2.0), OpenCV (`opencv-python`, Apache 2.0) and NumPy (BSD-3-Clause).

