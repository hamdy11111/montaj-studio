// The director: turns what is said (word timings) and what is seen (where the person's head is, how it moves) into
// a whole edit plan (montaj.editplan/1) — the decisions an editor makes, written as rules:
//  · pacing: every pause cut on the words ("creator" style), keeping beats after questions/exclamations and the
//    wordless moments where something is shown (the head jumps in size or place: a close-up, a move);
//  · framing: consecutive shots alternate wide / closer (the classic way to hide jump cuts), the face kept where it
//    is; a punch-in on questions and exclamations;
//  · graphics: per sentence, one treatment chosen from its content — an emoji for a concept it names (a small
//    Arabic/English lexicon), a word coming out from behind the person, stacked words, a word rising — with a rhythm
//    (one every few seconds of the edit), no treatment twice in a row, and only where there is room beside the person;
//  · sound: every motion gets its sound; a voice clean-up and the platform loudness;
//  · captions that reveal the words as they are spoken, the chosen words emphasised.
// Pure: the caller provides the transcript, the person track and the media facts (agent/director.js).
import { normWord, suggestCuts, pauseKind, correctWords } from "./speech.js";
import { US } from "./util.js";

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
  // gapUs: least time between two graphics in the EDIT; zoom: the closer framing of alternate shots; punch: on ?/!
  energetic: { gapUs: 2_600_000, zoom: 1.14, punch: 1.26, transitionsEvery: 9_000_000 },
  calm: { gapUs: 4_500_000, zoom: 1.08, punch: 1.15, transitionsEvery: 16_000_000 },
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

/** The source time reached after `editUs` of EDIT time from source `fromUs` (the cuts in between are skipped). */
function srcAfter(cuts, fromUs, editUs, maxUs = Infinity) {
  let t = fromUs, left = editUs;
  for (const c of cuts) {
    if (c.toUs <= t) continue;
    if (c.fromUs > t) { const span = c.fromUs - t; if (span >= left) return Math.min(maxUs, t + left); left -= span; }
    t = Math.max(t, c.toUs);
  }
  return Math.min(maxUs, t + left);
}

/** Edit time of a source time once `cuts` ([{fromUs,toUs}] sorted) are removed; null when cut. */
function editTime(cuts, src) {
  let removed = 0;
  for (const c of cuts) { if (c.toUs <= src) removed += c.toUs - c.fromUs; else if (c.fromUs < src) return null; }
  return src - removed;
}

/**
 * A whole edit plan. input: { mediaId, words: [{text,startUs,endUs}], durationUs, track (MatteService.track, may be
 * empty), media: { width, height }, canvas: { width, height }, style, keywords, cta, captionTemplate, title }.
 * Returns { plan, notes } — notes explain each decision (shown to the user / the agent).
 */
