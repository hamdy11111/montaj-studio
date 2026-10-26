// The Remotion graphics layer (phase 3): the kit and its contracts, the style pack, Arabic text rules, platform zones,
// sentence needs, eligibility, hard checks, the density guard, the export wiring — and, when the graphics runtime is
// installed (npm run setup:graphics && npm run build:graphics), a real render that is measured and composited.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { KIT_TEMPLATES, KIT_IDS, PUNCHY_COMPONENTS, EXTRA_COMPONENTS, kitParams, kitBox, kitTexts, kitBlend, kitCrop, isRemotionTemplate } from "../../src/core/graphicsKit.js";
import { GRAPHIC_TEMPLATES, graphicStates, graphicParams } from "../../src/core/graphics.js";
import { PACKS, PACK_SCHEMA, packOf, packSound } from "../../src/graphics/packs/index.js";
import { splitWords, splitLines, visibleChars, readSeconds, formatNumber, toArabicDigits, wordTimes, emphasisIndexes, normWord } from "../../src/graphics/arabic.js";
import { platformZones, safeRect, placeY, faceUnion, overlapArea, inside } from "../../src/graphics/layout.js";
import { sentenceNeeds } from "../../src/graphics/needs.js";
import { eligible, eligibleTemplates, fillParams, hardChecks, densityGuard, densityReport, planGraphics, frameCtx, rankNeed, clampParams, lengthFor, heuristicRanker, DENSITY } from "../../src/graphics/selection.js";
import { remotionSegments, assetRefs, segmentJob, jobKey, groupJobs, bandOf, touchesEdge, GraphicsRenderer } from "../../src/graphics/render.js";
import { alphaStats, measureAlpha, measureClip } from "../../src/graphics/measure.js";
import { graphicsRuntime } from "../../src/graphics/setup.js";
import { buildExport } from "../../src/core/exportGraph.js";
import { newTimeline, newSegment } from "../../src/core/model.js";
import * as ops from "../../src/core/timelineOps.js";
import { binaries, run } from "../../src/services/ffmpeg.js";

const US = 1_000_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..", "src");

/** Words of Arabic sentences at a steady pace: [[text, startSec]] → [{ text, startUs, endUs }]. */
function words(sents, per = 0.34) {
  const out = [];
  for (const [text, t0] of sents) text.split(" ").forEach((w, i) => out.push({ text: w, startUs: Math.round((t0 + i * per) * US), endUs: Math.round((t0 + i * per + per * 0.85) * US) }));
  return out;
}

// ───────── the kit ─────────

test("kit: 27 components from the skill + the official extras, all registered as remotion templates next to the 20 canvas ones", () => {
  assert.equal(PUNCHY_COMPONENTS.length, 27);
  for (const c of ["CounterRoll", "DeltaPill", "ImpactNumber", "CornerHUD", "ProgressHUD", "TimerHUD", "ChapterCard", "ChapterBanner", "Flashback", "CCTVWall", "PhoneFrame", "CompareGauge", "ListMontage", "NarratorCard", "KineticWord", "SlamStamp", "SpeedLines", "Confetti", "NameTag", "JokeMath", "FreezeFx", "TitleCard", "PhotoCard", "TintFx", "Streak", "WeatherSwap", "WordReveal"])
    assert.ok(PUNCHY_COMPONENTS.some((id) => KIT_TEMPLATES[id].component === c), c);
  assert.deepEqual(EXTRA_COMPONENTS.map((id) => KIT_TEMPLATES[id].component).sort(), ["AnimatedEmojiSticker", "GsapTitle", "HandDrawn", "LottieSticker", "PathArrow", "ShapeBurst", "SwapCard"]);
  const canvas = Object.keys(GRAPHIC_TEMPLATES).filter((id) => !isRemotionTemplate(id));
  assert.equal(canvas.length, 20, "the canvas templates are kept");
  for (const id of KIT_IDS) assert.equal(GRAPHIC_TEMPLATES[id], KIT_TEMPLATES[id]);
  // Every component named by the kit is exported by the React kit files.
  const jsx = ["punchy", "numbers", "text", "extras"].map((f) => fs.readFileSync(path.join(SRC, "graphics", "remotion", "kit", `${f}.jsx`), "utf8")).join("\n");
  for (const id of KIT_IDS) assert.match(jsx, new RegExp(`export const ${KIT_TEMPLATES[id].component}\\b`), id);
});

