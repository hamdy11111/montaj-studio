// The «استوديو الموسيقى» tab in the real app: it opens from the home navigation with its six steps, opening it starts
// no engine and loads no model, the model manager opens with the runtime and the model sets (size, licence, source),
// the description rules suggest choices, and the page has no errors. A screenshot of the tab is kept.
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
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-musicui-"));
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

test("the music studio tab opens with its steps and starts nothing", async () => {
  await win.locator(".nav-item", { hasText: "استوديو الموسيقى" }).click();
  await win.waitForSelector(".music .mu-step");
  assert.equal(await win.locator(".music .mu-step").count(), 6);
  await win.waitForSelector(".music .mu-card");
  assert.equal(await win.locator(".music .mu-card").count(), 11, "the 11 compose styles");
  const st = await api("music.status");
  assert.equal(st.engine.running, false, "opening the tab starts no engine");
  // Suggestions from an Arabic description.
  await win.locator(".music textarea").first().fill("موسيقى هادية فيها تشويق");
  await win.locator(".music button", { hasText: "اقترح اختيارات من كلامي" }).click();
  await win.waitForSelector(".music .chip >> text=طبّق");
  await win.screenshot({ path: path.join(ART, "music-tab.png"), fullPage: true });
  // The model manager: runtime and model sets with size, licence and source.
  await win.locator(".music button", { hasText: "النماذج والمتطلبات" }).first().click();
  await win.waitForSelector(".modal >> text=ACE-Step 1.5 Turbo");
  const text = await win.locator(".modal").textContent();
  assert.match(text, /Apache-2\.0/);
  assert.match(text, /huggingface\.co\/Comfy-Org\/ACE-Step-1\.5/);
  await win.screenshot({ path: path.join(ART, "music-models.png") });
  assert.equal((await api("music.status")).engine.running, false, "the model manager loads no model");
  assert.doesNotMatch(await win.locator(".music").textContent(), /undefined|NaN|null/);
  assert.deepEqual(errors, []);
});

test("from the editor's audio tab the studio opens with the timeline's length", async () => {
  const wav = path.join(ud, "tone.wav");
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", wav], { timeoutMs: 60_000 });
  const p = await api("project.create", {});
  await api("media.import", p.id, [wav]);
  const m = (await api("media.list", p.id))[0];
  await api("timeline.exec", p.mainTimelineId, "addMedia", { mediaId: m.id });
  await win.reload(); await win.waitForSelector(".proj-card");
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
  await win.locator(".mat-tab").nth(1).click();
  await win.locator(".mat-body button", { hasText: "استوديو الموسيقى" }).click();
  await win.waitForSelector(".music .mu-step");
  const chip = win.locator(".music .chip", { hasText: "التايم لاين كله" });
  assert.match(await chip.textContent(), /0:12/);
  assert.match(await chip.getAttribute("class"), /active/, "the length is taken from the timeline");
  assert.equal((await api("music.status")).engine.running, false);
  assert.deepEqual(errors, []);
});
