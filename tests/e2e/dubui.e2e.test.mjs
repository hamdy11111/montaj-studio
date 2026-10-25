// The Dub dialog in the real app (Electron driven by Playwright): the button in the editor's top bar opens it, it
// finds the video's language (Arabic → the dub can start), shows the expected time, and — with MONTAJ_DUB_UI_RUN=1 —
// runs a whole dub from the dialog: the progress bar moves, the speakers and the lines appear, and the timeline gets
// the two dub tracks. Needs MONTAJ_DUB_SAMPLE (an Arabic video) and the dub runtime; skipped otherwise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { dubParts } from "../../src/services/dubService.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const SAMPLE = process.env.MONTAJ_DUB_SAMPLE || "";
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-dubui-"));
let app, win, skip = null, tid = null;
const errors = [];
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
const shot = (n) => win.screenshot({ path: path.join(ART, `${n}.png`) });

before(async () => {
  if (!SAMPLE || !fs.existsSync(SAMPLE)) { skip = "set MONTAJ_DUB_SAMPLE to an Arabic video"; return; }
  if (Object.values(dubParts(ud)).some((v) => !v)) { skip = "dub runtime not set up"; return; }
  fs.mkdirSync(ART, { recursive: true });
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack}`));
  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await win.waitForSelector(".home");
  await api("settings.set", "general", { onboarded: true });
  const p = await api("project.create", {});
  tid = p.mainTimelineId;
  await api("media.import", p.id, [SAMPLE]);
  const m = (await api("media.list", p.id))[0];
  await api("timeline.exec", tid, "addMedia", { mediaId: m.id });
  await win.reload();
  await win.waitForSelector(".proj-card");
  await win.locator(".proj-card").first().click();
  await win.waitForSelector(".editor");
});
after(async () => { await app?.close().catch(() => {}); try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("the Dub dialog finds the Arabic speech and can dub the video", { timeout: 60 * 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  await win.locator(".ed-topbar button", { hasText: "دبلجة" }).click();
  await win.waitForSelector(".modal");
  await win.waitForFunction(() => /الفيديو عربي/.test(document.querySelector(".modal")?.textContent || ""), null, { timeout: 180_000 });
  const go = win.locator(".modal button", { hasText: "ابدأ الدبلجة" });
  assert.equal(await go.isDisabled(), false);
  assert.match(await win.locator(".modal").textContent(), /الوقت المتوقع/);
  assert.doesNotMatch(await win.locator(".modal").textContent(), /null|undefined|NaN/);
  await shot("dub-dialog");
  if (process.env.MONTAJ_DUB_UI_RUN !== "1") return;
  await go.click();
  await win.waitForFunction(() => /بفصل الكلام|بكتب الكلام|بحدد مين/.test(document.querySelector(".modal")?.textContent || ""), null, { timeout: 120_000 });
  await shot("dub-running");
  await win.waitForFunction(() => /تمت الدبلجة/.test(document.querySelector(".modal")?.textContent || ""), null, { timeout: 55 * 60_000 });
  await shot("dub-done");
  const rows = await win.locator(".modal textarea").count();
  assert.ok(rows >= 3, `${rows} lines listed`);
  assert.doesNotMatch(await win.locator(".modal").textContent(), /null|undefined|NaN/);
  const tl = (await api("timeline.get", tid)).timeline;
  assert.equal(tl.tracks.filter((x) => (x.role || "").startsWith("dub:")).length, 2);
  assert.deepEqual(errors, []);
});
