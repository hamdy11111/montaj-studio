// The director's pipeline, part 2 (PLAN_editor_and_graphics.md, item 9 step 4): a critic that compares treatments
// two by two. Every treatment is first EXECUTED (core/director.js — the real cuts, the real segment order), then
// scored on the plan's rubric, measured, not judged:
//  · hook: something strong in the first 3 s (the flash-forward's moment, or the opening moment);
//  · pace: shots not longer than the limit, no dead stretch (the retention guard), the median shot;
//  · punch + reaction: every cause kept next to its reaction, in its order;
//  · no repetition: no line said twice in the edit (a hook copy aside);
//  · no cut inside a word (the speech guards);
//  · story: how much of the video's strength the edit keeps, and its length against the target.
// A judge (an LLM: the local planner model or Claude) may compare each pair too — asked in BOTH orders (A/B and B/A);
// only an answer that survives the swap counts, otherwise the rubric decides. Pure except for the judge it is given.
import { POLICY } from "./policy.js";
import { sameLine } from "./treatments.js";
import { US } from "./util.js";

export const RUBRIC_WEIGHTS = { hook: 0.25, pace: 0.2, punch: 0.15, repetition: 0.1, midWord: 0.15, story: 0.15 };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r2 = (x) => Math.round(x * 100) / 100;

/** Shot lengths (s) of a v2 plan in edit order: each segment, split again where a zoom (an angle change) starts or ends. */
export function shotLengths(plan) {
  const out = [];
  for (const seg of plan.segments || []) {
    const edges = new Set([seg.fromUs, seg.toUs]);
    for (const z of plan.zooms || []) if (z.mediaId === seg.mediaId) for (const t of [z.fromUs, z.toUs]) if (t > seg.fromUs + 200_000 && t < seg.toUs - 200_000) edges.add(t);
    const e = [...edges].sort((a, b) => a - b);
    for (let i = 1; i < e.length; i++) out.push((e[i] - e[i - 1]) / US);
  }
  return out;
}

/**
 * The rubric of one executed treatment. x: { treatment, plan (v2), qa (may be null), moments, links, targetUs }.
 * Returns { scores: { hook, pace, punch, repetition, midWord, story }, total, facts } — scores 0–1, facts the numbers.
 */
export function rubric({ treatment, plan, qa = null, moments, links = [], targetUs = null }) {
  const byN = (n) => moments[n - 1];
  const maxStrength = Math.max(1, ...moments.map((m) => m.strength));
  const segs = plan.segments || [];
  const editUs = segs.reduce((n, s) => n + (s.toUs - s.fromUs), 0);
  // Hook: the flash-forward's moment, else the opening one; nothing in the first 3 s scores 0.
  const hookM = treatment.hook && segs[0]?.role === "hook" ? byN(treatment.hook.moment) : byN(treatment.order[0]);
  const pull = hookM ? hookM.strength + (hookM.reactions.some((r) => r.type !== "pitch" && r.type !== "loudness") ? 1 : 0) : 0;
  let hook = hookM ? clamp01(pull / (maxStrength + 1)) : 0;
  if (hookM && (hookM.role === "filler" || hookM.kind === "still" || hookM.kind === "gap")) hook *= 0.3;
  if (hookM && hookM.role === "setup" && !hookM.question) hook *= 0.7;
  // Pace: the longest shot and the median against the policy; every dead stretch costs.
  const shots = shotLengths(plan).filter((x) => x > 0.04).sort((a, b) => a - b);
  const median = shots.length ? shots[Math.floor(shots.length / 2)] : 0, longest = shots.length ? shots[shots.length - 1] : 0;
  const dead = (qa?.checks || []).filter((c) => c.id === "retention.dead").length;
  const [lo, hi] = POLICY.shots.medianTarget;
  let pace = 1;
  if (median > hi) pace -= Math.min(0.5, (median - hi) / 4);
  if (longest > 8) pace -= Math.min(0.4, (longest - 8) / 20);
  pace -= 0.2 * dead;
  if (median && median < lo * 0.5) pace -= 0.1; // frantic
  // Punch + reaction: kept together, cause first (a "before" link: reaction first).
  const pos = new Map(treatment.order.map((n, i) => [n, i]));
  const relevant = links.filter((l) => l.cause !== l.reaction && (pos.has(l.cause) || pos.has(l.reaction)));
  const together = relevant.filter((l) => pos.has(l.cause) && pos.has(l.reaction) && pos.get(l.reaction) - pos.get(l.cause) === (l.direction === "before" ? -1 : 1));
  const punch = relevant.length ? together.length / relevant.length : 1;
  // Repetition: two kept lines that say the same thing.
  const lines = treatment.order.map(byN).filter((m) => m?.kind === "speech");
  let repeats = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (sameLine(lines[i].text, lines[j].text)) repeats++;
  const repetition = clamp01(1 - 0.34 * repeats);
  // No cut inside a word.
  const wordFails = (qa?.checks || []).filter((c) => c.id === "speech.cutInsideWord" || c.id === "speech.lostWord").length;
  const midWord = wordFails ? 0 : 1;
  // Story: the share of the video's (positive) strength kept, and the length against the target.
  const pos0 = (m) => Math.max(0, m.strength);
  const all = moments.reduce((n, m) => n + pos0(m), 0) || 1;
  const keptStrength = treatment.order.reduce((n, k) => n + pos0(byN(k)), 0);
  let story = clamp01(keptStrength / all);
  if (targetUs) story *= clamp01(1 - Math.abs(editUs - targetUs) / targetUs);
  else story = clamp01(0.6 * story + 0.4 * clamp01(keptStrength / Math.max(1, editUs / US) / 0.5)); // strength per second
  const scores = { hook: r2(hook), pace: r2(clamp01(pace)), punch: r2(punch), repetition: r2(repetition), midWord, story: r2(story) };
  const total = r2(Object.entries(RUBRIC_WEIGHTS).reduce((n, [k, w]) => n + w * scores[k], 0));
  return { scores, total, facts: { editSec: r2(editUs / US), medianShot: r2(median), longestShot: r2(longest), dead, links: relevant.length, linksTogether: together.length, repeats, wordFails, hookMoment: hookM?.n ?? null } };
}

