// Phase 8 of PLAN_editor_and_graphics.md (the phase table, row 8): a STORY ORDER for raw footage shot out of order —
// several clips in any order, or one long raw. The director stays the executor (core/treatments.js, core/director.js);
// this module gives it the order to tell the story in:
//  · segments: the director's numbered moments grouped into scenes — never across a clip joint, cut where a shot or
//    the place changes (perception's shot log), at a long pause, where the topic of the words shifts, and kept
//    between ~8 and ~45 s (a dynamic program over the moment edges, so the cuts land on the best boundaries);
//  · what each segment is: its words (the topic), its place, people and outfits (the shot log's "where" / "who"),
//    day or night, a time hint (the file's creation time + the offset in it), and its story BEAT — setup · promise /
//    question · build-up · conflict · payoff · ending — from Egyptian Arabic cue words, the moments' roles (phase 6),
//    its reactions and the promises;
//  · constraints: phase 6's links (a cause before its reaction) and promises (the payoff after its promise) are HARD
//    (a cycle is broken at its weakest link); the beats' usual order, the time hints, the recording order inside one
//    clip and continuity (same place, people, outfit, topic next to each other) are SOFT;
//  · the order: the best permutation of the segments under both — exact for ≤ 13 segments (a dynamic program over
//    subsets), a local search above — or a planner model's proposal over segment NUMBERS (never times), checked and
//    repaired by the same hard rules (no reaction before its cause, no payoff before its promise, no repeat, none lost);
//  · measurement: Kendall tau, exact positions, kept neighbours and constraint violations against a known order.
// Pure; times in µs on the director's virtual axis (core/treatments.js eventsOnAxis / clipMoments).
import { alignToken } from "./speech.js";
import { normAr } from "./moments.js";
import { US } from "./util.js";

export const BEATS = ["setup", "promise", "build", "conflict", "payoff", "ending"];
export const BEAT_AR = { setup: "تمهيد", promise: "وعد / سؤال", build: "تصاعد", conflict: "مشكلة", payoff: "النتيجة", ending: "النهاية" };
const BEAT_RANK = Object.fromEntries(BEATS.map((b, i) => [b, i]));
const r2 = (x) => Math.round(x * 100) / 100;
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// ------------------------------------------------------------------ words
// Egyptian Arabic cue words of each beat (matched on normAr text: no hamza forms, ة → ه, ى → ي). Each [regex, weight].
const CUES = {
  setup: [[/(^| )(السلام عليكم|صباح الخير|مساء الخير|اهلا|ازيكم|ازيك|يا جماعه|معاكم|معاكو)( |$)/, 2], [/(النهارده|النهاردا|هنعمل|هنجرب|هنروح|هنبدا|هنتكلم|احنا دلوقتي|جينا|الفكره|فكره الفيديو|اول حاجه|في البدايه|بصوا)/, 1]],
  promise: [[/(^| )لو .{0,40}( ه| هن| هي| هت| ح)\S+/, 1.5], [/(تفتكروا|يا تري|ياتري|اللي يكسب|اللي هيخسر|مين هيكسب|هيحصل ايه|هنشوف|وعدتكم|وعدهم|موعدهم|وعدتني|واعدني|عشان نعرف|السؤال|رهان|تحدي|المطلوب|القاعده)/, 1.2]],
  conflict: [[/(المشكله|فجاه|للاسف|مقلب|اتخانق|زعلان|زعلانه|اتحرق|اتكسر|ضاع|اتاخر|اتاخرنا|مش هينفع|مستحيل|يا نهار|يا لهوي|الحقني|الحقوني|مصيبه|خساره|مش لاقي|مش راضي|ما تهزرش|متهزرش|خسرنا|خسرت|وقع)/, 1.2], [/(^| )(بس|لكن|ولكن)( |$)/, 0.3]],
  payoff: [[/(اخيرا|خلصنا|النتيجه|نجحنا|كسبنا|كسبت|عملناها|وصلنا|في الاخر|تحفه|روعه|حلو اوي|جميل جدا|الطعم|دوقوا|طلعت|طلع)/, 1.2], [/(^| )(اهو|جاهز|جاهزه|تمام كده|خلاص)( |$)/, 0.5]],
  ending: [[/(اشتركوا|اشترك|لايك|متنسوش|ما تنسوش|نشوفكم|الفيديو الجاي|الحلقه الجايه|تصبحوا علي خير|لحد هنا|اكتبولي|الكومنتات|فولو|سبسكرايب)/, 2], [/(^| )(سلام|باي|مع السلامه|شكرا|كده خلصنا)( |$)/, 1]],
};
// Function words left out of the topic (normalised like alignToken).
const STOP = new Set(["انا", "انت", "انتي", "احنا", "انتو", "هو", "هي", "هما", "ده", "دي", "دا", "دول", "اللي", "علي", "على", "في", "من", "عن", "مع", "لما", "عشان", "علشان", "كده", "كدا", "بقي", "بقى", "يعني", "طيب", "خلاص", "ايه", "اه", "لا", "مش", "مفيش", "فيه", "كان", "كانت", "هيكون", "يكون", "حاجه", "حاجة", "اوي", "قوي", "جدا", "بس", "كمان", "تاني", "برضه", "والله", "ازاي", "ليه", "امتي", "فين", "مين", "كل", "زي", "لو", "اما", "ولا", "او", "ان", "انه", "انها", "اني", "بتاع", "بتاعت", "بتاعه", "عند", "عندي", "عندنا", "دلوقتي", "النهارده", "هنا", "هناك", "يا", "ما", "لسه", "اصلا", "طبعا", "the", "and", "a", "an", "of", "to", "in", "on", "with", "is", "are", "at", "his", "her", "their"].map(alignToken));
/** Topic tokens of Arabic speech (content words, normalised). */
export const topicTokens = (text) => String(text || "").split(/\s+/).map(alignToken).filter((t) => t.length >= 3 && !STOP.has(t));
const EN_STOP = new Set(["the", "and", "with", "wearing", "while", "his", "her", "their", "from", "into", "onto", "that", "this", "there", "some", "background", "foreground", "visible", "person", "camera", "near", "front", "behind", "side", "left", "right", "center", "standing", "sitting", "holding", "outside", "inside", "area", "large", "small", "light", "dark", "short", "long"]);
/** Tokens of the vision model's English descriptions (places, outfits). */
export const enTokens = (text) => String(text || "").toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3 && !EN_STOP.has(t));
const jaccard = (A, B) => { if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); };

