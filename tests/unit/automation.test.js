// Editing automation: speech analysis (fillers, pauses, retakes, suggested cuts), word-timed caption templates
// (pages, animation states, edits, reading speed), edit-plan mapping and checks, and — through the real services and
// agent layer — applying a whole edit plan (cuts, zoom, text, transition, audio, captions) as one undo step with
// rollback, revision checks and caption data that survives the database. The transcript is fixed (stubbed) so the
// result does not depend on a speech model; the real provider is exercised in the e2e tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { AgentHub } from "../../src/agent/controlServer.js";
import { fillers, pauses, retakes, sentences, suggestCuts, normWord } from "../../src/core/speech.js";
import { paginate, captionStates, captionWords, captionQc, emphasisFor, CAPTION_TEMPLATES, POP_FRAMES } from "../../src/core/captionTemplates.js";
import { mainPieces, mapSpan, mapPoint, predictCuts, normalizeCuts, checkPlan } from "../../src/core/editPlan.js";
import { US } from "../../src/core/util.js";
import { refineWordTimes } from "../../src/services/captionService.js";

const W = (text, s, e) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US) });
// "So today I want to show you, um, three tricks. [1.5 s] The first trick is cut. The first trick is to cut silence."
const TALK = [W("So", 0, 0.3), W("today", 0.3, 0.6), W("I", 0.6, 0.8), W("want", 0.8, 1.0), W("to", 1.0, 1.2), W("show", 1.2, 1.4), W("you,", 1.4, 1.7), W("um,", 1.8, 2.3),
  W("three", 2.8, 3.1), W("tricks.", 3.1, 3.9), W("The", 5.4, 5.6), W("first", 5.6, 5.9), W("trick", 5.9, 6.2), W("is", 6.2, 6.4), W("cut.", 6.4, 6.9),
  W("The", 7.3, 7.5), W("first", 7.5, 7.8), W("trick", 7.8, 8.1), W("is", 8.1, 8.3), W("to", 8.3, 8.4), W("cut", 8.4, 8.7), W("silence.", 8.7, 9.4)];

test("speech analysis: sentences, sure and possible fillers, pauses, retakes", () => {
  const sents = sentences(TALK);
  assert.deepEqual(sents.map((s) => s.text), ["So today I want to show you, um, three tricks.", "The first trick is cut.", "The first trick is to cut silence."]);
  const f = fillers(TALK);
  assert.deepEqual(f.filter((x) => x.sure).map((x) => x.text), ["um,"]);
  assert.deepEqual(f.filter((x) => !x.sure).map((x) => x.text), ["So"]);
  const p = pauses(TALK, { minUs: 500_000, durationUs: 10 * US });
  assert.deepEqual(p.map((x) => [x.fromUs, x.toUs]), [[2_300_000, 2_800_000], [3_900_000, 5_400_000], [9_400_000, 10_000_000]]);
  const r = retakes(TALK, sents);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "restart");
  assert.equal(r[0].text, "The first trick is cut.");
  assert.deepEqual(retakes([W("the", 0, 0.2), W("the", 0.3, 0.5), W("end", 0.5, 0.9)]).map((x) => [x.kind, x.text]), [["repeat", "the"]]);
  // Arabic: diacritics/alef forms normalised, and a hesitation glued to a one-letter prefix counts only when isolated.
  assert.equal(normWord("أَوَّل،"), "اول");
  const ar = [W("هوريكم", 1, 1.5), W("بأمم", 1.7, 2.2), W("تلات", 2.5, 2.8), W("بامتياز", 3, 3.5)];
  assert.deepEqual(fillers(ar).map((x) => [x.text, x.sure]), [["بأمم", true]]);
  // "فطبعا إيه؟" (rhetorical question between pauses) is speech, not a hesitation — found on a real recording.
  assert.deepEqual(fillers([W("فطبعا", 50.6, 51.1), W("ايه?", 51.12, 51.44), W("كل", 52.7, 53.0)]), []);
});

