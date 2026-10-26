// Sample videos of the graphics layer: one per component family (and the Arabic fonts, the extras, the VFX library),
// vertical on the user's own footage and horizontal on the interview — the raw files are read in place, never copied.
// Each graphic is rendered transparent by the Remotion layer and composited with FFmpeg the way the export does
// (tints multiplied, VFX screened/added). Writes <out>/<name>.mp4 + a contact sheet + README.md (what is when).
// Run: node tests/bench/graphicsSamples.mjs "D:\capcut new\montaj-bench\النتائج\graphics"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphicsRenderer } from "../../src/graphics/render.js";
import { KIT_TEMPLATES, kitParams } from "../../src/core/graphicsKit.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { lottieFor, animatedFor } from "../../src/graphics/emoji.js";
import { VfxLibraryService } from "../../src/services/vfxLibraryService.js";

const OUT = process.argv[2] || "D:\\capcut new\\montaj-bench\\النتائج\\graphics";
const CASES = "D:\\capcut new\\montaj-bench\\الحالات";
const SRC = { comedy: `${CASES}\\06-كوميديا\\خام\\IMG_2705.MP4`, vlog: `${CASES}\\01-فلوق\\خام\\IMG_3039.MP4`, cooking: `${CASES}\\03-طبخ\\خام\\IMG_6682.MP4`, interview: `${CASES}\\04-مقابلة\\خام\\1026.mp4` };
const ff = binaries().ffmpeg, FPS = 30;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-gfx-samples-"));
fs.mkdirSync(OUT, { recursive: true });
const r = new GraphicsRenderer({ cacheDir: path.join(tmp, "cache") });

/** A still of the source at t seconds (for photo cards, phones, CCTV walls, freezes). */
async function still(src, t, name, W, H) {
  const f = path.join(tmp, `${name}.png`);
  await run(ff, ["-hide_banner", "-v", "error", "-y", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, f], { timeoutMs: 60_000 });
  return f;
}

/**
 * One sample: items [{ template, params, sec, blend? }] one after another over the source from `at` seconds.
 * Returns the README lines.
 */
async function sample(name, srcKey, at, W, H, items) {
  if (!want(name)) return [];
  let from = 0;
  const seq = items.map((it) => { const n = Math.round(it.sec * FPS); const x = { template: it.template, params: kitParams(it.template, it.params || {}), from, durationInFrames: n, blend: it.blend || KIT_TEMPLATES[it.template].blend?.(kitParams(it.template, it.params || {})) || "normal" }; from += n; return x; });
  const total = from / FPS;
  const layer = async (list, file) => r.renderTo({ composition: "Sheet", props: { items: list.map(({ blend, ...x }) => x), pack: "punchy" }, width: W, height: H, fps: FPS, durationInFrames: from, out: file });
  const normal = seq.filter((x) => x.blend === "normal"), multiply = seq.filter((x) => x.blend !== "normal");
  const t0 = Date.now();
  const gfx = path.join(tmp, `${name}.mov`), tint = path.join(tmp, `${name}-tint.mov`);
  await layer(normal, gfx);
  if (multiply.length) await layer(multiply, tint);
  const renderSec = (Date.now() - t0) / 1000;
  const base = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p,setsar=1[b]`;
  const chains = [base, `[1:v]format=rgba[g]`];
  let last = "b";
  if (multiply.length) { // a tint layer multiplies the picture: transparent areas = white
    chains.push(`color=c=white:s=${W}x${H}:r=${FPS}:d=${total}[w]`, `[2:v]format=rgba[t]`, `[w][t]overlay=format=auto,format=gbrp[tw]`, `[b]format=gbrp[bg]`, `[bg][tw]blend=all_mode=multiply,format=yuv420p[m]`);
    last = "m";
  }
  chains.push(`[${last}][g]overlay=format=auto,format=yuv420p[v]`);
  const out = path.join(OUT, `${name}.mp4`);
  await run(ff, ["-hide_banner", "-v", "error", "-y", "-ss", String(at), "-t", String(total), "-i", SRC[srcKey], "-i", gfx, ...(multiply.length ? ["-i", tint] : []), "-filter_complex", chains.join(";"), "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", out], { timeoutMs: 600_000 });
  // Contact sheet: one frame in the middle of each graphic.
  const shots = [];
  for (const [i, x] of seq.entries()) {
    const f = path.join(tmp, `${name}-${i}.png`);
    await run(ff, ["-hide_banner", "-v", "error", "-y", "-ss", ((x.from + x.durationInFrames * 0.55) / FPS).toFixed(3), "-i", out, "-frames:v", "1", "-vf", `scale=${W > H ? 480 : 270}:-2`, f], { timeoutMs: 60_000 });
    shots.push(f);
  }
  const cols = W > H ? 4 : 6;
  await run(ff, ["-hide_banner", "-v", "error", "-y", ...shots.flatMap((s) => ["-i", s]), "-filter_complex", `${shots.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=${shots.length}:layout=${shots.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => "w0").join("+") : "0"}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+") : "0"}`).join("|")}:fill=black`, "-frames:v", "1", path.join(OUT, `${name}-sheet.png`)], { timeoutMs: 120_000 }).catch(() => {});
  return [`## ${name}.mp4 (${W}×${H}, ${total.toFixed(1)} s, rendered in ${renderSec.toFixed(1)} s)`, `On \`${path.basename(SRC[srcKey])}\` from ${at} s.`, "", ...seq.map((x) => `- ${(x.from / FPS).toFixed(1)} s — \`${x.template}\` (${KIT_TEMPLATES[x.template].ar})${x.blend !== "normal" ? ` · blend ${x.blend}` : ""}`), ""];
}