/** Beat scores of one text ({ beat: score }) and the cue words that matched. */
export function beatCues(text) {
  const t = normAr(text);
  const scores = {}, hits = [];
  for (const [beat, list] of Object.entries(CUES)) for (const [re, w] of list) {
    // Up to two different cue words of a list count (two achievements say "payoff" more than one).
    const ms = [...t.matchAll(new RegExp(re.source, "g"))].filter((m, i, a) => a.findIndex((x) => x[0].trim() === m[0].trim()) === i).slice(0, 2);
    if (!ms.length) continue;
    // "السلام عليكم" opens; a lone "سلام" closes.
    if (beat === "ending" && ms.every((m) => /سلام/.test(m[0])) && /السلام عليكم/.test(t)) continue;
    scores[beat] = (scores[beat] || 0) + w * ms.length;
    for (const m of ms) hits.push({ beat, word: m[0].trim().slice(0, 30), strong: w >= 2 });
  }
  if (/[?؟]/.test(text)) { scores.promise = (scores.promise || 0) + 0.5; hits.push({ beat: "promise", word: "؟" }); }
  return { scores, hits };
}

// ------------------------------------------------------------------ segments
const shotLogsIn = (events, s, e) => events.filter((x) => x.type === "shot_log" && overlap(s, e, x.t0, x.t1) > 0);

/**
 * Boundary scores between consecutive moments (higher = a better place to start a new scene): a clip joint is
 * forced (Infinity); a shot cut, an indoor ↔ outdoor flip, a long pause, a long quiet moment and a drop of the words'
 * topic count for a cut; a question answered right after, or a cause → reaction across it, count against.
 * Returns [score before moment i] (index 0 unused).
 */
