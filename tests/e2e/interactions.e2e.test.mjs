// Pointer interactions on the timeline, driven with the real mouse: drag-to-reorder on the main track (magnet on),
// trimming the edge between two neighbouring clips, the transition badge at that boundary, and HTML5 drag from
// the Media panel. These regressed unnoticed before (see docs/CAPCUT_COMPARISON.md, P1-1 / P1-2).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-int-"));
let app, win, project;
const errors = [];
const api = (m, ...a) => win.evaluate(([mm, aa]) => window.api.call(mm, ...aa), [m, a]);
const main = async () => (await api("timeline.get", project.mainTimelineId)).timeline.tracks.find((t) => t.isMain).segments;
const box = (i) => win.locator(".tl-row .clip").nth(i).boundingBox();

before(async () => {
  const ff = binaries().ffmpeg;
  const make = (name, src, d) => run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", `${src}=size=640x360:rate=30:duration=${d}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(ud, name)], { timeoutMs: 120_000 });
  await make("long.mp4", "testsrc2", 8);
  await make("short.mp4", "smptebars", 3);
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForSelector(".home");
  await api("settings.set", "general", { onboarded: true });
  project = await api("project.create", { name: "interactions" });
  await api("media.import", project.id, [path.join(ud, "long.mp4"), path.join(ud, "short.mp4")]);
  await win.reload(); await win.waitForSelector(".home");
  await win.locator('.proj-card[title="interactions"]').click();
  await win.waitForSelector(".editor");
  await win.waitForFunction(() => document.querySelectorAll(".media-card").length === 2);
});
after(async () => { await app?.close().catch(() => {}); fs.rmSync(ud, { recursive: true, force: true }); });

test("HTML5 drag from the Media panel adds a clip to the timeline", async () => {
  await win.locator(".media-card").first().dragTo(win.locator(".tl-row").first(), { targetPosition: { x: 40, y: 20 } });
  await win.waitForFunction(() => document.querySelectorAll(".tl-row .clip").length === 1);
  const c = win.locator(".media-card").nth(1); await c.hover(); await c.locator(".media-add").click();
  await win.waitForFunction(() => document.querySelectorAll(".tl-row .clip").length === 2);
  await win.locator(".tl-toolbar .icon-btn").last().click(); // zoom to fit
  await win.waitForTimeout(300);
  assert.equal((await main()).length, 2);
});

test("dragging the second main clip to the start reorders the track (magnet on)", async () => {
  const before = (await main()).map((s) => s.mediaId);
  const b2 = await box(1), b1 = await box(0);
  await win.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await win.mouse.down();
  await win.mouse.move(b2.x + b2.width / 2 - 20, b2.y + b2.height / 2, { steps: 4 });
  await win.mouse.move(b1.x + b2.width / 2 + 2, b2.y + b2.height / 2, { steps: 10 });
  await win.mouse.up();
  await win.waitForTimeout(600);
  const after = (await main()).map((s) => s.mediaId);
  assert.deepEqual(after, [before[1], before[0]]);
  assert.equal((await main())[0].start, 0);
});

test("the right edge of a clip followed by another clip can be trimmed by dragging", async () => {
  const first = await box(0);
  const d0 = (await main())[0].duration;
  // grab the edge at mid-height (where the transition button used to sit)
  const hit = await win.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [first.x + first.width - 3, first.y + first.height / 2]);
  assert.match(String(hit), /trim r/);
  await win.mouse.move(first.x + first.width - 3, first.y + first.height / 2);
  await win.mouse.down();
  await win.mouse.move(first.x + first.width * 0.5, first.y + first.height / 2, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(600);
  const segs = await main();
  assert.ok(segs[0].duration < d0 * 0.8, `duration ${segs[0].duration} vs ${d0}`);
  assert.equal(segs[1].start, segs[0].duration); // magnet closed the gap
});

test("the transition badge at the boundary is still clickable and opens Transitions", async () => {
  const first = await box(0);
  await win.locator(".tl-row").first().hover();
  const badge = win.locator(".tl-trans").first();
  const bb = await badge.boundingBox();
  assert.ok(bb.y < first.y + first.height / 3, "badge sits in the top band of the boundary");
  await badge.click();
  await win.waitForTimeout(300);
  assert.match(await win.locator(".mat-tab.active").innerText(), /الانتقالات|Transitions/);
  assert.deepEqual(errors, []);
});
