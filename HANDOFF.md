# HANDOFF — `quick-wins` (Phase 2 of PLAN_editor_and_graphics.md)

Branch `phase2-quick-wins` (worktree `D:\capcut new\worktrees\quick-wins`), based on `main` 0fe8ace. Nothing pushed.

## What was built

### 1. Edit plan v2 (`montaj.editplan/2`) — `src/core/editPlan.js`, `src/agent/editPlan.js`
- `segments`: the main track as an ORDERED list of source spans of any media of the project — several files, any order,
  a span may repeat. `role: "hook"` marks a flash-forward / cold open whose span is also kept in its natural place
  (a repeat without a hook is a warning). `jl` (ms, −500…500) per joint, before that segment.
- Fields for the later phases: `music` (edit time, offset, volume, fade), `broll` (over a source span of the speech,
  silent, `cover`/`pip`), `graphics[].anchor` (`{ word, atUs }`) + `reason`, `retakes` (groups: takes, kept, reason).
- Overlays (zooms, texts, graphics, b-roll, sfx) stay in SOURCE time like v1; they land on their natural place (not a
  hook copy) unless pinned with `segment: <index>`. Zooms are picture, so they go on every occurrence. Transitions:
  `segment` (the joint before it) or `mediaId + atUs`.
- `checkPlan` dispatches by version; v2 errors/warnings (media not in the project, audio as a segment, past the end of
  the file, overlay media in no segment, transition before segment 0, unknown kept take…), summary (`reordered`,
  `hooks`, `jl`, `retakes`, `media`), and a cut sheet in edit order: `#n edit-span ▸ file source-span [hook] — reason`,
  the J/L lines, graphics with `on «anchor»`, b-roll, music, transitions, and one line per retake group (every take,
  the kept one and why).
- `EDIT_PLAN_SCHEMA` is now `oneOf [v1, v2]` (what `edit_plan_schema` shows); `EDIT_PLAN_SCHEMA_V1/V2`, `planSchemaOf`.
  v1 plans are applied exactly as before.
- Apply (`applyPlan`): v2 rebuilds the main track with `layoutMain` (each segment takes the look — transform, colour,
  effects, sound — of a clip of its media already there), sets the J/Ls, then the same steps as v1 (zooms, transitions,
  stabilize, texts, graphics, behind-person) + b-roll + sfx + music + look/audio + captions — still ONE batch / ONE undo
  step / rollback on failure.

### 2. J/L cuts — `src/core/timelineOps.js`, `src/core/exportGraph.js`, schema v6
- `Segment.jlUs` (the joint before a main-track clip): < 0 = J (its sound starts before its picture), > 0 = L (the
  previous sound runs on under its picture). The clips' start/duration stay the SOUND's edit points — plans, captions,
  sfx and the speech guards map them unchanged — only the picture edit point moves, so a J/L can never lose a word.
