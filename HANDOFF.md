# HANDOFF — `asr-ab` (Round 4: Phase 0 Egyptian speech A/B, «البند 1» of PLAN_editor_and_graphics.md)

Branch `r4-asr-ab` (worktree `D:\capcut new\worktrees\asr-ab`), based on `397ac7b`. Nothing pushed or merged.
Results: `D:\capcut new\montaj-bench\النتائج\الكتابة\` (`hyp\*.json`, the provisional page, later the final report).

## The one command

When the user has saved `reference.json` (from «اكتب الكلام.html», button «حفظ الملف») next to that page:

```powershell
cd "D:\capcut new\montaj-studio"
node bench\asr-score.mjs
```

It writes `مقارنة النماذج.html` + `asr-scores.json` in `montaj-bench\النتائج\الكتابة\` and prints one line per model.
Every model's text is already in `hyp\` (154/154 clips each), so no model runs again and the GPU is not needed. Only
sentences marked «خلصت» count; while none is marked (or `reference.json` is missing) the same command rewrites the
provisional page instead. Optional, next to the page: `names.txt` (one name per line → "names right" column) and
`equivalences.txt` (`a = b` lines, e.g. `يوتيوب = youtube`).

Re-running engines (only for a new engine, new clips, or to re-time one):
`runtime\python312\python.exe -X utf8 bench\asr_all.py [--only cohere,jais] [--force]`. Each engine runs with its
own environment, holds `gpu-lock.mjs` (name `asr-ab`) for its own run only (released in `finally`), and the score step
follows. One engine by hand: `python bench\asr_run.py --engine <name> --ffmpeg <ffmpeg.exe> --dir <folder> [--limit 3]`
(`--limit` writes a smoke file to %TEMP%, not to `hyp\`).

## What was built

- `bench/asr_engines.py` (new): one class per engine (`load()` once, `transcribe(files)` → texts) + pure helpers:
  `plan_chunks` (split a clip longer than a model takes at the quietest 10 ms frame of each piece's second half),
  `rms_frames`, `strip_tags`, `join_texts`, and `snapshot_dir` (reads a model's snapshot folder in the user's HF cache
  directly: several downloads there have no `refs\main`, and the cache is never written).
- `bench/asr_run.py`: uses the engines; records `rtf` (transcription only, model loading excluded), `loadSeconds`,
  `vramMB` (peak − before, from `nvidia-smi` every 0.5 s: covers ctranslate2 too, but includes anything else that
  grew on the shared GPU meanwhile) and `torchPeakMB` (torch's own counter), `source` (repo@commit or local path),
  `label`, `plan` role. Temp WAVs are always removed (also when ffmpeg fails).
- `bench/asr_all.py` (new): all engines in order under the GPU lock, skip what is done, then `asr-score.mjs`.
- `bench/asr-score.mjs`: `agreement()` (new, exported) + the provisional page «مقارنة مبدئية (مش دقة).html» /
  `asr-agreement.json` — pairwise word disagreement, each model vs the Whisper draft, empty sentences, speed, GPU
  memory, and the 15 sentences the models disagree on most (with the clip player, to listen to while correcting).
  It says in a warning box that agreement is not accuracy. The final page gained label/role, a GPU-memory column and
  a note that Whisper is favoured (the reference starts from its draft). Default folder works from a worktree too.
- Tests: `tests/unit/asrAb.test.js` (agreement, final-row fields) and `tests/python/test_asr_engines.py` (chunking,
  tags; run by the unit test with `runtime\python312`).

## Engines and where their weights are

| Engine | Model (licence) | Weights | Environment | Plan role |
|---|---|---|---|---|
| `nemo` | the app's `asr-egyptian-nemo-v2.0.nemo` | `src\services\asr\models\` (junction) | `runtime\asr` (existing, untouched) | baseline |
| `whisper` | faster-whisper large-v3 (MIT) | HF cache `Systran/faster-whisper-large-v3` | `runtime\dub` (existing) | the draft; sanity check |
| `qwencleo` | `mohammedaly22/QwenCleo-ASR` @50f6b90 (Apache-2.0), PyPI `qwencleo-asr` 0.2.1 + `qwen-asr` 0.0.6 | HF cache (already there, 3.9 GB) | **`runtime\asr-qwen`** (new) | main contender |
| `qwen3` | `Qwen/Qwen3-ASR-1.7B` @7278e1e (Apache-2.0) | HF cache (already there, 4.4 GB) | `runtime\asr-qwen` | rejected in the plan; QwenCleo's control |
| `cohere` | `NAMAA-Space/cohere-transcribe-arabic-07-2026-int8` @88a45a1 (Apache-2.0), int8 build of the gated official model | HF cache (already there, 2.2 GB) | **`runtime\asr-hf`** (new) | contender |
| `jais` | `IFM/Jais-ASR` @1323995 (Apache-2.0, own modelling code, `trust_remote_code`) | **downloaded**: `runtime\models\asr-ab\Jais-ASR` (11 GB; HF checks each file's sha256) | `runtime\asr-hf` | optional |
| `voxtral` | `mistralai/Voxtral-Mini-4B-Realtime-Arabic` @7c60cf2 (Apache-2.0) | HF cache (already there, 8.3 GB) | `runtime\asr-hf` | extra, not in the plan (was already on disk) |

The official `CohereLabs/cohere-transcribe-arabic-07-2026` is gated (`gated: auto` — log in and accept terms): not
downloaded, per the rules. Also in the cache but not run: `microsoft/VibeVoice-ASR-HF` (16 GB, long-form with
speakers), `OpenVoiceOS/stt_ar_fastconformer…onnx` (MSA), `NAMAA-Space/EgypTalk-ASR-v2` (empty folder, no weights).

Settings: QwenCleo/Qwen3 `language="Arabic"`, bf16, greedy, batches of 8 (the package splits long audio itself).
Cohere `language="ar"`, greedy, pieces ≤ 30 s at pauses (`plan_chunks`). Jais bf16, `language="EG"`, `code_switch=True`,
pieces ≤ 30 s, its own `postprocess.split_text` drops the `[EG]` tag and turns `[IFM-NoTranscript]` into "".
Voxtral offline mode, bf16, greedy, whole clip.

## Results so far (provisional — not accuracy)

All 154 clips (958 s of audio, 5 bench raws: vlog, challenge, cooking, explainer, comedy) through every engine,
2026-10-26, RTX 4090 shared with the desktop. Page: `montaj-bench\النتائج\الكتابة\مقارنة مبدئية (مش دقة).html`.

| Model | differs from the others (mean) | differs from the Whisper draft | empty clips | words | RTF | GPU added (torch peak) | load |
|---|---|---|---|---|---|---|---|
| Jais-ASR | 65.5 % | 67.8 % | 4 | 1530 | 0.237 | 14.2 GB (12.2) | 66 s |
| QwenCleo-ASR | 70.4 % | 76.0 % | 0 | 1500 | 0.132 | 10.3 GB (8.3) | 73 s |
| Cohere int8 | 71.5 % | 66.4 % | 2 | 1235 | 0.372 | 4.3 GB (2.4) | 32 s |
| Whisper large-v3 | 71.7 % | 57.9 % | 0 | 1201 | 0.145 | 6.0 GB | 16 s |
| Qwen3-ASR-1.7B | 72.3 % | 73.7 % | 0 | 1369 | 0.052 | 8.6 GB (8.1) | 24 s |
| Voxtral Realtime Arabic | 75.2 % | 65.4 % | 35 | 1034 | 1.356 | 13.0 GB (9.0) | 63 s |
| NeMo (current) | 75.3 % | 66.2 % | 18 | 1024 | 0.005 | 3.1 GB (2.7) | 41 s |

What can honestly be read from it:
- The material is hard: every pair of models differs on ~55–80 % of the words. The closest pair is Jais ↔ QwenCleo
  (54 %). The draft has only 1287 words; QwenCleo and Jais write ~1500 — they try to write every word in noisy
  speech, while NeMo drops words or whole sentences. Which of the two is right is exactly what the reference decides.
- Speed: NeMo is in a class of its own (RTF 0.005). Of the contenders Qwen3/QwenCleo are fastest; Cohere int8 is
  slowed by bitsandbytes' int8 matmuls; Voxtral (a streaming model run offline) is slower than real time.
- QwenCleo's RTF (0.132) vs its own base Qwen3 (0.052) with the same code — QwenCleo writes more tokens, but part of
  the gap may be the shared GPU at that moment. Not re-timed: `ai-setup` held the GPU lock for a long series; to
  re-time later: `bench\asr_all.py --only qwencleo --force` (greedy, so the text comes out the same).
- Voxtral's 35 empty clips are all short (1–12 s; one 57 s music-heavy clip). Checked: it emits only
  `[STREAMING_PAD]` tokens from start to end on them; 1 s or 2 s of trailing silence (`--tail-s`) changes nothing.
  So it is the streaming model staying silent on isolated short clips, not a cut-off in the harness.
- Cohere sometimes answers in Standard Arabic / translates (e.g. #142 «(هل تريد أن تدخل)»), and marks music «♫».
- Whisper hallucinated its classic subtitle credit on #120 («ترجمة نانسي قنقر»).

## Disk

New, kept (the comparison and the future winner need them):

| Path | Size | What |
|---|---|---|
| `runtime\asr-qwen` | 7.7 GB | Python 3.12 venv: torch 2.8.0+cu128, transformers 4.57.6 (pinned by qwen-asr), qwen-asr 0.0.6, qwencleo-asr 0.2.1 |
| `runtime\asr-hf` | 7.6 GB | Python 3.12 venv: torch 2.8.0+cu128, transformers 5.16.1, accelerate 1.15, bitsandbytes 0.50.2, mistral-common 1.12, soundfile/soxr/librosa |
| `runtime\models\asr-ab\Jais-ASR` | 11 GB | IFM/Jais-ASR bf16 (the only download) |
| `montaj-bench\النتائج\الكتابة\hyp\*.json` + `asr-agreement.json` + the provisional page | < 1 MB | results |

All under `D:\capcut new\montaj-studio\runtime\` (git-ignored; reached through the worktree junction).
Weights already in `%USERPROFILE%\.cache\huggingface\hub` were read in place, nothing copied, moved or written there.

Removed after use: the transformers wheel downloaded to inspect it, the Jais download log, smoke-run JSONs in %TEMP%,
an empty temp-audio folder left by a failed first smoke run, NeMo probe WAVs and scripts, the dry-run copy of the
results used to test the final report, `bench\__pycache__`. Every engine run deletes its temp WAVs itself.

Reported, not touched (shared caches): uv cache `C:\Users\HI\AppData\Local\uv\cache` 43 GB (now also holds the
torch 2.8 cu128 wheels these environments came from); Hugging Face cache 149 GB.

If a contender loses for good: `runtime\asr-hf` serves Cohere, Jais and Voxtral, `runtime\asr-qwen` QwenCleo and
Qwen3 — delete an environment only when none of its models is kept, and `runtime\models\asr-ab\Jais-ASR` when Jais
loses.

## Needs a practical test / open points

- **The real verdict needs `reference.json`.** Nothing here says which model is more accurate.
- NeMo (the app's model) writes nothing at all on 18 of 154 clips with clear speech (e.g. #24, a 16 s sentence; #58,
  #59 cooking talk). Checked: the same on the CPU (how the app runs it), with batch size 1, and the CTC head gives only
  fragments — it is the model, not the harness. The score will show it as deletions; worth knowing for the app today.
- Speed numbers come from a shared desktop GPU (Premiere, browsers, LM Studio open; per-process memory is not readable
  on Windows/WDDM), so treat RTF and `vramMB` as ±20 %. QwenCleo batches 8 clips (up to 57 s each), hence ~10 GB.
- Cohere is NAMAA-Space's int8 build, not the official weights (gated: the user must log in and accept terms on Hugging
  Face). Same architecture and parameter count (2,065,804,048 official BF16 vs 2,066,801,152 int8 incl. scales), same
  tokenizer, `base_model` points to the official repo, both Apache-2.0; its card reports 0.46 % WER drift from fp16 on
  Saudi podcasts — unverified by us. If Cohere comes close to winning, re-run it on the official fp16 weights.
- Jais-ASR is pinned to Egyptian (`language="EG"`) with `code_switch=True` (English kept in Latin letters); it may still
  answer "no speech" (empty text) — counted as such.
- Plan items not run here: Omnilingual 7B (only cited in the plan as a published comparison), MMS aligner / word timing
  (a separate test: 200 hand-marked word boundaries).

## Shared files / requests for the coordinator

- No shared file touched. `npm test`: 249/249 pass (245 before + 4 new in `tests/unit/asrAb.test.js`, one of which runs
  `tests/python/test_asr_engines.py`, 6/6). The final-report path was also run end to end on a fake reference (draft
  as reference) in a scratch copy of the results, then deleted.
- When merging, nothing to rebuild; the environments live under `runtime\` (shared by the junction).
