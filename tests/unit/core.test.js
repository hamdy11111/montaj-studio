// Pure core logic (shared by the main process and the renderer): timeline operations, speed, layer math,
// shortcuts, naming, captions, EditPilot planner, colour, history, validation and i18n coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline, newSegment, mainTrack, findSegment, canvasSize } from "../../src/core/model.js";
import { curveIntegral, timelineDurationFor, sourceOffsetAt, curveChunks, atempoChain, CURVE_PRESETS } from "../../src/core/speed.js";
import { layerState, NUM, EXPR, keyframeValue, gainAt, transitionsFor } from "../../src/core/layerMath.js";
import { chordFromEvent, normalizeChord, applyBinding, defaultBindings, findConflicts, lookup, COMMANDS } from "../../src/core/shortcuts.js";
import { defaultProjectName, uniqueName, duplicateName } from "../../src/core/naming.js";
import { parseSrt, formatSrt, cuesFromTimeline } from "../../src/core/srt.js";
import { planFromText } from "../../src/core/assistant.js";
import { isDefaultAdjust, applyFilterPreset, adjustToFfmpeg, makePixelProcessor, evalCurve } from "../../src/core/color.js";
import { History } from "../../src/core/history.js";
import { validateName, validateNumber, validateColor, AppError } from "../../src/core/validation.js";
import { parseCube, sampleLut } from "../../src/core/lut.js";
import { US, formatTimecode } from "../../src/core/util.js";
import { pickVideoEncoder, sourceMatrix, splitFilters, buildExport, planSegments } from "../../src/core/exportGraph.js";
import { has } from "../../src/renderer/js/i18n.js";

const media = (id, durS, type = "video") => ({ id, name: `${id}.mp4`, type, durationUs: durS * US, width: 1920, height: 1080, hasAudio: true });
function tl3() {
  const tl = newTimeline("p1");
  for (const [id, d] of [["m1", 4], ["m2", 3], ["m3", 5]]) ops.addMediaSegment(tl, media(id, d));
  return tl;
}
const opts = { magnet: true, linkage: true, linkTypes: ["text"] };

test("add, split, delete with magnet packs the main track", () => {
  const tl = tl3();
  const main = mainTrack(tl);
  assert.deepEqual(main.segments.map((s) => [s.start, s.duration]), [[0, 4e6], [4e6, 3e6], [7e6, 5e6]]);
  const right = ops.splitSegment(tl, main.segments[0].id, 1.5e6);
  assert.equal(right.sourceStart, 1.5e6);
  assert.equal(main.segments.length, 4);
  ops.deleteSegments(tl, [main.segments[1].id], opts);
  assert.equal(main.segments[1].start, 1.5e6); // gap closed
  assert.deepEqual(ops.validateTimeline(tl), []);
});

test("linkage moves attached text with its main clip", () => {
  const tl = tl3();
  const [, b] = mainTrack(tl).segments;
  const txt = ops.addSegment(tl, Object.assign(newSegment("text"), { start: b.start + 500_000, duration: 1e6 }));
  ops.deleteSegments(tl, [mainTrack(tl).segments[0].id], opts);
  assert.equal(findSegment(tl, txt.id).segment.start, 500_000);
});

test("move to a new track, trim bounded by media length, delete left/right", () => {
  const tl = tl3();
  const [a, b] = mainTrack(tl).segments;
  ops.moveSegment(tl, b.id, 1e6, "new", { magnet: true });
  const moved = findSegment(tl, b.id);
  assert.equal(moved.track.isMain, false);
  assert.equal(moved.segment.start, 1e6);
  ops.trimSegment(tl, a.id, "end", 99e6, 4e6, opts);
  assert.equal(findSegment(tl, a.id).segment.duration, 4e6); // cannot exceed the source
  ops.deleteSide(tl, a.id, 1e6, "left", opts);
  assert.equal(findSegment(tl, mainTrack(tl).segments[0].id).segment.sourceStart, 1e6);
});

