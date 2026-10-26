// مقارنة نماذج الكلام — scores each speech model's text against the user's reference transcription (Phase 0).
//
//   node bench/asr-score.mjs --dir "<...\montaj-bench\النتائج\الكتابة>"
//
// Reads reference.json (from the «اكتب الكلام» page) and every hyp\<model>.json ({ model, segments: [{ id, text }] },
// the same clips run through each model). Optional: names.txt (one name per line) and equivalences.txt (a = b).
// Only sentences the user marked «خلصت» count. Sentences tagged [غير مفهوم] or [متداخل] are scored apart; sentences
// tagged [مفيش كلام] measure invented words (hallucinations). Writes asr-scores.json and an Arabic HTML table.
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
      model: h.model, sentences: refSegs.length - acc.missing, missing: acc.missing,
      wer: pct(acc.clean.e, acc.clean.w), cer: pct(acc.clean.ce, acc.clean.c),
      subs: acc.clean.S, dels: acc.clean.D, ins: acc.clean.I, words: acc.clean.w,
      werHard: pct(acc.hard.e, acc.hard.w),
      namesPct: pct(acc.names.found, acc.names.total), namesTotal: acc.names.total,
      latinPct: pct(acc.latin.found, acc.latin.total), latinTotal: acc.latin.total,
      inventedWordsInSilence: acc.silenceWords, silenceSentences: acc.silenceSegs,
      rtf: h.rtf ?? null, vramMB: h.vramMB ?? null,
    };
  }).sort((a, b) => (a.wer ?? 999) - (b.wer ?? 999));
}

function html(rows, ref) {
  const done = ref.segments.filter((s) => s.status === "done").length;
  const v = (x, unit = "%") => (x === null || x === undefined ? "—" : `${x}${unit}`);
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مقارنة نماذج الكلام</title>
<style>body{font-family:Tajawal,Cairo,Segoe UI,sans-serif;background:#0e1112;color:#e8eeee;max-width:1100px;margin:24px auto;padding:0 16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #243033;padding:6px 8px;text-align:start}th{color:#7fd6dc}.best{color:#6fd38a;font-weight:700}.muted{color:#8aa0a3;font-size:13px}</style>
<h1>مقارنة نماذج الكلام المصري</h1>
<p class="muted">على ${done} جملة انت صحّحتها. الخطأ محسوب بعد توحيد الكتابة (الهمزات، والتاء المربوطة، والأرقام، و«و» المنفصلة، والمكافئات اللي في equivalences.txt). الأقل أحسن، ما عدا الأسامي والإنجليزي: الأعلى أحسن.</p>
<table><tr><th>النموذج</th><th>خطأ الكلمات</th><th>خطأ الحروف</th><th>كلمات غلط / ناقصة / زيادة</th><th>الجمل الصعبة (متداخل / غير مفهوم)</th><th>الأسامي صح</th><th>الإنجليزي صح</th><th>كلام اخترعه في السكوت</th><th>السرعة (× الوقت الحقيقي)</th></tr>
${rows.map((r, i) => `<tr><td class="${i === 0 ? "best" : ""}">${r.model}</td><td>${v(r.wer)}</td><td>${v(r.cer)}</td><td>${r.subs} / ${r.dels} / ${r.ins}</td><td>${v(r.werHard)}</td><td>${v(r.namesPct)} (${r.namesTotal})</td><td>${v(r.latinPct)} (${r.latinTotal})</td><td>${r.inventedWordsInSilence} كلمة في ${r.silenceSentences} جملة</td><td>${v(r.rtf, "")}</td></tr>`).join("")}
</table></html>`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = process.argv.slice(2);
  const i = a.indexOf("--dir");
  const dir = i >= 0 ? a[i + 1] : path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..", "montaj-bench", "النتائج", "الكتابة");
  const reference = JSON.parse(fs.readFileSync(path.join(dir, "reference.json"), "utf8"));
  const hypDir = path.join(dir, "hyp");
  const hyps = fs.existsSync(hypDir) ? fs.readdirSync(hypDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(hypDir, f), "utf8"))) : [];
  if (!hyps.length) { console.error(`مفيش نتايج نماذج في ${hypDir}`); process.exit(2); }
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "");
  const equivalences = parseEquivalences(read("equivalences.txt"));
  const names = read("names.txt").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const rows = score(reference, hyps, { names, equivalences });
  fs.writeFileSync(path.join(dir, "asr-scores.json"), JSON.stringify({ schema: "montaj-bench.asr/1", scoredAt: new Date().toISOString(), rows }, null, 1));
  fs.writeFileSync(path.join(dir, "مقارنة النماذج.html"), html(rows, reference));
  for (const r of rows) console.log(`${r.model}\tWER ${r.wer}%\tCER ${r.cer}%`);
}
