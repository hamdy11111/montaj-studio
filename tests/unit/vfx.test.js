// The VFX/overlay library: background classification → blend mode, what a clip is for (contract tags/energy),
// deterministic picks, the segment patch that lays a clip over the picture, the Mixkit page parser, and the pack's
// emoji family files. No network; the index is built from generated clips (FFmpeg lavfi).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBackground, blendOf, kindOf, VfxLibraryService, VFX_CATEGORIES } from "../../src/services/vfxLibraryService.js";
import { parseMixkitVideoPage, licenseOf } from "../../src/services/vfxLibrary/fetch.js";
import { OVERLAY_WORDS, NOT_OVERLAY } from "../../src/services/vfxLibrary/sources.js";
import { emojiCode, isFlag, lottieFor, animatedFor } from "../../src/graphics/emoji.js";
import { binaries, run } from "../../src/services/ffmpeg.js";

const frame = (w, h, f) => { const b = Buffer.alloc(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(f(x, y), (y * w + x) * 3); return b; };

test("background → blend: black is screened (lights added), green keyed, white multiplied, footage left as it is", () => {
  const black = frame(64, 36, (x, y) => (Math.hypot(x - 32, y - 18) < 8 ? [250, 180, 40] : [4, 4, 4]));
  const green = frame(64, 36, (x, y) => (Math.hypot(x - 32, y - 18) < 10 ? [200, 50, 50] : [20, 220, 40]));
  const white = frame(64, 36, (x, y) => (Math.hypot(x - 32, y - 18) < 10 ? [10, 10, 10] : [250, 250, 250]));
  const foot = frame(64, 36, (x, y) => [100 + x, 90 + y, 120]);
  assert.equal(classifyBackground([black], 64, 36).bg, "black");
  const g = classifyBackground([green], 64, 36);
  assert.equal(g.bg, "green");
  assert.match(g.key, /^#[0-9a-f]{6}$/);
  assert.equal(classifyBackground([white], 64, 36).bg, "white");
  assert.equal(classifyBackground([foot], 64, 36).bg, "footage");
  // Big bright smoke over black: the source's words settle it.
  const smoke = frame(64, 36, (x) => (x < 50 ? [150, 150, 150] : [6, 6, 6]));
  assert.equal(classifyBackground([smoke], 64, 36).bg, "footage");
  assert.equal(classifyBackground([smoke], 64, 36, { saysBlack: true }).bg, "black");
  assert.equal(blendOf("black", kindOf("fire on black"), false), "add");
  assert.equal(blendOf("black", kindOf("grey smoke"), false), "screen");
  assert.equal(blendOf("white", kindOf("ink"), false), "multiply");
  assert.equal(blendOf("footage", kindOf("x"), true), "normal");
  assert.deepEqual(kindOf("Ball of fire blasting").tags.includes("peak"), true);
  assert.equal(kindOf("Explosion on black").energy, 5);
});

test("Mixkit pages: cards are read per card (asset id, title, page); licence from the item's data; people are not overlays", () => {
  const card = (id, slug, title, desc) => `<div class="item-grid-card" data-algolia-analytics-object-id="video-9${id}"><video src="https://assets.mixkit.co/videos/${id}/${id}-360.mp4"></video><span class="item-grid-video-player__overlay-video-title">${title}</span><span class="item-grid-video-player__overlay-video-description">${desc}</span><a href="/free-stock-video/${slug}-${id}/">x</a></div>`;
  const html = `<div>${card(52284, "flames", "Flames over a black backdrop", "Fire.")}${card(1243, "bonfire", "Fire &amp; wood", "A bonfire.")}</div>`;
  const c = parseMixkitVideoPage(html);
  assert.deepEqual(c.map((x) => [x.id, x.title, x.page]), [["52284", "Flames over a black backdrop", "https://mixkit.co/free-stock-video/flames-52284/"], ["1243", "Fire & wood", "https://mixkit.co/free-stock-video/bonfire-1243/"]]);
  assert.ok(OVERLAY_WORDS.test(c[0].title) && !OVERLAY_WORDS.test(c[1].title));
  assert.ok(NOT_OVERLAY.test("Ballerina wearing a tutu") && !NOT_OVERLAY.test("Smoke on a black background"));
  assert.equal(licenseOf('{"@type":"VideoObject","@id":"https://mixkit.co/x-45298/#video","copyrightNotice":"Mixkit Restricted License"}', "45298"), "mixkit-restricted");
  assert.equal(licenseOf('{"@type":"VideoObject","@id":"https://mixkit.co/x-1968/#video","copyrightNotice":"Free"}', "1968"), "mixkit-free");
});

test("the library: index built from the category folders, deterministic picks, the patch that blends a clip", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-vfx-"));
  try {
    const ff = binaries().ffmpeg;
    const mk = async (rel, src) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", src, "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, rel)], { timeoutMs: 60_000 }); };
    await mk("action/fire-on-black.mp4", "color=c=black:s=320x180:r=30,drawbox=x=120:y=60:w=80:h=60:color=orange:t=fill");
    await mk("drama/smoke-on-black.mp4", "color=c=black:s=320x180:r=30,drawbox=x=100:y=50:w=60:h=50:color=gray:t=fill");
    await mk("transitions/green-swoosh.mp4", "color=c=0x14DC28:s=320x180:r=30,drawbox=x=100:y=50:w=60:h=50:color=white:t=fill");
    await mk("comedy/street.mp4", "testsrc2=s=320x180:r=30");
    fs.writeFileSync(path.join(root, "sources.json"), JSON.stringify({ items: [{ id: "mixkit-1", category: "action", file: "action/fire-on-black.mp4", title: "Fire on a black background", source: "mixkit", license: "mixkit-free", url: "u" }] }));
    const v = new VfxLibraryService({ root });
    const idx = await v.buildIndex();
    assert.deepEqual(idx.categories, VFX_CATEGORIES);
    for (const c of VFX_CATEGORIES) assert.ok(fs.existsSync(path.join(root, c)), `folder ${c}`);
    const by = Object.fromEntries(idx.items.map((i) => [i.file, i]));
    assert.equal(by["action/fire-on-black.mp4"].blend, "add");
    assert.equal(by["action/fire-on-black.mp4"].id, "action/mixkit-1");
    assert.equal(by["action/fire-on-black.mp4"].license, "mixkit-free");
    assert.equal(by["drama/smoke-on-black.mp4"].blend, "screen");
    assert.equal(by["transitions/green-swoosh.mp4"].background, "green");
    assert.equal(by["comedy/street.mp4"].overlay, false);
    assert.ok(by["action/fire-on-black.mp4"].contract.tags.includes("peak") && Math.abs(by["action/fire-on-black.mp4"].durationUs - 2e6) < 1e5);
    const a = await v.pick({ tags: ["peak"], energy: 4 }), b = await v.pick({ tags: ["peak"], energy: 4 });
    assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
    assert.equal(a[0].id, "action/mixkit-1");
    assert.equal((await v.pick({ tags: ["peak"], energy: 4, avoid: ["action/mixkit-1"] }))[0]?.id === "action/mixkit-1", false);
    assert.equal((await v.pick({ tags: ["transition"] })).every((i) => i.overlay), true, "footage only when asked for");
    assert.deepEqual(v.segmentPatch(by["action/fire-on-black.mp4"]), { transform: { blend: "add" } });
    assert.equal(v.segmentPatch(by["transitions/green-swoosh.mp4"]).videoFx.chroma.enabled, true);
    // A re-scan reuses unchanged entries.
    const t0 = Date.now();
    await new VfxLibraryService({ root }).buildIndex();
    assert.ok(Date.now() - t0 < 2000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("emoji family: Noto codes, no flags, the files on disk when the library is present", () => {
  assert.equal(emojiCode("😂"), "1f602");
  assert.equal(emojiCode("❤️"), "2764_fe0f");
  assert.equal(isFlag("🇪🇬"), true);
  assert.equal(lottieFor("🇪🇬"), null);
  const lot = lottieFor("😂");
  if (lot) assert.match(lot, /noto-lottie[\\/]1f602\.json$/);
  const vid = animatedFor("🔥");
  if (vid) assert.equal(vid.name, "fire");
  assert.equal(animatedFor("🦄"), null);
});