test("magnet reorder: a dropped main clip lands in the slot the drop position points to", () => {
  const order = (tl) => mainTrack(tl).segments.map((s) => s.mediaId).join(",");
  const cases = [[0, "m2,m1,m3"], [1e6, "m2,m1,m3"], [2.5e6, "m1,m2,m3"], [9e6, "m1,m2,m3"], [10e6, "m1,m3,m2"]];
  for (const [drop, want] of cases) {
    const tl = tl3(); // m1 0–4 s, m2 4–7 s, m3 7–12 s
    const m2 = mainTrack(tl).segments[1];
    ops.moveSegment(tl, m2.id, drop, null, opts);
    assert.equal(order(tl), want, `drop at ${drop / 1e6}s`);
    assert.deepEqual(ops.validateTimeline(tl), []);
    assert.equal(mainTrack(tl).segments[0].start, 0); // packed, no gaps
  }
  // Linked items follow their main clip to its new position.
  const tl = tl3();
  const m3 = mainTrack(tl).segments[2];
  const title = ops.addSegment(tl, Object.assign(newSegment("text"), { start: m3.start + 1e6, duration: 1e6 }));
  ops.moveSegment(tl, m3.id, 0, null, opts);
  assert.equal(order(tl), "m3,m1,m2");
  assert.equal(findSegment(tl, title.id).segment.start, 1e6);
});

test("locked tracks reject edits; group moves together; markers and snapping", () => {
  const tl = tl3();
  const main = mainTrack(tl);
  main.locked = true;
  assert.throws(() => ops.splitSegment(tl, main.segments[0].id, 1e6), (e) => e.messageKey === "err.trackLocked");
  main.locked = false;
  const t1 = ops.addSegment(tl, Object.assign(newSegment("text"), { start: 0, duration: 1e6 }));
  const t2 = ops.addSegment(tl, Object.assign(newSegment("sticker"), { start: 0, duration: 1e6 }));
  ops.group(tl, [t1.id, t2.id]);
  ops.moveSegment(tl, t1.id, 2e6, null, { magnet: true });
  assert.equal(findSegment(tl, t2.id).segment.start, 2e6);
  ops.addMarker(tl, 3e6);
  assert.equal(ops.nextMarker(tl, 0).timeUs, 3e6);
  assert.equal(ops.snapTime(tl, 4.05e6, 100_000), 4e6);
});

test("copy/paste segments and attributes; compound create/expand round-trip", () => {
  const tl = tl3();
  const [a, b] = mainTrack(tl).segments;
  a.transform.scale = 2;
  const attrs = ops.copyAttributes(a);
  ops.pasteAttributes(tl, [b.id], attrs);
  assert.equal(findSegment(tl, b.id).segment.transform.scale, 2);
  const ids = ops.pasteSegments(tl, ops.copySegments(tl, [a.id]), 0, opts);
  assert.equal(mainTrack(tl).segments.length, 4);
  assert.notEqual(ids[0], a.id);
  const child = newTimeline("p1", { name: "child" });
  const comp = ops.createCompound(tl, [mainTrack(tl).segments[1].id, mainTrack(tl).segments[2].id], child);
  assert.equal(comp.kind, "compound");
  assert.equal(child.tracks[0].segments.length, 2);
  ops.expandCompound(tl, comp.id, child);
  assert.equal(mainTrack(tl).segments.length, 4);
});

test("speed: constant and curve durations, source mapping, export chunks, atempo chain", () => {
  const seg = { duration: 4e6, speed: 2, speedMode: "standard", curve: { points: [] } };
  assert.equal(timelineDurationFor(seg, 8e6), 4e6);
  assert.equal(sourceOffsetAt(seg, 1e6), 2e6);
  const curve = { duration: 4e6, speedMode: "curve", curve: { points: CURVE_PRESETS.montage } };
  assert.ok(curveIntegral(CURVE_PRESETS.montage, 1) > 1);
  const chunks = curveChunks(curve, 12);
  assert.equal(chunks.length, 12);
  assert.ok(Math.abs(chunks.reduce((a, c) => a + c.srcDur, 0) - sourceOffsetAt(curve, 4e6)) < 1);
  assert.equal(atempoChain(5), "atempo=2,atempo=2,atempo=1.25");
  assert.equal(atempoChain(0.2), "atempo=0.5,atempo=0.5,atempo=0.8");
});

