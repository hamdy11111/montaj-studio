// Fonts for the render: the app's bundled fonts (core/fonts.js — the same files the editor uses, copied into the
// bundle's public/fonts by build.js) registered as FontFace, and the render waits (delayRender) until the families a
// graphic uses are loaded — a frame drawn with a fallback font would differ from the preview. Calibri is a Windows
// system font (its Bold has the Arabic glyphs): it is used by name, never shipped. In the editor's Player the app has
// already registered the same faces (renderer/js/fonts.js), so nothing is loaded twice.
import { continueRender, delayRender, staticFile } from "remotion";
import { BUNDLED_FONTS } from "../../core/fonts.js";

const SYSTEM = new Set(["Calibri", "Segoe UI", "Tahoma", "Arial"]);
let registered = false;

/** Register every bundled face once (files load lazily, on first use). base: URL prefix of the font files. */
export function registerFonts(base) {
  if (registered || typeof document === "undefined") return;
  registered = true;
  const root = base ?? staticFile("fonts/");
  for (const f of BUNDLED_FONTS) {
    for (const { file, weight } of f.files) {
      try {
        const url = `${root}${encodeURI(file).replace(/\[/g, "%5B").replace(/\]/g, "%5D")}`;
        document.fonts.add(new FontFace(f.family, `url("${url}")`, { weight, style: "normal", display: "block" }));
      } catch { /* a broken file must not stop the render */ }
    }
  }
}

/** Load the given families (with their weights) before the frame is captured. */
export function waitForFonts(families) {
  if (typeof document === "undefined") return;
  const want = [...new Set(families.filter(Boolean))].filter((f) => !SYSTEM.has(f));
  if (!want.length) return;
  const handle = delayRender(`fonts ${want.join(", ")}`, { timeoutInMilliseconds: 20000 });
  const loads = [];
  for (const fam of want) {
    const spec = BUNDLED_FONTS.find((f) => f.family === fam);
    const weights = spec ? spec.files.map((x) => String(x.weight).split(" ")) .flat() : ["400"];
    for (const w of new Set(weights)) loads.push(document.fonts.load(`${w} 40px "${fam}"`, "ابت abc").catch(() => null));
  }
  Promise.all(loads).then(() => continueRender(handle), () => continueRender(handle));
}
