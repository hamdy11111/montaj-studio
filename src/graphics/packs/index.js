// Style packs by id. A pack is one file (see punchy.js); this is the list the app and the components read.
import { PUNCHY } from "./punchy.js";

export const PACKS = { punchy: PUNCHY };
export const DEFAULT_PACK = "punchy";

/** The pack of a graphic (unknown ids fall back to the default pack). */
export const packOf = (id) => PACKS[id] || PACKS[DEFAULT_PACK];

/** A pack's sound for a role: the first of its list the app has (has(id) → bool), else null. */
export function packSound(pack, role, has = () => true) {
  for (const id of packOf(pack?.id || pack).sounds[role] || []) if (has(id)) return id;
  return null;
}

/** Keys every pack must define (checked by the tests so a new pack cannot miss a role). */
export const PACK_SCHEMA = {
  colors: ["accent", "alert", "energy", "ink", "paper", "info", "gain", "impact", "impactDepth", "cream"],
  fonts: ["display", "body", "ui"],
  type: ["hero", "title", "word", "heading", "number", "body", "label"],
  motion: ["enter", "exit", "overshoot", "shake", "spring"],
  sounds: ["word", "stamp", "streak", "card", "tag", "tick", "done", "out"],
  family: ["emoji", "icons", "lottie"],
};
