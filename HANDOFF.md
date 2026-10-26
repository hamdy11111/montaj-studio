# Phase 3 — graphics layer: hand-over

Branch `phase3-graphics` (worktree `D:\capcut new\worktrees\graphics`), on top of `main` 0fe8ace.
Plan: `D:\capcut new\PLAN_editor_and_graphics.md` v3, item 10 and §5.

## What was built

1. **Remotion graphics layer** (`src/graphics/**`).
   - Graphics are React components (`src/graphics/remotion/**`). The same `Graphic` component is rendered for the
     export and shown in the editor by the Remotion Player, so the preview is the export.
   - Export (the edit-hamdy "hybrid render"): only the transparent overlay is rendered, never the video.
     - `render.js` + `renderWorker.js`: a child process that keeps one Chrome Headless Shell open. Each graphic
       becomes a ProRes 4444 clip, and FFmpeg composites it (`core/exportGraph.js`: a `.mov` overlay is read as alpha
       video from the segment start).
     - Speed-ups:
       - (a) only the band of the frame the graphic moves in is rendered (`kitCrop`). If the drawing touches the
         band's edge, it is rendered again on the whole frame (measured), so nothing is ever cut off.
       - (b) all missing graphics are rendered together, one render per band height (a cost model picks the groups).
         They are then cut per graphic by stream copy, which is frame-exact.
       - (c) clips are cached by template, parameters, size and bundle.
   - Preview: `src/graphics/preview/entry.jsx` is built to `src/renderer/js/editor/graphicsPlayer.js`.
     `graphicsRaster.js` attaches a Remotion Player layer over the preview canvas. It is seeked to the playhead on
     every editor frame and follows the segment's transform, opacity and blend.
     - The layer attaches itself to the editor's `Player` class (it wraps `render`/`destroy`) because `player.js`
       is not in this column. **Coordinator:** replace this with an explicit call in `player.js`, e.g.
       `this.remotionLayer = new RemotionLayer(this)` and `this.remotionLayer.sync()` at the end of `render()`.
       The class is exported from graphicsRaster.js; `installRemotionPreview` can then go.
   - Offline: the browser (Chrome for Testing headless shell 157.0.8080.0, the version this Remotion is tested with)
     is in `runtime/remotion`. It is installed by `npm run setup:graphics` and shipped by `extraResources`.
     - The Remotion bundle, the Player module and the tile posters are build outputs: `npm run build:graphics`,
       chained into `predist`/`prepack`, and git-ignored.
     - The compositor is unpacked from the asar (`asarUnpack`), and its path is passed to Remotion
       (`binariesDirectory`).
   - The existing 20 canvas templates are unchanged and still drawn by the canvas rasterizer.
2. **The Punchy components** of the edit-hamdy skill:
   - The 26 components of `Punchy.tsx` and `Graphics.tsx`, plus `WordReveal`, make 27 (`src/core/graphicsKit.js`
     `PUNCHY_COMPONENTS`). Ported to JSX in `kit/punchy.jsx`, `kit/numbers.jsx` and `kit/text.jsx`.
   - They work on 9:16 and 16:9: sizes scale with the short side, and positions are fractions of the frame.
   - Colours and fonts come from the style pack, and each component reads the frame itself (motion blur works).
   - NarratorCard now types whole words: the skill sliced letters, which breaks the Arabic shaping.
   - CompareGauge and ListMontage moved to clear the Reels/TikTok button column (the hard checks caught it).
3. **Official Remotion extras**, all 4.0.538 and each rendered in `05-extras-vertical.mp4`. Each one has a kit template
   that exercises it (`kit/extras.jsx`):

   | Package | Template | What it does |
   |---|---|---|
   | `@remotion/gsap` | `GsapTitle` | GSAP timeline seeked from the frame |
   | `@remotion/rough-notation` | `HandDrawn` | hand-drawn circle, underline, highlight, box, cross, bracket |
   | `@remotion/motion-blur` | `KineticWord`, `ImpactNumber` | motion blur on the drop |
   | `@remotion/transitions` | `SwapCard` | wipe, slide, flip, clock |
   | `@remotion/paths` | `PathArrow` | `evolvePath` and tangent head |
   | `@remotion/shapes` | `ShapeBurst` | star and burst shapes |
   | `@remotion/lottie` | `LottieSticker` | Noto Lottie family |
   | `@remotion/animated-emoji` | `AnimatedEmojiSticker` | transparent webm via `OffthreadVideo` |
