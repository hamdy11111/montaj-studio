# HANDOFF — `story` (Phase 8 of PLAN_editor_and_graphics.md: story order for mixed-up raw footage)

Branch `phase8-story` (worktree `D:\capcut new\worktrees\story`), based on `main` 06c137a. Nothing pushed or merged.
Results: `D:\capcut new\montaj-bench\النتائج\story\` (Arabic summary `اقرأني.md`).

## What was built

The director stays the executor; phase 8 gives it a story order (`src/core/story.js`, pure):

1. **Moments never cross a clip joint** (`clipMoments` in `src/core/treatments.js`): with several clips on the main track
   the moments are built clip by clip, numbered once, each with `clip`. Before, a sentence could run on across a clip
   joint, and a derived link could tie a reaction to the moment of another clip.
2. **Segments (scenes)** (`segmentMoments`): a dynamic program over the moment edges. Each segment costs `cutCost` minus
   the boundary score of its start, plus a penalty outside 8–45 s.
   - Boundary scores (`boundaryScores`), for a cut: a shot cut, an indoor ↔ outdoor flip in the shot log, a long pause,
     a long quiet moment, a topic drop (tokens of the 3 moments before vs after).
   - Against a cut: a question answered right after, a cause → reaction across the edge.
   - Clip joints are always cuts.
3. **What each segment is** (`describeSegments`):
   - its words: topic tokens, head and tail;
   - place and outfit tokens from the shot log's `where` / `objects` / `who.looks`, indoor, day / night;
   - people (face / voice ids scoped per file, `fileKey`), energy and reactions;
   - a time hint (`clip.timeUs` + offset);
   - its **beat** — setup · promise · build · conflict · payoff · ending. It comes from Egyptian Arabic cue words
     (`beatCues`; up to two different cue words per list count), story roles (`reel.js storyRole`), phase 6 roles,
     reactions and promises.
   - `opens` / `closes`: a greeting in the first lines / a goodbye in the last lines — the only cues strong enough to
     pull a segment to an edge.
4. **Constraints** (`storyConstraints`):
   - Hard: a sure cross-segment link (cause before its reaction; a `before` link: the reaction first) and a promise
     before its payoff. A hard edge that would close a cycle becomes soft, weakest first.
   - Unsure links are soft.
5. **The order** (`storyMatrices`, `bestOrder`):
   - `P[a][b]` = worth of a before b: the beats' expected ranks, the edge cues, recording order inside one clip (strong),
     recording times across clips (when known), the order the clips were given (weak, when no time is known), day
     before night, soft links, −1000 for a broken hard constraint.
   - `A[a][b]` = continuity: place, outfits, topic tf-idf, people; plus a contiguous piece of one take.
   - Exact dynamic program over subsets up to 13 segments; local search (insertion moves, several starts) above.
6. **A model's order** (`src/services/directorLLM.js`: `STORY_SYSTEM`, `STORY_SCHEMA`, `storyPrompt`, `llmStoryOrder`):
   - The planner model (Qwen3.8-27B local, or Claude) gets the numbered segments (`storyTable`): length, clip, beat
     guess, reactions, place, what is said, and the hard and soft constraints.
   - It answers `{ order: [numbers], beats, why }`, JSON-schema constrained.
   - `repairOrder` drops invented / repeated numbers, inserts a missing segment where it scores best, then makes a stable
     topological pass so no hard constraint is broken; every fix is listed (en + ar).
   - `voteOrders` (several model orders as pairwise votes on the rules' matrices) exists and is tested, but the agent
     does not use it: it measured no better than one call.
7. **Into the director** (`src/agent/director.js`):
   - `storyOrder()` runs after the moments when `story` is `"on"`, or `"auto"` (the default) with ≥ 2 clips on the
     main track. It reads the files' recording times (`src/services/story/clipTimes.js`: QuickTime
     `com.apple.quicktime.creationdate`, MP4 `creation_time`, else the file's mtime) unless `storyHints: "off"`.
   - The model is `planner`, or `storyPlanner: "local" | "claude"` alone: the model is loaded for the one story call and
     stopped right after.
   - `ruleTreatments(…, { story: { rank } })` sorts every treatment's order by story rank, adds `story-full` (the pure
     story, no flash-forward), uses story position for the result / question / in-medias-res hooks, and appends
     `shooting-order` with `alternative: true`. That alternative is executed and scored and listed on the cut sheet,
     never a candidate in the ranking pool; `opts.treatment: "shooting-order"` forces it.
   - `validateTreatment(…, { rank })` sorts by story rank when it has to sort.
   - The planner's treatment prompt gets the story order (`planPrompt({ storyOrder })`).
   - The cut sheet gets `story` (`storySheet`): the order with each scene's beat, cue words, the constraints into it,
     the model's why, the shooting order as the alternative, the repairs — and its Arabic lines first in
     `cutSheet.text`.
   - The result has `story` (segments without the token sets, order, shooting, source, constraints). There is a
     decision `{ k: "story" }` and a note.
8. **Fixes found on the way (same files):**
   - **Phase 6's document was ignored by the merged director.** `LinkService.cached()` returns `montaj.links/1` (links by
     id, roles on its own moments); the adapter expected `{ links: [{ cause: { t0, t1 } … }] }`, so every phase 6 link
     mapped to NaN and was dropped.
   - `phase6Shape` reads the document through phase 6's own `directorView`: `build_up` → `build`; a promise's payoff
     is the best `after` link from it.
   - Phase 5 / 6 spans now map through the clip that shows them (`mediaToAxis`, `mediaSpanToAxis`) instead of the
     file's first clip. A file cut into pieces placed apart was mis-mapped; a span across two pieces keeps its larger
     part.
   - `core/director.js`'s note says "in the story order" when the spec carries `story`.
9. **UI** (`src/renderer/js/editor/director.js`, i18n block "Phase 8"):
   - A **«فولدر كليبات»** button: imports every video / picture of a folder, puts them on the main track in file-name
     order (numeric), and sets the story to "on".
   - A **«ترتيب القصة»** select: auto / build the story (one long raw too) / keep the timeline order.
   - The cut sheet shows the story lines and the decision text.

## Files touched
Own column:
- new: `src/core/story.js`, `src/services/story/clipTimes.js`, `tests/unit/story.test.js`;
- changed: `src/core/treatments.js`, `src/core/director.js` (one note), `src/agent/director.js`,
  `src/services/directorLLM.js`, `src/renderer/js/editor/director.js`.

Shared, appended block: `src/renderer/js/i18n.js` (Phase 8 block at the end of the dictionary).
No npm packages, no new models, no downloads, no new venv.

## Tests
- `npm test` in the worktree: **245 / 245 pass** (main 233; +12 in `tests/unit/story.test.js`). The director7 and
  quickwins tests still pass with the per-clip moments.
- `story.test.js` covers:
  - cue words: «السلام عليكم» opens and is not a goodbye; bet → promise;
  - moments never across a joint (word indices global, no derived link across a joint);
  - segments: joints always cut, a 3-topic long raw cut at the topic changes;
  - constraints: hard / soft / cycle broken;
  - the exact program = brute force (4 random 6×6); local search on 16 keeps the hard rules;
  - four clips given as payoff, ending, setup, promise → setup, promise, payoff, ending; recording times decide when
    the words say nothing; a hard link beats the beats;
  - repair: invented, repeated, missing, hard; votes;
  - treatments in story order, shooting order as the non-candidate alternative, the executor laying the files in story
    order;
  - phase 6 document → adapter; spans through the right piece;
  - recording-time tags (1904 placeholder ignored, injected probe);
  - the model call (numbers only, listing order, beats, the planner prompt gets the story); the story sheet; Kendall
    tau / exact / neighbours.
- Real runs, below. All 24 app runs completed; nothing failed.

## Measured (`montaj-bench\النتائج\story\`, `اقرأني.md`)

No mixed-up raw with a known story exists, so each bench case (one raw shot in order) was cut into the segmenter's scene
chunks (8–21 per case, 4–38 s), shuffled as virtual pieces of the same file (no media copied), and measured against the
shooting order. Time hints are off: the pieces of one file would give the order away.

**Order recovery** (`story_bench.mjs`, 3 shuffles per case, τ / kept neighbours):

| case | chunks | given τ | rules | Qwen3.8 — separate files | Qwen3.8 — one raw |
|---|---|---|---|---|---|
| 01 vlog | 9 | −0.06 | 0.22 / 0.04 | 0.28 / 0.13 | 0.33 / 0.29 |
| 02 challenge | 10 | −0.02 | −0.02 / 0 | −0.63 / 0.15 | −0.35 / 0.67 |
| 03 cooking | 21 | −0.11 | −0.12 / 0.03 | −0.33 / 0.22 | −0.23 / 0.33 |
| 04 interview | 8 | −0.10 | −0.19 / 0.14 | −0.33 / 0.48 | −0.33 / 0.48 |
| 05 explainer | 20 | −0.10 | −0.10 / 0.12 | 0.26 / 0.03 | 0.68 / 0.67 |
| 06 comedy | 15 | −0.06 | −0.06 / 0.12 | 0.09 / 0.34 | −0.02 / 0.33 |

- **Neither the rules nor Qwen3.8 recovers the shooting order on average** (mean τ −0.05 rules, −0.11 model, separate
  files).
- The rules keep the given order unless a strong cue moves a scene; the vlog's opening («صباح الخير») is found every
  time.
- The model keeps related scenes together more (neighbours up to 0.48), but its overall order differs from the
  shooting order:
  - 02: it puts the match on TV before the celebration — a cause-first story, but the goal happened before the
    recording;
  - 03 / 04: it opens on the greeting / the student's introduction, which were shot mid-way.
- The shooting order of a continuous take is not always the best story, so this measures recovery, not story quality.
- **"One raw" is optimistic:** phase 6's links across the pieces of one recording effectively say which pieces were
  adjacent (the 0.68 on 05). The "separate files" column is the honest one.
- **Two calls with two listing orders voted together:** no better than one call (mean −0.16), so the agent asks once:
  14 s on average, 25 s at most.
- **Thinking mode:** > 4 min and > 10 k tokens per call; stopped.

**Full director in the app** (`run_story_app.mjs`, exports at 1080p measured with the main checkout's
`bench/quality.mjs`; τ = the export's order against the raw):

| case | in order | shuffled, timeline order | shuffled, story (rules) | shuffled, story (Qwen3.8) |
|---|---|---|---|---|
| 01 | 5/6 · τ 0.66 · 91 s | 6/6 · τ 0.02 · 119 s | 5/6 · τ 0.22 · 99 s | 5/6 · τ 0.22 · 99 s |
| 02 | 5/6 · τ 0.92 · 83 s | 4/6 · τ −0.01 · 112 s | 4/6 · τ −0.01 · 112 s | 4/6 · τ −0.08 · 112 s |
| 03 | 5/6 · τ 0.95 · 148 s | 6/6 · τ −0.22 · 195 s | 6/6 · τ −0.18 · 195 s | 6/6 · τ −0.27 · 195 s |
| 04 | 5/6 · τ 0.93 · 176 s | 5/6 · τ 0.18 · 178 s | 5/6 · τ 0.09 · 178 s | 5/6 · τ −0.08 · 178 s |
| 05 | 5/6 · τ 0.71 · 221 s | 5/6 · τ 0.00 · 221 s | 5/6 · τ 0.03 · 221 s | 5/6 · τ 0.12 · 221 s |
| 06 | 4/6 · τ 0.87 · 128 s | 4/6 · τ −0.06 · 124 s | 4/6 · τ −0.06 · 124 s | 4/6 · τ 0.38 · 147 s |

- Quality checks: 29 / 30 / 29 / 29 of 36 — the story pass does not hurt the edit.
- `director.verify` passes on all exports except 02 with Qwen3.8 (`out.cutWords`: joint words heard 7 % vs 50 % —
  02's crowd / TV case has low re-transcription agreement, and 10 pieces add joints).
- Director time: rules story 2–5 s; with the model 75–138 s (load + one call + the rest).

## Needs a practical test on the user's footage
- **The real test:** a folder of the user's own clips shot out of order («فولدر كليبات» → ابدأ, planner rules or
  Qwen3.8), judged on the cut sheet's story lines.
- **Recording-time hints:** never measured. The bench had to switch them off; real phone clips carry them.
- **The Egyptian cue lists** (`CUES` in `story.js`): written by me, not tuned on the user's speech.
- **One long raw with `story: "on"`:** the recording order inside a clip is a strong prior (`W.clip` 3), so a long raw
  is reordered only by strong cues or the model.
- **The folder button:** clicking through the real dialog was not done (the bench drives the same IPC calls:
  `media.importFolder`, `timeline.exec addMedia`).

## Needs from other phases / the coordinator
- `src/agent/operations.js` (not mine): add `story` ("auto" | "on" | "off"), `storyHints` ("auto" | "off") and
  `storyPlanner` ("rules" | "local" | "claude") to `edit_auto`'s input schema and description. The IPC `director.run`
  already passes them.
- **Phase 6 adapter fix:** `phase6Shape` now really feeds phase 6's links into every director run (before this branch
  they were silently dropped). That changes single-clip director runs too; the in-order bench above ran with it (29/36
  checks, as phase 7 measured).
- A cross-file face / voice identity (perception gives P1 / S1 per file) would let "same people" count across clips;
  today `people` only matches inside one file.

## Open risks
- **Story order quality is unproven:** see "Measured". Treat the story order as a proposal; the shooting order is always
  one click away on the cut sheet.
- **The model's order can be far from the recording order** even when the recording order was the right story (02,
  03). With recording times available, the rules would mostly follow them, but the model's order replaces the rules'
  when a planner is on.
- **More joints, more risk at joints:** rearranged pieces of continuous footage add cuts (02's verifier failure).
- **Chunking differs between the bench and the app:** the app's NeMo words vs perception's words give 25 segments for
  21 pieces on 03. Segments inside one clip keep their recording order through `W.clip`.

## Disk
Following `D:\capcut new\CLAUDE.md`, cleaned on 2026-10-26.

**Removed:**
- 21 intermediate exports of the app bench (3.47 GB).
- The two temporary app profiles `%TEMP%\montaj-story-ud` (1.52 GB) and `%TEMP%\montaj-story-ud2` (0.96 GB): no app
  running, no links inside.
- The llama-server log.
- My scratch scripts.

No media was copied: the shuffled pieces were spans of the raws, read in place.

**Kept:**

| What | Where | Size |
|---|---|---|
| 3 videos to watch: `app-local\06-كوميديا.story.mp4` (shuffled, story by Qwen3.8), `app-rules\06-كوميديا.in-order.mp4` (the same case in order), `app-local\01-فلوق.story.mp4` | `D:\capcut new\montaj-bench\النتائج\story\` | 428 MB |
| Reports: plans with the story cut sheets, quality / verify / align files, `summary.json`, `order.*.json`, `compare.json`, `اقرأني.md`, the bench scripts | same folder | ~2 MB |
| Graphics build of this worktree (git-ignored, needed to run the app here; goes with the worktree) | `src\graphics\build`, `src\renderer\assets\graphics` | 26 MB |

The worktree's `runtime`, `node_modules` and `src\services\asr\models` are junctions to the main checkout. Unlink them
first if the worktree folder is ever deleted by hand. Qwen3.8-27B (`runtime\models\director\qwen3.8-27b`) was reused in
place. The GPU lock was taken as `story` for every model run and released; one thinking-mode run was stopped by me
(my own process and its llama-server) and the lock released by hand.
