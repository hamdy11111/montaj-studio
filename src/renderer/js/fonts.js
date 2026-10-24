// Registers the bundled fonts (core/fonts.js) with the page and makes sure the ones a timeline uses are loaded
// before anything is drawn — a canvas silently falls back to another font when its font is not ready yet, which
// would make an export look different from the preview.
import { BUNDLED_FONTS, BUNDLED_FAMILIES } from "../../core/fonts.js";
import { CAPTION_TEMPLATES } from "../../core/captionTemplates.js";

let installed = null;

/** Add every bundled font face to document.fonts (files load lazily, on first use). */
export function installFonts() {
  if (installed) return installed;
  for (const f of BUNDLED_FONTS) {
    for (const { file, weight } of f.files) {
      try {
        const face = new FontFace(f.family, `url("assets/fonts/${encodeURI(file).replace(/\[/g, "%5B").replace(/\]/g, "%5D")}")`, { weight, style: "normal", display: "block" });
        document.fonts.add(face);
      } catch { /* a broken file must not stop the app */ }
    }
  }
  installed = true;
  return installed;
}

/** Families used by the text, caption and graphic layers of a timeline. */
export function fontsOf(timeline) {
  const out = new Set();
  for (const t of timeline?.tracks || []) for (const s of t.segments) {
    if (!s.text) continue;
    if (s.text.font) out.add(s.text.font);
    const cap = s.text.caption;
    if (cap) out.add(cap.overrides?.font || CAPTION_TEMPLATES[cap.template]?.font);
    const g = s.text.graphic;
    if (g?.params?.font) out.add(g.params.font);
  }
  out.add("Cairo");
  return [...out].filter((f) => f && BUNDLED_FAMILIES.includes(f));
}

/** Load the given bundled families (all weights in use) before drawing. Resolves even if a font fails. */
export async function ensureFonts(families) {
  installFonts();
  await Promise.all(families.flatMap((f) => ["400", "700", "900"].map((w) => document.fonts.load(`${w} 40px "${f}"`, "أب Ab").catch(() => []))));
}
