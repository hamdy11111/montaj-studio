// Quality guards for an edit plan (from the edit-hamdy skill's preflight checks): the speech is intact (no cut inside
// a word, no word lost without a reason), a reason to keep watching at least every 6 s, the hook and the ending,
// zooms that never crop the head, emoji and sound-effect limits, and no on-screen word shown before it is said —
// plus the pacing numbers (cuts per minute, shot lengths) against the style's reference. Pure; times in µs.
import { POLICY } from "./policy.js";
import { GRAPHIC_TEMPLATES } from "./graphics.js";
import { normAr } from "./moments.js";
import { US } from "./util.js";

const S = (s) => Math.round(s * US);

/** Edit time of a source time once `cuts` ([{fromUs,toUs}] sorted) are removed; null when it is cut. */
export function editTime(cuts, src) {
  let removed = 0;
  for (const c of cuts) { if (c.toUs <= src) removed += c.toUs - c.fromUs; else if (c.fromUs < src) return null; }
  return src - removed;
}
/** Edit time of a source time; inside a cut: the cut point. */
export function editAt(cuts, src) {
  let removed = 0;
  for (const c of cuts) { if (c.toUs <= src) removed += c.toUs - c.fromUs; else if (c.fromUs < src) return c.fromUs - removed; }
  return src - removed;
}
/** The source time reached after `editUs` of EDIT time from source `fromUs` (the cuts in between are skipped). */
export function srcAfter(cuts, fromUs, editUs, maxUs = Infinity) {
  let t = fromUs, left = editUs;
  for (const c of cuts) {
    if (c.toUs <= t) continue;
    if (c.fromUs > t) { const span = c.fromUs - t; if (span >= left) return Math.min(maxUs, t + left); left -= span; }
    t = Math.max(t, c.toUs);
  }
  return Math.min(maxUs, t + left);
}

/**
 * The head box over a source span from the person track ([t, x0, y0, x1, y1, hx, hy, hw, hh, area]): the union of
 * the head boxes in it (top/bottom/left/right as fractions of the frame), or null. The model's "face skin" class runs
 * down the neck, so the chin is placed at most 1.2 head widths below the top of the hair (a head is about 1.2× as
 * tall as it is wide); `aspect` = the video's width / height, to measure that width in frame heights.
 */
export function headBox(track, a, b, aspect = 1) {
  const fs = (track || []).filter((f) => f[0] >= a && f[0] <= b && f[7] > 0 && f[8] > 0);
  if (!fs.length) return null;
  const chin = (f) => Math.min(f[6] + f[8] / 2, f[6] - f[8] / 2 + 1.2 * f[7] * aspect);
  return { top: Math.min(...fs.map((f) => f[6] - f[8] / 2)), bottom: Math.max(...fs.map(chin)),
    left: Math.min(...fs.map((f) => f[5] - f[7] / 2)), right: Math.max(...fs.map((f) => f[5] + f[7] / 2)),
    cx: fs.reduce((n, f) => n + f[5], 0) / fs.length, cy: fs.reduce((n, f) => n + f[6], 0) / fs.length };
}

/**
 * Frame a zoom `z` around the head so it is never cropped: the top of the hair inside the window, 5 % of the head's
 * height below the chin, 6 % of the window at the sides (the skill's reframe constraints). The head stays where it was when it can (hides the jump cut); when no
 * offset fits, the zoom is reduced. Offsets as the plan's zooms: fractions of the canvas. `fit` = the share of the
 * canvas the video fills on each axis ({ dx, dy }, 1 = edge to edge): an axis the zoomed video does not overflow is
 * never cropped. Returns { scale, x, y }.
 */