export function boundaryScores(moments, { events = [], links = [] } = {}) {
  const shots = events.filter((e) => e.type === "shot").map((e) => e.t0).filter((t) => t > 0);
  const logOf = (m) => { const l = shotLogsIn(events, m.s, m.e).sort((p, q) => overlap(m.s, m.e, q.t0, q.t1) - overlap(m.s, m.e, p.t0, p.t1))[0]; return l?.extra || null; };
  const logs = moments.map(logOf);
  const toks = moments.map((m) => new Set(m.kind === "speech" ? topicTokens(m.text) : []));
  const around = (i, d) => { const s = new Set(); for (let k = i, c = 0; k >= 0 && k < moments.length && c < 3 && (moments[k].clip ?? 0) === (moments[i].clip ?? 0); k += d, c++) for (const x of toks[k]) s.add(x); return s; };
  const out = [0];
  for (let i = 1; i < moments.length; i++) {
    const a = moments[i - 1], b = moments[i];
    if ((a.clip ?? 0) !== (b.clip ?? 0)) { out.push(Infinity); continue; }
    let sc = 0;
    if (shots.some((t) => Math.abs(t - b.s) < 700_000)) sc += 2;
    const la = logs[i - 1], lb = logs[i];
    if (la && lb && typeof la.indoor === "boolean" && typeof lb.indoor === "boolean" && la.indoor !== lb.indoor) sc += 2;
    // The pause before b (from a's last word to b's first word; a wordless moment counts as pause).
    const pause = b.kind === "speech" && a.kind === "speech" ? Math.max(0, b.s - a.e) : a.kind !== "speech" ? a.e - a.s : 0;
    sc += Math.min(2, pause / US / 1.5);
    if (a.kind !== "speech" && (a.kind === "still" || a.kind === "gap") && a.e - a.s >= 5 * US) sc += 1;
    // The topic: the words of the three moments before against the three after.
    const L = around(i - 1, -1), Rt = around(i, 1);
    if (L.size >= 3 && Rt.size >= 3) sc += 1.5 * (1 - Math.min(1, 3 * jaccard(L, Rt)));
    if (a.kind === "speech" && /[?؟]\s*$/.test(a.text)) sc -= 1.5;
    if (links.some((l) => l.cause === a.n && l.reaction === b.n) || links.some((l) => l.cause === b.n && l.reaction === a.n)) sc -= 2;
    out.push(r2(sc));
  }
  return out;
}

/**
 * The moments as story segments (scenes). A dynamic program picks the cut points: every segment costs `cutCost`
 * minus the boundary score of its start, plus a penalty when shorter than minUs or longer than maxUs; clip joints
 * are always cuts. Returns [{ k (1-based), from, to (moment indices, inclusive), moments: [n], s, e, clip }].
 */
export function segmentMoments(moments, { events = [], links = [], minUs = 8 * US, maxUs = 45 * US, cutCost = 2 } = {}) {
  const N = moments.length;
  if (!N) return [];
  const b = boundaryScores(moments, { events, links });
  const len = (j, i) => moments[i - 1].e - moments[j].s;
  const pen = (L) => (L < minUs ? 3 * (minUs - L) / minUs : L > maxUs ? 6 * (L - maxUs) / maxUs : 0);
  const best = new Float64Array(N + 1).fill(Infinity), from = new Int32Array(N + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= N; i++) {
    for (let j = i - 1; j >= 0; j--) {
      // A segment never runs across a clip joint.
      if (j < i - 1 && b[j + 1] === Infinity) break;
      if (!Number.isFinite(best[j])) continue;
      const start = j === 0 ? 0 : b[j] === Infinity ? 0 : b[j];
      const c = best[j] + cutCost - start + pen(len(j, i));
      if (c < best[i]) { best[i] = c; from[i] = j; }
      if (len(j, i) > 3 * maxUs) break;
    }
  }
  const cuts = [];
  for (let i = N; i > 0; i = from[i]) cuts.unshift([from[i], i - 1]);
  return cuts.map(([a, z], k) => ({ k: k + 1, from: a, to: z, moments: moments.slice(a, z + 1).map((m) => m.n), s: moments[a].s, e: moments[z].e, clip: moments[a].clip ?? 0 }));
}

/**
 * Everything the order needs to know about each segment. segments: segmentMoments' output; moments (with role,
 * reactions, text); events (on the axis); clips: [{ mediaId, vStart, srcStart, speed, timeUs? (the clip's first
 * frame as an absolute time, µs — the file's creation time + srcStart; null when unknown) }]; promises / links in
 * moment numbers. Adds: text, head, tail, tokens, place, looks, indoor, night, people, summary, beat, beatConf,
 * beatScores, cues, timeUs, mediaId, lengthUs, reactions.
 */
