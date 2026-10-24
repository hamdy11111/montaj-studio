// End-to-end export tests with real FFmpeg on generated media (no network). Verifies the output with ffprobe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, closeDatabase } from "../../src/db/realmClient.js";
import { createRepositories } from "../../src/db/repositories.js";
import { makePaths } from "../../src/services/paths.js";
import { MediaService } from "../../src/services/mediaService.js";
import { SettingsService } from "../../src/services/settingsService.js";
import { TimelineService } from "../../src/services/timelineService.js";
import { ExportService } from "../../src/services/exportService.js";
import { ffprobe, binaries, run } from "../../src/services/ffmpeg.js";
import { US } from "../../src/core/util.js";
import { planSegments } from "../../src/core/exportGraph.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-export-"));
let paths, repos, media, settings, timeline, exporter, project, clipA, clipB, song;
const events = [];

async function makeClip(name, src, seconds, withAudio = true) {
  const out = path.join(root, name);
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", `${src}=size=640x360:rate=30:duration=${seconds}`];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-shortest", "-c:a", "aac");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", out);
  await run(binaries().ffmpeg, args, { timeoutMs: 120_000 });
  return out;
}

const waitFor = (pred, ms = 240_000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => { const e = events.find(pred); if (e) { clearInterval(iv); resolve(e); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("timeout")); } }, 100);
});

before(async () => {
  paths = makePaths(root);
  const realm = await openDatabase({ file: paths.db });
  repos = createRepositories(realm);
  settings = new SettingsService({ repos, paths });
  media = new MediaService({ repos, paths });
  timeline = new TimelineService({ repos, media, settings });
  exporter = new ExportService({ repos, paths, settings, notify: (e, p) => events.push({ e, ...p }) });
  project = repos.projects.create({ name: "export-test" });
  const fa = await makeClip("a.mp4", "testsrc2", 4);
  const fb = await makeClip("b.mp4", "smptehdbars", 4);
  const fs3 = path.join(root, "tone.wav");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=6", fs3], { timeoutMs: 60_000 });
  const r = await media.importFiles(project.id, [fa, fb, fs3, path.join(root, "missing.mp4")]);
  assert.equal(r.imported.length, 3);
  assert.equal(r.errors.length, 1, "missing file reported, not thrown");
  [clipA, clipB, song] = r.imported;
});

after(() => { closeDatabase({ shutdown: true }); if (!process.env.MONTAJ_KEEP_EXPORT_GRAPH) fs.rmSync(root, { recursive: true, force: true }); });

test("probe classifies media types and durations", () => {
  assert.equal(clipA.type, "video");
  assert.ok(Math.abs(clipA.durationUs - 4 * US) < 0.2 * US);
  assert.equal(song.type, "audio");
});

test("thumbnails sprite and waveform are generated", async () => {
  const m = await media.generateDerivatives(clipA.id);
  assert.ok(fs.existsSync(m.thumbPath));
  assert.ok(m.thumbCount >= 1);
  const wf = media.readWaveform(clipA.id);
  assert.equal(wf.rate, 100);
  assert.ok(wf.peaks.length > 300);
});

