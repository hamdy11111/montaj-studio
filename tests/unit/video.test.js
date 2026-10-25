// The video studio without its engine: the limits (24 fps, 17k+5 frames, at most 362), "the whole remaining part"
// never cut short in silence, the output size, the prompt, the generation and enhancement graphs (ComfyUI's own nodes
// and the app's, nothing third-party), sources, the plan, refusals, the library and its files.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateSettings, resolveFrames, outputDimensions, buildPrompt, buildGenerateGraph, buildEnhanceGraph, enhanceDimensions, snapFrames, MAX_FRAMES,
} from "../../src/services/video/graphs.js";
import { composeDescription } from "../../src/services/video/presets.js";
import { MODEL_SETS } from "../../src/services/video/catalog.js";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";

const CORE_OR_OURS = new Set(["LoadVideo", "GetVideoComponents", "CheckpointLoaderSimple", "CLIPTextEncode", "SAM3_Detect", "ImageInvert", "ImageCompositeMasked",
  "ImageScaleToTotalPixels", "UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly", "LoadImage", "AudioAdjustVolume", "MiniMaxH3ReferenceToVideo", "BasicGuider",
  "RandomNoise", "KSamplerSelect", "BasicScheduler", "SamplerCustomAdvanced", "MontajFreeModels", "VAEDecode", "CreateVideo", "SaveVideo", "ResizeImageMaskNode",
  "SeedVR2Preprocess", "VAEEncodeTiled", "SeedVR2TemporalChunk", "SeedVR2Conditioning", "KSampler", "SeedVR2TemporalMerge", "VAEDecodeTiled", "SeedVR2PostProcessing", "ImageBlend"]);

test("frames: 17k+5 at 24 fps, at most 362; a preset that does not fit is refused, the whole part is capped and says so", () => {
  assert.equal(snapFrames(362), 362);
  assert.equal(snapFrames(361), 345);
  assert.equal(snapFrames(4), 5);
  const s = generateSettings({ durationMode: "preset", frames: 107 });
  assert.deepEqual(resolveFrames(s, 10), { frames: 107, leftOut: 0 });
  assert.throws(() => resolveFrames(generateSettings({ frames: 107, start: 6 }), 10), (e) => e.messageKey === "err.videoTooShort");
  // 13.047 s from 0 → 313 frames available → 311 (the source's own example).
  assert.equal(resolveFrames(generateSettings({ durationMode: "full" }), 13.047).frames, 311);
  // A 60 s source: 362 frames (15.08 s), and 44.9 s are reported as left out — never a silent cut.
  const full = resolveFrames(generateSettings({ durationMode: "full" }), 60);
  assert.equal(full.frames, MAX_FRAMES);
  assert.ok(full.leftOut > 44 && full.leftOut < 45.5, String(full.leftOut));
  // A range: from start to its end.
  assert.equal(resolveFrames(generateSettings({ durationMode: "range", start: 2 }), 60, 7).frames, snapFrames(120));
  assert.throws(() => resolveFrames(generateSettings({ durationMode: "full", start: 9.9 }), 10), (e) => e.messageKey === "err.videoSegmentShort");
  assert.throws(() => generateSettings({ frames: 100 }), (e) => e.messageKey === "err.videoSetting");
  assert.throws(() => generateSettings({ megapixels: 2 }), (e) => e.messageKey === "err.videoSetting");
  assert.throws(() => generateSettings({ hacker: 1 }), (e) => e.messageKey === "err.videoSetting");
});

