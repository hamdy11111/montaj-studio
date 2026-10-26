// The perception event timeline (Phase 4 of PLAN_editor_and_graphics.md, «الإدراك»): ONE time-ordered list of
// everything the models perceived in a media file — words, speakers, overlaps, faces, who speaks on screen, laughs,
// sound tags, feelings, loudness and pitch spikes, shots, and the vision model's shot log — every event with the same
// shape, so the later phases (best take, cause ↔ reaction links, the director) read one file:
//
//   { id, t0, t1, type, source_model, confidence, speaker, entity, text, extra }
//
//   t0/t1         seconds in the media's own time (t1 ≥ t0)
//   type          one of TYPES below
//   source_model  the model (or "fusion" for what this layer derived from several models)
//   confidence    0..1, or null when the model gives none
//   speaker       the voice ("S1", "S2"…, from diarization) or null
//   entity        the on-screen person ("P1", "P2"…, a face identity) or another subject, or null
//   text          the words / the label / the one-line shot description, or null
//   extra         anything type-specific (documented per type in HANDOFF.md)
//
// Pure functions only (no I/O): the service (perceptionService.js) runs the models and calls these.

export const SCHEMA_VERSION = 1;

export const TYPES = Object.freeze([
  "word", "utterance", "pause",
  "speaker_turn", "overlap",
  "face_track", "active_speaker",
  "audio_tag", "laughter", "emotion", "loudness_spike", "pitch_spike",
  "shot", "shot_log",
]);

const r3 = (x) => Math.round(x * 1000) / 1000;

/** One event in the timeline's shape (missing fields become null; times rounded to the millisecond). */
export function makeEvent({ t0, t1 = t0, type, source_model = null, confidence = null, speaker = null, entity = null, text = null, extra = null }) {
  if (!TYPES.includes(type)) throw new Error(`unknown event type: ${type}`);
  const a = Number(t0), b = Number(t1);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`event ${type} without a finite time`);
  return {
    id: null,
    t0: r3(Math.min(a, b)),
    t1: r3(Math.max(a, b)),
    type,
    source_model,
    confidence: confidence === null || confidence === undefined || !Number.isFinite(Number(confidence)) ? null : r3(Math.max(0, Math.min(1, Number(confidence)))),
    speaker: speaker ?? null,
    entity: entity ?? null,
    text: text ?? null,
    extra: extra && Object.keys(extra).length ? extra : null,
  };
}

/** Problems with one event (empty = valid). */
export function validateEvent(e) {
  const bad = [];
  if (!e || typeof e !== "object") return ["not an object"];
  for (const k of ["id", "t0", "t1", "type", "source_model", "confidence", "speaker", "entity", "text", "extra"]) if (!(k in e)) bad.push(`missing ${k}`);
  if (!TYPES.includes(e.type)) bad.push(`type ${e.type}`);
  if (!(Number.isFinite(e.t0) && Number.isFinite(e.t1) && e.t1 >= e.t0)) bad.push("times");
  if (e.confidence !== null && !(e.confidence >= 0 && e.confidence <= 1)) bad.push("confidence");
  return bad;
}

const ORDER = new Map(TYPES.map((t, i) => [t, i]));

/** Sort by start, then end, then type order, and number the events ("e000001"…) in that order. */
export function finalize(events) {
  const out = events.slice().sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1 || ORDER.get(a.type) - ORDER.get(b.type));
  out.forEach((e, i) => { e.id = `e${String(i + 1).padStart(6, "0")}`; });
  return out;
}

/** Seconds two spans share. */
export const overlapS = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Events of some types that touch [t0, t1] (for the later phases' queries). */
export function eventsIn(timeline, t0, t1, types = null) {
  const set = types ? new Set([].concat(types)) : null;
  return (timeline.events || []).filter((e) => (!set || set.has(e.type)) && e.t1 >= t0 && e.t0 <= t1);
}

/** Count of events per type. */
export function countByType(events) {
  const c = {};
  for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
  return c;
}
