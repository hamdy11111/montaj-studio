// Phase 2 ("quick wins" of PLAN_editor_and_graphics.md): edit plans v2 (ordered segments from several files, a hook,
// J/L joints, music, b-roll, anchored graphics, retake groups) — validated, shown in the cut sheet and applied as ONE
// undo step; J/L cuts in the timeline and in a real FFmpeg export (the sound and the picture land where intended);
// retakes grouped by their words (Smith–Waterman) with the last complete take kept; the director on several clips;
// captions that fill with the speech, a sliding box, eased springs, one emphasis in 3–5 words and safe zones.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { AgentHub } from "../../src/agent/controlServer.js";
import { autoEdit } from "../../src/agent/director.js";
import { EDIT_PLAN_SCHEMA, EDIT_PLAN_SCHEMA_V2, checkPlan, layoutSegments, occurrence, mainPieces } from "../../src/core/editPlan.js";
import { setJL, pictureTracks, splitSegment, addMediaSegment, layoutMain } from "../../src/core/timelineOps.js";
import { newTimeline } from "../../src/core/model.js";
import { alignTokens, alignToken, retakeGroups, retakeDrops, retakeKind, speechUnits, chooseTake } from "../../src/core/speech.js";
import { directPlan, toPlanV2 } from "../../src/core/director.js";
import { captionStates, emphasisFor, captionPosY, spring, SPRING, SAFE_ZONES, safeZone, CAPTION_TEMPLATES, stateKey } from "../../src/core/captionTemplates.js";
import { US } from "../../src/core/util.js";

const W = (text, s, e) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US) });
/** Words of lines said one after another: [text, pause after (s)]; each word 0.3 s, 0.05 s apart. */
function talk(lines, t0 = 0.3) {
  const out = [];
  let t = t0;
  for (const [line, gap = 0.8] of lines) { for (const w of line.split(" ")) { out.push(W(w, t, t + 0.3)); t += 0.35; } t += gap; }
  return out;
}

// ------------------------------------------------------------------ edit plan v2 (pure)
const MEDIA = { a: { durationUs: 20 * US, type: "video", name: "a.mp4" }, b: { durationUs: 10 * US, type: "video", name: "b.mp4" }, s: { durationUs: 30 * US, type: "audio", name: "song.wav" } };
const TL = (() => { const tl = newTimeline("p"); addMediaSegment(tl, { id: "a", type: "video", name: "a", durationUs: 20 * US }); return tl; })();

