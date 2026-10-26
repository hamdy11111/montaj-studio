# HANDOFF — `ai-setup` (round 4: the AI layers installable in the app, and re-measured)

Branch `r4-ai-setup` (worktree `D:\capcut new\worktrees\ai-setup`), based on `397ac7b`. Nothing pushed, nothing
merged. Results and scripts: `D:\capcut new\montaj-bench\النتائج\ai-setup\`.

## 1. In-app set-up of the AI layers

Perception, best take, cause ↔ reaction links and the B-roll index were set up by hand during development. They now
have the studios' kind of set-up (same plumbing as `engineSetupService.js`: one task at a time, resumable SHA-256
checked downloads, progress events), plus import of what is already on disk and real health checks.

```
src/services/aiSetup/sources.js          hand-written: where every model set comes from (official sources), licences
src/services/aiSetup/buildCatalog.mjs    dev tool: resolves sources.js to pinned commits and PROVES each pin against the
                                         copy on this PC → catalog.json
src/services/aiSetup/catalog.json        generated: 19 sets, every file {url @commit, size, sha256, source}
src/services/aiSetup/catalog.js          layers (runtime, sets, borrowed sets, dependencies), pure helpers
src/services/aiSetup/requirements-perception.txt, requirements-takes.txt   pinned (pip freeze of the phase runtimes)
src/services/aiSetup/venv_check.py       runtime health check: every package's RECORD (missing / wrong-size files),
                                         pinned versions, the layer's imports; names the package behind a lost module
src/services/aiSetupService.js           AiSetupService (extends EngineSetupService): status, install, import, check,
                                         repair, llama.cpp, GPU/driver check
