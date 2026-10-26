// Choosing graphics (plan item 10, steps 2–5): each component's contract → a deterministic eligibility filter →
// a ranker that keeps the top 3 and fills their parameters (a stub now; the LLM plugs in at the director phase) →
// hard checks (enters on its word, off the face, inside the platform-safe area, on screen long enough to read) →
// a density guard over the whole timeline (one major graphic per 8–12 s at most, no repeat within 45 s, ≤ ~40 % of
// the runtime covered, a breath after every peak). Times in µs (like the words); boxes are fractions of the frame.
import { KIT_TEMPLATES, kitParams, kitTexts, kitBox, kitBlend } from "../core/graphicsKit.js";
import { readSeconds, visibleChars, splitWords, normWord, formatNumber } from "./arabic.js";
import { platformZones, safeRect, faceUnion, placeY, overlapArea, area, intersect, grow, inside, EDGE_TOLERANCE, MAX_BLOCK_PIXELS } from "./layout.js";
import { sentenceNeeds } from "./needs.js";

const US = 1_000_000;
/** Allowed gap between a graphic's entry and its word (frames, either way) — the measured sync check. */
export const SYNC_FRAMES = 3;

/** The density rules (plan item 10, step 5); the golden reference ran at 5.6 elements a minute. */
export const DENSITY = { majorGapSec: 8, majorGapMaxSec: 12, repeatSec: 45, maxCoverage: 0.4, calmAfterPeakSec: 1.5 };

// ─────────────────────────── eligibility ───────────────────────────

/**
 * Can this template serve this need? Deterministic: shared tag, enough time in the sentence, text short enough,
 * the picture/cut-out it needs is available, energy close enough. Returns { ok, why } (why: the first failed rule).
 * ctx: { hasImage(need, template) → bool, hasCutout → bool }
 */
export function eligible(template, need, ctx = {}) {
  const tpl = KIT_TEMPLATES[template];
  if (!tpl) return { ok: false, why: "unknown template" };
  const c = tpl.contract;
  const tags = c.tags.filter((t) => need.tags.includes(t));
  if (!tags.length) return { ok: false, why: "no shared tag" };
  const room = (need.roomUs ?? Infinity) / US;
  if (room < c.minSec) return { ok: false, why: `needs ${c.minSec} s, the moment has ${room.toFixed(1)} s` };
  if (c.needsImage && !ctx.hasImage?.(need, template)) return { ok: false, why: "needs a picture" };
  if (c.needsCutout && !ctx.hasCutout) return { ok: false, why: "needs a person cut out" };
  if (Math.abs(c.energy - need.energy) > 2) return { ok: false, why: `energy ${c.energy} vs ${need.energy}` };
  return { ok: true, tags };
}

/** Templates eligible for a need, with the shared tags. */
export function eligibleTemplates(need, ctx = {}) {
  return Object.keys(KIT_TEMPLATES).map((id) => ({ id, ...eligible(id, need, ctx) })).filter((x) => x.ok);
}

// ─────────────────────────── filling parameters ───────────────────────────

const clip = (s, n) => { const w = splitWords(s); const out = []; for (const x of w) { if (visibleChars([...out, x].join(" ")) > n) break; out.push(x); } return out.join(" ") || w[0] || ""; };
const wordsOf = (need, words) => words.slice(need.w0, need.w1 + 1);
const relMs = (us, need0) => Math.max(0, Math.round((us - need0) / 1000));
const MOMENT_EMOJI = { laugh: "😂", shock: "😱", oops: "😅", win: "🥳", fire: "🔥", tasty: "😋", love: "🥰", question: "🤔", idea: "💡", money: "💸", cool: "😎", alert: "🚨", look: "👀", effort: "💪", tired: "😪", no: "❌", yes: "👍" };

/**
 * Parameters for a template from a need (deterministic — what the stub ranker uses and what an LLM may override).
 * Returns null when the template cannot be filled from what was said (no invented numbers, names or results).
 */