test("plan v2: ordered segments from several files, a hook kept in its natural place too, J/L joints — validated and read in the cut sheet", () => {
  const plan = {
    schema: "montaj.editplan/2", title: "story",
    segments: [
      { mediaId: "a", fromUs: 12 * US, toUs: 14 * US, role: "hook", reason: "the result first" },
      { mediaId: "a", fromUs: 1 * US, toUs: 6 * US },
      { mediaId: "b", fromUs: 0, toUs: 4 * US, jl: -200, reason: "new place" },
      { mediaId: "a", fromUs: 10 * US, toUs: 16 * US, jl: 300 },
    ],
    graphics: [{ mediaId: "a", fromUs: 12.5 * US, toUs: 13.5 * US, template: "big-word", params: { text: "نجحنا" }, anchor: { word: "نجحنا", atUs: 12.5 * US }, reason: "the win" }],
    music: [{ mediaId: "s", editFromUs: 0, volumeDb: -20, reason: "bed" }],
    broll: [{ mediaId: "b", fromUs: US, toUs: 2 * US, brollMediaId: "b", brollFromUs: 5 * US, mode: "pip", reason: "show it" }],
    transitions: [{ segment: 3, type: "push_left" }],
    retakes: [{ line: "نجحنا", kept: 1, reason: "last complete take", takes: [{ mediaId: "a", fromUs: 7 * US, toUs: 8 * US, kind: "false-start", complete: false }, { mediaId: "a", fromUs: 10 * US, toUs: 12 * US, complete: true }] }],
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA_V2, plan), JSON.stringify(ajv.errors));
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, plan), "the combined schema takes both versions");
  const r = checkPlan(plan, TL, { media: MEDIA });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings)); // the hook repeats a span on purpose
  assert.equal(r.summary.afterUs, 17 * US);
  assert.equal(r.summary.media, 2);
  assert.ok(r.summary.reordered === false && r.summary.hooks === 1 && r.summary.jl === 2 && r.summary.retakes === 1);
  const sheet = r.cutSheet.join("\n");
  assert.match(sheet, /#1 0:00\.0–0:02\.0 ▸ a\.mp4 0:12\.0–0:14\.0 \(2\.0s\) \[hook\] — the result first/);
  assert.match(sheet, /J-cut 0\.20s: its sound starts before its picture/);
  assert.match(sheet, /L-cut 0\.30s: the previous sound runs on under its picture/);
  assert.match(sheet, /graphic big-word "نجحنا" at 0:13\.5 on «نجحنا» — the win/, "a graphic lands on its natural place (not the hook copy)");
  assert.match(sheet, /retake ×2 «نجحنا» — kept take 2 \(a\.mp4 0:10\.0–0:12\.0, last complete take\); dropped: take 1 a\.mp4 0:07\.0–0:08\.0 \(false start\)/);
  assert.match(sheet, /music song\.wav 0:00\.0–0:17\.0 -20 dB/);
  // The hook copy vs the natural place: occurrence() picks the body segment; pinned to the hook, the hook.
  const pieces = layoutSegments(plan);
  assert.deepEqual(occurrence(pieces, plan.graphics[0]).map((p) => p.seg), [1, 3]);
  assert.deepEqual(occurrence(pieces, { ...plan.graphics[0], segment: 0 }).map((p) => p.seg), [0]);
  // Story order is reported; mistakes are errors.
  assert.equal(checkPlan({ ...plan, segments: [plan.segments[3], { ...plan.segments[1], jl: undefined }] }, TL, { media: MEDIA }).summary.reordered, true);
  const bad = checkPlan({ ...plan, segments: [{ mediaId: "s", fromUs: 0, toUs: US }, { mediaId: "x", fromUs: 0, toUs: US }, { mediaId: "b", fromUs: 0, toUs: 12 * US }], transitions: [{ segment: 0, type: "push_left" }], graphics: [{ ...plan.graphics[0], mediaId: "zz" }] }, TL, { media: MEDIA });
  const paths = bad.errors.map((e) => e.path);
  for (const p of ["segments/0", "segments/1/mediaId", "segments/2", "transitions/0/segment", "graphics/0/mediaId"]) assert.ok(paths.includes(p), `${p}: ${JSON.stringify(bad.errors)}`);
  assert.ok(checkPlan({ ...plan, segments: [plan.segments[1], plan.segments[1]] }, TL, { media: MEDIA }).warnings.some((w) => /same footage/.test(w.message)), "a repeat that is not a hook is flagged");
});

// ------------------------------------------------------------------ J/L cuts (pure)
test("J/L cuts: set on a joint (clamped), the picture edit point moves, the sound's stays; a split keeps it on the outer edge", () => {
  const tl = newTimeline("p");
  const m = (id, d) => ({ id, type: "video", name: id, durationUs: d });
  const lay = layoutMain(tl, [{ media: m("a", 10 * US), fromUs: US, toUs: 4 * US }, { media: m("b", 10 * US), fromUs: 2 * US, toUs: 6 * US, jlUs: -400_000 }, { media: m("a", 10 * US), fromUs: 6 * US, toUs: 8 * US, jlUs: 300_000 }]);
  const main = tl.tracks.find((t) => t.isMain).segments;
  assert.deepEqual(main.map((s) => [s.start, s.duration, s.sourceStart, s.jlUs || 0]), [[0, 3 * US, US, 0], [3 * US, 4 * US, 2 * US, -400_000], [7 * US, 2 * US, 6 * US, 300_000]]);
  assert.equal(setJL(tl, lay[1], -900_000), -500_000, "at most 0.5 s");
  assert.equal(setJL(tl, lay[2], 1_800_000), 500_000);
  assert.throws(() => setJL(tl, lay[0], -100_000), /jlNoJoint/, "no joint before the first clip");
  setJL(tl, lay[1], -400_000); setJL(tl, lay[2], 300_000);
  const durOf = (s) => 10 * US;
  const pic = pictureTracks(tl.tracks, durOf).find((t) => t.isMain).segments;
  // J: the first clip's picture runs 0.4 s longer (its own footage after its out point), the second starts 0.4 s later.
  assert.deepEqual(pic.map((s) => [s.start, s.duration, s.sourceStart]), [[0, 3.4 * US, US], [3.4 * US, 3.3 * US, 2.4 * US], [6.7 * US, 2.3 * US, 5.7 * US]]);
  assert.deepEqual(main.map((s) => [s.start, s.duration]), [[0, 3 * US], [3 * US, 4 * US], [7 * US, 2 * US]], "the timeline itself (the sound) is unchanged");
  // Handles are limited by the files: an L into a clip that starts at 0.1 s of its file can only reach 0.1 s back.
  const tl2 = newTimeline("p");
  const ids = layoutMain(tl2, [{ media: m("a", 10 * US), fromUs: 0, toUs: 3 * US }, { media: m("b", 10 * US), fromUs: 100_000, toUs: 4 * US, jlUs: 400_000 }]);
  assert.equal(pictureTracks(tl2.tracks, durOf).find((t) => t.isMain).segments[1].start, 2.9 * US);
  const tl3 = newTimeline("p");
  layoutMain(tl3, [{ media: m("a", 3 * US), fromUs: 0, toUs: 3 * US }, { media: m("b", 10 * US), fromUs: 0, toUs: 4 * US, jlUs: -400_000 }]);
  assert.equal(pictureTracks(tl3.tracks, (s) => 3 * US).find((t) => t.isMain).segments[1].start, 3 * US, "a J out of a clip that ends with its file: nothing to hold, plain cut");
  // A split inside the second clip: the J stays on its start, the new joint is a plain continuous cut.
  const right = splitSegment(tl2, ids[1], 3.5 * US);
  assert.equal(right.jlUs, undefined);
  assert.equal(tl2.tracks.find((t) => t.isMain).segments.find((s) => s.id === ids[1]).jlUs, 400_000);
  assert.equal(pictureTracks(newTimeline("p").tracks).length, 1, "nothing to move: the same tracks");
});