/** The rubric's verdict on a pair: "A" | "B" | "tie" (a margin under 0.02 is a tie), and the criteria that decided. */
export function compareByRubric(a, b) {
  const d = a.total - b.total;
  const why = Object.keys(RUBRIC_WEIGHTS).filter((k) => Math.abs(a.scores[k] - b.scores[k]) >= 0.1).map((k) => `${k} ${a.scores[k]} vs ${b.scores[k]}`);
  return { winner: Math.abs(d) < 0.02 ? "tie" : d > 0 ? "A" : "B", why };
}

/** The cut as text for a judge: the hook, the moments in edit order (with what is said or seen), the numbers. */
export function describeCut(item, moments) {
  const t = item.treatment, f = item.rubric.facts;
  const sec = (us) => (us / US).toFixed(1);
  const show = (n) => { const m = moments[n - 1]; return `${n} (${m.kind}, ${m.role}${m.reactions.some((r) => r.type !== "pitch") ? ", reaction" : ""}) ${m.kind === "speech" ? `«${m.text.slice(0, 70)}»` : `[${(m.summary || "no words").slice(0, 70)}]`}`; };
  return [
    `Title: ${t.title}`,
    `Opens with: ${t.hook && item.plan.segments[0]?.role === "hook" ? `a flash-forward (${t.hook.kind}) of moment ${show(t.hook.moment)}` : `moment ${show(t.order[0])}`}`,
    `Moments in edit order: ${t.order.map((n) => n).join(", ")}`,
    ...t.order.slice(0, 40).map((n) => `  - ${show(n)} @${sec(moments[n - 1].s)} s`),
    t.order.length > 40 ? `  … ${t.order.length - 40} more` : "",
    `Length ${f.editSec} s · median shot ${f.medianShot} s · longest shot ${f.longestShot} s · dead stretches ${f.dead} · cause/reaction kept together ${f.linksTogether}/${f.links} · repeated lines ${f.repeats} · cuts inside words ${f.wordFails}`,
  ].filter(Boolean).join("\n");
}

/**
 * Pairwise ranking. items: [{ id, treatment, plan, qa, rubric }]. judge (optional): async ({ a, b, aText, bText }) →
 * { winner: "A" | "B" | "tie", why }. Each pair is judged as (A, B) and as (B, A); an answer that does not survive the
 * swap is ignored and the rubric decides. Returns { ranking: [{ id, wins, losses, ties, total }], pairs: [{ a, b,
 * winner (id | null), by: "judge" | "rubric", why, consistent }] } — best first (wins − losses, then the rubric).
 */
export async function rankTreatments(items, { judge = null, moments = [] } = {}) {
  const score = new Map(items.map((x) => [x.id, { id: x.id, wins: 0, losses: 0, ties: 0, total: x.rubric.total }]));
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const A = items[i], B = items[j];
    const rub = compareByRubric(A.rubric, B.rubric);
    let winner = rub.winner === "tie" ? null : rub.winner === "A" ? A.id : B.id, by = "rubric", why = rub.why.join("; "), consistent = null;
    if (judge) {
      try {
        const aText = describeCut(A, moments), bText = describeCut(B, moments);
        const first = await judge({ a: A, b: B, aText, bText });
        const second = await judge({ a: B, b: A, aText: bText, bText: aText });
        const w1 = first?.winner === "A" ? A.id : first?.winner === "B" ? B.id : null;
        const w2 = second?.winner === "A" ? B.id : second?.winner === "B" ? A.id : null;
        consistent = w1 === w2;
        if (consistent && w1) { winner = w1; by = "judge"; why = String(first.why || "").slice(0, 300); }
        else if (consistent && !w1) { winner = null; by = "judge"; why = "a tie both ways"; }
      } catch (e) { why = `${why}${why ? "; " : ""}judge failed: ${String(e.message || e).slice(0, 80)}`; }
    }
    if (winner) { score.get(winner).wins++; score.get(winner === A.id ? B.id : A.id).losses++; } else { score.get(A.id).ties++; score.get(B.id).ties++; }
    pairs.push({ a: A.id, b: B.id, winner, by, why, consistent });
  }
  const ranking = [...score.values()].sort((p, q) => (q.wins - q.losses) - (p.wins - p.losses) || q.total - p.total);
  return { ranking, pairs };
}

/** The judge's instructions (the plan's rubric) and the answer it must give. */
export const JUDGE_SYSTEM = `You are a senior video editor judging two cuts of the same raw video (an Egyptian Arabic short video: vlog, challenge, cooking, interview, explainer or comedy). Pick the cut a viewer would watch to the end. Criteria, in order: (1) a hook in the first 3 seconds — something strong, a result, a reaction or a question, not a slow setup; (2) pace — no long static shots, no dead stretches; (3) every punchline or action stays with its reaction; (4) no repeated line; (5) no cut in the middle of a word; (6) the story still makes sense and keeps the best moments. Answer only JSON: {"winner": "A" | "B" | "tie", "why": "<one short sentence>"}.`;
export const JUDGE_SCHEMA = { type: "object", additionalProperties: false, required: ["winner", "why"], properties: { winner: { enum: ["A", "B", "tie"] }, why: { type: "string", maxLength: 300 } } };
