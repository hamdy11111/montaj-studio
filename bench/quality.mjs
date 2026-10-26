// تقرير جودة المونتاج — the editing-quality report of Phase 0 (PLAN_editor_and_graphics.md): it measures finished
// videos (never plans) and puts the app's edit next to the creator's own published edit.
//
//   node bench/quality.mjs <video> [--ref <published video>] [--out <folder>] [--name <title>]
//   node bench/quality.mjs --case "<...\montaj-bench\الحالات\01-فلوق>"   (المنشور\ is the reference; every video in
//                                                                     نتائج-البرنامج\ is measured against it)
//
// Writes <name>.quality.json and an Arabic HTML page. Numbers come from the video itself: shot changes (incl. jump
// cuts and punch-ins), shot lengths, pace per 10 s, dead air, the opening, visual stagnation and loudness.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measure, detectCuts } from "./lib/signals.mjs";
import { rawFiles, align } from "./align.mjs";

const VIDEO = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
const TARGETS_FILE = new URL("./targets.json", import.meta.url);

/** Every metric of one video. */
export function metrics(sig) {
  const D = sig.duration || 0;
  const cuts = detectCuts(sig.scores);
  const bounds = [0, ...cuts, D];
  const shots = [];
  for (let i = 1; i < bounds.length; i++) if (bounds[i] - bounds[i - 1] > 0.04) shots.push({ start: bounds[i - 1], end: bounds[i], len: bounds[i] - bounds[i - 1] });
  const lens = shots.map((s) => s.len).sort((a, b) => a - b);
  const q = (p) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(p * lens.length))] : 0);
  // Pace per 10 s: cuts in each window.
  const pace = [];
  for (let t = 0; t < D; t += 10) pace.push({ t, cuts: cuts.filter((c) => c >= t && c < t + 10).length });
  // Dead air: silences inside the video (not the very start/end), and those long enough to feel like "it ended".
  const inner = sig.silences.filter((s) => s.end > 0.3 && s.start < D - 0.3);
  const dead = inner.map((s) => ({ start: s.start, end: Math.min(s.end, D), len: Math.min(s.end, D) - s.start }));
  const firstSpeech = sig.silences.length && sig.silences[0].start <= 0.05 ? sig.silences[0].end : 0;
  // Visual stagnation: the longest stretch with no cut and almost no change in the picture.
  let still = 0, run = 0, prev = null;
  const cutSet = new Set(cuts.map((c) => c.toFixed(3)));
  for (const f of sig.scores) {
    const dt = prev === null ? 0 : f.t - prev;
    prev = f.t;
    if (f.s < 1.0 && !cutSet.has(f.t.toFixed(3))) { run += dt; still = Math.max(still, run); } else run = 0;
  }
  return {
    duration: round(D), size: `${sig.width}×${sig.height}`, fps: round(sig.fps),
    cuts: cuts.length, cutsPerMin: round(D ? (cuts.length / D) * 60 : 0),
    shot: { median: round(q(0.5)), p90: round(q(0.9)), longest: round(lens.at(-1) || 0), under4sPct: round(lens.length ? (100 * lens.filter((l) => l < 4).length) / lens.length : 0) },
    longestShotAt: round(shots.find((s) => s.len === lens.at(-1))?.start || 0),
    pace, paceMin: Math.min(...pace.map((p) => p.cuts)), paceMax: Math.max(...pace.map((p) => p.cuts)),
    deadAir: { count: dead.length, totalSec: round(dead.reduce((n, s) => n + s.len, 0)), over2s: dead.filter((s) => s.len >= 2).map((s) => ({ at: round(s.start), len: round(s.len) })) },
    opening: { firstSpeechSec: round(firstSpeech), cutsIn3s: cuts.filter((c) => c < 3).length },
    stillestSec: round(still),
    loudness: sig.loudness,
    cutTimes: cuts.map(round),
  };
}

const round = (x) => Math.round(x * 100) / 100;

/** The verdict of one metric against the targets (and against the reference edit when there is one). */
function judge(m, t) {
  const out = [];
  const add = (key, ok, text) => out.push({ key, ok, text });
  add("median", m.shot.median <= t.shotMedian.max, `وسيط اللقطة ${m.shot.median} ث (المرجع ≤ ${t.shotMedian.max} ث)`);
  add("dead", m.deadAir.over2s.length === 0, `سكوت ميت ≥ 2 ث: ${m.deadAir.over2s.length} مرة`);
  add("opening", m.opening.firstSpeechSec <= t.firstSpeech.max, `أول كلمة بعد ${m.opening.firstSpeechSec} ث (المرجع ≤ ${t.firstSpeech.max} ث)`);
  add("longest", m.shot.longest <= t.longestShot.max, `أطول لقطة ${m.shot.longest} ث عند ${m.longestShotAt} ث (المرجع ≤ ${t.longestShot.max} ث)`);
  add("still", m.stillestSec <= t.stillest.max, `أطول جمود في الصورة ${m.stillestSec} ث (المرجع ≤ ${t.stillest.max} ث)`);
  if (m.loudness) add("loud", Math.abs(m.loudness.i - t.loudness.target) <= t.loudness.tol, `العلو ${m.loudness.i} LUFS (المرجع ${t.loudness.target} ± ${t.loudness.tol})`);
  return out;
}