test("full timeline export: transition, speed, curve, keyframes, grade, filter/effect tracks, text overlay, audio", async () => {
  const tid = project.mainTimelineId;
  await timeline.exec(tid, "addMedia", { mediaId: clipA.id });
  await timeline.exec(tid, "addMedia", { mediaId: clipB.id });
  let st = timeline.get(tid).timeline;
  const [a, b] = st.tracks[0].segments;
  await timeline.exec(tid, "setSpeed", { segId: a.id, speed: 2 });
  await timeline.exec(tid, "setCurve", { segId: b.id, preset: "hero" });
  await timeline.exec(tid, "setTransition", { segId: a.id, type: "dissolve", durationUs: 500_000 });
  await timeline.exec(tid, "updateSegment", { segId: a.id, patch: { adjust: { contrast: 20, saturation: 30, hsl: { red: { h: 15, s: 10, l: 0 } }, curves: { master: [[0, 0], [0.5, 0.55], [1, 1]] } }, animation: { in: { type: "zoom_in", durationUs: 400_000 } } } });
  await timeline.exec(tid, "addKeyframe", { segId: b.id, prop: "scale", timeUs: 0, value: 1 });
  await timeline.exec(tid, "addKeyframe", { segId: b.id, prop: "scale", timeUs: 1_000_000, value: 1.3, easing: "easeInOut" });
  await timeline.exec(tid, "addKeyframe", { segId: b.id, prop: "opacity", timeUs: 0, value: 0.5 });
  await timeline.exec(tid, "addKeyframe", { segId: b.id, prop: "opacity", timeUs: 800_000, value: 1 });
  await timeline.exec(tid, "addSegment", { kind: "filter", atUs: 0, durationUs: 1_500_000, init: { filter: { preset: "vintage", intensity: 80 } } });
  await timeline.exec(tid, "addSegment", { kind: "effect", atUs: 1_000_000, durationUs: 1_000_000, init: { effect: { type: "vignette", intensity: 60 } } });
  const txt = await timeline.exec(tid, "addSegment", { kind: "text", atUs: 500_000, durationUs: 2_000_000, init: { text: { content: "مرحبا" }, animation: { in: { type: "fade", durationUs: 300_000 } } } });
  await timeline.exec(tid, "addSegment", { kind: "audio", mediaId: song.id, atUs: 0 });
  st = timeline.get(tid).timeline;
  const audioSeg = st.tracks.find((t) => t.type === "audio").segments[0];
  await timeline.exec(tid, "updateSegment", { segId: audioSeg.id, patch: { volumeDb: -6, fadeInUs: 500_000, fadeOutUs: 500_000, audioFx: { denoise: { enabled: true } } } });
  // A text overlay PNG as the renderer would provide it (generated here with FFmpeg).
  const png = path.join(root, "text.png");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=200x60", "-frames:v", "1", png], { timeoutMs: 30_000 });
  const b64 = fs.readFileSync(png).toString("base64");
  const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "480p", fps: 30, codec: "h264", overlays: { [txt.result]: b64 }, dir: root });
  const done = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
  assert.equal(done.e, "export:done", JSON.stringify(done.error?.details?.stderr || done.error));
  const info = await ffprobe(out);
  const v = info.streams.find((x) => x.codec_type === "video");
  assert.equal(v.height, 480);
  assert.ok(info.streams.some((x) => x.codec_type === "audio"));
  const total = timeline.get(tid).timeline.tracks.reduce((m, t) => Math.max(m, ...t.segments.map((s) => s.start + s.duration)), 0);
  assert.ok(Math.abs(Number(info.format.duration) - total / US) < 0.25, `duration ${info.format.duration} vs ${total / US}`);
  assert.ok(events.some((e) => e.e === "export:progress"));
  assert.equal(repos.exports.list({ projectId: project.id })[0].status, "done");
});

test("audio-only, GIF, still frame and captions exports", async () => {
  const tid = project.mainTimelineId;
  for (const mode of ["audio", "gif", "still"]) {
    const { jobId, path: out } = exporter.start({ timelineId: tid, mode, audioFormat: "wav", gifResolution: "240p", stillAtUs: 1_000_000, dir: root, overlays: overlaysFor(tid) });
    const done = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
    assert.equal(done.e, "export:done", `${mode}: ${JSON.stringify(done.error?.details?.stderr || done.error)}`);
    assert.ok(fs.statSync(out).size > 0);
  }
  const st = timeline.get(tid).timeline;
  const txt = st.tracks.find((t) => t.type === "text").segments[0];
  await timeline.exec(tid, "updateSegment", { segId: txt.id, patch: { text: { isCaption: true, content: "سطر ترجمة" } } });
  const r = exporter.start({ timelineId: tid, mode: "captions", captionsFormat: "srt", dir: root });
  assert.ok(r.done);
  assert.match(fs.readFileSync(r.path, "utf8"), /00:00:00,500 --> 00:00:02,500\nسطر ترجمة/);
});

function overlaysFor(tid) {
  const st = timeline.get(tid).timeline;
  const png = path.join(root, "text.png");
  const b64 = fs.readFileSync(png).toString("base64");
  return Object.fromEntries(st.tracks.filter((t) => t.type === "text").flatMap((t) => t.segments.map((s) => [s.id, b64])));
}

test("cancel stops a running export and marks it cancelled", async () => {
  const tid = project.mainTimelineId;
  const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "1080p", codec: "h264", dir: root, overlays: overlaysFor(tid) });
  await new Promise((r) => setTimeout(r, 300));
  exporter.cancel(jobId);
  const ev = await waitFor((e) => e.jobId === jobId && (e.e === "export:error" || e.e === "export:done"));
  if (ev.e === "export:error") { assert.equal(ev.cancelled, true); assert.ok(!fs.existsSync(out)); }
});