export function fillParams(template, need, words, ctx = {}) {
  const ws = wordsOf(need, words), anchorTag = KIT_TEMPLATES[template].contract.tags.find((t) => need.anchors[t]);
  const anchor = need.anchors[anchorTag] || { w: need.w0, atUs: need.startUs };
  const strongest = need.moments?.slice().sort((a, b) => b.score - a.score)[0];
  const punch = strongest?.text || ws.slice(-2).map((w) => w.text).join(" ");
  const n0 = need.numbers?.[0];
  const at0 = anchor.atUs;
  const after = (k) => ws.slice(Math.max(0, anchor.w - need.w0), Math.max(0, anchor.w - need.w0) + k).map((w) => w.text).join(" ");
  switch (template) {
    case "kinetic-word": return { text: clip(punch, 20), hi: "" };
    case "slam-stamp": return { text: clip(punch, 14) };
    case "word-reveal": {
      const text = clip(need.text, 44), n = splitWords(text).length;
      return { text, times: ws.slice(0, n).map((w) => relMs(w.startUs, need.startUs)), emphasis: strongest ? splitWords(strongest.text).slice(0, 2) : [] };
    }
    case "gsap-title": return { text: clip(need.text, 26) };
    case "title-card": { const w = splitWords(clip(need.text, 30)); const h = Math.ceil(w.length / 2); return w.length >= 2 ? { l1: w.slice(0, h).join(" "), l2: w.slice(h).join(" "), kicker: "" } : null; }
    case "chapter-banner": return { tag: "", text: clip(after(4) || need.text, 20) };
    case "chapter-card": { const x = need.numbers?.find((n) => n.unit === "يوم") || n0; return x ? { text: clip(`${ws[Math.max(0, x.w - need.w0 - 1)]?.text || "اليوم"} ${formatNumber(x.value)}`, 12) } : { text: clip(after(2), 12) }; }
    case "counter-roll": return n0 ? { to: n0.value, from: 0, suffix: n0.unit ? ` ${n0.unit}` : "", label: n0.item || "" } : null;
    case "impact-number": return n0 ? { text: clip(n0.label, 8) } : null;
    case "delta-pill": { const d = need.numbers?.find((n) => n.kind === "delta"); return d ? { text: `${d.sign === "-" ? "-" : "+"}${formatNumber(d.value)}${d.unit ? ` ${d.unit}` : ""}`, kind: d.sign === "-" ? "loss" : "gain" } : null; }
    case "list-montage": { const L = need.list || need.numbers?.filter((n) => n.kind === "list") || []; return L.length >= 2 ? { items: L.slice(0, 6).map((n) => clip(n.label, 18)), times: L.slice(0, 6).map((n) => relMs(n.at, at0)) } : null; }
    case "joke-math": { const L = need.numbers || []; return L.length >= 2 ? { title: "", lines: L.slice(0, 5).map((n) => clip(n.label, 22)), times: L.slice(0, 5).map((n) => relMs(n.at, at0)) } : null; }
    case "compare-gauge": { const P = (need.numbers || []).filter((n) => n.unit === "٪"); if (P.length < 2) return null; const lab = (n) => clip(ws[Math.max(0, n.w - need.w0 - 1)]?.text || "", 12); return { leftLabel: lab(P[0]), leftValue: Math.min(100, P[0].value), rightLabel: lab(P[1]), rightValue: Math.min(100, P[1].value) }; }
    case "progress-hud": return n0 ? { label: "", value: n0.value, max: ctx.goal?.value || Math.max(n0.value, 1), unit: n0.unit || "" } : null;
    case "corner-hud": { const x = need.numbers?.[0]; return x ? { text: clip(`${ws[Math.max(0, x.w - need.w0 - 1)]?.text || ""} ${formatNumber(x.value)}`, 12) } : null; }
    case "timer-hud": { const x = need.numbers?.find((n) => ["ثانية", "دقيقة"].includes(n.unit)); return x ? { from: x.unit === "دقيقة" ? x.value * 60 : x.value } : null; }
    case "name-tag": { const w = need.anchors.name?.w; return w !== undefined ? { name: clip(words[w].text.replace(/[^\p{L}\p{N}\s]/gu, ""), 12), role: "" } : null; }
    case "photo-card": { const w = need.anchors.thing?.w ?? need.anchors.place?.w ?? need.anchors.food?.w; if (w === undefined) return null; const src = ctx.imageFor?.(words[w].text, need); return src ? { src, label: clip(words[w].text.replace(/[^\p{L}\p{N}\s]/gu, ""), 14) } : null; }
    case "phone-frame": { const src = ctx.imageFor?.("phone", need); return src ? { src, title: "" } : null; }
    case "cctv-wall": { const stills = ctx.stillsFor?.(need) || []; return stills.length >= 4 ? { stills } : null; }
    case "freeze-fx": { const still = ctx.frameAt?.(anchor.atUs); return still ? { still } : null; }
    case "flashback": return { label: clip(after(3), 18) };
    case "narrator-card": return { text: clip(need.text, 32) };
    case "weather-swap": { const t = need.text; const rain = /مطر|برد|سقع|غيم|تلج/.test(t), sun = /شمس|حر/.test(t); return { text: clip(need.text, 18), from: rain && !sun ? "☀️" : "🌧️", to: rain && !sun ? "🌧️" : "☀️" }; }
    case "tint-fx": { const t = need.text; return { kind: /حلم|رومانس/.test(t) ? "dream" : /خطر|رعب|مرعب/.test(t) ? "red" : "night" }; }
    case "speed-lines": case "confetti": case "streak": return {};
    case "hand-drawn": case "path-arrow": return ctx.focusRect ? (template === "hand-drawn" ? { ...ctx.focusRect, label: "" } : { x2: ctx.focusRect.x + ctx.focusRect.w / 2, y2: ctx.focusRect.y + ctx.focusRect.h / 2, label: "" }) : null;
    case "shape-burst": { const w = need.anchors.offer?.w; return w !== undefined ? { text: clip(words[w].text, 8) } : null; }
    case "lottie-sticker": case "animated-emoji": { const e = MOMENT_EMOJI[strongest?.type]; if (!e) return null; const src = ctx.emojiFor?.(e, template); return template === "animated-emoji" && !src ? null : { emoji: template === "lottie-sticker" ? e : (ctx.emojiName?.(e) || "joy"), ...(src ? { src } : {}) }; }
    case "swap-card": { const k = splitWords(need.text).findIndex((w) => /^(طلع|طلعت|اتضح|بالعكس)/.test(normWord(w))); if (k < 1) return null; const w = splitWords(need.text); return { before: clip(w.slice(0, k).join(" "), 20), after: clip(w.slice(k).join(" "), 20) }; }
    default: return {};
  }
}

