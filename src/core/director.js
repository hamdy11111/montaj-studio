// The director: turns what is said (word timings) and what is seen (where the person's head is, how it moves) into
// a whole edit plan (montaj.editplan/1) — the decisions an editor makes, written as rules. The rules and their
// numbers are the edit-hamdy editing skill's (core/policy.js):
//  · pacing: what is said is kept whole; stretched hesitations, stutters, restarted sentences and the recogniser's
//    hallucinations go; the silence kept between words depends on the moment (glued after a question, faster before
//    a punchline, a breath after a laugh, never above 0.6 s); wordless moments where something is shown are kept;
//  · angles from one camera: wide / medium / close, never the same twice in a row, close on a punchline or a
//    reaction, the head never cropped (14 % above, 6 % below), within the video's sharpness;
//  · zooms by meaning (moments lexicon): a punch-in on a shock/laugh/win, a push on a question or an idea, spaced;
//  · numbers and lists: every number said becomes a counter (+/− for a gain or a loss), a list a montage of points;
//  · graphics per sentence by value, never entering before their word; emoji at most 4 a minute, 3 s apart, never
//    the same one within 25 s; a reason to keep watching at least every 6 s;
//  · sound: sound events at least 1 s apart, at most 20 a minute; a voice clean-up and the platform loudness;
//  · captions that reveal the words as they are spoken, the chosen words emphasised;
//  · quality guards on the result (core/qa.js), reported with the plan.
// Pure: the caller provides the transcript, the person track and the media facts (agent/director.js).
import { normWord, pauseKind, correctWords, sentences, smartCuts } from "./speech.js";
import { US } from "./util.js";
import { POLICY } from "./policy.js";
import { MOMENT_TYPES } from "./momentsLexicon.js";
import { detectMoments, isPunch, isReaction } from "./moments.js";
import { findNumbers } from "./numbers.js";
import { qaPlan, editTime, editAt, srcAfter, fitHead, headBox, reasonsToWatch, deadSpans, soundEvents } from "./qa.js";

