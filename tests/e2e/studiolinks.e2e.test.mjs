// Phase 10 in the real app (no GPU): the preview lays J/L cuts like the export; a music bed goes under the edit from
// the timeline's button and is lowered under speech in the preview; the inspector's graphics fields are in Arabic with a
// picture picker, Calibri is in the font list, the J/L handle and the library browsers open, the settings show the
// library folder and cut-out quality, and the music studio's cover path lists its 27 styles. No page errors.
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
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-links-"));
const S = 1_000_000;
let app, win, project;
const errors = [];
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
const tl = () => win.evaluate(() => window.__montaj.timeline());
const exec = (cmd, a) => win.evaluate(([c, x]) => window.__montaj.ed.exec(c, x), [cmd, a]);

before(async () => {
  fs.mkdirSync(ART, { recursive: true });
  const ff = binaries().ffmpeg;
  // "Speech": 300 Hz bursts at 0.5–1.5, 2.5–3.5 and 4.5–5.5 s of each 6 s clip (no transcript: the voice-activity reading).
  const speech = "aevalsrc='0.4*sin(2*PI*300*t)*between(mod(t\\,2)\\,0.5\\,1.5)':s=48000:d=6";
  const clip = (name, color) => run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=320x180:rate=30:duration=6`, "-f", "lavfi", "-i", speech, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(ud, name)], { timeoutMs: 120_000 });
  await clip("red.mp4", "red");
  await clip("blue.mp4", "blue");
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-ac", "2", path.join(ud, "music.wav")], { timeoutMs: 60_000 });
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1", MONTAJ_BENCH: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack}`));
  win.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await win.waitForSelector(".home");
  await api("settings.set", "general", { onboarded: true });
  project = await api("project.create", { name: "links" });
  await api("media.import", project.id, ["red.mp4", "blue.mp4", "music.wav"].map((f) => path.join(ud, f)));
  await win.reload(); await win.waitForSelector(".home");
  await win.locator('.proj-card[title="links"]').click();
  await win.waitForSelector(".editor");
  await win.waitForFunction(() => document.querySelectorAll(".media-card").length === 3);
});
after(async () => { await app?.close().catch(() => {}); try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

/** The colour at the centre of the preview at `us`. */
async function centreAt(us) {
  return win.evaluate(async (t) => {
    const p = window.__montaj.player;
    p.seek(t);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      p.render();
      const d = p.ctx.getImageData(Math.floor(p.W / 2), Math.floor(p.H / 2), 1, 1).data;
      if (d[0] + d[1] + d[2] > 60) return [d[0], d[1], d[2]];
    }
    return null;
  }, us);
}
const isRed = (c) => c && c[0] > 150 && c[2] < 100;
const isBlue = (c) => c && c[2] > 150 && c[0] < 100;

test("J/L: the preview lays the main track's picture with its own edit points, the handle sits on the joint", async () => {
  const media = await api("media.list", project.id);
  const red = media.find((m) => m.name.startsWith("red")), blue = media.find((m) => m.name.startsWith("blue"));
  await exec("addMedia", { mediaId: red.id, toMain: true });
  await exec("addMedia", { mediaId: blue.id, toMain: true });
  // Handles on both sides of the joint: red ends at 4 s of its 6 s; blue starts 0.5 s into its file.
  let main = (await tl()).tracks.find((t) => t.isMain).segments.sort((a, b) => a.start - b.start);
  await exec("trim", { segId: main[0].id, edge: "end", timeUs: 4 * S });
  main = (await tl()).tracks.find((t) => t.isMain).segments.sort((a, b) => a.start - b.start);
  await exec("trim", { segId: main[1].id, edge: "start", timeUs: main[1].start + 0.5 * S });
  main = (await tl()).tracks.find((t) => t.isMain).segments.sort((a, b) => a.start - b.start);
  assert.deepEqual([main[0].start, main[0].duration, main[1].start, main[1].sourceStart], [0, 4 * S, 4 * S, 0.5 * S], JSON.stringify(main.map((x) => [x.start, x.duration, x.sourceStart])));
  assert.ok(isBlue(await centreAt(4.15 * S)), "no J/L: the new picture at the joint");
  await exec("setJL", { segId: main[1].id, jlUs: -300_000 }); // J: the next sound 0.3 s before its picture
  assert.equal((await tl()).tracks.find((t) => t.isMain).segments.find((s) => s.id === main[1].id).jlUs, -300_000);
  assert.ok(isRed(await centreAt(4.15 * S)), "J: the clip before is still seen 0.15 s after the joint");
  assert.ok(isBlue(await centreAt(4.4 * S)), "J: the new picture after the 0.3 s");
  await win.waitForSelector(".tl-jl");
  assert.equal((await win.locator(".tl-jl").first().textContent()).trim(), "J");
  await exec("setJL", { segId: main[1].id, jlUs: 200_000 }); // L: the picture 0.2 s early
  assert.ok(isBlue(await centreAt(3.9 * S)), "L: the new picture 0.1 s before the joint");
  assert.equal((await win.locator(".tl-jl").first().textContent()).trim(), "L");
  await exec("setJL", { segId: main[1].id, jlUs: 0 });
});

test("music under speech: placed under the edit from the timeline button, lowered under speech in the preview", async () => {
  await win.locator(`.tl-toolbar .icon-btn[title="موسيقى تحت الكلام"]`).click();
  await win.waitForSelector(".modal >> text=أصوات المشروع");
  await win.locator(".modal .list-row", { hasText: "music" }).click();
  await win.locator(".modal button", { hasText: "حطها تحت الكلام" }).click();
  await win.waitForFunction(() => window.__montaj.timeline().tracks.some((t) => t.role === "music" && t.segments.length));
  const t = (await tl()).tracks.find((x) => x.role === "music");
  const bed = t.segments[0];
  assert.equal(bed.start, 0);
  const end = Math.max(...(await tl()).tracks.find((x) => x.isMain).segments.map((x) => x.start + x.duration));
  assert.equal(bed.duration, end, "covers the whole edit, cut to it");
  assert.ok(bed.fadeInUs > 0 && bed.fadeOutUs > 0, "fades");
  assert.ok(bed.volumeDb < -5, `measured level ${bed.volumeDb} dB under the speech`);
  const speech = await api("musicbed.speech", (await tl()).id);
  assert.ok(speech.spans.length >= 2, `speech found by its sound (${JSON.stringify(speech.spans)})`);
  assert.equal(Object.values(speech.sources).filter(Boolean)[0], "vad");
  // The preview's gain of the music: under a word vs between phrases (fades kept out of both points).
  const gains = await win.evaluate(async (id) => {
    const p = window.__montaj.player;
    const at = async (us) => { p.seek(us); for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 60)); p.render(); } const v = p.audios.get(id); return v.gain ? v.gain.gain.value : v.el.volume; };
    return { under: await at(4.5 * 1e6), between: await at(5.68 * 1e6) };
  }, bed.id);
  const db = 20 * Math.log10(gains.under / gains.between);
  assert.ok(Math.abs(db + 12) < 1, `lowered ${db.toFixed(2)} dB under speech (${JSON.stringify(gains)})`);
  // The inspector of the music clip: the section is on, with its amount.
  await win.evaluate((id) => window.__montaj.ed.select([id]), bed.id);
  await win.waitForSelector(".inspector >> text=موسيقى تحت الكلام");
  await win.screenshot({ path: path.join(ART, "music-bed.png") });
});

