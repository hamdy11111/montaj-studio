// Every number said, and every list (the edit-hamdy skill's 45_numbers): digits (١٠٥ · 105) and Egyptian number words
// («خمسة وعشرين» · «تلت آلاف» · «مية وخمسين» · «نص كيلو» · «عشرتلاف») with the unit after them, at the word's time.
// Kinds: delta (with a gain/loss verb → +/−), impact (a big number in a ?/! sentence), info, list (3+ numbers in a
// row within 3.5 s of each other, the list ≤ 12 s). Pure; times in µs.
import { POLICY } from "./policy.js";
import { sentences } from "./speech.js";
import { US } from "./util.js";

const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "٫": ".", "٬": "," };
export function nrm(w) {
  let s = String(w || "").replace(/[٠-٩٫٬]/g, (c) => AR_DIGITS[c]).replace(/[ً-ْـ]/g, "");
  s = s.replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  return s.replace(/[^\p{L}\p{N}_.%]/gu, "");
}

const U = { "واحد": 1, "واحده": 1, "اتنين": 2, "اثنين": 2, "اتنان": 2, "تلاته": 3, "تلات": 3, "ثلاثه": 3, "ثلاث": 3, "تلت": 3,
  "اربعه": 4, "اربع": 4, "خمسه": 5, "خمس": 5, "سته": 6, "ست": 6, "سبعه": 7, "سبع": 7, "تمانيه": 8, "تمن": 8, "تماني": 8,
  "ثمانيه": 8, "ثمان": 8, "تسعه": 9, "تسع": 9, "عشره": 10, "عشر": 10, "حداشر": 11, "احداشر": 11, "اتناشر": 12, "اطناشر": 12,
  "تلتاشر": 13, "اربعتاشر": 14, "اربعطاشر": 14, "خمستاشر": 15, "خمسطاشر": 15, "ستاشر": 16, "سطاشر": 16, "سبعتاشر": 17, "سبعطاشر": 17,
  "تمنتاشر": 18, "تمنطاشر": 18, "تسعتاشر": 19, "تسعطاشر": 19 };
const T = { "عشرين": 20, "تلاتين": 30, "ثلاثين": 30, "اربعين": 40, "خمسين": 50, "ستين": 60, "سبعين": 70, "تمانين": 80, "ثمانين": 80, "تسعين": 90 };
const H = { "ميه": 100, "مايه": 100, "ميت": 100, "ميتين": 200, "متين": 200, "تلتميه": 300, "تلاتميه": 300, "ربعميه": 400, "اربعميه": 400,
  "خمسميه": 500, "ستميه": 600, "سبعميه": 700, "تمنميه": 800, "تسعميه": 900 };
const M = { "الف": 1000, "الاف": 1000, "تلاف": 1000, "الفين": 2000, "مليون": 1_000_000, "ملايين": 1_000_000, "مليونين": 2_000_000, "مليار": 1_000_000_000 };
const FR = { "نص": 0.5, "ربع": 0.25, "تلت": 1 / 3 };
const UNITS = { "كيلو": "كيلو", "كيلوجرام": "كيلو", "جرام": "جرام", "جنيه": "جنيه", "جنيهات": "جنيه", "دولار": "دولار", "ليره": "ليرة", "ريال": "ريال",
  "يورو": "يورو", "يوم": "يوم", "ايام": "يوم", "يومين": "يوم", "ساعه": "ساعة", "ساعات": "ساعة", "ساعتين": "ساعة", "دقيقه": "دقيقة",
  "دقايق": "دقيقة", "ثانيه": "ثانية", "ثواني": "ثانية", "سنه": "سنة", "سنين": "سنة", "شهر": "شهر", "شهور": "شهر", "متر": "متر",
  "كيلومتر": "كم", "سعره": "سعرة", "سعرات": "سعرة", "كالوري": "سعرة", "مره": "مرة", "مرات": "مرة", "رغيف": "رغيف", "علبه": "علبة",
  "كوبايه": "كوباية", "طبق": "طبق", "حته": "حتة", "نفر": "نفر", "%": "٪", "في_الميه": "٪" };
const GAIN = /(كسب|كسبنا|وفر|وفرنا|زاد|زادت|زودنا|ربحنا|جمعنا|وصلنا|طلع|اتضاف)/;
const LOSS = /(خسر|خسرنا|ضاع|ضاعت|راح|راحت|نقص|نقصت|اتخصم|خصم|دفعنا|صرفنا|اترمي|بايظ|باظ)/;
const DIGITS = /^[\d.,]+%?$/;
const ITEM_STOP = new Set(["في", "من", "علي", "بس", "كمان", "تاني", "بقي", "خلاص", "يعني"]);

export function unitOf(tok) {
  const t = nrm(tok);
  for (const pre of ["", "ب", "و", "ال"]) {
    const t2 = pre && t.startsWith(pre) ? t.slice(pre.length) : t;
    if (t2 in UNITS) return UNITS[t2];
  }
  return null;
}

const isNum = (x) => x in U || x in T || x in H || x in M || DIGITS.test(x);