test("output size keeps the ratio in multiples of 32; the prompt follows the choices", () => {
  assert.deepEqual(outputDimensions(1080, 1920, 0.98), [768, 1344]); // the source's own example
  assert.deepEqual(enhanceDimensions(768, 1344, 1080), [1080, 1890]);
  assert.throws(() => enhanceDimensions(768, 4000, 2160), (e) => e.messageKey === "err.videoEnhanceTooBig");
  const p = buildPrompt({ promptStyle: "cartoon", characterNotes: "red scarf", instructions: "slow", sound: false }, 3);
  assert.match(p, /illustrated cartoon/);
  assert.match(p, /<Picture 2>, <Picture 3> provide additional views/);
  assert.match(p, /Character details: red scarf/);
  assert.match(p, /Scene direction: slow/);
  assert.doesNotMatch(p, /<Audio 1>/);
  assert.match(buildPrompt({ promptStyle: "reference", characterNotes: "", instructions: "", sound: true }, 1), /<Audio 1>: fully_copy/);
  const d = composeDescription({ scene: "talking", style: "realistic", priorities: ["lighting", "outfit"] });
  assert.equal(d.promptStyle, "realistic");
  assert.match(d.instructions, /mouth shapes/);
  assert.match(d.instructions, /light direction/);
  assert.match(d.characterNotes, /outfit colors/);
});

test("graphs use ComfyUI's own nodes and the app's only; turbo, sound and references wire as asked", () => {
  const base = { video: "v.mp4", images: ["a.png", "b.png"], frames: 107, width: 1080, height: 1920, hasAudio: true, prefix: "montaj/x" };
  const g = buildGenerateGraph({ ...base, settings: { sound: true, steps: 25, seed: 7 } });
  for (const n of Object.values(g.graph)) assert.ok(CORE_OR_OURS.has(n.class_type), n.class_type);
  const h3 = g.graph["20"].inputs;
  assert.equal(h3.length, 107);
  assert.deepEqual([h3.width, h3.height], [768, 1344]);
  assert.deepEqual(h3["ref_images.ref_image_1"], ["15", 0]);
  assert.deepEqual(h3["ref_audios.ref_audio_0"], ["17", 0]);
  assert.equal(g.graph["24"].inputs.steps, 25);
  assert.equal(g.graph["22"].inputs.noise_seed, 7);
  assert.ok(!g.graph["30"]);
  const t = buildGenerateGraph({ ...base, hasAudio: false, settings: { turbo: true, turboSteps: 6, turboStrength: 0.8 } });
  assert.deepEqual(t.graph["21"].inputs.model, ["30", 0]);
  assert.equal(t.graph["24"].inputs.steps, 6);
  assert.equal(t.graph["30"].inputs.strength_model, 0.8);
  assert.equal(t.sound, false, "a silent source makes a silent result");
  assert.ok(!t.graph["17"] && !t.graph["28"].inputs.audio && !t.graph["20"].inputs["ref_audios.ref_audio_0"]);
  const e = buildEnhanceGraph({ video: "r.mp4", width: 768, height: 1344, hasAudio: true, settings: { chunkFrames: 0, color: "wavelet", strength: 0.5 }, prefix: "montaj/e" });
  for (const n of Object.values(e.graph)) assert.ok(CORE_OR_OURS.has(n.class_type), n.class_type);
  assert.equal(e.graph["8"].inputs.chunking_mode, "auto");
  assert.equal(e.graph["13"].inputs.color_correction_method, "wavelet");
  assert.equal(e.graph["14"].inputs.blend_factor, 0.5);
  assert.deepEqual(e.graph["15"].inputs.audio, ["2", 1]);
});