// ─────────────────────────── timing, placement, hard checks ───────────────────────────

/** Default length of a template for a need (µs): its default, inside its contract, long enough to read. */
export function lengthFor(template, params) {
  const tpl = KIT_TEMPLATES[template], c = tpl.contract;
  const read = Math.max(0, ...kitTexts(template, params).map(readSeconds)) + (tpl.inUs + tpl.outUs) / US;
  const sec = Math.min(c.maxSec, Math.max(c.minSec, tpl.durUs / US, read));
  return Math.round(sec * US);
}

/** Context of a frame: size, the platform zones, the safe rectangle and the face boxes ({ t (s), x, y, w, h }). */
export function frameCtx({ width = 1080, height = 1920, fps = 30, platforms, faces = [] } = {}) {
  return { W: width, H: height, fps, zones: platformZones(width, height, platforms), safe: safeRect(width, height, platforms), faces };
}

/**
 * Move a graphic off the face and into the safe area when its template has a free position (y, or x for side
 * elements). Returns the adjusted params (unchanged when nothing better exists).
 */
export function place(template, params, item, fctx) {
  const tpl = KIT_TEMPLATES[template];
  if (tpl.contract.fullFrame) return params;
  const P = kitParams(template, params);
  const face = faceUnion(fctx.faces, item.atUs / US, (item.atUs + item.durUs) / US);
  const box = kitBox(template, P, fctx.W, fctx.H);
  if (!box) return params;
  const out = { ...params };
  const ySch = tpl.params.y;
  if (ySch) {
    // Some templates take the centre, some the top edge (titles say "Top edge"): keep the template's meaning.
    const topEdge = /top edge/i.test(ySch.title);
    const region = { "upper-third": "upper-third", top: "top", bottom: "bottom", center: "center", side: "center", person: "top", target: "center" }[tpl.contract.region] || "center";
    const { y } = placeY(box.h, region, { safe: fctx.safe, face });
    const val = topEdge ? y : y + box.h / 2;
    out.y = Math.min(ySch.maximum, Math.max(ySch.minimum, Math.round(val * 1000) / 1000));
  }
  if (tpl.params.x && face && tpl.contract.region === "side") {
    const fc = face.x + face.w / 2, xs = tpl.params.x;
    const leftEdge = /left edge/i.test(xs.title);
    const sf = fctx.safe, m = 0.03;
    const target = fc > 0.5 ? sf.x + m + box.w / 2 : sf.x + sf.w - m - box.w / 2; // the free side, inside the safe area
    out.x = Math.min(xs.maximum, Math.max(xs.minimum, Math.round((leftEdge ? target - box.w / 2 : target) * 1000) / 1000));
  }
  return out;
}