test("graphics fields in Arabic with a picture picker; Calibri in the fonts", async () => {
  const r = await api("graphics.add", (await tl()).id, { template: "photo-card", atUs: 0, durationUs: 2 * S });
  await win.evaluate(() => window.__montaj.ed.reloadTimeline());
  const g = (await tl()).tracks.flatMap((t) => t.segments).find((s) => s.text?.graphic?.template === "photo-card");
  assert.ok(g, JSON.stringify(r).slice(0, 300));
  await win.evaluate((id) => window.__montaj.ed.select([id]), g.id);
  await win.waitForSelector(".inspector >> text=الصورة أو الملف");
  const text = await win.locator(".inspector").textContent();
  assert.doesNotMatch(text, /Picture \(a file or a media:\/\/ link\)/, "no English title left for src");
  await win.locator(".inspector button", { hasText: "اختار" }).first().click();
  await win.waitForSelector(".modal >> text=من الجهاز…");
  await win.keyboard.press("Escape");
  // A text clip: Calibri in its font list.
  const id = (await exec("addSegment", { kind: "text", atUs: 0, durationUs: 2 * S })).result;
  await win.evaluate((x) => window.__montaj.ed.select([x]), id);
  await win.waitForFunction(() => [...document.querySelectorAll(".inspector select option")].some((o) => o.textContent === "Cairo"));
  const fonts = await win.locator(".inspector select option").allTextContents();
  assert.ok(fonts.includes("Calibri"), "Calibri in the font list");
});

test("library browsers and settings open; the music studio's cover path lists its styles", async () => {
  await win.locator(`.tl-toolbar .icon-btn[title="مكتبة الأصوات"]`).click();
  await win.waitForSelector(".modal >> text=مكتبة الأصوات");
  await win.keyboard.press("Escape");
  await win.locator(`.tl-toolbar .icon-btn[title="بحث البي-رول"]`).click();
  await win.waitForSelector(".modal >> text=بحث البي-رول");
  await win.keyboard.press("Escape");
  await win.evaluate(() => window.__montaj.ed.openSettings("draft"));
  await win.waitForSelector(".modal >> text=فولدر مكتبة الأصوات والبي-رول");
  await win.waitForSelector(".modal >> text=قص الشخص");
  await win.keyboard.press("Escape");
  await win.evaluate(() => window.__montaj.ed.app.go("home", { view: "music" }));
  await win.waitForSelector(".music .mu-step");
  await win.locator(".music .suite-card", { hasText: "إعادة توزيع / كافر" }).click();
  await win.waitForFunction(() => document.querySelectorAll(".music .mu-card").length === 27);
  const t3 = await win.locator(".music").textContent();
  for (const w of ["عربي", "تركي", "عالمي", "كلاسيك", "حديث", "فخم", "سرعة الأصل"]) assert.ok(t3.includes(w), w);
  assert.equal((await api("music.status")).engine.running, false, "opening the cover path starts nothing");
  await win.screenshot({ path: path.join(ART, "music-cover.png"), fullPage: true });
  assert.deepEqual(errors, []);
});
