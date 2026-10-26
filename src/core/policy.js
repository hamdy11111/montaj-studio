// The editing policy: the measured numbers of the edit-hamdy editing skill (its scripts/policy.json and the scripts that
// read it), in one place, so the director and the quality guards use the same values. Times are in SECONDS here, as
// in the source; code converts with US. Where a number comes from a measurement, the comment says which.
export const POLICY = {
  pace: {
    // Silence kept between words = baseGap × rhythm, then the overrides below, never above maxGap.
    rhythm: { mrbeast: 0.6, fast: 0.8, normal: 1.0, calm: 1.3 },
    baseGap: 0.25,          // mood "normal" (no scene moods known)
    maxGap: 0.6,            // zero dead silence: the hard cap on any kept pause
    sentenceExtra: 0.12,    // a little more air after . ؟ ! …
    questionGap: 0.16,      // a question is glued to its answer
    beforePunch: { window: 8.0, factor: 0.7 }, // the setup of a punchline/reveal runs faster
    afterReaction: { window: 1.5, gap: 0.32 },  // a breath after a laugh/reaction
    wordPad: { before: 0.05, after: 0.06 },     // a word's content span around its voiced part
    stutterGap: 0.9,        // the same function word twice within this = a stutter
    retake: { within: 2.5, pauseBefore: 0.2, flowAfter: 0.4 },
  },
  // MrBeast reference (one ~58 min episode): ~28 cuts/min, median shot 1.73 s, 93 % of shots under 4 s.
  shots: { medianTarget: [1.7, 2.5], p90Max: 4.0 },
  angles: { W: 1.0, M: 1.18, C: 1.42, longShot: 6.0, minC: 1.25 },
  // A full-frame zoom never crops the head (the skill's reframe constraints): the top of the hair stays inside the
  // window, the chin has 5 % of the head's height below it, the sides 6 % of the window. (The skill's 14 % / 6 %
  // margins are for picture-in-card windows, which the director does not make.)
  face: { top: 0, chin: 0.05, side: 0.06 },
  zoom: {
    punch: { before: 0.05, after: 1.1, factor: 1.14 },
    push: { before: 0.6, after: 1.6, factor: 1.07 },
    minScore: 1.8, minGap: 2.5, punchGap: 4.0, clear: 0.05, minLen: 0.5,
  },
  emoji: { perMin: 4, minGap: 3.0, sameWindow: 25, minScore: 2.0, dur: 1.6, laughDur: 2.0 },
  sfx: { minGap: 1.0, layered: 0.08, perMin: 20 },
  sync: { tol: 0.04, spoil: 6.0 },                 // an element never enters before its word; no written word said later
  retention: { maxDead: 6.0, angleDelta: 0.2 },    // a reason to keep watching at least every 6 s
  hook: { sec: 2.0, firstCaption: 0.5 },
  ending: { strike: 2.0, question: 2.5 },
  numbers: { listGap: 3.5, listSpan: 12, listMin: 3, impactMin: 10 },
  // J cut on a change of scene (another file, or a stretch of ≥ longGap s left out): the next sound starts leadMs
  // before its picture — short, so it reads as a lead-in, not as a lip-sync error; only into a segment ≥ minSegment s.
  jl: { leadMs: 200, minSegment: 1.0, longGap: 4.0 },
  // Retakes: a repeated line is looked for this far back (s); a false start is redone within falseStart s.
  retakes: { within: 20, falseStart: 4 },
  // Reference cuts per minute by style (±30 % is "in style"); used for the report only.
  cutsPerMin: { energetic: [22.1, 46.2], explain: [14.8, 26.4], calm: [14.8, 18.0] },
};
