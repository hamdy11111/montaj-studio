// Person matte with the real local model (MediaPipe Selfie Multiclass through python): the mask video has the
// media's frame count and aspect, made in parallel parts; a failed GPU part is redone on the CPU. Skipped when
// python with mediapipe/opencv is not installed (Settings › Providers › Python).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MatteService } from "../../src/services/matteService.js";
import { binaries, run, ffprobe } from "../../src/services/ffmpeg.js";
import { decodeRecipes } from "../../src/services/fastDecode.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-matte-e2e-"));
const clip = path.join(root, "clip.mp4");
const media = { id: "m1", type: "video", path: clip, width: 640, height: 360, fps: 30, durationUs: 9_000_000, proxyPath: null };
const logs = [];
const svc = new MatteService({ repos: { media: { get: () => media } }, paths: { cache: root }, settings: { get: () => ({ pythonPath: process.env.MONTAJ_PYTHON || "" }) }, log: (...a) => logs.push(a.join(" ")) });
let skip = null;

before(async () => {
  const st = await svc.status();
  if (!st.available) { skip = `person matte unavailable: ${st.error}`; return; }
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=9", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { timeoutMs: 60_000 });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the matte has the media's frames and aspect; parts are joined; progress reaches 1", async (t) => {
  if (skip) return t.skip(skip);
  const seen = [];
  const file = await svc.ensure("m1", { onProgress: (p) => seen.push(p) });
  assert.ok(svc.ready("m1") && fs.existsSync(file));
  const info = await ffprobe(file);
  const v = info.streams.find((s) => s.codec_type === "video");
  assert.equal(v.width / v.height, 640 / 360);
  const frames = (await run(binaries().ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { timeoutMs: 60_000 })).stdout.toString().trim();
  assert.equal(Number(frames), 270, "one mask frame per media frame at 30 fps");
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(logs.some((l) => /matte ready m1 270 frames, \d workers/.test(l)), logs.join("\n"));
  assert.ok(!fs.readdirSync(path.join(root, "mattes")).some((f) => f.startsWith("tmp-")), "temporary parts removed");
  assert.equal(await svc.ensure("m1"), file, "cached");
});

test("a part whose GPU decode fails is made again on the CPU", async (t) => {
  if (skip) return t.skip(skip);
  fs.rmSync(svc.file("m1"));
  const key = [...decodeRecipes.keys()].find((k) => k.startsWith(clip));
  // A GPU recipe that cannot work (bad filter): every GPU part fails and must fall back.
  decodeRecipes.set(key, { gpu: true, pre: [], vf: "no_such_filter", cpu: { gpu: false, pre: [], vf: "scale=640:360", cpu: null } });
  const file = await svc.ensure("m1");
  assert.ok(fs.existsSync(file));
  assert.ok(logs.some((l) => l.startsWith("matte: GPU decode failed, CPU for this part")), logs.join("\n"));
});
