// One graphic on a transparent frame: the kit template's component with its parameters (defaults applied), inside the
// style pack, with the fonts it uses loaded before the frame is captured. Used by the render (composition "Graphic")
// and by the editor's Player — the same component tree, so the preview is the export.
import React, { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import { KIT_TEMPLATES, kitParams } from "../../core/graphicsKit.js";
import { packOf } from "../packs/index.js";
import { GraphicsProvider } from "./context.jsx";
import { registerFonts, waitForFonts } from "./fonts.js";
import { COMPONENTS } from "./registry.js";

/** Font families a graphic will draw with (its own font parameter + the pack's display/body/ui). */
export function graphicFonts(template, params, pack) {
  const pk = packOf(pack);
  return [params?.font, pk.fonts.display, pk.fonts.body, pk.fonts.ui, "Alexandria"].filter(Boolean);
}

export const Graphic = ({ template, params = {}, pack = "punchy", assetBase = "", fontBase }) => {
  const tpl = KIT_TEMPLATES[template];
  const P = useMemo(() => kitParams(template, params), [template, params]);
  useMemo(() => { registerFonts(fontBase); waitForFonts(graphicFonts(template, P, pack)); }, [template, pack, fontBase]); // eslint-disable-line react-hooks/exhaustive-deps
  const C = tpl && COMPONENTS[tpl.component];
  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <GraphicsProvider pack={pack} assetBase={assetBase}>{C ? <C {...P} /> : null}</GraphicsProvider>
    </AbsoluteFill>
  );
};