function targetsFor(duration) {
  const all = JSON.parse(fs.readFileSync(TARGETS_FILE, "utf8"));
  return duration <= all.shortMaxSec ? { kind: "short", ...all.short } : { kind: "long", ...all.long };
}

export async function report(file, { ref = null, out, name, raws = [] } = {}) {
  const m = metrics(await measure(file));
  const r = ref ? metrics(await measure(ref)) : null;
  const t = targetsFor(m.duration);
  fs.mkdirSync(out, { recursive: true });
  // The story: which raw parts this edit kept and in what order (only when the raw files are known).
  let story = null;
  if (raws.length) {
    try { story = await align(file, raws, path.join(out, `${name || path.basename(file).replace(/\.[^.]+$/, "")}.align.json`)); } catch (e) { story = { error: String(e.message || e).slice(0, 400) }; }
  }
  const result = { schema: "montaj-bench.quality/1", file, ref, measuredAt: new Date().toISOString(), targets: t, video: m, reference: r,
    verdict: judge(m, t), referenceVerdict: r ? judge(r, t) : null, story };
  const base = path.join(out, name || path.basename(file).replace(/\.[^.]+$/, ""));
  fs.writeFileSync(`${base}.quality.json`, JSON.stringify(result, null, 1));
  fs.writeFileSync(`${base}.quality.html`, html(result, name || path.basename(file)));
  return { ...result, html: `${base}.quality.html` };
}

function bars(pace, max) {
  return `<div class="bars">${pace.map((p) => `<span title="${p.t}–${p.t + 10} ث: ${p.cuts} قطع" style="height:${Math.round((p.cuts / Math.max(1, max)) * 100)}%"></span>`).join("")}</div>`;
}

function storyHtml(st) {
  if (!st) return "";
  if (st.error) return `<h2>القصة</h2><p class="bad">ما قدرتش أطابقه بالخام: ${st.error}</p>`;
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
  return `<h2>القصة: إيه اللي اتاخد من الخام وبأي ترتيب</h2>
<ul><li>اتطابق ${st.matchedPct}% من الفيديو مع الخام، والباقي موسيقى أو جرافيك أو صوت جديد.</li>
<li>اتاخد ${st.keptOfRawPct}% من الخام.</li>
<li>الترتيب: ${st.orderTau >= 0.95 ? "نفس ترتيب التصوير" : st.orderTau >= 0.5 ? "قريب من ترتيب التصوير مع شوية تقديم وتأخير" : "مترتب بشكل مختلف عن التصوير"} (معامل الترتيب ${st.orderTau}؛ 1 = نفس الترتيب).</li>
<li>البداية: ${st.openingFromRawPct !== null && st.openingFromRawPct > 25 ? `من جزء متأخر في الخام (${st.openingFromRawPct}% من طوله)، يعني بداية بالنتيجة أو بلحظة قوية` : "من أول الخام تقريبًا"}.</li></ul>
<table><tr><th>في الفيديو</th><th>من الخام</th><th>الملف</th><th>الثقة</th></tr>${st.segments.map((s) => `<tr><td>${mmss(s.pubStart)}–${mmss(s.pubEnd)}</td><td>${mmss(s.rawStart)}–${mmss(s.rawEnd)}</td><td><code>${s.rawName}</code></td><td>${s.conf}</td></tr>`).join("")}</table>`;
}