test("suggested cuts remove pauses (keeping air), sure fillers and the first attempt of a retake", () => {
  const cuts = suggestCuts(TALK, { style: "natural", durationUs: 10 * US });
  const reasons = cuts.map((c) => c.reason);
  assert.ok(reasons.some((r) => r.includes("filler")));
  assert.ok(reasons.some((r) => r.includes("retake")));
  assert.ok(reasons.some((r) => r.includes("pause")));
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i].fromUs > cuts[i - 1].toUs, "merged, non-overlapping");
  const retake = cuts.find((c) => c.reason.includes("retake"));
  assert.ok(retake.fromUs <= 5_400_000 && retake.toUs >= 7_200_000 && retake.toUs < 7_300_000, "the false start is removed, the next sentence kept");
  const tight = suggestCuts(TALK, { style: "tight", durationUs: 10 * US });
  const removed = (cs) => cs.reduce((n, c) => n + c.toUs - c.fromUs, 0);
  assert.ok(removed(tight) > removed(cuts), "tight removes more than natural");
  assert.ok(!cuts.some((c) => c.fromUs < 300_000), "possible fillers ('So') are never cut automatically");
});

const words = (list) => list.map(([t, s, e]) => ({ t, s: s * 1000, e: e * 1000 }));

test("caption pages break at punctuation, pauses and the template budget; states follow the spoken word", () => {
  const ws = words([["The", 0, 200], ["second", 200, 500], ["trick", 500, 800], ["is", 800, 900], ["to", 900, 1000], ["add", 1000, 1200], ["captions,", 1200, 1700], ["because", 2600, 2900], ["most", 2900, 3100]]);
  const pages = paginate(ws, "karaoke-yellow");
  assert.deepEqual(pages.map((p) => p.words.map((w) => w.t).join(" ")), ["The second trick is to", "add captions,", "because most"]);
  assert.equal(pages[0].endUs, pages[1].startUs, "short gaps are bridged (no flicker)");
  assert.ok(pages[1].endUs < pages[2].startUs, "a long pause leaves a gap");
  assert.ok(paginate(ws, "single-pop").every((p) => p.words.every((w) => w.t === w.t.toUpperCase())), "single-pop is upper case");
  // States of the first page: page pop frames, then the active word changes at each word start.
  const pg = pages[0];
  const text = { content: pg.words.map((w) => w.t).join(" "), caption: { template: "karaoke-yellow", words: pg.words.map((w) => ({ ...w, s: w.s - pg.startUs, e: w.e - pg.startUs })) } };
  const st = captionStates(text, pg.endUs - pg.startUs, 30);
  assert.deepEqual(st.slice(0, POP_FRAMES.length).map((x) => x.pop), POP_FRAMES);
  assert.deepEqual([...new Set(st.map((x) => x.active))], [0, 1, 2, 3, 4]);
  assert.equal(st.find((x) => x.active === 2).fromUs, 500_000);
  assert.equal(st[st.length - 1].toUs, pg.endUs - pg.startUs);
  // A template without highlight has one settled state.
  assert.equal(captionStates({ ...text, caption: { ...text.caption, template: "minimal-lower" } }, 1_000_000, 30).length, 1);
});