- `setJL` (clamped to ±0.5 s and half of each side; needs two picture clips side by side with no transition),
  `pictureTracks(tracks, durOf)` (the picture view: the handle comes from the previous clip's own footage after its out
  point for a J, before this clip's in point for an L, clamped to the file), `layoutMain`, and `splitSegment` keeps the
  J/L on the outer edge only. Defaults off (0).
- Export: the video-layers block lays `pictureTracks(...)` (one line + the cutout call); the audio is untouched.
- **Verified with a real FFmpeg export** (`tests/unit/quickwins.test.js`, "J and L cuts in a real export"): red clip
  (300 Hz) | blue clip (1000 Hz, J −400 ms) | red (L +300 ms). Measured: at 2.6–2.7 s the picture is still red while
  the sound is already 995 Hz (J); at 5.3 s the picture is red again while the sound is still 995 Hz (L); before/after
  each joint the right colour and 300/995 Hz; no sound lost or doubled.
- The director: a 200 ms J lead (`POLICY.jl`) into a new scene — another clip, or a stretch of ≥ 4 s left out — when
  the next segment is ≥ 1 s and the previous clip has footage to hold; at a clip joint it no longer puts a transition.

### 3. Retakes by meaning — `src/core/speech.js` (no performance judging)
- `speechUnits` (sentences, split again where a unit restarts its own opening after a short pause), `alignToken`
  (normalised Arabic, «و/ف» and «ال» dropped), `alignTokens` (Smith–Waterman, match +2 / mismatch −1 / gap −1, tokens
  equal or one letter apart), `retakeKind` (`full`, `partial`, `false-start`: a shorter attempt whose opening matches a
  later longer one), `retakeGroups` (nearby units only: a full retake within 20 s, a false start redone within 4 s, at
  most 2 short asides such as «تاني / استنى» between attempts, anything else said in between stops the search; at most
  8 takes within 60 s — a refrain is not a retake), `chooseTake` (default: the LAST complete take), `retakeDrops`.
- Clean structure for Phase 5: `{ line, takes: [{ w0, w1, fromUs, toUs, text, kind, complete }], asides, kept, reason }`;
  pass `score(take, group)` to `retakeGroups`/`chooseTake` to replace the choice with a performance score.
- The director drops the other takes and the asides (reason `retake`, counted as intended removals by the QA guards)
  and writes the groups into `plan.retakes` (cut sheet + decision `{ k: "retakes" }`). `retakes: false` keeps all.

### 4. Captions — `src/core/captionTemplates.js`, `src/renderer/js/editor/captionRaster.js`
- States are now sampled PER FRAME and merged where nothing changes (`captionStates`): `wipe` (karaoke fill of the
  spoken word in step with its sound, 8 steps), `wordPop` / `pop` (springs eased per frame: word 1.0→1.15→1.0 over
  120 ms, page 0.86→1.04→1.0 over 160 ms — no more 2–3 hard frames), `boxFrom`/`boxK` (the highlight box slides from
  the previous word in 110 ms). `stateKey` includes them; preview (`captionStateAt`) and export (`captionFrames`) play
  the same states drawn by the same `captionCanvas`.
- Wipe: the whole shaped word is drawn, then the said share is filled through a clip rectangle growing from where the
  word is read first (right edge for Arabic) — glyphs are never split, so Arabic joins stay correct. Templates with the
  wipe: clean-pro, bold-3d, karaoke-yellow (also `sung`: said words stay filled), neon.
- Emphasis (`emphasisFor`): one word in every 3–5 (round(n/4), at least one from 3 words; 1–2-word pages only for a
  keyword or a number), keyword > number > longest content word (Egyptian/English function words excluded), never two
  side by side.
- Safe zones (`SAFE_ZONES` tiktok/reels/shorts/all, `safeZone`): on a vertical canvas the lines stay between the sides
  of the zone (max width 74 % instead of 84 %) and `captionPosY` keeps the page above the bottom bar (minimal-lower and
  subtitle-bar move from 0.30 to 0.222; the others already fit). `text.caption.safe` picks a platform or `none`.

### Director on several clips — `src/agent/director.js`, `src/core/director.js`
- No more `err.directorOneClip`: every main-track clip (videos and pictures at a constant speed; cut or not) is planned,
  in timeline order. Each file is transcribed / stabilized / tracked once; the words and person track are laid on one
  virtual axis; clips without speech are protected (never cut); shots also break at clip joints; `toPlanV2` maps the
  plan back to each file (zooms per kept segment, overlays by source, transitions by segment, anchors, retakes).
  The director now always returns a v2 plan. Refused only with `err.directorClips` (a text/compound/curve clip on main).

## Files touched
Own column: `src/core/editPlan.js`, `src/agent/editPlan.js`, `src/agent/director.js`, `src/core/director.js`,
`src/core/speech.js`, `src/core/policy.js` (`jl`, `retakes`), `src/core/timelineOps.js`, `src/core/captionTemplates.js`,
`src/renderer/js/editor/captionRaster.js`, tests `tests/unit/quickwins.test.js` (new), `director.test.js`,
`automation.test.js` (caption/emphasis expectations).
Outside the column (small, needed — please review):
- `src/core/exportGraph.js`: 7 lines at the start of the video-layers block (`pictureTracks`); audio untouched.
- **Realm schema 5 → 6**: `src/db/schemas.js` (`SCHEMA_VERSION`, `Segment.jlUs` int default 0), `src/db/mappers.js`
  (`SEG_SCALARS`), `src/db/migrations.js` (step from 5, `legacySchemaV5`), `tests/unit/db.test.js` (versions read
  from `SCHEMA_VERSION`, a v5→v6 test). Without it the J/L would not survive a save (the export reads the database).
  If another branch also bumps the schema, renumber on merge.
- Shared, appended block: `src/renderer/js/i18n.js` (`err.directorClips`, `err.jlMainOnly`, `err.jlNoJoint`,
  `err.layoutAudio`, `dec.retakes`, `dec.jl`, `dec.clips`).
No new npm packages, no models, no downloads, no GPU jobs (no GPU lock needed).

## Tests
- `npm test` in the worktree: **127 / 127 pass** (includes the real-FFmpeg J/L export and the services-level v2 apply
  and two-clip director tests).
- Bench before/after: see "Quality reports" below.

## Quality reports (bench) — `D:\capcut new\montaj-bench\النتائج\quick-wins\`
Driver `run_director.mjs` (launches the app of a checkout with its own user data, imports each raw case in place, runs
`director.run` — energetic, stabilize/person off — exports 1080p, then the MAIN checkout's `bench/quality.mjs`);
`compare.mjs` → `compare.json` + `قبل-وبعد.html`; `اقرأني.md` (Arabic summary). Same NeMo transcripts on both sides.

| case | length before → after (s) | median shot | quality checks passed | takes left out | J cuts |
|---|---|---|---|---|---|
| 01 vlog | 89.9 → 88.5 | 1.80 → 1.87 | 5 → 5 | 1 | 1 |
| 02 challenge | 12.6 → 12.4 | 0.80 → 0.73 | 6 → 6 | 0 | 2 |
| 03 cooking | 104.1 → 104.1 | 1.30 → 1.30 | 3 → 3 | 0 | 3 |
| 04 interview | 167.2 → 167.2 | 2.07 → 2.07 | 5 → 5 | 0 | 0 |
| 05 explainer | 172.3 → 172.2 | 1.37 → 1.37 | 4 → 4 | 0 | 1 |
| 06 comedy | 60.0 → 59.0 | 1.30 → 1.23 | 5 → 5 | 1 | 3 |

The bench metrics (cuts, shots, dead air, opening, loudness) are unchanged within noise — expected: phase 2 is mostly
capability (multi-file v2 plans, J/L, retake groups, captions) that the current metrics do not see. Nothing regressed.
Retakes found: 01 «امال عايز ايه» ×2 (may be a deliberate repeat — check), 06 a false start «بطاريه العربيه».
The cases are single files, so the multi-clip director is covered by the unit tests only.
Export time: with a 16-step wipe the caption rasters made exports ~2× slower (01: 3:18 → 6:12); at 8 steps 01 takes
3:25 (`after-wipe8\`). The `after\` videos were made with 16 steps. (The ffconcat entries themselves are cheap: +1200
entries ≈ +2.5 s; the cost is drawing/encoding one PNG per state in the raster window.)
Case 02: the director cuts 127 s to 12 s on both sides (little speech, and without person tracking the wordless action
is cut) — a perception-phase problem, not phase 2.

Worktree note: the NeMo model (`src/services/asr/models/*.nemo`, git-ignored) is not in a new worktree — without it the
app silently uses faster-whisper. I junctioned `src/services/asr/models` to the main checkout's folder (untracked).

## Changes needed in files I do not own (for the coordinator to route)
1. `src/renderer/js/editor/director.js:36` shows `(plan.cuts || []).length` — the director's plan is v2 now (no
   `cuts`), so the summary says 0 cuts. Use `r.decisions.find((d) => d.k === "pacing")?.cuts`. Also add cases for the
   new decisions `retakes`, `jl`, `clips` in `decisionText` (i18n keys `dec.retakes`, `dec.jl`, `dec.clips` exist).
2. `src/renderer/js/editor/player.js` (preview): lay main-track PICTURE through `pictureTracks(tl.tracks, durOf)`
   from `core/timelineOps.js` (audio as is), so the preview shows J/L cuts like the export.
3. `src/agent/operations.js`: `edit_auto` description still says "The timeline must hold one uncut video";
   `edit_plan_schema` example and `edit_plan_apply/validate` input descriptions say `montaj.editplan/1` — mention v2
   (segments, jl, hook, music, broll, anchors, retakes). Optionally a `timeline_set_jl` operation calling `setJL`.
4. Timeline UI: no J/L handle yet (a marker on the joint and an inspector field would use `setJL`).

## Needs a practical test on the user's footage
- Retake grouping on real Egyptian speech (thresholds 0.6/0.5 coverage, 4 s false start, 20 s window): count how often
  it groups lines that are deliberate repetitions, and how often it misses retakes.
- The 200 ms J lead on real scene changes (does it read as a lead-in, not as lip-sync error?).
- Safe-zone numbers against the real TikTok / Reels / Shorts overlays on a phone.
- The caption wipe/box/springs look (they render in the real app's raster window — see the after-bench exports).

## Open risks
- Export cost of captions: states are per frame while a word is said (up to ~8 images per word instead of ~3); measured
  as no real slowdown at 8 wipe steps. The cheaper long-term path (export side, not mine): two images per word (plain and
  filled) and an animated crop in FFmpeg instead of one PNG per state.
- `toPlanV2` truncates a graphic at the end of its clip when it would run across a clip joint.
- A media used twice on the main track: overlays are pinned per segment (a graphic over a cut into the other copy is
  shortened).
