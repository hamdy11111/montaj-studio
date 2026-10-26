// What each sentence needs on screen (plan item 10, step 1): tags such as number, list, compare, quote, memory, phone,
// peak, chapter — with the word that triggers each one (a graphic enters on that word) and the sentence's energy.
// Deterministic: the numbers and moments scanners of the app (core/numbers.js, core/moments.js — the edit-hamdy
// skill's 45_numbers and 28_moments) plus a small Egyptian/MSA lexicon for the rest. Times are µs, like the words.
import { findNumbers } from "../core/numbers.js";
import { detectMoments } from "../core/moments.js";
import { sentences } from "../core/speech.js";
import { normWord } from "./arabic.js";

/** Lexicon: tag → words or phrases (normalised forms are compared; a phrase matches consecutive words). */
export const NEED_LEXICON = {
  compare: ["اكتر من", "اكثر من", "احسن من", "افضل من", "اقل من", "اغلى من", "ارخص من", "مقابل", "مقارنه", "الفرق بين", "ضد"],
  memory: ["زمان", "فاكر", "فاكرين", "فاكره", "افتكرت", "من سنه", "من سنين", "وانا صغير", "وانا صغيره", "ايام زمان", "الماضي", "قبل كده", "المره اللي فاتت"],
  phone: ["موبايل", "الموبايل", "تليفون", "التليفون", "الفون", "رساله", "مسدج", "ماسدج", "واتساب", "واتس", "تطبيق", "ابلكيشن", "سكرين", "سكرينشوت", "بعتلي", "بعتتلي", "انستجرام", "تيك توك", "فيسبوك", "شات"],
  chapter: ["النهارده", "اليوم الاول", "تاني يوم", "تالت يوم", "اليوم التاني", "الجوله", "المرحله", "الفصل", "الجزء", "نبدا", "يلا بينا", "اول حاجه", "الحكايه", "القصه"],
  name: ["ماما", "بابا", "اخويا", "اختي", "خالتي", "عمتي", "عمي", "خالي", "جدتي", "جدي", "تيتا", "جدو", "صاحبي", "صاحبتي", "مراتي", "جوزي", "ابني", "بنتي"],
  place: ["الماركت", "السوبر ماركت", "السوبرماركت", "المطعم", "البيت", "المطبخ", "الشارع", "المدرسه", "الجامعه", "الدكتور", "المستشفى", "الجيم", "البحر", "المول", "الكافيه", "المحل", "الفرن", "العربيه", "المطار"],
  food: ["اكل", "الاكل", "اكله", "فراخ", "الفراخ", "لحمه", "رز", "عيش", "العيش", "بيتزا", "برجر", "كشري", "مكرونه", "جمبري", "سمك", "تاكو", "شاورما", "فول", "طعميه", "كيك", "حلويات", "العجين"],
  countdown: ["فاضل", "باقي", "قدامنا", "في خلال", "التايمر", "الوقت خلص"],
  narration: ["بعد ساعه", "بعد ساعتين", "بعد يوم", "بعد يومين", "بعد شويه", "بعدها ب", "وبعد", "تاني يوم الصبح", "بالليل"],
  weather: ["شمس", "الشمس", "مطر", "المطر", "بتمطر", "برد", "البرد", "حر", "الحر", "الجو", "سقعه", "تلج", "غيم", "عاصفه"],
  run: ["اجري", "جري", "اهرب", "هرب", "هربت", "بسرعه", "طيران", "يلا نجري"],
  watch: ["بنراقب", "بنراقبهم", "كاميرا", "كاميرات", "مراقبه", "بنتفرج عليهم", "متصورين"],
  mood: ["بالليل", "الليل", "ضلمه", "حلم", "كابوس", "خطر", "رعب", "مرعب", "رومانسي"],
  point: ["بص", "بصوا", "شوف", "شوفوا", "هنا", "خدوا بالكم", "ركزوا", "لاحظوا", "المهم", "السر", "النصيحه", "الفكره"],
  correction: ["طلع", "طلعت", "اتضح", "مش كده", "بالعكس", "كنت فاكر", "كنا فاكرين", "اكتشفت"],
  round: ["الجوله", "الراوند", "المرحله", "النقط", "النقطه", "السكور"],
  day: ["اليوم", "يوم"],
  offer: ["جديد", "مجانا", "ببلاش", "خصم", "عرض", "هديه"],
  math: ["يعني", "يساوي", "زائد", "ناقص", "ضرب", "في المجموع", "يبقى", "المجموع", "الحسبه"],
  celebrate: ["مبروك", "نجحنا", "كسبنا", "فزنا", "حفله", "احتفال", "خلصنا"],
  quote: ["قال", "قالت", "قالي", "قالتلي", "بيقول", "بتقول", "حكمه", "مقوله"],
};
const PHRASES = Object.entries(NEED_LEXICON).flatMap(([tag, list]) => list.map((p) => [p.split(" ").map(normWord), tag])).sort((a, b) => b[0].length - a[0].length);
const MONEY = new Set(["جنيه", "دولار", "ريال", "ليرة", "يورو", "درهم", "دينار"]);

/** Moment types (core/momentsLexicon.js) → need tags and an energy (1–5). */
const MOMENT_TAGS = {
  shock: [["peak", "reaction", "surprise"], 5], laugh: [["peak", "reaction", "punchline"], 5], oops: [["peak", "reaction", "punchline"], 5],
  alert: [["peak", "surprise"], 5], win: [["celebrate", "reaction"], 4], fire: [["reaction"], 4], tasty: [["reaction", "food"], 3],
  question: [["question"], 3], look: [["point", "look"], 3], idea: [["point"], 3], money: [["money"], 3], cool: [["reaction"], 3],
  no: [["reaction", "verdict"], 4], time: [["time"], 2], effort: [["reaction"], 3], love: [["reaction"], 3],
};