export function directPlan(input) {
  const { mediaId, durationUs, track = [], keywords = [], style = "energetic", cta = "", captionTemplate = "clean-pro", title = "Auto edit", corrections = [] } = input;
  // Recognition fixes first, so graphics show the right words (the same fixes go to the captions).
  const words = correctWords((input.words || []).map((w) => ({ t: w.text, s: w.startUs, e: w.endUs })), corrections).map((w) => ({ text: w.t, startUs: w.s, endUs: w.e }));
  const st = DIRECTOR_STYLES[style] || DIRECTOR_STYLES.energetic;
  const notes = [];
  if (!words.length) return { plan: { schema: "montaj.editplan/1", title, audio: { denoise: true, enhanceVoice: true, normalizeLufs: -14 }, stabilize: true }, notes: ["no speech: clean-up and stabilization only"] };

  // 1. Pacing.
  const keep = visualBeats(words, track);
  for (const [a, b] of keep) notes.push(`kept a wordless moment ${(a / US).toFixed(1)}–${(b / US).toFixed(1)} s (something is shown)`);
  const cuts = suggestCuts(words, { style: "creator", durationUs, keep }).sort((x, y) => x.fromUs - y.fromUs);
  const removed = cuts.reduce((n, c) => n + c.toUs - c.fromUs, 0);
  notes.push(`cut ${cuts.length} pauses/fillers: ${(durationUs / US).toFixed(1)} → ${((durationUs - removed) / US).toFixed(1)} s`);

  // 2. Shots (what is left between cuts) and framing: alternate wide / closer, the face kept in place.
  const shots = [];
  let s0 = 0;
  for (const c of cuts) { if (c.fromUs - s0 > 200_000) shots.push([s0, c.fromUs]); s0 = c.toUs; }
  if (durationUs - s0 > 200_000) shots.push([s0, durationUs]);
  const zooms = [];
  const facing = (a, b, scale) => {
    const f = sampleAt(track, (a + b) / 2);
    if (!f) return { scale };
    const bw = 1, bh = 1, lim = (scale - 1) / 2;
    const x = Math.max(-lim, Math.min(lim, -(f[5] - 0.5) * (scale - 1) * bw)), y = Math.max(-lim, Math.min(lim, -(f[6] - 0.5) * (scale - 1) * bh));
    return { scale, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  };
  shots.forEach(([a, b], i) => { if (i % 2 === 1) zooms.push({ mediaId, fromUs: a, toUs: b, ...facing(a, b, st.zoom), reason: "alternate framing (hides the jump cut)" }); });

  // 3. Graphics: the sentences worth one are chosen by value (a concept, a question, the opening, marked words),
  // then spaced out in the edit; each gets the treatment its content asks for, never the same twice in a row.
  const sents = [];
  let w0 = 0;
  words.forEach((w, i) => { if (i === words.length - 1 || /[.!?؟…]$/.test(w.text) || words[i + 1].startUs - w.endUs >= 700_000) { sents.push({ w0, w1: i }); w0 = i + 1; } });
  const kw = new Set(keywords.map(normWord));
  const graphics = [], sfx = [], emphasis = new Set(keywords);
  const room = (f) => (f ? Math.max(f[1], 1 - f[3]) : 0.3); // free width beside the person at head height
  const roomAbove = (f) => (f ? f[6] - f[8] / 2 : 0.2);
  const pick = (w) => clean(w.text);
  const cands = sents.map((sn, si) => {
    const ws = words.slice(sn.w0, sn.w1 + 1).filter((w) => editTime(cuts, w.startUs) !== null);
    if (!ws.length) return null;
    const content = ws.filter((w) => !isStop(w.text)).map((w) => ({ w, score: wordScore(w.text, kw) })).sort((x, y) => y.score - x.score);
    const concept = ws.map((w) => ({ w, c: conceptOf(w.text) })).find((x) => x.c);
    const question = /[?؟]$/.test(ws[ws.length - 1].text);
    const value = (content[0]?.score || 0) + (question ? 3 : 0) + (si === 0 ? 4 : 0) + (concept ? 2 : 0);
    return { si, ws, content, concept, question, value, start: editTime(cuts, ws[0].startUs) };
  }).filter((c) => c && (c.content.length || c.question));
  const chosen = [];
  // A light accent (an emoji for a named concept or a question) may come sooner than a big kinetic text.
  const light = (c) => c.si !== 0 && (c.concept || c.question);
  const gapFor = (a, b) => (light(a) || light(b) ? st.gapUs * 0.55 : st.gapUs);
  for (const c of [...cands].sort((x, y) => y.value - x.value)) if (c.value >= 2 && chosen.every((o) => Math.abs(o.start - c.start) >= gapFor(o, c))) chosen.push(c);
  chosen.sort((x, y) => x.start - y.start);
  // Variety: the same treatment never looks the same twice running (colour and style rotate).
  const LOOKS = [{ style: "box", accent: "#FF2E63" }, { style: "gradient", color: "#FFFFFF", accent: "#FFD84D" }, { style: "box", accent: "#7B5CFF" }, { style: "outline", color: "#FFFFFF" }, { style: "box", accent: "#00A8A0" }, { style: "gradient", color: "#FFFFFF", accent: "#3EE07B" }];
  let looks = 0;
  // Nothing new in the call-to-action's window at the end.
  const ctaFrom = cta ? editTime(cuts, Math.max(0, words[words.length - 1].endUs - 2_600_000)) ?? Infinity : Infinity;
  let lastKind = "";
  for (const c of chosen) {
    if (c.start >= ctaFrom - 300_000) continue;
    const { si, ws, content, concept, question } = c;
    const key = content[0]?.w;
    const f = sampleAt(track, (key || ws[0]).startUs);
    let kind;
    if (si === 0 && key) kind = roomAbove(f) > 0.12 ? "rise-behind" : "emerge-side";
    else if (question) kind = "head-emoji";
    else if (concept && lastKind !== "head-emoji") kind = "head-emoji";
    else if (content.filter((x) => x.score > 1).length >= 2 && lastKind !== "word-stack" && room(f) > 0.22) kind = "word-stack";
    else if (key && room(f) > 0.2 && lastKind !== "emerge-side") kind = "emerge-side";
    else if (key && roomAbove(f) > 0.12 && lastKind !== "rise-behind") kind = "rise-behind";
    else if (concept) kind = "head-emoji";
    else if (key && room(f) > 0.2) kind = "emerge-side";
    else continue;
    let g;
    if (kind === "head-emoji") {
      const at = concept?.w || ws[ws.length - 1];
      const emoji = question && !concept ? "thinking-face" : concept.c.emoji;
      g = { template: "head-emoji", fromUs: at.startUs - 80_000, toUs: srcAfter(cuts, at.startUs, 1_400_000, durationUs), params: { emoji, motion: question ? "wiggle" : "bounce", size: 0.26 }, why: question && !concept ? "a question: a thinking face" : `«${pick(at)}» → ${emoji}` };
    } else if (kind === "word-stack") {
      const pickWords = content.filter((x) => x.score > 1).slice(0, 3).map((x) => x.w).sort((a, b) => a.startUs - b.startUs);
      const first = pickWords[0], last = pickWords[pickWords.length - 1];
      // Word times in EDIT time (pauses between them are cut), from the graphic's start (0.12 s before the first).
      const e0 = editTime(cuts, first.startUs);
      g = { template: "word-stack", fromUs: first.startUs - 120_000, toUs: Math.max(srcAfter(cuts, last.endUs, 1_000_000, durationUs), srcAfter(cuts, first.startUs, 2_000_000, durationUs)), params: { words: pickWords.map(pick), times: pickWords.map((w) => Math.max(0, Math.round(((editTime(cuts, w.startUs) ?? e0) - e0 + 120_000) / 1000))) }, why: `words as they are said: ${pickWords.map(pick).join(" / ")}` };
      for (const w of pickWords) emphasis.add(pick(w));
    } else {
      const look = kind === "emerge-side" ? LOOKS[looks++ % LOOKS.length] : {};
      g = { template: kind, fromUs: key.startUs - 120_000, toUs: srcAfter(cuts, key.startUs, kind === "rise-behind" ? 1_800_000 : 1_600_000, durationUs), params: { text: pick(key), ...look }, why: `the key word «${pick(key)}» ${kind === "rise-behind" ? "rises from behind" : "comes out from behind"} the person` };
      emphasis.add(pick(key));
    }
    const { why, ...item } = g;
    graphics.push({ mediaId, ...item, fromUs: Math.max(0, Math.round(g.fromUs)), toUs: Math.round(Math.min(durationUs, g.toUs)), reason: why.slice(0, 200), sfx: true });
    notes.push(`${g.template} at ${(g.fromUs / US).toFixed(1)} s: ${g.why}`);
    lastKind = kind;
    // A punch-in on a question or an exclamation, with an impact.
    if (question || /!$/.test(ws[ws.length - 1].text)) {
      const w = ws[ws.length - 1];
      zooms.push({ mediaId, fromUs: w.startUs, toUs: Math.min(durationUs, w.endUs + 250_000), ...facing(w.startUs, w.endUs, st.punch), reason: "punch-in on the question/exclamation" });
      sfx.push({ mediaId, atUs: Math.round(w.startUs), sound: "impact" });
    }
  }

  // 4. Transitions at the longest removed pauses between sentences, spaced out.
  const transitions = [];
  let lastT = -Infinity;
  for (const c of [...cuts].sort((a, b) => (b.toUs - b.fromUs) - (a.toUs - a.fromUs))) {
    const at = editTime(cuts, c.toUs);
    if (c.toUs - c.fromUs < 1_200_000 || at === null) continue;
    if (transitions.some((x) => Math.abs(editTime(cuts, x.atUs) - at) < st.transitionsEvery) || at < 2 * US) continue;
    transitions.push({ mediaId, atUs: Math.round(c.fromUs), type: transitions.length % 2 ? "push_left" : "zoom_in", durationUs: 280_000, reason: "topic change (a long pause was cut)" });
    sfx.push({ mediaId, atUs: Math.round(c.toUs), sound: "whoosh" });
    lastT = at;
  }
  // Zooms must not overlap each other: punch-ins win over the alternate framing they fall into.
  const punch = zooms.filter((z) => z.reason.startsWith("punch"));
  const framing = zooms.filter((z) => !z.reason.startsWith("punch")).flatMap((z) => {
    let parts = [[z.fromUs, z.toUs]];
    for (const p of punch) parts = parts.flatMap(([a, b]) => (p.toUs <= a || p.fromUs >= b ? [[a, b]] : [[a, p.fromUs], [p.toUs, b]]).filter(([x, y]) => y - x > 300_000));
    return parts.map(([a, b]) => ({ ...z, fromUs: a, toUs: b }));
  });

  // 5. Finishing.
  const lastWord = words[words.length - 1];
  if (cta) {
    graphics.push({ mediaId, template: "follow-cta", fromUs: Math.max(0, Math.round(lastWord.endUs - 2_600_000)), toUs: Math.round(Math.min(durationUs, lastWord.endUs + 400_000)), params: { text: cta, position: "top" }, sfx: true });
    notes.push(`a call to action at the end: «${cta}»`);
  }
  graphics.push({ mediaId, template: "progress-bar", fromUs: words[0].startUs, toUs: lastWord.endUs, params: { position: "top", thickness: 0.006 } });
  const plan = {
    schema: "montaj.editplan/1", title,
    cuts: cuts.map((c) => ({ mediaId, fromUs: Math.round(c.fromUs), toUs: Math.round(c.toUs), reason: c.reason })),
    zooms: [...framing, ...punch].map((z) => ({ ...z, fromUs: Math.round(z.fromUs), toUs: Math.round(z.toUs) })).sort((a, b) => a.fromUs - b.fromUs),
    transitions, graphics, sfx,
    stabilize: true,
    audio: { denoise: true, enhanceVoice: true, normalizeLufs: -14 },
    captions: { template: captionTemplate, reveal: true, keywords: [...emphasis].slice(0, 60), ...(corrections.length ? { corrections } : {}) },
  };
  return { plan, notes };
}

export { pauseKind };