test("advanced looks export: blend, mask, chroma, canvas blur, stabilize, denoise, motion blur, clip effects, LUT, voice FX, sticker, compound", async () => {
  const p2 = repos.projects.create({ name: "fx-test", canvas: { ratio: "16:9", width: 1920, height: 1080 } });
  repos.media.add(p2.id, clipA); repos.media.add(p2.id, clipB); repos.media.add(p2.id, song);
  const tid = p2.mainTimelineId;
  await timeline.exec(tid, "setCanvas", { bgType: "blur", bgBlur: 60 });
  const a = (await timeline.exec(tid, "addMedia", { mediaId: clipA.id })).result;
  const b = (await timeline.exec(tid, "addMedia", { mediaId: clipB.id })).result;
  await timeline.exec(tid, "updateSegment", { segId: a, patch: {
    transform: { scale: 0.7, x: 0.1, rotation: 5 },
    videoFx: { stabilize: { enabled: true }, denoise: { enabled: true, level: 40 }, motionBlur: { enabled: true, amount: 3 }, mask: { type: "circle", w: 0.8, h: 0.8, feather: 20 } },
    clipEffects: [{ type: "deflicker", intensity: 50 }, { type: "glow", intensity: 40 }, { type: "rgb_split", intensity: 50 }],
    audioFx: { voiceChanger: "deep", normalize: { enabled: true, targetLufs: -16 }, isolate: "remove_vocal" },
  } });
  // Overlay with a blend mode and chroma key, on its own track.
  const ov = (await timeline.exec(tid, "addMedia", { mediaId: clipB.id, toMain: false, atUs: 500_000 })).result;
  await timeline.exec(tid, "trim", { segId: ov, edge: "end", timeUs: 2_500_000 });
  await timeline.exec(tid, "updateSegment", { segId: ov, patch: { transform: { blend: "screen", scale: 0.5, opacity: 0.8 }, videoFx: { chroma: { enabled: true, color: "#00FF00", intensity: 40, shadow: 10 } }, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } });
  // LUT on clip b (identity 2³ cube) and a sticker.
  const cube = path.join(root, "id.cube");
  fs.writeFileSync(cube, ["LUT_3D_SIZE 2", ...[0, 1].flatMap((z) => [0, 1].flatMap((y) => [0, 1].map((x) => `${x} ${y} ${z}`)))].join("\n"));
  const lut = repos.library.add({ kind: "lut", category: "yours", name: "id.cube", path: cube, durationUs: 0, sizeBytes: 64 });
  await timeline.exec(tid, "updateSegment", { segId: b, patch: { adjust: { lut: { assetId: lut.id, intensity: 70 }, temperature: 20 } } });
  const st = (await timeline.exec(tid, "addSegment", { kind: "sticker", atUs: 0, durationUs: 2_000_000, init: { sticker: { builtin: "star" } } })).result;
  // Compound clip from clip b, pre-processed before the parent export.
  const comp = await timeline.exec(tid, "createCompound", { ids: [b], name: "sub" });
  const png = fs.readFileSync(path.join(root, "text.png")).toString("base64");
  const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "480p", fps: 25, codec: "h264", dir: root, overlays: { [st]: png } });
  const done = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
  assert.equal(done.e, "export:done", JSON.stringify(done.error?.details?.stderr?.slice(-1500) || done.error));
  assert.ok(fs.existsSync(exporter.compoundPath(comp.compoundTimelineId)), "compound clip was pre-processed");
  const info = await ffprobe(out);
  assert.equal(Number(info.streams.find((x) => x.codec_type === "video").height), 480);
  assert.ok(Math.abs(Number(info.format.duration) - 8) < 0.3, `duration ${info.format.duration}`);
});