// ------------------------------------------------------------------ meaning → visuals
// [stems, emoji id, icon]: a word matches a stem after normalisation and common prefixes/suffixes are removed.
const LEXICON_RAW = [
  [["شعر", "hair", "شعري"], "barber-pole", "scissors"],
  [["مكركب", "كركبه", "فوضي", "فوضى", "messy", "mess"], "broom", "home"],
  [["اوضه", "غرفه", "room", "بيت", "house"], "broom", "home"],
  [["لون", "الوان", "color", "colour", "صبغ"], "artist-palette", "palette"],
  [["بشره", "جلد", "skin", "وش"], "face-with-monocle", "search"],
  [["عيوب", "عيب", "مشكله", "مشاكل", "problem", "issue"], "warning", "alert-triangle"],
  [["سكوت", "صمت", "ساكت", "silence", "quiet"], "shushing-face", "volume-2"],
  [["فلوس", "مال", "ربح", "دخل", "money", "profit", "cash"], "money-bag", "dollar-sign"],
  [["فكره", "افكار", "idea", "ideas"], "light-bulb", "lightbulb"],
  [["وقت", "ساعه", "دقيقه", "دقايق", "time", "minute", "hour"], "alarm-clock", "clock"],
  [["سريع", "بسرعه", "fast", "quick"], "high-voltage", "zap"],
  [["نجاح", "ناجح", "فوز", "كسب", "success", "win"], "trophy", "trophy"],
  [["نمو", "زياده", "زاد", "growth", "grow"], "chart-increasing", "trending-up"],
  [["خساره", "نقص", "loss", "drop"], "chart-decreasing", "trending-down"],
  [["صح", "صحيح", "تمام", "correct", "right"], "check-mark-button", "check-circle-2"],
  [["غلط", "خطا", "wrong", "mistake"], "cross-mark", "circle-x"],
  [["واو", "جامد", "رهيب", "خارق", "مذهل", "wow", "amazing", "insane"], "exploding-head", "sparkles"],
  [["ضحك", "هزار", "funny", "lol"], "face-with-tears-of-joy", "laugh"],
  [["حب", "بحب", "love"], "red-heart", "heart"],
  [["نار", "ترند", "trend", "viral", "fire"], "fire", "flame"],
  [["سر", "اسرار", "secret"], "shushing-face", "lock"],
  [["شايفين", "شايف", "بص", "شوف", "look", "see"], "eyes", "eye"],
  [["كاميرا", "تصوير", "صوره", "camera", "photo"], "camera", "camera"],
  [["فيديو", "مونتاج", "منتج", "متمنتج", "video", "edit"], "clapper-board", "clapperboard"],
  [["صوت", "مايك", "voice", "audio", "mic"], "microphone", "mic"],
  [["موسيقي", "اغنيه", "music", "song"], "musical-notes", "music"],
  [["هديه", "gift", "giveaway"], "wrapped-gift", "gift"],
  [["عقل", "دماغ", "ذكاء", "brain", "smart"], "brain", "brain"],
  [["قوه", "قوي", "strong", "power"], "flexed-biceps", "zap"],
  [["خطر", "انتبه", "تحذير", "careful", "danger"], "warning", "alert-triangle"],
  [["هدف", "goal", "target"], "pushpin", "target"],
  [["سهل", "بسيط", "easy", "simple"], "victory-hand", "check"],
  [["صعب", "hard", "difficult"], "grinning-face-with-sweat", "help-circle"],
  [["محترف", "احترافي", "pro", "professional"], "smiling-face-with-sunglasses", "award"],
  [["تجربه", "test", "experiment"], "nerd-face", "wand-sparkles"],
  [["تعليق", "تعليقات", "comment", "comments"], "speech-balloon", "message-circle"],
  [["تابع", "تابعني", "اشترك", "follow", "subscribe"], "bell", "bell-ring"],
  [["لايك", "اعجاب", "like"], "thumbs-up", "thumbs-up"],
  [["شكرا", "thanks", "thank"], "folded-hands", "heart"],
  [["موبايل", "تليفون", "phone", "mobile"], "mobile-phone", "smartphone"],
  [["لابتوب", "كمبيوتر", "laptop", "computer"], "laptop", "laptop"],
  [["قص", "قطع", "cut"], "scissors", "scissors"],
  [["مهم", "important"], "red-exclamation-mark", "info"],
  [["حلو", "جميل", "جمال", "beautiful", "nice"], "sparkles", "sparkles"],
  [["تنظيف", "نضيف", "نظف", "clean"], "broom", "sparkles"],
  [["تصلح", "اصلح", "يتظبط", "ظبط", "يتزبط", "fix", "repair"], "hammer-and-wrench", "settings"],
];
const PREFIXES = ["وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ل", "ك"];
const SUFFIXES = ["هم", "ها", "نا", "كم", "ي", "ه", "ك"];
const LEX = LEXICON_RAW.flatMap(([stems, emoji, icon]) => stems.map((s) => [normWord(s), { emoji, icon }]));
const STOP = new Set(["من", "في", "علي", "الي", "عن", "مع", "ده", "دي", "دا", "كده", "كدا", "انا", "انت", "انتو", "احنا", "هو", "هي", "هم", "اللي", "الي", "ان", "انه", "انها", "ما", "لا", "لم", "لن", "يعني", "طيب", "بس", "كمان", "برضه", "عشان", "علشان", "لان", "لو", "كل", "بعض", "هنا", "هناك", "اه", "ايوه", "مش", "كان", "كانت", "يكون", "تكون", "ممكن", "لازم", "جدا", "اوي", "زي", "مثل", "حاجه", "حاجات", "طبعا", "وطبعا", "فطبعا", "عليه", "عليها", "ايه", "اهو", "ونشوف", "وتبقي", "يبقي", "the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "are", "it", "this", "that", "i", "you", "we", "so", "but", "with", "for", "my", "your"].map(normWord));

/** Forms of a word to look up: itself, without a prefix, without a suffix, without both. */
function forms(w) {
  const n = normWord(w), out = new Set([n]);
  for (const p of PREFIXES) if (n.startsWith(p) && n.length - p.length >= 2) out.add(n.slice(p.length));
  for (const f of [...out]) for (const s of SUFFIXES) if (f.endsWith(s) && f.length - s.length >= 2) out.add(f.slice(0, -s.length));
  return [...out];
}

/** The visual a word names ({ emoji, icon }) or null. */
export function conceptOf(word) {
  for (const f of forms(word)) for (const [stem, v] of LEX) if (f === stem || (stem.length >= 4 && f.startsWith(stem))) return v;
  return null;
}
const isStop = (w) => forms(w).some((f) => STOP.has(f)) || normWord(w).length < 3;

/**
 * How good a word is as the one to show: a marked keyword or a named concept first, then nouns (the definite «ال…»),
 * longer words a little; verbs (present/future prefixes) and participles («…ين») lower. No grammar parser: rules.
 */
export function wordScore(w, marked = new Set()) {
  const n = normWord(clean(w));
  if (isStop(w)) return -3;
  let s = Math.min(n.length, 8) * 0.25;
  if (marked.has(n)) s += 5;
  if (conceptOf(w)) s += 3;
  const noun = (n.startsWith("ال") && n.length >= 5) || /ة[.،,!?؟…]*$/u.test(String(w)); // «ال…» or ending in ة
  if (noun) return s + 1.5;
  if (/^(ه|ح|ب)?(ي|ت|ن)./.test(n) && n.length >= 4) s -= 2; // present/future verbs
  if (/^ا.{2,4}$/.test(n)) s -= 1; // «اغير», «اعمل»: first-person verbs
  if (/(نا|وا)$/.test(n) && n.length >= 4) s -= 1.5; // «عملنا», «شافوا»: past verbs
  if (/(ين|ون)$/.test(n) && n.length >= 5) s -= 2.5; // participles, plural verbs
  return s;
}
// Shown text: no end punctuation, and no «و»/«ف» glued to «ال…» («فالسكوت» → «السكوت»).
const clean = (t) => String(t).replace(/[.،,!?؟…:;"«»]+$/u, "").replace(/^[«"]+/u, "").replace(/^[وف](?=ال.{2,})/u, "");

// ------------------------------------------------------------------ the plan
export const DIRECTOR_STYLES = {
  // rhythm: the pacing preset (POLICY.pace.rhythm); gapUs: least time between two graphics in the EDIT.
  energetic: { rhythm: "mrbeast", gapUs: 2_600_000, transitionsEvery: 9_000_000 },
  explain: { rhythm: "normal", gapUs: 3_500_000, transitionsEvery: 12_000_000 },
  calm: { rhythm: "calm", gapUs: 4_500_000, transitionsEvery: 16_000_000 },
};

/** Person track sample nearest to a source time: [tUs, x0, y0, x1, y1, hx, hy, hw, hh, area] or null. */
function sampleAt(track, tUs) {
  if (!track?.length) return null;
  let lo = 0, hi = track.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (track[m][0] < tUs) lo = m + 1; else hi = m; }
  return track[lo];
}

/** Wordless moments where something is shown: inside a pause, the head jumps in size/place (≥ 0.6 s pauses). */
export function visualBeats(words, track, { minPauseUs = 600_000, keepUs = 700_000 } = {}) {
  const out = [];
  if (!track?.length) return out;
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].endUs, b = words[i].startUs;
    if (b - a < minPauseUs) continue;
    let best = 0, at = null, prev = sampleAt(track, a);
    for (const f of track) {
      if (f[0] <= a || f[0] >= b) continue;
      const d = Math.abs(f[5] - prev[5]) + Math.abs(f[6] - prev[6]) + 2 * Math.abs(f[7] - prev[7]);
      if (d > best) { best = d; at = f[0]; }
      prev = f;
    }
    if (best > 0.06 && at !== null) out.push([Math.max(a, at - keepUs / 2), Math.min(b, at + keepUs / 2)]);
  }
  return out;
}