src/renderer/js/pages/aiSetup.js         the «تجهيز الذكاء» page (home navigation)
tests/unit/aiSetup.test.js (9), tests/e2e/aiSetup.e2e.test.mjs (2)
```

### How the catalog is pinned (and proved)

`node src/services/aiSetup/buildCatalog.mjs "<runtime>"` hashes the files already installed and checks each one
against its official source at a pinned commit, so the catalog is not just "what we have" but "what the source
publishes, and we have exactly that":

- Hugging Face: the tree of the commit — an LFS file's published SHA-256, a small file's git blob id. A gated repo
  (pyannote) hides the LFS SHA-256; the git id of the LFS *pointer* (built from our SHA-256 + size) is compared instead.
- GitHub: git trees API (gh); git-LFS pointers read for their SHA-256 (opencv_zoo's YuNet).
- zenodo: the record's MD5 (the API answered 403 to scripts during this run; the MD5 phase 4 checked stands).
  Google's model store: the `x-goog-hash` MD5. Archives (InsightFace `buffalo_l.zip`, the LibreFace 2.0.0 nupkg):
  downloaded once, unpacked, each member compared, removed.
- Locally made files (TransNetV2 converted weights, AdaFace ONNX export): hashed, marked **import-only**.

| layer | set | size | source (pinned) | licence |
|---|---|---|---|---|
| perception | align (wav2vec2 Arabic) | 1.26 GB | HF jonatasgrosman/wav2vec2-large-xlsr-53-arabic @af46c2d | Apache-2.0 |
| perception | speakers (pyannote community-1) | 0.03 GB | HF pyannote/speaker-diarization-community-1 @3533c8c — **gated: import only** | CC-BY-4.0 |
| perception | audio (PANNs + laughter) | 0.34 GB | zenodo 3987831 · GitHub qiuqiangkong/audioset_tagging_cnn @d2f4b8c · jrgillick/laughter-detection @5d5e032 | CC-BY-4.0 / MIT |
| perception | emotion (emotion2vec+ large) | 1.95 GB | HF emotion2vec/emotion2vec_plus_large @6c303ba | FunASR licence v1.1 |
| perception | shots (TransNetV2) | 0.03 GB | GitHub soCzech/TransNetV2 @85cef72 + converted weights — **import only** | MIT |
| perception | faces (buffalo_l det + ArcFace) | 0.19 GB | GitHub deepinsight/insightface release v0.7 zip | non-commercial research |
| perception | adaface (optional) | 0.26 GB | exported ONNX — **import only** | WebFace terms |
| perception | asd (LR-ASD + Light-ASD) | 0.01 GB | GitHub Junhua-Liao/LR-ASD @1b6dcd2, Light-ASD @ed38c23 | MIT |
| perception | vision (Qwen3.6-35B-A3B) | 18.63 GB | HF unsloth/Qwen3.6-35B-A3B-GGUF @a483e9e | Apache-2.0 |
| perception | omni (Qwen3-Omni-30B-A3B, optional) | 19.88 GB | HF ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF @6e35a28 | Apache-2.0 |
| takes | voice (DNSMOS P.835) | 0.001 GB | GitHub microsoft/DNS-Challenge @591184a | CC-BY-4.0 |
| takes | face (YuNet, MediaPipe, LibreFace) | 0.09 GB | opencv_zoo @48b10fa (LFS) · Google model store v1 · nuget LibreFace 2.0.0 | MIT / Apache-2.0 / USC research |
| takes | gaze (L2CS Gaze360) | 0.10 GB | HF py-feat/l2cs @2410769 | non-commercial |
| broll | siglip2 / metaclip2 / qwen3vlEmb / rerank / bge | 22.94 GB | HF @ phase 9's pinned revisions | Apache-2.0 / CC-BY-NC-4.0 / MIT |
| broll | captioner (Qwen3.5 mmproj) | 0.90 GB | HF unsloth/Qwen3.5-35B-A3B-GGUF @bc014a1 | Apache-2.0 |

The links layer has no sets of its own: it borrows perception's `vision` and `omni`; best take borrows `omni` (its AI
judge). B-roll needs the dubbing
translator (Qwen3.5-35B-A3B, installed by the dubbing set-up) and the video studio's runtime (its venv overlays it).

### What the service does

- **status** per layer: runtime (installed, healthy from the last check, linked?), every set file by file (ok /
  missing / partial / damaged; `verify` hashes), dependencies (llama.cpp, the speech engine, the video runtime, the
  translator), state `ready | partial | missing`, sizes, and whether the card has enough VRAM (gpuInfo: name, VRAM,
  driver ≥ 580 for the CUDA 13.0 torch).
- **install a runtime**: portable Python 3.12 (the studios' pinned build) → venv → torch cu130 wheels fetched by the
  app (resumable, SHA-256) → `pip install -r` pinned → health check must pass → wheels removed. The B-roll runtime is
  the media venv overlaid on the video runtime (phase 9's design). llama.cpp (the dubbing set-up's pinned b11870).
- **import** (nothing downloaded twice): a set's folders found complete *where they belong* are **linked** (junction,
  no copy, no extra disk); otherwise files are found by name+size (every candidate hash-checked), hard-linked on the
  same drive, copied otherwise (import-all never copies; it reports the size instead). The Hugging Face cache is
  searched too, including its `blobs/` when a snapshot folder was emptied (the case of Qwen2.5-Omni-7B here). A runtime
  is imported only after its health check passes. **Import everything** does all layers + llama + the speech engine.
- **repair**: sets — re-hash, delete damaged, re-download from the pinned source (import-only sets must be imported);
  runtimes — reinstall exactly the broken packages (`--force-reinstall --no-deps`, torch from its checked wheel), add
  missing pins, check again, rebuild only if still broken.
- **prepare** (the layer's one button): runtime (install or repair) + llama.cpp + every required downloadable set.
- **degrade**: perception skips a stage whose runtime, llama.cpp or required model is missing (`PerceptionService.missing`,
  sizes only, no hashing) instead of failing in Python; `status().missing` lists them. Takes already dropped stages per
  model; links answers `available: false`; the director already falls back on all three.

IPC (`src/main/ipc.js`, appended block): `ai.setupStatus|prepareLayer|installEnv|checkEnv|repairEnv|importEnv|
installLlama|downloadSet|importSet|verifySet|repairSet|importAll|setupCancel`; event `ai:setup` (preload).

### Tests

- `npm test`: **254/254** (9 new in `tests/unit/aiSetup.test.js`: catalog integrity and pinning, import-only/gated/borrowed
  sets, layer states, locating files by place/name, wheel pins, requirement lookup, perception's stage skipping, and —
  on this PC — a real import → missing → damaged → re-download repair cycle of the DNSMOS set).
- `tests/e2e/aiSetup.e2e.test.mjs` (2/2): the real app on a fresh profile shows the four layers not installed, details
  with licences and sources, and a set imported from a folder turns «جاهز». Screenshots in `tests/e2e/artifacts/`.
- **End to end on a fresh temporary user-data folder** (`النتائج\ai-setup\setup-e2e.json`):
  - fresh: all four layers `missing`;
  - import everything from the development runtime: 3 runtimes linked after their checks, llama + speech engine
    linked, all 20 sets of that run linked in place (23 folders, **0 copies, 0 downloads**), 217 s (hashing ~110 GB);
  - full hash check of every file afterwards: 0 damaged (303 s); every layer `ready`;
  - perception, takes, links and the B-roll VLM lookup all resolve to the profile's runtime;
  - **missing model detected**: one set folder unlinked → perception `partial`, `missing("emotion")` names the file,
    the stage is skipped; re-import → linked again, `ready`;
  - **broken runtime repaired**: the app installed a real best-take runtime (Python 3.12 download, torch wheels, pip;
    368 s), then opensmile + audinterface folders were deleted and numpy's `__init__.py` truncated → the check names
    the three packages and the failing imports, the page shows the layer `partial` / runtime broken → repair reinstalled
    exactly `audinterface==1.4.0, numpy==2.5.2, opensmile==2.6.0` in **17 s**, check passes. (A first run found that
    Python 3.12's `importlib.metadata` hides RECORD rows of deleted files, so the check missed the deleted folders and
    the repair had to rebuild — fixed by reading RECORD directly.)
  - the real phase runtimes pass the check (two harmless shared-file conflicts — the two OpenCV wheels share `cv2/`,
    two packages ship `docs/conf.py` — are recognised as such).

## 2. Re-measurements (GPU lock `ai-setup`)

### B-roll captions: Qwen3.6 vs Qwen3.5 — **Qwen3.5 stays** (`broll-q36-report.json`)

The 228 test shots re-captioned with Qwen3.6-35B-A3B (4.6 s/shot vs 6.7 s with Qwen3.5), bge re-embedded, phase 9's
search measurement re-run unchanged on the 30 questions:

| config | captions | expansion | R@1 | R@5 | R@10 | MRR (expanded: rrf+rerank+diverse) |
|---|---|---|---|---|---|---|
| before (reproduces phase 9 exactly) | Qwen3.5 | Qwen3.5 | **0.900** | **0.967** | **0.967** | **0.919** |
| captions36 | Qwen3.6 | Qwen3.5 | 0.833 | 0.933 | 0.967 | 0.878 |
| expand36 | Qwen3.5 | Qwen3.6 | 0.867 | 0.933 | 0.933 | 0.882 |
| after (what the app had switched to) | Qwen3.6 | Qwen3.6 | 0.767 | 0.900 | 0.900 | 0.818 |

Adopted: **Qwen3.5 for both** — `findVlm` had silently switched B-roll captions and query expansion to Qwen3.6 once
perception installed it; it now prefers Qwen3.5 (Qwen3.6 is the fallback). The library's captions were already
Qwen3.5's, so nothing in the library changed; the Qwen3.6 caption copy was deleted. Caveat: phase 9 marked the right
answers partly from the Qwen3.5 captions, which may favour them; the expansion-only run has no such bias and is worse
too. Qualitatively Qwen3.6 writes longer English captions but its Arabic has errors (a woman in a cap → «ست بحجاب»).

### perception's windowCheck with Qwen3-Omni — **not better; the default is now Qwen3.6** (`window-check.json`)

Through the app's own code path (`PerceptionService.windowCheck`), on phase 6's labelled spans of 02-تحدي and
06-كوميديا (labelled from frames by the links session — not by the user), the same 29 yes/no questions to the eye alone
(Qwen3.6, a new `qwen3.6` engine of `window_check.py`) and to Qwen3-Omni (frames + the window's sound):

| question | right answer | Qwen3.6 (eye) | Qwen3-Omni (eye + ear) | phase 6 verify (Qwen3.6, multiple choice) |
|---|---|---|---|---|
| a labelled real reaction — is someone reacting? | yes | **7/8** | 4/8 | 7/8 |
| a flagged moment that is not a reaction | no | 2/3 | 2/3 | 2/3 |
| a calm decoy moment (phase 6's controls) | no | 11/12 | **12/12** | — |
| the labelled cause — did it cause the reaction? | yes | 3/3 | 3/3 | — |
| another candidate — did it cause the reaction? | no | **2/3** | 0/3 | — |
| **total** | | **25/29** | 21/29 | |

Omni misses reactions it should hear (it calls 02's laugh at 27 s and the hands-on-heads at 92 s "conversation"), says
"yes, that caused it" to every wrong candidate, and calls the crying toddler's moment (06 R011) a laugh. Adopted:
`WINDOW_CHECK_ENGINE = "qwen3.6"` (Omni stays selectable). Speed: Qwen3.6 ~1.3 s a question; Qwen3-Omni 2–6 s on 06
but 14–390 s on 02 — with the user's other apps on the card (Premiere, LM Studio, browsers) the 20 GB Omni spilled out
of VRAM (prompt eval fell from ~1,200 to 7–100 tokens/s). Small sample (2 files, labels not the user's).

### best-take judge with Qwen3-Omni — **the position bias is gone; adopted** (`judge-bias.json`)

New worker `takes/workers/judge_omni.py` (Qwen3-Omni GGUF on llama.cpp: each take's sound + 6 keyframes, the same
question as phase 5's judge, answer forced to A/B, both orders). Both judges got the same 8 pairs: 5 real sentences
(01, 03, 04, 05, 06) played clean vs degraded (white noise, darkened, washed out, shaking — made with FFmpeg from the
raws, removed afterwards), 06's false start vs the full take, and two pairs without a right answer (01's two full takes,
05's clean take against itself). 02 had no 3.5–7 s sentence.

| judge | consistent in both orders | right where known | share of "A" answers (0.5 = no position bias) | same letter both orders | time |
|---|---|---|---|---|---|
| Qwen2.5-Omni-7B (phase 5) | 1/8 | 1/6 | 0.06 (answered "B" 15 of 16) | 7/8 | — |
| **Qwen3-Omni-30B-A3B** | **7/8** | **6/6** | **0.44** | 1/8 (the identical-takes control) | 137 s for 16 questions incl. a 20 s load |

Adopted: `JUDGE_ENGINE = "qwen3-omni"` (`takeService.js`, `judgeJob()`; Qwen2.5-Omni stays selectable), and the takes
layer borrows perception's Qwen3-Omni set; Qwen2.5-Omni-7B left the catalog. The judge is still asked only when the
caller passes `judge: true` (close calls only) — the director may now turn it on; it was not turned on here. A 32k
context made the model spill out of VRAM (2–3 min a question); 8k is enough (prompts ≈ 1.8k tokens). Small sample:
the degraded takes are an easy test; real retakes with subtle differences need the user's picks.

## Files touched

Own column: `src/services/aiSetup/**`, `src/services/aiSetupService.js`, `src/renderer/js/pages/aiSetup.js`,
`src/services/perception/perceptionService.js` (stage skipping), `src/services/perception/workers/window_check.py`
(qwen3.6 engine), `src/services/takes/takeService.js` (judge engines), `src/services/takes/workers/judge.py` (per-take
media), new `src/services/takes/workers/judge_omni.py`, `src/services/broll/llm.js` (VLM order, junctions),
`tests/unit/aiSetup.test.js`, `tests/e2e/aiSetup.e2e.test.mjs`.
Shared, appended blocks: `src/main/ipc.js`, `src/preload/preload.cjs`, `src/services/index.js`, `src/renderer/js/i18n.js`.
**Outside my column (for the coordinator):** `src/renderer/js/pages/home.js` — 3 lines: import `aiSetupView`, a nav item
«تجهيز الذكاء» after «توليد الفيديو», a view branch. Without them the page is unreachable (the service and IPC work).
No new npm packages. No new Python environments on the shared runtime.

## For the user's installed app

`%APPDATA%\Montaj Studio\runtime` has today only `asr` and junctions to dub/llama/sep — none of the AI layers. After this
branch ships: «تجهيز الذكاء» › «استورد الموجود من فولدر…» › `D:\capcut new\montaj-studio\runtime` links everything
(≈ 4 min of hash checks, no copy). Not done for the user (their real profile was never touched).

## Open risks / needs

- Two sets are import-only on a new PC: pyannote community-1 is gated (the user accepts on Hugging Face and imports the
  folder; the stage is skipped meanwhile) and TransNetV2's converted weights (no official PyTorch file; the shots stage
  is skipped, perception falls back to 12 s windows). AdaFace is optional.
- The media venv's `.pth` points at the video runtime next to it; `mediaRuntime()` rewrites it to whichever runtime
  folder calls it (phase 9's design) — with junctions, the dev checkout and the app flip it between two valid paths.
- `runtime\video` is linked into a profile by "import everything" when the B-roll runtime needs it: the video studio
  then sees its runtime as installed too (it is the same runtime).
- A layer's "prepare" downloads up to ~47 GB (perception); the page shows the size and licences first.
- Qwen3-Omni (20 GB) and Qwen3.6 (19 GB) need most of the card: with Premiere / LM Studio / browsers using VRAM they
  spill into shared memory and slow down 10–100×. The page warns only by total VRAM, not by what other apps hold.
- All three re-measurements are small samples; none uses the user's own labels or picks.
- For `director2`/the coordinator: the judge can now be worth enabling on close calls (`takes.analyze({judge: true})`);
  `windowCheck` defaults to Qwen3.6; B-roll uses Qwen3.5 (needs the dubbing translator installed).

## Disk (clean-up per `D:\capcut new\CLAUDE.md`)

Before deleting, each item was searched for in `src/`, `bench/`, `scripts/` of the main checkout and every worktree
(no reference), checked for links inside (none), and none is used by a running session.

**Removed:**
- the temporary test profile `D:\capcut new\_tmp-ai-setup\profile` — 28 junctions unlinked first (never followed), then
  the app-installed test runtime (Python 3.12 + best-take venv): 4.4 GB; the first profile (hard links only): ~0;
- `D:\capcut new\_tmp-ai-setup\` — the judge's synthetic clips (43 MB), the window-check frame cache (8 MB), the Qwen3.6
  caption copy of the B-roll index (67 MB, the losing caption set), e2e notes: 0.12 GB in all;
- `%TEMP%\ai-setup-judge-rt` (hard links into the Hugging Face cache: freed nothing, removed only the names);
- unused model files in `runtime\models\perception`: InsightFace `1k3d68.onnx`, `2d106det.onnx`, `genderage.onnx`
  (the zip's 3 models the faces stage never loads), LR-ASD / Light-ASD `pretrain_*` weights (only the TalkSet ones are
  used), `adaface-src\` (the source checkpoint the AdaFace ONNX was exported from; huggingface.co/minchul/
  cvlface_adaface_ir101_webface12m has it) and `transnetv2\tf\` (the TF weights the PyTorch file was converted from;
  GitHub soCzech/TransNetV2 LFS has them): 0.46 GB;
- the catalog builder's scratch (hash cache, downloaded archives — `buffalo_l.zip`, the LibreFace nupkg): removed by the
  builder itself / 48 KB; the page screenshots in `tests\e2e\artifacts` (copied to the results folder).

**Kept:**

| what | where | size | why |
|---|---|---|---|
| perception runtime | `montaj-studio\runtime\perception` | 4.2 GB | used by perception + links (unchanged) |
| best-take runtime | `montaj-studio\runtime\takes` | 4.1 GB | used by best take (unchanged) |
| perception models | `montaj-studio\runtime\models\perception` | 40 GB (was 40.5) | every file is in the catalog and used |
| best-take models | `montaj-studio\runtime\models\takes` | 0.18 GB | used |
| B-roll models + Qwen3.5 projector | `montaj-studio\runtime\models\media` (B-roll part) | 23.8 GB | used; Qwen3.5 adopted |
| B-roll library index | `assets-library\broll-index` | 67 MB | unchanged (its captions were already Qwen3.5's) |
| results | `montaj-bench\النتائج\ai-setup\` | 0.4 MB | reports, scripts, page screenshots, Arabic summary |
| this worktree | `worktrees\ai-setup` | small | branch not merged; junctions `runtime`, `node_modules`, `src\services\asr\models` — unlink them first |

**Reported, not deleted (shared cache — the user decides):** Qwen2.5-Omni-7B in the Hugging Face cache
(`%USERPROFILE%\.cache\huggingface\hub\models--Qwen--Qwen2.5-Omni-7B`, 22.4 GB): the program no longer needs it (the
judge is Qwen3-Omni now) unless someone picks `judgeEngine: "qwen2.5-omni"`. pip / uv / npm caches untouched.