/** VFX library sample: clips blended over the cooking video, each with its own mode. */
async function vfxSample(name, W, H) {
  if (!want(name)) return [];
  const v = new VfxLibraryService();
  const idx = await v.load();
  const pick = (cat) => idx.items.find((i) => i.category === cat && i.overlay);
  const clips = ["action", "drama", "transitions", "comedy", "kitchen"].map(pick).filter(Boolean);
  const sec = 2.5, lines = [`## ${name}.mp4 (${W}×${H}) — VFX library over the cooking video`, ""];
  const parts = [];
  for (const [i, it] of clips.entries()) {
    const f = path.join(tmp, `${name}-${i}.mp4`);
    const mode = { add: "addition", screen: "screen", multiply: "multiply" }[it.blend] || "normal";
    const fx = it.background === "green" ? `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},chromakey=${(it.chroma?.color || "#00ff00").replace("#", "0x")}:0.15:0.08,format=rgba[x];[a][x]overlay=format=auto[v]`
      : `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=gbrp[x];[a]format=gbrp[ag];[ag][x]blend=all_mode=${mode},format=yuv420p[v]`;
    await run(ff, ["-hide_banner", "-v", "error", "-y", "-ss", String(20 + i * 3), "-t", String(sec), "-i", SRC.cooking, "-stream_loop", "-1", "-t", String(sec), "-i", v.file(it), "-filter_complex", `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p[a];${fx}`, "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", f], { timeoutMs: 300_000 });
    parts.push(f);
    lines.push(`- ${(i * sec).toFixed(1)} s — ${it.category}: «${it.title}» (${it.license}) · ${it.background} background → ${it.blend}`);
  }
  const list = path.join(tmp, `${name}.txt`);
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  await run(ff, ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", path.join(OUT, `${name}.mp4`)], { timeoutMs: 120_000 });
  return [...lines, ""];
}

const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const want = (n) => !ONLY || ONLY.some((o) => n.startsWith(o));
const readme = ["# Graphics layer samples (phase 3)", "", "Every graphic below is a Remotion component rendered transparent by the app's graphics layer and composited with FFmpeg like the export. Raw footage read in place.", ""];
try {
  const V = [1080, 1920], Hz = [1920, 1080];
  const photo = await still(SRC.vlog, 30, "photo", 800, 800), phone = await still(SRC.vlog, 60, "phone", 540, 1100), freeze = await still(SRC.comedy, 43, "freeze", 1080, 1920);
  const cctv = await Promise.all([10, 25, 40, 55, 70, 85].map((t, i) => still(SRC.vlog, t, `cctv${i}`, 640, 360)));
  readme.push(...await sample("01-punchy-vertical", "comedy", 40, ...V, [
    { template: "streak", params: { word: "يلا!" }, sec: 0.6 },
    { template: "kinetic-word", params: { text: "مفيهاش | فراخ!!", hi: "فراخ!!", y: 0.3 }, sec: 1.8 },
    { template: "title-card", params: { l1: "تحدي", l2: "الـ٢٠ كيلو", kicker: "يوم الخبيز 🔥", sub: "مين هيخلص الأول؟" }, sec: 3.8 },
    { template: "photo-card", params: { src: photo, label: "الماركت", x: 0.3, y: 0.16, rot: -6 }, sec: 3 },
    { template: "chapter-banner", params: { tag: "الفصل التاني", text: "المقلب الكوري", emoji: "😈" }, sec: 3.2 },
    { template: "freeze-fx", params: { still: freeze }, sec: 1.1 },
    { template: "slam-stamp", params: { text: "مفيهاش فراخ!!", y: 0.35 }, sec: 1.6 },
    { template: "name-tag", params: { name: "ماما", role: "المسؤولة", x: 0.5, y: 0.18 }, sec: 2.5 },
    { template: "joke-math", params: { title: "حسبة ماما", lines: ["٥ علب", "العلبة تكفي ٣–٤", "الواحد فينا = ٢ 😂"], times: [400, 1400, 2600] }, sec: 4.5 },
    { template: "weather-swap", params: { text: "أخيراً الشمس طلعت!" }, sec: 2.6 },
    { template: "confetti", sec: 1.8 },
    { template: "speed-lines", sec: 1 },
  ]));
  readme.push(...await sample("02-numbers-vertical", "vlog", 20, ...V, [
    { template: "counter-roll", params: { to: 20, suffix: " كيلو", label: "عيش في يوم واحد" }, sec: 2.4 },
    { template: "delta-pill", params: { text: "-٨٠ جنيه", kind: "loss", x: 0.5, y: 0.4 }, sec: 1.8 },
    { template: "impact-number", params: { text: "٤٫٣ مليون", sub: "سعرة!" }, sec: 1.6 },
    { template: "progress-hud", params: { label: "فاضل", value: 15, prev: 5, max: 20, unit: "كيلو" }, sec: 3 },
    { template: "corner-hud", params: { text: "اليوم ٣", corner: "tl", pulse: 900, icon: "📅" }, sec: 2.5 },
    { template: "timer-hud", params: { from: 5 }, sec: 5.6 },
    { template: "chapter-card", params: { text: "اليوم ٣", sub: "التحدي الأخير" }, sec: 2 },
    { template: "compare-gauge", params: { leftLabel: "حمدي", leftValue: 57, rightLabel: "وفاء", rightValue: 60 }, sec: 3 },
    { template: "list-montage", params: { title: "اشترينا", items: ["١٠٥ رغيف", "٣٤ علبة", "٩٦ عصير"], times: [300, 1100, 1900] }, sec: 3.6 },
  ]));
  readme.push(...await sample("03-story-vertical", "vlog", 60, ...V, [
    { template: "flashback", params: { label: "من ٩٥ يوم…" }, sec: 3 },
    { template: "cctv-wall", params: { stills: cctv }, sec: 3 },
    { template: "phone-frame", params: { src: phone, title: "ماما بعتت!" }, sec: 3 },
    { template: "narrator-card", params: { text: "وبعد ٣ ساعات عجن…" }, sec: 2.5 },
    { template: "tint-fx", params: { kind: "night" }, sec: 2 },
    { template: "tint-fx", params: { kind: "red" }, sec: 1.6 },
  ]));
  readme.push(...await sample("04-arabic-text-vertical", "vlog", 90, ...V, [
    { template: "word-reveal", params: { text: "الفكرة كلها في التوقيت", font: "Alexandria", mode: "words", emphasis: ["التوقيت"] }, sec: 2.6 },
    { template: "word-reveal", params: { text: "الحروف موصولة في كل فريم", font: "Cairo", mode: "wipe", weight: 900 }, sec: 2.6 },
    { template: "word-reveal", params: { text: "كشف بالكلمة مش بالحرف", font: "Tajawal", mode: "pop", weight: 900, emphasis: ["بالكلمة"] }, sec: 2.6 },
    { template: "word-reveal", params: { text: "خط كاليبري العريض بالعربي", font: "Calibri", mode: "words", weight: 700, box: true }, sec: 2.6 },
    { template: "word-reveal", params: { text: "جملة أطول شوية عشان نشوف السطر بيتكسر بين الكلمات بس", font: "Alexandria", mode: "words", size: 0.9 }, sec: 3.2 },
  ]));
  readme.push(...await sample("05-extras-vertical", "comedy", 70, ...V, [
    { template: "hand-drawn", params: { type: "circle", x: 0.3, y: 0.42, w: 0.4, h: 0.12, label: "بص هنا 👀" }, sec: 2.2 },
    { template: "hand-drawn", params: { type: "highlight", x: 0.15, y: 0.6, w: 0.7, h: 0.06, label: "" }, sec: 1.8 },
    { template: "gsap-title", params: { text: "سر المونتاج الخارق", sub: "من غير ولا مؤثر رخيص" }, sec: 3 },
    { template: "path-arrow", params: { label: "هنا!" }, sec: 2 },
    { template: "shape-burst", params: { text: "جديد!" }, sec: 1.8 },
    { template: "lottie-sticker", params: { emoji: "😂", src: lottieFor("😂") || "" }, sec: 2 },
    { template: "animated-emoji", params: { emoji: "fire", src: animatedFor("🔥")?.file || "" }, sec: 2 },
    { template: "swap-card", params: { before: "كنت فاكر", after: "طلع العكس!", transition: "wipe" }, sec: 3 },
  ]));
  readme.push(...await sample("06-mixed-horizontal", "interview", 30, ...Hz, [
    { template: "kinetic-word", params: { text: "واااو!", y: 0.3 }, sec: 1.6 },
    { template: "chapter-banner", params: { tag: "الجزء الأول", text: "البداية" }, sec: 3 },
    { template: "counter-roll", params: { to: 1500, suffix: " جنيه", label: "التكلفة" }, sec: 2.4 },
    { template: "name-tag", params: { name: "الضيف", role: "خبير", x: 0.7, y: 0.25 }, sec: 2.5 },
    { template: "compare-gauge", params: { leftLabel: "قبل", leftValue: 30, rightLabel: "بعد", rightValue: 85 }, sec: 3 },
    { template: "list-montage", params: { items: ["الفكرة", "التنفيذ", "النتيجة"], times: [200, 900, 1600] }, sec: 3 },
    { template: "word-reveal", params: { text: "المهم إنك تبدأ", emphasis: ["تبدأ"] }, sec: 2.5 },
    { template: "corner-hud", params: { text: "الجولة ٢", corner: "tr" }, sec: 2.5 },
    { template: "gsap-title", params: { text: "الخلاصة" }, sec: 2.5 },
  ]));
  readme.push(...await vfxSample("07-vfx-library-vertical", ...V));
  readme.push("Credits: animated emoji — Noto Emoji Animation by Google, CC BY 4.0. VFX clips — Mixkit (licence per clip above).");
  fs.writeFileSync(path.join(OUT, "README.md"), readme.join("\n"));
  console.log(readme.join("\n"));
} finally {
  await r.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
