// Where the VFX/overlay library comes from. Only sources that need no account:
//   mixkit — Mixkit stock video (https://mixkit.co/license/#videoFree): items marked "Free" may be used in personal and
//            commercial projects without attribution; items marked "Mixkit Restricted License" are free but restricted
//            (not for some commercial uses) — fine for this personal app; each item records which it is.
// Not fetched (reported to the user instead): ProductionCrate (its free tier needs an account and a daily-limited
// login), ActionVFX (account; most packs paid), Pixabay (its site refuses scripted downloads behind a bot check and
// its API needs a personal key).

export const LICENSES = {
  "mixkit-free": { name: "Mixkit Stock Video Free License", url: "https://mixkit.co/license/#videoFree", personal: true, commercial: true },
  "mixkit-restricted": { name: "Mixkit Restricted License", url: "https://mixkit.co/license/#videoFree", personal: true, commercial: false },
  user: { name: "User-provided (licence of the pack the user owns)", url: "", personal: true, commercial: null },
};

/** Library categories (plan item 10) → Mixkit tag pages to read. */
export const MIXKIT_VFX = {
  comedy: ["confetti", "balloons", "bubbles", "stars", "fireworks", "shine", "coins"],
  drama: ["smoke", "rain", "lightning", "dust", "snow", "light-leak", "lens-flare", "bokeh"],
  action: ["fire", "explosion", "sparks", "particles", "glitch"],
  kitchen: ["steam", "flour", "fire", "smoke"], // Mixkit has few kitchen overlays: flames and smoke (steam) on black
  transitions: ["ink", "transition", "light-leak", "glitch", "overlay"],
};

/** Words in a title/description that say the clip is an overlay (a plain background to blend or key away). */
export const OVERLAY_WORDS = /\b(black (back(ground|drop)|screen)|dark background|green (screen|background)|chroma|overlay|isolated|on (a )?black|against (a )?black|alpha)\b/i;

/** Clips of people are footage, not overlays, whatever their background. */
export const NOT_OVERLAY = /\b(woman|man|girl|boy|person|people|dancer|ballerina|couple|model|hands?)\b/i;

/** Items per category kept (the best overlay candidates first). */
export const PER_CATEGORY = 10;