test("the catalog: every file pinned to a revision with its size and hash; MiniMax H3 asks for its licence", () => {
  for (const s of MODEL_SETS) for (const f of s.files) {
    assert.match(f.url, /^https:\/\/huggingface\.co\/Comfy-Org\/[^/]+\/resolve\/[0-9a-f]{40}\//);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.size > 1e8);
  }
  assert.ok(MODEL_SETS.find((s) => s.id === "h3").accept?.key);
  assert.ok(MODEL_SETS.find((s) => s.id === "h3turbo").accept?.key === MODEL_SETS.find((s) => s.id === "h3").accept.key);
  assert.ok(!MODEL_SETS.find((s) => s.id === "seedvr2").accept);
});

let S, root;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-video-"));
  S = await createServices({ root, notify: () => {} });
});
after(() => { closeDatabase({ shutdown: true }); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("sources, the plan and its refusals; nothing starts an engine; a licence must be accepted before a download", async () => {
  const ff = binaries().ffmpeg;
  const vid = path.join(root, "clip.mp4"), silent = path.join(root, "silent.mp4"), img = path.join(root, "face.png");
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", vid], { timeoutMs: 60_000 });
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent], { timeoutMs: 60_000 });
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:size=256x256", "-frames:v", "1", img], { timeoutMs: 60_000 });
  const v = await S.video.addSource(vid), q = await S.video.addSource(silent), i = await S.video.addSource(img);
  assert.equal(v.kind, "video"); assert.equal(i.kind, "image"); assert.ok(v.hasAudio); assert.ok(!q.hasAudio);
  assert.ok(fs.existsSync(v.thumb), "a picture for the source");
  assert.notEqual(v.file, vid, "the studio keeps its own copy");
  const p = S.video.plan({ source: v.id, refs: [i.id], settings: { durationMode: "full", start: 1 } });
  assert.equal(p.frames, snapFrames(120)); // 5 s left → 120 frames → 107
  assert.ok(p.leftOut > 0.5, "what is left out is said");
  assert.deepEqual([p.width, p.height], outputDimensions(640, 360, 0.98));
  assert.throws(() => S.video.plan({ source: q.id, refs: [i.id], settings: { sound: true } }), (e) => e.messageKey === "err.videoNoSound");
  assert.throws(() => S.video.plan({ source: v.id, refs: [], settings: {} }), (e) => e.messageKey === "err.videoRefs");
  assert.throws(() => S.video.plan({ source: v.id, refs: [i.id, i.id], settings: {} }), (e) => e.messageKey === "err.videoRefs");
  assert.throws(() => S.video.plan({ source: v.id, refs: [i.id], settings: { frames: 243 } }), (e) => e.messageKey === "err.videoTooShort");
  assert.throws(() => S.video.plan({ source: i.id, refs: [i.id], settings: {} }), (e) => e.messageKey === "err.videoSourceType");
  await assert.rejects(S.video.addSource(path.join(root, "nope.txt")), (e) => e.messageKey === "err.fileNotFound");
  assert.throws(() => S.videoSetup.download("h3"), (e) => e.messageKey === "err.licenseNotAccepted");
  const st = await S.videoSetup.accept("h3");
  assert.ok(st.sets.find((x) => x.id === "h3turbo").accepted, "one acceptance covers the licence's sets");
  assert.equal(S.video.status().engine.running, false);
  // A job without the runtime fails clearly (and is received at once, never twice).
  const j = S.video.submit({ kind: "generate", source: v.id, refs: [i.id], settings: { durationMode: "full" }, title: "تجربة" });
  assert.equal(j.state, "queued");
  assert.throws(() => S.video.submit({ kind: "generate", source: v.id, refs: [i.id], settings: {} }), (e) => e.messageKey === "err.videoBusy");
  for (let k = 0; k < 100 && S.video.jobsList()[0].state !== "failed"; k++) await new Promise((r) => setTimeout(r, 50));
  const failed = S.video.jobsList()[0];
  assert.equal(failed.state, "failed");
  assert.ok(["err.videoNotReady", "err.engineRam", "err.engineVram"].includes(failed.error.messageKey), failed.error.messageKey);
});