export function describeSegments(segments, { moments, events = [], clips = [], promises = [], links = [] }) {
  const byN = (n) => moments[n - 1];
  const promiseSeg = new Set(promises.map((p) => p.promise)), payoffSeg = new Set(promises.map((p) => p.payoff).filter(Boolean));
  return segments.map((g) => {
    const ms = g.moments.map(byN);
    const speech = ms.filter((m) => m.kind === "speech");
    const text = speech.map((m) => m.text).join(" ");
    const words = text.split(/\s+/).filter(Boolean);
    const logs = shotLogsIn(events, g.s, g.e).map((x) => x.extra || {});
    const clip = clips[g.clip] || {};
    const people = new Set();
    // People ids (faces P1…, voices S1…) are per file: `fileKey` scopes them (a file split into pieces keeps one scope).
    const scope = clip.fileKey ?? clip.mediaId ?? "?";
    for (const e of events) if ((e.type === "face_track" || e.type === "utterance") && overlap(g.s, g.e, e.t0, e.t1) > 0.3 * (e.t1 - e.t0)) { const id = e.entity || e.speaker; if (id) people.add(`${scope}:${id}`); }
    const where = logs.map((l) => [l.where, ...(l.objects || [])].join(" ")).join(" ");
    const looks = logs.flatMap((l) => (l.who || []).map((w) => w.looks || "")).join(" ");
    const indoorVotes = logs.filter((l) => typeof l.indoor === "boolean");
    const night = logs.some((l) => /\b(night|dark|evening|nighttime)\b/i.test(`${l.where || ""} ${l.summary || ""}`)) ? true : logs.some((l) => /\b(sunny|daylight|sunlight|bright day|daytime)\b/i.test(`${l.where || ""} ${l.summary || ""}`)) ? false : null;
    // The beat: cue words (the first two lines count for the opening beats, the last two for the closing ones),
    // the moments' story roles and roles, the reactions, the promises.
    const sc = { setup: 0, promise: 0, build: 0.3, conflict: 0, payoff: 0, ending: 0 }, cues = [];
    // A greeting in the first lines opens the video, a goodbye in the last lines closes it: the only cues strong
    // enough to pull a segment to an edge of the story.
    let opens = false, closes = false;
    speech.forEach((m, i) => {
      const { scores, hits } = beatCues(m.text);
      const early = i < 2, late = i >= speech.length - 2;
      if (early && hits.some((h) => h.strong && h.beat === "setup")) opens = true;
      if (late && hits.some((h) => h.strong && h.beat === "ending")) closes = true;
      for (const [k, v] of Object.entries(scores)) sc[k] += v * ((k === "setup" || k === "promise") && !early ? 0.5 : k === "ending" && !late ? 0.4 : 1);
      cues.push(...hits.map((h) => h.word));
      if (m.story === "stakes") sc.promise += 0.6; else if (m.story === "result") sc.payoff += 0.6; else if (m.story === "setup") sc.setup += 0.4; else if (m.story === "bridge") sc.build += 0.3;
    });
    for (const m of ms) {
      if (m.role === "punch") sc.payoff += 0.3;
      if (m.role === "reaction") sc.payoff += 0.25;
      for (const r of m.reactions || []) { if (r.type === "laughter" || r.type === "applause") sc.payoff += 0.4 * (r.conf ?? 0.6); else if (r.type === "scream" || r.type === "gasp") sc.conflict += 0.4 * (r.conf ?? 0.6); }
      if (promiseSeg.has(m.n)) { sc.promise += 2; cues.push("وعد"); }
      if (payoffSeg.has(m.n)) { sc.payoff += 2; cues.push("نتيجة وعد"); }
    }
    const ranked = Object.entries(sc).sort((p, q) => q[1] - p[1]);
    const beat = ranked[0][0], beatConf = r2(Math.max(0, Math.min(1, (ranked[0][1] - ranked[1][1]) / (ranked[0][1] + 0.5))));
    const head = words.slice(0, 30).join(" "), tail = words.length > 50 ? words.slice(-20).join(" ") : words.slice(30).join(" ");
    const timeUs = Number.isFinite(clip.timeUs) ? Math.round(clip.timeUs + (g.s - (clip.vStart || 0)) * (clip.speed || 1)) : null;
    return {
      ...g, mediaId: clip.mediaId ?? null, lengthUs: g.e - g.s, text, head, tail, tokens: new Set(topicTokens(text)),
      place: new Set(enTokens(where)), looks: new Set(enTokens(looks)), indoor: indoorVotes.length ? indoorVotes.filter((l) => l.indoor).length * 2 >= indoorVotes.length : null, night, people,
      summary: String(logs[0]?.summary_ar || logs[0]?.summary || "").slice(0, 140), beat, beatConf, opens, closes, beatScores: Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, r2(v)])), cues: [...new Set(cues)].slice(0, 6),
      timeUs, speechShare: r2(speech.reduce((n, m) => n + m.e - m.s, 0) / Math.max(1, g.e - g.s)), reactions: ms.reduce((n, m) => n + (m.reactions || []).filter((r) => r.type !== "pitch" && r.type !== "loudness").length, 0),
      energy: Math.max(0, ...ms.map((m) => m.energy || 0)) || null,
    };
  });
}

// ------------------------------------------------------------------ constraints
/**
 * The constraints between segments (indices into `segs`) from moment links and promises: { hard: [{ a, b, why,
 * conf }] (a must come before b), soft: [{ a, b, w, why }] }. A sure link (not unsure, confidence ≥ 0.5) and a promise
 * are hard; a hard edge that would close a cycle (the footage contradicts itself) becomes soft, weakest first.
 */