/** Source time of an EDIT time (the inverse of editTime). */
function srcAt(cuts, editUs) {
  let removed = 0;
  for (const c of cuts) { if (c.fromUs <= editUs + removed) removed += c.toUs - c.fromUs; else break; }
  return editUs + removed;
}

/** How the video sits in the canvas: the share it fills per axis, and the zoom it takes before it gets soft. */
export function videoFit(media, canvas) {
  const aspect = media?.width && media?.height ? media.width / media.height : 1;
  if (!media?.width || !media?.height || !canvas?.width || !canvas?.height) return { dx: 1, dy: 1, sharpZoom: null, aspect };
  const va = aspect, ca = canvas.width / canvas.height;
  return { dx: va >= ca ? 1 : va / ca, dy: va >= ca ? ca / va : 1, sharpZoom: Math.max(media.width / canvas.width, media.height / canvas.height), aspect };
}

const SYNC_US = Math.round(POLICY.sync.tol * US);

/**
 * A whole edit plan. input: { mediaId, words: [{text,startUs,endUs}], durationUs, track (MatteService.track, may be
 * empty), media: { width, height }, canvas: { width, height }, style, keywords, cta, captionTemplate, title }.
 * The rules and numbers are the edit-hamdy skill's (core/policy.js). Returns { plan, notes, qa } — notes explain each
 * decision, qa is the quality guards' verdict on the plan (core/qa.js).
 */
