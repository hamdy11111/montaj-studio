# HANDOFF — `audio-export` (round 4: the export keeps kept action's sound; library previews)

Branch `r4-audio-export` (worktree `D:\capcut new\worktrees\audio-export`), based on 397ac7b. Nothing merged or pushed.
Results: `D:\capcut new\montaj-bench\النتائج\audio-export\` (Arabic summary `اقرأني.md`, case 02 reports in `case02\`,
driver `case02.mjs`). Notes for director2: shared notes `audio-export-notes.md`.

## 1. Keep the action's own sound (`plan.audio.keepAmbience`)

**Before:**
- The voice clean-up (`audioFx.denoise`) ran RNNoise, then `betweenWords`, which lowers everything between known
  words to −20 dB.
- RNNoise also gates a crowd or a game away. Kept wordless action came out as dead air: case 02 read −17.5 LUFS.

**Now** (`src/core/exportGraph.js`):
- `ambienceByMedia(list)` normalises the contract `[{ mediaId, fromUs, toUs }]` (SOURCE time) into
  `{ [mediaId]: [[from, to]…] }`. It sorts, merges overlapping spans and drops malformed ones.
- `keepMask(spans, srcFromUs, speed, durUs)` is a 0…1 gain on the same source clock as `betweenWords`:
  - 1 over a kept span;
  - a linear ramp over `AMBIENCE_RAMP_S` (0.3 s) outside each edge;
  - null when no span touches the piece.
- In the audio chain, when a clip with the clean-up on overlaps a kept span:
  - The clip's sound is split in two (`asplit`).
  - The voice branch gets RNNoise (or the FFT denoiser), then `betweenWords`, then `× (1 − mask)`.
  - The raw branch gets `× mask`.
  - Both are summed (`amix normalize=0`).
- Effect over a kept span: the clip's own sound at full level, with no denoise and no lowering, and an equal-gain
  cross-fade at the edges.
- Everything after the split stays as before: enhance voice, isolate, voice changer, clip gain, dub and music ducks,
  the master gain and limiter.
- **No spans, spans of another file, or spans outside the clip build exactly the same graph string as before** (unit
  test).
- A speed-curve clip keeps the old chain (its source clock is not linear).

**Where the spans come from** (`src/services/exportService.js`):
- `setKeepAmbience(timelineId, list)` stores the merged spans in `<cache>/ambience/<timelineId>.json`. An empty list
  deletes the file. The id is sanitised, so it cannot leave the folder.
- `keepAmbience(timelineId)` reads them back.
- `voiceFor(tl, override)` adds them to the export options.
- An export request's own `keepAmbience` (in the `export.start` options) wins over the stored list.
- Both video and audio exports, and the loudness measurement pass, use them.
- **The plan → export handover is director2's** (their files):
  - add `keepAmbience` to `EDIT_PLAN_SCHEMA.audio` (it has `additionalProperties: false`);
  - in `applyPlan`, call `ctx.services.exporter.setKeepAmbience(timelineId, plan.audio.keepAmbience || [])`.
  - Exact schema text: shared notes `audio-export-notes.md`.
  - The mediaId must be the real one, not `"virtual"`.

**Preview:** nothing to mirror. The preview (`player.js`) plays the clips' raw sound and applies neither the denoise
nor the between-words gain, so kept action already sounds as in the source there.

**Proof:**
- `tests/unit/keepAmbience.test.js`: a real FFmpeg export with RNNoise.
  - Source: a 220 Hz "voice" with known words, plus pink-noise "crowd" from 3.5 to 9 s.
  - The crowd at 4.5–8 s measured **−84.2 dB → −27.4 dB**.
  - Dead air (≥ 0.6 s under −35 dB) inside the crowd: **1 → 0**.
  - The level is within 3 dB of the clip without the gain.
  - The voice is unchanged (< 0.5 dB).
  - The gap after the hand-off is still lowered.
  - The middle of the ramp sits between the two levels, with no doubled sound at the edge.
- **Case 02 re-measured** (`case02.mjs`):
  - Input: the director's rules plan `director\rules\02-تحدي.plan.json`, with its 20 kept spans laid on a timeline, the
    raw read in place, and perception's cached words for the between-words gain.
  - `keepAmbience` = the plan's 15 `action` moments (85 s of source), as director2 would pass them.
  - Each variant: the app's two-pass loudness to −14, muxed under the director's exported picture (stream copy),
    measured with `bench/quality.mjs`.
  - J/L, sound effects and transitions are left out, so only the clean-up differs.

| variant | integrated | true peak | LRA | dead air (all / ≥ 2 s) | checks |
|---|---|---|---|---|---|
| A clean-up on (old) | **−17.49 LUFS** | −0.88 | 23.3 | 12 (35.3 s) / 9 | 3/6 |
| B clean-up on + keepAmbience | **−14.52 LUFS** | −0.67 | 5.8 | **0 / 0** | 5/6 |
| C clean-up off (director's work-around) | −14.46 LUFS | −0.16 | 5.6 | 0 / 0 | 5/6 |

- A reproduces the director's −17.5 LUFS.
- B matches C on loudness and dead air, and still cleans the speech.
- The remaining failed check, "still picture", is not audio.

## 2. Previews in the library browsers (`media://libfile`)

- **`src/main/libraryFiles.js` (new):** `libraryFiles({ roots, listed, stamp })` resolves a path to its **real path**
  (links and junctions resolved) and serves it only when it is:
  - inside the sound library folder or the B-roll index folder; or
  - a file those libraries list from elsewhere: `abs` sounds in `library.json` (folders the user imported by path),
    and `media[*].path` videos in `shots.json`.