4. **Arabic text**:
   - The smallest unit that moves is a word (`src/graphics/arabic.js`). The tests check that the components never
     slice display text.
   - `WordReveal` has three modes: `words` (on spoken times when given), `wipe` (a soft right-to-left mask) and `pop`.
     Key words are bigger and in the accent colour.
   - Fonts: Alexandria, Cairo and Tajawal (the app's bundled files, copied into the bundle), and Calibri Bold (a system
     font, used by name, never shipped). All four are shown in `04-arabic-text-vertical.mp4`.
5. **Style pack and design tokens**: `src/graphics/packs/punchy.js`, one file per pack.
   - Colours by role, fonts and type scale, stroke, shadow and radius, motion (enter/exit, overshoot, shake, spring),
     sound roles with fallbacks, and one emoji/icon/Lottie family (Noto Animated, no flags).
   - The golden reference's density numbers are included. `PACK_SCHEMA` makes the tests fail if a new pack misses a
     role.
6. **Contracts and the selection system** (`src/graphics/needs.js`, `selection.js`, `measure.js`):
   - Contract per template: trigger tags, min/max seconds, max characters (with its text keys), region, needsImage,
     needsCutout, energy, major, fullFrame, `reach` (band) and blend.
   - `sentenceNeeds(words)`: tags each sentence (number, money, percent, delta, list, compare, quote, memory, phone,
     peak, chapter, name, thing, weather, countdown, math, …). Each tag has its anchor word and the sentence has an
     energy. It reuses `core/numbers.js` and `core/moments.js`.
   - `eligible`/`eligibleTemplates`: a deterministic filter. `fillParams` fills parameters from what was said and
     never invents a number, name or picture; it returns null instead.
   - `rankNeed` is the stub interface for the LLM:
     - It receives `ranker({ need, candidates, pack, recent }) → [{ template, params?, score, why }]`.
     - Only eligible templates are accepted, and their parameters are clamped to the schema.
     - It keeps at most 3. `heuristicRanker` is the default ranker (specific tags weigh more than generic ones).
   - `place`: moves a graphic off the face and into the platform-safe rectangle (the edit-hamdy policy zones for
     Reels, TikTok, Shorts and YouTube).
   - `hardChecks`: the entry within ±3 frames of its word, ≤ 5 % of the face covered, ≤ 400 drawn pixels in a
     platform block zone (40 px edge tolerance), and on screen long enough to read (`readSeconds`).
     - It works on predictions, or on measurements via `measure.measuredChecks()`. That function renders the pick and
       reads the alpha of the real frames.
   - `densityGuard`: at most one major graphic per 8 s, no repeat within 45 s, ≤ 40 % of the runtime covered and a
     1.5 s breath after a peak. Persistent HUDs may sit under other graphics, and a pick that breaks a rule gives way
     to its next alternative.
   - `planGraphics(words, opts)` runs all of it and keeps the alternatives for the cut sheet. It is reachable over
     IPC as `graphics.plan`.
7. **VFX/overlay library**: `src/services/vfxLibraryService.js` and `src/services/vfxLibrary/{sources,fetch}.js`.
   - Clips are on disk in `D:\capcut new\assets-library\vfx\{comedy,drama,action,kitchen,transitions}`, with
     `index.json` and `sources.json`.
   - Each clip's background is measured:
     - black → `screen`, or `add` for light sources;
     - white → `multiply`;
     - green → a chroma key;
     - anything else is footage.
   - Each clip has a contract (tags, energy, length) and is picked deterministically. `segmentPatch` gives the blend
     or key.
   - IPC: `vfx.list`, `vfx.rescan`, `vfx.pick`, `vfx.place` (it imports the clip and lays it on the timeline with
     its blend).
   - The emoji family is registered as library items (`media://lib/<id>`), so the Player and the render load the
     same file.