/** A number starting at token k: { value, n } (n tokens) or null. */
export function parseNumber(tokens, k) {
  let total = 0, cur = 0, n = 0, any = false;
  for (let i = k; i < tokens.length; i++) {
    const t = nrm(tokens[i]);
    let w = t;
    if (t.startsWith("و") && t.length > 1 && isNum(t.slice(1))) {
      if (any && !DIGITS.test(t.slice(1))) w = t.slice(1); // «خمسة وعشرين» = the same number
      else if (!any) w = t.slice(1);                        // «و٣٤ علبة» = a new number in a list
      else break;                                            // «١٠٥ و٣٤» = two numbers
    } else if (t.startsWith("ال") && isNum(t.slice(2)) && !any) w = t.slice(2); // «العشرين كيلو»
    const tens = w.match(/^(.+)تلاف$/);
    if (/^\d+(\.\d+)?%?$/.test(w.replace(/,/g, ""))) { cur += parseFloat(w.replace(/,/g, "").replace(/%$/, "")); any = true; }
    else if (w in U && !(w === "ست" && i + 1 < tokens.length && unitOf(tokens[i + 1]) === null && !any)) { cur += U[w]; any = true; }
    else if (w in T) { cur += T[w]; any = true; }
    else if (w in H) { cur += H[w]; any = true; }
    else if (w in M) {
      const dual = w === "الفين" || w === "مليونين";
      total += dual && !cur ? M[w] : (cur || 1) * M[w];
      cur = 0; any = true;
    } else if (tens && (tens[1] in U || tens[1] in T)) { total += (U[tens[1]] ?? T[tens[1]]) * 1000; any = true; }
    else if (w in FR && !any) { cur += FR[w]; any = true; }
    else break;
    n++;
  }
  return any ? { value: total + cur, n } : null;
}

const EAST = "٠١٢٣٤٥٦٧٨٩";
/** A value as it is shown: Arabic-Indic digits, «٬» thousands, «٫» decimals. */
export function fmtNumber(v) {
  const s = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v).toLocaleString("en-US").replace(/,/g, "٬") : String(Number(v.toPrecision(6))).replace(".", "٫");
  return s.replace(/[0-9]/g, (d) => EAST[d]);
}

/**
 * Numbers said in `words` ([{ text, startUs, endUs }]): { numbers: [{ s, e, at, value, unit, item, label, kind, sign, w }],
 * — `at` is the start of the word that completes it (its unit or item): a graphic of it enters there, never earlier —
 * lists: [[index into numbers…]], progress: [{ unit, values }] }.
 */
export function findNumbers(words) {
  const toks = words.map((w) => w.text);
  const segOf = [];
  sentences(words).forEach((sn, si) => { for (let i = sn.w0; i <= sn.w1; i++) segOf[i] = si; });
  const out = [];
  for (let k = 0; k < toks.length;) {
    const r = parseNumber(toks, k);
    if (!r) { k++; continue; }
    const { value, n } = r;
    const unit = k + n < toks.length ? unitOf(toks[k + n]) : null;
    if (value === 1 && !unit) { k += n; continue; } // «واحد» alone is a person, not a number
    const sg = segOf[k];
    const same = [];
    for (let q = Math.max(0, k - 4); q < Math.min(toks.length, k + n + 3); q++) if (segOf[q] === sg) same.push(q);
    const segText = toks.filter((_, q) => segOf[q] === sg).join(" ");
    const near = same.filter((q) => q <= k + n).map((q) => nrm(toks[q])).join(" ");
    const kind = GAIN.test(near) || LOSS.test(near) ? "delta" : /[؟!?]/.test(segText) && value >= POLICY.numbers.impactMin ? "impact" : "info";
    const sign = LOSS.test(near) ? "-" : GAIN.test(near) ? "+" : "";
    const x = { s: words[k].startUs, e: unit ? words[k + n].endUs : words[k + n - 1].endUs, at: unit ? words[k + n].startUs : words[k + n - 1].startUs, w: k, seg: sg, value, unit: unit || "", raw: toks[k], label: `${sign}${fmtNumber(value)}${unit ? ` ${unit}` : ""}`, kind, sign };
    // The item after the number when it is not a unit («٩٦ عصير»): it names the item in a list.
    if (!unit && k + n < toks.length && segOf[k + n] === sg && !parseNumber(toks, k + n)) {
      const it = toks[k + n].replace(/^[\s.,،…]+|[\s.,،…؟?!]+$/g, "");
      if (nrm(it).length > 2 && !ITEM_STOP.has(nrm(it))) { x.item = it; x.at = words[k + n].startUs; }
    }
    out.push(x);
    k += n + (unit ? 1 : 0);
  }
  // Lists: 3+ numbers, each within 3.5 s of the previous one's end, the whole list ≤ 12 s, in one sentence (or
  // continued with «و…»). A gain/loss is an event of its own, never a list item.
  const P = POLICY.numbers, lists = [];
  let cur = [];
  const close = () => { if (cur.length >= P.listMin) lists.push(cur); cur = []; };
  out.forEach((x, i) => {
    if (x.kind === "delta") { close(); return; }
    const last = cur.length ? out[cur[cur.length - 1]] : null;
    const newSent = last && x.seg !== last.seg && !nrm(x.raw).startsWith("و");
    if (last && (newSent || x.s - last.e > P.listGap * US || x.s - out[cur[0]].s > P.listSpan * US)) close();
    cur.push(i);
  });
  close();
  for (const L of lists) for (const i of L) { out[i].kind = "list"; if (out[i].item) out[i].label += ` ${out[i].item}`; }
  const byUnit = new Map();
  for (const x of out) if (x.unit && x.kind !== "list") byUnit.set(x.unit, [...(byUnit.get(x.unit) || []), x]);
  const progress = [...byUnit].filter(([, xs]) => xs.length >= 3).map(([unit, xs]) => ({ unit, values: xs.map((x) => x.label) }));
  return { numbers: out, lists, progress };
}
