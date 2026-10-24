// Builds docs/TRACEABILITY.md from the report tables (docs/report/*.csv) and scripts/traceability-map.mjs.
// Fails (exit 1) if a feature is unmapped or a referenced file/test does not exist — run: npm run traceability
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAP, IMPROVEMENTS, ASSUMPTIONS } from "./traceability-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

const features = parseCsv(fs.readFileSync(path.join(ROOT, "docs/report/features.csv"), "utf8"));
const LABEL = { done: "منفّذ محليًا", alt: "بديل محلي", partial: "جزئي", provider: "يتطلب مزوّدًا خارجيًا", na: "غير منطبق", no: "غير منفّذ" };
const problems = [];
const counts = Object.fromEntries(Object.keys(LABEL).map((k) => [k, 0]));
const lines = [];
lines.push("# مصفوفة تتبّع المتطلبات — Requirements Traceability Matrix", "");
lines.push("مولَّدة آليًا بالأمر `npm run traceability` من جداول التقرير (`docs/report/features.csv`) وخريطة التنفيذ (`scripts/traceability-map.mjs`). يتحقق السكربت من وجود كل ملف واختبار مذكور.", "");

const rowsOut = [];
for (const f of features) {
  const m = MAP[f.id];
  if (!m) { problems.push(`unmapped ${f.id}`); continue; }
  if (!LABEL[m.s]) problems.push(`bad status ${f.id}: ${m.s}`);
  counts[m.s]++;
  for (const p of [...m.f, ...m.t]) if (!fs.existsSync(path.join(ROOT, p))) problems.push(`${f.id}: missing ${p}`);
  const files = m.f.map((p) => `\`${p.replace(/^src\//, "")}\``).join("<br>") || "—";
  const tests = m.t.map((p) => `\`${path.basename(p)}\``).join("<br>") || (m.s === "done" || m.s === "alt" || m.s === "partial" ? "يدوي" : "—");
  rowsOut.push(`| ${f.id} | ${f.name_ar} / ${f.name_en} | ${f.screens || "—"} | ${LABEL[m.s]} | ${files} | ${tests} | ${(m.n || "").replace(/\|/g, "/")} |`);
}
for (const id of Object.keys(MAP)) if (!features.some((f) => f.id === id)) problems.push(`map has unknown ${id}`);

const total = features.length;
lines.push("## الملخص", "", "| الحالة | العدد |", "|---|---|");
for (const [k, v] of Object.entries(counts)) lines.push(`| ${LABEL[k]} (${k}) | ${v} |`);
lines.push(`| **المجموع** | **${total}** |`, "");
lines.push("التصنيف: **منفّذ محليًا** = يعمل دون اتصال كما في التقرير؛ **بديل محلي** = الوظيفة الأصلية سحابية/توليدية وقُدّم بديل محلي حقيقي يؤدي الغرض؛ **جزئي** = جزء من الوظيفة؛ **يتطلب مزوّدًا خارجيًا** = يظهر في الواجهة كغير متاح دون اتصال ولا يُحاكى؛ **غير منطبق** = حسابات/اشتراكات/مزامنة سحابية للمنتج الأصلي.", "");
lines.push("## المتطلبات الأصلية (من التقرير)", "", "| المعرّف | الميزة | الشاشات | الحالة | ملفات التنفيذ | الاختبارات | ملاحظات |", "|---|---|---|---|---|---|---|", ...rowsOut, "");
lines.push("## تحسينات مقترحة ومنفّذة (ليست من التقرير)", "", "| التحسين | الملف | الاختبار |", "|---|---|---|");
for (const [name, file, test] of IMPROVEMENTS) { lines.push(`| ${name} | \`${file}\` | ${test ? `\`${path.basename(test)}\`` : "—"} |`); if (!fs.existsSync(path.join(ROOT, file))) problems.push(`improvement missing ${file}`); }
lines.push("", "## افتراضات", "", ...ASSUMPTIONS.map((a) => `- ${a}`), "");

fs.writeFileSync(path.join(ROOT, "docs/TRACEABILITY.md"), lines.join("\n"), "utf8");
console.log(`TRACEABILITY.md: ${total} features —`, Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
if (problems.length) { console.error("Problems:\n" + problems.join("\n")); process.exit(1); }