## Files

- **New:**
  - `src/core/graphicsKit.js`
  - `src/graphics/**`: `setup.js`, `build.js`, `render.js`, `renderWorker.js`, `measure.js`, `selection.js`,
    `needs.js`, `layout.js`, `arabic.js`, `emoji.js`, `packs/`, `remotion/`, `preview/`
  - `src/services/vfxLibraryService.js`, `src/services/vfxLibrary/`
  - `tests/unit/graphics.test.js`, `tests/unit/vfx.test.js`, `tests/e2e/graphics.e2e.test.mjs`
  - `tests/bench/graphicsExport.bench.mjs`, `tests/bench/graphicsSamples.mjs`
- **Mine, changed:**
  - `src/core/graphics.js`: the kit is merged into `GRAPHIC_TEMPLATES`, and a Remotion template has one state.
  - `src/renderer/js/editor/graphicsRaster.js`: the Player layer, tile posters, and no PNG states for Remotion
    templates.
  - `src/core/exportGraph.js`: the text-overlay input branch only — `.mov/.webm/.mkv` clips and band overlays padded
    back.
  - `src/services/exportService.js`: the `graphics` renderer, `graphicsOverlays` in `runJob`, `resolveMediaRef`, and
    `writeOverlays` skips Remotion markers.
- **Shared, append-only:**
  - `package.json`:
    - dependency `@remotion/renderer`;
    - devDependencies: remotion and the @remotion packages, react, react-dom, gsap, lottie-web, esbuild;
    - scripts `setup:graphics`, `build:graphics`, `predist`, `prepack`;
    - `asarUnpack` +2;
    - `extraResources` for the browser.
  - `.gitignore`: the build outputs.
  - `src/main/ipc.js`: one block — `graphics.runtime`, `graphics.setup`, `graphics.plan`, `vfx.*`.
  - `THIRD_PARTY_NOTICES.md`: a "Graphics layer" section.

## Tests

- `npm test`: **136/136 pass** (191 s).
  - `graphics.test.js` has 15 tests, including a real render that is measured, band-checked and composited.
  - `vfx.test.js` has 4 tests.
- `node --test tests/e2e/graphics.e2e.test.mjs`: **pass**. It runs the real app:
  - kit graphics are added;
  - the Remotion Player layer shows "فراخ" over the canvas;
  - the export composites the rendered clips (a frame difference against the source); there are no page or CSP
    errors.
- The same e2e against the **packaged app**: `npm run pack`, then
  `MONTAJ_E2E_EXE="…\dist\win-unpacked\Montaj Studio.exe"`. Result: **pass**.
  - The worker forks from the asar with `ELECTRON_RUN_AS_NODE`, the bundle and compositor are unpacked, the browser
    is in `resources
untime
emotion`, and nothing is downloaded.
  - The first packaged run failed because Remotion looks for `bundle.js.map` and the installer drops `*.map`. The
    bundle is now built without source maps.
- Speed (`tests/bench/graphicsExport.bench.mjs`): 1080×1920, 30 s, 10 graphics × 3 s covering the whole video,
  H.264 1080p export in the app, the fastest of 3 rounds, on a quiet i9-13900K:

  | Case | Whole export | Graphics share (above the 1.9 s plain export) |
  |---|---|---|
  | No graphics | 1.9 s | — |
  | Canvas graphics (PNG per frame state) | 9.7 s | 7.8 s |
  | Remotion layer, cold (nothing cached) | 14.5 s | 12.7 s |
  | Remotion layer, warm (cached clips) | 3.7 s | 1.9 s |

  The cold render is 1.6× the old path: it captures 900 animated 1080×1920 frames, about 71 fps after the speed-ups.
  The old path only drew each graphic's held frame once. Before the band and packing speed-ups the cold render took
  48.5 s on the same test (on a busier machine).
  - Warm, which is every re-export after an edit that leaves a graphic unchanged, it is 4× faster than the old path.
  - The editor never waits for it: the preview is the live Player.
  - Raw numbers: `D:\capcut new\montaj-bench\النتائج\graphics\bench\export-bench.json`, with one export frame per
    path next to it.