/**
 * Hard checks of one placed graphic. item: { template, params, atUs, durUs, anchorUs }. measured (optional, from
 * measure.js on the rendered clip): { entryFrame, bbox, zonePixels, faceOverlap } replaces the predictions.
 * Returns { ok, checks: { sync, face, safe, readable } } where each is { ok, value, limit }.
 */
export function hardChecks(item, fctx, measured = null) {
  const tpl = KIT_TEMPLATES[item.template], c = tpl.contract, P = kitParams(item.template, item.params);
  const fps = fctx.fps;
  // Sync: the first visible frame vs the word's frame.
  const entryUs = measured?.entryFrame !== undefined ? item.atUs + (measured.entryFrame / fps) * US : item.atUs;
  const syncFrames = Math.round(((entryUs - (item.anchorUs ?? item.atUs)) / US) * fps);
  const sync = { ok: Math.abs(syncFrames) <= SYNC_FRAMES, value: syncFrames, limit: SYNC_FRAMES };
  // Face: the graphic's box must not cover the face (full-frame looks are exempt by contract).
  const box = measured?.bbox || kitBox(item.template, P, fctx.W, fctx.H);
  const face = faceUnion(fctx.faces, item.atUs / US, (item.atUs + item.durUs) / US);
  const faceShare = c.fullFrame || !face || !box ? 0 : measured?.faceOverlap ?? overlapArea(box, face) / Math.max(1e-9, area(face));
  const faceCheck = { ok: faceShare <= 0.05, value: Math.round(faceShare * 1000) / 1000, limit: 0.05 };
  // Safe area: drawn pixels inside the platforms' block zones (edge tolerance as in the skill), at 1080×1920 scale.
  let zonePx = 0;
  if (!c.fullFrame && box) {
    if (measured?.zonePixels !== undefined) zonePx = measured.zonePixels;
    else for (const z of fctx.zones.block) { const zi = shrinkToContent(z, EDGE_TOLERANCE * (Math.min(fctx.W, fctx.H) / fctx.H), EDGE_TOLERANCE * (Math.min(fctx.W, fctx.H) / fctx.W)); zonePx += overlapArea(box, zi) * 1080 * 1920; }
  }
  const safe = { ok: zonePx <= MAX_BLOCK_PIXELS, value: Math.round(zonePx), limit: MAX_BLOCK_PIXELS };
  // Readable: on screen (between entry and exit) at least as long as its text takes to read.
  const holdSec = (item.durUs - tpl.inUs - tpl.outUs) / US;
  const need = Math.max(0, ...kitTexts(item.template, P).map(readSeconds));
  const readable = { ok: !need || holdSec >= need - 0.05, value: Math.round(holdSec * 100) / 100, limit: need };
  const checks = { sync, face: faceCheck, safe, readable };
  return { ok: Object.values(checks).every((x) => x.ok), checks };
}

