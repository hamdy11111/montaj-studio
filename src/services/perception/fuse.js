// Fusion: the raw outputs of the perception stages (one Python worker each) → the event timeline. Everything that
// needs more than one model is decided here, in plain testable JavaScript:
//   · every word gets its speaker from the exclusive diarization, and "unsure" when it sits in overlapping speech
//   · words become utterances (one speaker, no long pause) — the units the feeling model hears
//   · active-speaker scores (LR-ASD, per face track and frame) become "speaking on screen" spans
//   · voices ↔ faces: a cost matrix over the whole file solved with the Hungarian method; a voice whose best face
//     scores below the threshold is "off-screen" (the person behind the camera, a voice-over)
import { makeEvent, finalize, overlapS, SCHEMA_VERSION } from "./timeline.js";

export const DEFAULTS = Object.freeze({
  wordNearS: 0.5,          // a word in no turn takes the nearest turn this close
  overlapShare: 0.3,       // a word with ≥ this share inside overlapping speech is unsure
  utteranceGapS: 0.6,      // a pause this long ends an utterance
  utteranceMaxS: 20,       // and so does this length (the feeling model hears ≤ 30 s)
  pauseMinS: 0.5,
  asdSmooth: 5,            // frames of moving average on the ASD score
  asdMinS: 0.3,            // shortest "speaking on screen" span
  linkThreshold: 0.15,     // voice ↔ face: the contrast score (see linkSpeakersToFaces) a link needs
  linkMinEvidenceS: 3,     // seconds of the voice with that face visible, below which no link is made
  linkPriorS: 5,           // evidence shrink: a score counts fully only after several seconds of visible speech
  linkBaseline: 0.3,       // the face's "speaking" share assumed when it is hardly seen at other times
  linkMinCoverage: 0.25,   // the face must be on screen for this share of the voice's speech (else: a voice heard
                           // mostly off-screen — a TV, the person filming — that a face happened to mouth along with)
  // Laughter: laughter-detection fires on crowd noise and chatter (alone: ~40–50 % of its spans were laughs on the
  // user's raw videos, judged by an independent listening model), PANNs' laughter classes rarely pass 0.3 there. Both
  // together — laughter-detection ≥ 0.8 with some PANNs laughter (≥ 0.05) within ±0.5 s — were laughs ~80 % of the time.
  laughLD: 0.8,
  laughPannsSupport: 0.05,
  laughPannsAlone: 0.3,
  laughPannsWindowS: 1,
  laughMinS: 0.3,
  laughGapS: 0.3,
});

/** Hungarian method (Kuhn–Munkres), minimising. `cost` is rows × cols (any shape); returns col index per row or -1. */
export function hungarian(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  if (!n || !m) return new Array(n).fill(-1);
  const N = Math.max(n, m);
  const big = Math.max(1, ...cost.flat().map((v) => Math.abs(v))) * 10;
  const a = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i < n && j < m ? cost[i][j] : big)));
  const u = new Array(N + 1).fill(0), v = new Array(N + 1).fill(0), p = new Array(N + 1).fill(0), way = new Array(N + 1).fill(0);
  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(N + 1).fill(Infinity), used = new Array(N + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= N; j++) if (p[j] && p[j] - 1 < n && j - 1 < m) out[p[j] - 1] = j - 1;
  return out;
}

