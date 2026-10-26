# HANDOFF — `director` (Phase 7 of PLAN_editor_and_graphics.md: the director as a pipeline)

Branch `phase7-director` (worktree `D:\capcut new\worktrees\director`), based on `main` 1eb5672. Nothing pushed or merged.
Results: `D:\capcut new\montaj-bench\النتائج\director\` (Arabic summary `rules\ملخص المخرج.md`, per-case cut sheets
`rules\<case>.ورقة-القص.html`, quality reports, planner comparison `planners\planners.json` + `planners\ملخص المقارنة.md`).

## What was built

The old director was one pass of rules over the words. It is now a pipeline (plan item 9 steps 3–6):

1. **Moments** (`src/core/treatments.js`): the video as numbered units that tile the time axis — every sentence said,
   and the wordless stretches between them cut into `action` / `still` moments from perception's event timeline
   (shot-log energy, laughter, applause / cheering / screams from the AudioSet tags, clear loudness spikes). A
   reaction becomes its own moment with its lead-in (the cause) and its tail. Each moment has a role (setup · build ·
   punch · reaction · filler), a strength, a mood (for sound rules), reactions. Without perception the wordless parts
   are `gap` moments (the old view). `eventsOnAxis` maps each file's events onto the director's virtual axis (several
   clips), `momentsTable` is the compact text the models read.
2. **Adapters for phases 5 and 6** (thin, documented in the shared notes `director-notes.md` and below): `linkMoments`
   (phase 6 `montaj.links/1`: links, roles, promises; without it: every laugh / applause / scream at the start of a
   moment is caused by the moment before it, confidence 0.4, unsure) and `takeScorer` (phase 5 `montaj.takes/1` or a
   `score(take, group)` function, matched by IoU ≥ 0.5; unmatched takes rank below scored ones, so the last complete
   take still wins when phase 5 says nothing). The agent reads them from `opts.links` / `opts.takes` (one object, or
   `{ [mediaId]: … }`) or from a service `S.links.cached(path)` / `S.takes.cached(path)` when those exist.
3. **Treatments**: `ruleTreatments` makes 3–5 different edits — result first (a flash-forward of the strongest late
   punch/reaction), the reaction first (medium length), a question first, straight into the action (the slow opening
   dropped), a short version (≤ 45 % / the reel target); reels get their own pair. A treatment is `{ hook: { kind,
   moment }, order: [moment numbers], length }` — **numbers only**. `validateTreatment` drops invented / repeated
   numbers, refuses an invented hook, puts a cause right before its reaction, adds a promise's payoff, keeps clips
   without speech; every fix is listed on the cut sheet. The planner models propose their own (below).
4. **The executor** (`executionSpec` + `src/core/director.js`): a treatment becomes words to drop, wordless spans to
   cut or protect, the edit order and the hook span (`hookSpan`: whole words only, ≤ 3.2 s around the punch word or
   [reaction − 1 s, + 2 s]); `directPlan` takes it as `input.spec` and stays the deterministic edit-hamdy executor
   (pacing, retakes, angles, zooms, J cuts, sounds, captions). `toPlanV2` now orders the kept spans by the treatment
   and prepends the hook copy (`role: "hook"`, its natural place kept). Kept action is cut to its core (tighter in
   shorter treatments) with an angle change every 2.5 s (wide/medium only — a group is never cropped close). A mostly
   wordless video (speech < 45 %, ≥ 20 s of action) keeps its own sound: no voice clean-up (it ducks everything between
   words). `wordlessPlan` handles a treatment with no speech left.
5. **The critic** (`src/core/critic.js`): every treatment is EXECUTED, then scored on the plan's rubric — hook in the
   first 3 s, pace (median/longest shot from the real segments and zooms, dead stretches), punch with its reaction,
   no repeated line, no cut inside a word, story (strength kept, length vs target). `rankTreatments` compares every pair;
   a judge model is asked in both orders (A/B and B/A) and only an answer that survives the swap counts, otherwise the
   rubric decides. A treatment that fails a guard never wins over one that passes.
6. **The verifier** (`src/core/verifier.js`): plan guards that FAIL — `action.cut` (most of a mostly wordless video's
   action cut: 02's 127 s → 17 s, which the old guards called "all passed"), `edit.tooShort`, `links.apart`,
   `links.lost`, and `hook.empty` (warn). They join the quality guards (one `qa` verdict). Output checks after an
   export (`verifyExport` in `src/agent/director.js`, IPC `director.verify`): the export re-transcribed by the same
   speech model, every important line still heard, words at the joints heard as often as the others (both judged
   against the model's own agreement on that file — see "measured"), loudness (−14 ± 1.5 LUFS, true peak), black
   frames, frozen / duplicated frames. `cutSheet` → the chosen treatment and its alternatives side by side, the order,
   the unsure links, the guards.
7. **Models** (`src/services/directorLLM.js`): `LocalDirectorLLM` (llama-server, text only, JSON-schema answers, inside
   the GPU lock — the app's queue plus the machine-wide lock file when `DIRECTOR_GPU_LOCK` / `PERCEPTION_GPU_LOCK` is
   set — stopped after the run) with Qwen3.8-27B or Qwen3.6-35B-A3B; `ClaudeDirectorLLM` (the "stronger director",
   `claude-opus-5-5`, structured output, `fallbacks: "default"`; the key comes from the dialog for one run or from
   `ANTHROPIC_API_KEY`; it lives only in a closure — never on the object, never stored, logged or sent elsewhere; off by
   default). Three calls: `llmTreatments`, `llmJudge`, `llmGraphicsRanker` (all graphics needs in one call).
8. **Graphics and sounds by meaning** (`meaningGraphics`, `meaningSounds` in `src/agent/director.js`): the chosen cut's
   kept words in EDIT time go to `planGraphics` (phase 3) with the model as ranker and perception's face boxes, plus one
   need per wordless reaction kept (a laugh → sticker / emoji, applause → confetti…, never a text template without
   words); the density guard over all; each pick rendered and measured (`measuredChecks`) when the renderer is there,
   a failing pick gives way to its alternative. They replace the director's own random key-word texts, numbers and
   emoji (`opts.graphics: "words"` keeps the old ones). Sounds: punch-ins, transitions and wordless reactions carry
   `query` / `mood` (e.g. «قفشة»/comic, «هيصة»/joy, «صدمة»/shock); the sound library (phase 9) picks the file
   (`sfx[].library`, applied by `applyPlan` from inside the library folder only) and its rules drop what breaks them;
   the bundled sound stays as fallback.
9. **UI and agent fixes routed to this column**: the summary counts cuts from the pacing decision (v2 plans have no
   `cuts`); decision texts for `retakes`, `jl`, `clips`, `treatment`, `hook`, `noPerception`; the dialog has the
   planner choice (rules / local / Claude + a password field that is cleared after the run), "understand the video
   first" (runs perception), and shows the cut sheet; `operations.js` describes v2 plans, the pipeline and the new
   options (`perceive`, `planner`, `plannerModel`, `treatment`, `graphics`, `sounds`) and the Remotion kit in
   `graphics_templates`.

## Files touched
Own column: `src/core/treatments.js` (new), `src/core/critic.js` (new), `src/core/verifier.js` (new),
`src/services/directorLLM.js` (new), `src/core/director.js`, `src/agent/director.js`, `src/core/qa.js`
(`actionAt` reasons), `src/core/editPlan.js` (sfx `library`/`query`/`mood`), `src/agent/editPlan.js` (library sounds),
`src/agent/operations.js`, `src/renderer/js/editor/director.js`, tests `tests/unit/director7.test.js` (new),
`tests/unit/quickwins.test.js` (the two-clip test now allows a hook before the story).
Shared, appended blocks: `src/main/ipc.js` (`director.verify`, `director.planners`, after the perception block),
`src/renderer/js/i18n.js` (Phase 7 block at the end).
No npm packages added. **Claude client uses raw `fetch`** because `@anthropic-ai/sdk` is not a dependency and
`node_modules` is a shared junction here; the coordinator may switch it to the official SDK when merging (one class).

## Tests
- `npm test` in the worktree: **195 / 195 pass** (main was 177; +18 in `tests/unit/director7.test.js`, the two-clip
  director test in `quickwins.test.js` adjusted for a hook before the story and told not to start the render
  measurement / CLAP worker).
- `director7.test.js` covers: moments tiling speech + wordless action/still with reactions on their moment; derived and
  phase-6 links/roles/promises; the phase-5 scorer (best take kept, unmatched → last complete take); 3–5 different
  treatments of moment numbers only and the validator (invented numbers dropped, cause put before its reaction); the
  executor (hook first with role hook and its natural place kept, wordless action kept, the plan validates against
  `EDIT_PLAN_SCHEMA`, a no-speech treatment); **the guards fail on the old director's cut of a wordless game** and pass
  when the action is kept; the critic (rubric ranges; a position-biased judge never survives the swap; a consistent one
  decides); the output checks (lost important line, loudness, black, frozen; agreement-relative joints; no transcript →
  a warning; a missed line settled by its sound); hook spans never inside a word; cuts never touching kept words; long
  takes broken at word boundaries; action-video audio and jump cuts; the GPU-lock helper runs as Node; the judge is told
  what was asked; the Claude client never keeps the key on itself.
- Real runs in the app (Electron through Playwright, its own profile, raws read in place): four rounds of the six cases
  with the rules planner and two with the local Qwen3.8 planner, each exported at 1080p, measured with the main
  checkout's `bench/quality.mjs` (with the story alignment) and checked with `director.verify` — see "Measured".

## Measured
All in `D:\capcut new\montaj-bench\النتائج\director\` (start with `اقرأني.md`). Driver `run_director7.mjs` (the
app of this worktree through Playwright, its own profile, the raws imported in place, 1080p export in the source's
orientation, stabilization and person tracking off as in the quick-wins bench, perception from phase 4's cache), the
main checkout's `bench/quality.mjs` with the raws (story alignment), then `director.verify`. `compare.mjs` puts each run
next to `baselineaseline.json`; `cutsheet.mjs` writes `<case>.ورقة-القص.html`.

Final runs (`rules\` = the rules planner, `local-qwen3.8-27b\` = Qwen3.8-27B planner + judge + graphics ranker):

| case | baseline | rules | Qwen3.8 |
|---|---|---|---|
| 01 vlog | 1:41 · 4/6 · still 5.4 s | 1:31 · 5/6 · still 0.7 s · in medias res | 1:46 · 4/6 · result first |
| 02 challenge | **0:17** · 6/6 (nothing left to fail) | **1:23** · 5/6 · the game kept | 1:23 · 5/6 |
| 03 cooking | 2:04 · 3/6 · still 10.9 s | 2:28 · 5/6 · still 4.8 s · reaction first | 3:51 · **6/6** |
| 04 interview | 2:51 · 4/6 | 2:56 · 5/6 · longest shot 19 → 5.2 s | 2:56 · 5/6 |
| 05 explainer | 3:18 · 6/6 | 3:41 · 5/6 (3 silences ≥ 2 s) · median 3.1 → 1.6 s | 3:41 · 5/6 |
| 06 comedy | 1:17 · 4/6 | 2:08 · 4/6 | 1:56 · 4/6 · the model's own treatment won |

Quality checks passed (the bench's six per case): baseline **27/36**, rules **29/36**, Qwen3.8 **29/36**. All twelve final
exports pass `director.verify` (loudness −14.0…−14.8 LUFS, no black frames, no frozen stretch; important lines heard or
their sound matching the source). The opening comes from later in the raw in 5 of 6 cases (a flash-forward hook),
where the baseline always opened at the start.
- **The new guards on the OLD director's cut** (same words and timeline, computed in `compare.mjs`): the old guards said
  "all passed" on 02 and 06; the new ones fail 02 (1 % of 84 s of action kept), 03 (3 %) and 06 (3 %); 01/04/05 pass.
- **Planner comparison** (`planners\ملخص المقارنة.md`, same moments, every treatment executed and scored, the model
  judging each pair in both orders): Qwen3.8-27B plans in 28 s on average (load 12 s), best treatment score 0.88, 6/26
  treatments fail the guards, judge consistency 73 %, its treatment won the critic in 3/6; Qwen3.6-35B-A3B plans in 9 s
  (load 15 s), 0.85, 8/24, 81 %, 1/6. Neither invented a moment number (JSON schema + validator). **Qwen3.8-27B is the
  default local planner** (`plannerModels` lists it first). (That comparison ran with the first judge prompt.)
- What the bench taught the code (each a commit): the voice clean-up silenced 02's crowd (dead air, −17.5 LUFS) → off
  for wordless videos; kept action as one 13 s shot → jump cuts + angle changes; wordless beats ducked in talking videos
  → < 2 s, one per quiet stretch; a crowd cheer and a long whoosh masked interview lines → short quiet sounds, no voices
  over speech; 19 s interview takes lost on pace → angle changes inside long takes; a left-out moment's cut ate the
  previous word's release (joint words heard 34–45 % vs 78–80 %) → margins around kept words; the Qwen3.8 judge picked
  47–55 s versions of 3–5 min videos → told what was asked. Earlier rounds are kept in `rules-v1..v3\` and
  `local-qwen3.8-judge-v1\`.
- Time: the rules director takes 3–16 s once the words are cached; with Qwen3.8 74–487 s (load ~11 s, plan 20–40 s, the
  rest is the pairwise judge: up to 45 pairs × 2 orders, and the graphics ranker); exports 1–10 min.
- **GPU-lock incident (my mistake, fixed):** the first local run started `gpu-lock.mjs` with Electron's binary; it took
  the shared lock at 11:49 and never exited — the lock was held ~11 minutes with nothing on the card until I killed it
  and released (`fileGpuLock` now runs it as Node; unit test).

## Models downloaded
| Model | Where | Source | Licence | Size | GPU |
|---|---|---|---|---|---|
| Qwen3.8-27B UD-Q4_K_M (GGUF) | `runtime\models\director\qwen3.8-27b\` | huggingface.co/unsloth/Qwen3.8-27B-GGUF (GGUF of the official Qwen/Qwen3.8-27B; Qwen publishes no GGUF), SHA-256 `322e194f…3482` = the repo's LFS hash | Apache-2.0 | 16.5 GB | ~18 GB with a 16k context |
Qwen3.6-35B-A3B (perception's, `runtime\models\perception\qwen3.6-35b-a3b\`) is reused, nothing else downloaded.

## Left on disk (after clean-up, 2026-10-26)
| What | Where | Size |
|---|---|---|
| Qwen3.8-27B UD-Q4_K_M + its SHA-256 | `D:\capcut new\montaj-studio\runtime\models\director\qwen3.8-27b\` (shared by the worktrees' runtime junction; not copied) | 16 GB |
| Final bench: 6 exports + quality/verify/plan/cut-sheet files per run | `D:\capcut new\montaj-bench\النتائج\director\rules\` and `local-qwen3.8-27b\` | 0.9 GB + 1.0 GB |
| Earlier rounds (reports only, their videos deleted) | `…\director\rules-v1..v3\`, `local-qwen3.8-judge-v1\` | ~3 MB |
| Planner comparison, scripts, `اقرأني.md` | `…\director\planners\`, `*.mjs` | < 1 MB |

Deleted: the 26 intermediate exports of the earlier rounds (~3.1 GB on D:), the bench's temporary app profile
`%TEMP%\montaj-director-ud` (1.8 GB on C:; `reverify.mjs` needed its transcript cache, so it can no longer re-check old
runs — a new bench run recreates it), scratch audio clips. Qwen3.6-35B-A3B is perception's file, reused in place.
Nothing was copied from `runtime\models\perception`; the raws were only read.

## Needs a practical test on the user's footage
- The treatments and the chosen one, case by case (the cut sheets): is the hook the moment you would open on? The
  rubric is mine (measured, but its weights are a guess); the plan's "the critic agrees with you ≥ 70 %" test on 20 old
  edits is still to do.
- The wordless moments of 02 (what is kept of the game, the jump cuts every 2.5 s, the wide/medium angles on a group).
- Graphics by meaning on real edits (stickers on laughs, kit templates on sentences) — their look and timing.
- Library sounds by meaning (the moods are guessed from the words, laughter and emotion events).
- Claude as the stronger director: not run (needs the user's key).

## Needs from other phases / the coordinator
- **Export side (`src/core/exportGraph.js`, not mine):** the voice clean-up's between-words ducking (`betweenWords`
  under `denoise`) lowers EVERYTHING between words, so kept wordless action becomes silence (it made 02 read −17.5 LUFS
  with 6 dead-air gaps). The director works around it (no clean-up for mostly wordless videos, short beats in talking
  ones). Better: skip the ducking over spans the plan marks as kept action (the director can pass them, e.g. a
  `plan.audio.keepAmbience: [[from, to]]` list) — then talking videos could keep longer shown moments.
- **Phase 5 / phase 6:** match `montaj.takes/1` / `montaj.links/1` (shared notes `director-notes.md`, section "What the
  director reads"), or expose `S.takes.cached(path)` / `S.links.cached(path)`; the adapter maps either. Unit tests
  show the contract (`tests/unit/director7.test.js`, "links: …", "phase 5 adapter: …").
- **Perception in the app:** the director uses the cached timeline (the app's cache, then `runtime\perception-cache`);
  "understand the video first" runs `perception.analyze` (all stages, ≈ 1.3× the length, GPU). A lighter preset
  (shots + audio + vision only) for the director would be faster — perception's call.
- **Coordinator:** switch `ClaudeDirectorLLM` to `@anthropic-ai/sdk` when it is added to package.json (raw `fetch`
  here because node_modules is a shared junction); the Claude path was never run (no key).
- **Graphics (phase 3):** `planGraphics` gets words in EDIT time and faces in seconds of edit time from the director;
  `measuredChecks` renders each pick (≈ 1–3 s each, cold) — the renderer stays alive in the app afterwards (tests must
  pass `measureGraphics: false` or close it).

## Open risks
- **The rubric is mine.** Its criteria are the plan's, measured, but the weights are a guess and it favours the rules'
  own treatments (they are built from the same strengths). The plan's check — the critic agrees with the user ≥ 70 % on
  20 old edits — is not done yet; until then treat the chosen treatment as a proposal (the cut sheet shows the others).
- **The judge is position-biased:** Qwen3.8 kept the same winner after swapping A/B in 73 % of pairs, Qwen3.6 in 81 %;
  the rest fall back to the rubric (that is why both orders are asked).
- **The local planner is slow on long videos:** Qwen3.8-27B 18–53 s per plan + ~1.4 s per judged order (a 10-treatment
  video has 45 pairs = 90 calls); the judge pool is limited to the treatments that pass the guards.
- **Re-transcription agreement is ~70–77 %** on talking cases (NeMo hears mumbled / short words differently on a second
  pass) and 25 % on 02's crowd: the output checks are judged relative to that agreement, so they catch gross losses and
  masking, not a single clipped syllable. Forced alignment of the expected words onto the export (perception's
  wav2vec2 worker) would be the precise check — a follow-up.
- **Perception quality limits moments:** 02's off-screen TV commentary is transcribed as speech moments; laughter recall
  is ~60 % (phase 4), so some reactions are missed and some links never formed.
- **Hook from the end** (05 opens on the last minute's result): good for retention but spoils an explainer's ending —
  a "no spoiler" option per style may be wanted.
