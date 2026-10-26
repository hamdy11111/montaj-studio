# HANDOFF — `best-take` (Phase 5 of PLAN_editor_and_graphics.md: choosing the best take by performance)

Branch `phase5-best-take` (worktree `D:\capcut new\worktrees\best-take`), based on `main` 1eb5672. Nothing pushed,
nothing merged. Plan: section 2 «البند 4: اختيار أحسن لقطة وإعادة», phase 5 of section 3.

## What was built

For every retake group that phase 2 finds (`core/speech.js` `retakeGroups`: the same line said again, by meaning),
every take is **measured**, the takes are **compared with each other only**, and the group gets a kept take, a margin,
and a reason in English and Egyptian Arabic — the stable `montaj.takes/1` JSON below, which the director consumes.

```
src/core/takeScore.js                    pure scorer: signals, relative scores, gates, weights per content type,
                                         judge rule, learning from picks, agreement measurement, scoreFn adapter
src/services/takes/features.js           pure: per-take signals from the words + perception's event timeline
src/services/takes/takeService.js        TakeService: groups → worker → score → (judge) → montaj.takes/1; published → picks
src/services/takes/picks.js              PickStore (picks.json + weights.json), takeFromCoverage (published cut → kept take)
src/services/takes/pickPage.js           the Arabic pick page («اختار الإعادة») — the user picks by hand when nothing is published
src/services/takes/cli.mjs               command line (bench / published matching / import picks / measure)
src/services/takes/workers/take_features.py   openSMILE, DNSMOS, YuNet + MediaPipe + LibreFace, L2CS, picture gate
src/services/takes/workers/fingerprint.py     published ↔ raw by landmark audio fingerprints
src/services/takes/workers/judge.py           AI tie-breaker: Qwen2.5-Omni-7B (sees + hears both takes), both orders
src/services/takes/workers/tcommon.py         worker plumbing (same contract as perception's workers)
tests/unit/takes.test.js                 12 tests
```

### The signals (all compared between the takes of one group)

| signal | measured by | better | jnd |
|---|---|---|---|
| fillers — «يعني، امم، بص…» per word (speech.js `fillers`, in context; «ايه» glued to the word before = question, not filler) | words | low | 0.08 |
| pauses — in-sentence pause (≥ 0.25 s) per second of speech | words | low | 0.12 s/s |
| asrConf — recogniser confidence | words | high | 0.06 |
| rateSteady — CV of letters/second over the words | words | low | 0.12 |
| timing — beat before the punchline: longest gap in the 2nd half minus the typical gap; > 1.5 s counts against | words | high | 0.12 s |
| pitchVar — F0 semitone stddevNorm | openSMILE eGeMAPSv02 | high | 0.04 |
| loudness — log2 of mean loudness | openSMILE | high | 0.25 |
| emotion — happy+surprised+angry − neutral − sad, overlap-weighted | perception's emotion2vec+ | high | 0.12 |
| quality — DNSMOS P.835 OVRL (also a gate) | DNSMOS | high | 0.2 |
| smile — mean √(AU6·AU12) (real smile needs both) | LibreFace 2.0 (ONNX) | high | 0.25 |
| brows — std + ¼ mean of (AU1+AU2)/2 | LibreFace | high | 0.12 |
| blinks — blinks whose middle falls inside a word, per second | MediaPipe blendshapes | low | 0.25 |
| onScreen — share of the take the speaker's face is tracked | perception (faces + voice↔face link) | high | 0.15 |
| gaze — share of frames within 15° of the camera | L2CS-Net Gaze360 | high | 0.15 |
| laughter — seconds of laughter in [end − 0.3 s, end + 3 s] (until 0.5 s into the next take); other voices ×2, AudioSet laugh tags ×1 | perception | high | 0.3 |

