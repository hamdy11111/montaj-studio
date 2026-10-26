// Music under speech (core/musicBed.js, services/musicBedService.js energyVad) and its export filter: the preview's
// curve and the export's expression are the same numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline, newSegment, newTrack, findSegment } from "../../src/core/model.js";
import { buildExport } from "../../src/core/exportGraph.js";
import { musicRole, duckDbOf, isMusicTrack, speechSpans, duckCover, duckGainAt, duckExpr, bedLevelDb, bedPlacement, editExtent, placeMusicBed, setMusicDuck, DUCK, DUCK_DEFAULT_DB } from "../../src/core/musicBed.js";
import { energyVad } from "../../src/services/musicBedService.js";

const S = 1_000_000;
const video = { id: "v", path: "v.mp4", type: "video", durationUs: 60 * S, width: 1920, height: 1080, hasAudio: true, hasVideo: true };
const song = { id: "m", path: "song.wav", type: "audio", durationUs: 200 * S, hasAudio: true, hasVideo: false };

/** Evaluate an FFmpeg volume expression (the subset duckExpr writes) at clip-local second t. */
function evalVolume(filter, t) {
  const body = /^volume='(.*)':eval=frame$/.exec(filter)[1];
  const js = body.replace(/\bclip\(/g, "CLIP(").replace(/\bmin\(/g, "Math.min(").replace(/\bT\b/g, "t");
  return new Function("t", "CLIP", `return ${js};`)(t, (x, a, b) => Math.min(b, Math.max(a, x)));
}

test("music roles: the duck amount lives in the track role", () => {
  assert.equal(musicRole(), "music");
  assert.equal(musicRole(18), "music:18");
  assert.equal(musicRole(0), "music:0");
  assert.equal(duckDbOf({ role: "music" }), DUCK_DEFAULT_DB);
  assert.equal(duckDbOf({ role: "music:6" }), 6);
  assert.equal(duckDbOf({ role: "behind" }), null);
  assert.equal(duckDbOf({ role: "" }), null);
  assert.ok(isMusicTrack({ role: "music:0" }) && !isMusicTrack({ role: "dub:x:bg" }));
});

test("speech spans: source words mapped through cuts and speed, music and muted tracks ignored, short pauses bridged", () => {
  const tl = newTimeline("p");
  ops.addMediaSegment(tl, video);
  const main = tl.tracks.find((t) => t.isMain);
  // Two cuts of the same file: 0–10 s (speed 1) and 30–50 s at 2x placed at 10 s.
  main.segments = [Object.assign(main.segments[0], { start: 0, duration: 10 * S, sourceStart: 0, sourceDuration: 10 * S }),
    Object.assign(newSegment("video", { mediaId: "v" }), { start: 10 * S, duration: 10 * S, sourceStart: 30 * S, sourceDuration: 20 * S, speed: 2 })];
  const regions = { v: [[1 * S, 2 * S], [2.5 * S, 3 * S], [8 * S, 12 * S], [34 * S, 36 * S]], m: [[0, 200 * S]] };
  placeMusicBed(tl, song, {});
  const spans = speechSpans(tl, regions);
  // 1–2 and 2.5–3 joined (0.5 s pause < bridge); 8–10 (cut at the clip's end); 34–36 s at 2x from 30 s → 12–13 s.
  assert.deepEqual(spans, [[1 * S, 3 * S], [8 * S, 10 * S], [12 * S, 13 * S]]);
  assert.deepEqual(speechSpans(tl, regions, { bridgeUs: 0 }).slice(0, 2), [[1 * S, 2 * S], [2.5 * S, 3 * S]]);
  main.segments[1].disabled = true;
  assert.deepEqual(speechSpans(tl, regions).at(-1), [8 * S, 10 * S]);
  // A dub's voice clips are speech as a whole.
  const voice = newTrack("audio", { order: 5, role: "dub:v:voice:en" });
  voice.segments.push(Object.assign(newSegment("audio", { mediaId: "tts" }), { start: 20 * S, duration: 2 * S }));
  tl.tracks.push(voice);
  assert.deepEqual(speechSpans(tl, regions).at(-1), [20 * S, 22 * S]);
});

test("duck curve: down by the amount under words, ramps over attack and release, export expression = preview gain", () => {
  const spans = [[2 * S, 4 * S], [10 * S, 11 * S]];
  const low = 10 ** (-12 / 20);
  assert.equal(duckGainAt(spans, 0, 12), 1);
  assert.ok(Math.abs(duckGainAt(spans, 3 * S, 12) - low) < 1e-9);
  assert.ok(Math.abs(duckCover(spans, 2 * S - DUCK.attackUs / 2) - 0.5) < 1e-9, "half-way through the attack");
  assert.ok(Math.abs(duckCover(spans, 4 * S + DUCK.releaseUs / 2) - 0.5) < 1e-9, "half-way through the release");
  assert.equal(duckGainAt(spans, 3 * S, 0), 1, "0 dB: no ducking");
  // A clip that starts at 1 s and lasts 12 s: its local expression gives the same gain at every point.
  const f = duckExpr(spans, 1 * S, 12 * S, "T", 12);
  for (let t = 0; t <= 12; t += 0.05) assert.ok(Math.abs(evalVolume(f, t) - duckGainAt(spans, 1 * S + t * S, 12)) < 2e-3, `t=${t}`);
  assert.equal(duckExpr(spans, 20 * S, 5 * S, "T", 12), null, "no speech near the clip");
});

test("bed level and placement", () => {
  assert.equal(bedLevelDb({ musicLufs: -14, speechLufs: -20 }), -22);
  assert.equal(bedLevelDb({ musicLufs: -30, speechLufs: -16 }), -2);
  assert.equal(bedLevelDb({ musicLufs: NaN, speechLufs: -16 }), -18);
  const tl = newTimeline("p");
  ops.addMediaSegment(tl, video);
  assert.deepEqual(editExtent(tl), { startUs: 0, endUs: 60 * S });
  const p = bedPlacement(tl, { mediaDurationUs: 200 * S });
  assert.deepEqual([p.start, p.duration, p.fadeInUs, p.fadeOutUs], [0, 60 * S, 1.5 * S, 3 * S]);
  const shortSong = bedPlacement(tl, { mediaDurationUs: 25 * S, offsetUs: 5 * S, fromUs: 10 * S });
  assert.deepEqual([shortSong.start, shortSong.duration, shortSong.sourceStart], [10 * S, 20 * S, 5 * S]);
  assert.equal(bedPlacement(tl, { mediaDurationUs: 0.5 * S }), null);
});

test("placing a bed and switching ducking keep the timeline valid", () => {
  const tl = newTimeline("p");
  ops.addMediaSegment(tl, video);
  const id = placeMusicBed(tl, song, { volumeDb: -20 });
  const f = findSegment(tl, id);
  assert.equal(f.track.role, "music");
  assert.equal(f.segment.volumeDb, -20);
  assert.equal(ops.validateTimeline(tl).length, 0);
  assert.equal(setMusicDuck(tl, id, 6), 6);
  assert.equal(findSegment(tl, id).track.role, "music:6");
  assert.equal(setMusicDuck(tl, id, null), null);
  assert.equal(findSegment(tl, id).track.role, "");
  // A sound sharing its track with another one moves to its own music track.
  const t2 = newTrack("audio", { order: 9 });
  const a = Object.assign(newSegment("audio", { mediaId: "m" }), { start: 0, duration: 5 * S });
  const b = Object.assign(newSegment("audio", { mediaId: "m" }), { start: 6 * S, duration: 5 * S });
  t2.segments.push(a, b);
  tl.tracks.push(t2);
  setMusicDuck(tl, b.id, 12);
  assert.equal(findSegment(tl, a.id).track.role, "");
  assert.equal(findSegment(tl, b.id).track.role, "music");
  assert.notEqual(findSegment(tl, a.id).track, findSegment(tl, b.id).track);
  assert.throws(() => setMusicDuck(tl, tl.tracks.find((t) => t.isMain).segments[0].id, 12), /musicBedMedia/);
  assert.equal(ops.validateTimeline(tl).length, 0);
});

test("export: a music bed's clip gets the duck filter, other sounds do not", () => {
  const tl = newTimeline("p");
  ops.addMediaSegment(tl, video);
  placeMusicBed(tl, song, { volumeDb: -18 });
  const media = { v: video, m: song };
  const spans = [[2 * S, 4 * S]];
  const { graph } = buildExport(tl, { media, width: 1920, height: 1080, fps: 30, mode: "audio", audio: { enabled: true, format: "aac" }, musicBed: { spans } });
  const lines = graph.split(";\n").filter((l) => /volume='1-0\.7488\*min\(1,clip/.test(l));
  assert.equal(lines.length, 1, "one chain ducks");
  const without = buildExport(tl, { media, width: 1920, height: 1080, fps: 30, mode: "audio", audio: { enabled: true, format: "aac" } }).graph;
  assert.doesNotMatch(without, /0\.7488/);
});

test("voice activity fallback: tone bursts in noise", () => {
  const rate = 8000, x = new Float32Array(rate * 6);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.002;
  for (const [a, b] of [[1, 2], [2.1, 2.6], [4, 4.05], [4.5, 5.5]]) for (let i = a * rate; i < b * rate; i++) x[i] += 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
  const v = energyVad(x, rate).map(([a, b]) => [Math.round(a / 1e4) / 100, Math.round(b / 1e4) / 100]);
  // 1–2 and 2.1–2.6 joined (100 ms gap), the 50 ms blip dropped, 4.5–5.5 kept; 80 ms padding.
  assert.deepEqual(v, [[0.92, 2.68], [4.42, 5.58]]);
});

test("export with FFmpeg: the music is 12 dB lower under speech and back between phrases", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { binaries, run } = await import("../../src/services/ffmpeg.js");
  const ff = binaries().ffmpeg;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-bed-"));
  try {
    const tone = path.join(dir, "tone.wav");
    await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-ac", "2", tone]);
    const music = { id: "m", path: tone, type: "audio", durationUs: 8 * S, hasAudio: true, hasVideo: false, sampleRate: 48000 };
    const tl = newTimeline("p");
    placeMusicBed(tl, music, { volumeDb: 0, fromUs: 0, toUs: 8 * S });
    const seg = tl.tracks.find((t) => isMusicTrack(t)).segments[0];
    Object.assign(seg, { fadeInUs: 0, fadeOutUs: 0 });
    const b = buildExport(tl, { media: { m: music }, width: 1920, height: 1080, fps: 30, mode: "audio", audio: { enabled: true, format: "flac" }, musicBed: { spans: [[3 * S, 5 * S]] } });
    const graphFile = path.join(dir, "graph.txt");
    fs.writeFileSync(graphFile, b.graph);
    const out = await run(ff, ["-hide_banner", "-v", "error", ...b.inputs, "-filter_complex_script", graphFile, "-map", "[aout]", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
    const buf = out.stdout;
    const a = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    const rmsDb = (t0, t1) => { let e = 0; const i0 = Math.round(t0 * 8000), i1 = Math.round(t1 * 8000); for (let i = i0; i < i1; i++) e += a[i] * a[i]; return 10 * Math.log10(e / (i1 - i0)); };
    const between = rmsDb(1, 2), under = rmsDb(3.4, 4.6), after = rmsDb(6, 7);
    assert.ok(Math.abs(under - between + 12) < 0.5, `ducked by ${(between - under).toFixed(2)} dB`);
    assert.ok(Math.abs(after - between) < 0.5, "back after the release");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