test("layer math: same formulas in numbers and FFmpeg expressions", () => {
  const seg = Object.assign(newSegment("video"), { duration: 2e6, transform: { x: 0.25, y: -0.1, scale: 1.5, opacity: 0.8, rotation: 10 } });
  seg.keyframes = [{ id: "k1", prop: "scale", timeUs: 0, value: 1, easing: "linear" }, { id: "k2", prop: "scale", timeUs: 1e6, value: 2, easing: "linear" }];
  const st = layerState(NUM, seg, 0.5, { W: 1920, H: 1080 });
  assert.equal(st.x, 480);   // x is a fraction of the width
  assert.equal(st.y, -108);
  assert.equal(st.scale, 1.5); // keyframe interpolated halfway between 1 and 2
  assert.ok(Math.abs(st.opacity - 0.8) < 1e-9);
  const ex = layerState(EXPR, seg, "t", { W: 1920, H: 1080 });
  const evalExpr = (e, t) => Function("t", "lt", "clip", "if_", `return ${String(e).replace(/if\(/g, "if_(")}`)(t, (a, b) => (a < b ? 1 : 0), (a, lo, hi) => Math.min(hi, Math.max(lo, a)), (c, a, b) => (c ? a : b));
  assert.ok(Math.abs(evalExpr(ex.scale, 0.5) - 1.5) < 1e-6);
  assert.equal(keyframeValue(NUM, seg, "x", 0), null);
  seg.fadeInUs = 1e6;
  assert.ok(Math.abs(gainAt(NUM, seg, 0.5) - 0.5) < 1e-9);
  const a = Object.assign(newSegment("video"), { start: 0, duration: 2e6, transitionOut: { type: "dissolve", durationUs: 1e6 } });
  const b = Object.assign(newSegment("video"), { start: 2e6, duration: 2e6 });
  assert.equal(transitionsFor([a, b], 1).transIn.type, "dissolve");
});

