// UI coverage: opens every home view, material tab, inspector tab and dialog, runs EditPilot and context menus,
// and fails on any page error. Uses generated media in an isolated user-data folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-panels-"));
let app, win;
const errors = [];
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
const shot = (n) => win.screenshot({ path: path.join(ART, `${n}.png`) });
async function escapeAll() { for (let i = 0; i < 4 && (await win.locator(".backdrop, .menu").count()); i++) { await win.keyboard.press("Escape"); await win.waitForTimeout(120); } }

before(async () => {
  fs.mkdirSync(ART, { recursive: true });
  const file = path.join(ud, "v.mp4");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file], { timeoutMs: 120_000 });
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack}`));
  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await win.waitForSelector(".home");
  await api("settings.set", "general", { onboarded: true });
  const p = await api("project.create", {});
  await api("media.import", p.id, [file]);
  const m = (await api("media.list", p.id))[0];
  await api("timeline.exec", p.mainTimelineId, "addMedia", { mediaId: m.id });
  await win.reload();
  await win.waitForSelector(".home");
});
after(async () => { await app?.close().catch(() => {}); fs.rmSync(ud, { recursive: true, force: true }); });

test("home views: templates, tools, library tabs, notifications, shares, spaces", async () => {
  const nav = win.locator(".home-nav .nav-item");
  const n = await nav.count();
  for (let i = 0; i < n - 3; i++) { await nav.nth(i).click(); await win.waitForTimeout(200); }
  await win.locator(".nav-item", { hasText: "المكتبة" }).click();
  await win.locator(".tabs.inline button").nth(1).click();
  await win.waitForTimeout(200);
  // create a space
  await win.locator(".nav-item", { hasText: "إنشاء مساحة" }).click();
  await win.locator(".modal input").fill("Team A");
  await win.locator(".modal-foot .btn.primary").click();
  await win.waitForSelector(".space-head h1");
  assert.equal((await api("workspace.list")).length, 1);
  // tools + provider-only panel
  await win.locator(".nav-item", { hasText: "أدوات ذكية" }).click();
  await win.locator(".suite-card.disabled-card").first().click();
  await win.waitForSelector(".modal");
  await escapeAll();
  await win.locator(".nav-item").first().click();
  // search: no match → no-results state; match → the card is back
  await win.locator(".proj-toolbar input[type=search]").fill("zzz-no-such-project");
  await win.waitForSelector(".projects .empty");
  await win.locator(".proj-toolbar input[type=search]").fill("");
  await win.waitForSelector(".proj-card");
  // list layout + sort
  await win.locator(".proj-toolbar .seg button").nth(1).click();
  await win.waitForSelector(".table");
  await shot("10-home-list");
  await win.locator(".proj-toolbar .seg button").nth(0).click();
  assert.deepEqual(errors, []);
});

test("settings: every tab renders; shortcuts dialog records and resets", async () => {
  await win.locator(".nav-item", { hasText: "الإعدادات" }).click();
  for (let i = 0; i < 6; i++) { await win.locator(".settings-tabs button").nth(i).click(); await win.waitForTimeout(250); }
  await shot("11-settings-backup");
  await win.locator(".settings-tabs button").nth(3).click();
  await win.locator(".settings-pane .btn", { hasText: "اختصارات" }).click();
  await win.waitForSelector(".sc-list");
  await win.locator(".sc-row .sc-keys").first().click();
  await win.keyboard.press("Control+Alt+Shift+J");
  await win.waitForTimeout(400);
  const sc = await api("shortcuts.get", 1);
  assert.equal(sc.bindings.split, "Ctrl+Alt+Shift+J");
  await shot("12-shortcuts");
  await api("shortcuts.reset", 1);
  await escapeAll();
  assert.deepEqual(errors, []);
});

test("editor: every material tab and inspector tab renders", async () => {
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
  await win.waitForTimeout(600);
  const tabs = win.locator(".mat-tab");
  for (let i = 0; i < await tabs.count(); i++) { await tabs.nth(i).click(); await win.waitForTimeout(220); }
  // add one of each overlay kind
  // Tabs: 0 media, 1 audio, 2 text, 3 graphics, 4 stickers, 5 effects, 6 transitions, 7 captions, 8 filters, 9 adjustment.
  await tabs.nth(2).click(); await win.locator(".mat-body .btn.primary").first().click();
  await tabs.nth(3).click(); await win.locator(".mat-body .gfx-tile").first().click(); // a motion graphic (a text clip)
  await tabs.nth(4).click(); await win.locator(".mat-body .tile").first().click();
  await tabs.nth(5).click(); await win.locator(".tl-ruler").click({ position: { x: 40, y: 10 } }); await win.locator(".mat-body .tile").first().click();
  await tabs.nth(8).click(); await win.locator(".mat-body .tile").nth(2).click();
  await tabs.nth(9).click(); await win.locator(".mat-body .btn.primary").first().click();
  await win.waitForTimeout(500);
  const kinds = await win.locator(".clip").evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith("k-"))));
  for (const k of ["k-video", "k-text", "k-sticker", "k-effect", "k-filter", "k-adjust"]) assert.ok(kinds.includes(k), `missing ${k} in ${kinds}`);
  // inspector tabs for every clip kind
  for (const k of ["k-video", "k-text", "k-sticker", "k-effect", "k-filter", "k-adjust"]) {
    await win.locator(`.clip.${k}`).first().click();
    const it = win.locator(".insp-tabs button");
    for (let i = 0; i < await it.count(); i++) {
      await it.nth(i).click(); await win.waitForTimeout(150);
      const seg = win.locator(".insp-body > .seg").first();
      if (await seg.count()) for (let j = 0; j < await seg.locator("button").count(); j++) { await seg.locator("button").nth(j).click(); await win.waitForTimeout(120); }
    }
  }
  await win.locator(".clip.k-video").first().click();
  await win.locator(".insp-tabs button").last().click(); // adjust
  await shot("13-adjust");
  assert.deepEqual(errors, []);
});

test("editor: transitions, speed curve, animation, keyframe and context menu", async () => {
  const tid = (await api("project.list", {}))[0].mainTimelineId;
  // Second main clip (through the Media panel) so there is a boundary for a transition.
  await win.locator(".mat-tab").nth(0).click();
  const card = win.locator(".media-card").first();
  await card.hover(); await card.locator(".media-add").click();
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-video").length === 2);
  await win.locator(".clip.k-video").first().click();
  await win.locator(".mat-tab").nth(6).click(); // transitions
  await win.locator(".mat-body .tile").first().click();
  await win.waitForTimeout(400);
  let tl = (await api("timeline.get", tid)).timeline;
  assert.equal(tl.tracks.find((t) => t.isMain).segments[0].transitionOut.type, "dissolve");
  // speed: curve preset
  await win.locator(".clip.k-video").first().click();
  await win.locator(".insp-tabs button", { hasText: "السرعة" }).click();
  await win.locator(".insp-body .seg button").nth(1).click();
  await win.waitForTimeout(400);
  tl = (await api("timeline.get", tid)).timeline;
  assert.equal(tl.tracks.find((t) => t.isMain).segments[0].speedMode, "curve");
  await shot("14-speed-curve");
  // keyframe diamond on scale
  await win.locator(".insp-tabs button").first().click();
  await win.locator(".insp-body .kf-btn").first().click();
  await win.waitForTimeout(300);
  tl = (await api("timeline.get", tid)).timeline;
  assert.equal(tl.tracks.find((t) => t.isMain).segments[0].keyframes.length, 1);
  // context menu
  await win.locator(".clip.k-video").first().click({ button: "right" });
  await win.waitForSelector(".menu");
  await shot("15-context-menu");
  await win.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("EditPilot executes a local plan through undoable commands", async () => {
  await win.locator(".ed-topbar .btn", { hasText: "EditPilot" }).click();
  await win.locator(".pilot-modal textarea").fill("اجعل الفيديو مربع 1:1");
  await win.locator(".pilot-modal .btn.primary").click();
  await win.waitForFunction(() => document.querySelectorAll(".pilot-msg.bot").length >= 2, null, { timeout: 20_000 });
  const tid = (await api("project.list", {}))[0].mainTimelineId;
  assert.equal((await api("timeline.get", tid)).timeline.canvas.ratio, "1:1");
  await shot("16-editpilot");
  await escapeAll();
  await win.keyboard.press("Control+z");
  await win.waitForTimeout(400);
  assert.notEqual((await api("timeline.get", tid)).timeline.canvas.ratio, "1:1");
  assert.deepEqual(errors, []);
});

test("switching the UI to English flips direction to LTR", async () => {
  await api("settings.set", "general", { language: "en" });
  await win.reload();
  await win.waitForSelector(".home");
  assert.equal(await win.evaluate(() => document.documentElement.dir), "ltr");
  assert.ok((await win.locator(".home-nav").innerText()).includes("Templates"));
  await shot("17-home-en");
  assert.deepEqual(errors, []);
});
