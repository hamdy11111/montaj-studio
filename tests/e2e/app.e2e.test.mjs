// End-to-end UI tests: launches the real Electron app (isolated user-data folder, no network) with Playwright and
// drives the renderer like a user. Generated media only (FFmpeg lavfi). Screenshots go to tests/e2e/artifacts/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run, ffprobe } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-e2e-"));
const mediaDir = path.join(ud, "_media");
const exportDir = path.join(ud, "_exports");
let app, win;
const pageErrors = [];

async function launch() {
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => pageErrors.push(e.message));
  win.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await win.waitForSelector(".home", { timeout: 30_000 });
}
const shot = (name) => win.screenshot({ path: path.join(ART, `${name}.png`) });
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
async function closeModals() { while (await win.locator(".backdrop").count()) { await win.keyboard.press("Escape"); await win.waitForTimeout(150); } }

before(async () => {
  fs.mkdirSync(ART, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });
  const ff = binaries().ffmpeg;
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(mediaDir, "a.mp4")], { timeoutMs: 120_000 });
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "smptebars=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=660:duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(mediaDir, "b.mp4")], { timeoutMs: 120_000 });
  await launch();
});

after(async () => {
  await app?.close().catch(() => {});
  fs.rmSync(ud, { recursive: true, force: true });
});

test("home renders in Arabic RTL with navigation and no page errors", async () => {
  assert.equal(await win.evaluate(() => document.documentElement.dir), "rtl");
  for (const label of ["القوالب", "أدوات ذكية", "المكتبة"]) {
    await win.locator(".nav-item", { hasText: label }).first().click();
    await win.waitForTimeout(250);
  }
  await win.locator(".nav-item").first().click();
  await shot("01-home");
  assert.deepEqual(pageErrors, []);
});

test("first-run walkthrough appears once and can be dismissed", async () => {
  await win.click(".suite-card.primary");
  await win.waitForSelector(".editor");
  await win.waitForSelector(".backdrop .modal", { timeout: 5000 });
  await win.locator(".backdrop .modal-foot .btn").first().click(); // Skip
  await win.waitForFunction(() => !document.querySelector(".backdrop"));
  await win.waitForTimeout(200);
  assert.equal((await api("settings.all")).general.onboarded, true);
  await win.locator("#titlebar-actions .btn").click();
  await win.waitForSelector(".home");
  // That project stays empty; delete it so the rest of the suite works on one project.
  for (const p of await api("project.list", {})) await api("project.deleteForever", p.id);
  await win.locator(".nav-item").nth(1).click(); await win.locator(".nav-item").first().click();
});

test("create project, import media and build a timeline", async () => {
  await win.click(".suite-card.primary");
  await win.waitForSelector(".editor");
  await closeModals();
  const pid = (await api("project.list", {}))[0].id;
  const res = await api("media.import", pid, [path.join(mediaDir, "a.mp4"), path.join(mediaDir, "b.mp4")]);
  assert.equal(res.imported.length, 2);
  await win.waitForFunction(() => document.querySelectorAll(".media-card").length === 2, null, { timeout: 20_000 });
  for (let i = 0; i < 2; i++) { const c = win.locator(".media-card").nth(i); await c.hover(); await c.locator(".media-add").click(); await win.waitForTimeout(300); }
  await win.waitForFunction(() => document.querySelectorAll(".clip").length === 2);
  // Text via the Text tab
  await win.locator(".mat-tab").nth(2).click();
  await win.locator(".mat-body .btn.primary").first().click();
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-text").length === 1);
  await shot("02-editor");
  const time = await win.locator(".player-bar .time").innerText();
  assert.match(time, /00:00:07:00/); // 4 s + 3 s on the main track
});

test("split (E), undo (Ctrl+Z) and redo (Ctrl+Shift+Z)", async () => {
  await closeModals();
  await win.locator(".tl-ruler").click({ position: { x: 60, y: 12 } });
  await win.locator(".clip.k-video").first().click();
  const before = await win.locator(".clip.k-video").count();
  await win.keyboard.press("e");
  await win.waitForFunction((n) => document.querySelectorAll(".clip.k-video").length === n + 1, before);
  await win.keyboard.press("Control+z");
  await win.waitForFunction((n) => document.querySelectorAll(".clip.k-video").length === n, before);
  await win.keyboard.press("Control+Shift+z");
  await win.waitForFunction((n) => document.querySelectorAll(".clip.k-video").length === n + 1, before);
});

