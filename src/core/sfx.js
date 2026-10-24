// Sound effects bundled with the app (src/services/audio/sfx, unpacked from the asar so FFmpeg can read them).
// whoosh, swish, riser, pop, blip and sparkle are made by Montaj Studio (filtered noise and tones); ding, click,
// impact, thud and confirm come from Kenney's CC0 packs. All peak at −3 dBFS; volumeDb sits them under a voice.
// leadUs: how long before the moment it marks the sound starts (a whoosh peaks 0.3 s in, a riser ends on the hit).
export const SFX = {
  whoosh: { ar: "ووش", use: "Text or a graphic flying in; a transition", file: "whoosh.wav", volumeDb: -11, leadUs: 300_000 },
  swish: { ar: "سويش", use: "Something leaving quickly; a small move", file: "swish.wav", volumeDb: -13, leadUs: 60_000 },
  riser: { ar: "تصاعد", use: "Building up to a reveal (ends on the moment)", file: "riser.wav", volumeDb: -15, leadUs: 950_000 },
  pop: { ar: "بوب", use: "An emoji, a sticker or a word popping in", file: "pop.wav", volumeDb: -9, leadUs: 10_000 },
  blip: { ar: "بليب", use: "A small UI-like accent, a badge going away", file: "blip.wav", volumeDb: -15, leadUs: 0 },
  sparkle: { ar: "لمعة", use: "Something nice, magic, a highlight", file: "sparkle.wav", volumeDb: -15, leadUs: 20_000 },
  ding: { ar: "دينج", use: "A correct point, a tip, an idea", file: "ding.wav", volumeDb: -15, leadUs: 0 },
  click: { ar: "كليك", use: "A tick, a step, a number changing", file: "click.wav", volumeDb: -12, leadUs: 0 },
  impact: { ar: "ضربة", use: "A punch-in zoom, a strong statement", file: "impact.wav", volumeDb: -12, leadUs: 20_000 },
  thud: { ar: "خبطة", use: "A softer hit, text landing", file: "thud.wav", volumeDb: -12, leadUs: 10_000 },
  confirm: { ar: "تأكيد", use: "A checklist item done, success", file: "confirm.wav", volumeDb: -14, leadUs: 0 },
};