export function storyConstraints(segs, { links = [], promises = [] } = {}) {
  const segOf = new Map();
  segs.forEach((g, i) => g.moments.forEach((n) => segOf.set(n, i)));
  const cand = [];
  for (const l of links) {
    const c = segOf.get(l.cause), r = segOf.get(l.reaction);
    if (c === undefined || r === undefined || c === r) continue;
    const [a, b] = l.direction === "before" ? [r, c] : [c, r];
    const sure = !l.unsure && (l.confidence ?? 0) >= 0.5;
    cand.push({ a, b, conf: l.confidence ?? 0.4, sure, why: `cause → reaction (moments ${l.cause} → ${l.reaction})`, whyAr: `سبب ← رد فعل (لحظة ${l.cause} ← ${l.reaction})` });
  }
  for (const p of promises) {
    const a = segOf.get(p.promise), b = segOf.get(p.payoff);
    if (a === undefined || b === undefined || a === b) continue;
    cand.push({ a, b, conf: 1, sure: true, why: `promise → payoff (moments ${p.promise} → ${p.payoff})`, whyAr: `وعد ← نتيجته (لحظة ${p.promise} ← ${p.payoff})` });
  }
  const hard = [], soft = [];
  const reach = (from, to) => { const seen = new Set([from]), st = [from]; while (st.length) { const x = st.pop(); if (x === to) return true; for (const h of hard) if (h.a === x && !seen.has(h.b)) { seen.add(h.b); st.push(h.b); } } return false; };
  for (const c of cand.filter((x) => x.sure).sort((p, q) => q.conf - p.conf)) {
    if (hard.some((h) => h.a === c.a && h.b === c.b)) continue;
    if (reach(c.b, c.a)) { soft.push({ ...c, w: 1.5 * c.conf, cycle: true }); continue; }
    hard.push(c);
  }
  for (const c of cand.filter((x) => !x.sure)) soft.push({ ...c, w: 1.0 * c.conf });
  return { hard, soft };
}

// ------------------------------------------------------------------ the order
export const STORY_WEIGHTS = { beat: 0.6, edge: 2.0, time: 0.6, given: 0.25, clip: 3.0, light: 0.4, cont: 1.0, contig: 2.0, hard: 1000 };

/**
 * The objective's two matrices: P[a][b] — what it is worth to play a before b (anywhere before), A[a][b] — what it
 * is worth to play b right after a (continuity). opts.useTime: use the time hints (off in the bench: the shuffled
 * pieces of one file would give the answer away).
 */
export function storyMatrices(segs, { hard = [], soft = [] } = {}, { useTime = true, W = STORY_WEIGHTS } = {}) {
  const n = segs.length;
  const P = Array.from({ length: n }, () => new Float64Array(n)), A = Array.from({ length: n }, () => new Float64Array(n));
  const expRank = (g) => { const v = Object.entries(g.beatScores || { build: 1 }), z = v.reduce((s, [, x]) => s + Math.exp(x), 0); return v.reduce((s, [k, x]) => s + BEAT_RANK[k] * Math.exp(x), 0) / z; };
  const E = segs.map(expRank);
  // The topic as tf-idf vectors.
  const df = new Map();
  for (const g of segs) for (const t of g.tokens || []) df.set(t, (df.get(t) || 0) + 1);
  const vec = segs.map((g) => { const v = new Map(); for (const t of g.tokens || []) { const w = Math.log(1 + n / (df.get(t) || 1)); if (df.get(t) < n) v.set(t, w); } return v; });
  const cos = (x, y) => { let d = 0, a = 0, b = 0; for (const [k, v] of x) { a += v * v; if (y.has(k)) d += v * y.get(k); } for (const v of y.values()) b += v * v; return a && b ? d / Math.sqrt(a * b) : 0; };
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    if (a === b) continue;
    const ga = segs[a], gb = segs[b];
    let p = W.beat * Math.max(-1, Math.min(1, (E[b] - E[a]) / 2)) * (0.3 + 0.7 * (ga.beatConf + gb.beatConf) / 2);
    if (ga.opens && !gb.opens) p += W.edge;
    if (gb.closes && !ga.closes) p += W.edge;
    if (ga.closes && !gb.closes) p -= W.edge;
    if (gb.opens && !ga.opens) p -= W.edge;
    // Inside one clip the recording order is physical: a strong prior (a long raw may still be told otherwise).
    if (ga.clip === gb.clip) p += W.clip * Math.sign(gb.s - ga.s);
    else if (useTime && Number.isFinite(ga.timeUs) && Number.isFinite(gb.timeUs) && Math.abs(gb.timeUs - ga.timeUs) > US) p += W.time * Math.sign(gb.timeUs - ga.timeUs);
    // Nothing else known: the clips stay a little in the order they were given (a folder sorts by file name — on a
    // phone, the shooting order).
    else p += W.given * Math.sign(gb.clip - ga.clip);
    if (ga.night === false && gb.night === true) p += W.light;
    if (ga.night === true && gb.night === false) p -= W.light;
    P[a][b] = p;
    // Continuity: the same place, outfits, topic and people next to each other; one take cut in two strongly so.
    const sim = 0.35 * jaccard(ga.place || new Set(), gb.place || new Set()) + 0.25 * jaccard(ga.looks || new Set(), gb.looks || new Set()) + 0.25 * cos(vec[a], vec[b]) + 0.15 * jaccard(ga.people || new Set(), gb.people || new Set());
    A[a][b] = W.cont * sim + (ga.clip === gb.clip && Math.abs(gb.s - ga.e) < 50_000 ? W.contig : 0);
  }
  for (const c of soft) P[c.a][c.b] += c.w;
  for (const h of hard) P[h.b][h.a] -= W.hard;
  return { P, A, expRank: E.map(r2) };
}