/** Diarization labels ("SPEAKER_00"…) → "S1", "S2"… by speaking time (most first). */
export function speakerNames(exclusive) {
  const sec = new Map();
  for (const t of exclusive) sec.set(t.speaker, (sec.get(t.speaker) || 0) + t.end - t.start);
  const order = [...sec.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return new Map(order.map((k, i) => [k, `S${i + 1}`]));
}

/** Words with their speaker (exclusive turns) and an `unsure` flag (overlapping speech). */
export function wordsWithSpeakers(words, exclusive, overlap = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const turns = exclusive.slice().sort((a, b) => a.start - b.start);
  return words.map((w) => {
    let best = null, bestS = 0;
    for (const t of turns) {
      if (t.start > w.end) break;
      const s = overlapS(w.start, w.end, t.start, t.end);
      if (s > bestS) { bestS = s; best = t; }
    }
    if (!best) {
      let d = Infinity;
      for (const t of turns) {
        const g = t.end < w.start ? w.start - t.end : t.start > w.end ? t.start - w.end : 0;
        if (g < d) { d = g; best = t; }
      }
      if (d > o.wordNearS) best = null;
    }
    const len = Math.max(1e-3, w.end - w.start);
    const ov = overlap.reduce((acc, r) => acc + overlapS(w.start, w.end, r.start, r.end), 0);
    return { ...w, speaker: best ? best.speaker : null, unsure: ov / len >= o.overlapShare };
  });
}

/** Utterances: consecutive words of one speaker without a long pause (and not longer than utteranceMaxS). */
export function utterances(words, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  let cur = null;
  for (const w of words) {
    if (cur && (w.speaker !== cur.speaker || w.start - cur.end > o.utteranceGapS || w.end - cur.start > o.utteranceMaxS)) { out.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, speaker: w.speaker, words: [] };
    cur.words.push(w);
    cur.end = Math.max(cur.end, w.end);
  }
  if (cur) out.push(cur);
  return out.map((u) => ({ start: u.start, end: u.end, speaker: u.speaker, text: u.words.map((w) => w.word).join(" "), n: u.words.length, unsure: u.words.some((w) => w.unsure) }));
}

/** Silences between words at least pauseMinS long (and before the first / after the last word). */
export function pauses(words, duration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  let prev = 0;
  for (const w of words) {
    if (w.start - prev >= o.pauseMinS) out.push({ start: prev, end: w.start });
    prev = Math.max(prev, w.end);
  }
  if (duration && duration - prev >= o.pauseMinS) out.push({ start: prev, end: duration });
  return out;
}

/** Spans where a face track's ASD score (moving average) is above 0, at least asdMinS long. */
export function speakingSpans(track, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = track.scores || [];
  const fps = track.fps || 25;
  const k = Math.max(1, o.asdSmooth | 0);
  const sm = s.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - (k >> 1)); j <= Math.min(s.length - 1, i + (k >> 1)); j++) { a += s[j]; n++; } return a / n; });
  const out = [];
  let st = -1;
  for (let i = 0; i <= sm.length; i++) {
    const on = i < sm.length && sm[i] > 0;
    if (on && st < 0) st = i;
    if (!on && st >= 0) {
      if ((i - st) / fps >= o.asdMinS) {
        const seg = sm.slice(st, i);
        out.push({ start: track.t0 + st / fps, end: track.t0 + i / fps, score: seg.reduce((a, b) => a + b, 0) / seg.length });
      }
      st = -1;
    }
  }
  return out;
}

/**
 * Laughter spans from the two frame tracks of the audio stage ({hop, laughterDetection: [p], panns: [p]}): a frame is
 * laughter when laughter-detection is ≥ laughLD and PANNs' laughter classes reach laughPannsSupport somewhere within
 * ±laughPannsWindowS/2, or when PANNs alone is ≥ laughPannsAlone. Spans shorter than laughMinS are dropped, gaps up to
 * laughGapS are bridged. p: a heuristic score, 0.55–1 (see DEFAULTS for the measured precision at this setting).
 */