test("a result in the library: versions, thumbnail, inputs kept, save as MP4, into a project, favourite, delete", async () => {
  const ff = binaries().ffmpeg;
  const v = S.video.sources().find((x) => x.kind === "video"), i = S.video.sources().find((x) => x.kind === "image");
  const fake = path.join(root, "out.mp4"), cut = path.join(root, "cut.mp4");
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=768x432:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", fake], { timeoutMs: 60_000 });
  fs.copyFileSync(fake, cut);
  const j = { group: "g1", title: "بطل", req: {}, stages: [] };
  const a = await S.video.addResult(j, fake, { kind: "generate", engine: "MiniMax H3", settings: { seed: 1 }, seed: 1, frames: 48, seconds: 2, source: { id: v.id, name: v.name, start: 0, frames: 48, cut }, refs: [{ id: i.id, name: i.name, file: i.file }] });
  assert.equal(a.meta.n, 1);
  assert.match(a.name, /بطل · نسخة 1/);
  assert.ok(fs.existsSync(a.meta.thumb) && fs.existsSync(a.meta.source.copy) && fs.existsSync(a.meta.refs[0].copy));
  assert.ok(fs.existsSync(path.join(path.dirname(a.path), "report.json")));
  const fake2 = path.join(root, "out2.mp4");
  fs.copyFileSync(cut, fake2);
  const b = await S.video.addResult({ ...j, req: { parent: a.id } }, fake2, { kind: "enhance", engine: "SeedVR2 3B", settings: {}, seed: 42, source: a.meta.source, refs: a.meta.refs });
  assert.equal(b.meta.n, 2); assert.equal(b.meta.parent, a.id); assert.match(b.name, /محسّنة/);
  assert.equal(S.video.library({ group: "g1" }).length, 2);
  const saved = await S.video.saveAs(a.id, path.join(root, "حفظ"));
  assert.ok(saved.path.endsWith(".mp4")); assert.equal(saved.codec, "h264");
  const p = S.projects.create({ name: "video test" });
  const m = await S.video.addToProject(a.id, p.id);
  assert.equal((await S.video.addToProject(a.id, p.id)).id, m.id, "added once");
  S.video.favorite(a.id, true);
  assert.equal(S.video.library({ favorite: true }).length, 1);
  assert.equal(S.video.library({ search: "بطل" }).length, 2);
  // Deleting a result a project uses keeps the file for that project.
  const r = S.video.remove(a.id);
  assert.equal(r.keptFile, true); assert.ok(fs.existsSync(a.path));
  const r2 = S.video.remove(b.id);
  assert.equal(r2.keptFile, false); assert.ok(!fs.existsSync(b.path));
});

test("the user's own template: found through switches and its regex steps in order; filled like the original studio", async () => {
  const { extractPromptTemplate, templatePrompt } = await import("../../src/services/video/graphs.js");
  const wf = {
    1: { class_type: "PrimitiveStringMultiline", inputs: { value: "subject_definitions:\n<Video 1> is the source clip; x\n\noverall_soundscape:\nNatural ambience and physical sounds matching the source clip. No invented dialogue.\n<Audio 1> keep" } },
    2: { class_type: "Any Switch (rgthree)", inputs: { any_02: ["1", 0] } },
    3: { class_type: "RegexReplace", inputs: { string: ["2", 0], regex_pattern: "a", replace: "b", case_insensitive: true, multiline: true, dotall: false, count: 0 } },
    4: { class_type: "RegexReplace", inputs: { string: ["3", 0], regex_pattern: "c", replace: "d", count: 1 } },
    5: { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: ["4", 0] } },
  };
  const t = extractPromptTemplate(wf);
  assert.deepEqual(t.steps.map((s) => s.regex_pattern), ["a", "c"]);
  const p = templatePrompt(t.text, { characterNotes: "n", instructions: "", sound: false }, 2);
  assert.match(p, /<Picture 2> show additional views/);
  assert.match(p, /User-specified character details: n\n\noverall_soundscape:/);
  assert.doesNotMatch(p, /<Audio 1>/);
  assert.match(p, /overall_soundscape:\nN\/A/);
  assert.throws(() => extractPromptTemplate({ nodes: [] }), (e) => e.messageKey === "err.videoTemplateFormat");
  assert.throws(() => extractPromptTemplate({ 1: { class_type: "KSampler", inputs: {} } }), (e) => e.messageKey === "err.videoTemplateNone");
  const g = buildGenerateGraph({ video: "v", images: ["a"], frames: 22, width: 640, height: 360, hasAudio: true, settings: { promptStyle: "original" }, prefix: "p", template: t });
  assert.deepEqual(g.graph["20"].inputs.prompt, ["41", 0]);
  assert.equal(g.graph["41"].inputs.count, 1);
  assert.throws(() => buildGenerateGraph({ video: "v", images: ["a"], frames: 22, width: 640, height: 360, hasAudio: true, settings: { promptStyle: "original" }, prefix: "p" }), (e) => e.messageKey === "err.videoNoTemplate");
});