test("word times snap to the sound: no caption before the word is said; clicks are ignored", () => {
  // 10 ms frames: silence (level 10), a one-frame click at 0.30 s, speech 0.50–1.00 s and 1.80–2.30 s.
  const env = Array.from({ length: 300 }, (_, i) => ((i >= 50 && i < 100) || (i >= 180 && i < 230) ? 1000 : i === 30 ? 900 : 10));
  const words = [W("early", 0.1, 0.9), W("inside", 1.0, 1.2), W("next", 1.8, 2.3)];
  const { words: out, moved } = refineWordTimes(words, { env, frameUs: 10_000 });
  assert.equal(out[0].startUs, 470_000, "starts where speech starts (−30 ms), not at the click");
  assert.equal(out[0].endUs, 900_000, "end kept inside speech");
  assert.equal(out[2].startUs, 1_800_000, "a word that starts on its sound is untouched");
  assert.deepEqual([out[1].startUs, out[1].endUs], [1_000_000, 1_200_000], "no sound before the next word: left as reported");
  assert.equal(moved, 1);
  // A word placed entirely in the silence before its sound moves to the sound and keeps its length.
  const env2 = Array.from({ length: 200 }, (_, i) => (i >= 120 && i < 170 ? 1000 : 10));
  const r2 = refineWordTimes([W("a", 0.1, 0.4), W("b", 1.9, 2.0)], { env: env2, frameUs: 10_000 }).words;
  assert.equal(r2[0].startUs, 1_170_000);
  assert.ok(r2[0].endUs > r2[0].startUs && r2[0].endUs <= 1_900_000);
  // No speech/silence contrast (all noise): nothing changes.
  assert.equal(refineWordTimes(words, { env: Array(300).fill(500), frameUs: 10_000 }).moved, 0);
});

test("reveal: words of a page appear only once spoken, even without a highlight", () => {
  const ws = words([["no", 0, 300], ["spoilers", 300, 900], ["here", 900, 1300]]);
  const text = { content: "no spoilers here", caption: { template: "minimal-lower", words: ws, reveal: true } };
  const st = captionStates(text, 1_300_000, 30);
  assert.deepEqual(st.map((x) => [x.fromUs, x.active]), [[0, 0], [300_000, 1], [900_000, 2]]);
  assert.equal(captionStates({ ...text, caption: { ...text.caption, reveal: false } }, 1_300_000, 30).length, 1);
});

test("caption pages respect cuts: no page spans a cut or stays on screen after it; no orphan last word", () => {
  // "...يبقى شاكله حلو." then a cut at 2.0 s, then "والدنيا حواليا مكركبة."
  const ws = words([["يبقى", 0, 300], ["شاكله", 300, 700], ["حلو.", 700, 1000], ["والدنيا", 2000, 2400], ["حواليا", 2400, 2800], ["مكركبة.", 2800, 3300]]);
  const pages = paginate(ws, "single-pop", { breaksUs: [1_900_000] }); // single-pop: 3 words max per page
  assert.deepEqual(pages.map((p) => p.words.map((w) => w.t).join(" ")), ["يبقى شاكله حلو.".toUpperCase(), "والدنيا حواليا مكركبة.".toUpperCase()]);
  assert.ok(pages[0].endUs <= 1_900_000, "the page ends at the cut");
  const joined = words([["one", 0, 200], ["two", 200, 400], ["three", 400, 600], ["four", 600, 800], ["five", 800, 1000], ["end.", 1000, 1200]]);
  const kp = paginate(joined, "karaoke-yellow"); // 5 words max: "end." would be alone on the next page
  assert.equal(kp.length, 1, "a sentence-final word joins the page instead of standing alone");
});

test("editing a caption keeps or redistributes word timings; emphasis and reading-speed checks", () => {
  const cap = { template: "keywords", words: words([["three", 0, 300], ["editing", 300, 700], ["tricks", 700, 1000]]) };
  assert.deepEqual(captionWords({ content: "3 editing tricks", caption: cap }, 1_000_000).map((w) => [w.t, w.s, w.e]), [["3", 0, 300_000], ["editing", 300_000, 700_000], ["tricks", 700_000, 1_000_000]]);
  const re = captionWords({ content: "three great editing tricks", caption: cap }, 1_000_000);
  assert.equal(re.length, 4);
  assert.equal(re[0].s, 0); assert.equal(re[3].e, 1_000_000);
  for (let i = 1; i < re.length; i++) assert.ok(re[i].s >= re[i - 1].e - 1);
  assert.deepEqual(emphasisFor(words([["save", 0, 1], ["50%", 1, 2], ["Today", 2, 3]]), ["today"]), [1, 2]);
  const qc = captionQc([{ startUs: 0, endUs: 500_000, words: words([["incomprehensibilities", 0, 500], ["everywhere", 0, 500]]) }]);
  assert.equal(qc.issues[0].kind, "fast");
  assert.ok(Object.keys(CAPTION_TEMPLATES).length >= 8);
});

