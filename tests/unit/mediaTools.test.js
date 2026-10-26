// Image tools and the pro matte: prompt cleaning (no Arabic drawn by a model), sizes, the ComfyUI graphs' wiring,
// the GPU memory sampler, the matte recipe choice and file names, and object-track smoothing (no models run).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanPrompt, sizeFor, qwenGraph, zimageGraph, samDetectGraph, NO_TEXT, MODELS } from "../../src/services/imagegen/graphs.js";
import { gpuSampler } from "../../src/services/imagegenService.js";
import { MatteService, smoothTrack } from "../../src/services/matteService.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-mediatools-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("prompts: Arabic script is removed (no model writes it), 'no text' is asked, transparency phrased for Qwen", () => {
  const p = cleanPrompt("A shop sign that says «مطبخ ماما» above a door");
  assert.ok(!/[؀-ۿ]/.test(p));
  assert.ok(p.includes(NO_TEXT));
  assert.ok(!/«|»/.test(p), "the empty quotes go too");
  const t = cleanPrompt("a cartoon pot", { transparent: true });
  assert.match(t, /RGBA image with an alpha channel/);
  assert.equal(cleanPrompt("x, no text at all").match(/no text/g).length, 1, "not asked twice");
  assert.throws(() => cleanPrompt("حلة بتغلي"), /empty prompt/);
  const sign = cleanPrompt("A shop sign that says «مطبخ ماما» above a door");
  assert.ok(!/says/.test(sign), "the words introducing the writing go too (the model would write them)");
  assert.match(sign, /^A shop sign above a door\. Every sign, label, screen and surface is blank/);
  const up = cleanPrompt("A street with a small restaurant. Above the door hangs a sign displaying Arabic calligraphy in gold. Warm light.", { blankSigns: true });
  assert.ok(!/calligraphy/.test(up), "a sentence about writing is dropped");
  assert.match(up, /^A street with a small restaurant\. Warm light\. Every sign/);
});

test("sizes: multiples of 32 near the aspect at ~1 MP; portrait stays portrait", () => {
  const v = sizeFor(1080, 1920);
  assert.ok(v.height > v.width && v.width % 32 === 0 && v.height % 32 === 0);
  assert.ok(Math.abs(v.width * v.height - 1024 * 1024) < 0.06e6);
  assert.deepEqual(sizeFor(1024, 1024), { width: 1024, height: 1024 });
});

test("graphs: Qwen text→image samples an empty latent; an edit samples the first reference's latent; Z-Image wiring", () => {
  const g = qwenGraph({ prompt: "p", width: 768, height: 1344, seed: 3 });
  assert.equal(g["1"].inputs.unet_name, MODELS.qwen.unet);
  assert.deepEqual(g["11"].inputs.latent_image, ["6", 0]);
  assert.equal(g["7"].inputs.cfg, 1);
  assert.equal(g["9"].inputs.sigmas.split(",").length, 9, "8 turbo steps");
  const e = qwenGraph({ prompt: "p", images: ["a.png", "b.png"] });
  assert.equal(e["6"], undefined);
  assert.deepEqual(e["11"].inputs.latent_image, ["5", 2]);
  assert.deepEqual(e["5"].inputs["images.image_2"], ["L1", 0]);
  const z = zimageGraph({ prompt: "p", width: 1024, height: 576, seed: 1 });
  assert.equal(z["8"].inputs.steps, 8);
  assert.equal(z["3"].inputs.type, "lumina2");
  assert.deepEqual(z["8"].inputs.negative, ["6", 0]);
  const s = samDetectGraph({ image: "f.png", concept: "person:4" });
  assert.equal(s["4"].class_type, "SAM3_Detect");
  assert.equal(s["3"].inputs.text, "person:4");
});

test("GPU sampler: baseline and peak from the reader", async () => {
  const values = [1000, 1500, 4200, 3000];
  let i = 0;
  const s = gpuSampler(5, () => values[Math.min(i++, values.length - 1)]);
  await new Promise((r) => setTimeout(r, 40));
  const m = s.stop();
  assert.equal(m.baseMiB, 1000);
  assert.equal(m.peakMiB, 4200);
  assert.equal(m.deltaMiB, 3200);
});

test("matte recipe: fast/pro/auto choose the file; the fast one keeps its name", () => {
  let quality = "fast";
  const settings = { get: (s) => (s === "media" ? { matteQuality: quality } : { pythonPath: "" }) };
  const m = new MatteService({ repos: {}, paths: { root: dir, cache: dir }, settings });
  assert.match(m.file("abc"), /abc-v2\.mp4$/);
  assert.match(m.file("abc", "stab"), /abc-stab-v2\.mp4$/);
  quality = "pro";
  assert.match(m.file("abc"), /abc-pro1\.mp4$/);
  assert.equal(m.ready("abc"), false);
  fs.writeFileSync(m.fastFile("abc"), "fast");
  m.keepFastAsPro(m.fastFile("abc"), "abc");
  assert.equal(m.ready("abc"), false, "a fast matte under the pro name does not count when pro is asked");
  fs.rmSync(`${m.proFile("abc")}.fast`);
  assert.equal(m.ready("abc"), true);
  quality = "auto";
  m.proRuntime = () => null; m.proCheck = null;
  assert.equal(m.wantPro(), false, "auto without the pro runtime → fast");
  m.proRuntime = () => ({}); m.proCheck = null;
  assert.equal(m.wantPro(), true);
});

test("object track smoothing: holds through misses, damps jitter, follows real motion", () => {
  const f = (t, cx, area = 0.1) => [t, cx - 0.05, 0.4, cx + 0.05, 0.6, cx, 0.5, area];
  const jitter = [f(0, 0.5), f(0.1, 0.52), f(0.2, 0.48), f(0.3, 0.52), f(0.4, 0.48)];
  const s = smoothTrack(jitter);
  const spread = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(spread(s.map((x) => x[5])) < spread(jitter.map((x) => x[5])) * 0.6, "jitter damped");
  const miss = smoothTrack([f(0, 0.3), [0.1, 0, 0, 0, 0, 0, 0, 0], f(0.2, 0.3)]);
  assert.equal(miss[1][5], 0.3, "a missed frame holds the last position");
  assert.equal(miss[1][7], 0, "and says it was not seen");
  const move = smoothTrack(Array.from({ length: 20 }, (_, i) => f(i * 0.1, 0.1 + i * 0.04)));
  assert.ok(Math.abs(move.at(-1)[5] - 0.86) < 0.08, "a steady move is followed closely");
});
