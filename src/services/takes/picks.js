// The user's own take picks — the plan's «أقوى حاجة»: learn the user's taste from what they actually kept.
//
// Two ways a pick arrives:
//  · from a published video: workers/fingerprint.py matches its sound to the raw file(s) (landmark audio fingerprints),
//    which gives the raw spans the published cut used; takeFromCoverage then says which take of each group made it in;
//  · by hand: the pick page (pickPage.js) lets the user play every take of a group and choose one, and saves a JSON file
//    that `cli.mjs --import-picks` reads.
// Picks are stored with the scored group they belong to (the relative signal scores of every take), so the weights can
// be learned again whenever the scorer changes (learnWeights, per content type, pulled towards the defaults).
import fs from "node:fs";
import path from "node:path";
import { exampleFrom, learnWeights, chooseByWeights, agreement, leaveOneOut, TYPE_WEIGHTS, CONTENT_TYPES } from "../../core/takeScore.js";

const US = 1e6;

/**
 * Which take of a group a published cut kept: the take whose span is covered most by the raw spans the cut used
 * (spans in seconds of the raw). { picked, coverage: [share per take] } — picked is null when no take is covered at
 * least `min` (the line was left out, or the match failed there) or when two takes are both covered (a deliberate repeat).
 */
export function takeFromCoverage(group, spans, { min = 0.6 } = {}) {
  const cov = group.takes.map((t) => {
    const a = t.fromUs / US, b = t.toUs / US;
    const parts = spans.map(([s0, s1]) => [Math.max(a, s0), Math.min(b, s1)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
    let got = 0, end = a;
    for (const [x, y] of parts) if (y > end) { got += y - Math.max(x, end); end = y; }
    return Math.round((got / Math.max(0.05, b - a)) * 1000) / 1000;
  });
  const ok = cov.map((c, i) => ({ c, i })).filter((x) => x.c >= min);
  return { picked: ok.length === 1 ? ok[0].i : null, coverage: cov, both: ok.length > 1 };
}

/** Raw spans (s) of the media a fingerprint match result maps the published cut onto. */
export function rawSpansOf(match, mediaPath) {
  const m = (match?.matches || []).find((x) => path.resolve(x.raw) === path.resolve(mediaPath));
  return (m?.segments || []).map((s) => [s.r0, s.r1]);
}

/** A JSON-file store of picks and the weights learned from them (one folder; the app keeps it in its data folder). */
export class PickStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "picks.json");
    this.weightsFile = path.join(dir, "weights.json");
  }

  list() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")).picks || []; } catch { return []; }
  }

  /**
   * Adds (or replaces) the pick of one group. g: a scored group (scoreGroup / a takes result group). picked: the
   * take index. source: "published" | "hand". Keyed by media hash + the group's time span.
   */
  add({ media, g, picked, source = "hand", note = null }) {
    if (!Number.isInteger(picked) || picked < 0 || picked >= g.takes.length) throw new Error(`bad pick ${picked}`);
    const key = `${media?.hash || media?.path || "?"}@${g.fromUs}-${g.toUs}`;
    const rec = { key, media: { path: media?.path ?? null, name: media?.name ?? null, hash: media?.hash ?? null }, type: g.type || "default", source, note,
      at: new Date().toISOString(), picked, scorerKept: g.kept, lastComplete: g.defaultKept, example: exampleFrom(g, picked), line: g.line,
      takes: g.takes.map((t) => ({ fromUs: t.fromUs, toUs: t.toUs, text: t.text })) };
    const all = this.list().filter((p) => p.key !== key);
    all.push(rec);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, picks: all }, null, 1));
    return rec;
  }

  /** Learns the weights of every content type that has picks; saves and returns { type: { weights, examples, learned } }. */
  learn() {
    const ex = this.list().map((p) => p.example);
    const out = {};
    for (const type of CONTENT_TYPES) if (ex.some((e) => e.type === type)) out[type] = learnWeights(ex, { type });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.weightsFile, JSON.stringify({ version: 1, at: new Date().toISOString(), byType: out }, null, 1));
    return out;
  }

  /** The learned weights ({ type: { weights } }) or null. */
  learned() {
    try { return JSON.parse(fs.readFileSync(this.weightsFile, "utf8")).byType || null; } catch { return null; }
  }

  /**
   * How well the scorer agrees with the picks: the scorer as it chose at the time, the default weights of each type,
   * learned weights in leave-one-out (honest for a small set), against random and "always the last take".
   */
  measure() {
    const picks = this.list();
    const ex = picks.map((p) => p.example);
    const asChosen = agreement(ex, picks.map((p) => p.scorerKept));
    const defaults = agreement(ex, ex.map((e) => chooseByWeights(e, TYPE_WEIGHTS[e.type] || TYPE_WEIGHTS.default)));
    const loo = ex.length >= 2 ? agreement(ex, leaveOneOut(ex)) : null;
    const lastComplete = agreement(ex, picks.map((p) => p.lastComplete));
    return { picks: picks.length, bySource: countBy(picks, (p) => p.source), byType: countBy(picks, (p) => p.type), scorer: asChosen, defaults, learnedLeaveOneOut: loo, lastComplete };
  }
}

function countBy(xs, f) { const o = {}; for (const x of xs) o[f(x)] = (o[f(x)] || 0) + 1; return o; }