export function fitHead(z, box, fit = {}, F = POLICY.face) {
  const round = (v) => Math.round(v * 1000) / 1000;
  if (!box) return { scale: z };
  const dx = fit.dx || 1, dy = fit.dy || 1;
  const axis = (s, d, lo, hi, c, mLo, mHi) => {
    const e = d * s;
    if (e <= 1) return [0, 0, 0];
    const lim = (e - 1) / 2;
    return [Math.max(-lim, e * (0.5 - lo) + mLo - 0.5), Math.min(lim, 0.5 - mHi - e * (hi - 0.5)), -(c - 0.5) * d * (s - 1)];
  };
  for (let s = z; s >= 1.02 - 1e-9; s = Math.round((s - 0.02) * 1000) / 1000) { // ×1.02 is the least zoom a plan takes
    const [yMin, yMax, y0] = axis(s, dy, box.top, box.bottom + F.chin * (box.bottom - box.top), box.cy, F.top, 0);
    const [xMin, xMax, x0] = axis(s, dx, box.left, box.right, box.cx, F.side, F.side);
    if (yMin > yMax + 1e-9 || xMin > xMax + 1e-9) continue;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return { scale: s, x: round(clamp(x0, xMin, xMax)), y: round(clamp(y0, yMin, yMax)) };
  }
  return { scale: 1 };
}
/** Does a framed zoom keep the head inside its margins? */
export function headInside(z, box, fit = {}, F = POLICY.face, tol = 0.004) {
  if (!box || !(z.scale > 1)) return true;
  const ok = (d, off, lo, hi, mLo, mHi) => {
    const e = d * z.scale;
    if (e <= 1) return true;
    const a = 0.5 - (0.5 + off) / e, b = 0.5 + (0.5 - off) / e;
    return lo - a >= mLo / e - tol && b - hi >= mHi / e - tol;
  };
  return ok(fit.dy || 1, z.y || 0, box.top, box.bottom + F.chin * (box.bottom - box.top), F.top, 0) && ok(fit.dx || 1, z.x || 0, box.left, box.right, F.side, F.side);
}

/** Sound events of a plan in edit time: [{ t, what }] — its sfx and the sounds graphics bring on their motion. */
export function soundEvents(plan, cuts) {
  const ev = [];
  for (const x of plan.sfx || []) ev.push({ t: editAt(cuts, x.atUs), what: `sfx ${x.sound}` });
  for (const g of plan.graphics || []) {
    const tpl = GRAPHIC_TEMPLATES[g.template];
    if (!g.sfx || !tpl?.sfx) continue;
    const a = editAt(cuts, g.fromUs), b = editAt(cuts, g.toUs);
    if (tpl.sfx.in) ev.push({ t: a, what: `${g.template} in` });
    if (tpl.sfx.each) for (const ms of (g.params?.times || []).slice(1)) ev.push({ t: a + ms * 1000, what: `${g.template} word` });
    if (tpl.sfx.out) ev.push({ t: Math.max(a, b - (tpl.outUs || 0)), what: `${g.template} out` });
  }
  return ev.sort((p, q) => p.t - q.t);
}

const QUESTION_START = /^(ليه|ازاي|إزاي|هل|مين|ايه|إيه|فين|امتى|إمتى|كام|تفتكر)$/;
/** Edit times that give a reason to keep watching (the skill's retention reasons). */
export function reasonsToWatch(plan, { words, cuts, numbers = [] }) {
  const R = [];
  for (const g of plan.graphics || []) if (g.template !== "progress-bar") R.push({ t: editAt(cuts, g.fromUs), why: g.template });
  const zs = [...(plan.zooms || [])].sort((a, b) => a.fromUs - b.fromUs);
  // A punch-in counts; an angle change counts when the framing changes by 0.2 or more (a jump cut at the same angle
  // does not). Between zoom spans the picture is at ×1.
  let prev = 1, prevEnd = -1;
  for (const z of zs) {
    if (prevEnd >= 0 && z.fromUs > prevEnd + 1000) {
      if (Math.abs(prev - 1) >= POLICY.retention.angleDelta) R.push({ t: editAt(cuts, prevEnd), why: "angle" });
      prev = 1;
    }
    if (/^punch/.test(z.reason || "")) R.push({ t: editAt(cuts, z.fromUs), why: "punch" });
    else if (Math.abs(z.scale - prev) >= POLICY.retention.angleDelta) R.push({ t: editAt(cuts, z.fromUs), why: "angle" });
    prev = z.scale; prevEnd = z.toUs;
  }
  for (const x of plan.transitions || []) R.push({ t: editAt(cuts, x.atUs), why: "transition" });
  words.forEach((w, i) => {
    const t = editTime(cuts, w.startUs);
    if (t === null) return;
    const first = i === 0 || /[.!?؟…]$/.test(words[i - 1].text);
    if (/[?؟]/.test(w.text) || (first && QUESTION_START.test(normAr(w.text)))) R.push({ t, why: "question" });
    if (/[0-9٠-٩]/.test(w.text)) R.push({ t, why: "number" });
  });
  for (const x of numbers) { const t = editTime(cuts, x.s); if (t !== null) R.push({ t, why: "number" }); }
  return R.sort((a, b) => a.t - b.t);
}
/** Spans longer than maxDead with no reason to keep watching: [[a, b]] in edit time. */
export function deadSpans(reasons, totalUs) {
  const ts = [0, ...reasons.map((r) => r.t).filter((t) => t >= 0 && t <= totalUs), totalUs].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > S(POLICY.retention.maxDead)) out.push([ts[i - 1], ts[i]]);
  return out;
}

