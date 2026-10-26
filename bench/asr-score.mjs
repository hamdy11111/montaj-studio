// مقارنة نماذج الكلام — scores each speech model's text against the user's reference transcription (Phase 0).
//
//   node bench/asr-score.mjs [--dir "<...\montaj-bench\النتائج\الكتابة>"] [--provisional]
//
// Reads reference.json (from the «اكتب الكلام» page) and every hyp\<model>.json ({ model, segments: [{ id, text }] },
// the same clips run through each model by bench/asr_all.py). Optional: names.txt (one name per line) and
// equivalences.txt (a = b). Only sentences the user marked «خلصت» count. Sentences tagged [غير مفهوم] or [متداخل] are
// scored apart; sentences tagged [مفيش كلام] measure invented words (hallucinations). Writes asr-scores.json and the
// Arabic page «مقارنة النماذج.html».
//
// Until reference.json exists (or has no «خلصت» sentence yet), or with --provisional, it writes the PROVISIONAL page
// «مقارنة مبدئية (مش دقة).html» + asr-agreement.json instead: how much the models agree with each other and with the
// Whisper draft. Agreement is not accuracy — models can agree on the same mistake, and the draft is itself a model.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, parseEquivalences, editOps } from "./lib/arabicNorm.mjs";

export function score(reference, hyps, { names = [], equivalences = [] } = {}) {
  const refSegs = reference.segments.filter((s) => s.status === "done");
  const kind = (t) => (/\[مفيش كلام\]/.test(t) ? "silence" : /\[(غير مفهوم|متداخل)\]/.test(t) ? "hard" : "clean");
  const normNames = names.map((n) => normalize(n, equivalences)).filter(Boolean);
  return hyps.map((h) => {
    const byId = new Map(h.segments.map((s) => [s.id, s.text || ""]));
    const acc = { clean: { w: 0, e: 0, c: 0, ce: 0, S: 0, D: 0, I: 0 }, hard: { w: 0, e: 0 }, silenceWords: 0, silenceSegs: 0, names: { found: 0, total: 0 }, latin: { found: 0, total: 0 }, missing: 0 };
    for (const r of refSegs) {
      const k = kind(r.text);
      if (!byId.has(r.id)) { acc.missing++; continue; }
      const ref = normalize(r.text, equivalences), hyp = normalize(byId.get(r.id), equivalences);
      const rw = ref ? ref.split(" ") : [], hw = hyp ? hyp.split(" ") : [];
      if (k === "silence") { acc.silenceSegs++; acc.silenceWords += hw.length; continue; }
      const ops = editOps(rw, hw);
      if (k === "hard") { acc.hard.w += rw.length; acc.hard.e += ops.distance; continue; }
      acc.clean.w += rw.length; acc.clean.e += ops.distance; acc.clean.S += ops.S; acc.clean.D += ops.D; acc.clean.I += ops.I;
      const rc = [...ref.replace(/ /g, "")], hc = [...hyp.replace(/ /g, "")];
      acc.clean.c += rc.length; acc.clean.ce += editOps(rc, hc).distance;
      for (const n of normNames) if (` ${ref} `.includes(` ${n} `)) { acc.names.total++; if (` ${hyp} `.includes(` ${n} `)) acc.names.found++; }
      for (const t of rw.filter((x) => /[a-z]/.test(x))) { acc.latin.total++; if (hw.includes(t)) acc.latin.found++; }
    }
    const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
    return {
      model: h.model, label: h.label || h.model, plan: h.plan || null, sentences: refSegs.length - acc.missing, missing: acc.missing,
      wer: pct(acc.clean.e, acc.clean.w), cer: pct(acc.clean.ce, acc.clean.c),
      subs: acc.clean.S, dels: acc.clean.D, ins: acc.clean.I, words: acc.clean.w,
      werHard: pct(acc.hard.e, acc.hard.w),
      namesPct: pct(acc.names.found, acc.names.total), namesTotal: acc.names.total,
      latinPct: pct(acc.latin.found, acc.latin.total), latinTotal: acc.latin.total,
      inventedWordsInSilence: acc.silenceWords, silenceSentences: acc.silenceSegs,
      rtf: h.rtf ?? null, vramMB: h.vramMB ?? null, torchPeakMB: h.torchPeakMB ?? null, loadSeconds: h.loadSeconds ?? null,
    };
  }).sort((a, b) => (a.wer ?? 999) - (b.wer ?? 999));
}


