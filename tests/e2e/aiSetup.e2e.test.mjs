// End-to-end UI test of «تجهيز الذكاء» (the AI layers' set-up page): the real Electron app on a fresh, isolated
// user-data folder (nothing installed there), no download. The page lists the four layers as not installed with their
// sizes, opens a layer's details (runtime, parts it needs, model sets with licence and source), and imports the
// smallest set from a folder when this PC has the development runtime. Screenshots go to tests/e2e/artifacts/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-e2e-ai-"));
let app, win;
const pageErrors = [];
const shot = (name) => win.screenshot({ path: path.join(ART, `${name}.png`) });
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);

before(async () => {
  fs.mkdirSync(ART, { recursive: true });
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => pageErrors.push(e.message));
  win.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await win.waitForSelector(".home", { timeout: 30_000 });
  while (await win.locator(".backdrop").count()) { await win.keyboard.press("Escape"); await win.waitForTimeout(150); }
});

after(async () => {
  await app?.close().catch(() => {});
  // A junction made by the import test is unlinked first, never followed.
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); else if (e.isDirectory()) walk(p); } };
  try { walk(ud); } catch { /* already gone */ }
  fs.rmSync(ud, { recursive: true, force: true });
});

test("the AI set-up page: four layers, not installed on a fresh profile, details with licences", async () => {
  await win.locator(".nav-item", { hasText: "تجهيز الذكاء" }).click();
  await win.waitForSelector(".ai-setup .card b", { timeout: 15_000 });
  await win.waitForFunction(() => document.querySelectorAll(".ai-setup > .col > .card").length === 4, null, { timeout: 15_000 });
  const titles = await win.locator(".ai-setup > .col > .card > .row > b").allTextContents();
  assert.deepEqual(titles, ["فهم الفيديو (الإدراك)", "أحسن إعادة", "الفعل ورد الفعل", "التدوير في لقطاتك (بي-رول)"]);
  assert.equal(await win.locator(".ai-setup .badge", { hasText: "مش متسطّبة" }).count(), 4);
  assert.equal(await win.locator(".ai-setup button", { hasText: "جهّزها" }).count(), 4);
  await shot("ai-setup-01-fresh");
  await win.locator(".ai-setup details > summary").first().click();
  await win.waitForTimeout(200);
  assert.ok(await win.locator(".ai-setup", { hasText: "Apache-2.0" }).count());
  assert.ok(await win.locator(".ai-setup", { hasText: "huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF" }).count());
  await shot("ai-setup-02-details");
  const st = await api("ai.setupStatus");
  assert.equal(st.root, path.join(ud, "runtime"));
  assert.deepEqual(st.layers.map((l) => l.state), ["missing", "missing", "missing", "missing"]);
  assert.deepEqual(pageErrors, []);
});

const DEV = path.join(APP, "runtime", "models", "takes");
test("importing a set from a folder marks it ready on the page", { skip: !fs.existsSync(path.join(DEV, "dnsmos", "sig_bak_ovr.onnx")) && "no development runtime" }, async () => {
  const r = await api("ai.importSet", "takes/voice", DEV);
  assert.equal(r.status.installed, true);
  await win.locator(".nav-item", { hasText: "تجهيز الذكاء" }).click();
  await win.waitForFunction(() => document.querySelectorAll(".ai-setup > .col > .card").length === 4, null, { timeout: 15_000 });
  await win.locator(".ai-setup > .col > .card").nth(1).locator("details > summary").first().click();
  await win.waitForTimeout(200);
  assert.ok(await win.locator(".ai-setup .card .card", { hasText: "DNSMOS" }).locator(".badge", { hasText: "جاهز" }).count());
  await shot("ai-setup-03-imported");
  assert.deepEqual(pageErrors, []);
});