test("edit-plan mapping: source spans through cuts, cut points, predicted duration and the cut sheet", () => {
  const tl = { fps: 30, canvas: { width: 1920, height: 1080 }, tracks: [{ isMain: true, order: 0, segments: [
    { id: "a", kind: "video", mediaId: "m", start: 0, duration: 10 * US, sourceStart: 0, speed: 1 },
  ] }] };
  const pieces = mainPieces(tl);
  const cuts = normalizeCuts([{ mediaId: "m", fromUs: 2 * US, toUs: 3 * US }, { mediaId: "m", fromUs: 2.5 * US, toUs: 4 * US }, { mediaId: "m", fromUs: 8 * US, toUs: 8.05 * US }]);
  assert.deepEqual(cuts.get("m").map((c) => [c.fromUs, c.toUs]), [[2 * US, 4 * US], [8 * US, 8.05 * US]]);
  const after = predictCuts(pieces, cuts);
  assert.equal(after[after.length - 1].end, 8 * US, "the 50 ms cut is below the minimum and ignored");
  assert.deepEqual(mapSpan(after, "m", 1 * US, 5 * US).map((s) => [s.t0, s.t1]), [[1 * US, 2 * US], [2 * US, 3 * US]]);
  assert.equal(mapPoint(after, "m", 3 * US), 2 * US, "a moment inside a cut maps to the cut point");
  const r = checkPlan({ schema: "montaj.editplan/1", cuts: [{ mediaId: "m", fromUs: 2 * US, toUs: 4 * US, reason: "pause" }], zooms: [{ mediaId: "m", fromUs: 2.2 * US, toUs: 3.8 * US, scale: 1.2 }], texts: [{ mediaId: "x", fromUs: 0, toUs: US, content: "hi" }] }, tl);
  assert.ok(r.errors.some((e) => /not on the main track/.test(e.message)));
  assert.ok(r.warnings.some((w) => w.path === "zooms/0"), "a zoom inside a cut is reported");
  assert.equal(r.summary.afterUs, 8 * US);
  assert.ok(r.cutSheet.some((l) => /^cut 0:02\.0–0:04\.0 \(2\.0s\) — pause$/.test(l)));
});

// ------------------------------------------------------------------ through the services and the agent layer
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-auto-"));
const mediaDir = path.join(root, "m");
let S, hub, client, tid, mid;
const call = (n, a) => hub.call(hub.clients.all().find((c) => c.id === client.id), n, a);
const tlDur = () => mainPieces(S.timelines.get(tid).timeline).reduce((m, p) => Math.max(m, p.end), 0);