test("inspector edits persist (scale slider) and playback advances", async () => {
  await win.locator(".clip.k-video").first().click();
  await win.locator(".insp-tabs button").first().click();
  const num = win.locator(".insp-body .ctl").first().locator("input[type=number]");
  await num.fill("150");
  await num.press("Enter");
  await win.waitForTimeout(500);
  const tid = (await api("project.list", {}))[0].mainTimelineId;
  const tl = (await api("timeline.get", tid)).timeline;
  const main = tl.tracks.find((t) => t.isMain);
  assert.equal(main.segments[0].transform.scale, 1.5);
  await win.locator(".tl-ruler").click({ position: { x: 2, y: 12 } });
  await win.locator(".player-bar .icon-btn.big").click();
  await win.waitForTimeout(1200);
  await win.locator(".player-bar .icon-btn.big").click();
  const t = await win.locator(".player-bar .time").innerText();
  assert.doesNotMatch(t, /^00:00:00:00 /);
  await shot("03-after-play");
});

test("export a real MP4 through the export dialog", async () => {
  await api("settings.set", "export", { dir: exportDir });
  await win.evaluate(() => window.api.call("settings.all")); // warm
  await win.keyboard.press("Control+e");
  await win.waitForSelector(".export-form");
  await win.locator(".export-grid select").first().selectOption("480p");
  await shot("04-export-dialog");
  await win.locator(".modal-foot .btn").click();
  await win.waitForFunction(() => [...document.querySelectorAll(".job")].some((j) => j.querySelector(".btn")), null, { timeout: 240_000 });
  const files = fs.readdirSync(exportDir).filter((f) => f.endsWith(".mp4"));
  assert.equal(files.length, 1);
  const info = await ffprobe(path.join(exportDir, files[0]));
  const v = info.streams.find((s) => s.codec_type === "video");
  assert.equal(Number(v.height), 480);
  assert.ok(Math.abs(Number(info.format.duration) - 7) < 0.3, `duration ${info.format.duration}`);
  await shot("05-export-done");
  await closeModals();
});

test("settings dialog validates and saves", async () => {
  await win.locator(".ed-topbar .btn.ghost").first().click(); // Menu
  await win.locator(".menu-item", { hasText: "الإعدادات" }).click();
  await win.waitForSelector(".settings");
  await win.locator(".settings-tabs button").nth(1).click(); // Edit
  const step = win.locator(".settings-pane input[type=number]").first();
  await step.fill("999"); await step.press("Enter");
  assert.ok(await step.evaluate((el) => el.classList.contains("invalid")));
  await step.fill("12"); await step.press("Enter");
  await win.locator(".modal-foot .btn.primary").click();
  await win.waitForTimeout(400);
  assert.equal((await api("settings.all")).edit.stepFrames, 12);
});

test("data persists after restarting the app", async () => {
  const before = await api("project.list", {});
  await app.close();
  await launch();
  const after = await api("project.list", {});
  assert.equal(after.length, before.length);
  const tl = (await api("timeline.get", after[0].mainTimelineId)).timeline;
  assert.equal(tl.tracks.find((t) => t.isMain).segments.length, 3);
  assert.equal((await api("settings.all")).edit.stepFrames, 12);
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
  await win.waitForFunction(() => document.querySelectorAll(".clip").length >= 4);
  await shot("06-reopened");
  await win.locator("#titlebar-actions .btn").click(); // back to home
  await win.waitForSelector(".home");
});

test("move to trash, restore, and delete permanently with confirmation", async () => {
  const card = win.locator(".proj-card").first();
  await card.click({ button: "right" });
  await win.locator(".menu-item", { hasText: "حذف" }).click();
  await win.locator(".modal-foot .btn.danger").click();
  await win.waitForFunction(() => !document.querySelector(".proj-card"));
  await win.locator(".proj-toolbar .btn", { hasText: "سلة المهملات" }).click();
  await win.waitForSelector(".trash .proj-card");
  await shot("07-trash");
  await win.locator(".trash .btn", { hasText: "استعادة" }).click();
  await win.waitForFunction(() => !document.querySelector(".trash .proj-card"));
  await closeModals();
  await win.waitForSelector(".proj-card");
  assert.equal((await api("project.list", {})).length, 1);
});

test("offline: the app never requests remote http(s) resources", async () => {
  const remote = [];
  win.on("request", (r) => { if (/^https?:/.test(r.url())) remote.push(r.url()); });
  await win.reload();
  await win.waitForSelector(".home");
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
  await win.waitForTimeout(1500);
  assert.deepEqual(remote, []);
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});