- It also requires:
  - a picture, sound or video extension, on both the asked and the real path;
  - a regular file.
- The listed set is re-read when the index files' times change.
- Refused: look-alike folder names (`sfx-evil`), `..` traversal, junctions out of the library, relative paths and
  index JSONs.
- `servicesLibraryFiles(getServices)` binds it to `sfxLib.dir` / `broll.dir`.
- **`src/main/protocols.js`:**
  - `media://libfile/<base64url of the UTF-8 path>` → the file with Range support, or 403.
  - The whole `media:` protocol is now read-only: anything other than GET/HEAD gets 405. Nothing used other methods.
- **`src/renderer/js/editor/libraryBrowsers.js`:**
  - `libFileUrl(file)` builds the URL.
  - `previewPlayer` is one shared player per browser: a click toggles it, it stops itself at a span's end, and a
    failure shows a toast.
  - The sound browser has a ▶ button per result.
  - The B-roll browser shows each shot's keyframe (frame 1). Clicking it shows the preview video, which plays the
    shot's `startS…endS` and stops.
  - Players stop when the dialog closes.
  - `openBrollSearch(ed, { search })` takes an optional search function, for the test.
- **i18n:** appended block «Round 4 — audio-export» (`lb.listen`, `lb.stopListen`, `lb.watchShot`, `lb.previewFailed`).
- **Checked against the real libraries** (Node, the same resolver):
  - served: a mixkit sound, a real keyframe, and two raws the B-roll index lists (Arabic paths);
  - refused: `D:\capcut new\CLAUDE.md`.

## Files
- Own column: `src/core/exportGraph.js`, `src/services/exportService.js`, `src/main/protocols.js`,
  `src/renderer/js/editor/libraryBrowsers.js`.
- New (mine): `src/main/libraryFiles.js`, `tests/unit/keepAmbience.test.js`, `tests/unit/libraryFiles.test.js`,
  `tests/e2e/libpreview.e2e.test.mjs`.
- Shared, appended: `src/renderer/js/i18n.js` (one block at the end).
- No npm packages, no models, no downloads.

## Tests
- `npm test`: **253 / 253 pass** (397ac7b had 245; +5 keepAmbience, +3 libraryFiles).
- `tests/e2e/libpreview.e2e.test.mjs` (new), in the real app, **3 / 3 pass**. It uses temp libraries in the default
  library place; the B-roll search is a fixed answer because its models need the GPU.
  - Protocol:
    - 200 for a sound and a keyframe;
    - 206 with Range for a listed video with an Arabic name;
    - 403 for an unlisted video, a file outside, traversal, `library.json` and a relative path;
    - 405 for POST.
  - The sound plays and stops by itself at its end, and a second click stops it.
  - The keyframe loads. The shot plays from 2.0 s and pauses at 4.0–4.4 s.
  - No page errors.
- `studiolinks.e2e` + `interactions.e2e`: **9 / 9 pass** (GPU quiet, ~3 GB used by others).

## Disk
- **Removed:** nothing was left to remove. Every test cleans up after itself:
  - the unit tests and the e2e test use mkdtemp folders and delete them;
  - the case 02 driver wrote its three intermediate audio files and three muxed MP4s (~3 × 100 MB) to the scratchpad
    and deleted them in `finally`;
  - `node cleanup.mjs` reports 0 GB to free.
- **Kept:**
  - `D:\capcut new\montaj-bench\النتائج\audio-export\`, 40 KB: the case 02 quality reports (HTML + JSON) and
    `summary.json`, `case02.mjs`, `اقرأني.md`.
  - The worktree's junctions (`runtime`, `node_modules`, `src\services\asr\models`) point at the main checkout. Remove
    them as links (`rmdir`) before deleting the worktree.
  - The worktree's git-ignored graphics bundle (`npm run build:graphics`).
- Shared caches untouched.

## Needs a practical test
- **Listening:** case 02 with director2's real `keepAmbience` and the clean-up on. Is the 0.3 s hand-off from the
  cleaned voice to the crowd natural? Or does the room tone jump at the edges, when the voice branch was at −20 dB
  just before? A longer ramp is one constant (`AMBIENCE_RAMP_S`).
- **The previews by hand in the app**, on the user's library: a mixkit sound, and a B-roll shot after a real
  (GPU) search.

## Needs from other phases
- **director2:** write `audio.keepAmbience` and hand it over in `applyPlan` (above, and the notes file). Then mostly
  wordless videos can keep the clean-up on for their speech instead of switching it off.
- **Coordinator:**
  - `media:` now refuses non-GET/HEAD methods. Nothing in the app sends others, but keep it in mind.
  - Compound clips render their own timelines: a plan's spans are stored for the main timeline only.

## Open risks
- **Edge comb:** at a span's edges the cleaned and raw branches overlap for 0.3 s. RNNoise adds no timing shift that
  the tests could hear (no doubled level at the edge), but a phase-y blur over that 0.3 s is possible on some sources.
- **Stale spans:** spans are stored per timeline and are not undone with the plan. If the user undoes a plan, its spans
  stay. They only matter where the same source stretch is still in the edit with the clean-up on. Re-applying a plan,
  or an empty list, replaces them.
- **Path in the URL:** a preview URL contains the file's path (base64). That is local only (renderer ↔ main) and never
  leaves the app.
