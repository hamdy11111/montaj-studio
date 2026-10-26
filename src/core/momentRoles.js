// Moment roles (Phase 6 of PLAN_editor_and_graphics.md, item 9 step 2: «تمهيد · تصاعد · ضربة · رد فعل · حشو»): the
// media cut into moments — what is said (one per utterance), the reactions heard outside speech, the moments the
// vision check placed, and the stretches in between (≤ 6 s each) — and every moment given one role:
//
//   setup     the premise: the promise or the stakes («لو عملتها هاخد…»), the lines that lead to a punch, and plain
//             information (an explainer's sentences are its setup — weak confidence)
//   build_up  what raises the tension between the setup and the punch (the game being played, loud overlapping talk)
//   punch     the cause of a reaction: the punchline, the reveal, the fall, the goal
//   reaction  the laugh, the scream, the cheer, the hush — and an exclamation said in reply
//   filler    nothing happens: a lone word with no weight, a calm stretch with no event
//
// Rules on top of the cause ↔ reaction links (causeLinks.js); the director's model may override them (each moment
// keeps `why` and a confidence). Pure; times in seconds of the media.
import { normAr } from "./moments.js";
import { STRETCHED_FILLER } from "./speech.js";

export const ROLES = Object.freeze(["setup", "build_up", "punch", "reaction", "filler"]);
export const ROLE_AR = Object.freeze({ setup: "تمهيد", build_up: "تصاعد", punch: "ضربة", reaction: "رد فعل", filler: "حشو" });

const r3 = (x) => Math.round(x * 1000) / 1000;
const overlapS = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const byType = (tl, ...types) => (tl.events || []).filter((e) => types.includes(e.type));
const FILLER_WORDS = new Set(["يعني", "امم", "اه", "ايوه", "طب", "بص", "خلاص", "ماشي", "اوكي", "ok", "طيب", "يلا"].map(normAr));

/** Vision energy (1–5) over a span: the shot-log windows that overlap it, weighted by overlap; null when none. */
function energyOf(tl, t0, t1) {
  let s = 0, w = 0;
  for (const e of byType(tl, "shot_log")) { const o = overlapS(t0, t1, e.t0, e.t1); if (o > 0 && Number.isFinite(e.extra?.energy)) { s += o * e.extra.energy; w += o; } }
  return w ? Math.round((s / w) * 10) / 10 : null;
}

/** Busy sound in a span: loudness bursts and overlapping voices (a game in full swing). */
const busyness = (tl, t0, t1) => byType(tl, "loudness_spike", "overlap").filter((e) => overlapS(t0, t1, e.t0, e.t1) > 0).length;

/**
 * The moments: utterances, reactions outside speech, vision-placed causes, and the gaps between (≤ maxGapS each).
 * Overlaps are trimmed in favour of the earlier moment. [{id, t0, t1, kind, text, speaker}].
 */
export function momentUnits(tl, doc, { maxGapS = 6, minS = 0.2 } = {}) {
  const dur = tl.media?.duration || doc?.media?.duration || Math.max(0, ...(tl.events || []).map((e) => e.t1));
  const utt = byType(tl, "utterance");
  const inSpeech = (a, b) => { let s = 0; for (const u of utt) s += overlapS(a, b, u.t0, u.t1); return b > a ? s / (b - a) : 1; };
  const anchors = [
    ...utt.map((u) => ({ t0: u.t0, t1: u.t1, kind: "speech", text: u.text, speaker: u.speaker })),
    ...(doc?.reactions || []).filter((r) => inSpeech(r.t0, r.t1) < 0.5).map((r) => ({ t0: r.t0, t1: r.t1, kind: "reaction", text: r.kinds.join("+"), speaker: r.speakers[0] || null })),
    ...(doc?.causes || []).filter((c) => c.placedBy && inSpeech(c.t0, c.t1) < 0.5).map((c) => ({ t0: c.t0, t1: c.t1, kind: "action", text: c.text, speaker: null })),
  ].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const units = [];
  for (const a of anchors) {
    const last = units[units.length - 1];
    const u = { ...a };
    if (last && u.t0 < last.t1) u.t0 = last.t1;
    if (u.t1 - u.t0 >= minS) units.push(u);
  }
  const out = [];
  let t = 0;
  const gap = (a, b) => {
    const n = Math.max(1, Math.ceil((b - a) / maxGapS));
    for (let k = 0; k < n; k++) out.push({ t0: a + (b - a) * k / n, t1: a + (b - a) * (k + 1) / n, kind: "gap", text: null, speaker: null });
  };
  for (const u of units) { if (u.t0 - t >= 0.4) gap(t, u.t0); out.push(u); t = Math.max(t, u.t1); }
  if (dur - t >= 0.4) gap(t, dur);
  out.forEach((m, i) => { m.id = `M${String(i + 1).padStart(3, "0")}`; m.t0 = r3(m.t0); m.t1 = r3(m.t1); });
  return out;
}

/**
 * Roles for the moments, from the links document (best links from `minLink` confidence, «مش متأكد» ones included
 * at their own weight). Returns the moments with {role, role_ar, roleConfidence, why, links, energy}.
 */
