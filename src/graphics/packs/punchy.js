// Style pack «Punchy» — the design tokens of the edit-hamdy golden reference (styles/punchy, examples/bread_day,
// user's verdict 20 Oct 2026: "the best result so far"). One file per pack: colours by role, type scale, motion,
// sounds and one coherent emoji/icon/Lottie family. Components read only these tokens (never a raw colour), so a new
// pack restyles every component; the selection system reads its density and sound rules.

export const PUNCHY = {
  id: "punchy",
  name: "Punchy",
  ar: "بانشي",
  description: "Designed intro, huge words on the beat, tilted photo cards, freeze + stamp on the big hit (Arabic comedy channels).",
  reference: "edit-hamdy/styles/punchy/examples/bread_day",

  /** Colours by role (the component asks for a role, not a colour). */
  colors: {
    accent: "#FFD60A",   // the key word, banners, highlights (yellow)
    alert: "#FF2D2D",    // stamps, losses, the hot line of a joke sum
    energy: "#FF8A00",   // streaks, cut-out card backgrounds
    ink: "#0B0B0F",      // outlines, dark boxes
    paper: "#FFFFFF",    // card frames, light text
    info: "#1FB6FF",     // structure, the left side of a comparison
    gain: "#2ED47A",     // gains, done
    impact: "#FF3D7F",   // the impact number
    impactDepth: "#7A1035",
    cream: "#FFFDF4",    // note paper (joke sums)
  },

  /** Families: display (huge words), body (labels), ui (small HUD text). Calibri is the Windows system font
   * (Bold has the Arabic glyphs on this machine) — used when a pack or the user asks for it, never shipped. */
  fonts: { display: "Lalezar", body: "Tajawal", ui: "Cairo", alt: ["Alexandria", "Cairo", "Tajawal", "Calibri"] },

  /** Type scale: font size as a fraction of the frame's short side (1080 → px). */
  type: { hero: 0.22, title: 0.176, word: 0.139, heading: 0.096, number: 0.13, body: 0.044, label: 0.03, caption: 0.041 },

  /** Outline (a share of the font size) and shadows. */
  stroke: { word: 0.09, title: 0.09, number: 0.085, label: 0.05 },
  shadow: { card: "0 22px 46px rgba(0,0,0,0.55)", tag: "0 8px 18px rgba(0,0,0,0.4)", soft: "0 14px 28px rgba(0,0,0,0.45)" },
  radius: { card: 0.0093, tag: 0.0093, pill: 999 },

  /** Motion: entry/exit lengths (s), overshoot of the back-ease, shake on landing, the spring used by new components. */
  motion: {
    enter: 0.2, enterCard: 0.32, exit: 0.16, exitCard: 0.2,
    overshoot: { word: 2.2, card: 1.6, tag: 2.0, stamp: 0 },
    shake: { amp: 0.12, len: 0.28 },
    spring: { damping: 12, mass: 0.6, stiffness: 180 },
    wobbleDeg: 1.4,
  },

  /**
   * Sounds by role. Each role lists the pack's own sound first, then the app's bundled one (core/sfx.js) as the
   * fallback — the golden reference used locally generated sounds (boom, scratch, sting, slide, flash, streak);
   * until the sound library (phase 9) carries them the fallback plays.
   */
  sounds: {
    word: ["impact"], stamp: ["boom", "impact"], scratch: ["scratch", "swish"], sting: ["sting", "riser"], streak: ["streak", "whoosh"],
    card: ["slide", "whoosh"], tag: ["pop"], flash: ["flash", "sparkle"], tick: ["click"], done: ["confirm", "ding"], out: ["swish"],
    celebrate: ["pop", "sparkle"], rise: ["riser"],
  },

  /** One coherent family for emoji, icons and Lottie: Google's Noto Animated Emoji (Lottie/webm, CC BY 4.0) and
   * Lucide line icons recoloured to the pack. Anything outside the family is refused or recoloured. */
  family: {
    emoji: { source: "noto-animated", license: "CC BY 4.0 (Google)", credit: "Animated emoji: Noto Emoji Animation by Google, CC BY 4.0" },
    icons: { source: "lucide", stroke: 2.5, color: "accent" },
    lottie: { source: "noto-animated" },
    noFlags: true, // flag emoji render as letters on Windows («KR»)
  },

  /** Density of the golden reference (story part): elements per minute, median gap, longest gap, emoji per minute. */
  density: { perMinute: 5.6, medianGapSec: 6.6, maxGapSec: 38.6, emojiPerMinute: 0.67, freezeStampsPerVideo: 2 },
};

export default PUNCHY;
