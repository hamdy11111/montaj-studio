# Phase 6 — flexible cause ↔ reaction links + moment roles («الربط المرن») — hand-off

Branch `phase6-links` (worktree `D:\capcut new\worktrees\links`). Plan: `PLAN_editor_and_graphics.md` v3, section 2
item 9 step 2 (all of it) and the phase table (phase 6). Reads perception's event timeline (phase 4); never edits
`src/services/perception/**` (it imports its `llama.py` / `pcommon.py` worker plumbing and `findRuntime` /
`makeGpuLock` / `fileHash` read-only).

## What was built

For one media file: every **reaction** perception heard or saw, its **candidate causes** in a window that depends on the
content, a **check of the relation** (same people, same scene, and meaning — a vision model looks at the span), the
final **links** (direction, distance, confidence, «متأكد» / «مش متأكد», nothing dropped), the **protection rule** the
director applies, and a **role for every moment** (setup · build-up · punch · reaction · filler). Plus a hand-label
file format, a labelling page, and precision / recall against labels.

```
node src/services/links/cli.mjs <timeline.json|folder>… --out <dir> [--verify qwen3.6|qwen3-omni|both|none]
     [--gpu-lock "D:\capcut new\gpu-lock.mjs"] [--hint challenge|prank|comedy|vlog…] [--labels <dir>] [--continue <dir>] [--refresh]
```
Writes `<name>.links.json` (the document), `<name>.labels.html` (labelling page), `<name>.eval.json` when labelled,
`eval.pooled.json`, `index.html` (Arabic overview). App: `LinkService` (`src/services/links/linkService.js`), created
in `services/index.js` with the app's GPU queue; IPC `links.status`, `links.analyze(mediaId, {verify, hint, options})`,
`links.get(mediaId)`, progress event `links:progress`.

### Pipeline (src/core/causeLinks.js, pure)

1. **Reactions** (`findReactions`): `laughter`; `audio_tag` Applause/Clapping → applause, Cheering/Crowd → cheer,
   Scream/Shout/Yell → scream, Gasp, laugh tags; `loudness_spike` (weight from dB above the median, halved inside
   someone's sentence = emphasis); `pitch_spike`; **exclamations** from the moments lexicon (`detectMoments` laugh /
   shock / oops / win → `verbal`); **sudden silences** (`suddenSilences` on the cached 16 kHz WAV: lively → ≥ 12 dB drop
   held ≥ 0.8 s); **face changes** from the shot log's "change" sentence (smiles, laughs, covers face…). Evidence closer
   than 0.6 s merges into one reaction, strength = 1 − Π(1 − w); weaker than 0.3 is not linked.
2. **Scenes** (`findScenes`): shot cuts + a stable indoor↔outdoor flip in the shot log (≥ 2 windows; free-text "where"
   proved too noisy). **Profile** (`contentProfile`): the user's content type when given, else *event* when speech
   covers < 25 % of the file or a challenge / promise is said («لو عملتها هاخد…», «اللي يكسب…», رهان، تحدي، عقاب…),
   else *speech*.
3. **Causes** (`findCauses`): every utterance (promises marked), vision windows with movement or energy ≥ 3, sudden
   sounds (non-reaction tags, bursts outside speech). **Candidates** (`candidates`): speech profile −2…+8 s around the
   line (cause up to 8 s before, or starting up to 2 s after — the laugh before the punchline ends); event profile back
   to the scene start (≤ 300 s) and on to its end (≤ 30 s), the scene's **promise always kept**. Prior = time kernel ×
   cause kind × same people (face identity / voice co-presence, `peopleIn` / `samePeople`) × same scene × punchline
   bonus; best 4 (speech) / 5 (event) kept.
