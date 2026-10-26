// Limits on sound effects, as rules the director calls before placing sounds (and the checker calls after):
//   - no cartoon/meme or comic sounds in a serious, sad or emotional moment (a dramatic sting is fine there);
//   - at most `comicPerMin` comic sounds in any 60 s, and at least `comicMinGapS` between two of them;
//   - any two sounds at least `anyMinGapS` apart (sounds within `layeredS` are one layered event), at most
//     `anyPerMin` a minute — the same numbers as the director's policy (src/core/policy.js → POLICY.sfx).
// Pure functions over plain objects: events are { atUs, sound: { id, cartoon, comic }, priority? }, moments are
// { startUs, endUs, mood } with mood one of MOODS.
import { US } from "../../core/util.js";

export const SFX_RULES = { comicPerMin: 3, comicMinGapS: 8, anyMinGapS: 1.0, layeredS: 0.08, anyPerMin: 20 };
export const MOODS = ["comic", "joy", "shock", "neutral", "tense", "serious", "sad", "emotional", "religious"];
/** Moments where a cartoon or comic sound would mock the speaker. */
export const SERIOUS_MOODS = new Set(["serious", "sad", "emotional", "religious", "tense"]);

/** The mood at a time (the last moment that covers it wins), "neutral" when none does. */
export function moodAt(moments = [], tUs) {
  let mood = "neutral";
  for (const m of moments) if (tUs >= m.startUs && tUs < m.endUs) mood = m.mood || "neutral";
  return mood;
}

/** Whether one sound may play in a moment of this mood: { ok, reason }. */
export function soundAllowed(sound, mood) {
  if (SERIOUS_MOODS.has(mood) && sound?.cartoon) return { ok: false, reason: "cartoon-in-serious" };
  if (SERIOUS_MOODS.has(mood) && sound?.comic) return { ok: false, reason: "comic-in-serious" };
  return { ok: true, reason: null };
}

/** Every broken rule of a sound plan: [{ index, atUs, rule }]. */
export function checkSfxPlan(events, { moments = [], rules = SFX_RULES } = {}) {
  const ev = events.map((e, index) => ({ ...e, index })).sort((a, b) => a.atUs - b.atUs);
  const out = [];
  const comic = ev.filter((e) => e.sound?.comic || e.sound?.cartoon);
  for (const e of ev) {
    const a = soundAllowed(e.sound, moodAt(moments, e.atUs));
    if (!a.ok) out.push({ index: e.index, atUs: e.atUs, rule: a.reason });
  }
  for (let i = 1; i < comic.length; i++) {
    if (comic[i].atUs - comic[i - 1].atUs < rules.comicMinGapS * US) out.push({ index: comic[i].index, atUs: comic[i].atUs, rule: "comic-too-close" });
  }
  for (let i = 0; i < comic.length; i++) {
    const n = comic.filter((c) => c.atUs > comic[i].atUs - 60 * US && c.atUs <= comic[i].atUs).length;
    if (n > rules.comicPerMin) out.push({ index: comic[i].index, atUs: comic[i].atUs, rule: "comic-per-minute" });
  }
  for (let i = 1; i < ev.length; i++) {
    const d = ev[i].atUs - ev[i - 1].atUs;
    if (d > rules.layeredS * US && d < rules.anyMinGapS * US) out.push({ index: ev[i].index, atUs: ev[i].atUs, rule: "too-close" });
  }
  for (let i = 0; i < ev.length; i++) {
    const n = ev.filter((c) => c.atUs > ev[i].atUs - 60 * US && c.atUs <= ev[i].atUs).length;
    if (n > rules.anyPerMin) out.push({ index: ev[i].index, atUs: ev[i].atUs, rule: "per-minute" });
  }
  return out;
}

/**
 * The plan with the rules kept: events are taken by priority (higher first, then earlier) and one that would break a
 * rule against those already taken is dropped. Returns { kept, dropped: [{ event, rule }] }, kept in time order.
 */
export function enforceSfxPlan(events, { moments = [], rules = SFX_RULES } = {}) {
  const order = events.map((e, i) => ({ e, i })).sort((a, b) => (b.e.priority ?? 0) - (a.e.priority ?? 0) || a.e.atUs - b.e.atUs);
  const kept = [];
  const dropped = [];
  for (const { e } of order) {
    // What is kept already keeps every rule, so a rule broken now is broken by this event.
    const broken = checkSfxPlan([...kept, e], { moments, rules });
    if (broken.length) dropped.push({ event: e, rule: broken[0].rule });
    else kept.push(e);
  }
  kept.sort((a, b) => a.atUs - b.atUs);
  return { kept, dropped };
}