/** The objective of an order (higher is better). */
export function orderScore(order, { P, A }) {
  let s = 0;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) s += P[order[i]][order[j]];
    if (i) s += A[order[i - 1]][order[i]];
  }
  return s;
}

/** The best order of n items under { P, A }: exact (dynamic program over subsets) up to `exactMax`, else local search. */
export function bestOrder(n, M, { exactMax = 13, starts = [] } = {}) {
  if (n <= 1) return Array.from({ length: n }, (_, i) => i);
  const { P, A } = M;
  if (n <= exactMax) {
    const F = 1 << n, NEG = -Infinity;
    const dp = new Float64Array(F * n).fill(NEG), prev = new Int32Array(F * n).fill(-1);
    for (let b = 0; b < n; b++) dp[(1 << b) * n + b] = 0;
    for (let mask = 1; mask < F; mask++) for (let last = 0; last < n; last++) {
      const v = dp[mask * n + last];
      if (v === NEG) continue;
      for (let b = 0; b < n; b++) {
        if (mask & (1 << b)) continue;
        let g = v + A[last][b];
        for (let a = 0; a < n; a++) if (mask & (1 << a)) g += P[a][b];
        const k = (mask | (1 << b)) * n + b;
        if (g > dp[k]) { dp[k] = g; prev[k] = last; }
      }
    }
    let last = 0;
    for (let b = 1; b < n; b++) if (dp[(F - 1) * n + b] > dp[(F - 1) * n + last]) last = b;
    const out = [];
    for (let mask = F - 1, x = last; x >= 0;) { out.unshift(x); const p = prev[mask * n + x]; mask &= ~(1 << x); x = p; }
    return out;
  }
  // Local search: every item moved to every other place, until nothing improves; several starts, the best kept.
  const improve = (o) => {
    let cur = [...o], best = orderScore(cur, M), better = true;
    while (better) {
      better = false;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const c = [...cur], [x] = c.splice(i, 1);
        c.splice(j, 0, x);
        const s = orderScore(c, M);
        if (s > best + 1e-9) { best = s; cur = c; better = true; }
      }
    }
    return { o: cur, s: best };
  };
  const greedy = () => { const left = new Set(Array.from({ length: n }, (_, i) => i)), o = []; while (left.size) { let bx = null, bs = -Infinity; for (const b of left) { let s = o.length ? A[o[o.length - 1]][b] : 0; for (const a of o) s += P[a][b]; for (const c of left) if (c !== b) s += P[b][c]; if (s > bs) { bs = s; bx = b; } } o.push(bx); left.delete(bx); } return o; };
  let top = null;
  for (const st of [greedy(), Array.from({ length: n }, (_, i) => i), ...starts]) { const r = improve(st); if (!top || r.s > top.s) top = r; }
  return top.o;
}

/**
 * A proposed order (segment NUMBERS, 1-based — a planner model's answer) made valid: unknown and repeated numbers
 * dropped, missing segments inserted where they fit best, then a stable topological pass so no hard constraint is
 * broken (a reaction never before its cause, a payoff never before its promise). Returns { order (indices), fixes }.
 */
