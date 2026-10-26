# HANDOFF — `director2` (round 4: the director's follow-ups)

Branch `r4-director2` (worktree `D:\capcut new\worktrees\director2`), based on `397ac7b`. Nothing merged or pushed.
Results: `D:\capcut new\montaj-bench\النتائج\director2\` (Arabic summary `اقرأني.md`).

## What was built

### 1. The precise verifier (forced alignment instead of a second transcription)
`src/core/verifier.js` (pure) + `src/agent/director.js` `alignExport` / `verifyExport`.
- The words the plan keeps (the app's own words, in edit time) are **force-aligned onto the export's sound** with
  perception's Arabic wav2vec2 worker (`src/services/perception/workers/align.py`, unchanged; run by a small runner in
  `agent/director.js`, since `perceptionService` keeps its `runWorker` private).
- The export's sound is laid out with **0.6 s of silence after every segment** (`alignLayout`, `layoutAudio`,
  `wavBytes`). A word whose sound was cut at a joint cannot borrow the next segment's sound: its letters are pushed
  past the cut into the silence.
- `verifyAligned`:
  - `out.clippedWord` (fail): a joint word whose letters run ≥ 120 ms past its segment;
  - `out.lineMissing` (fail, important lines) / `out.lineWeak` (warn): a line (≥ 3 aligned words) whose median letter
    probability is under 45 % of the file's own median.
  - Judged against the file's own alignment quality, never an absolute number.
- `withAlignment` swaps the transcription's speech checks for these; loudness, black and frozen frames are unchanged. The
  line-settling by sound (envelope correlation with the source) still runs on what the alignment flags.
- **Fallbacks:** no speech runtime / no model / too few words → the old re-transcription (`stats.method`).
  `DIRECTOR_VERIFY_METHOD=both` runs both (the bench).
- **Egyptian text for the aligner** (`alignText`):
  - a word-final ه / ة is said as a vowel («التركيه» torkeyya), but wav2vec2 aligns the letter ه to breath and room
    noise. It is left out, except in the few words that say a real h (الله، فيه، ليه…);
  - tanween adverbs written with ا («مثلا»، «طبعا») are read with ن.
  - Before this, 10–17 joint words per talking video looked cut on perfectly clean renders.
- **The window is short on purpose (pad 0.15 s):**
  - With 0.3 s the aligner dragged a line's last letter to the window's edge: on 01, 13 joint words "spilled"
    165–187 ms, which is exactly 0.3 s minus the director's ~135 ms margin.
  - With 0.15 s a drag stays ≤ 90 ms (the director's smallest margin is 60 ms). The threshold is 120 ms.
- **CPU by default:** the same result as on the card (mean |Δconf| 0.0001, identical times on 550 words), ~15 s per
  3.5-min export plus ~30 s to load. It never waits for the shared GPU (my first bench run sat ~30 min behind other
  sessions' locks). `DIRECTOR_VERIFY_DEVICE=gpu` uses the card, under the app's GPU queue and the machine-wide lock
  (`DIRECTOR_GPU_LOCK_NAME` sets the lock's name).
- `edgeLevels` reports the sound level at every cut with a flagged word. It is information only: in a noisy outdoor
  vlog a cut inside a word sits just 3–13 dB over the room noise, so a level gate failed.

### 2. No spoiler
`src/core/treatments.js` (`avoidSpoilers`, `spoils`, `SPOILER_AT`), `src/services/directorLLM.js` (`planPrompt`),
`src/core/director.js` (`DIRECTOR_STYLES.explain.noSpoiler`), `src/agent/director.js`.
- A **result or reaction flash-forward never comes from the ending**:
  - not from the last 40 % of the story (story order when there is one, else time);
  - not from the payoff of a promise.
- The question hook and «من وسط الأحداث» are untouched.
- Rules: `hookMoment` skips spoiling moments. A treatment without a result becomes «الحكاية كاملة بترتيبها».
- Planner treatments: `validateTreatment` drops a spoiling hook (the fix is listed on the cut sheet), and the planner
  prompt says so.
- **When:** `spoiler: "auto"` (default) turns it on:
  - for the `explain` style;
  - for an explainer by `contentType` or by the project / file name (`typeFromName`: «شرح»، tutorial…).
  - `"avoid"` / `"allow"` force it. The dialog has a «الافتتاحية» select, and the decision shows on the cut sheet.

### 3. Keep the action's sound (`plan.audio.keepAmbience`, the contract with `audio-export`)
`src/core/treatments.js` (`executionSpec(…, { ambience })`, `AMBIENT_CORE`), `src/core/director.js` (`toPlanV2(…,
{ ambience })`), `src/core/editPlan.js` (schema), `src/agent/editPlan.js` (hand-over), `src/agent/director.js`.
- The plan carries `audio.keepAmbience: [{ mediaId, fromUs, toUs }]`:
  - SOURCE spans of the real files, split at clip joints;
  - every kept wordless action moment, or one with a reaction;
  - only when the clean-up is on.
- `applyPlan` hands it to `exporter.setKeepAmbience(timelineId, list)` when the export service has that method (from
  `r4-audio-export`). A plan without spans clears old ones. Before that branch is merged the field is simply ignored.
- **The work-arounds stay behind that check** (`ambience = typeof S.exporter.setKeepAmbience === "function"`, or
  `opts.ambience`):
  - without it, the executor does what phase 7 did: no clean-up for action videos, < 2 s beats in talking videos, one
    beat per quiet stretch;
  - with it:
    - an action video keeps the clean-up for its speech (denoise on, no voice EQ) and its action keeps its sound;
    - in a talking video, action with a **heard reaction** (laughter, applause, a loudness burst) keeps up to 3.5 s
      beats, one after another;
    - quiet picture-only action stays a short beat (its sound is still kept). Measured: 01's walking shots kept 3.5 s
      read as dead air again.

### 4. Music as a real music track
`src/agent/editPlan.js`, `src/core/editPlan.js`.
- An edit plan's `music` items go through `placeMusicBed`: each on its own music track that ducks under the speech
  (`duckDb`, default 12).
- Level: `MusicBedService.levelFor` (16 LU under the speech) unless the plan sets its own `volumeDb` (or
  `autoLevel: false`).
- The plan's `fadeUs` overrides the bed's own fades.
- Schema and cut-sheet text updated. (The director itself writes no music yet; this is for plans from the planner,
  skills and agents.)

### 5. Agent operations (`src/agent/operations.js`)
- `edit_auto`:
  - new inputs `story`, `storyHints`, `storyPlanner`, `spoiler`, `contentType`;
  - the description covers the story order, no spoiler and the kept action sound.
- New operations:
  - `musicbed_place` → `music.bed.place`;
  - `musicbed_set_duck` → `music.bed.setDuck`;
  - `timeline_set_jl` → the `setJL` command.
- `edit_plan_schema` description: music beds and `audio.keepAmbience`.

### 6. The same people across clips (story order)
`src/core/story.js` (`crossFilePeople`, `SAME_VOICE`, `describeSegments(…, { people })`), `src/agent/director.js`
(`peopleAcrossFiles`).
- **Voices:** perception's diarization stage file (`speakers.<key>.json`, beside the timeline) keeps one pyannote
  embedding (256-d) per speaker. Voices of different files are one person when their cosine is ≥ 0.75 and each is the
  other's best match.
- **Faces:** a face joins its person through its own file's face ↔ voice link (`faces[].voice`).
- `people` in the story's continuity then counts the same person across clips.
- **Measured on the six bench raws** (all speakers, all file pairs):
  - same-file different speakers ≤ 0.44; different people ≤ 0.59;
  - joined: 03·S1 = 05·S1 (0.946), 03·S1 = 01·S2 (0.82), 05·S1 = 01·S2 (0.84) — the same woman in the face
    thumbnails (03·P1 / 05·P1 / 01·P2);
  - 01·S1 / 04·S2 / 06·S2 joined at 0.76–0.85: a man in all three thumbnails, not confirmed by eye;
  - 06·S1 (an off-screen voice) joined the woman at 0.79.
- **What perception must expose for faces:** faces carry no cached embedding (only crops, `faces/tracks/<id>.npy`).
  To match a face that never speaks, `faces.py` should save a mean ArcFace/AdaFace embedding per identity
  (`identities[].embedding`, normalised).

## Files touched
- Mine (column): `src/agent/director.js`, `src/core/director.js`, `src/core/treatments.js`, `src/core/verifier.js`,
  `src/core/story.js`, `src/agent/editPlan.js`, `src/core/editPlan.js`, `src/agent/operations.js`,
  `src/services/directorLLM.js`, `src/renderer/js/editor/director.js`.
- New: `tests/unit/director2.test.js` (15 tests).
- Shared, appended: `src/renderer/js/i18n.js` (block «Round 4 — director2»).
- No npm packages, no models, no downloads. `align.py` and `fuse.js` (perception) are used as they are.

## Tests
- `npm test` in the worktree: **260 / 260** before merging `main` (397ac7b: 245), **281 / 281** after.
- The combination with `r4-audio-export` (merged uncommitted in a throwaway worktree): **267 / 267**. The only merge
  conflict is the i18n append blocks (keep both).
- `director2.test.js` covers:
  - the aligner text;
  - the layout and audio;
  - a clean export passes, a word cut at either side of a joint fails, a lost important line fails;
  - too few words → not judged;
  - `withAlignment`;
  - `alignExport` end to end with a fake worker (CPU job, temp folder removed);
  - `edgeLevels`;
  - no spoiler: rules, validator, prompt and the defaults;
  - keepAmbience in talking and action videos, and the schema;
  - `crossFilePeople` and its effect on the story's people sets;
  - `applyPlan` → `setKeepAmbience` (and clearing);
  - music beds on music tracks at the measured / own level;
  - the three new operations and `edit_auto`'s inputs.

## Measured
All in `D:\capcut new\montaj-bench\النتائج\director2\` (Arabic: `اقرأني.md`).
- **Driver:** `run_director2.mjs`, phase 7's `run_director7.mjs` plus the verifier run both ways and round 4's decisions
  recorded.
  - Same six cases, rules planner, 1080p export in the source orientation, stabilization and person tracking off.
  - Measured with the main checkout's `bench/quality.mjs`.
- **Two runs:**
  - `rules\` is this branch alone. The export has no `setKeepAmbience`, so the old work-arounds apply.
  - `keep-ambience\` is this branch with `r4-audio-export` merged uncommitted in a throwaway worktree (since deleted).
- **Re-verified:** `reverify2.mjs` ran the final verifier on every export, with the bench profile's own words.
- **After merging `main` into this branch** (`fd03abe`: audio-export, asr-ab, ai-setup; 281 / 281 tests), 02 and 05
  were run once more on the merged code (`merged\`). The numbers match `keep-ambience\` exactly:
  - 02: 5/6, −14.47 LUFS, 0 dead air, 15 spans;
  - 05: 6/6, 0 dead air, opens at 44 %, 32 spans, «action sound kept (32)» in the applied steps.
  - The old work-arounds are off by themselves, since `setKeepAmbience` exists now.

| case | phase 7 | rules | + keepAmbience |
|---|---|---|---|
| 01 vlog | 1:31 · 5/6 · dead air 1 | 1:31 · 5/6 · dead air 1 | 1:38 · 5/6 · dead air 1 · 13 spans |
| 02 challenge | 1:23 · 5/6 | 1:23 · 5/6 | 1:23 · 5/6 · clean-up ON, −14.47 LUFS, 0 dead air |
| 03 cooking | 2:28 · 5/6 | 2:28 · 5/6 | 2:28 · 5/6 |
| 04 interview | 2:56 · 5/6 | 2:56 · 5/6 | 2:56 · 5/6 |
| 05 explainer | 3:41 · 5/6 · dead air 3 · opens at 95 % of the raw | 3:41 · 5/6 · **opens at 44 %** (no spoiler) | **3:54 · 6/6 · dead air 0** · longest shot 6.6 → 5.6 s |
| 06 comedy | 2:08 · 4/6 | 2:08 · 4/6 | 2:08 · 4/6 |
| checks passed | 29/36 | 29/36 | **30/36** |

- **The first keepAmbience version made 01 worse** (4/6: 2 dead-air gaps, a 7.8 s shot): every kept action beat in a
  talking video was 3.5 s, and a vlog's walking shots are quiet. Fixed (commit `ca91ecf`): only action with a heard
  reaction gets the longer beats. Re-run above.
- **The verifier, calibrated** (`verify_calibration.mjs`, `.log`):
  - Inputs: the six plans with the app's own words, on three versions of each:
    - the real export;
    - the plan rendered straight from the raw (no clean-up);
    - the same plan with up to 10 joint words cut on purpose (~45 % of the word removed at the joint).
  - **Results:**
    - false alarms: 0 / 6 real exports, 0 / 6 clean renders;
    - cut word endings caught: 20 / 28;
    - cut word beginnings caught: 6 / 23.
  - The old re-transcription check cannot fail a single word: it needs the joint words' recall 30 points under the
    file's own agreement (37–145 joint words per case).
  - **On the six real exports:** 5 / 6 pass in `rules\`.
    - 01 fails on one important line, «بس الحمد لله» (≈ 71.6 s): under the director's «impact» sound, letters at 17 %
      of the file's median, sound correlation with the source in the undecided band.
    - In `keep-ambience\` the same 01 line fails, plus a line in 06 («مسكتك انت تفكرني», ≈ 22.4 s, next to a cut, letters at
      2 %).
    - All other flagged lines are warnings or "heard differently" (same sound as the source, r ≥ 0.75).
  - Old numbers kept in each `verify.json` (`stats.transcript`):
    - agreement 0.25 (02's crowd) to 0.84;
    - joint recall 0.14–0.73.
- **Shuffled story bench** (phase 8's `story_bench.mjs`, rules, 3 shuffles, `order.rules-r4.json`):
  - identical to phase 8, separate-files τ 0.22 / −0.02 / −0.12 / −0.19 / −0.10 / −0.06;
  - expected: the pieces are one file, so their people already share ids;
  - a real cross-file test needs the user's own folders.

## Needs a practical test on the user's footage
- **Listen to 01** (`rules\01-فلوق.mp4`, ~71.6 s): «بس الحمد لله» under the director's «impact» sound. The new verifier
  fails it (letters at 17 % of the file's level), the sound comparison is in between (r 0.6–0.75), and phase 7's
  coarser check passed it.
- The kept action sound with the clean-up on (listen to `keep-ambience\02` and `05`): audio-export's 0.3 s cross-fade
  at each span's edge.
- No spoiler on the user's own explainers: is «a strong moment from before the ending» a good opening, or should
  explainers open on the question?
- The cross-file people match on the user's own multi-clip folders. Do the joined people look right (the cut sheet's
  notes list the pairs)?

## Needs from other phases / the coordinator
- **audio-export:** nothing more. Their branch is in `main` and merged into this one; the hand-over is measured above.
- **perception (`ai-setup` owns it now):**
  - per-identity face embeddings (above);
  - a public `runWorker` (or `align(audioFile, asr)`) would let `alignExport` drop its own small runner.
- **Merge note:** `main` is already merged into this branch (the i18n append blocks kept, no key defined twice), so
  merging it back should be clean.

## Open risks
- **The verifier catches cut word endings, not cut beginnings:**
  - 20 / 28 end cuts vs 6 / 23 start cuts made on purpose. The aligner squeezes a word's first letters into what is
    left rather than pushing them before the cut.
  - Short cuts (< ~45 % of a word) were not measured.
- **A word the transcript ends too early** (NeMo ends early, the director keeps ~135 ms after it) can still lose its
  last sound. The aligner cannot tell that from its own drag, so it is not flagged (that is the price of no false
  alarms).
- **The cross-file voice threshold** (0.75) is set on 6 files of one family; other microphones or rooms may score lower.
- **keepAmbience spans are stored per timeline** (audio-export's design). Undoing a plan leaves them until the next plan.

## Disk
Cleaned per `D:\capcut new\CLAUDE.md` on 2026-10-26. Each item was proven unused first: no process using it, no
junctions or links inside, no reference in `src/`, `bench/`, `scripts/`.

**Removed:**
- The throwaway integration worktree `worktrees\director2-int` (detached, an uncommitted merge with `r4-audio-export`).
  Its three junctions (`runtime`, `node_modules`, `src\services\asr\models`) were unlinked first; the targets were
  checked intact. Then `git worktree remove --force`.
- Two temp app profiles: `%TEMP%\montaj-director2-ud` (891 MB) and `%TEMP%\montaj-director2-int-ud` (886 MB).
- Calibration audio and worker outputs in the session scratchpad (108 MB), and my scratch scripts.
- Intermediate exports whose numbers equal phase 7's: `rules\02/03/04/06.mp4` (~597 MB) and
  `keep-ambience\03/04.mp4` (~355 MB). Phase 7's own videos stay in `director\rules\`.
- My first, stopped bench run's partial files (01's export and plan).
- The merged-code check's two exports (same numbers as `keep-ambience` / `05`, which are kept) and its profile
  `%TEMP%\montaj-director2-merged-ud`.

**Kept** (`montaj-bench\النتائج\director2\`, 0.93 GB):
- `rules\` 332 MB: `01-فلوق.mp4` (the line to listen to), `05-شرح.mp4` (no spoiler), and the plans, verify and quality
  reports and cut sheets of all six cases.
- `keep-ambience\` 594 MB: `01`, `02`, `05`, `06` (the kept action sound and the line to listen to), plus all six
  cases' reports and cut sheets.
- Scripts and logs (< 200 KB): `run_director2.mjs`, `reverify2.mjs`, `verify_calibration.mjs` / `.log`,
  `story_bench.mjs`, `order.rules-r4.json`, `cutsheet.mjs`, `run-*.out`, `اقرأني.md`.
- The worktree's git-ignored graphics bundle (`npm run build:graphics`) and its junctions. Remove them as links before
  deleting the worktree.

`node cleanup.mjs`: 0 GB to free from my work.
- Five `%TEMP%\montaj-video-*` folders are another session's ("in use").
- The shared caches (Hugging Face, uv, pip, npm) are untouched.
