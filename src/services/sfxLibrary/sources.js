// Where the sound-effects library comes from. Only sources that need no account are fetched by the app; paid or
// sign-up packs (BOOM Toons, Sonniss, ProductionCrate…) are the user's own files, indexed in place by "import folder".
// Every entry keeps its source and licence so the export notes and the HANDOFF list can name them.
//   mixkit  — Mixkit Sound Effects Free License (free in personal and commercial projects, no attribution, not
//             redistributable as a sound library). Category pages are read for id/title/tags; the WAV is downloaded.
//   kenney  — Kenney's audio packs, CC0 (public domain). Zips of OGG files.
//   remotion — the sounds @remotion/sfx points to (remotion.media). The package is MIT; most sounds are internet
//             memes (vine boom, bruh…) whose own rights are unclear: personal use only.
// Not fetched: Freesound (its API needs a personal key), Pixabay (its site refuses scripted downloads: HTTP 403 behind
// a browser check). Both can be added with "import folder" after downloading by hand.

export const LIBRARY_CATEGORIES = ["comedy", "reactions", "drama", "kitchen", "transitions", "impacts", "risers", "whooshes", "ui", "magic"];

export const LICENSES = {
  mixkit: { name: "Mixkit Sound Effects Free License", url: "https://mixkit.co/license/#sfxFree", personal: true, commercial: true },
  kenney: { name: "CC0 1.0 (Kenney)", url: "https://creativecommons.org/publicdomain/zero/1.0/", personal: true, commercial: true },
  remotion: { name: "@remotion/sfx (MIT package; meme sounds of unclear origin)", url: "https://www.remotion.dev/docs/sfx", personal: true, commercial: false },
  bundled: { name: "Montaj Studio / Kenney CC0", url: "", personal: true, commercial: true },
  user: { name: "User-provided (licence of the pack the user owns)", url: "", personal: true, commercial: null },
};

/** Mixkit category pages per library category (the first library category a sound is found under wins). */
export const MIXKIT = {
  comedy: ["cartoon", "funny", "fart", "squeak", "toy", "wrong", "lose", "game-over", "crickets", "dj-record-scratch", "game-show", "cute", "spin", "slide", "jump", "falling", "laugh"],
  reactions: ["applause", "cheer", "crowd", "gasp", "wow", "clapping", "win", "party", "kiss", "scream"],
  drama: ["suspense-music", "horror", "scary", "heartbeat", "sad", "cinematic", "terror", "thunder", "cry", "violins"],
  kitchen: ["kitchen", "cooking", "food", "eat", "drink", "glass", "restaurant", "supermarket"],
  transitions: ["transition", "sweep", "zoom", "rewind", "glitch", "tape-machine", "static"],
  impacts: ["impact", "hit", "punch", "thud", "boom", "crash", "stomp", "drum", "cymbal", "explosion"],
  risers: ["swell", "time-machine"],
  whooshes: ["whoosh", "woosh", "swoosh", "swish", "whip", "flying"],
  ui: ["click", "interface", "notification", "pop", "ding", "bell", "correct", "error", "beep", "bleep", "coin", "camera", "typewriter", "keyboard", "alerts", "countdown"],
  magic: ["magic", "sparkle", "fairy", "spell", "chimes"],
};
export const MIXKIT_PAGES = 3; // 36 sounds a page

/** Kenney packs (asset page → the zip is read from the page). */
export const KENNEY = [
  { pack: "impact-sounds", category: "impacts" },
  { pack: "interface-sounds", category: "ui" },
  { pack: "ui-audio", category: "ui" },
  { pack: "digital-audio", category: "transitions" },
  { pack: "casino-audio", category: "ui" },
  { pack: "rpg-audio", category: "kitchen" }, // foley: cloth, doors, metal, coins, a knife on wood
];

/** @remotion/sfx 4.0.538 (https://remotion.media/<name>.wav) with what each one is. */
export const REMOTION = {
  "anime-wow": ["reactions", "anime crowd saying wow"], "bone-crack": ["comedy", "cartoon bone crack"], bruh: ["comedy", "voice saying bruh, disappointment meme"],
  ding: ["ui", "bright ding"], "dramatic-boomer": ["drama", "dramatic boom hit"], fah: ["comedy", "meme exclamation fah"],
  "illuminati-confirmed": ["comedy", "conspiracy meme music sting"], "loading-lag": ["comedy", "glitchy loading lag meme"], "mac-quack": ["comedy", "duck quack"],
  "minecraft-hurt": ["comedy", "game character hurt grunt"], "mouse-click": ["ui", "mouse click"], "nelly-ahh": ["comedy", "meme voice ahh"],
  "oh-my-god-vine": ["reactions", "voice saying oh my god, shocked meme"], "omg-hell-nah": ["comedy", "voice saying hell nah, refusal meme"],
  "page-turn": ["ui", "paper page turn"], "price-is-right-fail": ["comedy", "game show fail trombone"], "record-scratch": ["comedy", "record scratch, sudden stop"],
  "romance-meme": ["comedy", "cheesy romantic music meme"], "sanctuary-guardian-what": ["comedy", "confused voice what"],
  "shutter-modern": ["ui", "camera shutter"], "shutter-old": ["ui", "old camera shutter"], skedaddle: ["comedy", "cartoon running away"],
  "snapchat-notification": ["ui", "phone notification"], "spongebob-fail": ["comedy", "cartoon fail music"], switch: ["ui", "switch toggle"],
  triggered: ["comedy", "angry distorted meme"], "vine-boom": ["impacts", "deep boom meme hit"], whip: ["whooshes", "whip crack"],
  whoosh: ["whooshes", "whoosh"], "wilhelm-scream": ["comedy", "man screaming, wilhelm scream"], "windows-xp-error": ["comedy", "computer error sound"],
  yippee: ["reactions", "cheerful voice yippee"],
};
export const REMOTION_BASE = "https://remotion.media";

/**
 * UCS (Universal Category System) CatIDs, the first part of a file name in Sonniss / BOOM / most pro packs
 * ("WHSH_Fast Swipe_BOOM_Toons.wav") → a library category. Unknown CatIDs fall back to the folder names.
 */
export const UCS = {
  CART: "comedy", TOON: "comedy", COMD: "comedy", BOING: "comedy", HUMR: "comedy", GAME: "ui",
  WHSH: "whooshes", WHOSH: "whooshes", SWSH: "whooshes", SWOSH: "whooshes", WIND: "whooshes",
  IMPC: "impacts", IMPCT: "impacts", HIT: "impacts", PUNCH: "impacts", FGHT: "impacts", EXPL: "impacts", DSGNImpt: "impacts",
  RISR: "risers", DSGNRise: "risers", BRAAM: "drama", DRON: "drama", DSGNDron: "drama", DSGN: "transitions", SWEEP: "transitions",
  UI: "ui", UIClick: "ui", USER: "ui", BEEP: "ui", ALRM: "ui", BELL: "ui", COIN: "ui", MAGC: "magic", MAGSpel: "magic",
  FOOD: "kitchen", KTCH: "kitchen", DISH: "kitchen", LIQ: "kitchen", GLAS: "kitchen", CROWD: "reactions", CRWD: "reactions", APPL: "reactions", LAFF: "reactions", VOX: "reactions",
  MUSC: "drama", STGR: "drama", TENS: "drama",
};
