# Phase 4 — Perception («الإدراك») — hand-off

Branch `phase4-perception` (worktree `D:\capcut new\worktrees\perception`). Plan: `PLAN_editor_and_graphics.md` v3,
section 2 items 1, 2, 3, 5, 9 (step 1) and the VRAM schedule (section 4).

## What was built

An offline perception pipeline that writes **one timestamped event timeline per media file**, runs the models one
after another (one Python process per stage, the GPU lock taken for each stage's run only), caches every stage per
file content hash + stage parameters, and is callable from the app (service + IPC) and from the command line.

```
node src/services/perception/cli.mjs <file|folder>… --out <dir> [--stages words,speakers,…] [--gpu-lock "D:\capcut new\gpu-lock.mjs"]
     [--asr nemo|file --asr-file <json>] [--nemo-model <file.nemo>] [--num-speakers N] [--asd light-asd] [--refresh stage,…] [--status]
```

| Stage | Model (runtime) | What it writes |
|---|---|---|
| words | the speech engine (pluggable `ASR_ENGINES`: `nemo` = the Egyptian NeMo model via `src/services/asr/nemo_words.py`; `file` = any transcript JSON in that shape) + **wav2vec2 Arabic forced alignment** (jonatasgrosman/wav2vec2-large-xlsr-53-arabic, the edit-hamdy 57_align method) — `runtime\asr` | `word` (aligned times, ASR times kept in `extra.asr`), `utterance`, `pause` |
| speakers | **pyannote speaker-diarization-community-1** (pyannote.audio 4.0.7) — `runtime\perception` | `speaker_turn` (exclusive mode: one voice at a time, used for word→speaker), `overlap` (regions with ≥ 2 voices; words inside get `extra.unsure`) |
| audio | **PANNs** Cnn14_DecisionLevelMax (AudioSet 527 tags, 10 ms), **laughter-detection** (Gillick et al. ResNet), loudness (RMS vs 6 s median) and pitch (pYIN vs 10 s median) spikes | `audio_tag`, `laughter`, `loudness_spike`, `pitch_spike` |
| emotion | **emotion2vec+ large** (FunASR), per utterance | `emotion` (label + all 8 scores) |
| shots | **TransNetV2** (authors' PyTorch port, weights converted from the official TF release with their converter: 100 % output match) | `shot` |
| faces | **InsightFace buffalo_l** (SCRFD-10G detection + ArcFace R50) on onnxruntime-gpu, IoU tracking at 25 fps, tracks split where the face changes, identity clusters (average linkage); **AdaFace IR-101** (CVLFace WebFace12M, exported to ONNX here) used for tracks in poor light / blur | `face_track` (identity `P1…`, quality, 5 boxes/s normalised) |
| asd | **LR-ASD** (TalkSet fine-tuned weights; the authors' Columbia_test recipe) — `--asd light-asd` = **Light-ASD** fast mode | per-frame scores → `active_speaker` |
| fusion (JS) | voices ↔ faces: mean-ASD-score contrast (voice talking vs not) × evidence, ≥ 25 % coverage, **Hungarian** assignment, threshold → "off-screen" | `speaker_turn.entity`, `active_speaker.speaker`, `timeline.speakers/faces/links` |
| vision | **Qwen3.6-35B-A3B** UD-IQ4_XS + mmproj F16 (llama.cpp b11870, thinking off, JSON schema), keyframes with their times in the prompt; long shots cut into ≤ 12 s windows | `shot_log` (who, where, action, objects, text on screen, shot size, camera, change, energy 1–5, B-roll candidate + reason, English + Egyptian summary, confidence) |
| window check (hook, not a stage) | `PerceptionService.windowCheck(file, [{t0,t1,question}], {engine})`: Qwen3-Omni-30B-A3B (sound + frames) implemented, Keye-VL-2.0 answers "unavailable" (needs Kwai's llama.cpp fork) | yes/no + confidence + reason per window |

### The event timeline (what phases 5/6 read)

`<cache>/<file hash>/timeline.json` (the CLI also writes `<out>/<name>.timeline.json` + `<name>.html`):

```
{ version: 1, media: {path, name, hash, duration, width, height, fps, hasAudio, hasVideo},
  speakers: [{id: "S1", seconds, face: "P1" | null, offScreen, linkConfidence}],
  faces:    [{id: "P1", tracks, seconds, poor, thumb, voice: "S1" | null}],
  links:    {S1: {face, confidence, score, meanS, baseline, coverage, visibleS, shareS, shareO} | {face: null, offScreen, best, …}},
  events:   [{id, t0, t1, type, source_model, confidence, speaker, entity, text, extra}],   // sorted by t0
  report:   {stages: {<stage>: {ms, gpuWaitMs, device, model, torchPeakMB, vram: {baseMB, peakMB, deltaMB}, parts, cached}}},
  artifacts: {dir, faces, vision} }
```

`speaker` is always a **voice** (S1, S2… by speaking time), `entity` an **on-screen person** (P1, P2… by screen time).
Per type `extra`: word `{aligned, asr: [t0, t1], unsure?}` · utterance `{words, unsure?}` · pause `{seconds}` · overlap
`{speakers}` · face_track `{track, poor, quality, boxes: [[t, x, y, w, h]…] normalised, 5/s}` · active_speaker `{track,
score}` · audio_tag `{index}` (AudioSet class) · laughter `{sources}` · emotion `{scores}` · loudness_spike `{db,
aboveDb}` · pitch_spike `{hz, ratio}` · shot `{index}` · shot_log `{shot, keyframes, who[], where, indoor, action,
objects[], text_on_screen, shot_size, camera, change, energy, broll_candidate, broll_reason, summary, summary_ar}`.
Query helper: `eventsIn(timeline, t0, t1, types)` in `timeline.js`.

**For phase 5 (best take):** `utterance` + `word` (aligned, with speaker) to group takes; `emotion` scores, `pitch_spike`,
`loudness_spike`, `pause` per take (compare takes with each other, not absolutely); `laughter` after a take; `face_track`
quality + `active_speaker` (is the speaker on screen and visibly talking). **For phase 6 (cause ↔ reaction):** reactions
= `laughter`, `audio_tag` (Applause, Cheering, Screaming, Gasp…), `loudness_spike`, `pitch_spike`; same-people check via
`speaker`/`entity` and `links`; same-scene via `shot`; the semantic check via `windowCheck()` (Qwen3-Omni) once its
weights are downloaded; the `shot_log` gives context per ≤ 12 s window.

## Results on the user's raw cases

`D:\capcut new\montaj-bench\النتائج\perception\` — `index.html` (overview), per case `<case>.html` (Arabic summary with
face thumbnails, timeline strip, shot log, the hand-check rows, per-stage time and GPU memory) and `<case>.timeline.json`,
plus `handcheck.json` (every judged clip). 6 cases, 21.0 min: five 4K/1080p HEVC phone raws and the interview
(04-مقابلة, 1080p h264, horizontal, already edited: 25 shots, burned-in captions).

Per stage: wall time of the first run · torch peak MB / card-wide increase MB (nvidia-smi every 0.5 s; other sessions'
small jobs can show up in the card-wide number):

| Case | Length | words | speakers | audio | emotion | shots | faces | asd | vision |
|---|---|---|---|---|---|---|---|---|---|
| 01-فلوق | 150 s | 46 s · 1530 / 1598 | 14 s · 2010 / 2540 | 9 s · 2644 / 3060 | 18 s · 988 / 1575 | 36 s · 224 / 1193 | 57 s · — / 2601 | 18 s · 732 / 1512 | 68 s · — / 18464 |
| 02-تحدي | 127 s | 51 s · 1458 / 835 | 24 s · 2010 / 2661 | 9 s · 2646 / 3060 | 26 s · 800 / 841 | 46 s · 224 / 1554 | 107 s · — / 2593 | 16 s · 1028 / 2358 | 77 s · — / 18483 |
| 03-طبخ | 300 s | 22 s · 2082 / 2495 | 11 s · 2010 / 2432 | 12 s · 2642 / 3057 | 10 s · 1020 / 1178 | 10 s · 224 / 849 | 72 s · — / 2573 | 10 s · 618 / 1382 | 104 s · — / 18464 |
| 05-شرح | 300 s | 23 s · 1606 / 2012 | 14 s · 2010 / 3457 | 13 s · 2642 / 1543 | 11 s · 1002 / 1219 | 10 s · 224 / 973 | 100 s · — / 4565 | 20 s · 618 / 1229 | 115 s · — / 18464 |
| 06-كوميديا | 179 s | 29 s · 1590 / 903 | 10 s · 2010 / 2432 | 9 s · 2644 / 3058 | 10 s · 788 / 1188 | 17 s · 224 / 1126 | 66 s · — / 2796 | 11 s · 702 / 1125 | 84 s · — / 18464 |
| 04-مقابلة | 206 s | 44 s · 1616 / 2028 | 10 s · 2010 / 2432 | 10 s · 2644 / 3058 | 10 s · 1384 / 1298 | 10 s · 224 / 851 | 52 s · — / 2604 | 10 s · 618 / 1034 | 131 s · — / 20102 |
| **total** | 1262 s | 215 s | 83 s | 62 s | 84 s | 130 s | 455 s | 86 s | 579 s |

≈ 28.2 min of compute for 21.0 min of video on the first run (≈ 1.3× real time), seconds from the cache afterwards. Only
the vision stage is heavy (Qwen3.6 ≈ 18.5 GB, 20.1 GB with the wider 16:9 keyframes); every other stage stays under ~3.5 GB, matching the plan's VRAM schedule
(section 4: steps أ–د). Words: NeMo runs on the CPU (as in the app), alignment on the GPU. Faces: decoding 4K HEVC is
the bulk — the GPU-resize recipe of `fastDecode.js` (orientation checked against a CPU frame) is ~4× faster than CPU
decoding; plain `-hwaccel cuda` was *slower* than the CPU here (full 4K frames downloaded).

### Accuracy — measured honestly, small samples

No human labels exist yet for these files; checks used (a) an independent listening model, Qwen2-Audio-7B-Instruct
(already in the HF cache), (b) an independent voice-embedding model, NeMo TitaNet-large (the dub runtime's ONNX), and
(c) my own look at frames around each moment plus the transcript. **None of this replaces the user's own check.**

- **Laughter.** laughter-detection alone fires on crowd noise and chatter: of 67 clips it scored ≥ 0.5, the listening
  model heard laughter in 26 (≈ 39 %; 20/40 ≈ 50 % at ≥ 0.8). PANNs' laughter classes never passed 0.3 on these videos.
  Requiring both (laughter-detection ≥ 0.8 and some PANNs laughter ≥ 0.05 within ±0.5 s) gave 16/20 ≈ 80 % in that
  sample, missing ≈ 40 % of the laughs the listener heard. That rule is now the default (`fuse.js`, tunable; the raw
  frame tracks are stored, so a new threshold needs no model re-run). Final output: **10 laughs in 17.6 min; the
  listener says 8/10 are laughter**; by eye 3 clearly laughing, 1 clearly not (05 @ 274 s), 6 not decidable from the
  picture (two of them a crying toddler with a smiling adult — crying may read as laughter).
- **Speaker changes** (pyannote community-1, exclusive mode). 56 sampled changes re-checked with TitaNet (is the audio
  before/after nearer each voice's own centroid?): **28 confirmed, 19 rejected, 9 unclear**. Good on two-person dialogue
  (01-فلوق: 8/10 confirmed; by transcript + frames 7/10 plausible, 3 unclear); poor in crowds and noise (02: 2/8, 03:
  2/9 — 03's S2/S3 are 5–6 s fragments, probably over-segmentation of S1). Passing `--num-speakers` should help.
- **The interview (04, the main speaker test).** Two people, and two face identities and two voices came out — right.
  9 speaker changes: from the transcript's meaning (question → answer, interjections) 5 plausible, 2 probably wrong
  (58–60 s: a sentence given to the student while only the host is on screen), 2 unclear; TitaNet confirmed 4. The 9
  overlap regions all sit at short interjections («بالظبط», «الوحدة يعني؟»), which is where they belong. LR-ASD
  over-fires on the student's side view (97 % of his frames > 0, even while the host talks).
- **Voice ↔ face.** Now right in 04 (S2 → the host, who talks alone on screen for the first 58 s; S1 → the student),
  01 (S1 «أنا مضطر» → the man, S2 «انت واعدني» → the woman), 03 (the cook who talks throughout) and 05 (the cook who
  explains); in 02 the TV's Fusha football commentary is correctly off-screen. 02-S1 and 06-S2 are unverified, 05-S2
  plausible. Three fixes came from these files: (1) a link needs the face on screen for ≥ 25 % of the voice's speech —
  the wrong links had 3–10 %, the right ones 75–100 %; (2) the contrast uses the **mean ASD score** (clipped logit)
  while the voice talks vs while it does not, instead of the share of frames > 0 — the interview's student scored
  "speaking" 97 % of the time but 3.2 vs 1.2 on average; (3) pairs that cannot link count 0 in the Hungarian
  assignment, not a large negative (a −9 sentinel had pushed 03's narrator off her own face).
- **Faces.** Tracks split when the ArcFace identity changes inside them (crowds made boxes slide between people);
  tracks whose median detector score is < 0.6 (ears, back of heads) are dropped. Identities in the crowd video still
  over-split (14 for ~12 people, plausible) — not measured; the interview gives exactly 2 (right).
- **Shots.** The five phone raws are single continuous takes; TransNetV2 found no false cut there. The edited
  interview gave 25 shots (fast cuts in the host's intro, then long two-shots), consistent with a contact sheet of it;
  not checked cut by cut.
- **Shot log (Qwen3.6).** Compared by eye with frames of 02 and 06: places, people, clothing, actions and objects are
  right (bubble gun, plastic chairs, van at night, crying baby with a bottle); one invented detail seen ("TV on a
  stand" in an early window where a ring light stands). `summary_ar` Egyptian is understandable but clumsy.
- **Emotion.** Not measured (acted-speech training data); use only to compare takes of the same line.
- **AdaFace colour order.** On 63 identity thumbnails, AdaFace similarities agree better with ArcFace in RGB (r = 0.845)
  than BGR (0.832), as its model card says; the worker feeds RGB.

## Models (all under `runtime\models\perception\`, never in git; checked on their official pages)

| Model | Source (official) | Licence | Size on disk | GPU |
|---|---|---|---|---|
| Egyptian NeMo ASR | already shipped (`src/services/asr/models`) | as before | 459 MB | CPU |
| wav2vec2-large-xlsr-53-arabic | huggingface.co/jonatasgrosman (copied from the HF cache) | Apache-2.0 | 1.2 GB | ~1.5 GB |
| pyannote speaker-diarization-community-1 | huggingface.co/pyannote (gated; the user had already accepted it — copied from the HF cache, loads offline) | CC-BY-4.0 | 32 MB | ~2 GB |
| PANNs Cnn14_DecisionLevelMax_mAP=0.385 + class_labels_indices.csv | zenodo.org/records/3987831 (md5 70539c43… matches) · qiuqiangkong/audioset_tagging_cnn | weights CC-BY-4.0, code MIT | 327 MB | ~2.6 GB |
| laughter-detection resnet_with_augmentation | github.com/jrgillick/laughter-detection | MIT | 10 MB | (with PANNs) |
| emotion2vec+ large | huggingface.co/emotion2vec/emotion2vec_plus_large | FunASR model licence v1.1 (attribution) | 1.9 GB | ~1 GB |
| TransNetV2 | github.com/soCzech/TransNetV2 official TF weights (LFS, SHA-256 match) converted with the authors' `convert_weights.py` (100 % output match), then the TF venv deleted | MIT | 36 MB TF + 31 MB .pth | < 0.3 GB |
| InsightFace buffalo_l (det_10g, w600k_r50; the zip's other 3 models unused) | github.com/deepinsight/insightface releases v0.7 | **non-commercial research** (personal use OK) | 341 MB | ~2.5 GB |
| AdaFace IR-101 WebFace12M | huggingface.co/minchul/cvlface_adaface_ir101_webface12m (author's repo), exported here to ONNX (max diff 1e-5) | code MIT; weights follow WebFace (non-commercial research) | 261 MB ONNX + 261 MB source | (with faces) |
| LR-ASD (finetuning_TalkSet.model) + Light-ASD | github.com/Junhua-Liao/LR-ASD, /Light-ASD | MIT | 3.4 + 4.2 MB | < 1 GB |
| Qwen3.6-35B-A3B UD-IQ4_XS + mmproj-F16 | huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF @ a483e9e (SHA-256 match); base Qwen/Qwen3.6-35B-A3B | Apache-2.0 | 16.5 + 0.84 GiB | ~18.5 GB |

UD-IQ4_XS (unsloth, 17.7 GB) was chosen over bartowski's IQ4_XS (19.7 GB): same publisher as the dub translator, ~2 GB
more room on the shared card. Runs on the existing llama.cpp b11870 (Qwen3.5/3.6 vision support since b7990).

**Not downloaded (hooks only):** Qwen3-Omni-30B-A3B-Instruct GGUF (ggml-org; ~18.6 GB + 1.3 GB mmproj; upstream
llama.cpp supports its audio since b8769) and Keye-VL-2.0-30B-A3B GGUF (Kwai-Keye; **needs Kwai's own llama.cpp fork**
built from source — upstream does not know the architecture). `windowCheck()` returns `{available: false}` until the
files are in `runtime\models\perception\qwen3-omni-30b-a3b\` (or `runtime\llama-keye\` + `keye-vl-2.0-30b-a3b\`).
DiariZen was not needed (community-1 was available).

## Runtime

`runtime\perception` — new venv (Python 3.12.15 from `runtime\python312`): torch 2.11.0+cu130, torchaudio 2.11.0,
torchvision 0.26.0, pyannote.audio 4.0.7 (torchcodec 0.17 installed but bypassed: audio is passed as a tensor),
onnxruntime-gpu 1.31.0, funasr 1.4.16, panns_inference, librosa, opencv-python-headless 5.0, scikit-learn,
python_speech_features, onnx (for the AdaFace export). The words stage runs in the existing `runtime\asr` (unchanged).
For the installed app the venv and models must be reachable from `%APPDATA%\Montaj Studio\runtime` (a junction like the
dub runtime's) or the project's `runtime\` — `findRuntime()` looks in that order after an explicit `runtimeDir`. There is
no set-up service yet (download + venv creation in-app) — a follow-up.

## Files

New: `src/services/perception/` — `timeline.js` (schema, pure), `fuse.js` (fusion, Hungarian, laughter rule, pure),
`perceptionService.js` (stages, cache, GPU lock, VRAM monitor, ASR engines, window check), `summary.js` (Arabic HTML),
`cli.mjs`, `workers/{pcommon,align,speakers,audio_events,emotion,shots,faces,asd,vision,llama,window_check}.py`;
`tests/unit/perception.test.js` (12 tests).
Shared files, append-only: `src/main/ipc.js` (block `perception.status|analyze|timeline` at the end of the handlers),
`src/preload/preload.cjs` (one `EVENTS.add("perception:progress")` line), `src/services/index.js` (import + service
creation after the video studio, using the app's `GpuQueue` as the lock; `perception` added to the returned object).
No UI yet (i18n untouched): the service is reachable over IPC; a panel is a follow-up.

## Tests

`npm test` in the worktree: green (see the commit). Perception unit tests cover the schema, sorting/ids, Hungarian,
speaker naming, word→speaker + overlap, utterances, pauses, ASD spans, voice↔face (incl. always-moving mouths and the
coverage rule), the laughter rule, `buildTimeline`, stage planning, cache keys, file hash, lock adapters and the summary
page. The Python workers were exercised end-to-end on all five cases (not in `npm test`: they need the GPU runtime).

## Open risks / needs

- **GPU-lock incident (my mistake):** a re-run with a wrong `--nemo-model` path and **without `--gpu-lock`** ran the
  Qwen3.6 vision stage on 4 cases outside the lock for ~7 min (local 07:07–07:14 on 2026-10-26) while another session
  may have held the lock. The CLI now warns when no lock is set and reads `PERCEPTION_GPU_LOCK` by default.
- Diarization is weak in crowds/noise (see above); voice↔face links are reliable only when the speaker faces the camera
  for a good share of the talk. Phase 5/6 should treat `linkConfidence` < 0.8 and `unsure` words with care.
- Laughter recall is low by design (≈ 60 % in the sample); tune `laughLD`/`laughPannsSupport` against the user's 50
  labelled reactions (plan phase 0) — no model re-run needed.
- The ASR engine is the current NeMo; when the coordinator picks QwenCleo/Cohere, add it to `ASR_ENGINES` (or feed its
  transcript with `--asr file --asr-file …`); the alignment stays.
- Needs from others: a raw (unedited) multi-person interview or prank with overlapping talk — 04 is already edited; a practical
  test of `windowCheck` once Qwen3-Omni is downloaded; an in-app set-up step for `runtime\perception` + models.