4. **Semantic check** (`verifyQueries` + `workers/verify_links.py` + `applyAnswers`): one multiple choice per reaction
   (cheaper than one call per pair, and the model compares): ~12 frames (dense in the 8–10 s before and during the
   reaction, one on each far candidate), the words said, what the sound models flagged (in words — Qwen3.6 cannot
   hear), candidates lettered **in time order** (the first version listed them by prior and the model favoured "A").
   The answer is grounded: `reaction_seen` (laughing, shocked, hands_on_head… / nothing_visible / camera_away),
   `reaction_frame`, `cause` (a letter / "other" / "none"), `cause_frame` (one of the given frame times), confidence,
   reason. A chosen 12 s vision window is narrowed to ~2 s around the named frame (only when well inside the window —
   v1 showed the model echoing the window's start time). **Decoys** (`controlQueries`): the same question at 6 calm
   moments with nothing flagged; the false-yes rate there (`calibrationFrom`) discounts the model's confidence.
   **Both engines** (`mergeAnswers`): the eye (Qwen3.6) and the ear (Qwen3-Omni, hears the clip): a heard laugh makes a
   reaction real; crying / talk / a shouted call heard there leaves only a strong visible reaction, not a smile.
5. **Links** (`finalizeLinks`): confidence = 0.35 × prior + 0.65 × P(model says yes), or ≤ 0.6 × prior when unchecked;
   **«متأكد»** only for the best link of a reaction with confidence ≥ 0.65 AND the model's calibrated yes ≥ 0.5 AND the
   reaction judged real. Everything else stays, as «مش متأكد». A reaction the model calls not real keeps its links at
   reduced weight.
6. **Roles** (`src/core/momentRoles.js`): moments = utterances + reactions outside speech + vision-placed causes + the
   gaps (≤ 6 s each). Punch = the cause of a linked reaction (a long vision window only its last 3 s); reaction = the
   reaction moments; setup = the promise, the 1–2 lines before a punch, and plain information; build-up = between the
   setup and the punch, or lively stretches; filler = lone filler words, calm empty stretches. Rules, each with `why`
   and a confidence — the director's model may override them.
7. **Protection** (`protectKeeps`, `checkEdit`) — see the contract.

## The contract: `montaj.links/1` (what `director` reads)

All times in **seconds of the media** (same clock as the perception timeline; `scale: 1e6` in the helpers for µs).

```
{ schema: "montaj.links/1",
  media:    {path, name, hash, duration},
  profile:  {kind: "speech" | "event", source: "hint" | "auto", reason},
  scenes:   [{id: "SC1", t0, t1, why: "start" | "cut" | "place"}],
  reactions:[{id: "R001", t0, t1, kind, kinds: [...], strength 0..1, speakers: ["S1"…],
              evidence: [{type, id (timeline event id), kind, w, text?}],
              verified: {real: bool, confidence, seen?} | null}],
  causes:   [{id: "C001", t0, t1, kind: "speech" | "promise" | "action" | "sound", text, speaker, energy,
              evidence: [timeline event ids], placedBy?: engine, refines?: "C0xx" (the window it narrows)}],
  links:    [{id: "L001", reaction: "R001", cause: "C003", rank (1 = best of this reaction), best: bool,
              direction: "after" (cause first) | "before" (the reaction comes first), offsetS (reaction.t0 − cause.t0),
              gapS (silence between the two spans, 0 if they touch), prior, confidence 0..1,
              status: "sure" | "unsure", label_ar: "متأكد" | "مش متأكد", keepGap: gapS ≤ 3 s,
              checks: {samePeople: true | false | null, sameScene: bool,
                       semantic: {yes, confidence (calibrated), reason, engine} | null}}],
  moments:  [{id: "M001", t0, t1, kind: "speech" | "reaction" | "action" | "gap", text, speaker,
              role: "setup" | "build_up" | "punch" | "reaction" | "filler", role_ar, roleConfidence, why,
              links: ["L001"…], energy}],
  report:   {counts, verify: {engine, available, calibration: {n, realRate, causeRate} | null, answers, controls,
             runs | vision/audio…}, roles: {seconds per role}, silences, ms} }
```

Stable promises: ids are `R###`, `C###`, `L###`, `M###`, `SC#` (stable for the same timeline + knobs); new fields
may be added, existing ones keep their meaning. Every reaction has ≥ 1 link when any cause is in its window; exactly
one link per reaction is `best`.

**Helpers for the director** (all pure, in `src/core/causeLinks.js`):
- `directorView(doc, {scale: 1e6, minConfidence, sureOnly})` → `{links: [{id, status, label_ar, confidence, direction,
  gap, keepGap, cause: {id, t0, t1, kind, text}, reaction: {id, t0, t1, kind, kinds, strength, real}}], moments: [{id,
  t0, t1, role, roleConfidence, links}]}` — the adapter's input.
- `protectKeeps(doc, keepRanges, {scale, includeUnsure, minConfidence, maxCauseS})` → `{keeps, added: [{link, t0, t1,
  why: "cause" | "reaction" | "gap"}]}`: a kept reaction brings its cause back (a long vision window trimmed to the
  6 s nearest the reaction, a promise whole), a kept cause its reaction, a near link (gap ≤ 3 s) its gap.
- `checkEdit(doc, segments, {scale})`, segments = the output in order `[{t0, t1, hook?}]` → violations `cause_lost`,
  `reaction_lost`, `split` (a near link's gap cut), `order` (the body plays the reaction before its cause),
  `hook_cause_missing` (the hook borrows a reaction whose cause never plays in its natural place), each with
  `message_ar` for the cut sheet.
- By default only «متأكد» links are protected / checked (`includeUnsure: true` widens it); show the «مش متأكد» ones
  on the cut sheet (`label_ar`).

**Mapping to the shape the `director` adapter expects** (its `director-notes.md`, "montaj.links/1"), from
`directorView(doc)` (seconds, `scale` 1):

| director's field | here |
|---|---|
| `links[].cause {t0, t1, text, eventIds}` | `links[].cause {t0, t1, text}`; event ids: `doc.causes[id].evidence` |
| `links[].reaction {t0, t1, type, eventIds}` | `links[].reaction {t0, t1, kind, kinds}` — `type` = `kind` (laughter, applause, cheer, scream, gasp, verbal, sudden_silence, face_change, loud_spike, pitch_spike); event ids: `doc.reactions[id].evidence[].id` |
| `links[].direction` | same (`after` = cause first, `before` = reaction first) |
| `links[].gapS` | `gap` (seconds when `scale` 1) |
| `links[].confidence` | same |
| `links[].unsure` | `status !== "sure"` (also `label_ar`); reactions the check judged not real: `reaction.real === false` |
| `links[].why` | `doc.links[].checks.semantic.reason` |
| `roles[] {t0, t1, role, confidence}` | `moments[] {t0, t1, role, roleConfidence}`; role `build` = `build_up`, the others are the same words |
| `promises[] {t0, t1, text, payoff}` | `doc.causes` with `kind: "promise"`; the payoff = the reaction of a link whose cause is that promise |

`directorView` returns only the best link of each reaction; the alternatives are in `doc.links` (`best: false`).

Service: `LinkService.cached(mediaPath | timeline)` → the last document; `analyze(...)` makes one (needs perception's
timeline in its cache). Cache: `<runtime>/links-cache/<media hash>/` (`links.json`, `links.<engine>.json`,
`answers.<engine>.json` — one cached answer per exact question, so re-scoring with new knobs needs no GPU).

## Results on the user's cases

`D:\capcut new\montaj-bench\النتائج\links\` — `index.html` (Arabic overview), per case `<case>.links.json` and
`<case>.labels.html`; `labels\` (my labels for 02 and 06), `*.eval.json`, `eval.pooled.json`; `v1-baseline\` (the first
prompt's results, kept for comparison); `both\` (02 and 06 with the eye + ear merge).

Qwen3.6 check (default), all six cases, frames 448 px, 6 calm decoys each:

| Case | Profile | Reactions | Judged real by the check | «متأكد» links | Decoy false-yes | Check time |
|---|---|---|---|---|---|---|
| 01-فلوق | event («حبيت اعمل فيهم مقلب» — it is a prank) | 12 | 4 | 4 | 1/6 | 49 s |
| 02-تحدي | event (speech 11 % of the file) | 21 | 12 | 12 | 1/6 | 68 s |
| 03-طبخ | speech | 48 | 3 | 3 | 0/6 | 204 s |
| 04-مقابلة | speech | 4 | 0 | 0 | 0/6 | 25 s |
| 05-شرح | speech | 58 | 2 | 2 | 0/6 | 180 s |
| 06-كوميديا | speech | 18 | 4 | 4 | 0/6 | 67 s |

Qwen3.6 server load ≈ 20 s, ≈ 2.5 s per question (12 frames). Qwen3-Omni load ≈ 25 s, ≈ 2.0 s per question (6 frames +
≤ 12 s of sound). Frame extraction from the 4K HEVC raws runs on the CPU before the GPU lock (≈ 1–3 min per case).
VRAM was not measured by me (model files: Qwen3.6 17.3 GB, Qwen3-Omni 18.5 GB; perception measured Qwen3.6 at ≈ 18.5 GB).

**Measured against labels — read the caveats first.** No labels from the user exist yet. I labelled 02 and 06 myself
from 2 fps contact sheets of the whole files plus the transcript, **without hearing the sound**, before reading the
model's answers; I judged only what the frames decided and marked the rest «مش متأكد» (left out). That leaves **8 real
reactions, 3 of them with a cause visible in the footage, and 3 flagged moments that are not reactions** — far from the
plan's 50 links; the numbers below say whether the method works at all, not how well. Scores of the best link per judged
reaction:

| Version | Best-link precision | «متأكد» precision | Labelled cause = best link | Labelled cause among candidates | Real reactions kept | Not-real moments caught |
|---|---|---|---|---|---|---|
| no check (proximity only) | 1/12 = 8 % (all «مش متأكد» by design) | — | 1/3 | 3/3 | 8/8 (nothing judged) | 0/3 |
| v1 prompt (free choice) | 2/12 = 17 % | 2/12 = 17 % (all 12 «متأكد») | 2/3 | 3/3 | 8/8 | 0/3 — it called every moment a real reaction, 0.85–0.95 sure |
| **v2 Qwen3.6 (default)** | 3/12 = 25 % | 2/8 = 25 % | **3/3** | 3/3 | 7/8 | 2/3 |
| v2 eye + ear (`both`) | 2/12 = 17 % | 2/7 = 29 % | 2/3 | 3/3 | 6/8 | 2/3 (other ones) |

What the numbers and the answers show:
- **The first prompt was useless as a check**: it said "real, caused by A, 0.9" to all 21 reactions of 02. v2 grounds
  the answer on named frames, offers "nothing visible" / "none" explicitly, letters the candidates in time order (v1
  picked "A" = the top-prior candidate most of the time), and is calibrated on decoys. It now says "nothing visible" to
  about half of the flagged moments, most of which are the loudness bursts of a noisy party, which is right by eye.
- **The candidate windows work**: the right cause was among the candidates for every labelled link (3/3) in every
  version, including the 6 s gap of 02's penalty (the TV at 95.8–101.5 s → hands on heads at 102 s).
- **Most «متأكد» links are about the right moment but not the cause I labelled**: e.g. 06 R002 (the dad grins after his
  own line about the battery) — the model links it to that line, I had labelled «no visible cause»; plausible, so my
  labels are a weak judge too. 02's opening celebration has no visible cause (it happened before the recording); the
  model links each cheer to the dancing — understandable, but not the editorial cause.
- **The ear (Qwen3-Omni) adds what the eye cannot**: in 06 it heard the toddler **crying** at 96–102 s (perception's laugh
  detector had called it laughter) and the shouted «يلا يا بلال اركب» as talk — the eye had accepted that call as a
  reaction. But it heard laughter at 107 s where I see none, in 02's party it hears laughter or cheering in 5 of 6 calm
  decoys (calibration then discounts it heavily), and the cautious merge (a smile over talk is not a reaction) dropped
  the real laugh of 06 at 48 s. `both` stays an option, not the default, until the user's labels decide.
- **The protection rule on the baseline problem (02)**: a speech-only cut keeps 19.4 s of 02; protecting the «متأكد»
  links adds back 4 pieces (23.9 s; 27.0 s with the «مش متأكد» ones too). The 12 «متأكد» links alone span 37.4 s in 12
  pieces — the material a director can build the challenge cut from, instead of the 17 s the old editor kept.
- Roles in 02: build-up 61 s, filler 22 s, reaction 18 s, punch 15 s, setup 11 s; in 04 (a talk interview) setup 136 s,
  no punch — as expected from rules that follow links (setup there just means "information").

## Labels and measurement

Label file `montaj.links-labels/1` (`src/services/links/labels.js`): `{schema, media, labeller, method, note,
reactions: [{id, t0, t1, kind, real: true | false | null, unsure, noCause, causes: [{t0, t1, kind, text}], note}]}`.
Rows that are `unsure` / `real: null` are left out of every score, and so are found reactions that only touch them.
`evaluate(doc, labels)`: reactions (precision / recall, before and after the check) and links (best-link precision,
precision of «متأكد», recall of the labelled cause at rank 1 and anywhere in the candidates). Matching is by time
(±0.75 s for reactions, ±1.5 s for causes), not ids.

The labelling page (`<name>.labels.html`) opens the raw file in place through `file://` (no copy), lists every
reaction with its candidates, and lets the user mark real / not real / unsure, pick or hand-mark the cause, add a
reaction the system missed at the video's current time; it autosaves in the browser and downloads `<name>.labels.json`
for `--labels`. It starts blank by default (`--continue <dir>` to resume a file) so nobody's earlier guesses steer the
labeller. Tested in the built-in browser for the rows, buttons and saved state; **the HEVC video playback through
`file://` was not tested** (the pane cannot open files outside the project) — needs a try in the user's Chrome/Edge.

## Files

New: `src/core/causeLinks.js`, `src/core/momentRoles.js`, `src/services/links/{linkService.js, labels.js, cli.mjs,
workers/verify_links.py}`, `tests/unit/links.test.js`, `HANDOFF.md`.
Shared files, append-only: `src/services/index.js` (import + `links` service after perception, `links` added to the
returned object), `src/main/ipc.js` (block `links.status|analyze|get` after the perception block),
`src/preload/preload.cjs` (one `EVENTS.add("links:progress")` line).

## Tests

`npm test` in the worktree: **195/195 green** (18 new in `tests/unit/links.test.js`: promises, reactions and their
merging, scenes, the profile, the time prior in both directions, candidates and same people / same scene, the event
profile's promise, unchecked links never «متأكد», the questions and the narrowing of long windows, decoys and
calibration, answers pinned to their causes, protection of kept ranges and the µs scale, the edit checker, the moment
roles, the label file / scores / pages, the WAV reader and the sudden silences, eye + ear merging, the director view).
The Python worker and both models ran end to end on the six bench cases (Qwen3.6) and on 02 / 06 (Qwen3-Omni); that is
not in `npm test` (it needs the GPU runtime). The labelling page was clicked through in the built-in browser (rows,
buttons, saved state).

## Models

| Model | Where | Source | Licence | Size | Role |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B UD-IQ4_XS + mmproj F16 | `runtime\models\perception\qwen3.6-35b-a3b\` | perception's copy, **reused — not downloaded again** | Apache-2.0 | 17.3 GB | the default eye |
| **Qwen3-Omni-30B-A3B-Instruct Q4_K_M + mmproj Q8_0** (new) | `runtime\models\perception\qwen3-omni-30b-a3b\` | huggingface.co/ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF (the official GGUF of Qwen/Qwen3-Omni-30B-A3B-Instruct; not gated) | Apache-2.0 (base model card) | 18.56 GB + 1.33 GB, SHA-256 match (d9e28765…, 1104376d…) | the ear (`--verify qwen3-omni` / `both`) |

The Omni files sit in the folder perception's `windowCheck()` hook already reads, so that hook stops answering
"unavailable" (not re-tested through perception's code by me). The existing llama.cpp b11870 (`runtime\llama`) loads
both. **Keye-VL-2.0 was not tried**: it needs Kwai's own llama.cpp fork built from source (perception's finding), and
its question ("the exact moment") is partly covered here by the grounded frame choice; worth a test only if precise
cause timing turns out to be the bottleneck once the user's labels exist. No new venv: the worker runs in
`runtime\perception`.

## Open risks / needs

- **The measurement is tiny and mine, not the user's**: 8 real reactions / 3 visible causes on 2 files, labelled from
  frames without sound. «متأكد» precision ≈ 25–30 % on that sample. The plan's 50 hand-labelled links from the user's
  pranks and challenges are still needed — the labelling page is ready (`<case>.labels.html`; the saved files go into
  `labels\`, then the CLI with `--labels`). Tune `LINK_DEFAULTS`, the merge rule and `sureAt` on those labels; the
  answers are cached per question, so re-scoring is free.
- **What a "reaction" is depends on perception**: loudness bursts are most of the reactions in noisy footage (02, 03,
  05) and most are not reactions; the laugh detector hears a crying toddler as laughter (06). The check removes many,
  not all.
- **The cause of a celebration is often before the recording or off screen** (02's TV goal, lines nobody transcribed in
  06). The model then links the nearest visible action; the label file has `noCause` for these, and the director should
  not build a hook on such a link alone.
- **The decoys are a crude control**: a calm moment can still hold an unflagged reaction (crowd footage), which makes
  the calibration pessimistic there; with the ear, the decoys of a party are mostly "heard laughter".
- Roles are rules on top of links; with few «متأكد» links most moments fall to setup / build-up / filler. The plan's
  "the model decides each moment's role" is left to the director's model (every moment has `why` and a confidence); an
  LLM role pass in this worker is a possible follow-up.
- The labelling page plays the raw HEVC files through `file://` — not tested in the user's browser (HEVC needs the
  browser's hardware decoding; Chrome/Edge on this PC should have it).
- For other phases: `director` (phase 7) reads `directorView` / `protectKeeps` / `checkEdit` through its adapter;
  perception's `windowCheck` can now use Qwen3-Omni (the coordinator may want perception to re-test it).
- GPU: every model run took `gpu-lock.mjs` (name `links`) for the model only; I waited for `best-take` and `director`.
  One early run held the lock while extracting frames for ~5 minutes before I moved frame extraction out of the locked
  part (stopped by me, lock released; nothing else was affected).
