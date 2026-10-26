// The director: turns what is said (word timings) and what is seen (where the person's head is, how it moves) into
// a whole edit plan (montaj.editplan/2) — the decisions an editor makes, written as rules. The rules and their
// numbers are the edit-hamdy editing skill's (core/policy.js):
//  · several clips: planned as one story, in their timeline order (story ordering is a later stage); each clip's
//    words and person track are laid on one "virtual" time axis, and the plan is mapped back to each file;
//  · retakes: repeated attempts of a line grouped by their words (core/speech.js retakeGroups) — the last complete
//    take is kept, the others and their asides go (the groups are in the plan for the cut sheet);
//  · pacing: what is said is kept whole; stretched hesitations, stutters, restarted sentences and the recogniser's
//    hallucinations go; the silence kept between words depends on the moment (glued after a question, faster before
//    a punchline, a breath after a laugh, never above 0.6 s); wordless moments where something is shown are kept;
//  · a small J cut (the next sound first) on a change of scene: another file, or a long stretch left out;
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
import { normWord, pauseKind, correctWords, sentences, smartCuts, retakeGroups, retakeDrops } from "./speech.js";
import { US } from "./util.js";
import { POLICY } from "./policy.js";
import { MOMENT_TYPES } from "./momentsLexicon.js";
import { detectMoments, isPunch, isReaction } from "./moments.js";
import { findNumbers, fmtNumber } from "./numbers.js";
import { reelSelect } from "./reel.js";
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
export function srcAt(cuts, editUs) {
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
 * A whole edit plan (montaj.editplan/2). input: { mediaId, words: [{text,startUs,endUs}], durationUs, track (MatteService.track,
 * may be empty), media: { width, height }, canvas: { width, height }, style, keywords, cta, captionTemplate, title }; several
 * clips: clips [{ mediaId, srcStart, srcEnd, vStart, speed }] with words, track and durationUs on their virtual axis (the
 * clips one after another) and protect [[a, b]] (virtual spans never cut: clips without speech); retakes: false keeps every take.
 * The rules and numbers are the edit-hamdy skill's (core/policy.js). Returns { plan, notes, qa } — notes explain each
 * decision, qa is the quality guards' verdict on the plan (core/qa.js).
 */
export function directPlan(input) {
  const { durationUs, track = [], keywords = [], style = "energetic", cta = "", captionTemplate = "clean-pro", title = "Auto edit", corrections = [], targetUs = null, stabilize = true, protect = [] } = input;
  // A treatment (core/treatments.js executionSpec): moments left out, wordless moments kept, the edit order and the
  // hook. kit: graphics chosen by meaning (graphics/selection.js planGraphics, virtual source time) — they replace the
  // director's own key-word texts, numbers and emoji.
  const spec = input.spec || null, kit = input.kit || null;
  // Several clips: one virtual time axis (the clips one after another); the plan is mapped back to each file at the end.
  const clips = input.clips?.length ? input.clips : [{ mediaId: input.mediaId, srcStart: 0, srcEnd: durationUs, vStart: 0 }];
  const mediaId = input.clips?.length ? "virtual" : input.mediaId;
  const joints = clips.slice(1).map((c) => c.vStart);
  // Recognition fixes first, so graphics show the right words (the same fixes go to the captions).
  const words = input.wordsCorrected ? (input.words || []) : correctWords((input.words || []).map((w) => ({ t: w.text, s: w.startUs, e: w.endUs })), corrections).map((w) => ({ text: w.t, startUs: w.s, endUs: w.e }));
  const st = DIRECTOR_STYLES[style] || DIRECTOR_STYLES.energetic;
  // notes: the reasons in English (for agents); decisions: the same, structured (the app shows them in its language).
  const notes = [], decisions = [];
  const r1 = (v) => Math.round(v * 10) / 10;
  if (spec && (!words.length || words.every((_, i) => spec.dropWords.has(i)))) return wordlessPlan(input, { clips, durationUs, spec, title, stabilize });
  if (!words.length) return { plan: toPlanV2({ schema: "montaj.editplan/1", title, cuts: [], audio: { denoise: true, enhanceVoice: true, normalizeLufs: -14 }, stabilize: true }, { clips, durationUs }), notes: ["no speech: clean-up and stabilization only"], decisions: [{ k: "noSpeech" }], qa: null };
  const Z = POLICY.zoom, A = POLICY.angles, E = POLICY.emoji;
  const S = (s) => Math.round(s * US);

  // 1. Pacing (the skill's rhythm): what is said is kept whole; stretched hesitations, stutters, restarts and the
  // recogniser's hallucinations go; the silence left between words depends on the moment.
  const moments = detectMoments(words, { keywords });
  const beats = visualBeats(words, track);
  for (const [a, b] of beats) { notes.push(`kept a wordless moment ${(a / US).toFixed(1)}–${(b / US).toFixed(1)} s (something is shown)`); decisions.push({ k: "kept", from: r1(a / US), to: r1(b / US) }); }
  const keep = [...beats, ...protect, ...(spec?.keepSpans || [])]; // + clips without speech (pictures, silent shots) and the wordless moments a treatment keeps: never cut
  // Retakes by meaning: of each line said several times, the last complete take stays; the others and the asides
  // between them («تاني», «استنى») go. No judging of the performance yet (a later stage scores the takes).
  const groups = input.retakes === false ? [] : retakeGroups(words, { withinUs: S(POLICY.retakes.within), falseStartWithinUs: S(POLICY.retakes.falseStart), score: input.takeScore || null });
  const retakeDrop = retakeDrops(groups);
  if (groups.length) {
    const left = groups.reduce((n, g) => n + g.takes.length - 1, 0);
    notes.push(`retakes: ${groups.length} line(s) said more than once — kept the last complete take, ${left} take(s) left out (${groups.slice(0, 3).map((g) => `«${clean(g.line).slice(0, 30)}» ×${g.takes.length}`).join(", ")})`);
    decisions.push({ k: "retakes", lines: groups.length, left, groups: groups.map((g) => ({ takes: g.takes.length, kept: g.kept + 1, at: r1(g.takes[g.kept].fromUs / US), text: clean(g.line).slice(0, 60) })) });
  }
  const pace = (drop) => smartCuts(words, {
    pace: POLICY.pace, rhythm: st.rhythm, durationUs, keep, drop: new Map([...retakeDrop, ...(spec?.dropWords || []), ...(drop || [])]),
    moments: moments.map((m) => ({ s: m.s, e: m.e, punch: isPunch(m) && m.score >= Z.minScore, reaction: isReaction(m) })),
  });
  let { cuts: rawCuts, removed } = pace(null);
  // A reel: the strongest whole sentences within the target, then paced again; when the result runs over by more than
  // 2 s, the budget shrinks by the overshoot (the skill's loop, at most 3 rounds).
  if (targetUs && !spec && editAt(rawCuts.sort((x, y) => x.fromUs - y.fromUs), durationUs) > targetUs + 2 * US) {
    const base = removed;
    let budget = null, sel = null;
    for (let round = 0; round < 3; round++) {
      sel = reelSelect(words, { targetUs, moments, keywords, removed: base, budgetUs: budget });
      ({ cuts: rawCuts, removed } = pace(sel.drop));
      const got = editAt(rawCuts.sort((x, y) => x.fromUs - y.fromUs), durationUs);
      if (got <= targetUs + 2 * US) break;
      budget = Math.max(0, (budget ?? targetUs - sel.units.filter((u) => u.must).reduce((n, u) => n + u.estUs, 0)) - (got - targetUs) - 500_000);
    }
    const kept = sel.units.filter((u) => u.kept);
    notes.push(`reel of ${(targetUs / US).toFixed(0)} s: ${kept.length} of ${sel.units.length} sentences kept (by their role in the story and their moments)${sel.warning ? ` — ${sel.warning}` : ""}`);
    decisions.push({ k: "reel", target: Math.round(targetUs / US), kept: kept.length, total: sel.units.length, short: !!sel.warning });
  }
  // A treatment's wordless moments left out are cut too; the wordless moments it keeps stay whole.
  const cuts = spec ? withSpans(rawCuts, spec.cutSpans, keep) : rawCuts.sort((x, y) => x.fromUs - y.fromUs);
  const total = editAt(cuts, durationUs);
  const why = {};
  for (const r of removed.values()) why[r] = (why[r] || 0) + 1;
  decisions.push({ k: "pacing", rhythm: st.rhythm, cuts: cuts.length, before: r1(durationUs / US), after: r1(total / US), removed: why });
  notes.push(`pacing «${st.rhythm}»: ${cuts.length} cuts, ${(durationUs / US).toFixed(1)} → ${(total / US).toFixed(1)} s${Object.keys(why).length ? ` (removed: ${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`);
  const kept = words.filter((w, i) => !removed.has(i) && editTime(cuts, w.startUs) !== null);
  const momentsKept = moments.filter((m) => editTime(cuts, m.s) !== null);

  // 2. Angles from one camera: wide / medium / close, never the same twice in a row (hides every jump cut); close on
  // a punch, a reaction or a marked word; wide on a long shot. The head is never cropped (fitHead).
  const fit = videoFit(input.media, input.canvas);
  let C = A.C, M = A.M;
  if (fit.sharpZoom && C > 1.02 * fit.sharpZoom) { C = Math.max(A.minC, fit.sharpZoom); M = Math.min(M, 1 + (C - 1) / 2); }
  const LEVEL = { W: A.W, M, C };
  // Shots: between the cuts — and at a joint between two clips (a new shot even without a cut).
  const shots = [];
  let s0 = 0;
  const breaks = [...joints, ...(spec?.angleBreaks || [])].filter((j) => editTime(cuts, j) !== null);
  for (const c of [...cuts, ...breaks.map((j) => ({ fromUs: j, toUs: j }))].sort((x, y) => x.fromUs - y.fromUs)) { if (c.fromUs - s0 > 200_000) shots.push([s0, c.fromUs]); s0 = Math.max(s0, c.toUs); }
  if (durationUs - s0 > 200_000) shots.push([s0, durationUs]);
  let prevAngle = null;
  const angleOf = shots.map(([a, b]) => {
    const inShot = momentsKept.filter((m) => m.s >= a && m.s < b);
    let ang, because;
    // A shot without words (a treatment's action moment): wide and medium in turn — a group is never cropped close.
    if (spec && !kept.some((w) => w.startUs >= a && w.startUs < b)) { ang = prevAngle === "W" ? "M" : "W"; because = "action"; prevAngle = ang; return { ang, because }; }
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
    if (c.kind === "punch") sfxWanted.push({ mediaId, atUs: Math.round(c.m.s), sound: "impact", why: `${c.m.type} «${clean(c.m.text)}»`, query: SFX_MEANING[c.m.type] || "ضربة", mood: c.m.type === "laugh" || c.m.type === "oops" ? "comic" : c.m.type === "shock" ? "shock" : "neutral" });
    return { mediaId, fromUs: c.fromUs, toUs: c.toUs, ...fr, reason: `${c.kind}-in: ${c.m.type} «${clean(c.m.text)}»` };
  }).filter((z) => z.scale >= 1.02);

  // 4. Graphics. Numbers first: every number said becomes a graphic (a counter; +/− for a gain or a loss), every list
  // a montage (one point per item, on its word). Then the sentences worth one, by value, spaced out in the edit.
  const nums = kit ? { numbers: [], lists: [] } : findNumbers(kept);
  const graphics = [], emphasis = new Set(keywords), taken = [];
  const startAt = (w) => Math.max(0, w.startUs - SYNC_US); // never before the word
  // Text graphics never share the screen (the skill's text-collision guard): one ends before the next starts.
  const TEXTS = new Set(["emerge-side", "rise-behind", "word-stack", "counter", "list-item", "pass-behind", "big-word", "title-reveal"]);
  const span = (g) => [editAt(cuts, g.fromUs), editAt(cuts, Math.min(durationUs, g.toUs))];
  const collides = (g, list) => TEXTS.has(g.template) && list.some((o) => TEXTS.has(o.template) && span(g)[0] < span(o)[1] && span(g)[1] > span(o)[0]);
  // What a graphic shows, for the decisions list.
  const shown = (g) => {
    const p = g.params || {};
    if (g.template === "counter") return { text: `${p.prefix || ""}${fmtNumber(p.to)}${p.suffix || ""}` };
    if (g.template === "head-emoji" || g.template === "emoji") return { emoji: p.emoji };
    if (g.template === "list-item") return { text: p.text, n: p.number };
    return { text: p.text || (p.words || []).join(" / ") };
  };
  const addGraphic = (g, whyText) => {
    graphics.push({ mediaId, ...g, fromUs: Math.max(0, Math.round(g.fromUs)), toUs: Math.round(Math.min(durationUs, g.toUs)), reason: whyText.slice(0, 200), sfx: g.sfx !== false });
    taken.push({ t: editAt(cuts, g.fromUs), kind: g.template, light: g.template === "head-emoji" });
    notes.push(`${g.template} at ${(g.fromUs / US).toFixed(1)} s: ${whyText}`);
    decisions.push({ k: "graphic", template: g.template, at: r1(editAt(cuts, g.fromUs) / US), ...shown(g) });
  };
  const inList = new Set(nums.lists.flat());
  // Graphics by meaning (kit): placed as they were picked — the numbers and lists are among their needs.
  for (const g of kit || []) addGraphic({ ...g, sfx: g.sfx !== false }, g.reason || `${g.template}: ${g.why || "by meaning"}`);
  for (const L of nums.lists) {
    const items = L.map((idx, k) => {
      const x = nums.numbers[idx], next = nums.numbers[L[k + 1]];
      return [{ template: "list-item", fromUs: x.at - SYNC_US, toUs: next ? next.at - SYNC_US : srcAfter(cuts, x.at, 1_500_000, durationUs), params: { number: String(k + 1), text: x.label.slice(0, 60), position: "top" }, anchor: { word: x.label.slice(0, 60), atUs: Math.round(x.at) } }, `list point ${k + 1}: «${x.label}»`];
    });
    if (items.some(([g]) => collides(g, graphics))) continue; // never on top of another text
    for (const [g, why] of items) addGraphic(g, why);
  }
  for (const [i, x] of nums.numbers.entries()) {
    if (inList.has(i) || (x.kind === "info" && !x.unit)) continue;
    const t = editAt(cuts, x.at);
    if (taken.some((o) => Math.abs(o.t - t) < 1_500_000)) continue;
    const accent = x.sign === "-" ? "#FF4D6D" : x.sign === "+" ? "#3EE07B" : "#FFD84D";
    const g = { template: "counter", fromUs: x.at - SYNC_US, toUs: srcAfter(cuts, x.at, 2_400_000, durationUs), params: { from: 0, to: x.value, decimals: Number.isInteger(x.value) ? 0 : 1, prefix: x.sign === "-" ? "−" : x.sign, suffix: x.unit ? ` ${x.unit}` : "", label: "", accent, position: "top" }, anchor: { word: x.label.slice(0, 60), atUs: Math.round(x.at) } };
    if (collides(g, graphics)) continue; // a counter still counting: the next number waits
    addGraphic(g, `the number «${x.label}» (${x.kind})`);
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
  for (const c of kit ? [] : [...cands].sort((x, y) => y.value - x.value)) {
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
      return [{ template: "word-stack", anchor: { word: pick(first), atUs: first.startUs }, fromUs: startAt(first), toUs: Math.max(srcAfter(cuts, last.endUs, 1_000_000, durationUs), srcAfter(cuts, first.startUs, 2_000_000, durationUs)), params: { words: pickWords.map(pick), times: pickWords.map((w) => Math.max(0, Math.round(((editTime(cuts, w.startUs) ?? e0) - e0 + SYNC_US) / 1000))) } }, `words as they are said: ${pickWords.map(pick).join(" / ")}`];
    }
    const look = kind === "emerge-side" ? LOOKS[looks++ % LOOKS.length] : {};
    emphasis.add(pick(key));
    return [{ template: kind, anchor: { word: pick(key), atUs: key.startUs }, fromUs: startAt(key), toUs: srcAfter(cuts, key.startUs, kind === "rise-behind" ? 1_800_000 : 1_600_000, durationUs), params: { text: pick(key), ...look } }, `the key word «${pick(key)}» ${kind === "rise-behind" ? "rises from behind" : "comes out from behind"} the person`];
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
        made = [{ template: "head-emoji", anchor: { word: pick(at), atUs: at.startUs }, fromUs: startAt(at), toUs: srcAfter(cuts, at.startUs, S(moment?.type === "laugh" ? E.laughDur : E.dur), durationUs), params: { emoji: name, motion: question ? "wiggle" : "bounce", size: 0.26 } }, whyText];
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

  // A treatment's reactions without words (a laugh, applause, a scream in the action) get a sound by their meaning.
  for (const r of spec?.reactionSfx || []) if (editTime(cuts, r.atUs) !== null) sfxWanted.push({ mediaId, atUs: Math.round(r.atUs), sound: r.sound || "pop", why: r.why || "reaction", query: r.query, mood: r.mood || "neutral" });

  // 5. Transitions at the longest removed pauses between sentences, spaced out.
  const transitions = [];
  for (const c of [...cuts].sort((a, b) => (b.toUs - b.fromUs) - (a.toUs - a.fromUs))) {
    const at = editTime(cuts, c.toUs);
    if (c.toUs - c.fromUs < 1_200_000 || at === null || c.toUs >= durationUs - 100_000) continue; // nothing after the end
    if (transitions.some((x) => Math.abs(editTime(cuts, x.atUs) - at) < st.transitionsEvery) || at < 2 * US) continue;
    if (joints.some((j) => j > c.fromUs && j <= c.toUs)) continue; // a change of clip: a J lead marks it (toPlanV2), not a transition
    transitions.push({ mediaId, atUs: Math.round(c.fromUs), type: transitions.length % 2 ? "push_left" : "zoom_in", durationUs: 280_000, reason: "topic change (a long pause was cut)" });
    sfxWanted.push({ mediaId, atUs: Math.round(c.toUs), sound: "whoosh", why: "transition", query: "whoosh", mood: "neutral" });
  }

  // 6. Finishing.
  const lastWord = kept[kept.length - 1];
  if (cta) {
    graphics.push({ mediaId, template: "follow-cta", fromUs: Math.max(0, Math.round(lastWord.endUs - 2_600_000)), toUs: Math.round(Math.min(durationUs, lastWord.endUs + 400_000)), params: { text: cta, position: "top" }, sfx: true });
    notes.push(`a call to action at the end: «${cta}»`);
    decisions.push({ k: "cta", text: cta });
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
    stabilize: !!stabilize,
    audio: spec?.audio || { denoise: true, enhanceVoice: true, normalizeLufs: -14 },
  };

  const punchRoom = (t) => plan.zooms.filter((x) => /^punch/.test(x.reason)).every((x) => Math.abs(editAt(cuts, x.fromUs) - t) >= S(Z.punchGap));

  // 7. Retention: a reason to keep watching at least every 6 s — a dead stretch gets its strongest word on screen
  // (or a punch-in when there is no person to place it by).
  for (let round = 0; round < 12; round++) {
    const dead = deadSpans(reasonsToWatch(plan, { words: kept, cuts, numbers: nums.numbers, actionAt: spec?.actionAt }), total);
    if (!dead.length) break;
    let fixed = false;
    for (const [a, b] of dead) {
      const pool = kept.filter((w) => { const t = editTime(cuts, w.startUs); return t !== null && t > a + 1_000_000 && t < b - 1_000_000 && !isStop(w.text); });
      const ranked = pool.map((w) => ({ w, score: wordScore(w.text, kw) - Math.abs(editTime(cuts, w.startUs) - (a + b) / 2) / (3 * US) })).sort((x, y) => y.score - x.score);
      const placeable = (w) => { const f = sampleAt(track, w.startUs); return track.length && (room(f) > 0.2 || roomAbove(f) > 0.12); };
      const kindAt = (w) => (room(sampleAt(track, w.startUs)) > 0.2 ? "emerge-side" : "rise-behind");
      const best = ranked.find((x) => placeable(x.w) && !collides(wordGraphic(kindAt(x.w), x.w, [x.w], [{ w: x.w, score: 1 }])[0], plan.graphics)) || ranked[0];
      if (!best) continue;
      // With graphics by meaning, a dead stretch gets a punch-in on its strongest word, never a random word on screen.
      if (!kit && placeable(best.w) && !collides(wordGraphic(kindAt(best.w), best.w, [best.w], [{ w: best.w, score: 1 }])[0], plan.graphics)) {
        const made = wordGraphic(kindAt(best.w), best.w, [best.w], [{ w: best.w, score: 1 }]);
        plan.graphics.push({ mediaId, ...made[0], fromUs: Math.round(made[0].fromUs), toUs: Math.round(Math.min(durationUs, made[0].toUs)), reason: `retention: ${made[1]}`.slice(0, 200), sfx: true });
        notes.push(`${made[0].template} at ${(made[0].fromUs / US).toFixed(1)} s: nothing new for ${((b - a) / US).toFixed(1)} s — «${pick(best.w)}»`);
        decisions.push({ k: "retention", template: made[0].template, at: r1(editAt(cuts, made[0].fromUs) / US), gap: r1((b - a) / US), text: pick(best.w) });
      } else if (!kit && !track.length && !collides({ template: "big-word", fromUs: startAt(best.w), toUs: srcAfter(cuts, best.w.startUs, 1_600_000, durationUs) }, plan.graphics)) {
        // Where the person is is not known: the word, large, at the top of the frame (away from a face).
        emphasis.add(pick(best.w));
        plan.graphics.push({ mediaId, template: "big-word", anchor: { word: pick(best.w), atUs: best.w.startUs }, fromUs: Math.round(startAt(best.w)), toUs: Math.round(srcAfter(cuts, best.w.startUs, 1_600_000, durationUs)), params: { text: pick(best.w), position: "top", size: 0.8 }, reason: `retention: the word «${pick(best.w)}» on screen`.slice(0, 200), sfx: true });
        notes.push(`big-word at ${(best.w.startUs / US).toFixed(1)} s: nothing new for ${((b - a) / US).toFixed(1)} s — «${pick(best.w)}»`);
        decisions.push({ k: "retention", template: "big-word", at: r1(editAt(cuts, best.w.startUs) / US), gap: r1((b - a) / US), text: pick(best.w) });
      } else {
        const z = Z.punch, from = Math.max(0, best.w.startUs - S(z.before)), to = srcAfter(cuts, best.w.startUs, S(z.after), durationUs);
        if (plan.zooms.some((x) => x.fromUs < to && x.toUs > from && /^(punch|push)/.test(x.reason))) continue;
        if (!punchRoom(editAt(cuts, from))) continue; // punch-ins at least 4 s apart
        const fr = fitHead(Math.min(angleAt(best.w.startUs) * z.factor, C * z.factor), headBox(track, from, to, fit.aspect), fit);
        if (fr.scale < 1.02) continue; // the head fills the frame: no room for a punch-in
        plan.zooms = plan.zooms.flatMap((x) => (x.toUs <= from || x.fromUs >= to ? [x] : [{ ...x, toUs: from }, { ...x, fromUs: to }].filter((y) => y.toUs - y.fromUs > 300_000)));
        plan.zooms.push({ mediaId, fromUs: Math.round(from), toUs: Math.round(to), ...fr, reason: `punch-in: retention «${pick(best.w)}»` });
        plan.zooms.sort((p, q) => p.fromUs - q.fromUs);
        notes.push(`punch-in at ${(from / US).toFixed(1)} s: nothing new for ${((b - a) / US).toFixed(1)} s — «${pick(best.w)}»`);
        decisions.push({ k: "retention", template: "punch", at: r1(editAt(cuts, from) / US), gap: r1((b - a) / US), text: pick(best.w) });
      }
      fixed = true;
    }
    if (!fixed) break;
  }

  // The ending strikes (the skill's ending rule): when the last 2 s have no element, sound, punch-in or question, the
  // strongest word there gets a punch-in.
  const endFrom = total - S(POLICY.ending.strike);
  const struck = plan.graphics.some((g) => g.template !== "progress-bar" && editAt(cuts, g.toUs) >= endFrom) || sfxWanted.some((x) => editAt(cuts, x.atUs) >= endFrom)
    || plan.zooms.some((z) => /^punch/.test(z.reason) && editAt(cuts, z.toUs) >= endFrom) || kept.some((w) => /[?؟]/.test(w.text) && (editTime(cuts, w.startUs) ?? -1) >= total - S(POLICY.ending.question));
  if (!struck) {
    const last = kept.filter((w) => (editTime(cuts, w.startUs) ?? -1) >= endFrom - S(1) && !isStop(w.text)).sort((a, b) => wordScore(b.text, kw) - wordScore(a.text, kw))[0];
    if (last && punchRoom(editTime(cuts, last.startUs))) {
      const z = Z.punch, from = Math.max(0, last.startUs - S(z.before)), to = Math.min(durationUs, srcAfter(cuts, last.startUs, S(z.after), durationUs));
      const fr = fitHead(Math.min(angleAt(last.startUs) * z.factor, C * z.factor), headBox(track, from, to, fit.aspect), fit);
      if (fr.scale >= 1.02) {
        plan.zooms = plan.zooms.flatMap((x) => (x.toUs <= from || x.fromUs >= to ? [x] : [{ ...x, toUs: from }, { ...x, fromUs: to }].filter((y) => y.toUs - y.fromUs > 300_000)));
        plan.zooms.push({ mediaId, fromUs: Math.round(from), toUs: Math.round(to), ...fr, reason: `punch-in: the ending «${pick(last)}»` });
        plan.zooms.sort((p, q) => p.fromUs - q.fromUs);
        notes.push(`punch-in on the last words «${pick(last)}» (the video ends on a strike)`);
        decisions.push({ k: "ending", text: pick(last) });
      }
    }
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
    if (fits([t]) && ev.length < capSfx) { ev.push(t); plan.sfx.push({ mediaId, atUs: x.atUs, sound: x.sound, ...(x.query ? { query: x.query, mood: x.mood || "neutral" } : {}) }); }
  }
  if (silenced) { notes.push(`${silenced} graphic(s) play without their sound effect (sounds kept at least ${POLICY.sfx.minGap} s apart)`); decisions.push({ k: "silenced", n: silenced }); }

  plan.captions = { template: captionTemplate, reveal: true, keywords: [...emphasis].slice(0, 60), ...(corrections.length ? { corrections } : {}) };
  const qa = qaPlan(plan, { words, removed, durationUs, track, style, numbers: nums.numbers, fit, actionAt: spec?.actionAt });
  const fails = qa.checks.filter((c) => c.level === "fail");
  notes.push(qa.ok ? `quality guards: all ${qa.passed.length} passed` : `quality guards: ${fails.length} problem(s) — ${fails.slice(0, 3).map((c) => c.message).join("; ")}`);
  const out = toPlanV2(plan, { clips, durationUs, groups, order: spec?.order, hook: spec?.hook });
  const jl = out.segments.filter((x) => x.jl).length;
  if (jl) { notes.push(`${jl} J cut(s) of ${POLICY.jl.leadMs} ms where the scene changes (the next sound starts before its picture)`); decisions.push({ k: "jl", n: jl, ms: POLICY.jl.leadMs }); }
  if (clips.length > 1) { notes.push(`${clips.length} clips planned as one story, in their timeline order`); decisions.unshift({ k: "clips", n: clips.length }); }
  return { plan: out, notes, qa, decisions, virtual: { cuts, durationUs, kept, removed, total } };
}

// What a punch-in moment sounds like, by meaning (the sound library's Egyptian tags; the bundled sound is the fallback).
const SFX_MEANING = { laugh: "قفشة", oops: "وقعة", shock: "صدمة", win: "هيصة", alert: "صدمة", no: "إحراج", fire: "لقطة", money: "فلوس", key: "ضربة" };

/** Cuts with extra spans added, minus the spans that must stay (merged, sorted). */
export function withSpans(cuts, add = [], keep = []) {
  let all = [...cuts, ...add].filter((c) => c.toUs - c.fromUs > 0).sort((a, b) => a.fromUs - b.fromUs);
  for (const [a, b] of keep) all = all.flatMap((x) => (b <= x.fromUs || a >= x.toUs ? [x] : [{ ...x, toUs: a }, { ...x, fromUs: b }].filter((y) => y.toUs - y.fromUs > 80_000)));
  const out = [];
  for (const c of all.sort((a, b) => a.fromUs - b.fromUs)) {
    const last = out[out.length - 1];
    if (last && c.fromUs <= last.toUs + 1000) { last.toUs = Math.max(last.toUs, c.toUs); if (!String(last.reason).includes(c.reason)) last.reason = `${last.reason}+${c.reason}`.slice(0, 120); }
    else out.push({ ...c });
  }
  return out;
}

/**
 * A treatment with no speech left (a wordless video, or every line left out): its cuts, wide/medium angles that
 * change at every moment edge, clean-up and loudness — no captions or graphics by words.
 */
function wordlessPlan(input, { clips, durationUs, spec, title, stabilize }) {
  const cuts = withSpans([], spec.cutSpans, [...(input.protect || []), ...spec.keepSpans]);
  const total = editAt(cuts, durationUs);
  const A = POLICY.angles, zooms = [];
  const bounds = [...new Set([0, ...spec.angleBreaks, ...cuts.flatMap((c) => [c.fromUs, c.toUs]), durationUs])].sort((a, b) => a - b);
  let k = 0;
  for (let i = 1; i < bounds.length; i++) {
    const a = bounds[i - 1], b = bounds[i];
    if (b - a < 300_000 || editTime(cuts, (a + b) / 2) === null) continue;
    if (k++ % 2) zooms.push({ mediaId: "virtual", fromUs: a, toUs: b, scale: A.M, reason: "angle M (action)" });
  }
  const plan = { schema: "montaj.editplan/1", title, cuts: cuts.map((c) => ({ mediaId: "virtual", ...c })), zooms, transitions: [], graphics: [], sfx: [], stabilize: !!stabilize, audio: { denoise: false, enhanceVoice: false, normalizeLufs: -14 } };
  const decisions = [{ k: "pacing", rhythm: "action", cuts: cuts.length, before: Math.round(durationUs / 1e5) / 10, after: Math.round(total / 1e5) / 10, removed: { treatment: cuts.length } }];
  return { plan: toPlanV2(plan, { clips, durationUs, order: spec.order, hook: spec.hook }), notes: [`no speech kept: ${cuts.length} cuts by the treatment, ${(durationUs / US).toFixed(1)} → ${(total / US).toFixed(1)} s`], decisions, qa: null, virtual: { cuts, durationUs, kept: [], removed: new Map(), total } };
}

/**
 * The director's plan — worked out on one virtual time axis (the clips one after another, cuts as v1) — as
 * montaj.editplan/2: the kept spans of each clip as ordered segments (each with what was cut before it), every overlay
 * mapped back to its file, a small J lead where the scene changes (POLICY.jl), and the retake groups for the cut sheet.
 * clips: [{ mediaId, srcStart, srcEnd, vStart, speed }] (one clip = the media itself from 0); groups: retakeGroups.
 */
export function toPlanV2(vplan, { clips, durationUs, groups = [], J = POLICY.jl, order = null, hook = null }) {
  const C = clips.map((c, i) => ({ ...c, i, speed: c.speed || 1, vEnd: i + 1 < clips.length ? clips[i + 1].vStart : Math.max(c.vStart, durationUs) }));
  const clipOf = (v) => C.find((c) => v >= c.vStart && v < c.vEnd) || (v >= C[C.length - 1].vEnd ? C[C.length - 1] : C[0]);
  const src = (c, v) => Math.max(0, Math.round(c.srcStart + (Math.min(Math.max(v, c.vStart), c.vEnd) - c.vStart) * c.speed));
  const cuts = [...(vplan.cuts || [])].sort((a, b) => a.fromUs - b.fromUs);
  // Kept spans of the virtual axis, split at the clips' joints.
  const kept = [];
  let t = 0, why = null;
  const keepSpan = (a, b, reason) => {
    for (const c of C) {
      const x = Math.max(a, c.vStart), y = Math.min(b, c.vEnd);
      if (y - x >= 40_000) kept.push({ v0: x, v1: y, c, reason: kept.length && x === a ? reason : null });
    }
  };
  for (const c of cuts) { if (c.fromUs > t) keepSpan(t, c.fromUs, why); if (c.toUs > t) { t = c.toUs; why = c.reason; } }
  if (durationUs > t) keepSpan(t, durationUs, why);
  // A treatment's order: the kept spans go in the order of the moments they belong to (stable inside a moment).
  if (order?.length) {
    const rank = (v) => { const i = order.findIndex(([a, b]) => v >= a && v < b); return i >= 0 ? i : order.reduce((best, [a], j) => (a <= v ? j : best), 0); };
    const ranked = kept.map((x, i) => ({ x, i, r: rank(x.v0) }));
    ranked.sort((p, q) => p.r - q.r || p.i - q.i);
    ranked.forEach((y, k) => { if (k && y.i !== ranked[k - 1].i + 1 && !y.x.reason) y.x.reason = "story order"; });
    kept.splice(0, kept.length, ...ranked.map((y) => y.x));
  }
  // The hook: a flash-forward copy of a moment's span, before everything (its natural place stays).
  if (hook && hook.toUs - hook.fromUs >= 300_000) {
    const hs = [];
    for (const c of C) { const x = Math.max(hook.fromUs, c.vStart), y = Math.min(hook.toUs, c.vEnd); if (y - x >= 40_000) hs.push({ v0: x, v1: y, c, hook: true, reason: `hook: ${hook.kind}${hook.moment ? ` (moment ${hook.moment})` : ""}` }); }
    kept.unshift(...hs);
  }
  const dup = new Set(C.map((c) => c.mediaId).filter((m, i, a) => a.indexOf(m) !== i)); // a file used twice: pin overlays
  const segAt = (v) => { const k = kept.findIndex((s) => !s.hook && v >= s.v0 && v < s.v1); return k >= 0 ? k : kept.findIndex((s) => !s.hook && s.v0 >= v); };
  const segments = kept.map((s, k) => {
    const out = { mediaId: s.c.mediaId, fromUs: src(s.c, s.v0), toUs: src(s.c, s.v1) };
    if (s.hook) { out.role = "hook"; out.reason = s.reason.slice(0, 200); return out; }
    if (k && s.reason) out.reason = (s.reason === "story order" || kept[k - 1].hook ? s.reason : `after a cut: ${s.reason}`).slice(0, 200);
    else if (k && kept[k - 1].c !== s.c) out.reason = "next clip";
    return out;
  });
  // J lead into a new scene: the previous picture holds (from its own footage after its out point, inside its clip)
  // while the next sound starts. Not where a transition already marks the change.
  const transAt = new Set((vplan.transitions || []).map((x) => segAt(cuts.find((c) => c.fromUs === x.atUs)?.toUs ?? x.atUs)));
  for (let k = 1; k < kept.length; k++) {
    const a = kept[k - 1], b = kept[k];
    const newScene = a.c !== b.c || a.hook !== b.hook || Math.abs(b.v0 - a.v1) >= J.longGap * US;
    const handle = (a.c.vEnd - a.v1) * a.c.speed;
    if (newScene && !transAt.has(k) && b.v1 - b.v0 >= J.minSegment * US && handle >= J.leadMs * 1000) segments[k].jl = -J.leadMs;
  }
  const pin = (mid, v) => (dup.has(mid) ? { segment: Math.max(0, segAt(v)) } : {});
  const span = (x) => { const c = clipOf(x.fromUs); return { mediaId: c.mediaId, fromUs: src(c, x.fromUs), toUs: Math.max(src(c, x.fromUs) + 1, src(c, Math.min(x.toUs, c.vEnd))), ...pin(c.mediaId, x.fromUs) }; };
  const point = (v) => { const c = clipOf(v); return { mediaId: c.mediaId, atUs: src(c, v), ...pin(c.mediaId, v) }; };
  const anchor = (a) => { if (!a?.word || !String(a.word).trim()) return {}; const c = clipOf(a.atUs ?? 0); return { anchor: { word: String(a.word).slice(0, 60), ...(a.atUs !== undefined ? { atUs: src(c, a.atUs) } : {}) } }; };
  // Zooms are picture: one per kept segment they cover.
  const zooms = [];
  for (const z of vplan.zooms || []) for (const [k, s] of kept.entries()) {
    if (s.hook) continue; // a zoom is picture: the plan applier lays it on every occurrence, the hook copy too
    const a = Math.max(z.fromUs, s.v0), b = Math.min(z.toUs, s.v1);
    if (b - a >= 150_000) zooms.push({ ...z, mediaId: s.c.mediaId, fromUs: src(s.c, a), toUs: src(s.c, b), ...(dup.has(s.c.mediaId) ? { segment: k } : {}) });
  }
  const plan = {
    schema: "montaj.editplan/2", title: vplan.title, segments,
    ...(zooms.length ? { zooms } : {}),
    ...(vplan.texts?.length ? { texts: vplan.texts.map((x) => ({ ...x, ...span(x) })) } : {}),
    ...(vplan.graphics?.length ? { graphics: vplan.graphics.map(({ anchor: a, ...g }) => ({ ...g, ...span(g), ...anchor(a) })) } : {}),
    ...(vplan.transitions?.length ? { transitions: vplan.transitions.map((x) => ({ segment: Math.max(1, segAt(cuts.find((c) => c.fromUs === x.atUs)?.toUs ?? x.atUs)), type: x.type, durationUs: x.durationUs, reason: x.reason })).filter((x) => x.segment < segments.length) } : {}),
    ...(vplan.sfx?.length ? { sfx: vplan.sfx.map((x) => ({ ...x, ...point(x.atUs) })) } : {}),
    ...(groups.length ? { retakes: groups.map((g) => ({ line: String(g.line).slice(0, 300), kept: g.kept, reason: g.reason, takes: g.takes.map((tk) => { const c = clipOf(tk.fromUs); return { mediaId: c.mediaId, fromUs: src(c, tk.fromUs), toUs: Math.max(src(c, tk.fromUs) + 1, src(c, tk.toUs)), text: String(tk.text).slice(0, 300), complete: tk.complete, kind: tk.kind }; }) })) } : {}),
  };
  for (const k of ["stabilize", "filter", "audio", "captions", "canvas"]) if (vplan[k] !== undefined) plan[k] = vplan[k];
  return plan;
}

/**
 * How long the smart edit's stages take, in seconds, for a video of `durationS` and its size — measured on the
 * development machine (RTX 4090, the Egyptian model on the CPU): speech 20 s + 0.03 × duration (19.4 min → 33–59 s);
 * stabilization ≈ 0.6 × duration per 720p of output (≤ 1080p): 720p50, 19.4 min → 10.5 min; 1080p30, 76 s → 103 s;
 * the person mask ≈ 0.41 × duration at 720p (19.4 min → 8 min), × √(pixels / 720p), plus reading it 0.05 ×; the plan
 * and applying it ~10 s + 0.01 ×. A stage already done (cached) costs ~1 s. Returns { stages: [{ key, sec }],
 * totalSec } — also the weights of the progress bar.
 */
export function estimateWork({ durationS, width = 1920, height = 1080, cached = {}, stabilize = true, person = true, perceive = false, planner = false }) {
  const P720 = 1280 * 720, px = Math.max(1, (width || 1920) * (height || 1080));
  const stabK = 0.6 * Math.min(px, 1920 * 1080) / P720, matteK = 0.41 * Math.sqrt(px / P720);
  const stages = [
    { key: "words", sec: cached.words ? 1 : 20 + 0.03 * durationS },
    ...(stabilize ? [{ key: "stabilize", sec: cached.stabilize ? 1 : stabK * durationS }] : []),
    ...(person ? [{ key: "person", sec: cached.person ? 1 + 0.05 * durationS : (matteK + 0.05) * durationS }] : []),
    // Perception run here (≈ 1.3 × the duration on the first run, measured by phase 4); the planner model's load
    // and calls (Qwen3.8-27B: ~40 s to load, the treatments, the pairwise judge and the graphics ranker).
    ...(perceive ? [{ key: "perceive", sec: 1.3 * durationS }] : []),
    { key: "plan", sec: planner ? 150 : 4 },
    { key: "apply", sec: 10 + 0.01 * durationS },
  ];
  return { stages, totalSec: Math.round(stages.reduce((n, x) => n + x.sec, 0)) };
}

export { pauseKind };
