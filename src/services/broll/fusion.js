// Combining the B-roll indexes into one ranking, in plain testable JavaScript:
//   1. reciprocal-rank fusion over the per-index lists (SigLIP2, MetaCLIP 2, Qwen3-VL-Embedding, bge-m3 captions):
//      score(shot) = Σ weight(index) / (k + rank) — robust to the indexes' different score scales;
//   2. the reranker (Qwen3-VL-Reranker) re-orders the top `rerankTop`; its probability is blended with the fused rank;
//   3. diversity: a shot too close to one already picked (same video, overlapping or within `nearS`) is pushed down,
//      so the results are not five slices of one take; shots used recently in the project are pushed down too.

export const FUSION = { k: 60, rerankTop: 30, rerankWeight: 0.7, nearS: 4, nearPenalty: 0.5, recentPenalty: 0.35,
  weights: { siglip2: 1, metaclip2: 1, qwen3vl: 1.2, bge: 1 } };

/** lists: { index: [[shotId, score], …] (best first) } → [{ id, rrf, ranks: { index: rank } }] best first. */
export function rrf(lists, { k = FUSION.k, weights = FUSION.weights } = {}) {
  const acc = new Map();
  for (const [name, list] of Object.entries(lists || {})) {
    const w = weights[name] ?? 1;
    list.forEach(([id], r) => {
      const e = acc.get(id) || { id, rrf: 0, ranks: {} };
      e.rrf += w / (k + r + 1);
      e.ranks[name] = r + 1;
      acc.set(id, e);
    });
  }
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

/**
 * Blend the reranker's scores (0–1, for the first `scores.length` candidates) with the fused order: the fused part is
 * the candidate's RRF normalised by the best one. Candidates past the reranked head keep their order below it.
 */
export function blendRerank(cands, scores, { weight = FUSION.rerankWeight } = {}) {
  if (!cands.length) return [];
  const top = cands[0].rrf || 1;
  const head = cands.slice(0, scores.length).map((c, i) => ({ ...c, rerank: scores[i], score: weight * scores[i] + (1 - weight) * (c.rrf / top) }));
  head.sort((a, b) => b.score - a.score);
  const tail = cands.slice(scores.length).map((c) => ({ ...c, score: (1 - weight) * (c.rrf / top) }));
  return [...head, ...tail];
}

/**
 * Greedy re-ordering for diversity and freshness. `shotOf(id)` → { mediaKey, startS, endS }; `recent`: shot ids (or
 * media keys) used lately. Each step takes the best remaining candidate after penalties against those taken.
 */
export function diversify(cands, shotOf, { limit = 10, recent = [], nearS = FUSION.nearS, nearPenalty = FUSION.nearPenalty, recentPenalty = FUSION.recentPenalty } = {}) {
  const rec = new Set(recent);
  const left = cands.map((c) => ({ ...c, base: c.score ?? c.rrf }));
  const out = [];
  while (out.length < limit && left.length) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < left.length; i++) {
      const c = left[i], s = shotOf(c.id);
      let v = c.base;
      if (s && out.some((o) => { const t = shotOf(o.id); return t && t.mediaKey === s.mediaKey && s.startS < t.endS + nearS && t.startS < s.endS + nearS; })) v *= 1 - nearPenalty;
      if (rec.has(c.id) || (s && rec.has(s.mediaKey))) v *= 1 - recentPenalty;
      if (v > bestScore) { bestScore = v; best = i; }
    }
    const [c] = left.splice(best, 1);
    out.push({ ...c, final: Math.round(bestScore * 10000) / 10000 });
  }
  return out;
}

/** Recall@k and MRR of ranked ids against the hand-marked right answers (for the 100-question test). */
export function evaluate(runs) {
  let r1 = 0, r5 = 0, r10 = 0, mrr = 0;
  for (const { ranked, relevant } of runs) {
    const rel = new Set(relevant);
    const pos = ranked.findIndex((id) => rel.has(id));
    if (pos === 0) r1++;
    if (pos >= 0 && pos < 5) r5++;
    if (pos >= 0 && pos < 10) r10++;
    if (pos >= 0) mrr += 1 / (pos + 1);
  }
  const n = runs.length || 1;
  const r = (x) => Math.round((x / n) * 1000) / 1000;
  return { n: runs.length, recall1: r(r1), recall5: r(r5), recall10: r(r10), mrr: r(mrr) };
}