test("kit: defaults validate against each schema; contracts are complete; boxes stay in the frame on 9:16 and 16:9", () => {
  const ajv = new Ajv({ strict: false });
  for (const id of KIT_IDS) {
    const t = KIT_TEMPLATES[id];
    const schema = { type: "object", properties: t.params, additionalProperties: false };
    assert.ok(ajv.validate(schema, kitParams(id)), `${id}: ${ajv.errorsText()}`);
    assert.deepEqual(graphicParams({ template: id }), kitParams(id));
    const c = t.contract;
    assert.ok(c.tags.length && c.minSec > 0 && c.maxSec >= c.minSec && c.energy >= 1 && c.energy <= 5, id);
    assert.ok(t.durUs / US >= c.minSec - 1e-9 && t.durUs / US <= c.maxSec + 1e-9, `${id}: default length inside its contract`);
    for (const k of c.textKeys) assert.ok(t.params[k], `${id}: text key ${k}`);
    if (c.maxChars) for (const s of kitTexts(id)) assert.ok(visibleChars(s) <= Math.max(c.maxChars, 26), `${id}: default text fits`);
    for (const [W, H] of [[1080, 1920], [1920, 1080]]) {
      const b = kitBox(id, {}, W, H);
      assert.ok(b && b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, `${id} ${W}x${H}: ${JSON.stringify(b)}`);
    }
    assert.deepEqual(graphicStates({ template: id }, 3 * US, 30), [{ fromUs: 0, toUs: 3 * US, key: "remotion", tUs: 0 }]);
  }
  assert.equal(kitBlend("tint-fx", { kind: "night" }), "multiply");
  assert.equal(kitBlend("tint-fx", { kind: "dream" }), "screen");
  assert.equal(kitBlend("kinetic-word", {}), "normal");
});

// ───────── style pack ─────────