- Sample videos, with a contact sheet and README listing what is when: `D:\capcut new\montaj-bench\النتائج\graphics\`.
  - `01-punchy-vertical` on the comedy case
  - `02-numbers-vertical` and `03-story-vertical` on the vlog
  - `04-arabic-text-vertical`, with the four fonts and three reveals
  - `05-extras-vertical`, with the official extras
  - `06-mixed-horizontal` on the interview (kept horizontal)
  - `07-vfx-library-vertical`, with the VFX over the cooking case
  - The raw footage was read in place.

## Downloads (outside git)

| What | Where | Size | Licence |
|---|---|---|---|
| Chrome Headless Shell 157.0.8080.0 (Google Chrome for Testing) | `runtime\remotion` | 283 MB | Chromium terms |
| 46 VFX clips from Mixkit (some hard-linked into two categories) | `assets-library\vfx` | 1.6 GB | Mixkit Free, or Restricted per clip in `index.json` |
| 80 Noto Animated Emoji Lottie files (copied from the edit-hamdy skill) | `assets-library\emoji\noto-lottie` | 4 MB | CC BY 4.0 |
| 30 animated-emoji webm (remotion-dev/animated-emoji) | `assets-library\emoji\animated-webm` | 8 MB | CC BY 4.0 |

Not fetched, because they need an account or are paid:
- **ProductionCrate**: the free tier needs a login and has a daily limit.
- **ActionVFX**: needs an account, and most packs are paid.
- **Pixabay**: the site blocks scripted downloads, and the API needs a personal key.

The user can drop their own clips into a category folder and run `vfx.rescan`.

## Needs a practical test (by the user)

- The look and timing of each component on real edits, against the graphics rubric. The samples are a start; the
  placements in them were set by hand.
- The preview layer while playing long timelines with many graphics: each visible graphic is one Player.
  - Known approximation: in the preview, kit graphics are drawn above every canvas layer.
  - Text behind the person is not supported for kit graphics yet: they render on top.
- The NSIS installer itself (`npm run dist`) was not built. The unpacked packaged app (`npm run pack` →
  `dist\win-unpacked`) **was** tested (see Tests).
- Speed on a busy machine: the CPU was at 100 % from other sessions during part of the runs.

## Needs from other phases / the coordinator

- `player.js`: the explicit hook described above.
- `inspector.js`:
  - Arabic labels for the new parameter keys (PARAM_AR); they show their English titles today.
  - A picker for media fields (src, still, stills) — today they are text fields.
  - "Calibri" in the font list (`core/fonts.js` lists only bundled fonts).
- `operations.js` (agents): the `graphics_templates` description lists only the old templates. The list itself
  already includes the kit.
- Director (phase 7): call `planGraphics` with an LLM ranker and perception's face tracks (`faces`). Show `alternatives`
  in the cut sheet, and use `measuredChecks` before applying.
- media (phase 9): the punchy sounds (boom, scratch, sting, slide, flash, streak) for the pack's sound roles. Cut-out
  PNGs for `TitleCard` left/right and `PhotoCard` cutout.

## Open risks

- **Export speed.** A cold Remotion render is slower than the old PNG-state path for the same number of graphics. The
  old path holds still frames, while kit graphics move on every frame.
  - It is faster once cached, and quality is the point.
  - Bands help most for small graphics; full-frame looks (title card, tints, streaks) cost the full price.
- **Remotion License.** Free for individuals and companies of up to 3 people. Fine for this personal app; it would
  matter if the app were sold.
- **Browser version.** Remotion pins Chrome 157.0.8080.0. Upgrading `@remotion/*` may need a new browser:
  `CHROME_VERSION` in `src/graphics/setup.js`.
