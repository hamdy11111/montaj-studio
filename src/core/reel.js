// A reel from a long video (the edit-hamdy skill's 54_pacing solver): the strongest whole sentences that fit a target
// length, in their original order — never a cut inside a sentence. Each unit (a sentence; a question with its answer;
// a one-word sentence joined to the one before) gets a value from its role in the story (stakes, result, reaction,
// setup, bridge, action — guessed from its words) and the strength of the moments in it; the opening is always kept;
// a 0/1 knapsack at 0.1 s chooses the rest. Pure; times in µs.
import { sentences } from "./speech.js";
import { US } from "./util.js";

// The skill's story roles (first match wins, default "action") and their values.
const ROLES = [
  ["stakes", /(لو\s|هنكسب|هيكسب|جايز[هة]|تحدي|رهان|هدف|لازم\s|عشان\s*نكسب|المطلوب|القاعد[هة]|ممنوع|مليون|الف\s*جنيه|دولار)/],
  ["result", /(في\s*الآخر|في\s*الاخر|خلاص|خلصنا|نجحنا|فشلنا|كسبنا|خسرنا|طلع|النتيج[هة]|وصلنا|عملناها)/],
  ["bridge", /(بعدها|بعد\s*كده|تاني\s*يوم|الصبح|بالليل|بعد\s*\S+\s*(ساع|يوم|دقي)|وبعدين|المرحل[هة])/],
  ["setup", /(النهارده|النهاردة|هنعمل|هنجرب|الفكر[هة]|عايزين|ناويين|خطتنا|هنبدأ|بصوا)/],
  ["reaction", /(يا\s*نهار|يا\s*لهوي|مش\s*معقول|معقول|واو|يا\s*سلام|بجد|ايه\s*ده|إيه\s*ده|هههه)/],
];
export const ROLE_VALUE = { stakes: 2.0, result: 2.5, reaction: 2.0, setup: 1.2, bridge: 0.3, action: 1.0 };
export const storyRole = (text) => (ROLES.find(([, re]) => re.test(text)) || ["action"])[0];

const KEPT_GAP_US = 150_000; // the silence a tightened unit keeps between its words (the creator rhythm)

/**
 * words: [{ text, startUs, endUs }] (the speech kept so far, source time); moments: [{ s, score, type }];
 * removed: Map of word indices already taken out (fillers…); targetUs; opts.budgetUs overrides target − must-keep.
 * Returns { drop: Map(word index → "reel"), units: [{ w0, w1, text, role, value, estUs, kept, must }], estUs, warning }.
 */
export function reelSelect(words, { targetUs, moments = [], keywords = [], removed = new Map(), budgetUs = null } = {}) {
  const live = (i) => !removed.has(i);
  const sents = sentences(words, { gapUs: 1_000_000 });
  // Units: a question with its answer; a one-word sentence said right after another joins it.
  const units = [];
  for (const sn of sents) {
    const last = units[units.length - 1];
    const one = sn.w1 === sn.w0 && last && words[sn.w0].startUs - words[last.w1].endUs < 400_000;
    if (last && (one || /[?؟]$/.test(words[last.w1].text))) { last.w1 = sn.w1; last.text += ` ${sn.text}`; }
    else units.push({ w0: sn.w0, w1: sn.w1, text: sn.text });
  }
  const marked = keywords.filter(Boolean);
  for (const u of units) {
    const ws = [];
    for (let i = u.w0; i <= u.w1; i++) if (live(i)) ws.push(words[i]);
    let est = 0;
    ws.forEach((w, k) => { est += w.endUs - w.startUs; if (k) est += Math.min(KEPT_GAP_US, Math.max(0, w.startUs - ws[k - 1].endUs)); });
    u.estUs = est;
    u.role = storyRole(u.text);
    const a = words[u.w0].startUs - 200_000, b = words[u.w1].endUs + 200_000;
    const strength = Math.max(0, ...moments.filter((m) => m.s >= a && m.s <= b && ["laugh", "shock", "oops", "win", "alert", "question", "key", "fire", "no"].includes(m.type)).map((m) => Math.min(1, m.score / 3.2)));
    u.value = ROLE_VALUE[u.role] + 3 * strength + (marked.some((k) => u.text.includes(k)) ? 0.5 : 0);
  }
  // The opening (the first setup or stakes unit, else the first) is always kept.
  const usable = units.filter((u) => u.estUs > 0);
  const opening = usable.find((u) => u.role === "setup" || u.role === "stakes") || usable[0];
  if (opening) opening.must = true;
  const mustUs = units.filter((u) => u.must).reduce((n, u) => n + u.estUs, 0);
  let budget = budgetUs ?? targetUs - mustUs;
  let warning = null;
  if (budget < 0) { warning = "the opening alone is longer than the target"; budget = 0; }
  // 0/1 knapsack at 0.1 s: the most value within the budget, the order of the video kept.
  const items = units.filter((u) => !u.must && u.estUs > 0);
  const cap = Math.floor(budget / 100_000);
  const wt = items.map((u) => Math.max(1, Math.ceil(u.estUs / 100_000)));
  const best = new Float64Array(cap + 1);
  const take = items.map(() => new Uint8Array(cap + 1));
  items.forEach((u, i) => {
    for (let c = cap; c >= wt[i]; c--) if (best[c - wt[i]] + u.value > best[c]) { best[c] = best[c - wt[i]] + u.value; take[i][c] = 1; }
  });
  let c = cap;
  for (let i = items.length - 1; i >= 0; i--) if (take[i][c]) { items[i].kept = true; c -= wt[i]; }
  for (const u of units) if (u.must) u.kept = true;
  const drop = new Map();
  for (const u of units) if (!u.kept) for (let i = u.w0; i <= u.w1; i++) if (live(i)) drop.set(i, "reel");
  const estUs = units.filter((u) => u.kept).reduce((n, u) => n + u.estUs, 0);
  if (!warning && estUs < 0.7 * targetUs) warning = `the strongest sentences fill ${(estUs / US).toFixed(0)} s of the ${(targetUs / US).toFixed(0)} s asked`;
  return { drop, units, estUs, warning };
}