/** A block zone shrunk on its content side by the edge tolerance (dy, dx fractions). */
function shrinkToContent(z, dy, dx) {
  const top = z.y <= 0.001, bottom = z.y + z.h >= 0.999, right = z.x + z.w >= 0.999, left = z.x <= 0.001, full = z.w >= 0.99;
  if (full && top) return { ...z, h: Math.max(0, z.h - dy) };
  if (full && bottom) return { ...z, y: z.y + dy, h: Math.max(0, z.h - dy) };
  if (right) return { ...z, x: z.x + dx, w: Math.max(0, z.w - dx) };
  if (left) return { ...z, w: Math.max(0, z.w - dx) };
  return z;
}

// ─────────────────────────── ranking (stub for the LLM) ───────────────────────────

/**
 * The ranker interface. The director phase plugs an LLM in here:
 *   ranker({ need, candidates: [{ template, name, use, tags, energy, params }], pack, recent }) →
 *     Promise<[{ template, params?, score, why }]>  (best first; only eligible templates are accepted, params are
 *     merged over the filled ones and clamped to the schema; at most 3 are kept)
 * heuristicRanker is the deterministic default: shared tags (the first contract tag is the component's main use),
 * energy fit, novelty against the recent picks, and majors preferred on strong moments.
 */
/** Tags that many sentences carry: they count less than the specific ones (a list wants a list graphic). */
const GENERIC_TAGS = new Set(["number", "count", "thing", "reaction", "hook", "title", "point", "food", "place", "question", "time", "surprise", "money"]);
export async function heuristicRanker({ need, candidates, recent = [] }) {
  return candidates.map((c) => {
    const tpl = KIT_TEMPLATES[c.template], ct = tpl.contract;
    let score = 0;
    ct.tags.forEach((t, i) => { if (need.tags.includes(t)) score += GENERIC_TAGS.has(t) ? (i === 0 ? 2 : 0.5) : (i === 0 ? 3 : 1.5); });
    score -= Math.abs(ct.energy - need.energy) * 0.6;
    const last = recent.lastIndexOf(c.template);
    if (last >= 0) score -= 2.5 / (recent.length - last);
    if (ct.major && need.energy >= 4) score += 0.5;
    if (ct.fullFrame) score -= 0.4; // a full-frame look is a strong choice: only when it clearly fits
    return { template: c.template, params: c.params, score: Math.round(score * 100) / 100, why: `tags ${ct.tags.filter((t) => need.tags.includes(t)).join("+")} · energy ${ct.energy}/${need.energy}` };
  }).sort((a, b) => b.score - a.score);
}

/** Clamp parameters to their schema (numbers in range, strings cut, enums kept valid, arrays bounded). */
export function clampParams(template, params) {
  const tpl = KIT_TEMPLATES[template], out = {};
  for (const [k, v] of Object.entries(params || {})) {
    const s = tpl.params[k];
    if (!s) continue;
    if (s.type === "number" || s.type === "integer") { const n = Number(v); if (Number.isFinite(n)) out[k] = Math.min(s.maximum, Math.max(s.minimum, s.type === "integer" ? Math.round(n) : n)); }
    else if (s.type === "string") { const x = String(v ?? ""); if (s.enum ? s.enum.includes(x) : !s.pattern || new RegExp(s.pattern).test(x)) out[k] = x.slice(0, s.maxLength || 1000); }
    else if (s.type === "boolean") out[k] = !!v;
    else if (s.type === "array" && Array.isArray(v)) out[k] = v.slice(0, s.maxItems || 12).map((x) => (s.items?.type === "number" ? Number(x) || 0 : String(x).slice(0, s.items?.maxLength || 100)));
  }
  return out;
}

/**
 * Top 3 graphics for one need: eligible → filled → ranked → placed → hard-checked. Each pick carries its timing
 * (atUs = the anchor word, durUs), its checks and the reason. Picks that fail a hard check are dropped.
 */