How a raw value becomes a score: `rel = 0.5 + 0.5·tanh(±(x − group mean) / jnd)`. Below one jnd two takes score
almost the same, so measurement noise cannot flip a choice by itself (measured: two identical takes differ by ≤ 0.012
in total score — see "Tests"). A signal that one take of the group lacks (no face on screen, no timeline, model not
installed) is dropped for the whole group (`signalsPartial`) and the other weights are renormalised. The total is
`Σ w·(rel − 0.5) / Σ w` (−0.5…0.5) + 0.01 for the last complete take (equal performances → phase 2's default).

**Eligibility before score:** a false start / incomplete take is never kept while a complete take exists; **gates**
(relative too, and only when some take passes): `sound` (DNSMOS OVRL more than 0.8 below the best and under 2.6, or
under 2.0 while the best is ≥ 2.6), `dark` (luma < 60 % of the best), `shaky` (median frame jitter > 2.5× the
steadiest and > 2 px at 320 px wide; a deliberate pan barely moves the median). DOVER is **not** used: the plan keeps
it only as a dark/shaky gate, and these direct measurements do that job for takes from the same camera; no DOVER
weights downloaded.

**Weights per content type** (`TYPE_WEIGHTS`): `comedy` (timing 2, laughter 2, smile 1.2, emotion 1, pitchVar 1,
pauses 0.3…), `explainer` (fillers 2, gaze 1.8, pauses 1.5, asrConf 1.2, rateSteady 1, timing 0…), `vlog`,
`interview` (gaze 0 — the guest looks at the host), `cooking`, `challenge`, `default`. `typeFromName` guesses the type
from a folder/file name (bench: 01 vlog, 02 challenge, 03 cooking, 04 interview, 05 explainer, 06 comedy).

**AI tie-breaker** (`--judge` / `analyze({judge: true})`): only for close calls (margin < 0.06). Qwen2.5-Omni-7B thinker
(bf16, from the local Hugging Face cache, sees 2 fps frames at 320 px and hears the take) is asked "which take would an editor
keep — A or B" twice, with the order swapped; `judgeVerdict` counts it only when both orders name the same take,
otherwise the score stands (`judge.consistent: false`). Takes the GPU lock (~20–21 GB peak). Measured so far: position
bias on every pair (see Tests) — it is wired and safe, but useless until a better judge (Qwen3-Omni, Claude) replaces it.

**Learning from the user's picks** (`PickStore`, `learnWeights`): a pick is stored with the scored group (every take's
relative signal scores), so weights can be relearned whenever the scorer changes. Pairwise (Bradley–Terry) logistic
loss summed over (picked, other) pairs, plus λ·‖w − w_type‖² (λ = 1): 3 consistent picks nudge, 6 flip a 3:0.5 prior,
20 move it far. Weights stay in [0, 5], per content type, saved to `weights.json`; `analyze` uses them automatically
(`weightsSource: "learned from N pick(s)"`). Two ways picks arrive:
- **published video:** `fingerprint.py` (landmark hashes of 8 kHz spectral peaks; offsets per 4 s window, then each
  0.25 s bin of the published sound assigned to the offset its own hashes agree with) gives the raw spans the cut used;
  `takeFromCoverage` keeps the take covered ≥ 60 % (none, or two covered = no pick: the line was cut, or a deliberate
  repeat). `cli.mjs --published <video> --raw <files…>`.
- **by hand:** `<out>/اختار-الإعادة.html` plays every take of every group from the raw file in place (no copy), shows the
  program's choice and why, and «احفظ اختياراتي» downloads `takes-picks.json`; `cli.mjs --import-picks <file>` stores it.

`cli.mjs --measure` / `PickStore.measure()`: agreement with the picks of (a) the scorer as it chose, (b) the default
weights, (c) learned weights in leave-one-out, (d) phase 2's last-complete take — each next to random (mean 1/n) and
"always the last take" (Descript).

### The output contract `montaj.takes/1` (for the director, phase 7)