export function repairOrder(proposed, segs, { hard = [] } = {}, M = null) {
  const n = segs.length, fixes = [];
  let order = [];
  for (const k of proposed || []) {
    const i = Number(k) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= n) { fixes.push({ en: `segment ${k} does not exist`, ar: `مشهد ${k} مش موجود` }); continue; }
    if (order.includes(i)) { fixes.push({ en: `segment ${k} twice`, ar: `مشهد ${k} متكرر` }); continue; }
    order.push(i);
  }
  for (let i = 0; i < n; i++) {
    if (order.includes(i)) continue;
    let at = order.length;
    if (M) { let bs = -Infinity; for (let j = 0; j <= order.length; j++) { const c = [...order]; c.splice(j, 0, i); const s = orderScore(c, M); if (s > bs) { bs = s; at = j; } } }
    order.splice(at, 0, i);
    fixes.push({ en: `segment ${i + 1} was missing: put at place ${at + 1}`, ar: `مشهد ${i + 1} كان ناقص: اتحط في المكان ${at + 1}` });
  }
  // Stable topological pass: the next item is the earliest one (in the proposal) whose hard predecessors are placed.
  const pos = new Map(order.map((x, i) => [x, i]));
  const preds = (x) => hard.filter((h) => h.b === x).map((h) => h.a);
  const out = [], placed = new Set();
  while (out.length < n) {
    const next = order.filter((x) => !placed.has(x)).sort((a, b) => pos.get(a) - pos.get(b)).find((x) => preds(x).every((p) => placed.has(p)))
      ?? order.find((x) => !placed.has(x)); // (a cycle cannot happen: storyConstraints breaks them)
    out.push(next); placed.add(next);
  }
  for (const h of hard) if (pos.get(h.a) > pos.get(h.b)) fixes.push({ en: `segment ${h.a + 1} moved before ${h.b + 1}: ${h.why}`, ar: `مشهد ${h.a + 1} اتنقل قبل ${h.b + 1}: ${h.whyAr}` });
  return { order: out, fixes };
}

/** The hard constraints an order breaks (order: indices). */
export function violations(order, hard = []) {
  const pos = new Map(order.map((x, i) => [x, i]));
  return hard.filter((h) => pos.has(h.a) && pos.has(h.b) && pos.get(h.a) > pos.get(h.b));
}

/**
 * The whole story pass on the director's moments. input: { moments, links, promises, events, clips }, opts: { useTime,
 * minUs, maxUs, W }. Returns { segments (described), constraints, order (indices, the rules' best), shooting (indices
 * in the footage's order), matrices, rank: Map(moment → place) for core/treatments.js, moments: [n in story order] }.
 */
export function storyPlan({ moments, links = [], promises = [], events = [], clips = [] }, { useTime = true, minUs, maxUs, W } = {}) {
  const raw = segmentMoments(moments, { events, links, ...(minUs ? { minUs } : {}), ...(maxUs ? { maxUs } : {}) });
  const segments = describeSegments(raw, { moments, events, clips, promises, links });
  const constraints = storyConstraints(segments, { links, promises });
  const M = storyMatrices(segments, constraints, { useTime, ...(W ? { W } : {}) });
  const shooting = segments.map((_, i) => i);
  const order = bestOrder(segments.length, M, { starts: [shooting] });
  return { segments, constraints, matrices: M, order, shooting, ...expand(segments, order) };
}

/**
 * Orders proposed by models as votes on top of the rules: every pair a model put a before b adds `w` / (number of
 * orders) to P[a][b] — so the models decide where they agree, the rules where they disagree, and the hard
 * constraints still hold. Returns { order (indices), matrices, agreement (share of pairs the orders agree on) }.
 */
export function voteOrders(M, orders, { w = 3 } = {}) {
  const n = M.P.length, valid = orders.filter((o) => o?.length === n);
  if (!valid.length) return { order: bestOrder(n, M), matrices: M, agreement: null };
  const P = M.P.map((row) => Float64Array.from(row));
  for (const o of valid) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) P[o[i]][o[j]] += w / valid.length;
  let agree = 0, pairs = 0;
  if (valid.length > 1) {
    const pos = valid.map((o) => new Map(o.map((x, i) => [x, i])));
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { pairs++; const s0 = pos[0].get(a) < pos[0].get(b); if (pos.every((p) => (p.get(a) < p.get(b)) === s0)) agree++; }
  }
  const matrices = { ...M, P };
  return { order: bestOrder(n, matrices, { starts: valid }), matrices, agreement: pairs ? r2(agree / pairs) : null };
}

/** Moment numbers in a segment order, and each moment's place (core/treatments.js `story.rank`). */
export function expand(segments, order) {
  const ns = order.flatMap((i) => segments[i].moments);
  return { moments: ns, rank: new Map(ns.map((n, i) => [n, i])) };
}

/** Why each segment sits where it does (Arabic and English): its beat and cue words, and the constraints into it. */
export function segmentWhy(g, i, { hard = [] } = {}) {
  const into = hard.filter((h) => h.b === i);
  const ar = [`${BEAT_AR[g.beat]}${g.cues?.length ? ` («${g.cues.slice(0, 2).join("»، «")}»)` : ""}`, ...into.map((h) => h.whyAr)].join("؛ ");
  const en = [`${g.beat}${g.cues?.length ? ` (${g.cues.slice(0, 2).join(", ")})` : ""}`, ...into.map((h) => h.why)].join("; ");
  return { ar, en };
}

