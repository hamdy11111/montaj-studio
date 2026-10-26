// Round 4 (audio-export) in the real app, no GPU: media://libfile serves the libraries' own files only (a sound of the
// sound library, a B-roll keyframe, the video the index lists, with Range for seeking) and refuses the rest; the sound
// browser plays a sound before it is added; the B-roll browser shows a shot's keyframe and plays exactly its span.
// The libraries are temporary folders in the default library place; the B-roll search itself (GPU models) is replaced
// by a fixed answer, everything after it is the app's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-libprev-"));
const LIB = path.join(ud, "library", "assets-library");
const F = {
  sound: path.join(LIB, "sfx", "files", "test", "knock.wav"),
  keyframe: path.join(LIB, "broll-index", "frames", "k1", "0000_1.jpg"),
  video: path.join(ud, "footage", "شارع.mp4"),
  other: path.join(ud, "footage", "other.mp4"),
  secret: path.join(ud, "outside", "secret.wav"),
};
let app, win;
const errors = [];

before(async () => {
  const ff = binaries().ffmpeg;
  for (const f of Object.values(F)) fs.mkdirSync(path.dirname(f), { recursive: true });
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=1:sample_rate=48000", F.sound]);
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=200:duration=1", F.secret]);
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", F.video], { timeoutMs: 120_000 });
  fs.copyFileSync(F.video, F.other);
  await run(ff, ["-hide_banner", "-y", "-ss", "3", "-i", F.video, "-frames:v", "1", F.keyframe]);
  fs.writeFileSync(path.join(LIB, "sfx", "library.json"), JSON.stringify({ version: 1, sounds: [{ id: "t-knock", source: "test", title: "knock knock test", file: "files/test/knock.wav", category: "foley", license: "CC0", stats: { durationS: 1 } }] }));
  fs.writeFileSync(path.join(LIB, "broll-index", "shots.json"), JSON.stringify({ version: 1, media: { k1: { path: F.video, durationS: 6 } }, shots: [{ id: "k1-0", mediaKey: "k1", startS: 2, endS: 4, frames: ["frames/k1/0000_1.jpg", "frames/k1/0000_1.jpg"] }] }));
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1", MONTAJ_BENCH: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack}`));
  win.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|status of 40[35]/.test(m.text())) errors.push(m.text()); });
  await win.waitForSelector(".home");
  await win.evaluate(() => window.api.call("settings.set", "general", { onboarded: true }));
  const project = await win.evaluate(() => window.api.call("project.create", { name: "libprev" }));
  await win.reload(); await win.waitForSelector(".home");
  await win.locator(`.proj-card[title="${project.name}"]`).click();
  await win.waitForSelector(".editor");
});
after(async () => { await app?.close().catch(() => {}); try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

/** fetch() a media://libfile URL from the renderer (the browsers' own encoder). */
const fetchLib = (file, init = {}) => win.evaluate(async ([f, i]) => {
  const { libFileUrl } = await import("./js/editor/libraryBrowsers.js");
  const r = await fetch(libFileUrl(f), i);
  return { status: r.status, type: r.headers.get("content-type"), range: r.headers.get("content-range"), bytes: (await r.arrayBuffer()).byteLength };
}, [file, init]);

test("media://libfile: the libraries' files are served (with Range), anything else is refused", async () => {
  const sound = await fetchLib(F.sound);
  assert.equal(sound.status, 200); assert.equal(sound.type, "audio/wav"); assert.equal(sound.bytes, fs.statSync(F.sound).size);
  const key = await fetchLib(F.keyframe);
  assert.equal(key.status, 200); assert.equal(key.type, "image/jpeg");
  const vid = await fetchLib(F.video, { headers: { Range: "bytes=0-99" } });
  assert.equal(vid.status, 206, "a listed video (Arabic name) with Range"); assert.equal(vid.bytes, 100);
  assert.equal((await fetchLib(F.other)).status, 403, "an unlisted video next to it");
  assert.equal((await fetchLib(F.secret)).status, 403, "a file outside the libraries");
  assert.equal((await fetchLib(path.join(LIB, "sfx", "..", "..", "..", "outside", "secret.wav"))).status, 403, "traversal");
  assert.equal((await fetchLib(path.join(LIB, "sfx", "library.json"))).status, 403, "not a picture, sound or video");
  assert.equal((await fetchLib(F.sound, { method: "POST", body: "x" })).status, 405, "read-only");
  assert.equal(await win.evaluate(async () => (await fetch("media://libfile/" + btoa("relative.wav").replace(/=+$/, ""))).status), 403);
});

test("the sound browser plays a sound before it is added", async () => {
  await win.evaluate(async () => { const m = await import("./js/editor/libraryBrowsers.js"); m.openSoundLibrary(window.__montaj.ed); });
  const modal = win.locator(".modal").last();
  await modal.locator('input[type="search"]').fill("knock");
  await modal.locator('input[type="search"]').press("Enter");
  const listen = modal.locator(".list-row .icon-btn").first();
  await listen.waitFor();
  await listen.click();
  await win.waitForFunction(() => document.querySelector(".modal .list-row .icon-btn.active"), null, { timeout: 5000 });
  // The 1 s sound ends by itself and the button goes back.
  await win.waitForFunction(() => !document.querySelector(".modal .list-row .icon-btn.active"), null, { timeout: 8000 });
  assert.equal(await win.locator(".toast").filter({ hasText: /can't be previewed|مش بيتعرض/ }).count(), 0);
  // Stopped by a second click.
  await listen.click();
  await win.waitForFunction(() => document.querySelector(".modal .list-row .icon-btn.active"));
  await listen.click();
  assert.equal(await win.locator(".modal .list-row .icon-btn.active").count(), 0);
  await win.keyboard.press("Escape");
});

test("the B-roll browser shows the shot's keyframe and plays exactly its span", async () => {
  await win.evaluate(async ([video, frame]) => {
    const m = await import("./js/editor/libraryBrowsers.js");
    m.openBrollSearch(window.__montaj.ed, { search: async () => [{ id: "k1-0", mediaKey: "k1", path: video, startS: 2, endS: 4, frames: [frame, frame], caption: "test street" }] });
  }, [F.video, F.keyframe]);
  const modal = win.locator(".modal").last();
  await modal.locator('input[type="search"]').fill("street");
  await modal.locator('input[type="search"]').press("Enter");
  const thumb = modal.locator(".lb-thumb img");
  await thumb.waitFor();
  await win.waitForFunction(() => document.querySelector(".modal .lb-thumb img")?.naturalWidth > 0, null, { timeout: 5000 });
  await modal.locator(".lb-thumb").click();
  const seen = await win.evaluate(async () => {
    const v = document.querySelector(".modal video.lb-preview");
    const times = [];
    for (let i = 0; i < 60 && times.length < 200; i++) { await new Promise((r) => setTimeout(r, 100)); times.push(v.currentTime); if (v.paused && v.currentTime > 2.5) break; }
    return { shown: getComputedStyle(v).display !== "none", first: times.find((x) => x > 0), last: v.currentTime, paused: v.paused, w: v.videoWidth };
  });
  assert.ok(seen.shown && seen.w === 320, "the preview shows the shot's video");
  assert.ok(seen.first >= 1.95 && seen.first < 2.8, `starts at the shot's start (${seen.first})`);
  assert.ok(seen.paused && seen.last >= 3.95 && seen.last < 4.4, `stops at its end (${seen.last})`);
  await win.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});