// ------------------------------------------------------------------ retakes by meaning (pure)
test("retakes: tokens aligned (Smith–Waterman), a false start and a partial take grouped with the full ones, the last complete take kept", () => {
  assert.deepEqual(alignTokens(["انا", "رحت", "السوق"].map(alignToken), ["امبارح", "انا", "رحت", "سوق"].map(alignToken)).b, [1, 3]);
  assert.equal(alignToken("والكيكة"), "كيكه");
  const words = talk([
    ["انا النهارده هوريكم ازاي تعملوا الكيكة."],
    ["انا النهارده", 0.7],
    ["انا النهارده هوريكم ازاي تعملوا كيكة الشوكولاتة."],
    ["تاني", 0.7],
    ["انا النهارده هوريكم ازاي تعملوا كيكة الشوكولاتة في البيت."],
    ["اول حاجة نجيب الدقيق."],
    ["تاني حاجة نجيب السكر."],
  ]);
  const groups = retakeGroups(words);
  assert.equal(groups.length, 1, "the list «اول حاجة / تاني حاجة» is not a retake");
  const g = groups[0];
  assert.deepEqual(g.takes.map((t) => t.kind), ["full", "false-start", "full", "full"]);
  assert.deepEqual(g.takes.map((t) => t.complete), [false, false, false, true]);
  assert.equal(g.kept, 3);
  assert.match(g.line, /في البيت/);
  assert.equal(g.reason, "last complete take");
  assert.equal(g.asides.length, 1, "«تاني» between two takes goes with them");
  const drop = retakeDrops(groups);
  assert.ok(!drop.has(g.takes[3].w0) && drop.has(g.takes[0].w0) && drop.has(g.asides[0].w0));
  assert.ok(words.slice(g.takes[3].w1 + 1).every((_, k) => !drop.has(g.takes[3].w1 + 1 + k)), "what follows the kept take stays");
  // Phase 5 will pass a performance score: the same groups, another choice.
  assert.equal(chooseTake(g, (t) => (t.kind === "false-start" ? 9 : 0)), 1);
  // A restart inside one breath splits the unit; a line repeated much later or with other speech between is not a retake.
  const units = speechUnits(talk([["انا كنت انا كنت رايح السوق امبارح.", 0.8]]).map((w, i) => (i === 2 ? { ...w, startUs: w.startUs + 200_000, endUs: w.endUs + 200_000 } : w)));
  assert.equal(units.length, 2);
  assert.equal(retakeKind(units[0], units[1]), "false-start");
  const far = talk([["الفكرة دي هتغير حياتك كلها."], ["وبعدين جربناها في البيت ونجحت معانا."], ["الفكرة دي هتغير حياتك كلها."]]);
  assert.equal(retakeGroups(far).length, 0, "other speech in between: a deliberate repetition");
  const refrain = talk(Array.from({ length: 14 }, () => ["وبعدين رحنا هناك وشفنا الدنيا."]));
  assert.ok(retakeGroups(refrain).every((x) => x.takes.length <= 8), "a line said over and over is not one huge retake");
});