/**
 * Needs of every sentence. words: [{ text, startUs, endUs }] (timeline or source time). Returns
 * [{ i, startUs, endUs, text, w0, w1, tags: [...], anchors: { tag: { w, atUs } }, energy, numbers, moments }].
 * opts.keywords: words the user marked (moments "key", energy 4); opts.names: people's names (tag name).
 */
export function sentenceNeeds(words, { keywords = [], names = [] } = {}) {
  const sents = sentences(words);
  const { numbers, lists, progress } = findNumbers(words);
  const moments = detectMoments(words, { keywords });
  const nameSet = new Set(names.map(normWord));
  const norm = words.map((w) => normWord(w.text));
  const out = sents.map((sn, i) => {
    const ws = words.slice(sn.w0, sn.w1 + 1);
    const tags = new Map(); // tag → { w, atUs }
    const tag = (t, w) => { if (!tags.has(t)) tags.set(t, { w, atUs: words[w].startUs }); };
    // Lexicon (phrases first; a word may carry several tags, but one tag's phrases do not overlap).
    const usedBy = new Map();
    for (const [pt, t] of PHRASES) {
      if (!usedBy.has(t)) usedBy.set(t, new Set());
      const used = usedBy.get(t);
      for (let k = sn.w0; k + pt.length - 1 <= sn.w1; k++) {
        if (pt.some((_, j) => used.has(k + j))) continue;
        if (!pt.every((p, j) => norm[k + j] === p || (p.length > 3 && norm[k + j].startsWith(p)))) continue;
        tag(t, k);
        if (["food", "place", "name"].includes(t)) tag("thing", k);
        for (let j = 0; j < pt.length; j++) used.add(k + j);
      }
    }
    for (let k = sn.w0; k <= sn.w1; k++) if (nameSet.has(norm[k])) { tag("name", k); tag("thing", k); }
    // Numbers said in the sentence.
    const nums = numbers.filter((x) => x.w >= sn.w0 && x.w <= sn.w1);
    for (const x of nums) {
      const w = words.findIndex((y) => y.startUs === x.at);
      const at = w >= 0 ? w : x.w;
      tag("number", at);
      if (x.item || x.unit) tag("count", at);
      if (MONEY.has(x.unit)) tag("money", at);
      if (x.unit === "٪" || /[%٪]/.test(x.raw)) { x.unit = x.unit || "٪"; tag("percent", at); } // «٥٧٪» is one word
      if (x.kind === "delta") tag("delta", at);
      if (x.kind === "impact") tag("peak", at);
      if (x.kind === "list") tag("list", at);
      if (["ثانية", "دقيقة"].includes(x.unit) && tags.has("countdown")) tag("countdown", at);
    }
    if (nums.length >= 2 && tags.has("math")) tag("math", nums[0].w);
    if (nums.length >= 2 && nums.filter((x) => x.unit === "٪").length >= 2) tag("compare", nums[0].w);
    if (progress.some((p) => nums.some((x) => x.unit === p.unit))) tag("progress", nums[0].w);
    if (!nums.length) { tags.delete("day"); tags.delete("round"); tags.delete("math"); } else if (tags.has("day") || tags.has("round")) tag("chapter", sn.w0);
    if (tags.has("countdown") && !nums.length) tags.delete("countdown");
    // Moments.
    const ms = moments.filter((m) => m.s >= words[sn.w0].startUs && m.s <= words[sn.w1].endUs);
    let energy = 2;
    for (const m of ms) {
      const [tg, en] = MOMENT_TAGS[m.type] || [[], 2];
      const w = words.findIndex((y) => y.startUs === m.s);
      for (const t of tg) tag(t, w >= 0 ? w : sn.w0);
      energy = Math.max(energy, m.score >= 2.4 ? en : Math.min(en, 3));
      if (m.type === "key") { tag("point", w >= 0 ? w : sn.w0); energy = Math.max(energy, 4); }
    }
    const text = ws.map((w) => w.text).join(" ");
    if (/[«"“].{3,}[»"”]/.test(text)) tag("quote", sn.w0);
    if (/!/.test(text)) energy = Math.max(energy, 4);
    if (i === 0 || words[sn.w0].startUs < 3_000_000) { tag("hook", sn.w0); tag("title", sn.w0); }
    // Chapters start a sentence: only when the chapter word is in its first three words.
    if (tags.has("chapter") && tags.get("chapter").w > sn.w0 + 2) tags.delete("chapter");
    return { i, startUs: words[sn.w0].startUs, endUs: words[sn.w1].endUs, text, w0: sn.w0, w1: sn.w1, tags: [...tags.keys()], anchors: Object.fromEntries(tags), energy: Math.min(5, energy), numbers: nums, moments: ms };
  });
  // Lists of numbers that run over several sentences: the list starts at the first sentence that has its first item.
  for (const L of lists) {
    const first = numbers[L[0]];
    const need = out.find((n) => first.w >= n.w0 && first.w <= n.w1);
    if (need && !need.tags.includes("list")) { need.tags.push("list"); need.anchors.list = { w: first.w, atUs: first.at }; }
    if (need) need.list = L.map((k) => numbers[k]);
  }
  return out;
}