```
{ version: "montaj.takes/1", schema: "montaj.takes/1",
  media: { path, name, hash },                 // hash = perception's fileHash (same cache key)
  type: "comedy" | "explainer" | "vlog" | "interview" | "cooking" | "challenge" | "default",
  weightsSource: "default" | "learned from N pick(s)" | "given",
  signals: { <name>: { group, better, jnd, source, en, ar } },
  missing: [ "why a stage/signal is unavailable" ],
  groups: [ {
    line, fromUs, toUs,                         // source µs of the media
    type, signalsUsed: [names], signalsPartial: [names], weights: { name: w },
    takes: [ { index, fromUs, toUs, text, kind: "full"|"partial"|"false-start", complete,
               scores: { <every signal>: { raw: number|null, rel: 0…1|null } },
               gates: ["sound"|"dark"|"shaky"], perf, total, eligible, ineligible: [reasons],
               info: { speaker, entity, faceMode, faceFrames, frames, aus, gazeDeg, dnsmos, prosody, video },
               t0, t1, score, why? } ],         // director-adapter aliases: seconds; score 1 = kept, total+0.5 (≤ 0.99) for
                                                // other eligible takes, 0 = left out; why = reasonAr on the kept take
    defaultKept,                                // phase 2's choice (last complete take)
    kept, best /* = kept */, runnerUp, margin, closeCall,
    keptBy: "score" | "last-complete" | "judge",
    judge: null | { model, ab, ba, consistent, verdict: "leader"|"runnerUp"|null },
    reason, reasonAr } ],
  timings: { ms, workerMs } }
```
The `schema`, `best`, `t0`/`t1`/`score`/`why` aliases match the shape in the director's notes (director-notes.md), so its
adapter reads this result as is. Stable: field names above, `kept` is an index into `takes`, times are source µs of the media (same as
`retakeGroups`). **Adapter for the director:** `scoreFn(result)` from `core/takeScore.js` returns a
`score(take, group)` that `retakeGroups(words, { score })` / `chooseTake` accept — it reproduces the result's choices
(matched by time ± 200 ms), so the director changes one argument and keeps everything else (drops, cut sheet,
`plan.retakes`; `reason` becomes "best performance"). Getting the result: `services.takes.analyze({ media: file.path,
words, groups, type })` (pass the director's own words/groups so the times match exactly; the timeline is read from
perception's cache when it exists).

## Files touched
Own column: everything under `src/services/takes/**`, `src/core/takeScore.js`, `tests/unit/takes.test.js`, this file.
Shared, appended: `src/services/index.js` — one import line, one block creating `takes` after perception
(`TakeService` with perception, the GPU queue as lock, `takes-picks` in the data folder), `takes` added to the returned
object. No IPC / preload / i18n / UI yet (the pick page is a standalone HTML for now).
Read, never edited: `src/core/speech.js` (retakeGroups, fillers), `src/core/policy.js` (`POLICY.retakes`),
`src/services/perception/perceptionService.js` (`fileHash`, `makeGpuLock`), perception timelines.

## Runtime and models (never in git)

`runtime\takes` — new venv (Python 3.12 from `runtime\python312`): torch 2.11.0+cu130, torchvision 0.26, torchaudio,
opensmile 2.6.0, mediapipe 1.1.1, onnxruntime-gpu 1.31, opencv-python-headless 5.0, librosa, soundfile, scipy,
transformers 5.20.2, accelerate, safetensors.

`runtime\models\takes\` (183 MB):

| model | source (official) | licence | size |
|---|---|---|---|
| DNSMOS P.835 `sig_bak_ovr.onnx` | github.com/microsoft/DNS-Challenge `DNSMOS/DNSMOS` | CC-BY-4.0 (repo LICENSE) | 1.4 MB |
| MediaPipe Face Landmarker `face_landmarker.task` (float16 v1) | storage.googleapis.com/mediapipe-models (Google) | Apache-2.0 | 3.7 MB |
| LibreFace 2.0 ONNX (AU encoder + intensity + presence, FE) | nuget.org/packages/LibreFace 2.0.0 (ihp-lab, the authors' own .NET package) | USC research licence (non-commercial — personal use OK) | 90 MB |
| L2CS-Net ResNet50 Gaze360 `l2cs_gaze360_resnet50.safetensors` | huggingface.co/py-feat/l2cs (Py-Feat's re-host of the authors' weights; the authors' Google Drive folder now returns 404) | code MIT, weights under Gaze360 terms (non-commercial) | 96 MB |
| YuNet `face_detection_yunet_2023mar.onnx` | github.com/opencv/opencv_zoo | MIT | 0.2 MB |
| openSMILE (pip `opensmile`) | PyPI, audEERING | audEERING research licence (non-commercial / personal OK) | — |
| Qwen2.5-Omni-7B (judge) | already in the user's HF cache (`~\.cache\huggingface`), **not downloaded**; `judgeModelPath` also looks in `models\takes\qwen2.5-omni-7b` | Apache-2.0 (Qwen) | 21 GB (cache) |

Not downloaded: DOVER (replaced by direct dark/shaky gates, see above), emotion2vec+ (perception already runs it),
laughter-detection / PANNs (perception's), Qwen2-Audio (the Omni model sees and hears).
For the installed app the venv and models must be reachable from `%APPDATA%\Montaj Studio\runtime` or the project's
`runtime\` (`findRuntime`) — no in-app set-up step yet.

## Tests and results

- `npm test` in the worktree: **189 / 189 pass** (177 before + 12 new in `tests/unit/takes.test.js`).
- Bench run (`node src/services/takes/cli.mjs "D:\capcut new\montaj-bench\الحالات" --out …\النتائج\best-take --timelines
  …\النتائج\perception`): results `*.takes.json` and the pick page in `D:\capcut new\montaj-bench\النتائج\best-take\`,
  Arabic summary `اقرأني.md` there. Worker time ≈ 12 s per group of two takes (4K HEVC decode dominates).
- **Real retake groups on the bench: 2 in 21 minutes** (01 «امال عايز ايه» ×2, 06 «بطاريه العربيه» false start + full),
  and in both the first take is incomplete/false start, so only one take was eligible: the scorer agrees with phase 2
  by construction. **No published versions exist** (every `المنشور` folder is empty) **and no hand picks yet**, so the
  agreement with the user is **not measured** (n = 0); random would be 50 %, "last take" 100 % on these two.
- Real-footage checks that do not need picks:
  - **gates + repeatability** (case 05, a real 6 s sentence played as 3 takes: clean, the same with white noise +
    darkened + shaken, clean again): the degraded take fails `sound` (OVRL 1.71 vs 2.66), `dark` (luma 42 vs 121) and
    `shaky` (15.5 vs 0.1 px); the two identical clean takes score 0.024 vs 0.006 (margin 0.012 → a close call, as it
    should be); face found in 56/56 frames of each.
  - **published → kept take** (synthetic "published" cuts of 01's raw, with pink noise and a tone mixed over the speech):
    kept take 2 → found, coverage [0, 0.87]; kept take 1 (1.3 s, also sped up 3 %) → found, [0.93, 0].
  - **the AI judge** (`judge-check.json`): Qwen2.5-Omni-7B answered the same letter in both orders on all 5 pairs —
    01 and 06 ("B"/"B"), clean vs degraded ("B"/"B" both ways, i.e. it picked the noisy, dark, shaky take when it was
    shown second) and the two identical clean takes ("A"/"A"). Pure position bias: the both-orders rule threw every
    answer away, as designed. **The judge adds nothing today**; it stays off by default. 66–82 s per run, peak 20.2–20.9
    GB (at 448 px frames a 6 s pair overflowed 24 GB and stalled — frames are now 320 px).
  - LibreFace alignment checked by eye (aligned 224 crop of 01's speaker is upright and centred); AU12/AU6 high on a
    smiling face (2.1 / 1.3). L2CS on sunglasses gives ~33° (no eyes visible) — gaze is meaningless behind sunglasses.

## Needs a practical test on the user's footage
- **Agreement with the user**: open `النتائج\best-take\اختار-الإعادة.html` (and future cases with real retakes), pick,
  send `takes-picks.json`; then `cli.mjs --import-picks … && cli.mjs --measure`. Better: a raw with many retakes
  (a sketch or an explainer shot line by line) plus its published cut → `cli.mjs --published … --raw …`.
- The per-type weights are reasoned defaults, not fitted: they need those picks.
- The joke-timing signal (`timing`) is a heuristic (a beat that stands out from hesitations); the plan says research
  disagrees on a fixed number — it is relative between takes, but unverified on real punchlines.
- The judge is position-biased on every pair tried (5/5); keep it off (it is off by default). Worth retrying with
  Qwen3-Omni (perception's hook) or Claude when available — the rule and the plumbing stay.
- Face signals depend on perception's voice↔face link: when the speaker is off screen (the person filming) they are
  absent by design; with `linkConfidence` < 0.8 the face may be the wrong person.

## What the director (phase 7) needs to do
- After `retakeGroups`, call `services.takes.analyze({ media, words, groups, type })` (or read a cached result) and pass
  `scoreFn(result)` as `score` (or simply take `result.groups[i].kept`). Show `reasonAr` in the cut sheet. Keep phase 2's
  default when the service is missing (no venv) — `analyze` still works without the worker (words + timeline signals
  only) when `stages: []`.
- `type`: pass the treatment's content type when the director knows it; otherwise `typeFromName`.

## Open risks
- Data: 2 real groups, both trivial. Nothing about the user's taste is measured yet.
- DNSMOS on short takes (< 9 s) uses the reference recipe (the clip repeated to 9 s); outdoor phone audio scores 1–2
  OVRL — hence the gate is relative and loose.
- `fingerprint.py` assumes the published sound keeps the raw speech (music under it is fine; a full voice-over or heavy
  pitch shift is not). Speed ramps beyond a few % break the per-window offsets.
- The 4K HEVC decode per take is the main cost (≈ 6 s per take); fine for a handful of groups, slow for a raw with
  hundreds of retakes — reuse perception's GPU-resize decode if that happens.

## Disk (clean-up per `D:\capcut new\CLAUDE.md`)

Removed (nothing in `src/`, `bench/` or `scripts/` uses them; no links inside; all mine):
- the session scratchpad: the synthetic test media (`synthetic05.mp4` + its clean/degraded parts, two "published"
  WAVs cut from 01's raw audio), worker/judge job and output files, debug crops, logs — 48 MB;
- `runtime\takes-cache\` — the feature and fingerprint cache of the test runs (21 KB; recreated on demand);
- `runtime\models\takes\dnsmos\model_v8.onnx` (DNSMOS P.808, not used) and `dnsmos_local.py` (reference script) — 0.2 MB;
- the empty bench pick store `النتائج\best-take\picks\` and the `gdown` package in `runtime\takes` (only used for a
  failed L2CS download attempt);
- `src/services/takes/workers/__pycache__` in the worktree.

Kept (used by the code or meant for the user):
- `runtime\takes` — the venv the workers run in: 4.1 GB;
- `runtime\models\takes` — DNSMOS, MediaPipe, LibreFace, L2CS, YuNet: 183 MB;
- `montaj-bench\النتائج\best-take\` — the six `*.takes.json`, the pick page, `measure.json`, `judge-check.json`,
  `اقرأني.md`: ~60 KB;
- the worktree `D:\capcut new\worktrees\best-take` (branch not merged yet) with its junctions `runtime`,
  `node_modules`, `src\services\asr\models` and the git-ignored `npm run build:graphics` output the tests need.
  When the branch is merged: unlink the three junctions first (`rmdir`), then remove the worktree.

Shared caches, reported only (not deleted): the pip cache (`%LOCALAPPDATA%\pip\cache`, 14 GB in total; this phase
added the torch cu130 wheels to it) and the Hugging Face cache, where the judge's Qwen2.5-Omni-7B (21 GB) already was
before this phase.