/** Word disagreement between two texts after normalising: edit distance over their mean length, in words. */
function disagreement(a, b, equivalences) {
  const wa = (normalize(a, equivalences) || "").split(" ").filter(Boolean), wb = (normalize(b, equivalences) || "").split(" ").filter(Boolean);
  return { e: editOps(wa, wb).distance, n: (wa.length + wb.length) / 2 };
}

/**
 * Agreement between the models while there is no reference yet (NOT accuracy): for every pair of models, the share of
 * words that differ; for every model, how far it is from the Whisper draft the user starts correcting from, and from the
 * others on average. Plus the sentences the models disagree on most — the ones worth a careful listen when correcting.
 */
export function agreement(hyps, segments, { equivalences = [], hardest = 15 } = {}) {
  const ids = segments.map((s) => s.id);
  const text = hyps.map((h) => new Map(h.segments.map((s) => [s.id, s.text || ""])));
  const pct = (e, n) => (n ? Math.round((1000 * e) / n) / 10 : null);
  const pairs = [];
  const sum = hyps.map(() => ({ e: 0, n: 0 }));
  for (let i = 0; i < hyps.length; i++) for (let j = i + 1; j < hyps.length; j++) {
    let e = 0, n = 0;
    for (const id of ids) { const d = disagreement(text[i].get(id) ?? "", text[j].get(id) ?? "", equivalences); e += d.e; n += d.n; }
    pairs.push({ a: hyps[i].model, b: hyps[j].model, pct: pct(e, n) });
    for (const k of [i, j]) { sum[k].e += e; sum[k].n += n; }
  }
  const models = hyps.map((h, k) => {
    let e = 0, n = 0, empty = 0, words = 0;
    for (const s of segments) {
      const t = text[k].get(s.id) ?? "";
      const w = (normalize(t, equivalences) || "").split(" ").filter(Boolean).length;
      if (!w) empty++;
      words += w;
      const ref = (normalize(s.draft, equivalences) || "").split(" ").filter(Boolean);
      e += editOps(ref, (normalize(t, equivalences) || "").split(" ").filter(Boolean)).distance; n += ref.length;
    }
    return { model: h.model, label: h.label || h.model, plan: h.plan || null, vsDraft: pct(e, n), vsOthers: pct(sum[k].e, sum[k].n),
      words, empty, sentences: h.segments.length, rtf: h.rtf ?? null, vramMB: h.vramMB ?? null, torchPeakMB: h.torchPeakMB ?? null,
      loadSeconds: h.loadSeconds ?? null, source: h.source || null };
  }).sort((x, y) => (x.vsOthers ?? 999) - (y.vsOthers ?? 999));
  const spread = segments.map((s) => {
    let e = 0, n = 0;
    for (let i = 0; i < hyps.length; i++) for (let j = i + 1; j < hyps.length; j++) {
      const d = disagreement(text[i].get(s.id) ?? "", text[j].get(s.id) ?? "", equivalences); e += d.e; n += d.n;
    }
    return { id: s.id, clip: s.clip, media: s.media, start: s.start, draft: s.draft, pct: pct(e, n) ?? 0,
      texts: Object.fromEntries(hyps.map((h, k) => [h.model, text[k].get(s.id) ?? ""])) };
  }).sort((x, y) => y.pct - x.pct).slice(0, hardest);
  return { models, pairs, hardest: spread, sentences: segments.length };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const val = (x, unit = "%") => (x === null || x === undefined ? "—" : `${x}${unit}`);
const gb = (mb) => (mb === null || mb === undefined ? "—" : `${(mb / 1024).toFixed(1)} جيجا`);
const PLAN = { baseline: "الحالي", draft: "المسودة", contender: "منافس", optional: "اختياري", "rejected-control": "للمقارنة (مرفوض في الخطة)", extra: "زيادة (مش في الخطة)" };
const STYLE = `body{font-family:Tajawal,Cairo,Segoe UI,sans-serif;background:#0e1112;color:#e8eeee;max-width:1100px;margin:24px auto;padding:0 16px;line-height:1.6}
table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{border-bottom:1px solid #243033;padding:6px 8px;text-align:start;vertical-align:top}th{color:#7fd6dc}
.best{color:#6fd38a;font-weight:700}.muted{color:#8aa0a3;font-size:13px}.warn{background:#3a2a10;border:1px solid #a87a20;border-radius:8px;padding:10px 14px;color:#ffd98a}
.wrap{overflow-x:auto}audio{height:28px;vertical-align:middle}`;

function html(rows, ref) {
  const done = ref.segments.filter((s) => s.status === "done").length;
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>مقارنة نماذج الكلام</title>
<style>${STYLE}</style>
<h1>مقارنة نماذج الكلام المصري</h1>
<p class="muted">على ${done} جملة انت صحّحتها. الخطأ محسوب بعد توحيد الكتابة (الهمزات، والتاء المربوطة، والأرقام، و«و» المنفصلة، والمكافئات اللي في equivalences.txt). الأقل أحسن، ما عدا الأسامي والإنجليزي: الأعلى أحسن.</p>
<p class="muted">تنبيه: الكتابة الصح بدأت من مسودة Whisper، فـWhisper بيبان أحسن من حقيقته شوية. هو للمقارنة بس.</p>
<div class="wrap"><table><tr><th>النموذج</th><th>خطأ الكلمات</th><th>خطأ الحروف</th><th>كلمات غلط / ناقصة / زيادة</th><th>الجمل الصعبة (متداخل / غير مفهوم)</th><th>الأسامي صح</th><th>الإنجليزي صح</th><th>كلام اخترعه في السكوت</th><th>السرعة (× الوقت الحقيقي)</th><th>ذاكرة الكارت</th></tr>
${rows.map((r, i) => `<tr><td class="${i === 0 ? "best" : ""}">${esc(r.label)}${r.plan ? `<div class="muted">${PLAN[r.plan] || r.plan}</div>` : ""}</td><td>${val(r.wer)}</td><td>${val(r.cer)}</td><td>${r.subs} / ${r.dels} / ${r.ins}</td><td>${val(r.werHard)}</td><td>${val(r.namesPct)} (${r.namesTotal})</td><td>${val(r.latinPct)} (${r.latinTotal})</td><td>${r.inventedWordsInSilence} كلمة في ${r.silenceSentences} جملة</td><td>${val(r.rtf, "")}</td><td>${gb(r.vramMB)}</td></tr>`).join("")}
</table></div>
<p class="muted">السرعة: ثواني الشغل لكل ثانية صوت على كارت الشاشة (أقل من 1 يعني أسرع من الوقت الحقيقي)، من غير وقت تحميل النموذج.</p></html>`;
}

function provisionalHtml(ag, why) {
  const lbl = new Map(ag.models.map((m) => [m.model, m.label]));
  const names = ag.models.map((m) => m.model);
  const cell = (a, b) => (a === b ? "—" : val(ag.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.pct));
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>مقارنة مبدئية — مش دقة</title>
<style>${STYLE}</style>
<h1>مقارنة مبدئية بين نماذج الكلام</h1>
<p class="warn"><b>دي مش نسبة الدقة.</b> ${esc(why)} الصفحة دي بتقول بس النماذج <b>متفقة مع بعض</b> قد إيه، ومع مسودة Whisper. نموذجين ممكن يتفقوا على نفس الغلطة، والمسودة نفسها نموذج وفيها غلط. النتيجة الحقيقية بتطلع لما تحفظ <code>reference.json</code> وتشغّل الأمر تاني.</p>
<h2>كل نموذج</h2>
<div class="wrap"><table><tr><th>النموذج</th><th>بيختلف عن الباقيين (متوسط)</th><th>بيختلف عن مسودة Whisper</th><th>جمل فاضية</th><th>عدد الكلمات</th><th>السرعة (× الوقت الحقيقي)</th><th>ذاكرة الكارت</th><th>التحميل</th></tr>
${ag.models.map((m) => `<tr><td>${esc(m.label)}${m.plan ? `<div class="muted">${PLAN[m.plan] || m.plan}</div>` : ""}</td><td>${val(m.vsOthers)}</td><td>${val(m.vsDraft)}</td><td>${m.empty} من ${m.sentences}</td><td>${m.words}</td><td>${val(m.rtf, "")}</td><td>${gb(m.vramMB)}</td><td>${val(m.loadSeconds, " ث")}</td></tr>`).join("")}
</table></div>
<p class="muted">«بيختلف» = نسبة الكلمات المختلفة بعد توحيد الكتابة. الأقل معناه أقرب للباقيين، <b>مش</b> أصح. Whisper قريب من المسودة طبيعي لأنه نفس النموذج.</p>
<h2>كل اتنين مع بعض</h2>
<div class="wrap"><table><tr><th></th>${names.map((n) => `<th>${esc(lbl.get(n))}</th>`).join("")}</tr>
${names.map((a) => `<tr><th>${esc(lbl.get(a))}</th>${names.map((b) => `<td>${cell(a, b)}</td>`).join("")}</tr>`).join("")}
</table></div>
<h2>أكتر ${ag.hardest.length} جملة النماذج اختلفت فيها</h2>
<p class="muted">دي أكتر جمل تستاهل تسمعها كويس وانت بتصحّح في «اكتب الكلام» (رقم الجملة هو نفس الرقم هناك).</p>
<div class="wrap"><table><tr><th>الجملة</th><th>الاختلاف</th><th>اللي كتبه كل نموذج</th></tr>
${ag.hardest.map((h) => `<tr><td>#${h.id}<div class="muted">${esc(h.media)} @ ${h.start} ث</div><audio controls preload="none" src="${esc(h.clip)}"></audio></td><td>${val(h.pct)}</td><td><div class="muted">المسودة: ${esc(h.draft)}</div>${names.map((n) => `<div><b>${esc(lbl.get(n))}:</b> ${esc(h.texts[n])}</div>`).join("")}</td></tr>`).join("")}
</table></div>
<p class="muted">على ${ag.sentences} جملة (${ag.models.length} نموذج). اتعملت ${new Date().toISOString().slice(0, 16).replace("T", " ")}.</p></html>`;
}

/** montaj-bench\النتائج\الكتابة next to the app (main checkout) or two levels up (a worktree). */
function benchDir() {
  const app = fileURLToPath(new URL("..", import.meta.url));
  const tries = [path.resolve(app, "..", "montaj-bench", "النتائج", "الكتابة"), path.resolve(app, "..", "..", "montaj-bench", "النتائج", "الكتابة")];
  return tries.find((d) => fs.existsSync(d)) || tries[0];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = process.argv.slice(2);
  const i = a.indexOf("--dir");
  const dir = i >= 0 ? a[i + 1] : benchDir();
  const hypDir = path.join(dir, "hyp");
  const hyps = fs.existsSync(hypDir) ? fs.readdirSync(hypDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(hypDir, f), "utf8"))) : [];
  if (!hyps.length) { console.error(`مفيش نتايج نماذج في ${hypDir} — شغّل bench/asr_all.py الأول`); process.exit(2); }
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "");
  const equivalences = parseEquivalences(read("equivalences.txt"));
  const names = read("names.txt").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const reference = read("reference.json") ? JSON.parse(read("reference.json")) : null;
  const done = reference ? reference.segments.filter((s) => s.status === "done").length : 0;
  if (reference && done && !a.includes("--provisional")) {
    const rows = score(reference, hyps, { names, equivalences });
    fs.writeFileSync(path.join(dir, "asr-scores.json"), JSON.stringify({ schema: "montaj-bench.asr/1", scoredAt: new Date().toISOString(), sentences: done, rows }, null, 1));
    fs.writeFileSync(path.join(dir, "مقارنة النماذج.html"), html(rows, reference));
    for (const r of rows) console.log(`${r.model}\tWER ${r.wer}%\tCER ${r.cer}%\tRTF ${r.rtf}`);
    console.log(path.join(dir, "مقارنة النماذج.html"));
  } else {
    const segments = JSON.parse(read("segments.json")).segments;
    const why = !reference ? "لسه مفيش reference.json (الكتابة الصح)." : !done ? "reference.json موجود بس لسه مفيش ولا جملة متعلّم عليها «خلصت»." : "اتطلبت الصفحة المبدئية.";
    const ag = agreement(hyps, segments, { equivalences });
    fs.writeFileSync(path.join(dir, "asr-agreement.json"), JSON.stringify({ schema: "montaj-bench.asr-agreement/1", provisional: true, notAccuracy: true, at: new Date().toISOString(), ...ag }, null, 1));
    fs.writeFileSync(path.join(dir, "مقارنة مبدئية (مش دقة).html"), provisionalHtml(ag, why));
    console.log(`مبدئي (مش دقة): ${why}`);
    for (const m of ag.models) console.log(`${m.model}\tvs others ${m.vsOthers}%\tvs draft ${m.vsDraft}%\tRTF ${m.rtf}\tGPU ${m.vramMB} MB`);
    console.log(path.join(dir, "مقارنة مبدئية (مش دقة).html"));
  }
}
