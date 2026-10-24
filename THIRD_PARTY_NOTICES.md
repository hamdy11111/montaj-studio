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
| Fonts: Cairo, Alexandria, Readex Pro, IBM Plex Sans Arabic, Tajawal, Lalezar, El Messiri, Changa, Noto Kufi Arabic, Baloo Bhaijaan 2, Marhey, Lemonada, Montserrat, Bebas Neue, Anton, Inter, Poppins | Google Fonts (2026-10) | SIL Open Font License 1.1 | `resources/app.asar/src/renderer/assets/fonts/<family>/`, `OFL.txt` in each folder | https://fonts.google.com |
| Fluent Emoji (3D style), 85 images | microsoft/fluentui-emoji | MIT | `resources/app.asar/src/renderer/assets/emoji/` (`LICENSE.txt`) | https://github.com/microsoft/fluentui-emoji |
| Lucide icons, 86 SVG files | lucide-static 1.61.0 | ISC | `resources/app.asar/src/renderer/assets/icons/` (`LICENSE.txt`) | https://lucide.dev |
| MediaPipe Selfie Multiclass segmentation model (`selfie_multiclass_256x256.tflite`, float32) | latest (2026-10) | Apache License 2.0 | `resources/app.asar.unpacked/src/services/vision/models/` (`NOTICE.txt`) | https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter |
| Electron (Chromium, Node.js) | 45.0.0 | MIT (Chromium and Node.js components under their own licenses, listed in `LICENSES.chromium.html` in the install folder) | install folder | https://github.com/electron/electron |

## FFmpeg / FFprobe (GPL v3)

FFmpeg and FFprobe are invoked as separate executables; they are not linked into Montaj Studio. They are distributed
unmodified, as built by the projects above. Their complete corresponding source code is available from
https://ffmpeg.org/download.html (FFmpeg 6.1.1) and from the build pages referenced in `ffmpeg.exe.README`. If you
need the exact source for the binaries shipped in a Montaj Studio release, open an issue in this repository and it
will be provided.

You can use a different FFmpeg build (for example an LGPL build) in Settings › Performance › FFmpeg program.

## Installed by the user, not bundled

Local speech recognition and the person cut-out ("text behind the person") run with the user's own Python
(Settings › Providers). These packages are not part of the installer: faster-whisper (MIT) and its Whisper models
(MIT), MediaPipe (Apache 2.0), OpenCV (`opencv-python`, Apache 2.0) and NumPy (BSD-3-Clause).