export function assignRoles(tl, doc, { minLink = 0.25, setupBackS = 12, maxActionS = 6, units = momentUnits(tl, doc) } = {}) {
  const R = new Map((doc?.reactions || []).map((r) => [r.id, r])), C = new Map((doc?.causes || []).map((c) => [c.id, c]));
  const best = (doc?.links || []).filter((l) => l.best && l.confidence >= minLink && R.get(l.reaction)?.verified?.real !== false);
  const sceneOf = (t) => (doc?.scenes || []).find((s) => t >= s.t0 && t < s.t1) || null;
  const M = units.map((m) => ({ ...m, role: null, roleConfidence: 0, why: "", links: [], energy: energyOf(tl, m.t0, m.t1) }));
  const set = (m, role, conf, why, link = null) => {
    if (link && !m.links.includes(link)) m.links.push(link);
    if (m.role && m.roleConfidence >= conf) return;
    m.role = role; m.roleConfidence = Math.round(conf * 100) / 100; m.why = why;
  };
  const touches = (m, a, b) => { const o = overlapS(m.t0, m.t1, a, b); return o > 0 && (o >= 0.5 * (m.t1 - m.t0) || o >= 0.5 * (b - a)); };

  // Punches and reactions first, from the links (a cause that is a promise is the setup, not the punch).
  for (const l of best) {
    const r = R.get(l.reaction), c0 = C.get(l.cause);
    if (!r || !c0) continue;
    // A long vision window (12 s) is not the punch itself: only its last seconds before the reaction are.
    const c = c0.kind === "action" && c0.t1 - c0.t0 > maxActionS
      ? { ...c0, t0: Math.max(c0.t0, Math.min(c0.t1, r.t0) - maxActionS / 2), t1: Math.min(c0.t1, Math.max(r.t0, c0.t0 + maxActionS / 2)) } : c0;
    for (const m of M) {
      if (touches(m, c.t0, c.t1) && m.kind !== "reaction") {
        if (c.kind === "promise") set(m, "setup", Math.max(0.4, l.confidence), `the promise / stakes of ${l.id}`, l.id);
        else set(m, "punch", Math.max(0.3, l.confidence), `cause of ${r.kind} ${r.id} (${l.label_ar})`, l.id);
      }
    }
    for (const m of M) {
      if (!touches(m, r.t0, r.t1)) continue;
      if (m.kind === "reaction" || (m.kind === "speech" && r.kinds.includes("verbal")) || m.kind === "gap") set(m, "reaction", Math.max(0.3, Math.min(r.strength, l.confidence + 0.2)), `${r.kinds.join("+")} after ${l.cause}`, l.id);
    }
  }
  // Reactions nobody could link are still reactions.
  for (const m of M) if (!m.role && m.kind === "reaction") set(m, "reaction", 0.35, "a reaction with no linked cause");

  // Setup: the lines just before a punch in the same scene; build-up: between the setup (or a promise) and the punch.
  for (const p of M.filter((m) => m.role === "punch")) {
    const sc = sceneOf(p.t0);
    const before = M.filter((m) => m.t1 <= p.t0 + 0.05 && m.t0 >= p.t0 - setupBackS && (!sc || sceneOf(m.t0) === sc));
    const speech = before.filter((m) => !m.role && m.kind === "speech").slice(-2);
    for (const m of speech) set(m, "setup", 0.5, `leads to the punch ${p.id}`);
    const setups = M.filter((m) => m.role === "setup" && m.t1 <= p.t0 + 0.05 && (!sc || sceneOf(m.t0) === sc));
    const from = setups.length ? setups[setups.length - 1].t1 : before.length ? before[0].t0 : p.t0;
    for (const m of M) if (!m.role && m.t0 >= from - 0.05 && m.t1 <= p.t0 + 0.05 && (!sc || sceneOf(m.t0) === sc)) set(m, "build_up", 0.45, `between the setup and the punch ${p.id}`);
  }

  // The rest by what it holds.
  for (const m of M) {
    if (m.role) continue;
    const words = String(m.text || "").split(/\s+/).filter(Boolean);
    const busy = busyness(tl, m.t0, m.t1);
    if (m.kind === "speech") {
      const lone = words.length <= 2 && words.every((w) => FILLER_WORDS.has(normAr(w)) || STRETCHED_FILLER.test(w));
      if (lone || words.length === 0) set(m, "filler", 0.6, "a filler word");
      else if (words.length <= 2) set(m, "filler", 0.35, "a word or two with no link");
      else if ((m.energy ?? 0) >= 4 || busy >= 2) set(m, "build_up", 0.35, "lively talk with no linked reaction");
      else set(m, "setup", 0.35, "information (no linked punch)");
    } else if ((m.energy ?? 0) >= 4 || busy >= 2) set(m, "build_up", 0.35, `lively stretch (energy ${m.energy ?? "?"}, ${busy} bursts)`);
    else set(m, "filler", (m.energy ?? 3) <= 2 && !busy ? 0.6 : 0.4, `calm stretch (energy ${m.energy ?? "?"})`);
  }
  return M.map((m) => ({ id: m.id, t0: m.t0, t1: m.t1, kind: m.kind, text: m.text, speaker: m.speaker, role: m.role, role_ar: ROLE_AR[m.role], roleConfidence: m.roleConfidence, why: m.why, links: m.links, energy: m.energy }));
}

/** Seconds per role (for the summary). */
export function roleShares(moments) {
  const out = Object.fromEntries(ROLES.map((r) => [r, 0]));
  for (const m of moments) out[m.role] = r3(out[m.role] + (m.t1 - m.t0));
  return out;
}
