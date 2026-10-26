// The pack's emoji family on disk (D:\capcut new\assets-library\emoji, never in git): Google's Noto Animated Emoji as
// Lottie JSON (noto-lottie/<code>.json — copied from the edit-hamdy skill, which downloaded them from
// fonts.gstatic.com) and as transparent video (animated-webm/<name>-1x.webm — from remotion-dev/animated-emoji, the
// files @remotion/animated-emoji plays). Both CC BY 4.0: a video that uses them credits
// "Animated emoji: Noto Emoji Animation by Google, CC BY 4.0". One family, one drawing style (plan §5).
import fs from "node:fs";
import path from "node:path";

export const EMOJI_DIR = process.env.MONTAJ_EMOJI_DIR || "D:\\capcut new\\assets-library\\emoji";
export const EMOJI_CREDIT = "Animated emoji: Noto Emoji Animation by Google, CC BY 4.0";

/** Noto file code of an emoji character: code points in hex joined by "_" ("❤️" → "2764_fe0f"). */
export const emojiCode = (ch) => [...String(ch || "").trim()].map((c) => c.codePointAt(0).toString(16)).join("_");

/** Flags render as letters on Windows and are outside the family: refused (pack.family.noFlags). */
export const isFlag = (ch) => [...String(ch || "")].some((c) => { const p = c.codePointAt(0); return p >= 0x1f1e6 && p <= 0x1f1ff; });

/** Lottie file of an emoji (exact code, then without / with the variation selector), or null. */
export function lottieFor(ch, dir = EMOJI_DIR) {
  if (isFlag(ch)) return null;
  const code = emojiCode(ch), bare = code.replace(/_fe0f/g, "");
  for (const c of [code, bare, `${bare}_fe0f`]) {
    const f = path.join(dir, "noto-lottie", `${c}.json`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Animated-emoji names by Noto code (the files downloaded into animated-webm). */
export const ANIMATED_NAMES = {
  "1f605": "grin-sweat", "1f602": "joy", "1f923": "rofl", "1f62d": "loudly-crying", "1f970": "heart-face", "1f60d": "heart-eyes", "1f973": "partying-face",
  "1f60b": "yum", "1f97a": "pleading", "1f914": "thinking-face", "1f92d": "smiling-eyes-with-hand-over-mouth", "1f631": "screaming", "1f644": "rolling-eyes",
  "1f92f": "mind-blown", "1f62a": "sleepy", "1f60e": "sunglasses-face", "1f648": "see-no-evil-monkey", "1f525": "fire", "1f4af": "100", "1f389": "party-popper",
  "2764_fe0f": "red-heart", "1f440": "eyes", "1f4aa": "muscle", "1f44f": "clap", "1f44d": "thumbs-up", "1f6a8": "police-car-light", "1f4b8": "money-with-wings",
  "1f4a1": "light-bulb", "274c": "cross-mark", "1f618": "kissing-heart",
};

/** { name, file } of the animated-emoji video of a character (or a name), or null when it is not downloaded. */
export function animatedFor(chOrName, dir = EMOJI_DIR) {
  const code = emojiCode(chOrName), bare = code.replace(/_fe0f/g, "");
  const name = ANIMATED_NAMES[code] || ANIMATED_NAMES[bare] || ANIMATED_NAMES[`${bare}_fe0f`] || (Object.values(ANIMATED_NAMES).includes(chOrName) ? chOrName : null);
  if (!name) return null;
  const file = path.join(dir, "animated-webm", `${name}-1x.webm`);
  return fs.existsSync(file) ? { name, file } : null;
}