before(async () => {
  S = await createServices({ root, notify: () => {} });
  fs.mkdirSync(mediaDir, { recursive: true });
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=10", "-f", "lavfi", "-i", "sine=frequency=300:duration=10", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(mediaDir, "talk.mp4")], { timeoutMs: 120_000 });
  // Deterministic transcript instead of a speech model.
  S.captions.transcribeWords = async ({ mediaId }) => ({ mediaId, language: "en", engine: "test", durationUs: 10 * US, words: TALK, segments: [] });
  S.captions.status = async () => ({ autoCaptions: true, words: true, engine: "test" });
  hub = new AgentHub({ services: S, dir: S.paths.agents });
  client = hub.clients.create({ name: "auto", scopes: ["read", "media", "edit"], projects: "*", importRoots: [mediaDir] }).client;
  const p = await call("project_create", { name: "auto", ratio: "9:16" });
  tid = p.mainTimelineId;
  mid = (await call("media_import", { projectId: p.projectId, paths: [path.join(mediaDir, "talk.mp4")] })).imported[0].mediaId;
  await call("timeline_add_clip", { timelineId: tid, mediaId: mid });
});
after(() => { hub.close(); closeDatabase({ shutdown: true }); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("an edit plan is validated, then applied as one undo step; captions persist in the database", async () => {
  const sp = await call("media_analyze_speech", { mediaId: mid, style: "natural" });
  assert.equal(sp.status, "done");
  const plan = { schema: "montaj.editplan/1", title: "reel", canvas: { ratio: "9:16", bgType: "blur" },
    cuts: sp.result.suggestedCuts.map((c) => ({ mediaId: mid, fromUs: c.fromUs, toUs: c.toUs, reason: c.reason })),
    zooms: [{ mediaId: mid, fromUs: 7_300_000, toUs: 8_700_000, scale: 1.2, reason: "key sentence" }],
    texts: [{ mediaId: mid, fromUs: 0, toUs: 1_400_000, content: "3 tricks", position: "top" }],
    transitions: [{ mediaId: mid, atUs: 5_300_000, type: "push_left", durationUs: 250_000 }],
    audio: { denoise: true, normalizeLufs: -14 }, captions: { template: "box-highlight", keywords: ["silence"] } };
  const v = await call("edit_plan_validate", { timelineId: tid, plan });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.cutSheet.some((l) => l.startsWith("zoom ×1.2")));
  const before = S.timelines.get(tid);
  const r = await call("edit_plan_apply", { timelineId: tid, plan, expectedRevision: before.revision });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  const res = r.result;
  assert.equal(res.undoLabel, "plan:reel");
  assert.equal(S.timelines.get(tid).history.depth, before.history.depth + 1, "the whole plan is one undo step");
  assert.ok(res.after.durationUs < 10 * US - 3 * US, `cuts applied (${res.after.durationUs})`);
  assert.equal(res.after.durationUs, v.summary.afterUs, "the validation predicted the result");
  assert.ok(res.applied.some((a) => a.startsWith("captions")));
  const tl = S.timelines.get(tid).timeline;
  const main = tl.tracks.find((t) => t.isMain).segments;
  assert.ok(main.some((s) => Math.abs((s.transform?.scale || 1) - 1.2) < 1e-6), "punch-in zoom on a main clip");
  assert.ok(main.some((s) => s.transitionOut?.type === "push_left"), "transition at the retake cut");
  const caps = tl.tracks.flatMap((t) => t.segments).filter((s) => s.text?.caption);
  assert.ok(caps.length >= 3);
  assert.ok(!caps.some((s) => s.text.content.includes("cut.")), "words of the removed retake have no captions");
  assert.ok(caps.some((s) => s.text.caption.emphasis.length), "keyword emphasis");
  // Saved and reloaded from Realm: the caption data is intact.
  const fromDb = S.repos.timelines.get(tid).tracks.flatMap((t) => t.segments).find((s) => s.id === caps[0].id);
  assert.deepEqual(fromDb.text.caption, caps[0].text.caption);
  // One undo restores the original 10 s timeline.
  await call("timeline_undo", { timelineId: tid });
  assert.equal(tlDur(), 10 * US);
  assert.equal(S.timelines.get(tid).timeline.tracks.flatMap((t) => t.segments).filter((s) => s.text?.caption).length, 0);
});

test("a failing plan step restores the timeline; stale revisions and invalid plans are refused", async () => {
  const snap = JSON.stringify(S.timelines.get(tid).timeline);
  const depth = S.timelines.get(tid).history.depth;
  const real = S.captions.transcribeWords;
  S.captions.transcribeWords = async () => { throw Object.assign(new Error("model crashed"), { code: "PROVIDER", messageKey: "err.whisperFailed" }); };
  const r = await call("edit_plan_apply", { timelineId: tid, plan: { schema: "montaj.editplan/1", cuts: [{ mediaId: mid, fromUs: 4_000_000, toUs: 5_000_000 }], captions: { template: "karaoke-yellow" } } });
  S.captions.transcribeWords = real;
  assert.equal(r.status, "failed");
  assert.equal(r.error.details.rolledBack, true);
  assert.equal(JSON.stringify(S.timelines.get(tid).timeline), snap, "cuts made before the failure are undone");
  assert.equal(S.timelines.get(tid).history.depth, depth);
  const stale = await call("edit_plan_apply", { timelineId: tid, expectedRevision: S.timelines.get(tid).revision - 1, plan: { schema: "montaj.editplan/1", filter: { preset: "vivid" } } });
  assert.equal(stale.error.messageKey, "err.revisionConflict");
  const bad = await call("edit_plan_validate", { timelineId: tid, plan: { schema: "montaj.editplan/1", zooms: [{ mediaId: mid, fromUs: 0, toUs: US, scale: 9 }], captions: { template: "nope" } } });
  assert.equal(bad.valid, false);
  const noMedia = hub.clients.create({ name: "editor-only", scopes: ["read", "edit"], projects: "*" }).client;
  const denied = await hub.call(hub.clients.all().find((c) => c.id === noMedia.id), "edit_plan_apply", { timelineId: tid, plan: { schema: "montaj.editplan/1", captions: { template: "karaoke-yellow" } } });
  assert.equal(denied.error.messageKey, "err.scopeMissing", "captions need the media permission");
});

test("animated captions op and restyle; frames for the agent to look at", async () => {
  const r = await call("timeline_add_captions_pro", { timelineId: tid, template: "single-pop" });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.equal(r.result.undoLabel, "captions:single-pop");
  assert.ok(r.result.qc.pages >= 3);
  const again = await call("timeline_add_captions_pro", { timelineId: tid, template: "keywords" });
  const all = S.timelines.get(tid).timeline.tracks.flatMap((t) => t.segments).filter((s) => s.text?.caption);
  assert.equal(all.length, again.result.pages, "replace: earlier captions removed");
  const st = await call("timeline_captions_style", { timelineId: tid, template: "neon", overrides: { accent: "#FF0000" } });
  assert.equal(st.changed, all.length);
  assert.ok(S.timelines.get(tid).timeline.tracks.flatMap((t) => t.segments).filter((s) => s.text?.caption).every((s) => s.text.caption.template === "neon" && s.text.caption.overrides.accent === "#FF0000"));
  const fr = await call("timeline_frames", { timelineId: tid, timesUs: [500_000, 4_000_000], short: 180 });
  assert.equal(fr.images.length, 2);
  assert.equal(fr.textOmitted, true, "without the raster window (tests) the frames say text was left out");
  assert.ok(Buffer.from(fr.images[0].data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "JPEG");
  const mf = await call("media_frames", { mediaId: mid, count: 3, short: 160 });
  assert.deepEqual(mf.frames.map((f) => f.atUs), [Math.round(10 * US / 6), Math.round(10 * US / 2), Math.round(50 * US / 6)]);
});

test("motion graphics: templates and frame states; the op checks params; behind the person via op and plan; caption corrections", async () => {
  const { GRAPHIC_TEMPLATES, graphicStates, graphicParams } = await import("../../src/core/graphics.js");
  const { checkInputs } = await import("../../src/agent/skills/runtime.js");
  const { correctWords } = await import("../../src/core/speech.js");
  for (const [id, tpl] of Object.entries(GRAPHIC_TEMPLATES)) {
    const defs = Object.fromEntries(Object.entries(tpl.params).map(([k, s]) => [k, s.default]));
    assert.doesNotThrow(() => checkInputs({ type: "object", properties: tpl.params, additionalProperties: false }, defs, id), `${id}: defaults match the schema`);
    assert.ok(tpl.ar && tpl.use && tpl.durUs > tpl.inUs + tpl.outUs, `${id}: names and timing`);
  }
  // Intro and outro frame by frame, one held state between; a looping template changes every frame.
  const st = graphicStates({ template: "title-reveal" }, 3 * US, 30);
  const tpl = GRAPHIC_TEMPLATES["title-reveal"];
  assert.equal(st.length, Math.ceil(tpl.inUs / (US / 30)) + 1 + Math.ceil(tpl.outUs / (US / 30)));
  assert.equal(st[0].fromUs, 0);
  assert.equal(st[st.length - 1].toUs, 3 * US);
  assert.ok(st.some((s) => s.toUs - s.fromUs > US), "the hold is one state");
  assert.equal(graphicStates({ template: "follow-cta" }, 2 * US, 30).length, 60, "loop: every frame");
  assert.equal(graphicParams({ template: "behind-title", params: { text: "واو" } }).width, 0.9, "missing params take their defaults");

  const invalid = (e) => e.messageKey === "err.inputsInvalid";
  await assert.rejects(call("timeline_add_graphic", { timelineId: tid, template: "lower-third", params: { title: "x", colour: "#fff" } }), invalid, "unknown parameter refused");
  await assert.rejects(call("timeline_add_graphic", { timelineId: tid, template: "lower-third", params: { accent: "red" } }), invalid, "colour checked");

  // Behind the person: the matte maker is stubbed (no model in unit tests); the op moves the layer and makes the matte.
  const made = [];
  const realEnsure = S.mattes.ensure, realReady = S.mattes.ready;
  S.mattes.ensure = async (id) => { made.push(id); return "matte.mp4"; };
  S.mattes.ready = (id) => made.includes(id);
  try {
    const g = await call("timeline_add_graphic", { timelineId: tid, template: "behind-title", params: { text: "WOW" }, atUs: US, durationUs: 2 * US });
    assert.ok(g.clipId && !g.behindPerson);
    const b = await call("timeline_behind_person", { timelineId: tid, clipIds: [g.clipId] });
    assert.equal(b.status, "done", JSON.stringify(b.error));
    assert.deepEqual(b.result.mattes, [{ mediaId: mid, ready: true }]);
    assert.deepEqual(made, [mid], "the matte of the main video is made once");
    const view = await call("timeline_inspect", { timelineId: tid });
    const host = view.tracks.find((t) => t.clips.some((c) => c.clipId === g.clipId));
    assert.equal(host.behindPerson, true);
    assert.equal(host.clips.find((c) => c.clipId === g.clipId).text.graphic, "behind-title");
    const front = await call("timeline_behind_person", { timelineId: tid, clipIds: [g.clipId], behind: false });
    assert.deepEqual(front.moved, [g.clipId]);
    assert.equal((await call("timeline_inspect", { timelineId: tid })).tracks.filter((t) => t.behindPerson).length, 0);
    await call("timeline_remove_clips", { timelineId: tid, clipIds: [g.clipId] });

    // The same through an edit plan, with caption corrections.
    const plan = { schema: "montaj.editplan/1", title: "gfx",
      graphics: [{ mediaId: mid, fromUs: 0, toUs: 1_500_000, template: "behind-title", params: { text: "TRICKS" }, behindPerson: true },
        { mediaId: mid, fromUs: 5_400_000, toUs: 7_000_000, template: "list-item", params: { number: "1", text: "cut", emoji: "scissors" } }],
      captions: { template: "box-highlight", corrections: [{ from: "um", to: "" }, { from: "three tricks", to: "3 tricks" }] } };
    assert.equal((await call("edit_plan_validate", { timelineId: tid, plan })).valid, true);
    const r = await call("edit_plan_apply", { timelineId: tid, plan });
    assert.equal(r.status, "done", JSON.stringify(r.error));
    assert.ok(r.result.applied.includes("graphics (2)") && r.result.applied.includes("behind the person (1)"), r.result.applied.join(", "));
    const tl = S.timelines.get(tid).timeline;
    const words = tl.tracks.flatMap((t) => t.segments).filter((s) => s.text?.caption).flatMap((s) => s.text.caption.words.map((w) => w.t));
    assert.ok(words.includes("3") && words.includes("tricks.") && !words.includes("three") && !words.some((w) => /^um/.test(w)), words.join(" "));
    assert.equal(tl.tracks.filter((t) => t.role === "behind").length, 1);
    const wrong = await call("edit_plan_validate", { timelineId: tid, plan: { schema: "montaj.editplan/1", captions: { template: "box-highlight", corrections: [{ from: "", to: "x" }] } } });
    assert.equal(wrong.valid, false, "empty correction refused");
    await call("timeline_undo", { timelineId: tid });
  } finally { S.mattes.ensure = realEnsure; S.mattes.ready = realReady; }
  // Corrections keep the span and the sentence end.
  assert.deepEqual(correctWords([{ t: "يتزبط.", s: 0, e: 600 }], [{ from: "يتزبط", to: "يتظبط" }]), [{ t: "يتظبط.", s: 0, e: 600 }]);
  assert.deepEqual(correctWords([{ t: "a", s: 0, e: 100 }, { t: "b", s: 100, e: 300 }], [{ from: "a b", to: "x y z" }]).map((w) => [w.t, w.s, w.e]), [["x", 0, 100], ["y", 100, 200], ["z", 200, 300]]);
});

test("sound effects: a bundled sound lands on its moment; graphics bring their own; one media item per sound", async () => {
  const list = await call("sfx_list", {});
  assert.ok(list.some((s) => s.id === "whoosh" && s.leadMs === 300));
  const r = await call("timeline_add_sfx", { timelineId: tid, sound: "whoosh", atUs: 2_000_000 });
  assert.equal(r.atUs, 1_700_000, "starts 0.3 s early: the whoosh peaks on the moment");
  const tl = () => S.timelines.get(tid).timeline;
  const clip = tl().tracks.flatMap((t) => t.segments).find((s) => s.id === r.clipId);
  assert.equal(clip.kind, "audio");
  assert.equal(clip.volumeDb, -11);
  const media = S.repos.media.get(clip.mediaId);
  assert.ok(media.durationUs > 500_000 && media.durationUs < 700_000, "the bundled file is a real 0.6 s sound");
  await call("timeline_add_sfx", { timelineId: tid, sound: "whoosh", atUs: 5_000_000 });
  const whooshes = tl().tracks.flatMap((t) => t.segments).filter((s) => s.name === "SFX: whoosh");
  assert.equal(new Set(whooshes.map((s) => s.mediaId)).size, 1, "the sound is imported once");
  const g = await call("timeline_add_graphic", { timelineId: tid, template: "lower-third", params: { title: "x" }, atUs: 3_000_000, sfx: false });
  assert.ok(g.clipId);
  const before = tl().tracks.flatMap((t) => t.segments).filter((s) => s.name?.startsWith("SFX")).length;
  const { GRAPHIC_TEMPLATES } = await import("../../src/core/graphics.js");
  GRAPHIC_TEMPLATES["lower-third"].sfx = { in: "pop", out: "swish" }; // a template with sounds
  try { await call("timeline_add_graphic", { timelineId: tid, template: "lower-third", params: { title: "y" }, atUs: 6_000_000, sfx: true }); }
  finally { delete GRAPHIC_TEMPLATES["lower-third"].sfx; }
  assert.equal(tl().tracks.flatMap((t) => t.segments).filter((s) => s.name?.startsWith("SFX")).length, before + 2, "in + out sounds");
  await assert.rejects(call("timeline_add_sfx", { timelineId: tid, sound: "nope", atUs: 0 }), (e) => e.messageKey === "err.inputsInvalid");
});
