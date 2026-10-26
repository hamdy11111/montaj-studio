// One graphic on a transparent frame: the kit template's component with its parameters (defaults applied), inside the
// style pack, with the fonts it uses loaded before the frame is captured. Used by the render (composition "Graphic")
// and by the editor's Player — the same component tree, so the preview is the export.
import React, { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import { KIT_TEMPLATES, kitParams } from "../../core/graphicsKit.js";
import { packOf } from "../packs/index.js";
import { GraphicsProvider } from "./context.jsx";
import { registerFonts, waitForFonts } from "./fonts.js";
import { FrameContext } from "./motion.js";
import { COMPONENTS } from "./registry.js";

/** Font families a graphic will draw with (its own font parameter + the pack's display/body/ui). */
export function graphicFonts(template, params, pack) {
  const pk = packOf(pack);
  return [params?.font, pk.fonts.display, pk.fonts.body, pk.fonts.ui, "Alexandria"].filter(Boolean);
}

/**
 * crop ({ x, y, w, h } pixels of the full frame frameWidth×frameHeight): the composition is only that band — the
 * graphic is laid out on the full frame and shifted so the band is what the browser captures (render speed).
 */
export const Graphic = ({ template, params = {}, pack = "punchy", assetBase = "", fontBase, crop = null, frameWidth, frameHeight }) => {
  const tpl = KIT_TEMPLATES[template];
  const P = useMemo(() => kitParams(template, params), [template, params]);
  useMemo(() => { registerFonts(fontBase); waitForFonts(graphicFonts(template, P, pack)); }, [template, pack, fontBase]); // eslint-disable-line react-hooks/exhaustive-deps
  const C = tpl && COMPONENTS[tpl.component];
  const body = <GraphicsProvider pack={pack} assetBase={assetBase}>{C ? <C {...P} /> : null}</GraphicsProvider>;
  if (!crop) return <AbsoluteFill style={{ backgroundColor: "transparent" }}>{body}</AbsoluteFill>;
  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", overflow: "hidden" }}>
      <FrameContext.Provider value={{ W: frameWidth, H: frameHeight }}>
        <div style={{ position: "absolute", left: -crop.x, top: -crop.y, width: frameWidth, height: frameHeight }}>{body}</div>
      </FrameContext.Provider>
    </AbsoluteFill>
  );
};