export async function rankNeed(need, words, { ranker = heuristicRanker, fctx = frameCtx(), ctx = {}, recent = [], pack = "punchy" } = {}) {
  const candidates = [];
  for (const { id } of eligibleTemplates(need, ctx)) {
    const filled = fillParams(id, need, words, ctx);
    if (!filled) continue;
    const params = clampParams(id, filled);
    if (KIT_TEMPLATES[id].contract.maxChars && Math.max(0, ...kitTexts(id, params).map(visibleChars)) > KIT_TEMPLATES[id].contract.maxChars) continue;
    candidates.push({ template: id, name: KIT_TEMPLATES[id].name, use: KIT_TEMPLATES[id].use, tags: KIT_TEMPLATES[id].contract.tags, energy: KIT_TEMPLATES[id].contract.energy, params });
  }
  if (!candidates.length) return [];
  const ranked = await ranker({ need, candidates, pack, recent });
  const allowed = new Map(candidates.map((c) => [c.template, c]));
  const picks = [];
  for (const r of ranked) {
    const base = allowed.get(r.template);
    if (!base || picks.some((p) => p.template === r.template)) continue;
    const params = { ...base.params, ...clampParams(r.template, r.params || {}) };
    const tag = KIT_TEMPLATES[r.template].contract.tags.find((t) => need.anchors[t]);
    const anchorUs = need.anchors[tag]?.atUs ?? need.startUs;
    const durUs = lengthFor(r.template, params);
    const item = { template: r.template, params, atUs: anchorUs, durUs, anchorUs, needIndex: need.i, score: r.score, why: r.why, energy: need.energy, major: KIT_TEMPLATES[r.template].contract.major };
    item.params = place(r.template, params, item, fctx);
    item.blend = kitBlend(r.template, item.params);
    const hc = hardChecks(item, fctx);
    item.checks = hc.checks;
    if (!hc.ok) continue;
    picks.push(item);
    if (picks.length === 3) break;
  }
  return picks;
}

// ─────────────────────────── density over the whole timeline ───────────────────────────

/**
 * Keep the graphics the timeline can carry: highest priority first, each accepted only if it breaks no rule —
 * majors ≥ majorGapSec apart, the same template not again within repeatSec, total coverage ≤ maxCoverage of the
 * runtime, and calmAfterPeakSec of nothing after an energy-5 graphic. Overlapping graphics are not stacked.
 * items: [{ template, atUs, durUs, major, energy, score, alternatives? }] — a pick that breaks a rule is replaced by
 * the first of its alternatives that does not. Returns { kept, dropped: [{ item, why }], coverage }.
 */