// ------------------------------------------------------------------ the director (pure)
test("the director: retakes left out with the groups in the plan; several clips in timeline order, a J lead where the scene changes", () => {
  const words = talk([["النهارده هنعمل تجربة جديدة"], ["هنعمل تجربة", 0.6], ["هنعمل تجربة جديدة خالص في البيت."], ["والنتيجة كانت رهيبة جدا."]]);
  const one = directPlan({ mediaId: "m", words, durationUs: 12 * US, track: [] });
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA_V2, one.plan), JSON.stringify(ajv.errors));
  assert.equal(one.plan.retakes.length, 1);
  const kept = one.plan.retakes[0].takes[one.plan.retakes[0].kept];
  assert.match(kept.text, /خالص في البيت/);
  const inEdit = (t) => one.plan.segments.some((x) => t >= x.fromUs && t < x.toUs);
  for (const [i, tk] of one.plan.retakes[0].takes.entries()) assert.equal(inEdit((tk.fromUs + tk.toUs) / 2), i === one.plan.retakes[0].kept, `take ${i + 1}`);
  assert.ok(one.decisions.some((d) => d.k === "retakes" && d.left === 2));
  assert.ok(one.qa.passed.includes("speech.lostWord"), "dropped takes are removals with a reason");
  // Two clips (b's words come first in the timeline): one story, mapped back to each file, a J at the joint.
  const wa = talk([["دي اول لقطة في المطبخ."], ["هنبدأ بالدقيق والسكر."]], 0.3), wb = talk([["ودي تاني لقطة في الجنينة."], ["والجو هنا حلو اوي."]], 0.4);
  const clips = [{ mediaId: "b", srcStart: 0, srcEnd: 7 * US, vStart: 0 }, { mediaId: "a", srcStart: 0, srcEnd: 7 * US, vStart: 7 * US }];
  const vWords = [...wb, ...wa.map((w) => ({ ...w, startUs: w.startUs + 7 * US, endUs: w.endUs + 7 * US }))];
  const two = directPlan({ mediaId: "b", clips, words: vWords, durationUs: 14 * US, track: [] });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA_V2, two.plan), JSON.stringify(ajv.errors));
  const order = two.plan.segments.map((x) => x.mediaId);
  assert.deepEqual([...new Set(order)], ["b", "a"], "the timeline order is kept");
  const k = order.indexOf("a");
  assert.equal(two.plan.segments[k].jl, -200, "a J lead into the new scene");
  assert.ok(two.plan.segments.every((x) => x.toUs <= 7 * US), "times are back in each file");
  assert.ok(wa.every((w) => two.plan.segments.some((x) => x.mediaId === "a" && w.startUs >= x.fromUs - 60_000 && w.endUs <= x.toUs + 60_000)), "every word of the second clip is kept");
  assert.ok(two.decisions.some((d) => d.k === "clips" && d.n === 2) && two.decisions.some((d) => d.k === "jl"));
  // A clip without speech is protected (never cut away), and the virtual plan maps zooms per segment.
  const v = toPlanV2({ schema: "montaj.editplan/1", cuts: [{ fromUs: 2 * US, toUs: 3 * US, reason: "pause" }], zooms: [{ mediaId: "virtual", fromUs: US, toUs: 5 * US, scale: 1.2, reason: "angle M" }] }, { clips: [{ mediaId: "x", srcStart: 2 * US, srcEnd: 6 * US, vStart: 0 }, { mediaId: "y", srcStart: 0, srcEnd: 4 * US, vStart: 4 * US }], durationUs: 8 * US });
  assert.deepEqual(v.segments.map((x) => [x.mediaId, x.fromUs, x.toUs]), [["x", 2 * US, 4 * US], ["x", 5 * US, 6 * US], ["y", 0, 4 * US]]);
  assert.deepEqual(v.zooms.map((z) => [z.mediaId, z.fromUs, z.toUs]), [["x", 3 * US, 4 * US], ["x", 5 * US, 6 * US], ["y", 0, US]]);
});

// ------------------------------------------------------------------ captions (pure)
const page = (template, ws, extra = {}) => ({ content: ws.map((w) => w[0]).join(" "), caption: { template, words: ws.map(([t, s, e]) => ({ t, s: s * 1000, e: e * 1000 })), ...extra } });