test("every effect, filter, transition, animation, mask, blend mode and voice changer renders in FFmpeg", async () => {
  const { EFFECTS, FILTER_PRESETS, VOICE_CHANGERS } = await import("../../src/core/presets.js");
  const { TRANSITIONS, ANIMATIONS_IN, ANIMATIONS_COMBO } = await import("../../src/core/layerMath.js");
  const p3 = repos.projects.create({ name: "sweep", canvas: { ratio: "16:9", width: 640, height: 360 } });
  repos.media.add(p3.id, clipA); repos.media.add(p3.id, clipB);
  const tid = p3.mainTimelineId;
  const a = (await timeline.exec(tid, "addMedia", { mediaId: clipA.id })).result;
  const b = (await timeline.exec(tid, "addMedia", { mediaId: clipB.id })).result;
  const failures = [];
  const render = async (label, mode = "still", extra = {}) => {
    const { jobId } = exporter.start({ timelineId: tid, mode, resolution: "480p", stillAtUs: 3_800_000, audioFormat: "wav", dir: root, name: `sweep-${label}`, ...extra });
    const ev = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
    if (ev.e !== "export:done") failures.push(`${label}: ${String(ev.error?.details?.stderr || ev.error?.messageKey).slice(-300)}`);
  };
  for (const type of Object.keys(EFFECTS)) {
    const seg = (await timeline.exec(tid, "addSegment", { kind: "effect", atUs: 3_500_000, durationUs: 1_000_000, init: { effect: { type, intensity: 70 } } })).result;
    await render(`effect-${type}`);
    await timeline.exec(tid, "delete", { ids: [seg] });
  }
  for (const preset of Object.keys(FILTER_PRESETS)) {
    await timeline.exec(tid, "updateSegment", { segId: a, patch: { clipEffects: [], filter: null, adjust: { ...FILTER_PRESETS[preset].adjust } } });
    await render(`filter-${preset}`);
  }
  for (const type of TRANSITIONS.filter((x) => x !== "none")) { await timeline.exec(tid, "setTransition", { segId: a, type, durationUs: 600_000 }); await render(`transition-${type}`); }
  await timeline.exec(tid, "setTransition", { segId: a, type: "none" });
  for (const anim of ANIMATIONS_IN.filter((x) => x !== "none")) { await timeline.exec(tid, "updateSegment", { segId: b, patch: { animation: { in: { type: anim, durationUs: 500_000 }, out: { type: anim, durationUs: 500_000 } } } }); await render(`anim-${anim}`); }
  for (const combo of ANIMATIONS_COMBO.filter((x) => x !== "none")) { await timeline.exec(tid, "updateSegment", { segId: b, patch: { animation: { in: { type: "none" }, out: { type: "none" }, combo: { type: combo, durationUs: 1_000_000 } } } }); await render(`combo-${combo}`); }
  for (const type of ["rect", "circle", "linear"]) { await timeline.exec(tid, "updateSegment", { segId: b, patch: { videoFx: { mask: { type, feather: 30, invert: type === "linear" } } } }); await render(`mask-${type}`); }
  for (const blend of ["screen", "add", "multiply", "darken", "lighten"]) { await timeline.exec(tid, "updateSegment", { segId: b, patch: { transform: { blend } } }); await render(`blend-${blend}`); }
  for (const vc of Object.keys(VOICE_CHANGERS).filter((x) => x !== "none")) { await timeline.exec(tid, "updateSegment", { segId: a, patch: { audioFx: { voiceChanger: vc } } }); await render(`voice-${vc}`, "audio", { range: { startUs: 0, endUs: 1_000_000 } }); }
  assert.deepEqual(failures, []);
});

/** Mean Y/U/V of the 7 top SMPTE HD bars of one frame (40×40 samples per bar), via a raw yuv444p frame. */
async function barValues(file, at = "1") {
  const raw = path.join(root, `bars-${path.basename(file)}.yuv`);
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-ss", at, "-i", file, "-frames:v", "1", "-vf", "scale=1920:1080:flags=neighbor,format=yuv444p", "-f", "rawvideo", raw], { timeoutMs: 60_000 });
  const buf = fs.readFileSync(raw), W = 1920, H = 1080, plane = W * H;
  return Array.from({ length: 7 }, (_, i) => {
    const x0 = Math.round(((i + 0.5) / 7) * W * 0.75 + W * 0.125 - 20), y0 = Math.round(H * 0.25);
    const sum = [0, 0, 0]; let n = 0;
    for (let y = y0; y < y0 + 40; y++) for (let x = x0; x < x0 + 40; x++) { for (let p = 0; p < 3; p++) sum[p] += buf[p * plane + y * W + x]; n++; }
    return sum.map((v) => v / n);
  });
}