export function densityGuard(items, totalUs, rules = DENSITY) {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => (b.it.score ?? 0) - (a.it.score ?? 0) || (b.it.energy ?? 0) - (a.it.energy ?? 0) || a.i - b.i);
  const kept = [], dropped = [];
  const covered = () => unionLength(kept.map((k) => [k.atUs, k.atUs + k.durUs]));
  for (const { it: first } of order) {
    // A pick that breaks a rule gives way to the next alternative of its moment (the ranker's 2nd and 3rd).
    let why = null, it = first;
    for (const cand of [first, ...(first.alternatives || [])]) {
      it = cand;
      why = breaks(cand);
      if (!why) break;
    }
    if (why) dropped.push({ item: first, why }); else kept.push(it);
  }
  function breaks(it) {
    const s = it.atUs, e = it.atUs + it.durUs;
    let why = null;
    for (const k of kept) {
      const ks = k.atUs, ke = k.atUs + k.durUs;
      if (s < ke && e > ks && !(isPersistent(k) || isPersistent(it))) { why = `overlaps ${k.template}`; break; }
      if (it.major && k.major && Math.abs(s - ks) < rules.majorGapSec * US) { why = `major graphic ${(Math.abs(s - ks) / US).toFixed(1)} s from ${k.template} (min ${rules.majorGapSec} s)`; break; }
      if (k.template === it.template && Math.abs(s - ks) < rules.repeatSec * US) { why = `same graphic again within ${rules.repeatSec} s`; break; }
      if ((k.energy ?? 0) >= 5 && s >= ke && s - ke < rules.calmAfterPeakSec * US) { why = `no breath after the peak at ${(ks / US).toFixed(1)} s`; break; }
      if ((it.energy ?? 0) >= 5 && ks >= e && ks - e < rules.calmAfterPeakSec * US) { why = `${k.template} right after this peak`; break; }
    }
    if (!why && totalUs > 0 && (covered() + (e - s) - overlapWith(kept, s, e)) / totalUs > rules.maxCoverage) why = `coverage would pass ${Math.round(rules.maxCoverage * 100)} %`;
    return why;
  }
  kept.sort((a, b) => a.atUs - b.atUs);
  return { kept, dropped, coverage: totalUs > 0 ? unionLength(kept.map((k) => [k.atUs, k.atUs + k.durUs])) / totalUs : 0 };
}
const isPersistent = (it) => ["progress-hud", "corner-hud", "timer-hud"].includes(it.template);
function unionLength(spans) {
  const s = spans.slice().sort((a, b) => a[0] - b[0]);
  let total = 0, cs = -Infinity, ce = -Infinity;
  for (const [a, b] of s) { if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); }
  if (ce > cs) total += ce - cs;
  return total;
}
const overlapWith = (kept, s, e) => unionLength(kept.map((k) => [Math.max(s, k.atUs), Math.min(e, k.atUs + k.durUs)]).filter(([a, b]) => b > a));

/** Is the plan within the density rules? (for tests and the cut sheet) → { ok, majorsPerMinute, coverage, issues } */
export function densityReport(items, totalUs, rules = DENSITY) {
  const majors = items.filter((i) => i.major).sort((a, b) => a.atUs - b.atUs);
  const issues = [];
  for (let i = 1; i < majors.length; i++) if (majors[i].atUs - majors[i - 1].atUs < rules.majorGapSec * US) issues.push(`majors ${majors[i - 1].template}→${majors[i].template} ${((majors[i].atUs - majors[i - 1].atUs) / US).toFixed(1)} s apart`);
  const coverage = totalUs ? unionLength(items.map((k) => [k.atUs, k.atUs + k.durUs])) / totalUs : 0;
  if (coverage > rules.maxCoverage + 1e-9) issues.push(`coverage ${(coverage * 100).toFixed(0)} %`);
  return { ok: !issues.length, majorsPerMinute: totalUs ? majors.length / (totalUs / 60 / US) : 0, coverage, issues };
}

// ─────────────────────────── the whole plan ───────────────────────────

/**
 * Graphics for a whole talk: needs of every sentence → top 3 per need → the best of each (alternatives kept for the
 * cut sheet) → density guard. Returns { items, alternatives: { needIndex: [picks] }, dropped, needs, coverage }.
 * opts: { width, height, fps, platforms, faces, ranker, ctx (pictures, frames, focus), keywords, names, totalUs, pack }
 */
export async function planGraphics(words, opts = {}) {
  const fctx = frameCtx(opts);
  const needs = sentenceNeeds(words, { keywords: opts.keywords, names: opts.names });
  const totalUs = opts.totalUs ?? (words.length ? words[words.length - 1].endUs : 0);
  needs.forEach((n, i) => { n.roomUs = (needs[i + 1]?.startUs ?? totalUs) - n.startUs; });
  const alternatives = {}, firsts = [], recent = [];
  for (const need of needs) {
    if (!need.tags.length) continue;
    const picks = await rankNeed(need, words, { ranker: opts.ranker, fctx, ctx: opts.ctx || {}, recent, pack: opts.pack });
    if (!picks.length) continue;
    alternatives[need.i] = picks;
    firsts.push({ ...picks[0], alternatives: picks.slice(1) });
    recent.push(picks[0].template);
  }
  const { kept, dropped, coverage } = densityGuard(firsts, totalUs);
  return { items: kept.map(({ alternatives: _, ...it }) => it), alternatives, dropped, needs, coverage };
}

export { intersect, inside, grow };
