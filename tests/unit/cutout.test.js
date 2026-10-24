// Text behind the person: the behind/cutout logic, the export graph, and a real FFmpeg render with a synthetic
// person matte (left half = person) — the text must disappear behind the "person" and stay visible beside it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline, newSegment, mainTrack } from "../../src/core/model.js";
import { behindWindows, cutoutLayers, cutoutAfterTrack, cutoutMedia } from "../../src/core/cutout.js";
import { buildExport } from "../../src/core/exportGraph.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { US } from "../../src/core/util.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-cutout-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const caps = { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() };
const media = (id, file = `${id}.mp4`) => ({ id, path: file, type: "video", durationUs: 4 * US, width: 640, height: 360, hasAudio: false, hasVideo: true, videoCodec: "h264", fps: 30 });
const text = (start, duration, content = "WOW") => newSegment("text", { start, duration, text: { content } });

function setup() {
  const tl = newTimeline("p", { width: 640, height: 360 });
  const m = { a: media("a"), b: media("b") };
  ops.addMediaSegment(tl, m.a); // 0–4 s
  ops.addMediaSegment(tl, m.b); // 4–8 s
  return { tl, m };
}

test("behind layers: windows merge, cutouts follow the main clips, the cutout goes right above the behind tracks", () => {
  const { tl } = setup();
  const t1 = ops.addSegment(tl, text(1 * US, 2 * US));
  const t2 = ops.addSegment(tl, text(2.5 * US, 2.5 * US, "TWO")); // overlaps t1 → its own track
  const cap = ops.addSegment(tl, text(0, 8 * US, "caption"));
  assert.deepEqual(behindWindows(tl), []);
  assert.deepEqual(ops.setBehindPerson(tl, [t1.id, t2.id], true), [t1.id, t2.id]);
  const main = mainTrack(tl);
  const behind = tl.tracks.filter((t) => t.role === "behind");
  assert.equal(behind.length, 2, "overlapping behind layers get a second behind track");
  const capTrack = tl.tracks.find((t) => t.segments.some((s) => s.id === cap.id));
  for (const t of behind) { assert.ok(t.order > main.order); assert.ok(t.order < capTrack.order, "other layers stay above the person"); }
  assert.deepEqual(behindWindows(tl), [[1 * US, 5 * US]]);
  const cuts = cutoutLayers(tl);
  assert.deepEqual(cuts.map((c) => [c.seg.mediaId, c.a, c.b]), [["a", 1 * US, 4 * US], ["b", 4 * US, 5 * US]], "one cutout per main clip under the window");
  assert.ok(cuts.every((c) => c.seg.videoFx.matte.type === "person" && c.seg.audioDetached), "cutouts are silent person mattes");
  assert.equal(mainTrack(tl).segments[0].videoFx.matte.type, "none", "the clip itself is not changed");
  assert.deepEqual(cutoutMedia(tl), ["a", "b"]);
  assert.equal(cutoutAfterTrack(tl), behind.sort((x, y) => y.order - x.order)[0].id);
  // A new text never lands on a behind track by itself.
  const later = ops.addSegment(tl, text(6 * US, 1 * US, "later"));
  assert.ok(!tl.tracks.find((t) => t.segments.some((s) => s.id === later.id)).role);
  // Back in front: the behind tracks empty out and go away.
  ops.setBehindPerson(tl, [t1.id, t2.id], false);
  assert.equal(tl.tracks.filter((t) => t.role === "behind").length, 0);
  assert.deepEqual(cutoutLayers(tl), []);
  assert.throws(() => ops.setBehindPerson(tl, [main.segments[0].id], true), /cannotGoBehind/);
});

test("export graph: cutouts are alpha-merged with the person matte and need it", () => {
  const { tl, m } = setup();
  const t1 = ops.addSegment(tl, text(1 * US, 2 * US));
  ops.setBehindPerson(tl, [t1.id], true);
  const o = { media: m, overlays: { [t1.id]: "t.png" }, width: 640, height: 360, fps: 30, mode: "video", caps, video: { codec: "h264" } };
  assert.throws(() => buildExport(tl, o), /matteMissing/);
  const { graph, inputs } = buildExport(tl, { ...o, mattes: { a: "a-matte.mp4" } });
  assert.ok(inputs.includes("a-matte.mp4"), "the matte video is an input");
  assert.match(graph, /alphamerge/);
  assert.match(graph, /scale=640:360:flags=bicubic,format=gray/);
});

test("rendered: the text is hidden where the matte says person and visible beside it", async () => {
  const ff = binaries().ffmpeg;
  const clip = path.join(dir, "blue.mp4"), matte = path.join(dir, "matte.mp4"), red = path.join(dir, "red.png");
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0x2040C0:s=640x360:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { timeoutMs: 60_000 });
  // Person = left half (white), background = right half (black); the real matte has the media's timing too.
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x360:r=30:d=4", "-f", "lavfi", "-i", "color=c=black:s=320x360:r=30:d=4",
    "-filter_complex", "[0][1]hstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", matte], { timeoutMs: 60_000 });
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0xE02020:s=640x360", "-frames:v", "1", red], { timeoutMs: 60_000 });
  const tl = newTimeline("p", { width: 640, height: 360 });
  const m = { a: media("a", clip) };
  ops.addMediaSegment(tl, m.a);
  const t1 = ops.addSegment(tl, text(0, 3 * US));
  const pixelAt = async (behind) => {
    ops.setBehindPerson(tl, [t1.id], behind);
    const b = buildExport(tl, { media: m, overlays: { [t1.id]: red }, mattes: { a: matte }, width: 640, height: 360, fps: 30, mode: "still", stillAtUs: 1 * US, caps });
    const out = path.join(dir, `still-${behind}.png`);
    await run(ff, ["-hide_banner", "-y", ...b.inputs, "-filter_complex", b.graph, ...b.encode, out], { timeoutMs: 60_000 });
    const raw = (await run(ff, ["-hide_banner", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeoutMs: 60_000 })).stdout;
    const px = (x, y) => [...raw.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
    return { person: px(160, 180), beside: px(480, 180) };
  };
  const red_ = ([r, g, b]) => r > 180 && g < 80 && b < 80, blue_ = ([r, g, b]) => b > 150 && r < 90;
  const front = await pixelAt(false);
  assert.ok(red_(front.person) && red_(front.beside), `in front: text everywhere ${JSON.stringify(front)}`);
  const back = await pixelAt(true);
  assert.ok(blue_(back.person), `behind: the person covers the text ${JSON.stringify(back)}`);
  assert.ok(red_(back.beside), `behind: the text shows beside the person ${JSON.stringify(back)}`);
});