test("captions: the spoken word fills with its sound (karaoke wipe), the box slides, springs are eased per frame", () => {
  const ws = [["احنا", 0, 400], ["هنجرب", 400, 1000], ["النهارده", 1000, 1600]];
  const st = captionStates(page("karaoke-yellow", ws), 1_600_000, 30);
  // The wipe of «هنجرب» grows frame by frame from 0 to 1 while it is said, never backwards.
  const second = st.filter((s) => s.active === 1);
  const wipes = second.map((s) => s.wipe);
  assert.ok(wipes[0] <= 0.1 && wipes[wipes.length - 1] >= 0.9, JSON.stringify(wipes));
  for (let i = 1; i < wipes.length; i++) assert.ok(wipes[i] >= wipes[i - 1]);
  assert.ok(new Set(wipes).size >= 8, "a smooth fill, not a jump");
  assert.equal(second[0].fromUs, 400_000, "the fill starts on the word's first frame");
  // The page springs in, eased per frame: 0.86 → 1.04 → 1.0 over 160 ms (not two hard frames).
  const pops = st.filter((s) => s.fromUs < 200_000).map((s) => s.pop);
  assert.equal(pops[0], SPRING.page.from);
  assert.ok(Math.max(...pops) > 1 && Math.max(...pops) <= SPRING.page.peak && st.find((s) => s.fromUs >= 170_000).pop === 1, JSON.stringify(pops));
  // Word pop: 1.0 → 1.15 → 1.0 in 120 ms, sampled per frame (60 fps: 7 distinct steps).
  const curve = [0, 16.7, 33.3, 50, 66.7, 83.3, 100, 116.7, 133].map((ms) => spring(ms));
  assert.equal(curve[0], 1); assert.equal(spring(SPRING.word.ms * SPRING.rise), 1.15); assert.equal(curve[curve.length - 1], 1);
  const top = curve.indexOf(Math.max(...curve));
  for (let i = 1; i < curve.length; i++) assert.ok(i <= top ? curve[i] >= curve[i - 1] : curve[i] <= curve[i - 1], "up to the peak, then eased back down");
  assert.ok(new Set(curve).size >= 7, "a value per frame, not two or three hard frames");
  const boxed = captionStates(page("box-highlight", ws), 1_600_000, 60);
  const ramp = boxed.filter((s) => s.active === 1);
  assert.ok(ramp[0].wordPop >= 1 && ramp.some((s) => s.wordPop > 1.12), "the spoken word pops on its own");
  // The box slides from the last word: boxFrom = 0 with boxK rising to 1 over ~110 ms, then settled.
  const slide = ramp.filter((s) => s.boxFrom === 0).map((s) => s.boxK);
  assert.ok(slide.length >= 5 && slide[0] < 0.2 && slide.every((k, i) => !i || k > slide[i - 1]), JSON.stringify(slide));
  assert.equal(ramp[ramp.length - 1].boxFrom, -1);
  assert.equal(captionStates(page("box-highlight", ws), 1_600_000, 30).filter((s) => s.active === 0).every((s) => s.boxFrom === -1), true, "the first word: no slide");
  assert.notEqual(stateKey({ ...ramp[0], wipe: 0.5 }), stateKey(ramp[0]));
  // A template without highlight and pop still has one settled state.
  assert.equal(captionStates(page("minimal-lower", ws), 1_600_000, 30).length, 1);
});

test("captions: one emphasis word in every 3–5, keywords and numbers first, never two side by side; vertical captions inside the safe zone", () => {
  const ws = (s) => s.split(" ").map((t, i) => ({ t, s: i, e: i + 1 }));
  assert.deepEqual(emphasisFor(ws("احنا هنجرب الطريقة الجديدة")), [2], "4 words: one, the longest content word");
  assert.equal(emphasisFor(ws("في البيت عملنا اكبر كيكة شوكولاتة في التاريخ كله")).length, 2, "9 words: two");
  assert.deepEqual(emphasisFor(ws("وفرنا 50% النهارده"), ["النهارده"]), [2], "a keyword before a number");
  assert.deepEqual(emphasisFor(ws("يا سلام")), [], "a short page: only a keyword or a number");
  assert.deepEqual(emphasisFor(ws("كسبنا 100")), [1]);
  const e = emphasisFor(ws("المكونات الاساسية الدقيق السكر الزبدة البيض"));
  for (let i = 1; i < e.length; i++) assert.ok(e[i] - e[i - 1] >= 2);
  // Safe zones: the union of TikTok / Reels / Shorts; captions sit above the bottom bar.
  assert.ok(SAFE_ZONES.all.bottom >= SAFE_ZONES.tiktok.bottom && SAFE_ZONES.all.right >= SAFE_ZONES.shorts.right);
  assert.equal(safeZone(1920, 1080), null, "landscape: none");
  const V = { width: 1080, height: 1920 };
  for (const id of Object.keys(CAPTION_TEMPLATES)) {
    const tpl = CAPTION_TEMPLATES[id], y = captionPosY(id, V);
    const half = ((tpl.mode === "word" ? 1 : tpl.lines) * tpl.size * 1.3 * 1.15) / 400;
    assert.ok(0.5 + y + half <= 1 - SAFE_ZONES.all.bottom + 1e-3, `${id}: bottom inside the safe zone`);
    assert.ok(y <= tpl.posY.portrait, `${id}: only ever moved up`);
  }
  assert.equal(captionPosY("subtitle-bar", V, { platform: "none" }), CAPTION_TEMPLATES["subtitle-bar"].posY.portrait);
  assert.equal(captionPosY("subtitle-bar", { width: 1920, height: 1080 }), CAPTION_TEMPLATES["subtitle-bar"].posY.landscape);
});