test("shortcuts: chords, conflicts, override, fixed gestures", () => {
  assert.equal(chordFromEvent({ key: "e", code: "KeyE" }), "E");
  assert.equal(chordFromEvent({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+Z");
  assert.equal(chordFromEvent({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }), "Shift+Left");
  assert.equal(normalizeChord("Shift+Ctrl+K"), "Ctrl+Shift+K");
  const b = defaultBindings();
  assert.equal(b.split, "E");
  assert.deepEqual(findConflicts(b), []);
  assert.throws(() => applyBinding(b, "split", "Q"), (e) => e.code === "CONFLICT" && e.details.conflictWith === "deleteLeft");
  const nb = applyBinding(b, "split", "Q", { override: true });
  assert.equal(nb.split, "Q"); assert.equal(nb.deleteLeft, "");
  assert.equal(lookup(nb, "Q"), "split");
  assert.throws(() => applyBinding(b, "zoomWheel", "Z"), (e) => e.messageKey === "err.shortcutFixed");
  assert.equal(COMMANDS.length, 100);
});

test("every remappable shortcut command has a handler in the editor", () => {
  const src = fs.readFileSync(path.resolve("src/renderer/js/editor/editor.js"), "utf8");
  const body = src.slice(src.indexOf("const commands = {"), src.indexOf("function easing("));
  const missing = COMMANDS.filter((c) => !c.fixed && !new RegExp(`\\b${c.id}\\s*:`).test(body)).map((c) => c.id);
  assert.deepEqual(missing, []);
});

test("naming: MMDD default names, uniqueness and duplicates", () => {
  const d = new Date(2026, 9, 23);
  assert.equal(defaultProjectName([], d), "1023");
  assert.equal(defaultProjectName(["1023", "1023 (1)"], d), "1023 (2)");
  assert.equal(uniqueName("Clip", ["clip"]), "Clip (1)");
  assert.equal(duplicateName("Trip (3)", ["Trip", "Trip (3)"]), "Trip (1)");
});

test("SRT round trip, WebVTT input and captions from text clips", () => {
  const cues = parseSrt("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<b>مرحبا</b>\n\n00:00:03,000 --> 00:00:04,000\nHello\n");
  assert.deepEqual(cues.map((c) => c.text), ["مرحبا", "Hello"]);
  assert.equal(cues[0].endUs, 2.5e6);
  assert.deepEqual(parseSrt(formatSrt(cues)), cues);
  assert.throws(() => parseSrt("garbage"), (e) => e.messageKey === "err.captionFormat");
  const tl = newTimeline("p");
  ops.addSegment(tl, Object.assign(newSegment("text"), { start: 1e6, duration: 1e6, text: { ...newSegment("text").text, content: "cap", isCaption: true } }));
  assert.equal(cuesFromTimeline(tl)[0].text, "cap");
});

test("EditPilot planner understands Arabic and English requests", () => {
  const p = planFromText("اجعل الفيديو عموديًا واحذف السكتات وأضف انتقال تلاشي");
  assert.deepEqual(p.actions.map((a) => a.type), ["setRatio", "removeSilences", "transitionAll"]);
  assert.equal(p.actions[0].args.ratio, "9:16");
  const q = planFromText('speed 2x and add text "Hello" then export');
  assert.deepEqual(q.actions.map((a) => a.type), ["setSpeed", "addText", "openExport"]);
  assert.equal(q.actions[1].args.content, "Hello");
  assert.equal(planFromText("lorem ipsum").understood, false);
});

test("colour: presets, FFmpeg chain, preview pixel processor, curves and LUT", () => {
  assert.equal(isDefaultAdjust(null), true);
  const a = applyFilterPreset(null, "mono", 100);
  assert.equal(a.saturation, -100);
  assert.ok(adjustToFfmpeg(a).join(",").includes("colorchannelmixer=")); // saturation done in RGB (BT.709 luma)
  const px = new Uint8ClampedArray([200, 50, 50, 255]);
  makePixelProcessor(a)(px);
  assert.ok(Math.abs(px[0] - px[1]) <= 1 && Math.abs(px[1] - px[2]) <= 1); // desaturated
  assert.equal(evalCurve([[0, 0], [1, 1]], 0.3), 0.3);
  const cube = ["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)))].join("\n");
  const lut = parseCube(cube);
  const o = sampleLut(lut, 0.25, 0.5, 1);
  assert.ok(Math.abs(o[0] - 0.75) < 1e-6 && Math.abs(o[2]) < 1e-6); // inverted
});

test("encoder choice respects hardware frame-size limits (8K H.264 → GPU HEVC, like CapCut)", () => {
  const nv = new Set(["h264_nvenc", "hevc_nvenc", "libx264", "libx265"]);
  const pick = (codec, w, h, hw = true, enc = nv) => pickVideoEncoder(codec, { hw, encoders: enc, width: w, height: h });
  assert.deepEqual(pick("h264", 3840, 2160), { name: "h264_nvenc", hwFallback: false, switchedTo: null });
  assert.deepEqual(pick("h264", 7680, 4320), { name: "hevc_nvenc", hwFallback: false, switchedTo: "hevc" }); // NVENC H.264 max 4096 → GPU HEVC
  assert.deepEqual(pick("h264", 7680, 4320, true, new Set(["h264_nvenc", "libx264"])), { name: "libx264", hwFallback: true, switchedTo: null }); // no HEVC on the GPU
  assert.deepEqual(pick("h264", 2160, 4096), { name: "h264_nvenc", hwFallback: false, switchedTo: null }); // portrait at the limit
  assert.deepEqual(pick("hevc", 7680, 4320), { name: "hevc_nvenc", hwFallback: false, switchedTo: null });
  assert.deepEqual(pick("hevc", 15360, 8640), { name: "libx265", hwFallback: true, switchedTo: null });
  assert.deepEqual(pick("h264", 7680, 4320, false), { name: "libx264", hwFallback: false, switchedTo: null }); // hardware off: no warning
  assert.deepEqual(pick("h264", 1920, 1080, true, new Set(["libx264"])), { name: "libx264", hwFallback: false, switchedTo: null }); // no GPU encoder
  assert.equal(pick("prores", 7680, 4320).name, "prores_ks");
  // Encoder arguments: measured NVENC presets; an 8K H.264 export is written as GPU HEVC tagged hvc1.
  const tl8 = newTimeline("p", { width: 1920, height: 1080 });
  ops.addMediaSegment(tl8, { id: "m", path: "m.mp4", type: "video", durationUs: 2e6, width: 1920, height: 1080, hasAudio: false, hasVideo: true, videoCodec: "h264" });
  const enc = (w, h) => buildExport(tl8, { media: { m: { id: "m", path: "m.mp4", type: "video", durationUs: 2e6, width: 1920, height: 1080, hasAudio: false, hasVideo: true, videoCodec: "h264" } },
    width: w, height: h, fps: 30, mode: "video", caps: { encoders: nv }, video: { codec: "h264", hw: true }, audio: { enabled: false } }).encode.join(" ");
  assert.match(enc(1920, 1080), /-c:v h264_nvenc -preset p3 /);
  assert.match(enc(7680, 4320), /-c:v hevc_nvenc -preset p4 .*-tag:v hvc1/);
  const sw8k = buildExport(tl8, { media: { m: { id: "m", path: "m.mp4", type: "video", durationUs: 2e6, width: 1920, height: 1080, hasAudio: false, hasVideo: true, videoCodec: "h264" } },
    width: 7680, height: 4320, fps: 30, mode: "video", caps: { encoders: nv }, video: { codec: "h264", hw: false }, audio: { enabled: false } }).encode.join(" ");
  assert.match(sw8k, /-c:v libx264 -preset medium -threads 16 -rc-lookahead 20 /); // x264 8K peaked at 30 GB with auto threads
  assert.doesNotMatch(enc(1920, 1080), /-threads/);
  assert.equal(sourceMatrix({ height: 1080 }), "bt709");
  assert.equal(sourceMatrix({ height: 480 }), "bt601");
});

test("export graph: BT.709 conversions, RGB compositing and in-place grading for simple tracks", () => {
  const tl = newTimeline("p", { width: 1920, height: 1080 });
  const media = { m1: { id: "m1", path: "x.mp4", type: "video", durationUs: 10e6, width: 1920, height: 1080, hasAudio: false, hasVideo: true } };
  ops.addMediaSegment(tl, media.m1);
  ops.addSegment(tl, Object.assign(newSegment("filter"), { start: 0, duration: 5e6, filter: { preset: "mono", intensity: 100 } }));
  ops.addSegment(tl, Object.assign(newSegment("effect"), { start: 0, duration: 5e6, effect: { type: "mirror", intensity: 50 } }));
  const caps = { encoders: new Set(["libx264"]), filters: new Set(["colorchannelmixer", "lutrgb"]), timeline: new Set(["colorchannelmixer", "lutrgb"]) };
  const { graph } = buildExport(tl, { media, width: 1920, height: 1080, fps: 30, mode: "video", caps, video: { codec: "h264" } });
  assert.match(graph, /scale=in_color_matrix=bt709:in_range=tv,format=rgba/);
  assert.match(graph, /scale=out_color_matrix=bt709:out_range=tv,format=yuv420p/);
  assert.match(graph, /colorchannelmixer=[^\[;]*:enable='between\(t,0,/); // filter track graded in place
  assert.match(graph, /\[ma_\d+\]\[mr_\d+\]overlay/); // mirror (multi-input effect) keeps the general path
  for (const m of graph.matchAll(/overlay=[^\[;]*/g)) assert.match(m[0], /format=auto/); // every overlay composites in RGB
  assert.deepEqual(splitFilters("a=x='1,2',b,c=y"), ["a=x='1,2'", "b", "c=y"]);
});

test("export graph: only the range is processed; the main track is a concat sequence with windowed transitions", () => {
  const tl = newTimeline("p", { width: 1920, height: 1080 });
  const m = (id) => ({ id, path: `${id}.mp4`, type: "video", durationUs: 10e6, width: 1920, height: 1080, hasAudio: true, hasVideo: true, videoCodec: "h264", sampleRate: 48000 });
  const media = { m1: m("m1"), m2: m("m2") };
  for (const id of ["m1", "m2", "m1"]) ops.addMediaSegment(tl, media[id]);
  for (const sg of mainTrack(tl).segments.slice(0, 2)) sg.transitionOut = { type: "dissolve", durationUs: 500_000 };
  const caps = { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() };
  const opts = { media, width: 1920, height: 1080, fps: 30, mode: "video", caps, video: { codec: "h264" } };
  const { graph, inputs, durationUs } = buildExport(tl, { ...opts, range: { startUs: 8e6, endUs: 22e6 } });
  assert.equal(durationUs, 14e6);
  // The sequence holds the three frame-filling clips (the outgoing one runs on through each dissolve); the incoming
  // clip of each dissolve is overlaid during its window only.
  assert.match(graph, /concat=n=3:v=1:a=0,settb=1\/30,setpts=N/);
  assert.doesNotMatch(graph, /geq=/); // transitions: alpha fade inside the window, not a per-pixel expression
  // Opacity per frame (the preview's formula) via sendcmd on a cheap filter: first window frame 1.7667 s → p = 1/30.
  assert.match(graph, /sendcmd=c='1\.799999 colorchannelmixer@k\d+ aa 0\.1;[^']*',colorchannelmixer@k\d+=aa=0\.033333/);
  assert.equal((graph.match(/overlay=/g) || []).length, 2); // only the two windows composite; full-frame clips pass through
  assert.match(graph, /enable='between\(t,1\.766666,2\.266666\)'/); // frames from the first one at/after 1.75 s
  const seeks = []; for (let i = 0; i < inputs.length; i++) if (inputs[i] === "-ss") seeks.push(Number(inputs[i + 1]));
  assert.ok(seeks.includes(8), "clip 1 is decoded from the range start");
  assert.ok(!seeks.some((x) => x < 0));
  assert.match(graph, /\[vout\]/);
  // Untouched BT.709 clips: the composite stays YUV. Only the dissolve windows are trimmed, THEN converted to RGBA
  // for the opacity ramp, then to YUVA with the BT.709 matrix and blended in YUV.
  assert.match(graph, /trim=end=14,setpts=PTS-STARTPTS,format=yuv420p\[vout\]/);
  assert.match(graph, /trim=start_pts=53:end_pts=68\[(v\d+)\];\n\[\1\]scale=in_color_matrix=bt709:in_range=tv,format=rgba/);
  assert.equal((graph.match(/scale=out_color_matrix=bt709:out_range=tv,format=yuva420p/g) || []).length, 2);
  assert.equal((graph.match(/overlay=[^;]*format=yuv420:/g) || []).length, 2);
  assert.doesNotMatch(graph, /[^a]trim=start=8/); // no video before the range is rendered and thrown away
  // Audio: clips cut from the same file share one input (m1 is used twice), each part cut from it with atrim.
  assert.equal(inputs.filter((x, i) => x === "-vn" && inputs[i + 5] === "-i" && inputs[i + 6] === "m1.mp4").length, 1);
  assert.match(graph, /asplit=2/);
  assert.match(graph, /adelay=12000\|12000/); // clip 3 audio at its range-local position
  // A range that starts inside a transition window: the ramp starts where the window already is (p = 0.3).
  const inside = buildExport(tl, { ...opts, range: { startUs: 9.9e6, endUs: 11e6 } }).graph;
  assert.match(inside, /colorchannelmixer@k\d+=aa=0\.3,/);
  // A clip that does not fill the frame (4:3 on 16:9) is composited on the canvas instead of passed through.
  media.m2 = { ...media.m2, width: 1440 };
  const letterboxed = buildExport(tl, opts).graph;
  assert.equal((letterboxed.match(/overlay=/g) || []).length, 2); // clip 2 over a canvas gap, clip 3's dissolve window
  assert.match(letterboxed, /concat=n=3/); // clip 1 · gap · clip 3
});

test("export graph: untouched frame-filling clips stay in YUV; anything to composite or grade uses RGBA", () => {
  const media = { m: { id: "m", path: "m.mp4", type: "video", durationUs: 4e6, width: 1920, height: 1080, hasAudio: false, hasVideo: true, videoCodec: "h264" } };
  const make = () => { const tl = newTimeline("p", { width: 1920, height: 1080 }); ops.addMediaSegment(tl, media.m); ops.addMediaSegment(tl, media.m); return tl; };
  const g = (tl, extra = {}) => buildExport(tl, { media, width: 1920, height: 1080, fps: 30, mode: "video", caps: { encoders: new Set(["libx264"]), filters: new Set(["colorchannelmixer", "lutrgb"]), timeline: new Set(["colorchannelmixer", "lutrgb", "vignette"]) }, video: { codec: "h264" }, audio: { enabled: false }, ...extra }).graph;
  const plain = g(make());
  assert.doesNotMatch(plain, /rgba|color_matrix/); // no conversion at all: the source values pass through
  assert.match(plain, /concat=n=2/);
  assert.match(plain, /format=yuv420p\[vout\]/);
  const graded = make(); mainTrack(graded).segments[0].adjust = { ...mainTrack(graded).segments[0].adjust, saturation: 30 };
  assert.match(g(graded), /format=rgba/); // a grade needs RGB
  const dissolve = make(); mainTrack(dissolve).segments[0].transitionOut = { type: "dissolve", durationUs: 500_000 };
  assert.match(g(dissolve), /format=rgba/); // a transition composites
  const titled = make(); ops.addSegment(titled, Object.assign(newSegment("effect"), { start: 0, duration: 1e6, effect: { type: "vignette", intensity: 50 } }));
  assert.match(g(titled), /format=rgba/); // a layer above
  const sd = make(); assert.match(g(sd, { media: { m: { ...media.m, height: 480, width: 854 } } }), /format=rgba/); // BT.601 source: convert
  const red = make(); red.canvas.bgColor = "#FF0000"; ops.moveSegment(red, mainTrack(red).segments[1].id, 6e6, null, { magnet: false });
  assert.match(g(red), /format=rgba/); // a coloured gap
  assert.match(g(make(), { mode: "still", stillAtUs: 1e6 }), /format=rgb24/); // stills keep the RGB path
});

test("long exports are planned in frame-aligned parts that close at cuts", () => {
  const tl = newTimeline("p", { width: 1920, height: 1080 });
  const m = { id: "m", path: "m.mp4", type: "video", durationUs: 2e6, width: 1920, height: 1080, hasAudio: true, hasVideo: true };
  for (let i = 0; i < 30; i++) ops.addMediaSegment(tl, m); // 30 clips × 2 s
  const parts = planSegments(tl, { fps: 30 });
  assert.ok(parts.length >= 4, `${parts.length} parts`);
  assert.equal(parts[0].startUs, 0);
  assert.equal(parts.at(-1).endUs, 60e6);
  for (let i = 1; i < parts.length; i++) {
    assert.equal(parts[i].startUs, parts[i - 1].endUs); // contiguous
    assert.ok(Math.abs(parts[i].startUs / 2e6 - Math.round(parts[i].startUs / 2e6)) < 1e-9); // at a cut
  }
  for (const p of parts) assert.ok(mainTrack(tl).segments.filter((x) => x.start < p.endUs && x.start + x.duration > p.startUs).length <= 8);
  // A range keeps its own frame grid: parts start on frames counted from the range start.
  const r = planSegments(tl, { fps: 30, range: { startUs: 1_010_000, endUs: 41e6 } });
  assert.equal(r[0].startUs, 1_010_000);
  for (const p of r.slice(1)) assert.ok(Math.abs(((p.startUs - 1_010_000) * 30) / 1e6 - Math.round(((p.startUs - 1_010_000) * 30) / 1e6)) < 1e-6);
  // A short timeline is a single part.
  assert.equal(planSegments(newTimelineWith(3), { fps: 30 }).length, 1);
  function newTimelineWith(n) { const t = newTimeline("q"); for (let i = 0; i < n; i++) ops.addMediaSegment(t, m); return t; }
});

test("history: undo/redo, coalescing and limit", () => {
  const h = new History({ limit: 3, coalesceMs: 800 });
  h.push({ v: 0 }, "a", "k", 1000); h.push({ v: 1 }, "a", "k", 1500); // coalesced
  assert.equal(h.info().depth, 1);
  h.push({ v: 2 }, "b", null, 3000); h.push({ v: 3 }, "c", null, 4000); h.push({ v: 4 }, "d", null, 5000);
  assert.equal(h.info().depth, 3);
  const u = h.undo({ v: 5 });
  assert.deepEqual(u.state, { v: 4 });
  assert.deepEqual(h.redo({ v: 4 }).state, { v: 5 });
});

test("validation rules and the error envelope", () => {
  assert.equal(validateName("  My film "), "My film");
  for (const bad of ["", "a/b", "a:b", ".hidden", "x".repeat(256)]) assert.throws(() => validateName(bad), AppError);
  assert.throws(() => validateNumber("abc", { field: "n" }), (e) => e.messageKey === "err.number");
  assert.throws(() => validateNumber(5, { min: 0, max: 1 }), (e) => e.messageKey === "err.range");
  assert.equal(validateColor("#00c1cd"), "#00C1CD");
  assert.throws(() => validateColor("red"));
  assert.deepEqual(canvasSize("9:16", 1080), { width: 1080, height: 1920 });
  assert.equal(formatTimecode(1.5 * US, 30), "00:00:01:15");
});

test("every error and UI message key has a translation", () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|cjs)$/.test(p)) files.push(p); } };
  walk(path.resolve("src"));
  const missing = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/"(err\.[A-Za-z0-9]+)"/g)) if (!has(m[1])) missing.add(m[1]);
    if (f.includes(`${path.sep}renderer${path.sep}`)) for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z]+\.[A-Za-z0-9]+)"/g)) if (!has(m[1])) missing.add(m[1]);
  }
  assert.deepEqual([...missing], []);
});