test("exports keep BT.709 colours (no BT.601 matrix shift) — plain and graded", async () => {
  const src = path.join(root, "bars709.mp4");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "smptehdbars=size=1920x1080:rate=30:duration=3", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", src], { timeoutMs: 60_000 });
  const p4 = repos.projects.create({ name: "colour", canvas: { ratio: "16:9", width: 1920, height: 1080 } });
  const { imported } = await media.importFiles(p4.id, [src]);
  const tid = p4.mainTimelineId;
  const seg = (await timeline.exec(tid, "addMedia", { mediaId: imported[0].id })).result;
  const exportOnce = async (name) => {
    const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "1080p", fps: 30, codec: "h264", bitrate: "higher", dir: root, name });
    const ev = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
    assert.equal(ev.e, "export:done", JSON.stringify(ev.error));
    return out;
  };
  const ref = await barValues(src);
  const plain = await barValues(await exportOnce("colour-plain"));
  for (let i = 0; i < 7; i++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(plain[i][c] - ref[i][c]) <= 2, `bar ${i} plane ${c}: ${plain[i][c].toFixed(1)} vs ${ref[i][c].toFixed(1)}`);
  // A neutral grade (passes through the RGB filter chain) must not shift colours either; a real grade must.
  await timeline.exec(tid, "updateSegment", { segId: seg, patch: { adjust: { curves: { master: [[0, 0], [0.5, 0.5], [1, 1]] }, contrast: 0.0001 } } });
  const neutral = await barValues(await exportOnce("colour-neutral"));
  for (let i = 0; i < 7; i++) assert.ok(Math.abs(neutral[i][0] - ref[i][0]) <= 3, `neutral grade bar ${i} luma ${neutral[i][0].toFixed(1)} vs ${ref[i][0].toFixed(1)}`);
  await timeline.exec(tid, "updateSegment", { segId: seg, patch: { adjust: { saturation: -100 } } });
  const mono = await barValues(await exportOnce("colour-mono"));
  for (const [, u, v] of mono) { assert.ok(Math.abs(u - 128) <= 2 && Math.abs(v - 128) <= 2, `mono chroma ${u},${v}`); }
  // Desaturation keeps BT.709 luma (a BT.601-weighted grey would darken the green bar 133 → ~111).
  for (let i = 0; i < 7; i++) assert.ok(Math.abs(mono[i][0] - ref[i][0]) <= 4, `mono bar ${i} luma ${mono[i][0].toFixed(1)} vs ${ref[i][0].toFixed(1)}`);
});

/** MD5 of every decoded video frame (framemd5), in order. */
async function frameHashes(file) {
  const { stdout } = await run(binaries().ffmpeg, ["-hide_banner", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { timeoutMs: 120_000 });
  return stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
}

test("a range export renders exactly the same frames as the full export (transitions, cuts, pre-roll)", async () => {
  const p6 = repos.projects.create({ name: "range", canvas: { ratio: "16:9", width: 1920, height: 1080 } });
  for (const c of [clipA, clipB]) repos.media.add(p6.id, c);
  const tid = p6.mainTimelineId;
  const segs = [];
  for (const c of [clipA, clipB, clipA]) segs.push((await timeline.exec(tid, "addMedia", { mediaId: c.id })).result);
  await timeline.exec(tid, "setTransition", { segId: segs[0], type: "dissolve", durationUs: 500_000 });
  await timeline.exec(tid, "setTransition", { segId: segs[1], type: "fade_black", durationUs: 1_000_000 });
  // ProRes is intra-only: identical input frames give identical encoded frames, so the hashes must match.
  const exportOnce = async (name, range) => {
    const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "480p", fps: 30, codec: "prores", format: "mov", range, dir: root, name });
    const ev = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
    assert.equal(ev.e, "export:done", JSON.stringify(ev.error?.details?.stderr?.slice(-600) || ev.error));
    return frameHashes(out);
  };
  const full = await exportOnce("range-full", null);
  assert.equal(full.length, 360);
  const part = await exportOnce("range-part", { startUs: 3_000_000, endUs: 9_000_000 }); // both transitions inside
  assert.equal(part.length, 180);
  const diff = part.map((h, i) => (h === full[90 + i] ? null : 90 + i)).filter((x) => x !== null);
  assert.deepEqual(diff, [], `frames that differ from the full export: ${diff.join(",")}`);
  const mid = await exportOnce("range-mid-window", { startUs: 3_900_000, endUs: 4_500_000 }); // starts inside the dissolve
  assert.deepEqual(mid, full.slice(117, 135));
});

