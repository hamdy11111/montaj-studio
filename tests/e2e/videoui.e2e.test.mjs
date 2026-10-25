// «توليد الفيديو» in the real app: the tab and its page title, the six sections, the plan line from a source and a
// reference picture, opening the page or the model manager starts no engine and loads no model, the model manager
// shows sizes, licences (MiniMax H3's terms) and sources, and the editor's media tab opens the studio with its project.
// Screenshots of the page and the model manager are kept.
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
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-videoui-"));
let app, win;
const errors = [];
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);

before(async () => {
  fs.mkdirSync(ART, { recursive: true });
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack}`));
  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await win.waitForSelector(".home");
  await api("settings.set", "general", { onboarded: true });
  await win.reload();
  await win.waitForSelector(".home");
});
after(async () => { await app?.close().catch(() => {}); try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("the video tab opens with its six sections, plans a job and starts nothing", async () => {
  await win.locator(".nav-item", { hasText: "توليد الفيديو" }).click();
  await win.waitForSelector(".vgen .mu-step");
  assert.equal(await win.locator(".vgen h1").textContent(), "استوديو توليد الفيديو بالذكاء الاصطناعي");
  assert.equal(await win.locator(".vgen .mu-step").count(), 6);
  for (const s of ["عايز تعمل إيه؟", "الفيديو والصور المرجعية", "الجزء المطلوب والإعدادات", "التوليد والتقدم", "مشاهدة النتيجة وتحسينها", "الفيديوهات المولّدة"]) assert.ok(await win.locator(".vgen h2", { hasText: s }).count(), s);
  assert.equal(await win.locator(".vgen button", { hasText: "توليد الفيديو" }).count(), 1);
  // Engine names stay out of the visible page (only in the engine details / advanced settings).
  const visible = await win.locator(".vgen").evaluate((el) => [...el.querySelectorAll("*")].filter((n) => n.closest("details:not([open])") === null && n.childElementCount === 0).map((n) => n.textContent).join(" "));
  assert.doesNotMatch(visible, /ComfyUI|SeedVR|MiniMax|H3/);
  // A source and a reference: the plan line says what will be made.
  const vid = path.join(ud, "clip.mp4"), img = path.join(ud, "face.png");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", vid], { timeoutMs: 60_000 });
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:size=256x256", "-frames:v", "1", img], { timeoutMs: 60_000 });
  await api("video.addSource", vid);
  await api("video.addSource", img);
  await win.reload(); await win.waitForSelector(".home");
  await win.locator(".nav-item", { hasText: "توليد الفيديو" }).click();
  await win.waitForSelector(".vgen .mu-step");
  await win.locator(".vgen .chip", { hasText: "clip.mp4" }).click();
  await win.locator(".vgen .vg-ref.add .chip", { hasText: "face.png" }).click();
  await win.waitForSelector(".vgen .card >> text=هيعمل");
  assert.match(await win.locator(".vgen .card", { hasText: "هيعمل" }).first().textContent(), /107 فريم/);
  assert.equal(await win.locator(".vgen button.primary", { hasText: "توليد الفيديو" }).isDisabled(), false, "ready to generate");
  assert.equal((await api("video.status")).engine.running, false, "opening the tab starts no engine");
  await win.screenshot({ path: path.join(ART, "video-tab.png"), fullPage: true });
  // The model manager: sizes, licences, sources — and MiniMax H3's terms.
  await win.locator(".vgen button", { hasText: "النماذج والمتطلبات" }).first().click();
  await win.waitForSelector(".modal >> text=MiniMax H3 Community License");
  const text = await win.locator(".modal").textContent();
  assert.match(text, /not for use in the EU, the UK, South Korea or the US/);
  assert.match(text, /Apache-2\.0/);
  assert.match(text, /huggingface\.co\/Comfy-Org\/MiniMax-H3/);
  assert.match(text, /محتاج موافقتك/);
  await win.screenshot({ path: path.join(ART, "video-models.png") });
  assert.equal((await api("video.status")).engine.running, false, "the model manager loads no model");
  await win.keyboard.press("Escape");
  assert.doesNotMatch(await win.locator(".vgen").textContent(), /undefined|NaN|\bnull\b/);
  assert.deepEqual(errors, []);
});

test("the editor's media tab opens the studio for its project", async () => {
  const p = await api("project.create", {});
  await win.reload(); await win.waitForSelector(".proj-card");
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
  await win.locator(".mat-tab").nth(0).click();
  await win.locator(".mat-body .mat-head button", { hasText: "توليد الفيديو" }).click();
  await win.waitForSelector(".vgen .mu-step");
  assert.equal((await api("video.status")).engine.running, false);
  void p;
  assert.deepEqual(errors, []);
});
