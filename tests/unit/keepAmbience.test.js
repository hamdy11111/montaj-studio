// Kept action's own sound (the edit plan's audio.keepAmbience, honoured by the export's voice clean-up): spans are
// normalised per media, the mask cross-fades the cleaned voice with the clip's own sound, plans without the field
// build the very same graph as before, the spans are stored per timeline, and a real FFmpeg export keeps a crowd that
// the clean-up used to turn into dead air.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ambienceByMedia, keepMask, betweenWords, buildExport, AMBIENCE_RAMP_S } from "../../src/core/exportGraph.js";
import { ExportService } from "../../src/services/exportService.js";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline } from "../../src/core/model.js";
import { US } from "../../src/core/util.js";

const RNN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "services", "audio", "models", "sh.rnnn");
const caps = { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() };

/** Evaluate a gain expression written by keepMask / betweenWords at clip-local second t. */
function evalExpr(e, t) {
  const js = e.replace(/if\(isnan\(t\),0,t\)/g, "t").replace(/\bclip\(/g, "CLIP(").replace(/\bmin\(/g, "Math.min(");
  return new Function("t", "CLIP", `return ${js};`)(t, (x, a, b) => Math.min(b, Math.max(a, x)));
}

const near = (x, want, msg) => assert.ok(Math.abs(x - want) < 1e-9, msg || `${x} ≠ ${want}`);

/** One clip of `media` with the voice clean-up on. */
function cleanedTimeline(media) {
  const tl = newTimeline("p", { width: 640, height: 360 });
  const seg = ops.addMediaSegment(tl, media);
  seg.audioFx = { normalize: { enabled: false, targetLufs: -14 }, denoise: { enabled: true }, enhanceVoice: { enabled: false }, isolate: "none", voiceChanger: "none" };
  return { tl, seg };
}

test("keepAmbience spans: per media, sorted, merged, malformed ones dropped; empty → null", () => {
  const by = ambienceByMedia([
    { mediaId: "a", fromUs: 5e6, toUs: 7e6 }, { mediaId: "a", fromUs: 1e6, toUs: 2e6 }, { mediaId: "a", fromUs: 6.5e6, toUs: 8e6 },
    { mediaId: "b", fromUs: -3, toUs: 1e6 }, { mediaId: "b", fromUs: 2e6, toUs: 2e6 }, { mediaId: "", fromUs: 0, toUs: 1e6 },
    { mediaId: "c", fromUs: "x", toUs: 1e6 }, null,
  ]);
  assert.deepEqual(by, { a: [[1e6, 2e6], [5e6, 8e6]], b: [[0, 1e6]] });
  assert.equal(ambienceByMedia([]), null);
  assert.equal(ambienceByMedia(undefined), null);
});

test("the mask: 1 over a kept span, a ramp outside its edges, 0 elsewhere; the source clock follows speed and skip", () => {
  const m = keepMask([[4 * US, 6 * US]], 0, 1, 10 * US);
  near(evalExpr(m, 5), 1);
  near(evalExpr(m, 4), 1, "the span's own edge is fully kept");
  near(evalExpr(m, 3), 0);
  assert.ok(Math.abs(evalExpr(m, 4 - AMBIENCE_RAMP_S / 2) - 0.5) < 1e-9, "half way through the hand-off");
  assert.ok(Math.abs(evalExpr(m, 6 + AMBIENCE_RAMP_S / 2) - 0.5) < 1e-9);
  // A clip that starts 3 s into the source and plays at ×2: clip second 0.5 = source second 4.
  const fast = keepMask([[4 * US, 6 * US]], 3 * US, 2, 4 * US);
  near(evalExpr(fast, 0.5), 1);
  near(evalExpr(fast, 0.3), 0);
  assert.equal(keepMask([[20 * US, 21 * US]], 0, 1, 10 * US), null, "no span near this piece");
  assert.equal(keepMask(null, 0, 1, US), null);
  // The cleaned voice's share (1 − mask) under the between-words gain: the action is never lowered.
  const duck = betweenWords([[0, 2 * US], [8 * US, 9 * US]], 0, 1, 10 * US);
  for (const t of [4.2, 5, 5.8]) assert.ok(Math.abs(evalExpr(m, t) + (1 - evalExpr(m, t)) * evalExpr(duck, t) - 1) < 1e-9, `full level at ${t} s`);
});

test("export graph: without keepAmbience (or with spans elsewhere) the graph is exactly as before; with it the clip's own sound is cross-faded in", () => {
  const media = { a: { id: "a", path: "a.wav", type: "audio", durationUs: 12 * US, hasAudio: true, hasVideo: false, sampleRate: 48000 } };
  const { tl, seg } = cleanedTimeline(media.a);
  const base = { media, width: 640, height: 360, fps: 30, mode: "audio", audio: { enabled: true, format: "aac" }, caps, speech: { a: [[0, 2 * US]] }, rnnModel: "C:/m/sh.rnnn", masterGainDb: 3 };
  const before = buildExport(tl, base).graph;
  assert.equal(buildExport(tl, { ...base, keepAmbience: null }).graph, before);
  assert.equal(buildExport(tl, { ...base, keepAmbience: { other: [[0, 5 * US]] } }).graph, before, "another file's spans change nothing");
  assert.equal(buildExport(tl, { ...base, keepAmbience: { a: [[30 * US, 31 * US]] } }).graph, before, "spans outside the clip change nothing");
  assert.doesNotMatch(before, /asplit=2/);
  const g = buildExport(tl, { ...base, keepAmbience: { a: [[4 * US, 8 * US]] } }).graph;
  assert.match(g, /asplit=2\[ac\d+\]\[ar\d+\]/);
  assert.match(g, /arnndn=model='C\\:\/m\/sh\.rnnn',volume='0\.1\+0\.9\*min\(1,clip.*,volume='1-min\(1,clip/, "denoise and the between-words gain stay on the voice branch only");
  const T = "\\(0\\+if\\(isnan\\(t\\),0,t\\)\\*1\\)";
  assert.match(g, new RegExp(`\\[ar\\d+\\]volume='min\\(1,clip\\(min\\(\\(${T}-3\\.7\\)/0\\.3,\\(8\\.3-${T}\\)/0\\.3\\),0,1\\)\\)':eval=frame`), "the own sound ramps in 0.3 s before the span and out 0.3 s after it");
  assert.match(g, /amix=inputs=2:normalize=0:duration=longest:dropout_transition=0\[a\d+\]/);
  // A speed curve keeps the old chain (its source clock is not a straight line).
  Object.assign(seg, { speedMode: "curve", curvePoints: [0, 1, 1, 1] });
  assert.doesNotMatch(buildExport(tl, { ...base, keepAmbience: { a: [[4 * US, 8 * US]] } }).graph, /asplit=2\[ac/);
});

test("the export service stores a timeline's spans, an export request may bring its own, an empty list removes them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-amb-"));
  try {
    const svc = new ExportService({ repos: {}, paths: { cache: dir }, settings: { get: () => ({}) } });
    const tl = { id: "tl-1", tracks: [] };
    assert.equal(svc.voiceFor(tl).keepAmbience, undefined, "nothing stored: the export is unchanged");
    const kept = svc.setKeepAmbience("tl-1", [{ mediaId: "m", fromUs: 3e6, toUs: 5e6 }, { mediaId: "m", fromUs: 4e6, toUs: 6e6 }, { mediaId: "m", fromUs: 9, toUs: 1 }]);
    assert.deepEqual(kept, [{ mediaId: "m", fromUs: 3e6, toUs: 6e6 }]);
    assert.deepEqual(svc.voiceFor(tl).keepAmbience, { m: [[3e6, 6e6]] });
    assert.deepEqual(svc.voiceFor(tl, [{ mediaId: "x", fromUs: 0, toUs: 1e6 }]).keepAmbience, { x: [[0, 1e6]] }, "a request's own list wins");
    assert.deepEqual(svc.keepAmbience("other"), []);
    svc.setKeepAmbience("tl-1", []);
    assert.ok(!fs.existsSync(svc.ambienceFile("tl-1")));
    assert.equal(path.dirname(svc.ambienceFile("../../x")), path.join(dir, "ambience"), "the timeline id cannot leave the folder");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("export with FFmpeg: a kept crowd keeps its level (no dead air), the voice clean-up still works elsewhere", async (ctx) => {
  const { binaries, run } = await import("../../src/services/ffmpeg.js");
  const ff = binaries().ffmpeg;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-amb-"));
  try {
    // 12 s: a "voice" (a 220 Hz tone) at 0.5–2.5 s and 10–11 s, the words known there; a crowd (pink noise) at 3.5–9 s.
    const src = path.join(dir, "src.wav");
    await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "anoisesrc=d=12:c=pink:r=48000:a=0.25", "-f", "lavfi", "-i", "sine=f=220:d=12:sample_rate=48000",
      "-filter_complex", "[0:a]volume='between(t,3.5,9)':eval=frame[n];[1:a]volume='0.3*(between(t,0.5,2.5)+between(t,10,11))':eval=frame[v];[n][v]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[o]",
      "-map", "[o]", src]);
    const media = { a: { id: "a", path: src, type: "audio", durationUs: 12 * US, hasAudio: true, hasVideo: false, sampleRate: 48000 } };
    const { tl } = cleanedTimeline(media.a);
    const base = { media, width: 640, height: 360, fps: 30, mode: "audio", audio: { enabled: true, format: "flac" }, caps, speech: { a: [[0.4 * US, 2.6 * US], [9.9 * US, 11.1 * US]] }, rnnModel: fs.existsSync(RNN) ? RNN : null };
    const render = async (extra) => {
      const b = buildExport(tl, { ...base, ...extra });
      const graphFile = path.join(dir, "graph.txt");
      fs.writeFileSync(graphFile, b.graph);
      const out = await run(ff, ["-hide_banner", "-v", "error", ...b.inputs, "-filter_complex_script", graphFile, "-map", "[aout]", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
      const a = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, Math.floor(out.stdout.length / 4));
      const db = (t0, t1) => { let e = 0; const i0 = Math.round(t0 * 8000), i1 = Math.round(t1 * 8000); for (let i = i0; i < i1; i++) e += a[i] * a[i]; return 10 * Math.log10(e / (i1 - i0) + 1e-12); };
      // Dead air as the quality bench counts it: ≥ 0.6 s under −35 dB (here inside the crowd only).
      let quiet = 0, dead = 0;
      for (let t = 3.6; t < 8.9; t += 0.05) {
        if (db(t, t + 0.05) < -35) { quiet += 0.05; if (Math.abs(quiet - 0.6) < 0.025) dead++; } else quiet = 0;
      }
      return { db, dead };
    };
    const before = await render({});
    const after = await render({ keepAmbience: { a: [[3.8 * US, 8.8 * US]] } });
    const raw = await render({ speech: {}, rnnModel: null, media: { a: media.a } }); // the clip without the gain (FFT denoise only)
    const crowdBefore = before.db(4.5, 8), crowdAfter = after.db(4.5, 8);
    ctx.diagnostic(`crowd ${crowdBefore.toFixed(1)} dB → ${crowdAfter.toFixed(1)} dB; dead air ${before.dead} → ${after.dead}`);
    assert.ok(crowdAfter - crowdBefore >= 15, `the crowd is back: ${crowdBefore.toFixed(1)} → ${crowdAfter.toFixed(1)} dB`);
    assert.ok(before.dead >= 1 && after.dead === 0, `dead air ${before.dead} → ${after.dead}`);
    assert.ok(crowdAfter > raw.db(4.5, 8) - 3, "near the clip's own level");
    // Elsewhere the clean-up is unchanged: the voice, and the quiet stretch 2.6–3.4 s still lowered.
    assert.ok(Math.abs(after.db(1, 2) - before.db(1, 2)) < 0.5, "the voice is the same");
    assert.ok(Math.abs(after.db(9.3, 9.7) - before.db(9.3, 9.7)) < 1, "after the span's hand-off the gap is lowered as before");
    // Smooth hand-off: the ramp's middle sits between the two levels, no doubled sound at the edges.
    const mid = after.db(3.8 - AMBIENCE_RAMP_S / 2 - 0.03, 3.8 - AMBIENCE_RAMP_S / 2 + 0.03);
    assert.ok(mid > before.db(3.55, 3.6) && mid < crowdAfter, `hand-off at ${mid.toFixed(1)} dB`);
    assert.ok(after.db(3.82, 4.2) < crowdAfter + 1.5, "no doubled sound at the edge");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