// ------------------------------------------------------------------ through the services, with real FFmpeg
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-qw-"));
const mediaDir = path.join(root, "m");
const events = [];
let S, hub, client, pid, tid, red, blue, green, tone;
const call = (n, a) => hub.call(hub.clients.all().find((c) => c.id === client.id), n, a);
const SAY = {
  red: talk([["دي اول لقطة في المطبخ."], ["هنبدأ بالدقيق والسكر."]], 0.3),
  blue: talk([["ودي تاني لقطة في الجنينة."], ["والجو هنا حلو اوي."]], 0.4),
};

async function clip(name, color, hz, seconds = 6) {
  const out = path.join(mediaDir, name);
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=320x180:rate=30:duration=${seconds}`];
  if (hz) args.push("-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`, "-shortest", "-c:a", "aac", "-b:a", "192k");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", out);
  await run(binaries().ffmpeg, args, { timeoutMs: 120_000 });
  return out;
}

before(async () => {
  fs.mkdirSync(mediaDir, { recursive: true });
  S = await createServices({ root, notify: (e, p) => events.push({ e, ...p }) });
  const files = [await clip("red.mp4", "red", 300), await clip("blue.mp4", "blue", 1000), await clip("green.mp4", "green", 0, 4)];
  const wav = path.join(mediaDir, "tone.wav");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=600:duration=12", wav], { timeoutMs: 60_000 });
  files.push(wav);
  hub = new AgentHub({ services: S, dir: S.paths.agents });
  client = hub.clients.create({ name: "qw", scopes: ["read", "media", "edit"], projects: "*", importRoots: [mediaDir] }).client;
  const p = await call("project_create", { name: "qw", ratio: "16:9" });
  pid = p.projectId; tid = p.mainTimelineId;
  [red, blue, green, tone] = (await call("media_import", { projectId: pid, paths: files })).imported.map((m) => m.mediaId);
  await call("timeline_add_clip", { timelineId: tid, mediaId: red });
  S.captions.transcribeWords = async ({ mediaId }) => ({ mediaId, language: "ar", engine: "test", words: mediaId === red ? SAY.red : mediaId === blue ? SAY.blue : [], segments: [] });
  S.captions.status = async () => ({ autoCaptions: true, words: true, engine: "test" });
});
after(() => { hub.close(); closeDatabase({ shutdown: true }); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("a v2 plan is applied as ONE undo step: a hook, story order, two files, J/L, b-roll, music; undo restores the clip", async () => {
  const before0 = S.timelines.get(tid), endBefore = mainPieces(before0.timeline)[0].end, depth0 = before0.history.depth;
  const plan = {
    schema: "montaj.editplan/2", title: "story",
    segments: [{ mediaId: blue, fromUs: 4 * US, toUs: 5 * US, role: "hook" }, { mediaId: red, fromUs: 0, toUs: 3 * US }, { mediaId: blue, fromUs: US, toUs: 5 * US, jl: -300 }],
    zooms: [{ mediaId: blue, fromUs: 4.2 * US, toUs: 4.8 * US, scale: 1.2, reason: "punch" }],
    texts: [{ mediaId: blue, fromUs: 4 * US, toUs: 4.9 * US, content: "النتيجة", position: "top" }],
    broll: [{ mediaId: red, fromUs: US, toUs: 2 * US, brollMediaId: green, brollFromUs: US, mode: "pip", reason: "shown" }],
    music: [{ mediaId: tone, editFromUs: 0, volumeDb: -22, fadeUs: 500_000 }],
    transitions: [{ segment: 1, type: "push_left", durationUs: 250_000 }],
    captions: { template: "karaoke-yellow" },
  };
  const v = await call("edit_plan_validate", { timelineId: tid, plan });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.cutSheet.some((l) => /\[hook\]/.test(l)) && v.cutSheet.some((l) => /J-cut 0\.30s/.test(l)));
  const r = await call("edit_plan_apply", { timelineId: tid, plan, expectedRevision: before0.revision });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.equal(r.result.undoLabel, "plan:story");
  assert.equal(S.timelines.get(tid).history.depth, depth0 + 1, "one undo step");
  const tl = S.timelines.get(tid).timeline;
  const main = mainPieces(tl);
  assert.deepEqual([...new Set(main.map((p) => p.mediaId))], [blue, red], "two files, in the plan's order");
  assert.equal(main[main.length - 1].end, 8 * US);
  const segs = tl.tracks.find((t) => t.isMain).segments;
  assert.equal(segs.find((s) => s.start === 4 * US).jlUs, -300_000, "the J is on the joint");
  assert.ok(segs.some((s) => s.start < US && Math.abs(s.transform.scale - 1.2) < 1e-6), "a zoom on the hook copy too (picture)");
  assert.ok(segs.some((s) => s.start >= 7 * US && Math.abs(s.transform.scale - 1.2) < 1e-6), "and on its natural place");
  const text = tl.tracks.flatMap((t) => t.segments).find((s) => s.kind === "text" && s.text.content === "النتيجة");
  assert.equal(text.start, 7 * US, "the text lands on the natural place, not the hook");
  assert.equal(segs.find((s) => s.start + s.duration === US).transitionOut.type, "push_left", "the transition at the joint before segments[1]");
  const over = tl.tracks.filter((t) => !t.isMain).flatMap((t) => t.segments);
  const b = over.find((s) => s.mediaId === green);
  assert.ok(b && b.start === 2 * US && b.duration === US && b.sourceStart === US && b.audioDetached && b.transform.scale < 1, "b-roll over red 1–2 s, silent, picture in picture");
  const m = over.find((s) => s.mediaId === tone);
  assert.ok(m && m.kind === "audio" && m.start === 0 && m.duration === 8 * US && m.volumeDb === -22 && m.fadeOutUs === 500_000);
  const caps = over.filter((s) => s.text?.caption);
  assert.ok(caps.length >= 2 && caps.some((s) => /الجنينة/.test(s.text.content)), "captions from both files' words");
  assert.ok(r.result.applied.some((x) => /segments \(3 from 2 files/.test(x)) && r.result.applied.some((x) => /J\/L cuts \(1\)/.test(x)));
  // Saved in the database (schema v6) and undone in one step.
  assert.equal(S.repos.timelines.get(tid).tracks.find((t) => t.isMain).segments.find((s) => s.start === 4 * US).jlUs, -300_000);
  await call("timeline_undo", { timelineId: tid });
  assert.deepEqual(mainPieces(S.timelines.get(tid).timeline).map((p) => [p.mediaId, p.start, p.end]), [[red, 0, endBefore]]);
});

/** Colour of a frame at `t` s: { r, g, b } (the frame scaled to one pixel). */
async function colorAt(file, t) {
  const raw = path.join(root, `px-${t}.rgb`);
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", file, "-ss", String(t), "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", raw], { timeoutMs: 60_000 });
  const [r, g, b] = fs.readFileSync(raw);
  return { r, g, b, is: r > 150 && b < 100 ? "red" : b > 150 && r < 100 ? "blue" : "?" };
}
/** Dominant frequency of the sound in [a, b) s (zero crossings of the mono signal). */
async function hzAt(file, a, b) {
  const raw = path.join(root, `snd-${a}.pcm`);
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", file, "-ss", String(a), "-t", String(b - a), "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", raw], { timeoutMs: 60_000 });
  const buf = fs.readFileSync(raw), n = buf.length / 2;
  // Rising crossings with hysteresis (±1/4 of the peak): the codec's noise near zero does not count.
  let peak = 1;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf.readInt16LE(i * 2)));
  let cross = 0, high = null;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); if (v > peak / 4 && high === false) cross++; if (v > peak / 4) high = true; else if (v < -peak / 4) high = false; }
  return cross / (n / 48000);
}