/** A compact table of the segments for the planner model (one line each). */
export function storyTable(segs, { hard = [], soft = [] } = {}, { listOrder = null } = {}) {
  const sec = (us) => (us / US).toFixed(0);
  // listOrder: the order the lines are LISTED in (their numbers stay) — asking twice in two listings shows how much
  // of a model's answer is only the listing's order.
  const lines = (listOrder || segs.map((_, i) => i)).map((i) => [segs[i], i]).map(([g, i]) => {
    const place = [g.indoor === true ? "indoor" : g.indoor === false ? "outdoor" : "", g.night === true ? "night" : g.night === false ? "day" : "", g.summary ? `[${g.summary.slice(0, 90)}]` : ""].filter(Boolean).join(" ");
    const said = g.text ? `«${g.head}${g.tail ? ` … ${g.tail}` : ""}»` : "(no words)";
    return `${i + 1} | ${sec(g.lengthUs)} s | clip ${g.clip + 1} | beat guess: ${g.beat} (${g.beatConf}) | reactions ${g.reactions} | ${place} | ${said}`;
  });
  const hs = hard.map((h) => `${h.a + 1} before ${h.b + 1} (${h.why.split(" (")[0]})`);
  const ss = soft.filter((s) => !s.cycle).map((s) => `${s.a + 1} before ${s.b + 1}?`);
  return `${lines.join("\n")}${hs.length ? `\nMust: ${hs.join("; ")}` : ""}${ss.length ? `\nProbably: ${ss.join("; ")}` : ""}`;
}

/**
 * The story part of the cut sheet: the proposed order with each segment's beat and why, the shooting order as the
 * alternative, the repairs. Returns { source, order: [{ k, beat, beat_ar, at, clip, text, why, whyAr }], shooting: [k],
 * fixes, constraints: { hard, soft }, why, text: [Arabic lines] }.
 */
export function storySheet({ segments, order, shooting, constraints = { hard: [], soft: [] }, source = "rules", why = "", fixes = [], beats = null }) {
  const show = (i) => {
    const g = segments[i], w = segmentWhy({ ...g, beat: beats?.get(i) || g.beat }, i, constraints);
    return { k: i + 1, beat: beats?.get(i) || g.beat, beat_ar: BEAT_AR[beats?.get(i) || g.beat], at: r2(g.s / US), lengthS: r2(g.lengthUs / US), clip: g.clip + 1, text: (g.head || g.summary || "").slice(0, 90), why: w.en, whyAr: w.ar };
  };
  const out = { source, order: order.map(show), shooting: shooting.map((i) => i + 1), fixes, constraints: { hard: constraints.hard.length, soft: constraints.soft.length }, why, same: order.every((x, i) => x === shooting[i]) };
  const L = [`ترتيب القصة (${source === "rules" ? "بالقواعد" : `من ${source}`}): ${out.order.map((o) => o.k).join(" ← ")}`];
  if (why) L.push(`ليه: ${why}`);
  for (const o of out.order) L.push(`  مشهد ${o.k} (كليب ${o.clip}، ${o.at} ث، ${o.lengthS} ث): ${o.whyAr}${o.text ? ` — «${o.text}»` : ""}`);
  L.push(out.same ? "ترتيب التصوير هو نفسه ترتيب القصة" : `البديل: بترتيب التصوير ${out.shooting.join(" ← ")}`);
  for (const f of fixes) L.push(`تصليح: ${f.ar || f}`);
  out.text = L;
  return out;
}

// ------------------------------------------------------------------ measurement
/** Kendall tau between two orders of the same items (1 = the same order, −1 = reversed). */
export function kendallTau(a, b) {
  const pos = new Map(b.map((x, i) => [x, i]));
  const xs = a.filter((x) => pos.has(x)).map((x) => pos.get(x));
  let c = 0, d = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) { if (xs[i] < xs[j]) c++; else d++; }
  return c + d ? r2((c - d) / (c + d)) : 1;
}
/** The share of items at their exact place. */
export const exactShare = (a, b) => (a.length ? r2(a.filter((x, i) => b[i] === x).length / a.length) : 1);
/** The share of b's neighbours (x then y) that a keeps as neighbours in the same direction. */
export function keptNeighbours(a, b) {
  if (b.length < 2) return 1;
  const next = new Map(a.slice(0, -1).map((x, i) => [x, a[i + 1]]));
  let k = 0;
  for (let i = 1; i < b.length; i++) if (next.get(b[i - 1]) === b[i]) k++;
  return r2(k / (b.length - 1));
}