test("a long timeline is rendered in parts and joined: no seams, full length, audio kept", async () => {
  const p7 = repos.projects.create({ name: "parts", canvas: { ratio: "16:9", width: 1920, height: 1080 } });
  for (const c of [clipA, clipB]) repos.media.add(p7.id, c);
  const tid = p7.mainTimelineId;
  for (let i = 0; i < 12; i++) await timeline.exec(tid, "addMedia", { mediaId: (i % 2 ? clipB : clipA).id }); // 48 s
  await timeline.exec(tid, "applyTransitionToAll", { type: "dissolve", durationUs: 500_000 });
  const tl = repos.timelines.get(tid);
  const parts = planSegments(tl, { fps: 30 });
  assert.ok(parts.length >= 2, "rendered in parts");
  const exportOnce = async (name, range, codec = "prores", format = "mov") => {
    const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "480p", fps: 30, codec, format, range, dir: root, name });
    const ev = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
    assert.equal(ev.e, "export:done", JSON.stringify(ev.error?.details?.stderr?.slice(-600) || ev.error));
    return out;
  };
  const whole = await exportOnce("parts-whole", null);
  const hashes = await frameHashes(whole);
  assert.equal(hashes.length, 48 * 30);
  const probe = await ffprobe(whole);
  const a = probe.streams.find((x) => x.codec_type === "audio");
  assert.ok(a && Math.abs(Number(a.duration) - 48) < 0.1, `audio ${a?.duration}`);
  // Around every join (a cut inside a dissolve window), the frames equal a single-pass render of that stretch.
  for (const p of parts.slice(1)) {
    const k = Math.round((p.startUs * 30) / 1e6);
    const near = await frameHashes(await exportOnce(`parts-seam-${k}`, { startUs: p.startUs - 1e6, endUs: p.startUs + 1e6 }));
    assert.deepEqual(near, hashes.slice(k - 30, k + 30), `frames around the join at ${k}`);
  }
  // H.264 parts join into one playable MP4 of the full length.
  const mp4 = await ffprobe(await exportOnce("parts-h264", null, "h264", "mp4"));
  const v = mp4.streams.find((x) => x.codec_type === "video");
  assert.equal(v.codec_name, "h264");
  assert.ok(Math.abs(Number(mp4.format.duration) - 48) < 0.1, `duration ${mp4.format.duration}`);
  const { stdout } = await run(binaries().ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path.join(root, "parts-h264.mp4")], { timeoutMs: 120_000 });
  assert.equal(Number(stdout.toString().trim()), 48 * 30);
});

test("8K H.264 export succeeds with hardware encoding enabled (GPU HEVC above 4096 px, else software H.264)", async () => {
  settings.set("performance", { hwEncode: true });
  const p5 = repos.projects.create({ name: "8k", canvas: { ratio: "16:9", width: 1920, height: 1080 } });
  repos.media.add(p5.id, clipA);
  const tid = p5.mainTimelineId;
  await timeline.exec(tid, "addMedia", { mediaId: clipA.id });
  const est = exporter.estimate(tid, { resolution: "8k", codec: "h264" });
  assert.equal(est.width, 7680);
  const gpuHevc = !!exporter.caps?.encoders?.has("hevc_nvenc");
  if (gpuHevc) assert.equal(est.switchedTo, "hevc"); // like CapCut: 8K goes to GPU HEVC
  else if (exporter.caps?.encoders?.has("h264_nvenc")) assert.equal(est.hwFallback, true);
  const { jobId, path: out } = exporter.start({ timelineId: tid, mode: "video", resolution: "8k", codec: "h264", fps: 30, range: { startUs: 0, endUs: 1_000_000 }, dir: root, name: "eight-k" });
  const ev = await waitFor((e) => e.jobId === jobId && (e.e === "export:done" || e.e === "export:error"));
  assert.equal(ev.e, "export:done", JSON.stringify(ev.error?.details?.stderr?.slice(-600) || ev.error));
  const v = (await ffprobe(out)).streams.find((s) => s.codec_type === "video");
  assert.equal(v.codec_name, gpuHevc ? "hevc" : "h264");
  if (gpuHevc) assert.equal(v.codec_tag_string, "hvc1"); // plays in QuickTime / browsers
  assert.equal(Number(v.width), 7680);
});