test("J and L cuts in a real export: the next sound before its picture (J), the previous sound under the next picture (L)", async () => {
  // red (300 Hz) 0.5–3.0 s | blue (1000 Hz) 1.0–4.0 s with a J of 0.4 s | red 3.5–5.5 s with an L of 0.3 s.
  const plan = { schema: "montaj.editplan/2", title: "jl", segments: [{ mediaId: red, fromUs: 0.5 * US, toUs: 3 * US }, { mediaId: blue, fromUs: US, toUs: 4 * US, jl: -400 }, { mediaId: red, fromUs: 3.5 * US, toUs: 5.5 * US, jl: 300 }] };
  const r = await call("edit_plan_apply", { timelineId: tid, plan });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  const dir = path.join(root, "out");
  fs.mkdirSync(dir, { recursive: true });
  const ex = S.exporter.start({ timelineId: tid, mode: "video", name: "jl", dir, resolution: "480p", codec: "h264", format: "mp4", fps: 30 });
  const t0 = Date.now();
  while (!events.some((e) => e.e === "export:done" && e.jobId === ex.jobId)) {
    const err = events.find((e) => e.e === "export:error" && e.jobId === ex.jobId);
    if (err) assert.fail(JSON.stringify(err.error));
    if (Date.now() - t0 > 240_000) assert.fail("export timeout");
    await new Promise((res) => setTimeout(res, 200));
  }
  const out = ex.path;
  if (process.env.QW_DEBUG) for (const t of [2.0, 2.3, 2.6, 2.7, 3.0, 5.0, 5.3, 5.6]) console.log(t, (await colorAt(out, t)).is, Math.round(await hzAt(out, t, t + 0.2)));
  // Sound joints at 2.5 s and 5.5 s (the clips' edit points); picture joints at 2.9 s (J) and 5.2 s (L).
  assert.equal((await colorAt(out, 2.3)).is, "red");
  assert.ok(Math.abs((await hzAt(out, 2.0, 2.4)) - 300) < 40, "before the J: red's sound");
  assert.equal((await colorAt(out, 2.7)).is, "red", "J: red's picture holds…");
  assert.ok(Math.abs((await hzAt(out, 2.56, 2.86)) - 1000) < 60, "…while blue's sound has started");
  assert.equal((await colorAt(out, 3.05)).is, "blue");
  assert.equal((await colorAt(out, 5.05)).is, "blue");
  assert.equal((await colorAt(out, 5.35)).is, "red", "L: red's picture is back…");
  assert.ok(Math.abs((await hzAt(out, 5.24, 5.46)) - 1000) < 60, "…under blue's sound running on");
  assert.ok(Math.abs((await hzAt(out, 5.6, 6.0)) - 300) < 40, "after the L: red's sound");
  assert.ok(Math.abs((await hzAt(out, 1.0, 2.4)) - 300) < 40 && Math.abs((await hzAt(out, 3.0, 5.4)) - 1000) < 40, "no sound is lost or doubled");
});