test("style pack: Punchy defines every role, its colours are hex, its sounds fall back to the app's bundled ones", () => {
  for (const pk of Object.values(PACKS)) for (const [group, keys] of Object.entries(PACK_SCHEMA)) for (const k of keys) assert.ok(pk[group]?.[k] !== undefined, `${pk.id}.${group}.${k}`);
  for (const c of Object.values(PACKS.punchy.colors)) assert.match(c, /^#[0-9A-F]{6}$/i);
  assert.equal(packOf("nope").id, "punchy");
  const appSfx = new Set(["whoosh", "swish", "riser", "pop", "blip", "sparkle", "ding", "click", "impact", "thud", "confirm"]);
  for (const role of Object.keys(PACKS.punchy.sounds)) assert.ok(packSound("punchy", role, (id) => appSfx.has(id)), `role ${role} has an app sound`);
  assert.equal(packSound("punchy", "stamp", (id) => appSfx.has(id)), "impact");
  assert.equal(packSound("punchy", "stamp", () => true), "boom");
  // Kit colour defaults are the pack's colours (the kit is drawn in the Punchy pack by default).
  assert.equal(KIT_TEMPLATES["slam-stamp"].params.color.default, PACKS.punchy.colors.alert);
  assert.equal(KIT_TEMPLATES["counter-roll"].params.color.default, PACKS.punchy.colors.accent);
  assert.equal(PACKS.punchy.family.noFlags, true);
});

// ───────── Arabic ─────────

test("arabic: split only between words (never inside one), lines, characters, reading time, digits, emphasis", () => {
  const s = "مفيهاش  فراخ!! يا جماعة";
  assert.deepEqual(splitWords(s), ["مفيهاش", "فراخ!!", "يا", "جماعة"]);
  assert.equal(splitWords(s).join(""), s.replace(/\s+/g, ""), "every letter stays in its word");
  assert.deepEqual(splitLines("سطر أول | سطر تاني"), ["سطر أول", "سطر تاني"]);
  assert.equal(visibleChars("مَرْحَبًا يا"), 7, "diacritics are not counted");
  assert.ok(readSeconds("كلمة") < readSeconds("جملة أطول بكتير من كلمة واحدة بس"));
  assert.equal(readSeconds(""), 0);
  assert.equal(formatNumber(1234.5, 1), "١٬٢٣٤٫٥");
  assert.equal(toArabicDigits("20 كيلو"), "٢٠ كيلو");
  assert.deepEqual(wordTimes(["a", "b", "c"], { times: [0, 500] , span: 1 }), [0, 0.5, 1]);
  assert.deepEqual(emphasisIndexes(["الفكرة", "كلها", "في", "التوقيت"], ["التوقيت"]), [3]);
  assert.deepEqual(emphasisIndexes(["الفكرة", "كلها", "في", "التوقيت"]), [3], "longest word when none is given");
  assert.equal(normWord("الإجابةُ"), "الاجابه");
  // The components never cut letters: no reveal splits a string with Array.from/split("") on display text.
  const jsx = ["punchy", "numbers", "text", "extras"].map((f) => fs.readFileSync(path.join(SRC, "graphics", "remotion", "kit", `${f}.jsx`), "utf8")).join("\n");
  assert.doesNotMatch(jsx, /text\.slice\(0, *n\)|\.split\(""\)|Array\.from\(P\.text/);
});

// ───────── layout ─────────

test("layout: platform block zones, the safe rectangle, placement away from the face", () => {
  const v = platformZones(1080, 1920);
  assert.deepEqual(v.platforms, ["reels", "tiktok", "shorts"]);
  const safe = safeRect(1080, 1920);
  assert.ok(Math.abs(safe.y - 150 / 1920) < 1e-6, "below the tallest top band (Reels 150 px)");
  assert.ok(Math.abs(safe.y + safe.h - 1580 / 1920) < 1e-6, "above the tallest bottom band (TikTok/Shorts 1580 px)");
  assert.ok(Math.abs(safe.x + safe.w - 900 / 1080) < 1e-6, "left of the widest button column (Reels 900 px)");
  const h = safeRect(1920, 1080);
  assert.ok(Math.abs(h.y + h.h - 0.9) < 1e-9 && h.x === 0);
  const face = { x: 0.3, y: 0.15, w: 0.4, h: 0.25 };
  const { y, forced } = placeY(0.1, "top", { safe, face });
  assert.ok(!forced && (y >= face.y + face.h || y + 0.1 <= face.y), `placed off the face: ${y}`);
  const fu = faceUnion([[0, 0.5, 0.3, 0.2, 0.2, 0, 1]]);
  assert.deepEqual(Object.values(fu).map((v) => Math.round(v * 1000) / 1000), [0.4, 0.2, 0.2, 0.2], "the app's person-track rows are read as face boxes");
});

// ───────── needs ─────────

const TALK = words([
  ["النهارده هنعمل تحدي العيش", 0],
  ["اشترينا ١٠٥ رغيف و٣٤ علبة و٩٦ عصير", 3],
  ["وخسرنا ٨٠ جنيه في الأكل", 7],
  ["فاكرين المرة اللي فاتت لما اتحرق كل حاجة", 10],
  ["ماما بعتتلي رسالة على الواتساب", 25],
  ["يا نهار أبيض مفيهاش فراخ!", 36],
  ["حمدي ٥٧٪ ووفاء ٦٠٪ مين أحسن من مين", 50],
  ["بالليل الجو برد والمطر نازل", 70],
]);

test("needs: numbers, lists, money and losses, memory, phone, peak, chapter, compare, weather from what is said", () => {
  const n = sentenceNeeds(TALK);
  const tags = (i) => n[i].tags;
  assert.ok(tags(0).includes("chapter") && tags(0).includes("hook"));
  assert.ok(tags(1).includes("list") && tags(1).includes("number") && n[1].list?.length === 3);
  assert.ok(tags(2).includes("delta") && tags(2).includes("money") && tags(2).includes("food"));
  assert.ok(tags(3).includes("memory"));
  assert.ok(tags(4).includes("phone") && tags(4).includes("name"));
  assert.ok(tags(5).includes("peak") && n[5].energy === 5);
  assert.ok(tags(6).includes("compare") && tags(6).includes("percent"));
  assert.ok(tags(7).includes("weather") && tags(7).includes("mood"));
  // The anchor of a number is the word that completes it (its unit/item), never earlier.
  const money = n[2].anchors.money;
  assert.equal(TALK[money.w].text, "جنيه");
});

// ───────── eligibility, filling, checks ─────────

test("eligibility: deterministic; a counter needs a number, a photo card needs a picture, energy must be close", () => {
  const n = sentenceNeeds(TALK);
  n.forEach((x, i) => { x.roomUs = (n[i + 1]?.startUs ?? 80 * US) - x.startUs; });
  assert.equal(eligible("counter-roll", n[3]).ok, false);
  assert.equal(eligible("counter-roll", n[1]).ok, true);
  assert.match(eligible("photo-card", n[2]).why, /picture/);
  assert.equal(eligible("photo-card", n[2], { hasImage: () => true }).ok, true);
  assert.match(eligible("tint-fx", { tags: ["mood"], energy: 5, roomUs: 9 * US }).why, /energy/);
  assert.match(eligible("joke-math", { tags: ["math"], energy: 3, roomUs: 1 * US }).why, /needs 3 s/);
  assert.deepEqual(eligibleTemplates(n[1]).map((x) => x.id), eligibleTemplates(n[1]).map((x) => x.id), "same answer every time");
  // Nothing is invented: no number → no counter parameters; no picture → no photo card.
  assert.equal(fillParams("counter-roll", n[3], TALK), null);
  assert.equal(fillParams("photo-card", n[2], TALK), null);
  assert.deepEqual(fillParams("list-montage", n[1], TALK).items, ["١٠٥ رغيف", "٣٤ علبة", "٩٦ عصير"]);
  assert.equal(fillParams("delta-pill", n[2], TALK).kind, "loss");
  assert.deepEqual(clampParams("counter-roll", { to: 5e12, dec: 2.7, color: "red", junk: 1 }), { to: 1e9, dec: 3 });
});

test("hard checks: entry within ±3 frames of its word, off the face, out of the platform zones, long enough to read", () => {
  const f = frameCtx({ width: 1080, height: 1920, fps: 30, faces: [{ x: 0.3, y: 0.12, w: 0.4, h: 0.2 }] });
  const base = { template: "kinetic-word", params: { text: "واااو!", y: 0.45 }, atUs: 5 * US, durUs: 1.6 * US, anchorUs: 5 * US };
  assert.equal(hardChecks(base, f).ok, true, JSON.stringify(hardChecks(base, f).checks));
  assert.equal(hardChecks(base, f, { entryFrame: 3 }).checks.sync.ok, true);
  const late = hardChecks(base, f, { entryFrame: 5 });
  assert.equal(late.checks.sync.ok, false);
  assert.equal(late.checks.sync.value, 5);
  assert.equal(hardChecks({ ...base, params: { text: "واااو!", y: 0.2 } }, f).checks.face.ok, false, "over the face");
  assert.equal(hardChecks({ ...base, params: { text: "واااو!", y: 0.88 } }, f).checks.safe.ok, false, "in the caption/buttons band");
  assert.equal(hardChecks({ ...base, template: "word-reveal", params: { text: "جملة طويلة شوية محتاجة وقت عشان تتقري كويس", y: 0.5 }, durUs: 1.2 * US }, f).checks.readable.ok, false);
  assert.equal(hardChecks({ ...base, template: "tint-fx", params: {} }, f).ok, true, "full-frame looks are exempt from face and zones");
  // Measured numbers replace the predictions.
  assert.equal(hardChecks(base, f, { entryFrame: 0, bbox: { x: 0.35, y: 0.15, w: 0.3, h: 0.1 } }).checks.face.ok, false);
  assert.equal(hardChecks(base, f, { entryFrame: 0, zonePixels: 900 }).checks.safe.ok, false);
});

test("placement moves a graphic off the face and keeps it in the safe area", async () => {
  const n = sentenceNeeds(TALK);
  n.forEach((x, i) => { x.roomUs = (n[i + 1]?.startUs ?? 80 * US) - x.startUs; });
  const fctx = frameCtx({ width: 1080, height: 1920, fps: 30, faces: [{ x: 0.25, y: 0.1, w: 0.5, h: 0.3 }] });
  const picks = await rankNeed(n[5], TALK, { fctx });
  assert.ok(picks.length >= 1 && picks.length <= 3);
  for (const p of picks) {
    assert.ok(p.checks.face.ok && p.checks.safe.ok && p.checks.sync.ok && p.checks.readable.ok, `${p.template} ${JSON.stringify(p.checks)}`);
    assert.equal(p.atUs, p.anchorUs, "enters on its word");
  }
});

test("ranker interface: an LLM-style ranker may only pick eligible templates; its parameters are clamped; 3 at most", async () => {
  const n = sentenceNeeds(TALK);
  n.forEach((x, i) => { x.roomUs = (n[i + 1]?.startUs ?? 80 * US) - x.startUs; });
  const calls = [];
  const ranker = async ({ need, candidates }) => {
    calls.push(candidates.map((c) => c.template));
    return [{ template: "not-a-template", score: 9 }, { template: "photo-card", score: 8 }, ...candidates.map((c, i) => ({ template: c.template, params: { size: 99 }, score: 5 - i }))];
  };
  const picks = await rankNeed(n[5], TALK, { ranker, fctx: frameCtx() });
  assert.ok(calls.length === 1 && !calls[0].includes("photo-card"));
  assert.ok(picks.length <= 3 && picks.every((p) => calls[0].includes(p.template)));
  for (const p of picks) if (KIT_TEMPLATES[p.template].params.size) assert.ok(p.params.size <= KIT_TEMPLATES[p.template].params.size.maximum);
  const h = await heuristicRanker({ need: n[1], candidates: [{ template: "list-montage" }, { template: "kinetic-word" }] });
  assert.equal(h[0].template, "list-montage");
});

// ───────── density ─────────

test("density guard: one major per 8 s at least, no repeat within 45 s, ≤ 40 % covered, a breath after a peak", () => {
  const it = (template, s, d, extra = {}) => ({ template, atUs: s * US, durUs: d * US, major: KIT_TEMPLATES[template].contract.major, energy: 3, score: 1, ...extra });
  const total = 60 * US;
  let r = densityGuard([it("kinetic-word", 0, 1.6, { score: 3 }), it("counter-roll", 5, 2, { score: 2 })], total);
  assert.equal(r.kept.length, 1);
  assert.match(r.dropped[0].why, /major graphic/);
  r = densityGuard([it("kinetic-word", 0, 1.6), it("kinetic-word", 20, 1.6)], total);
  assert.match(r.dropped[0].why, /within 45 s/);
  r = densityGuard([it("kinetic-word", 0, 1.6, { energy: 5, score: 3 }), it("name-tag", 2, 2)], total);
  assert.match(r.dropped[0].why, /breath/);
  const many = Array.from({ length: 12 }, (_, i) => it(i % 2 ? "narrator-card" : "tint-fx", i * 5, 4, { template: ["narrator-card", "tint-fx", "name-tag", "delta-pill", "weather-swap", "corner-hud"][i % 6] }));
  r = densityGuard(many.map((x, i) => ({ ...x, template: `${x.template}`, major: false })), total);
  assert.ok(r.coverage <= DENSITY.maxCoverage + 1e-9, `coverage ${r.coverage}`);
  const rep = densityReport(r.kept, total);
  assert.ok(rep.coverage <= 0.4 + 1e-9);
  // Persistent HUDs may sit under other graphics.
  r = densityGuard([it("progress-hud", 0, 20), it("kinetic-word", 5, 1.6)], 120 * US);
  assert.equal(r.kept.length, 2);
});

test("planGraphics: a whole talk → graphics that pass every hard check and the density rules", async () => {
  const total = 80 * US;
  const plan = await planGraphics(TALK, { width: 1080, height: 1920, fps: 30, totalUs: total, faces: [{ x: 0.3, y: 0.1, w: 0.4, h: 0.22 }] });
  assert.ok(plan.items.length >= 3, plan.items.map((i) => i.template).join(","));
  for (const i of plan.items) assert.ok(Object.values(i.checks).every((c) => c.ok), `${i.template}: ${JSON.stringify(i.checks)}`);
  const rep = densityReport(plan.items, total);
  assert.ok(rep.ok, rep.issues.join("; "));
  for (const alts of Object.values(plan.alternatives)) assert.ok(alts.length >= 1 && alts.length <= 3);
  const byNeed = Object.fromEntries(plan.items.map((i) => [i.needIndex, i.template]));
  assert.ok(["list-montage", "joke-math"].includes(byNeed[1]) || plan.dropped.some((d) => d.item.needIndex === 1), "the list gets a list graphic");
  for (const i of plan.items) assert.ok(i.durUs >= lengthFor(i.template, i.params) - 1);
});

// ───────── render + export wiring ─────────

test("render wiring: remotion segments of a timeline, their pictures, stable cache keys; exportGraph overlays the clip", () => {
  const tl = newTimeline("p", { width: 1080, height: 1920 });
  const seg = Object.assign(newSegment("text"), { start: 2 * US, duration: 1.5 * US, text: { content: "واو", graphic: { template: "photo-card", params: { src: "media://lib/abc", label: "الماركت" } } } });
  const old = Object.assign(newSegment("text"), { start: 0, duration: 1 * US, text: { content: "x", graphic: { template: "title-reveal", params: {} } } });
  ops.addSegment(tl, seg);
  ops.addSegment(tl, old);
  const rs = remotionSegments(tl);
  assert.deepEqual(rs.map((x) => x.template), ["photo-card"]);
  assert.deepEqual(assetRefs({ a: "media://lib/abc", b: ["D:\\x\\y.png", "hello"], c: { d: "/tmp/z.json" } }), ["media://lib/abc", "D:\\x\\y.png", "/tmp/z.json"]);
  const job = segmentJob(rs[0], { width: 1080, height: 1920, fps: 30 });
  assert.equal(job.durationInFrames, 45);
  assert.equal(jobKey(job, "1"), jobKey({ ...job }, "1"));
  assert.notEqual(jobKey(job, "1"), jobKey({ ...job, params: { ...job.params, label: "x" } }, "1"));
  assert.notEqual(jobKey(job, "1"), jobKey(job, "2"), "a rebuilt bundle renders again");
  const tl2 = newTimeline("p", { width: 1080, height: 1920 });
  ops.addSegment(tl2, Object.assign(newSegment("text"), { start: 1 * US, duration: 1.5 * US, text: { content: "واو", graphic: { template: "kinetic-word", params: {} } } }));
  const sid = tl2.tracks.flatMap((t) => t.segments)[0].id;
  const { graph, inputs } = buildExport(tl2, { media: {}, overlays: { [sid]: "C:/cache/abc.mov" }, width: 1080, height: 1920, fps: 30, mode: "video", caps: { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() }, video: { codec: "h264" }, audio: { enabled: false } });
  assert.ok(inputs.join(" ").includes("C:/cache/abc.mov"));
  assert.doesNotMatch(inputs.join(" "), /-loop 1 [^]*abc\.mov/, "a clip, not a looped still");
  assert.match(graph, /format=rgba,fps=30,setpts=PTS-STARTPTS\+30/, "starts at the segment's frame");
  // A banded clip is padded back to the full frame at its place.
  const banded = buildExport(tl2, { media: {}, overlays: { [sid]: { path: "C:/cache/abc.mov", x: 0, y: 300, w: 1080, h: 600 } }, width: 1080, height: 1920, fps: 30, mode: "video", caps: { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() }, video: { codec: "h264" }, audio: { enabled: false } });
  assert.match(banded.graph, /format=rgba,pad=1080:1920:0:300:color=black@0,fps=30/);
  // Bands: kinetic words are rendered as a band, full-frame looks as whole frames; groups by band height.
  const kw = segmentJob({ seg: { duration: US }, template: "kinetic-word", params: {}, pack: "punchy" }, { width: 1080, height: 1920, fps: 30 });
  assert.ok(kw.crop && kw.crop.w === 1080 && kw.crop.h < 1920 * 0.8 && kw.crop.h % 2 === 0);
  assert.equal(segmentJob({ seg: { duration: US }, template: "tint-fx", params: {}, pack: "punchy" }, { width: 1080, height: 1920, fps: 30 }).crop, null);
  const g = groupJobs([kw, { ...kw, crop: { ...kw.crop, h: 200 } }, { ...kw, crop: null }]);
  assert.equal(g.length, 3, "a whole frame, and two bands too different to share a render");
  assert.equal(groupJobs([kw, { ...kw, crop: { ...kw.crop, h: kw.crop.h - 10 } }]).length, 1, "close bands share one render");
  const b = bandOf({ ...kw, crop: { x: 0, y: 1800, w: 1080, h: 100 } }, 400);
  assert.ok(b.y + b.h <= 1920 && b.h === 400, "a band stays inside the frame");
  const edge = new Uint8Array(10 * 10); edge[5] = 255;
  assert.equal(touchesEdge({ frames: [edge], w: 10, h: 10 }, { y: 100, h: 10 }, 1920), true);
  assert.equal(touchesEdge({ frames: [edge], w: 10, h: 10 }, { y: 0, h: 10 }, 1920), false, "the frame's own edge is fine");
});

test("measure: alpha statistics of a frame and the first visible frame of a clip", () => {
  const w = 10, h = 10, blank = new Uint8Array(w * h), f = new Uint8Array(w * h);
  for (let y = 2; y < 4; y++) for (let x = 5; x < 9; x++) f[y * w + x] = 255;
  const st = alphaStats(f, w, h);
  assert.deepEqual(st.box, { x: 0.5, y: 0.2, w: 0.4, h: 0.2 });
  const m = measureAlpha({ frames: [blank, blank, f, f], w, h }, { fps: 30, zones: [{ x: 0, y: 0, w: 1, h: 0.25 }], faces: [{ x: 0.4, y: 0.2, w: 0.2, h: 0.2 }] });
  assert.equal(m.entryFrame, 2);
  assert.ok(m.zonePixels > 0);
  assert.equal(m.faceOverlap, 0.5);
});

const RT = graphicsRuntime();
test("real render (graphics runtime installed): a kit graphic renders transparent, enters on its frame and composites over video", { skip: !RT.ready && `graphics runtime missing: ${RT.missing.join(", ")}`, timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-gfx-"));
  const r = new GraphicsRenderer({ cacheDir: path.join(dir, "cache"), concurrency: 4 });
  try {
    const job = { template: "kinetic-word", params: kitParams("kinetic-word", { text: "مفيهاش فراخ!!", y: 0.45 }), pack: "punchy", width: 540, height: 960, fps: 30, durationInFrames: 30 };
    const res = await r.renderJob({ ...job, crop: kitCrop(job.template, job.params, 540, 960) });
    const clip = res.path;
    assert.ok(fs.statSync(clip).size > 1000);
    assert.ok(res.h < 960 && res.y > 0, `rendered as a band: ${JSON.stringify(res)}`);
    assert.deepEqual(await r.renderJob({ ...job, crop: kitCrop(job.template, job.params, 540, 960) }), res, "cached");
    // The band, padded back into the frame, is the same picture as a whole-frame render.
    const r2 = new GraphicsRenderer({ cacheDir: path.join(dir, "cache2"), concurrency: 4, bands: false });
    const whole = await r2.renderJob({ ...job, crop: null }).finally(() => r2.close());
    const pad = path.join(dir, "padded.mov");
    await run(binaries().ffmpeg, ["-hide_banner", "-y", "-i", clip, "-vf", `format=rgba,pad=540:960:0:${res.y}:color=black@0`, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", pad], { timeoutMs: 120_000 });
    const a = await measureClip(pad, { w: 135, h: 240, fps: 30 }), b = await measureClip(whole.path, { w: 135, h: 240, fps: 30 });
    assert.ok(a.coverage.every((c, i) => Math.abs(c - b.coverage[i]) < 0.002), "band == whole frame");
    const f = frameCtx({ width: 540, height: 960, fps: 30 });
    const m = await measureClip(clip, { w: 135, h: 240, band: res, W: 540, H: 960, fps: 30, inUs: 200_000, outUs: 140_000, zones: f.zones.block });
    assert.ok(m.entryFrame !== null && m.entryFrame <= 3, `entry ${m.entryFrame}`);
    assert.ok(m.bbox && m.bbox.y > 0.25 && m.bbox.y + m.bbox.h < 0.7, `box ${JSON.stringify(m.bbox)}`);
    assert.ok(m.zonePixels <= 400, `zone pixels ${m.zonePixels}`);
    // It lands on its word: frame 0 is the word's frame (the motion blur's samples reach at most one frame ahead),
    // and it holds afterwards.
    assert.ok(m.coverage[10] > 0.01 && m.coverage[20] > 0.01, "it holds");
    // Composite over a grey clip with FFmpeg as the exporter does and check the text is there.
    const out = path.join(dir, "comp.png");
    await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=gray:s=540x960:r=30:d=1", "-i", clip, "-filter_complex", "[1:v]format=rgba[g];[0:v][g]overlay=format=auto", "-ss", "0.6", "-frames:v", "1", out], { timeoutMs: 60_000 });
    assert.ok(fs.statSync(out).size > 5000);
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