const stripPrefix = (w) => normAr(w).replace(/^(وال|فال|بال|لل|ال)(?=.{2,})/, "");
const sameWord = (a, b) => { const x = stripPrefix(a), y = stripPrefix(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))); };

/**
 * All guards on a plan. ctx: { words (all, source time), removed (Map of removed word indices), durationUs, track,
 * style, numbers, fit: { dx, dy } }. Returns { checks: [{ id, level: "fail"|"warn", message, atUs? }], passed: [ids], stats }.
 */
export function qaPlan(plan, { words = [], removed = new Map(), durationUs, track = [], style = "energetic", numbers = [], fit = {} } = {}) {
  const P = POLICY, checks = [], passed = [];
  // message: English (agents); args: the values, for the app to say it in its own language (qa.<id>).
  const sec = (us) => Math.round(us / 1e5) / 10;
  const add = (id, level, message, atUs, args = {}) => checks.push({ id, level, message, args, ...(atUs !== undefined ? { atUs: Math.round(atUs) } : {}) });
  const cuts = [...(plan.cuts || [])].sort((a, b) => a.fromUs - b.fromUs);
  const total = editAt(cuts, durationUs);
  const fmt = (us) => `${(us / US).toFixed(1)} s`;
  const pass = (id, ok) => { if (ok) passed.push(id); };

  // 1. Speech intact.
  const kept = words.map((w, i) => ({ w, i })).filter((x) => !removed.has(x.i));
  const inside = kept.filter(({ w }) => cuts.some((c) => c.fromUs < w.endUs - S(0.03) && c.toUs > w.startUs + S(0.03) && !(c.fromUs <= (w.startUs + w.endUs) / 2 && c.toUs >= (w.startUs + w.endUs) / 2)));
  for (const { w } of inside) add("speech.cutInsideWord", "fail", `a cut inside the word «${w.text}»`, w.startUs, { word: w.text, at: sec(w.startUs) });
  pass("speech.cutInsideWord", !inside.length);
  const lost = kept.filter(({ w }) => cuts.some((c) => c.fromUs <= (w.startUs + w.endUs) / 2 && c.toUs >= (w.startUs + w.endUs) / 2));
  for (const { w } of lost) add("speech.lostWord", "fail", `the word «${w.text}» is cut out with no reason`, w.startUs, { word: w.text, at: sec(w.startUs) });
  pass("speech.lostWord", !lost.length);

  // 2. A reason to keep watching at least every 6 s.
  const dead = deadSpans(reasonsToWatch(plan, { words: kept.map((x) => x.w), cuts, numbers }), total);
  for (const [a, b] of dead) add("retention.dead", "fail", `${fmt(b - a)} with nothing new on screen (${fmt(a)}–${fmt(b)} of the edit)`, undefined, { len: sec(b - a), from: sec(a), to: sec(b) });
  pass("retention.dead", !dead.length);

  // 3. Hook and ending.
  const firstWord = kept.map((x) => editTime(cuts, x.w.startUs)).filter((t) => t !== null)[0];
  if (firstWord === undefined || firstWord > S(P.hook.firstCaption)) add("hook.firstWords", "warn", `the first words start at ${fmt(firstWord ?? total)} (they should start within ${P.hook.firstCaption} s)`, undefined, { at: sec(firstWord ?? total), max: P.hook.firstCaption });
  else passed.push("hook.firstWords");
  const endFrom = total - S(P.ending.strike);
  const strike = (plan.graphics || []).some((g) => g.template !== "progress-bar" && editAt(cuts, g.toUs) >= endFrom)
    || (plan.sfx || []).some((x) => editAt(cuts, x.atUs) >= endFrom) || (plan.zooms || []).some((z) => editAt(cuts, z.toUs) >= endFrom && /^punch/.test(z.reason || ""))
    || kept.some(({ w }) => /[?؟]/.test(w.text) && (editTime(cuts, w.startUs) ?? -1) >= total - S(P.ending.question));
  if (!strike) add("ending.strike", "warn", "the last 2 s have no strike (an element, a sound, a punch-in or a question): the video may just stop", undefined, { sec: P.ending.strike });
  else passed.push("ending.strike");

  // 4. Zooms: no overlap, punches spaced, the head never cropped.
  const zs = [...(plan.zooms || [])].sort((a, b) => a.fromUs - b.fromUs);
  let zoomOk = true;
  for (let i = 1; i < zs.length; i++) if (zs[i].fromUs < zs[i - 1].toUs - 1000) { zoomOk = false; add("zoom.overlap", "fail", `two zooms overlap at ${fmt(zs[i].fromUs)}`, zs[i].fromUs, { at: sec(editAt(cuts, zs[i].fromUs)) }); }
  pass("zoom.overlap", zoomOk);
  const punches = zs.filter((z) => /^punch/.test(z.reason || "")).map((z) => editAt(cuts, z.fromUs));
  const close = punches.filter((t, i) => i && t - punches[i - 1] < S(P.zoom.punchGap));
  for (const t of close) add("zoom.punchGap", "warn", `two punch-ins within ${P.zoom.punchGap} s (at ${fmt(t)} of the edit)`, undefined, { gap: P.zoom.punchGap, at: sec(t) });
  pass("zoom.punchGap", !close.length);
  let headOk = true;
  for (const z of zs) {
    const box = headBox(track, z.fromUs, z.toUs, fit.aspect || 1);
    if (box && !headInside(z, box, fit)) { headOk = false; add("face.cropped", "fail", `a ×${z.scale} zoom at ${fmt(z.fromUs)} cuts into the head's margins`, z.fromUs, { scale: z.scale, at: sec(editAt(cuts, z.fromUs)) }); }
  }
  pass("face.cropped", headOk);

  // 5. Emoji.
  const emo = (plan.graphics || []).filter((g) => g.template === "head-emoji" || g.template === "emoji").map((g) => ({ t: editAt(cuts, g.fromUs), e: g.params?.emoji })).sort((a, b) => a.t - b.t);
  const cap = Math.max(1, Math.floor((P.emoji.perMin * total) / (60 * US)));
  let emoOk = true;
  if (total > S(20) && emo.length > cap) { emoOk = false; add("emoji.count", "fail", `${emo.length} emoji for ${fmt(total)} (at most ${cap})`, undefined, { n: emo.length, total: sec(total), cap }); }
  emo.forEach((x, i) => {
    if (i && x.t - emo[i - 1].t < S(P.emoji.minGap)) { emoOk = false; add("emoji.gap", "fail", `two emoji within ${P.emoji.minGap} s (at ${fmt(x.t)})`, undefined, { gap: P.emoji.minGap, at: sec(x.t) }); }
    if (emo.some((y, j) => j < i && y.e === x.e && x.t - y.t < S(P.emoji.sameWindow))) { emoOk = false; add("emoji.repeat", "fail", `the same emoji twice within ${P.emoji.sameWindow} s (${x.e} at ${fmt(x.t)})`, undefined, { win: P.emoji.sameWindow, emoji: x.e, at: sec(x.t) }); }
  });
  pass("emoji", emoOk);

  // 6. Sound effects: one event at least every 1 s (sounds 0.08 s apart are one layered event), ≤ 20 per minute.
  const ev = soundEvents(plan, cuts);
  const events = [];
  for (const e of ev) { const last = events[events.length - 1]; if (last && e.t - last.t <= S(P.sfx.layered)) last.what += ` + ${e.what}`; else events.push({ ...e }); }
  let sfxOk = true;
  events.forEach((e, i) => { if (i && e.t - events[i - 1].t < S(P.sfx.minGap)) { sfxOk = false; add("sfx.gap", "fail", `two sound effects ${fmt(e.t - events[i - 1].t)} apart at ${fmt(e.t)} (${events[i - 1].what} / ${e.what})`, undefined, { gap: sec(e.t - events[i - 1].t), at: sec(e.t) }); } });
  const perMin = events.length / Math.max(1, total / (60 * US));
  if (perMin > P.sfx.perMin) { sfxOk = false; add("sfx.count", "fail", `${perMin.toFixed(1)} sound effects per minute (at most ${P.sfx.perMin})`, undefined, { perMin: Math.round(perMin * 10) / 10, max: P.sfx.perMin }); }
  pass("sfx", sfxOk);

  // 7. Sync: no written word appears before it is said (and is then said within 6 s).
  let syncOk = true;
  const spoken = kept.map(({ w }) => ({ t: editTime(cuts, w.startUs), text: w.text })).filter((x) => x.t !== null);
  for (const g of plan.graphics || []) {
    const shown = [g.params?.text, ...(g.params?.words || [])].filter((x) => typeof x === "string").flatMap((x) => x.split(/\s+/)).filter((x) => normAr(x).length >= 2);
    const at = editAt(cuts, g.fromUs);
    for (const word of shown) {
      const said = spoken.find((x) => x.t >= at - S(P.sync.spoil) && sameWord(x.text, word) && x.t <= at + S(P.sync.spoil));
      if (said && said.t > at + S(P.sync.tol) && g.template !== "word-stack") { syncOk = false; add("sync.early", "fail", `«${word}» appears ${fmt(said.t - at)} before it is said (${g.template})`, g.fromUs, { word, early: sec(said.t - at), template: g.template, at: sec(at) }); }
    }
  }
  pass("sync.early", syncOk);

  // 8. Text graphics never share the screen (the skill's text-collision guard).
  const TEXTS = new Set(["emerge-side", "rise-behind", "word-stack", "counter", "list-item", "pass-behind", "big-word", "title-reveal"]);
  const texts = (plan.graphics || []).filter((g) => TEXTS.has(g.template)).map((g) => ({ g, a: editAt(cuts, g.fromUs), b: editAt(cuts, Math.min(durationUs, g.toUs)) })).sort((x, y) => x.a - y.a);
  let textOk = true;
  texts.forEach((x, i) => { const prev = texts.slice(0, i).find((y) => x.a < y.b - 20_000); if (prev) { textOk = false; add("text.overlap", "fail", `${x.g.template} at ${fmt(x.a)} appears while ${prev.g.template} is still on screen`, x.g.fromUs, { template: x.g.template, other: prev.g.template, at: sec(x.a) }); } });
  pass("text.overlap", textOk);

  // Stats.
  const shots = [];
  let s0 = 0;
  for (const c of cuts) { if (c.fromUs > s0) shots.push(c.fromUs - s0); s0 = Math.max(s0, c.toUs); }
  if (durationUs > s0) shots.push(durationUs - s0);
  const sorted = shots.filter((x) => x > 0).sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] / US : 0);
  const mins = Math.max(1 / 60, total / (60 * US));
  const stats = {
    editUs: total, cutsPerMin: Math.round(((cuts.length) / mins) * 10) / 10, medianShot: Math.round(q(0.5) * 100) / 100, p90Shot: Math.round(q(0.9) * 100) / 100,
    longestShot: Math.round(q(1) * 100) / 100, elementsPerMin: Math.round(((plan.graphics || []).filter((g) => g.template !== "progress-bar").length / mins) * 10) / 10,
    sfxPerMin: Math.round(perMin * 10) / 10, emoji: emo.length,
  };
  const ref = P.cutsPerMin[style];
  if (ref && (stats.cutsPerMin < ref[0] * 0.7 || stats.cutsPerMin > ref[1] * 1.3)) add("pace.cutsPerMin", "warn", `${stats.cutsPerMin} cuts per minute (the style's reference: ${ref[0]}–${ref[1]})`, undefined, { cpm: stats.cutsPerMin, lo: ref[0], hi: ref[1] });
  else passed.push("pace.cutsPerMin");
  return { checks, passed, stats, ok: !checks.some((c) => c.level === "fail") };
}
