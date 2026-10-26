# HANDOFF — `media` (Phase 9 of PLAN_editor_and_graphics.md: section 2 items 6, 7, 8 and section 5 sound effects)

Branch `phase9-media` (worktree `D:\capcut new\worktrees\media`), based on `main` 0fe8ace. Nothing pushed.
Results, A/B images and measurements: `D:\capcut new\montaj-bench\النتائج\media\` (open `index.html`; scripts in `scripts\`).

## What was built (each service usable on its own)

### 1. Sound-effects library — `src/services/sfxLibrary.js`, `src/services/sfxLibrary/`
- **Library on disk** (outside git): `D:\capcut new\assets-library\sfx\` — `files/<source>/…`, `library.json` (every sound:
  source, licence, category, source tags, Egyptian meaning tags, English tags, cartoon/comic flags, duration, peak/RMS,
  accent time), `clap_audio.f32` + `clap_index.json` (CLAP audio embeddings), `clap_meanings.f32`.
  **2,213 sounds, 3.2 GB**: Mixkit 1,729 (Mixkit SFX Free License), Kenney 452 (CC0), @remotion/sfx 32 (meme sounds,
  personal use). Categories: comedy, reactions, drama, kitchen, transitions, impacts, risers, whooshes, ui, magic.
- `sfxLibrary/fetch.js` — fetches the no-account sources, resumable (`node src/services/sfxLibrary/fetch.js <dir>`).
  Freesound skipped (API needs a personal key); Pixabay skipped (HTTP 403 behind a browser check). ~29 Mixkit sounds
  refuse both WAV and MP3 (403) and are left out.
- **Import of the user's own packs** (BOOM Toons, Sonniss, Pixabay/Freesound downloads…): `importFolder(dir, {name})`
  indexes in place (never copies); category from the UCS CatID (`WHSH_…`, `TOON_…`) or folder words; then `index()`.
- **Egyptian meanings** (`sfxLibrary/meaning.js`): 35 tags («تريقة»، «قفشة»، «فضيحة»، «إحراج»، «صدمة»، «يا نهار أبيض»،
  «حركة نص كم»، «هيصة»، «لقطة»، «وقعة»، «وقفة»، «فلوس»…) each with Egyptian alternatives, English CLAP descriptions, a
  mood and a cartoon flag. Every sound is tagged by CLAP zero-shot (scores standardised over the library) plus what its
  source names (Mixkit's "crickets" page → «إحراج»/«ملل»). Requests are expanded: meaning tags, everyday words
  (باب→door, طاسة→pan…), English kept, unknown words handed to an optional translator.
- **Search** (`search(query, {mood, category, recent, exclude})`): standardised CLAP cosine (best description) + a bonus
  for each named meaning the sound carries (by its strength) + category; forbidden sounds for the mood are left out; a
  comic meaning asked in a serious moment returns nothing with `blocked: "comic-in-serious"`. CLAP runs on the CPU for
  queries (persistent worker, ~30–300 ms a query after a ~10 s load).
- **Rules the director calls** (`sfxLibrary/rules.js`, `SFX_TOOLS` + `sfxToolHandlers`): no cartoon/comic sound in
  serious/sad/emotional/religious/tense moments; ≤ 3 comic sounds a minute and ≥ 8 s between them; any two sounds ≥ 1 s
  apart (0.08 s = layered), ≤ 20 a minute (the policy's numbers). `checkSfxPlan` lists violations, `enforceSfxPlan` keeps
  by priority. Two tool definitions (`sfx_search`, `sfx_check_plan`) are ready for the director's LLM.

### 2. B-roll index of the user's own footage — `src/services/brollService.js`, `src/services/broll/`
- `broll/broll.py shots`: one decode (4 fps, 384 px, rotation-correct), colour-histogram cuts with an adaptive threshold,
  long takes split into ≤ 6 s pieces, 4 keyframes per shot. `broll.py embed`: SigLIP2 so400m (keyframes), MetaCLIP 2
  worldwide-huge (keyframes, native Arabic), Qwen3-VL-Embedding-2B (the 4 keyframes as a video), bge-m3 (captions).
  `broll.py serve`: per-index top-100 and Qwen3-VL-Reranker-2B on the top 30.
- Captions by the local VLM (`broll/llm.js`): llama-server + **Qwen3.5-35B-A3B Q4_K_M (the dubbing translator) + its
  mmproj** (0.9 GB, the only addition) — English sentence, Arabic sentence, English and Arabic keywords, shot size.
  Perception has not installed Qwen3.6 (`runtime\models\perception` has no Qwen3.6 GGUF): `findVlm()` switches to it
  automatically when `Qwen3.6-35B-A3B*.gguf` + `mmproj*.gguf` appear there.
- `broll/fusion.js`: RRF (k = 60, Qwen3-VL weight 1.2), reranker blend (0.7 reranker / 0.3 fused rank), diversity
  (neighbouring slices of one take ×0.5) and "used recently" penalty (shot or whole video ×0.65), `evaluate()` (R@k, MRR).
- Test library: the 6 cases read in place → `D:\capcut new\assets-library\broll-index\` (228 shots, 67 MB of keyframes
  and indexes). Test questions: `النتائج\media\broll-queries.json` (30; right answers marked by me — see "needs a test").

### 3. Image generation for coverage — `src/services/imagegenService.js`, `src/services/imagegen/`
- Its own ComfyUI engine ("imagegen") on the video runtime, two model folders (media image models + video models).
- **Qwen-Image-2.1 Turbo INT8** (8 steps, cfg 1): text→image, edits with 1–10 references, **native RGBA stickers**
  (the prompt asks for an alpha channel; PNG with alpha straight from the VAE). **Z-Image-Turbo INT8**: fast fallback.
- Prompt upsampler: the local LLM, run **first and alone**, stopped before the image model loads.
- **No Arabic text drawn by a model**: Arabic script is removed from prompts and "no text, no letters…" is asked.
- `removeBackground(image)`: BiRefNet (MIT, RMBG-2.0's architecture) for stills, or Qwen-Image "Remove the background".
- Every run measures time and GPU memory (nvidia-smi sampled during the job).
- **FLUX 3 Image Klein was not installed**: `black-forest-labs/flux-3-image-klein-comfy` is gated (FLUX Kommunity
  License accepted with a Hugging Face login — not done for the user) and FLUX 3 needs **ComfyUI 0.41** (the video
  runtime has 0.40). Its INT8 file is 5.8 GB + the Qwen3.5-9B prompt upsampler (INT8 9.7 GB). To add: the user accepts
  the licence, the coordinator upgrades ComfyUI, then a `flux3Graph` next to `qwenGraph`.

### 4. Professional matting — `src/services/matteService.js`, `src/services/vision/pro_matte.py`, `track_points.py`, `track_object.py`
- **pro recipe**: SAM 3.1 (concept "person:8", main people only: detections < 15 % of the largest are dropped) gives the
  first-frame mask → MatAnyone2 mattes; SAM runs again at every cut (colour jump) and every 15 frames: IoU < 0.8
  between the matte and SAM's mask = drift → MatAnyone2 restarts from SAM's mask. 720 px short side, mask video with the
  media's timing (same format as the fast matte, so export/preview are unchanged).
- SAM 3.1 runs **in-process through ComfyUI's own code** (`comfy.sd` + `SAM3_Detect.execute`), no server.
- Choice: settings `media.matteQuality` = `auto` (default: pro when installed, but media longer than 5 min stay fast —
  pro runs ~5.5 fps), `pro`, `fast`. A fast matte kept under the pro name is marked (`.fast`) so `pro` remakes it.
  A failed pro run falls back to fast in `auto`. `status()` reports `{fast, pro, quality, recipe}`.
- `pointTracks(mediaId, points)`: CoTracker3 offline, JSON `[tS, x, y, visible]` per point (fractions).
  `objectTrack(mediaId, concept)`: SAM 3.1 by concept at 10 fps, box/centre/area per frame + one-euro smoothing.
- VideoMaMa was measured as the challenger on the hard windows and not adopted (see Measured).
- MediaPipe (fast recipe) now runs with `cwd` = its own folder: it **aborts when the working folder has Arabic letters**.

### Shared runtime — `src/services/sfxLibrary/mediaRuntime.js`, `mediaModels.js`, `setupMedia.js`, `requirements-media.txt`
- `runtime\media`: a venv of `runtime\python312` + `zz_video_runtime.pth` → reuses the video runtime's torch 2.11/cu130
  and transformers 5.8.1 (no second 5 GB torch). Own packages pinned in `requirements-media.txt` (+ diffusers 0.36 /
  accelerate for the VideoMaMa test only). MatAnyone2 and CoTracker sources under `runtime\media\src` (pinned commits).
  `node src/services/sfxLibrary/setupMedia.js "<runtime>"` recreates all of it (`--skip-models`, `--only`, `--no-images`).
- `runPy` (JSON-lines scripts), `PyWorker` (loaded once, one request per line), `readF32`/`cosineAll`.

## Files touched
New: `src/services/{sfxLibrary.js, brollService.js, imagegenService.js}`, `src/services/sfxLibrary/*`,
`src/services/broll/*`, `src/services/imagegen/*`, `src/services/vision/{pro_matte,track_points,track_object}.py`,
`tests/unit/{sfxLibrary,broll,mediaTools}.test.js`, `HANDOFF.md`.
Mine, changed: `src/services/matteService.js`.
Shared, one appended block each: `src/services/index.js` (import `path`, the 3 services, `mattes.gpu = gpu`),
`src/services/settingsService.js` (`media: { libraryDir, matteQuality }` + 2 rules), `src/main/ipc.js` (`sfxlib.*`,
`broll.*`, `imagegen.*`, `mattes.pointTracks/objectTrack`), `src/preload/preload.cjs` (`imagegen:engine` event),
`src/renderer/js/i18n.js` (errors + 5 settings labels), `package.json` (`asarUnpack` for the 3 new Python folders).
No new npm packages. No UI was built (services + IPC only).

## Tests
`npm test`: **136 / 136 pass** (19 new tests in 3 files; the e2e suite was not run — the GPU was shared). New unit tests: Egyptian expansion, rules, meaning tagging, UCS categories, Mixkit parsing,
search over a fake index + import + director tools; RRF / rerank blend / diversity / evaluation / caption parsing / VLM
lookup / index bookkeeping; prompt cleaning, sizes, graph wiring, GPU sampler, matte recipe choice, track smoothing.

## Measured (RTX 4090, desktop already holding ~4.6 GB)
**Person matte, 6 hard 10 s windows of the cases** (`النتائج\media\matting\<clip>\ab_*.jpg`: source | fast | pro;
the first run, everyone SAM finds, up to 4 people, is kept in `matting-v1`). Flicker = mean |alpha change| on pixels
whose colour did not change (lower = steadier). Pro: 720 px short side, peak GPU **2.3 GB** (SAM 3.1 + MatAnyone2).

| clip | what | fast fps (1 process, 360 px) | fast flicker | pro fps | pro flicker | steadier by | cuts / restarts |
|---|---|---|---|---|---|---|---|
| hair-busy | long dark hair, trees, a pergola and people behind | 16.1 | 0.00341 | 5.25 | 0.0003 | 11.4× | 0 / 1 |
| fast-hands | knife work and quick hands over the board | 11.49 | 0.00139 | 5.72 | 0.00023 | 6.0× | 0 / 0 |
| two-people | two men side by side, an interview | 17.41 | 0.00194 | 7.13 | 0.00038 | 5.1× | 0 / 0 |
| low-light | night outdoors by a van, orange shirt | 22.01 | 0.01483 | 7.08 | 0.00259 | 5.7× | 0 / 6 |
| cut-mid | edited video: cuts at ~32, 34, 36, 38 s | 24.43 | 0.00442 | 7.3 | 0.00063 | 7.0× | 3 / 4 |
| crowd-passing | a challenge: several people moving in front of each other | 23.72 | 0.00395 | 5.64 | 0.00048 | 8.2× | 0 / 0 |

- Pro runs **5.3–7.3 fps** (~0.2× real time at 30 fps; ~25 % of it is the SAM checks every 15 frames). The fast recipe
  runs in 8 parallel chunks in the app, so it is still the quick one.
- Visually (A/B frames): pro keeps hair strands, fingers and the carrot in the hand, the night scene's children; fast
  loses arms and leaves blotches. First run problems, fixed: background people were cut out too (now: main people
  only) and a 5th person at the frame edge was missed (now up to 8). Cuts (`cut-mid`) found 3 of the ~4 cuts and
  restarted MatAnyone2 there; `low-light` restarted 6 times (SAM disagrees more in the dark) — still 5.7× steadier.
- **VideoMaMa (challenger)**, 9 windows of 16 frames on hair-busy / low-light / crowd-passing (`mama_*.jpg`): at
  1024×576 with SAM still loaded it filled the 24 GB and crawled in shared memory (stopped after 20 min); with SAM's
  masks made first and SAM freed, at **448×768: 5.29–6.29 fps, peak 12.27 GB**. Flicker inside the
  windows: VideoMaMa 0.00147 vs MatAnyone2 0.00116 (mean). Edges look alike by eye; it needs 5× the
  memory and works in 16-frame windows (seams between windows). **Decision: MatAnyone2 stays the recipe; VideoMaMa is
  not wired into the app** (its test code: `scripts\mama_bench.py`).

**Image tools** (`النتائج\media\imagegen\`; GPU total used incl. ~3 GB of the desktop):

| job | model | size | time | GPU before → peak |
|---|---|---|---|---|
| text→image (cold: engine start 12.9 s + load) | Qwen-Image-2.1 Turbo INT8 | 768×1376 | 20.6 s | 2.9 → 19.2 GB |
| text→image (warm) | Qwen-Image-2.1 Turbo INT8 | 768×1376 | **3.4 s** | 17.9 → 18.4 GB |
| transparent sticker (RGBA, 50 % transparent pixels) | Qwen-Image-2.1 Turbo INT8 | 1024×1024 | 3.5 s | → 19.2 GB |
| edit of a keyframe ("golden hour", identity kept) | Qwen-Image-2.1 Turbo INT8 | 768×1376 | 6.0 s | → **22.0 GB** |
| text→image (cold) | Z-Image-Turbo INT8 | 768×1376 | 16.5 s | 2.9 → 16.1 GB |
| text→image (warm) | Z-Image-Turbo INT8 | 1376×768 | 3.4 s | → 18.0 GB |
| Arabic request → upsampler (Qwen3.5-35B-A3B, alone) → image | Z-Image-Turbo INT8 | 768×1376 | 16.7 s (image) | → 18.3 GB |
| still cut-out | BiRefNet (fp16) | 384×678 | 2.8 s incl. load | 1.6 GB (process) |

- The Qwen edit peaks at ~22 GB with the desktop's ~3 GB: it fits the 4090 only with nothing else on the GPU.
- Arabic guard: the first test ("a sign that says «مطبخ ماما»") produced a sign reading **ABOVE** — the leftover
  "that says". Fixed (the introducing words go too, every sign is asked blank; an Arabic request is upsampled into
  English first); re-test: the same request now gives a door with a **blank** sign (`qwen-arabic-guard.png`); an upsampled prompt had also produced fake Arabic calligraphy ("a sign displaying Arabic calligraphy") — sentences about writing are now dropped before the model.
- FLUX 3 Klein: not measured (gated + needs ComfyUI 0.41).

**Sound library**: fetch Remotion + Kenney 1 min, Mixkit ~35 min (2,213 sounds); CLAP index on the CPU **30 min** first
time, 5 s for a top-up; a query **25–350 ms** after a ~10 s worker load. Examples (`sfx-search-demo.json`):
«صدمة» → female/male astonished gasps; «هيصة» → cheering crowd, ovation; «إحراج وسكتة» → crickets; «تريقة» → squeaky
toy, cartoon laughs; «تشويق قبل المفاجأة» → risers; «طاسة زيت بتطش» → frying pan; «تريقة» in a sad moment → nothing
(blocked). Weak: «يا نهار أبيض» (a cartoon sneeze first), «cartoon boing» (lasers rank high).

**B-roll index of the 6 cases** (17.5 min of video, 228 shots): shots 160 s (CPU decode); captions **6.7 s/shot**
(Qwen3.5-35B-A3B + mmproj, MoE on the CPU; 25 min); embeddings: SigLIP2 102 s (2.3 GB), MetaCLIP 2 58 s (3.6 GB),
Qwen3-VL-Embedding 521 s (7.2 GB; 2.3 s a shot), bge-m3 13 s (1.2 GB).
**B-roll search, 30 test questions (28 Egyptian, 2 English) on the 6 cases** (`broll-search-report.json`; raw = the
question as it is — SigLIP2 gets English only, so it has no raw row; expanded = the VLM's English + MSA phrases first):

| config | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|
| raw:metaclip2 | 0.433 | 0.733 | 0.767 | 0.552 |
| raw:qwen3vl | 0.5 | 0.733 | 0.767 | 0.613 |
| raw:bge | 0.633 | 0.8 | 0.9 | 0.725 |
| raw:rrf | 0.7 | 0.8 | 0.8 | 0.752 |
| raw:rrf+rerank | 0.7 | 0.8 | 0.8 | 0.758 |
| raw:rrf+rerank+diverse | 0.7 | 0.8 | 0.8 | 0.75 |
| expanded:siglip2 | 0.767 | 0.9 | 0.9 | 0.82 |
| expanded:metaclip2 | 0.633 | 0.9 | 0.9 | 0.713 |
| expanded:qwen3vl | 0.733 | 0.833 | 0.867 | 0.776 |
| expanded:bge | 0.767 | 0.9 | 0.933 | 0.83 |
| expanded:rrf | 0.8 | 0.867 | 0.9 | 0.835 |
| expanded:rrf+rerank | 0.9 | 0.967 | 0.967 | 0.92 |
| expanded:rrf+rerank+diverse | 0.9 | 0.967 | 0.967 | 0.919 |

- The expansion is worth ~20 points of R@1 (0.70 → 0.90 with the full pipeline); the reranker adds 10 points on top of RRF.
- Time per query: search 634 ms (4 indexes, warm worker on the GPU), rerank 2998 ms
  (top 30), expansion 2730 ms (the LLM already loaded; it takes ~40 s to load). Worker memory not measured (≈ 15 GB by the models' sizes).
- The published reranker script fails with transformers 5.8 (`mm_token_type_ids` left as lists; `_sample_frames`
  missing for videos); `broll.py` patches both at load. It reranks on one keyframe + the caption.

## Models and assets downloaded
| what | source (pinned) | size | licence | used for |
|---|---|---|---|---|
| clap | huggingface.co/laion/larger_clap_general @ada0c23 | 0.78 GB | Apache-2.0 | sound library: text → audio search, meaning tags |
| siglip2 | huggingface.co/google/siglip2-so400m-patch16-naflex @cc24074 | 4.58 GB | Apache-2.0 | B-roll: keyframe embeddings (English queries) |
| metaclip2 | huggingface.co/facebook/metaclip-2-worldwide-huge-quickgelu @c139061 | 7.51 GB | CC-BY-NC-4.0 | B-roll: keyframe embeddings, native Arabic queries |
| qwen3vl-emb | huggingface.co/Qwen/Qwen3-VL-Embedding-2B @9f2f7e7 | 4.27 GB | Apache-2.0 | B-roll: the shot as a video |
| qwen3vl-rerank | huggingface.co/Qwen/Qwen3-VL-Reranker-2B @4bd860a | 4.27 GB | Apache-2.0 | B-roll: reranking the top 30 |
| bge-m3 | huggingface.co/BAAI/bge-m3 @5617a9f | 2.31 GB | MIT | B-roll: caption text index |
| qwen35-mmproj | huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF @bc014a1 | 0.90 GB | Apache-2.0 | B-roll captions: the vision projector of the dubbing translator (runtime/models/translate) |
| matanyone2 | huggingface.co/PeiqingYang/MatAnyone2 @40c894a | 0.14 GB | S-Lab License 1.0 (non-commercial) | person matte |
| birefnet | huggingface.co/ZhengPeng7/BiRefNet @e2bf8e4 | 0.44 GB | MIT | still-image background removal (in place of the gated RMBG-2.0) |
| cotracker3 | huggingface.co/facebook/cotracker3 @bf55ea5 | 0.20 GB | CC-BY-NC-4.0 | point tracks |
| qwen_image_2.1_turbo_int8_convrot.safetensors | huggingface.co/Comfy-Org/Qwen-Image-2.1 @0217efd | 7.26 GB | Qwen Research License (non-commercial) | image tools (ComfyUI) |
| qwen3vl_8b_int8_convrot.safetensors | huggingface.co/Comfy-Org/Qwen-Image-2.1 @0217efd | 9.35 GB | Qwen Research License (non-commercial) | image tools (ComfyUI) |
| qwen_image_2.1_vae_bf16.safetensors | huggingface.co/Comfy-Org/Qwen-Image-2.1 @0217efd | 0.68 GB | Qwen Research License (non-commercial) | image tools (ComfyUI) |
| z_image_turbo_int8_convrot.safetensors | huggingface.co/Comfy-Org/Z-Image-Turbo @6fc90a3 | 6.20 GB | Apache-2.0 | image tools (ComfyUI) |
| qwen_3_4b_fp8_mixed.safetensors | huggingface.co/Comfy-Org/Z-Image-Turbo @6fc90a3 | 5.63 GB | Apache-2.0 | image tools (ComfyUI) |
| ae.safetensors | huggingface.co/Comfy-Org/Z-Image-Turbo @6fc90a3 | 0.34 GB | Apache-2.0 | image tools (ComfyUI) |
| MatAnyone2 (code) | github.com/pq-yang/MatAnyone2/archive/0079197acd6d16a741f71558809c06c586c579e0.zip | — | S-Lab License 1.0 (non-commercial) | runtime/media/src |
| co-tracker (code) | github.com/facebookresearch/co-tracker/archive/82e02e8029753ad4ef13cf06be7f4fc5facdda4d.zip | — | CC-BY-NC-4.0 | runtime/media/src |

Total models: 54.87 GB

Not downloaded:
- FLUX 3 Image Klein (INT8 ComfyUI build + prompt upsampler): black-forest-labs/flux-3-image-klein-comfy is gated (accept the FLUX Kommunity License with a Hugging Face login) and needs ComfyUI 0.41; the video runtime has 0.40
- RMBG-2.0: briaai/RMBG-2.0 is gated (licence form); BiRefNet (MIT), its architecture, is used instead
- VideoMaMa: downloaded for the challenger test only (see below); not used by the app
- TAPNext: not installed: CoTracker3 covers the point tracks
- Freesound: its API needs a personal key
- Pixabay sound effects: the site refuses scripted downloads (HTTP 403 behind a browser check); download by hand and use import folder
- BOOM Toons, Sonniss, ProductionCrate: paid or sign-up: the user's own packs, indexed in place with import folder

Also: VideoMaMa test only (not used by the app): `SammyLim/VideoMaMa` @e289a7a (6.1 GB, Stability AI Community License)
+ `stabilityai/stable-video-diffusion-img2vid-xt` @9e43909 (VAE, image encoder, configs: 1.4 GB, Stability AI Community
License) + code `cvlab-kaist/VideoMaMa` @c3ffc16 (CC-BY-NC-4.0) under `runtime\media\src\VideoMaMa`; diffusers 0.36.0 +
accelerate in `runtime\media`. Sound library: 3.2 GB in `D:\capcut new\assets-library\sfx` (Mixkit SFX Free License,
CC0 Kenney, @remotion/sfx). B-roll test index: 67 MB in `D:\capcut new\assets-library\broll-index`.
Runtime `runtime\media`: 0.2 GB (+ sources).

## Needs a practical test on the user's footage
- The B-roll right answers were marked by me from keyframes/captions; the plan's test is **100 real Egyptian questions
  of the user's own**, marked by the user.
- Sound choices by meaning: listen to `sfx-search-demo.json`'s top results (the tags are CLAP zero-shot + source names;
  some tags are noisy, e.g. «رومانسي» on game tones).
- The pro matte on full videos in the app (export + preview of "text behind the person"), especially portrait 4K.
- Image quality of Qwen-Image / Z-Image for the user's coverage needs; transparent stickers over real footage.

## What I need from other phases
- **quick-wins / director**: call `SFX_TOOLS` (`sfx_search` with the moment's mood, `sfx_check_plan`) instead of the
  11 bundled sounds; pass moments as `{startUs, endUs, mood}`. The bundled `src/core/sfx.js` stays as the offline fallback.
- **perception**: moods per moment (serious/sad/emotional/comic…) for the sound rules; and, if Qwen3.6-35B-A3B lands in
  `runtime\models\perception` with an mmproj, the B-roll captions switch to it.
- **graphics**: object tracks (`mattes.objectTrack`) and point tracks (`mattes.pointTracks`) are JSON in fractions of the
  frame, source time — arrows/circles/labels can follow them.
- **coordinator**: ComfyUI 0.41 for FLUX 3 (and the user's licence click); the exporter could pass the source ranges
  that are really behind-person so the pro matte runs only there (today: whole media, ≤ 5 min in auto); UI for the
  library folder / matte quality settings and the sound/B-roll browsers.

## Open risks
- `runtime\media` depends on the video runtime's torch/transformers via a .pth: upgrading the video runtime can break it.
- Non-commercial licences (fine for personal use): MetaCLIP 2, CoTracker3 (CC-BY-NC), MatAnyone2 (S-Lab), Qwen-Image-2.1
  (Qwen Research), VideoMaMa (Stability Community + CC-BY-NC code); @remotion/sfx meme sounds of unclear origin.
- Pro matte speed (~5.5 fps at 720p): a long video takes long; SAM checks are ~25 % of the time.
- The VLM captions take ~6.7 s a shot (MoE layers on the CPU): ~300 h of footage ≈ several nights, as the plan says.