function html(r, title) {
  const m = r.video, f = r.reference;
  const row = (label, a, b = null) => `<tr><td>${label}</td><td>${a}</td>${f ? `<td>${b ?? "—"}</td>` : ""}</tr>`;
  const max = Math.max(m.paceMax, f?.paceMax || 0, 1);
  const v = (list) => list.map((x) => `<li class="${x.ok ? "ok" : "bad"}">${x.ok ? "✓" : "✗"} ${x.text}</li>`).join("");
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تقرير الجودة — ${title}</title>
<style>body{font-family:Tajawal,Cairo,Segoe UI,sans-serif;background:#0e1112;color:#e8eeee;max-width:980px;margin:24px auto;padding:0 16px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #243033;padding:6px 8px;text-align:start}
th{color:#7fd6dc;font-weight:600}.ok{color:#6fd38a}.bad{color:#ff8a7a}ul{list-style:none;padding:0}li{margin:4px 0}
.bars{display:flex;align-items:flex-end;gap:2px;height:70px;background:#151b1c;padding:4px;border-radius:6px;direction:ltr}.bars span{flex:1;background:#00c1cd;min-height:2px;border-radius:2px}
.muted{color:#8aa0a3;font-size:13px}code{direction:ltr;unicode-bidi:embed}</style>
<h1>تقرير جودة المونتاج: ${title}</h1>
<p class="muted">اتقاس من الفيديو نفسه في ${new Date(r.measuredAt).toLocaleString("ar-EG")}. المراجع: «${r.targets.kind === "short" ? "فيديو قصير" : "فيديو طويل"}» من مهارة edit-hamdy وقواعد الاحتفاظ.</p>
<h2>الحكم</h2><ul>${v(r.verdict)}</ul>
${f ? `<h2>مونتاجك المنشور</h2><ul>${v(r.referenceVerdict)}</ul>` : ""}
<h2>الأرقام</h2><table><tr><th>المقياس</th><th>الفيديو</th>${f ? "<th>مونتاجك المنشور</th>" : ""}</tr>
${row("المدة", `${m.duration} ث`, f && `${f.duration} ث`)}
${row("عدد القطعات", m.cuts, f?.cuts)}
${row("قطعات في الدقيقة", m.cutsPerMin, f?.cutsPerMin)}
${row("وسيط اللقطة", `${m.shot.median} ث`, f && `${f.shot.median} ث`)}
${row("90% من اللقطات أقصر من", `${m.shot.p90} ث`, f && `${f.shot.p90} ث`)}
${row("لقطات أقل من 4 ث", `${m.shot.under4sPct}%`, f && `${f.shot.under4sPct}%`)}
${row("أطول لقطة", `${m.shot.longest} ث`, f && `${f.shot.longest} ث`)}
${row("السكوت الميت", `${m.deadAir.count} مرة · ${m.deadAir.totalSec} ث`, f && `${f.deadAir.count} مرة · ${f.deadAir.totalSec} ث`)}
${row("أول كلمة", `${m.opening.firstSpeechSec} ث`, f && `${f.opening.firstSpeechSec} ث`)}
${row("قطعات في أول 3 ث", m.opening.cutsIn3s, f?.opening.cutsIn3s)}
${row("أطول جمود في الصورة", `${m.stillestSec} ث`, f && `${f.stillestSec} ث`)}
${row("العلو", m.loudness ? `${m.loudness.i} LUFS` : "—", f?.loudness ? `${f.loudness.i} LUFS` : "—")}
</table>
${storyHtml(r.story)}
<h2>الإيقاع كل 10 ثواني</h2><p class="muted">كل عمود = عدد القطعات في 10 ثواني.</p>${bars(m.pace, max)}${f ? `<p class="muted">مونتاجك المنشور:</p>${bars(f.pace, max)}` : ""}
${m.deadAir.over2s.length ? `<h2>أماكن السكوت الميت (≥ 2 ث)</h2><p>${m.deadAir.over2s.map((s) => `${s.at} ث (${s.len} ث)`).join(" · ")}</p>` : ""}
<p class="muted">ملاحظة: القطع بيتعرف من تغيّر الصورة، بما فيه الجامب كات والزوم. وحاجات زي الهوك والقصة وجودة الجرافيك بتتقاس في أدوات تانية.</p></html>`;
}

// ---- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const kase = opt("--case");
  if (kase) {
    const pub = path.join(kase, "المنشور");
    const refFile = fs.existsSync(pub) ? fs.readdirSync(pub).filter((f) => VIDEO.test(f)).map((f) => path.join(pub, f))[0] : null;
    const appDir = path.join(kase, "نتائج-البرنامج");
    const apps = fs.existsSync(appDir) ? fs.readdirSync(appDir).filter((f) => VIDEO.test(f)).map((f) => path.join(appDir, f)) : [];
    const out = opt("--out") || path.join(path.dirname(path.dirname(kase)), "النتائج", path.basename(kase));
    if (!refFile && !apps.length) { console.error("مفيش فيديو منشور ولا نتيجة للبرنامج في الحالة دي."); process.exit(2); }
    const raws = rawFiles(kase);
    if (refFile) { const r = await report(refFile, { out, name: "المنشور", raws }); console.log(r.html); }
    for (const f of apps) { const r = await report(f, { ref: refFile, out, raws }); console.log(r.html); }
  } else {
    const file = a.find((x) => !x.startsWith("--") && a[a.indexOf(x) - 1] !== "--ref" && a[a.indexOf(x) - 1] !== "--out" && a[a.indexOf(x) - 1] !== "--name");
    if (!file) { console.error("الاستخدام: node bench/quality.mjs <video> [--ref <published>] [--out <folder>] أو --case <folder>"); process.exit(2); }
    const r = await report(file, { ref: opt("--ref"), out: opt("--out") || path.dirname(file), name: opt("--name") });
    console.log(r.html);
  }
}
