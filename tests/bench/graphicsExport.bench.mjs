// Export speed: today's canvas graphics (PNG per frame state → FFmpeg image sequences) against the Remotion layer
// (one transparent ProRes clip per graphic), in the real app, on a 1080×1920 30 s video. Three projects: no graphics
// (the floor), 10 canvas graphics of 3 s, 10 kit graphics of 3 s (the whole 30 s covered — the worst case), each
// exported to H.264 1080p through export.start; the Remotion one twice (cold, then with the clip cache warm).
// Run: node tests/bench/graphicsExport.bench.mjs [outDir]   (needs npm run setup:graphics && npm run build:graphics)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2] || path.join(APP, "tests", "e2e", "artifacts");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-gfx-bench-"));
const media = path.join(ud, "v.mp4"), exportDir = path.join(ud, "exports");
fs.mkdirSync(exportDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const CANVAS = ["title-reveal", "lower-third", "list-item", "checklist", "counter", "callout", "highlight-box", "emoji", "icon-badge", "big-word"];
const KIT = [["kinetic-word", { text: "واااو!" }], ["chapter-banner", {}], ["counter-roll", {}], ["list-montage", {}], ["joke-math", {}], ["word-reveal", {}], ["name-tag", {}], ["slam-stamp", {}], ["compare-gauge", {}], ["gsap-title", {}]];

await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", media], { timeoutMs: 300_000 });
const app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
const win = await app.firstWindow();
await win.waitForSelector(".home", { timeout: 30_000 });
const api = (m, ...a) => win.evaluate(([mm, aa]) => window.api.call(mm, ...aa), [m, a]);
await api("settings.set", "general", { onboarded: true });

async function project(name, add) {
  const p = await api("project.create", { name });
  const r = await api("media.import", p.id, [media]);
  await api("timeline.exec", p.mainTimelineId, "addMedia", { mediaId: r.imported[0].id });
  await add(p.mainTimelineId);
  return p;
}
async function exportTimed(p) {
  const t0 = Date.now();
  const { path: out } = await api("export.start", { timelineId: p.mainTimelineId, mode: "video", resolution: "1080p", fps: 30, codec: "h264", dir: exportDir });
  for (;;) {
    const rec = (await api("export.list", { projectId: p.id })).find((x) => x.path === out);
    if (rec && ["done", "failed", "cancelled"].includes(rec.status)) { if (rec.status !== "done") throw new Error(rec.error); break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { sec: (Date.now() - t0) / 1000, out };
}

// Each case several times, interleaved, keeping the fastest (other work on the machine only ever slows a run down).
const ROUNDS = Number(process.env.ROUNDS || 3);
const none = await project("none", async () => {});
const canvas = await project("canvas", async (tid) => { for (const [i, id] of CANVAS.entries()) await api("graphics.add", tid, { template: id, params: {}, atUs: i * 3_000_000, durationUs: 3_000_000 }); });
const kit = await project("kit", async (tid) => { for (const [i, [id, params]] of KIT.entries()) await api("graphics.add", tid, { template: id, params, atUs: i * 3_000_000, durationUs: 3_000_000 }); });
const cache = path.join(ud, "cache", "graphics");
const runs = { noGraphics: [], canvasPngPath: [], remotionCold: [], remotionWarm: [] };
for (let r = 0; r < ROUNDS; r++) {
  runs.noGraphics.push((await exportTimed(none)).sec);
  runs.canvasPngPath.push((await exportTimed(canvas)).sec);
  fs.rmSync(cache, { recursive: true, force: true });
  runs.remotionCold.push((await exportTimed(kit)).sec);
  runs.remotionWarm.push((await exportTimed(kit)).sec);
}
const results = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, +Math.min(...v).toFixed(2)]));
results.runs = runs;
results.graphicsOnly = { canvas: +(results.canvasPngPath - results.noGraphics).toFixed(1), remotionCold: +(results.remotionCold - results.noGraphics).toFixed(1), remotionWarm: +(results.remotionWarm - results.noGraphics).toFixed(1) };
results.machine = { cpus: os.cpus().length, cpu: os.cpus()[0].model, gpu: "RTX 4090 (gl=angle)" };
results.setup = "1080×1920, 30 s, 30 fps, H.264 1080p; 10 graphics × 3 s covering the whole video";
for (const [n, p] of [["frame-canvas.png", canvas], ["frame-remotion.png", kit]]) {
  const out = (await api("export.list", { projectId: p.id }))[0].path;
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-ss", "7.5", "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", path.join(OUT, n)], { timeoutMs: 60_000 });
}
fs.writeFileSync(path.join(OUT, "export-bench.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await app.close();
fs.rmSync(ud, { recursive: true, force: true });