export function laughterSpans(track, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hop = track.hop || 0.05;
  const ld = track.laughterDetection || [], pa = track.panns || [];
  const n = Math.min(ld.length, pa.length);
  const half = Math.max(0, Math.round(o.laughPannsWindowS / hop / 2));
  const paMax = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let m = 0; for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) m = Math.max(m, pa[j]); paMax[i] = m; }
  const on = Array.from({ length: n }, (_, i) => (ld[i] >= o.laughLD && paMax[i] >= o.laughPannsSupport) || pa[i] >= o.laughPannsAlone);
  const raw = [];
  for (let i = 0, st = -1; i <= n; i++) {
    if (i < n && on[i]) { if (st < 0) st = i; } else if (st >= 0) { raw.push([st, i]); st = -1; }
  }
  const merged = [];
  for (const r of raw) { const last = merged[merged.length - 1]; if (last && (r[0] - last[1]) * hop <= o.laughGapS) last[1] = r[1]; else merged.push([...r]); }
  return merged.filter(([a, b]) => (b - a) * hop >= o.laughMinS).map(([a, b]) => {
    const l = Math.max(...ld.slice(a, b)), q = Math.max(...paMax.slice(a, b));
    const sources = [...(l >= o.laughLD ? ["laughter-detection"] : []), ...(q >= o.laughPannsSupport ? ["PANNs"] : [])];
    const p = q >= o.laughPannsAlone ? Math.max(0.85, l) : 0.55 + 0.25 * Math.min(1, (l - o.laughLD) / Math.max(1e-6, 1 - o.laughLD)) + 0.2 * Math.min(1, q / 0.2);
    return { start: a * hop, end: b * hop, p: Math.min(1, p), sources, ld: l, panns: q };
  });
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Voices ↔ on-screen people. For a voice S and a person P, over the whole file:
 *   shareS   of the seconds S talks while P is on screen, the share where P's mouth is seen speaking (ASD > 0)
 *   baseline the same share when S is NOT talking (other voices, silence) — a face that always "speaks" (eating,
 *            laughing, a moving camera, the model's bias) has a high baseline and earns nothing
 *   score    (shareS − baseline) × visible / (visible + linkPriorS): the contrast, trusted more with more evidence
 * The Hungarian method picks the best one-to-one pairing; a pair under linkThreshold, with under linkMinEvidenceS of
 * visible time, or with the face on screen for under linkMinCoverage of the voice's speech, is not made, and that voice
 * is off-screen (the person behind the camera, a TV, a voice-over). On the user's raw videos the wrong links all had
 * the face on screen for 3–10 % of the voice's speech, the right ones for 75–100 %.
 * tracks: [{id, identity, t0, fps, scores: [per frame]}] · exclusive: [{start, end, speaker}]
 */
export function linkSpeakersToFaces(exclusive, tracks, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const voices = [...new Set(exclusive.map((t) => t.speaker))];
  const people = [...new Set(tracks.map((t) => t.identity))];
  const talk = voices.map((v) => exclusive.filter((t) => t.speaker === v).reduce((a, t) => a + t.end - t.start, 0));
  const stat = voices.map(() => people.map(() => ({ visible: 0, speaking: 0 })));
  const all = people.map(() => ({ visible: 0, speaking: 0 }));
  for (const tr of tracks) {
    const pj = people.indexOf(tr.identity);
    const fps = tr.fps || 25;
    const scores = tr.scores || [];
    for (const v of scores) { all[pj].visible += 1 / fps; if (v > 0) all[pj].speaking += 1 / fps; }
    for (const turn of exclusive) {
      const vi = voices.indexOf(turn.speaker);
      const f0 = Math.max(0, Math.floor((turn.start - tr.t0) * fps)), f1 = Math.min(scores.length, Math.ceil((turn.end - tr.t0) * fps));
      for (let f = f0; f < f1; f++) {
        stat[vi][pj].visible += 1 / fps;
        if (scores[f] > 0) stat[vi][pj].speaking += 1 / fps;
      }
    }
  }
  const detail = stat.map((row, i) => row.map((c, j) => {
    const visO = all[j].visible - c.visible, spkO = all[j].speaking - c.speaking;
    const baseline = visO >= 2 ? spkO / visO : o.linkBaseline;
    const shareS = c.visible > 0 ? c.speaking / c.visible : 0;
    const coverage = talk[i] > 0 ? c.visible / talk[i] : 0;
    const score = c.visible >= o.linkMinEvidenceS ? (shareS - baseline) * (c.visible / (c.visible + o.linkPriorS)) : -1;
    return { shareS, baseline, score, coverage, visible: c.visible, speaking: c.speaking };
  }));
  const pick = hungarian(detail.map((row) => row.map((d) => -d.score)));
  const r3 = (x) => Number(x.toFixed(3));
  const links = {};
  voices.forEach((v, i) => {
    const j = pick[i];
    const d = j >= 0 ? detail[i][j] : null;
    const conf = d ? r3(sigmoid((d.score - o.linkThreshold) * 10)) : null;
    links[v] = d && d.score >= o.linkThreshold && d.coverage >= o.linkMinCoverage
      ? { face: people[j], confidence: conf, score: r3(d.score), shareS: r3(d.shareS), baseline: r3(d.baseline), coverage: r3(d.coverage), visibleS: r3(d.visible), speakingS: r3(d.speaking) }
      : { face: null, offScreen: true, confidence: d ? r3(d.coverage < o.linkMinCoverage ? Math.max(1 - conf, 1 - d.coverage / o.linkMinCoverage) : 1 - conf) : null,
        best: d ? people[j] : null, score: d ? r3(d.score) : null, coverage: d ? r3(d.coverage) : null };
  });
  return { links, voices, people, score: detail.map((r) => r.map((d) => r3(d.score))) };
}

/** Speaking-on-screen spans of every track, with the voice talking at that moment when it is linked to that face. */
export function activeSpeakerEvents(tracks, exclusive, links, model, opts = {}) {
  const faceToVoice = new Map(Object.entries(links).filter(([, l]) => l.face).map(([v, l]) => [l.face, v]));
  const out = [];
  for (const tr of tracks) {
    for (const sp of speakingSpans(tr, opts)) {
      const v = faceToVoice.get(tr.identity) || null;
      // The span counts as that voice's when the voice is talking during most of it.
      const talk = v ? exclusive.filter((t) => t.speaker === v).reduce((a, t) => a + overlapS(sp.start, sp.end, t.start, t.end), 0) : 0;
      out.push(makeEvent({ t0: sp.start, t1: sp.end, type: "active_speaker", source_model: model, confidence: sigmoid(sp.score),
        entity: tr.identity, speaker: v && talk >= 0.5 * (sp.end - sp.start) ? v : null, extra: { track: tr.id, score: Number(sp.score.toFixed(3)) } }));
    }
  }
  return out;
}

/**
 * The whole timeline from the stages' results (any stage may be missing: its events are simply absent).
 * stages: { words?, speakers?, audio?, emotion?, shots?, faces?, asd?, vision? } — see the workers for each shape.
 */
export function buildTimeline({ media, stages, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const ev = [];
  const S = stages || {};
  const names = S.speakers ? speakerNames(S.speakers.exclusive) : new Map();
  const nm = (x) => (x === null || x === undefined ? null : names.get(x) || x);
  const excl = (S.speakers?.exclusive || []).map((t) => ({ ...t, speaker: nm(t.speaker) }));
  const overl = (S.speakers?.overlap || []).map((t) => ({ ...t, speakers: (t.speakers || []).map(nm) }));

  // Words, utterances, pauses.
  let words = [];
  if (S.words) {
    words = wordsWithSpeakers(S.words.words, excl, overl, o);
    for (const w of words) {
      ev.push(makeEvent({ t0: w.start, t1: w.end, type: "word", source_model: `${S.words.asrModel} + ${S.words.model}`, confidence: w.align_conf ?? w.p ?? null,
        speaker: w.speaker, text: w.word, extra: { aligned: !!w.aligned, asr: [w.asr_start, w.asr_end], ...(w.unsure ? { unsure: true } : {}) } }));
    }
    for (const u of utterances(words, o)) ev.push(makeEvent({ t0: u.start, t1: u.end, type: "utterance", source_model: "fusion", speaker: u.speaker, text: u.text, extra: { words: u.n, ...(u.unsure ? { unsure: true } : {}) } }));
    for (const p of pauses(words, media?.duration, o)) ev.push(makeEvent({ t0: p.start, t1: p.end, type: "pause", source_model: "fusion", extra: { seconds: Number((p.end - p.start).toFixed(3)) } }));
  }

  // Speakers and overlap.
  let links = {};
  const asdTracks = S.asd && S.faces ? S.asd.tracks.map((a) => ({ ...a, identity: S.faces.tracks.find((t) => t.id === a.id)?.identity ?? null })).filter((t) => t.identity) : [];
  if (S.speakers && asdTracks.length) links = linkSpeakersToFaces(excl, asdTracks, o).links;
  for (const t of excl) ev.push(makeEvent({ t0: t.start, t1: t.end, type: "speaker_turn", source_model: S.speakers.model, speaker: t.speaker, entity: links[t.speaker]?.face ?? null }));
  for (const r of overl) ev.push(makeEvent({ t0: r.start, t1: r.end, type: "overlap", source_model: S.speakers.model, extra: { speakers: r.speakers } }));

  // Faces and who speaks on screen.
  if (S.faces) {
    for (const t of S.faces.tracks) {
      const step = Math.max(1, Math.round((S.faces.fps || 25) / 5)); // 5 boxes a second are enough downstream
      ev.push(makeEvent({ t0: t.t0, t1: t.t1, type: "face_track", source_model: S.faces.model, confidence: t.quality?.det ?? null, entity: t.identity,
        extra: { track: t.id, poor: t.poor, quality: t.quality, boxes: t.boxes.filter((_, i) => i % step === 0).map((b) => b.slice(0, 5)) } }));
    }
  }
  if (asdTracks.length) ev.push(...activeSpeakerEvents(asdTracks, excl, links, S.asd.model, o));

  // Sound, laughter, feeling, spikes.
  if (S.audio) {
    for (const a of S.audio.tags || []) ev.push(makeEvent({ t0: a.start, t1: a.end, type: "audio_tag", source_model: S.audio.tagModel, confidence: a.p, text: a.label, extra: { index: a.index } }));
    const laughs = S.audio.laughTrack ? laughterSpans(S.audio.laughTrack, o) : S.audio.laughter || [];
    for (const l of laughs) {
      const who = excl.filter((t) => overlapS(l.start, l.end, t.start, t.end) > 0).map((t) => t.speaker);
      ev.push(makeEvent({ t0: l.start, t1: l.end, type: "laughter", source_model: l.sources.join(" + "), confidence: l.p, speaker: who.length === 1 ? who[0] : null, extra: { sources: l.sources, ...(l.kind ? { kind: l.kind } : {}) } }));
    }
    for (const s of S.audio.loudness || []) ev.push(makeEvent({ t0: s.start, t1: s.end, type: "loudness_spike", source_model: "librosa rms", confidence: s.p ?? null, extra: { db: s.db, aboveDb: s.above } }));
    for (const s of S.audio.pitch || []) {
      const who = excl.filter((t) => overlapS(s.start, s.end, t.start, t.end) > 0).map((t) => t.speaker);
      ev.push(makeEvent({ t0: s.start, t1: s.end, type: "pitch_spike", source_model: "librosa pyin", confidence: s.p ?? null, speaker: who.length === 1 ? who[0] : null, extra: { hz: s.hz, ratio: s.ratio } }));
    }
  }
  if (S.emotion) {
    for (const u of S.emotion.utterances || []) {
      ev.push(makeEvent({ t0: u.start, t1: u.end, type: "emotion", source_model: S.emotion.model, confidence: u.p, speaker: u.speaker ?? null, text: u.label, extra: { scores: u.scores } }));
    }
  }

  // Shots and the vision model's log.
  if (S.shots) S.shots.shots.forEach((s, i) => ev.push(makeEvent({ t0: s.start, t1: s.end, type: "shot", source_model: S.shots.model, confidence: s.p ?? null, extra: { index: i + 1 } })));
  if (S.vision) {
    for (const w of S.vision.windows || []) {
      if (!w.log) continue;
      ev.push(makeEvent({ t0: w.start, t1: w.end, type: "shot_log", source_model: S.vision.model, confidence: w.log.confidence ?? null, text: w.log.summary ?? null,
        entity: Array.isArray(w.people) && w.people.length === 1 ? w.people[0] : null, extra: { shot: w.shot, keyframes: w.keyframes, ...w.log } }));
    }
  }

  const speakers = [...names.values()].map((id) => {
    const sec = excl.filter((t) => t.speaker === id).reduce((a, t) => a + t.end - t.start, 0);
    return { id, seconds: Number(sec.toFixed(2)), face: links[id]?.face ?? null, offScreen: links[id] ? !!links[id].offScreen : null, linkConfidence: links[id]?.confidence ?? null };
  });
  const faces = (S.faces?.identities || []).map((p) => ({ ...p, voice: Object.entries(links).find(([, l]) => l.face === p.id)?.[0] ?? null }));
  return { version: SCHEMA_VERSION, media, speakers, faces, links, events: finalize(ev) };
}