test("the director on two clips: one story in timeline order, each file's words kept, a J into the new scene, one undo step", async () => {
  const T = S.timelines;
  const ps = mainPieces(T.get(tid).timeline);
  await T.batch(tid, "reset", async () => { for (const p of ps) T.exec(tid, "delete", { ids: [p.id] }); });
  await call("timeline_add_clip", { timelineId: tid, mediaId: red });
  await call("timeline_add_clip", { timelineId: tid, mediaId: blue });
  const depth = T.get(tid).history.depth;
  // No render measurement or sound-library worker here (they start a headless browser / a CLAP process that outlive the test).
  const r = await autoEdit(hub.userContext(), tid, { apply: true, stabilize: false, person: false, title: "auto two", measureGraphics: false, sounds: "bundled" });
  assert.equal(r.undoLabel, "plan:auto two");
  assert.equal(T.get(tid).history.depth, depth + 1, "one undo step");
  assert.equal(r.plan.schema, "montaj.editplan/2");
  // The body keeps the timeline order; a treatment may open with a flash-forward hook (phase 7), also kept in place.
  const order = r.plan.segments.filter((s) => s.role !== "hook").map((s) => s.mediaId);
  assert.deepEqual([...new Set(order)], [red, blue], "timeline order kept");
  assert.equal(r.plan.segments.find((s) => s.role !== "hook").mediaId, red, "after the hook, the story starts with the first clip");
  const hookUs = r.plan.segments.filter((s) => s.role === "hook").reduce((n, s) => n + s.toUs - s.fromUs, 0);
  assert.equal(mainPieces(T.get(tid).timeline).find((p) => p.start >= hookUs - 1000).mediaId, red, "and so does the timeline");
  assert.ok(T.get(tid).timeline.tracks.find((t) => t.isMain).segments.some((s) => s.mediaId === blue && s.jlUs === -200_000), "a J lead into the second clip");
  assert.ok(r.qa.passed.includes("speech.lostWord") && r.qa.passed.includes("speech.cutInsideWord"));
  assert.ok(r.notes.some((n) => /2 clips planned as one story/.test(n)));
  assert.ok(r.after.durationUs < 12 * US && r.after.durationUs > 5 * US, `${r.after.durationUs}`);
  T.exec(tid, "undo", {});
  assert.deepEqual(mainPieces(T.get(tid).timeline).map((p) => p.mediaId), [red, blue]);
});
