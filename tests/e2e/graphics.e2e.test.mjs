// Phase 3 graphics in the real app: a Remotion kit graphic is added to a timeline, the editor previews it with the
// Remotion Player over the canvas, and the export composites the rendered transparent clip over the video.
// Needs the graphics runtime (npm run setup:graphics && npm run build:graphics); skipped without it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { graphicsRuntime } from "../../src/graphics/setup.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const RT = graphicsRuntime();
const PLAYER = fs.existsSync(path.join(APP, "src", "renderer", "js", "editor", "graphicsPlayer.js"));
const skip = !RT.ready || !PLAYER ? "graphics runtime or Player module missing (npm run setup:graphics && npm run build:graphics)" : false;
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-gfx-e2e-"));
const mediaDir = path.join(ud, "_media"), exportDir = path.join(ud, "_exports");
let app, win;
const pageErrors = [];
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
async function closeModals() { while (await win.locator(".backdrop").count()) { await win.keyboard.press("Escape"); await win.waitForTimeout(150); } }

/** Mean absolute difference (0–255) between two frames as raw RGB at 160×90. */
async function frameDiff(a, at, b, bt) {
  const grab = async (file, t) => {
    const out = path.join(ud, `f${Math.random().toString(36).slice(2)}.rgb`);
    await run(binaries().ffmpeg, ["-hide_banner", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", out], { timeoutMs: 60_000 });
    return fs.readFileSync(out);
  };
  const x = await grab(a, at), y = await grab(b, bt);
  let d = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d += Math.abs(x[i] - y[i]);
  return d / x.length;
}

before(async () => {
  if (skip) return;
  fs.mkdirSync(ART, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(mediaDir, "a.mp4")], { timeoutMs: 120_000 });
  // MONTAJ_E2E_EXE: run the packaged app instead (e.g. dist\win-unpacked\Montaj Studio.exe after npm run pack).
  const exe = process.env.MONTAJ_E2E_EXE;
  app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: [APP] }), cwd: exe ? path.dirname(exe) : APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => pageErrors.push(e.message));
  win.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await win.waitForSelector(".home", { timeout: 30_000 });
});

after(async () => {
  await app?.close().catch(() => {});
  fs.rmSync(ud, { recursive: true, force: true });
});

test("a kit graphic: Remotion Player preview over the canvas, rendered clip in the export", { skip, timeout: 600_000 }, async () => {
  await api("settings.set", "general", { onboarded: true });
  const p = await api("project.create", {});
  const pid = p.id, tid = p.mainTimelineId;
  const res = await api("media.import", pid, [path.join(mediaDir, "a.mp4")]);
  await api("timeline.exec", tid, "addMedia", { mediaId: res.imported[0].id });
  await api("graphics.add", tid, { template: "kinetic-word", params: { text: "مفيهاش | فراخ!!", hi: "فراخ!!" }, atUs: 500_000, durationUs: 2_000_000 });
  await api("graphics.add", tid, { template: "counter-roll", params: { to: 20, suffix: " كيلو", label: "عيش" }, atUs: 2_600_000, durationUs: 1_300_000 });
  const texts = (await api("timeline.get", tid)).timeline.tracks.flatMap((t) => t.segments).filter((s) => s.kind === "text");
  assert.equal(texts.length, 2, JSON.stringify(pageErrors));
  await win.reload();
  await win.waitForSelector(".proj-card");
  await closeModals();
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
  await closeModals();
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-text").length >= 2, null, { timeout: 20_000 });
  // The graphics tiles show the kit's posters.
  await win.locator(".mat-tab").nth(3).click();
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(ART, "g1-graphics-tiles.png") });
  // Seek inside the first graphic: the Player layer appears over the canvas and shows the word.
  const ruler = win.locator(".tl-ruler");
  const box = await ruler.boundingBox();
  for (const x of [40, 60, 80, 100, 120, 140]) {
    await ruler.click({ position: { x, y: 12 } });
    await win.waitForTimeout(400);
    if (await win.evaluate(() => [...document.querySelectorAll(".remotion-layer > div")].some((d) => d.style.display !== "none"))) break;
  }
  await win.waitForFunction(() => [...document.querySelectorAll(".remotion-layer > div")].some((d) => d.style.display !== "none" && d.innerText.includes("فراخ")), null, { timeout: 20_000 });
  await win.screenshot({ path: path.join(ART, "g2-player-preview.png") });
  assert.ok(box);
  // Export: the clip of each Remotion graphic is rendered and overlaid.
  const { path: out } = await api("export.start", { timelineId: tid, mode: "video", resolution: "480p", fps: 30, codec: "h264", dir: exportDir });
  const t0 = Date.now();
  let rec;
  while (Date.now() - t0 < 300_000) {
    rec = (await api("export.list", { projectId: pid }))[0];
    if (rec && ["done", "failed", "cancelled"].includes(rec.status)) break;
    await win.waitForTimeout(500);
  }
  assert.equal(rec.status, "done", rec.error);
  const src = path.join(mediaDir, "a.mp4");
  const withWord = await frameDiff(out, 1.2, src, 1.2), without = await frameDiff(out, 0.2, src, 0.2), withCounter = await frameDiff(out, 3.3, src, 3.3);
  for (const [t, n] of [[1.2, "g3-export-word"], [3.3, "g4-export-counter"]]) await run(binaries().ffmpeg, ["-hide_banner", "-y", "-ss", String(t), "-i", out, "-frames:v", "1", path.join(ART, `${n}.png`)], { timeoutMs: 60_000 });
  // The source and the export differ only by encoding before the graphic; with it, the text adds a clear difference.
  assert.ok(withWord > 2 * without && withWord - without > 2.5, `the word is in the export (diff ${withWord.toFixed(1)} vs ${without.toFixed(1)} before it)`);
  assert.ok(withCounter > 2 * without && withCounter - without > 1.5, `the counter is in the export (diff ${withCounter.toFixed(1)} vs ${without.toFixed(1)})`);
  assert.deepEqual(pageErrors.filter((e) => !/favicon|DevTools/i.test(e)), []);
});