export function directPlan(input) {
  const { mediaId, durationUs, track = [], keywords = [], style = "energetic", cta = "", captionTemplate = "clean-pro", title = "Auto edit", corrections = [] } = input;
  // Recognition fixes first, so graphics show the right words (the same fixes go to the captions).
  const words = correctWords((input.words || []).map((w) => ({ t: w.text, s: w.startUs, e: w.endUs })), corrections).map((w) => ({ text: w.t, startUs: w.s, endUs: w.e }));
  const st = DIRECTOR_STYLES[style] || DIRECTOR_STYLES.energetic;
  const notes = [];
  if (!words.length) return { plan: { schema: "montaj.editplan/1", title, audio: { denoise: true, enhanceVoice: true, normalizeLufs: -14 }, stabilize: true }, notes: ["no speech: clean-up and stabilization only"], qa: null };
  const Z = POLICY.zoom, A = POLICY.angles, E = POLICY.emoji;
  const S = (s) => Math.round(s * US);

  // 1. Pacing (the skill's rhythm): what is said is kept whole; stretched hesitations, stutters, restarts and the
  // recogniser's hallucinations go; the silence left between words depends on the moment.
  const moments = detectMoments(words, { keywords });
  const keep = visualBeats(words, track);
  for (const [a, b] of keep) notes.push(`kept a wordless moment ${(a / US).toFixed(1)}–${(b / US).toFixed(1)} s (something is shown)`);
  const { cuts: rawCuts, removed } = smartCuts(words, {
    pace: POLICY.pace, rhythm: st.rhythm, durationUs, keep,
    moments: moments.map((m) => ({ s: m.s, e: m.e, punch: isPunch(m) && m.score >= Z.minScore, reaction: isReaction(m) })),
  });
  const cuts = rawCuts.sort((x, y) => x.fromUs - y.fromUs);
  const total = editAt(cuts, durationUs);
  const why = {};
  for (const r of removed.values()) why[r] = (why[r] || 0) + 1;
  notes.push(`pacing «${st.rhythm}»: ${cuts.length} cuts, ${(durationUs / US).toFixed(1)} → ${(total / US).toFixed(1)} s${Object.keys(why).length ? ` (removed: ${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`);
  const kept = words.filter((w, i) => !removed.has(i) && editTime(cuts, w.startUs) !== null);
  const momentsKept = moments.filter((m) => editTime(cuts, m.s) !== null);

  // 2. Angles from one camera: wide / medium / close, never the same twice in a row (hides every jump cut); close on
  // a punch, a reaction or a marked word; wide on a long shot. The head is never cropped (fitHead).
  const fit = videoFit(input.media, input.canvas);
  let C = A.C, M = A.M;
  if (fit.sharpZoom && C > 1.02 * fit.sharpZoom) { C = Math.max(A.minC, fit.sharpZoom); M = Math.min(M, 1 + (C - 1) / 2); }
  const LEVEL = { W: A.W, M, C };
  const shots = [];
  let s0 = 0;
  for (const c of cuts) { if (c.fromUs - s0 > 200_000) shots.push([s0, c.fromUs]); s0 = c.toUs; }
  if (durationUs - s0 > 200_000) shots.push([s0, durationUs]);
  let prevAngle = null;
  const angleOf = shots.map(([a, b]) => {
    const inShot = momentsKept.filter((m) => m.s >= a && m.s < b);
    let ang, because;
    if (inShot.some((m) => isPunch(m) && m.score >= Z.minScore)) { ang = "C"; because = "a punchline / reveal"; }
    else if (inShot.some(isReaction)) { ang = "C"; because = "a reaction"; }
    else if (editAt(cuts, b) - editAt(cuts, a) >= S(A.longShot)) { ang = "W"; because = "a long shot"; }
    else { ang = "M"; because = "speech"; }
    if (ang === prevAngle) { ang = ang === "M" ? (because === "speech" ? "C" : "W") : "M"; because += ", the angle changes at the cut"; }
    prevAngle = ang;
    return { ang, because };
  });
  const zooms = [];
  shots.forEach(([a, b], i) => {
    const { ang, because } = angleOf[i];
    if (LEVEL[ang] <= 1.0001) return;
    const fr = fitHead(LEVEL[ang], headBox(track, a, b, fit.aspect), fit);
    if (fr.scale >= 1.02) zooms.push({ mediaId, fromUs: a, toUs: b, ...fr, reason: `angle ${ang} (${because})` });
  });
  const angleAt = (src) => { const i = shots.findIndex(([a, b]) => src >= a && src < b); return i < 0 ? 1 : LEVEL[angleOf[i].ang]; };

  // 3. Zooms by meaning: a punch-in on a shock/laugh/win, a slow push on a question or an idea — spaced out.
  const sfxWanted = [];
  const meaning = [];
  for (const m of [...momentsKept].sort((p, q) => q.score - p.score)) {
    const kind = MOMENT_TYPES[m.type]?.zoom;
    if (!kind || kind === "none" || m.score < Z.minScore) continue;
    const t = editTime(cuts, m.s);
    if (meaning.some((c) => Math.abs(t - c.t) <= S(Z.minGap)) || (kind === "punch" && meaning.some((c) => c.kind === "punch" && Math.abs(t - c.t) < S(Z.punchGap)))) continue;
    const z = Z[kind];
    meaning.push({ t, kind, m, fromUs: srcAt(cuts, Math.max(0, t - S(z.before))), toUs: srcAfter(cuts, m.s, S(z.after), durationUs), factor: z.factor });
  }
  meaning.sort((a, b) => a.t - b.t);
  for (let i = 1; i < meaning.length; i++) if (meaning[i].fromUs < meaning[i - 1].toUs) meaning[i - 1].toUs = meaning[i].fromUs - S(Z.clear);
  const meaningZooms = meaning.filter((c) => editAt(cuts, c.toUs) - editAt(cuts, c.fromUs) >= S(Z.minLen)).map((c) => {
    const fr = fitHead(Math.min(angleAt(c.m.s) * c.factor, C * Z.punch.factor), headBox(track, c.fromUs, c.toUs, fit.aspect), fit);
    if (c.kind === "punch") sfxWanted.push({ mediaId, atUs: Math.round(c.m.s), sound: "impact", why: `${c.m.type} «${clean(c.m.text)}»` });
    return { mediaId, fromUs: c.fromUs, toUs: c.toUs, ...fr, reason: `${c.kind}-in: ${c.m.type} «${clean(c.m.text)}»` };
  }).filter((z) => z.scale >= 1.02);

  // 4. Graphics. Numbers first: every number said becomes a graphic (a counter; +/− for a gain or a loss), every list
  // a montage (one point per item, on its word). Then the sentences worth one, by value, spaced out in the edit.
  const nums = findNumbers(kept);
  const graphics = [], emphasis = new Set(keywords), taken = [];
  const startAt = (w) => Math.max(0, w.startUs - SYNC_US); // never before the word
  // Text graphics never share the screen (the skill's text-collision guard): one ends before the next starts.
  const TEXTS = new Set(["emerge-side", "rise-behind", "word-stack", "counter", "list-item", "pass-behind", "big-word", "title-reveal"]);
  const span = (g) => [editAt(cuts, g.fromUs), editAt(cuts, Math.min(durationUs, g.toUs))];
  const collides = (g, list) => TEXTS.has(g.template) && list.some((o) => TEXTS.has(o.template) && span(g)[0] < span(o)[1] && span(g)[1] > span(o)[0]);
  const addGraphic = (g, whyText) => {
    graphics.push({ mediaId, ...g, fromUs: Math.max(0, Math.round(g.fromUs)), toUs: Math.round(Math.min(durationUs, g.toUs)), reason: whyText.slice(0, 200), sfx: g.sfx !== false });
    taken.push({ t: editAt(cuts, g.fromUs), kind: g.template, light: g.template === "head-emoji" });
    notes.push(`${g.template} at ${(g.fromUs / US).toFixed(1)} s: ${whyText}`);
  };
  const inList = new Set(nums.lists.flat());
  for (const L of nums.lists) L.forEach((idx, k) => {
    const x = nums.numbers[idx], next = nums.numbers[L[k + 1]];
    addGraphic({ template: "list-item", fromUs: x.at - SYNC_US, toUs: next ? next.at - SYNC_US : srcAfter(cuts, x.at, 1_500_000, durationUs), params: { number: String(k + 1), text: x.label.slice(0, 60), position: "top" } }, `list point ${k + 1}: «${x.label}»`);
  });
  for (const [i, x] of nums.numbers.entries()) {
    if (inList.has(i) || (x.kind === "info" && !x.unit)) continue;
    const t = editAt(cuts, x.at);
    if (taken.some((o) => Math.abs(o.t - t) < 1_500_000)) continue;
    const accent = x.sign === "-" ? "#FF4D6D" : x.sign === "+" ? "#3EE07B" : "#FFD84D";
    addGraphic({ template: "counter", fromUs: x.at - SYNC_US, toUs: srcAfter(cuts, x.at, 2_400_000, durationUs), params: { from: 0, to: x.value, decimals: Number.isInteger(x.value) ? 0 : 1, prefix: x.sign === "-" ? "−" : x.sign, suffix: x.unit ? ` ${x.unit}` : "", label: "", accent, position: "top" } }, `the number «${x.label}» (${x.kind})`);
  }
  const numberSents = new Set(nums.numbers.map((x) => x.seg));

  const sents = sentences(kept);
  const kw = new Set(keywords.map(normWord));
  const room = (f) => (f ? Math.max(f[1], 1 - f[3]) : 0.3); // free width beside the person at head height
  const roomAbove = (f) => (f ? f[6] - f[8] / 2 : 0.2);
  const pick = (w) => clean(w.text);
  const cands = sents.map((sn, si) => {
    if (numberSents.has(si)) return null;
    const ws = kept.slice(sn.w0, sn.w1 + 1);
    const content = ws.filter((w) => !isStop(w.text)).map((w) => ({ w, score: wordScore(w.text, kw) })).sort((x, y) => y.score - x.score);
    const concept = ws.map((w) => ({ w, c: conceptOf(w.text) })).find((x) => x.c);
    const question = /[?؟]$/.test(ws[ws.length - 1].text);
    const moment = momentsKept.filter((m) => m.s >= ws[0].startUs && m.s <= ws[ws.length - 1].endUs && MOMENT_TYPES[m.type]?.emoji?.length && m.score >= E.minScore && m.type !== "yes" && m.type !== "time").sort((a, b) => b.score - a.score)[0];
    const value = (content[0]?.score || 0) + (question ? 3 : 0) + (si === 0 ? 4 : 0) + (concept ? 2 : 0) + (moment ? moment.score : 0);
    return { si, ws, content, concept, question, moment, value, start: editTime(cuts, ws[0].startUs) };
  }).filter((c) => c && c.start !== null && (c.content.length || c.question));
  // A light accent (an emoji) may come sooner than a big kinetic text.
  const light = (c) => c.si !== 0 && (c.concept || c.question || c.moment);
  const gapFor = (a, b) => (a.light || b.light ? st.gapUs * 0.55 : st.gapUs);
  const chosen = [];
  for (const c of [...cands].sort((x, y) => y.value - x.value)) {
    const me = { t: c.start, light: light(c) };
    if (c.value >= 2 && taken.every((o) => Math.abs(o.t - c.start) >= gapFor(o, me)) && chosen.every((o) => Math.abs(o.start - c.start) >= gapFor({ light: light(o) }, me))) chosen.push(c);
  }
  chosen.sort((x, y) => x.start - y.start);
  // Emoji, governed: at most 4 a minute, 3 s apart, the same one not again within 25 s.
  const emojiCap = Math.max(1, Math.floor((E.perMin * total) / (60 * US)));
  const emojiUsed = [];
  const emojiFor = (t, options) => {
    if (emojiUsed.length >= emojiCap || emojiUsed.some((e) => Math.abs(e.t - t) < S(E.minGap))) return null;
    return options.find((name) => !emojiUsed.some((e) => e.name === name && Math.abs(e.t - t) < S(E.sameWindow))) || null;
  };
  // Variety: the same treatment never looks the same twice running (colour and style rotate).
  const LOOKS = [{ style: "box", accent: "#FF2E63" }, { style: "gradient", color: "#FFFFFF", accent: "#FFD84D" }, { style: "box", accent: "#7B5CFF" }, { style: "outline", color: "#FFFFFF" }, { style: "box", accent: "#00A8A0" }, { style: "gradient", color: "#FFFFFF", accent: "#3EE07B" }];
  let looks = 0;
  // Nothing new in the call-to-action's window at the end.
  const ctaFrom = cta ? editTime(cuts, Math.max(0, kept[kept.length - 1].endUs - 2_600_000)) ?? Infinity : Infinity;
  let lastKind = "";
  const wordGraphic = (kind, key, ws, content) => {
    if (kind === "word-stack") {
      const pickWords = content.filter((x) => x.score > 1).slice(0, 3).map((x) => x.w).sort((a, b) => a.startUs - b.startUs);
      const first = pickWords[0], last = pickWords[pickWords.length - 1];
      const e0 = editTime(cuts, first.startUs);
      for (const w of pickWords) emphasis.add(pick(w));
      return [{ template: "word-stack", fromUs: startAt(first), toUs: Math.max(srcAfter(cuts, last.endUs, 1_000_000, durationUs), srcAfter(cuts, first.startUs, 2_000_000, durationUs)), params: { words: pickWords.map(pick), times: pickWords.map((w) => Math.max(0, Math.round(((editTime(cuts, w.startUs) ?? e0) - e0 + SYNC_US) / 1000))) } }, `words as they are said: ${pickWords.map(pick).join(" / ")}`];
    }
    const look = kind === "emerge-side" ? LOOKS[looks++ % LOOKS.length] : {};
    emphasis.add(pick(key));
    return [{ template: kind, fromUs: startAt(key), toUs: srcAfter(cuts, key.startUs, kind === "rise-behind" ? 1_800_000 : 1_600_000, durationUs), params: { text: pick(key), ...look } }, `the key word «${pick(key)}» ${kind === "rise-behind" ? "rises from behind" : "comes out from behind"} the person`];
  };
  for (const c of chosen) {
    if (c.start >= ctaFrom - 300_000) continue;
    const { si, ws, content, concept, question, moment } = c;
    const key = content[0]?.w;
    const f = sampleAt(track, (key || ws[0]).startUs);
    let made = null;
    // An emoji when the sentence has a moment (laugh, shock, win…), a named concept or is a question — if allowed.
    if (si !== 0 && (moment || question || concept) && lastKind !== "head-emoji" && track.length) {
      // What is named comes first (a concept's own emoji), then the moment's type, then a question.
      const at = concept ? concept.w : moment ? kept.find((w) => w.startUs >= moment.s) || ws[ws.length - 1] : ws[ws.length - 1];
      const t = editTime(cuts, at.startUs);
      const options = concept ? [concept.c.emoji] : moment ? MOMENT_TYPES[moment.type].emoji : ["thinking-face", "face-with-monocle"];
      const name = t === null ? null : emojiFor(t, options);
      if (name) {
        emojiUsed.push({ t, name });
        const whyText = concept ? `«${pick(concept.w)}» → ${name}` : moment ? `${moment.type} «${clean(moment.text)}» → ${name}` : "a question: a thinking face";
        made = [{ template: "head-emoji", fromUs: startAt(at), toUs: srcAfter(cuts, at.startUs, S(moment?.type === "laugh" ? E.laughDur : E.dur), durationUs), params: { emoji: name, motion: question ? "wiggle" : "bounce", size: 0.26 } }, whyText];
      }
    }
    if (!made && key && track.length) {
      let kind = null;
      if (si === 0) kind = roomAbove(f) > 0.12 ? "rise-behind" : "emerge-side";
      else if (content.filter((x) => x.score > 1).length >= 2 && lastKind !== "word-stack" && room(f) > 0.22) kind = "word-stack";
      else if (room(f) > 0.2 && lastKind !== "emerge-side") kind = "emerge-side";
      else if (roomAbove(f) > 0.12 && lastKind !== "rise-behind") kind = "rise-behind";
      else if (room(f) > 0.2) kind = "emerge-side";
      if (kind) made = wordGraphic(kind, key, ws, content);
    }
    if (!made || collides(made[0], graphics)) continue;
    addGraphic(...made);
    lastKind = made[0].template;
  }

  // 5. Transitions at the longest removed pauses between sentences, spaced out.
  const transitions = [];
  for (const c of [...cuts].sort((a, b) => (b.toUs - b.fromUs) - (a.toUs - a.fromUs))) {
    const at = editTime(cuts, c.toUs);
    if (c.toUs - c.fromUs < 1_200_000 || at === null) continue;
    if (transitions.some((x) => Math.abs(editTime(cuts, x.atUs) - at) < st.transitionsEvery) || at < 2 * US) continue;
    transitions.push({ mediaId, atUs: Math.round(c.fromUs), type: transitions.length % 2 ? "push_left" : "zoom_in", durationUs: 280_000, reason: "topic change (a long pause was cut)" });
    sfxWanted.push({ mediaId, atUs: Math.round(c.toUs), sound: "whoosh", why: "transition" });
  }

  // 6. Finishing.
  const lastWord = kept[kept.length - 1];
  if (cta) {
    graphics.push({ mediaId, template: "follow-cta", fromUs: Math.max(0, Math.round(lastWord.endUs - 2_600_000)), toUs: Math.round(Math.min(durationUs, lastWord.endUs + 400_000)), params: { text: cta, position: "top" }, sfx: true });
    notes.push(`a call to action at the end: «${cta}»`);
  }
  graphics.push({ mediaId, template: "progress-bar", fromUs: kept[0].startUs, toUs: lastWord.endUs, params: { position: "top", thickness: 0.006 } });

  // Zooms never overlap: the meaning zooms win over the angle they fall into.
  const framing = zooms.flatMap((z) => {
    let parts = [[z.fromUs, z.toUs]];
    for (const p of meaningZooms) parts = parts.flatMap(([a, b]) => (p.toUs <= a || p.fromUs >= b ? [[a, b]] : [[a, p.fromUs], [p.toUs, b]]).filter(([x, y]) => y - x > 300_000));
    return parts.map(([a, b]) => ({ ...z, fromUs: a, toUs: b }));
  });
  const plan = {
    schema: "montaj.editplan/1", title,
    cuts: cuts.map((c) => ({ mediaId, fromUs: Math.round(c.fromUs), toUs: Math.round(c.toUs), reason: c.reason })),
    zooms: [...framing, ...meaningZooms].map((z) => ({ ...z, fromUs: Math.round(z.fromUs), toUs: Math.round(z.toUs) })).sort((a, b) => a.fromUs - b.fromUs),
    transitions, graphics, sfx: [],
    stabilize: true,
    audio: { denoise: true, enhanceVoice: true, normalizeLufs: -14 },
  };

  // 7. Retention: a reason to keep watching at least every 6 s — a dead stretch gets its strongest word on screen
  // (or a punch-in when there is no person to place it by).
  for (let round = 0; round < 12; round++) {
    const dead = deadSpans(reasonsToWatch(plan, { words: kept, cuts, numbers: nums.numbers }), total);
    if (!dead.length) break;
    let fixed = false;
    for (const [a, b] of dead) {
      const pool = kept.filter((w) => { const t = editTime(cuts, w.startUs); return t !== null && t > a + 1_000_000 && t < b - 1_000_000 && !isStop(w.text); });
      const ranked = pool.map((w) => ({ w, score: wordScore(w.text, kw) - Math.abs(editTime(cuts, w.startUs) - (a + b) / 2) / (3 * US) })).sort((x, y) => y.score - x.score);
      const placeable = (w) => { const f = sampleAt(track, w.startUs); return track.length && (room(f) > 0.2 || roomAbove(f) > 0.12); };
      const kindAt = (w) => (room(sampleAt(track, w.startUs)) > 0.2 ? "emerge-side" : "rise-behind");
      const best = ranked.find((x) => placeable(x.w) && !collides(wordGraphic(kindAt(x.w), x.w, [x.w], [{ w: x.w, score: 1 }])[0], plan.graphics)) || ranked[0];
      if (!best) continue;
      if (placeable(best.w) && !collides(wordGraphic(kindAt(best.w), best.w, [best.w], [{ w: best.w, score: 1 }])[0], plan.graphics)) {
        const made = wordGraphic(kindAt(best.w), best.w, [best.w], [{ w: best.w, score: 1 }]);
        plan.graphics.push({ mediaId, ...made[0], fromUs: Math.round(made[0].fromUs), toUs: Math.round(Math.min(durationUs, made[0].toUs)), reason: `retention: ${made[1]}`.slice(0, 200), sfx: true });
        notes.push(`${made[0].template} at ${(made[0].fromUs / US).toFixed(1)} s: nothing new for ${((b - a) / US).toFixed(1)} s — «${pick(best.w)}»`);
      } else {
        const z = Z.punch, from = Math.max(0, best.w.startUs - S(z.before)), to = srcAfter(cuts, best.w.startUs, S(z.after), durationUs);
        if (plan.zooms.some((x) => x.fromUs < to && x.toUs > from && /^(punch|push)/.test(x.reason))) continue;
        const fr = fitHead(Math.min(angleAt(best.w.startUs) * z.factor, C * z.factor), headBox(track, from, to, fit.aspect), fit);
        if (fr.scale < 1.02) continue; // the head fills the frame: no room for a punch-in
        plan.zooms = plan.zooms.flatMap((x) => (x.toUs <= from || x.fromUs >= to ? [x] : [{ ...x, toUs: from }, { ...x, fromUs: to }].filter((y) => y.toUs - y.fromUs > 300_000)));
        plan.zooms.push({ mediaId, fromUs: Math.round(from), toUs: Math.round(to), ...fr, reason: `punch-in: retention «${pick(best.w)}»` });
        plan.zooms.sort((p, q) => p.fromUs - q.fromUs);
        notes.push(`punch-in at ${(from / US).toFixed(1)} s: nothing new for ${((b - a) / US).toFixed(1)} s — «${pick(best.w)}»`);
      }
      fixed = true;
    }
    if (!fixed) break;
  }

  // 8. Sound, governed (the skill's sfx rules): at least 1 s between sound events (sounds 0.08 s apart are one), at
  // most 20 a minute. A graphic whose sounds would crowd an earlier one plays silent; extra sfx are dropped.
  const ev = [];
  const fits = (list) => list.every((t) => ev.every((e) => Math.abs(e - t) >= S(POLICY.sfx.minGap) || Math.abs(e - t) <= S(POLICY.sfx.layered)))
    && list.every((t, i) => list.every((u, j) => i === j || Math.abs(u - t) >= S(POLICY.sfx.minGap) || Math.abs(u - t) <= S(POLICY.sfx.layered)));
  const capSfx = Math.floor((POLICY.sfx.perMin * total) / (60 * US));
  let silenced = 0;
  for (const g of [...plan.graphics].sort((a, b) => a.fromUs - b.fromUs)) {
    if (!g.sfx) continue;
    const mine = soundEvents({ graphics: [g] }, cuts).map((e) => e.t);
    if (mine.length && fits(mine) && ev.length + mine.length <= capSfx) ev.push(...mine);
    else if (mine.length) { g.sfx = false; silenced++; }
  }
  for (const x of sfxWanted.sort((a, b) => a.atUs - b.atUs)) {
    const t = editAt(cuts, x.atUs);
    if (fits([t]) && ev.length < capSfx) { ev.push(t); plan.sfx.push({ mediaId, atUs: x.atUs, sound: x.sound }); }
  }
  if (silenced) notes.push(`${silenced} graphic(s) play without their sound effect (sounds kept at least ${POLICY.sfx.minGap} s apart)`);

  plan.captions = { template: captionTemplate, reveal: true, keywords: [...emphasis].slice(0, 60), ...(corrections.length ? { corrections } : {}) };
  const qa = qaPlan(plan, { words, removed, durationUs, track, style, numbers: nums.numbers, fit });
  const fails = qa.checks.filter((c) => c.level === "fail");
  notes.push(qa.ok ? `quality guards: all ${qa.passed.length} passed` : `quality guards: ${fails.length} problem(s) — ${fails.slice(0, 3).map((c) => c.message).join("; ")}`);
  return { plan, notes, qa };
}

export { pauseKind };
