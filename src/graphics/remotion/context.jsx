// What every component may ask of its host: the style pack (tokens), and how to turn a picture reference into a URL
// the page can load. The render worker serves files and media:// references over a local HTTP server and passes
// its base as `assetBase`; the editor's Player loads media:// links directly (the app's protocol).
import React, { createContext, useContext } from "react";
import { packOf } from "../packs/index.js";

const Ctx = createContext({ pack: packOf("punchy"), assetBase: "" });

export const GraphicsProvider = ({ pack, assetBase = "", children }) => (
  <Ctx.Provider value={{ pack: packOf(pack), assetBase }}>{children}</Ctx.Provider>
);

export const usePack = () => useContext(Ctx).pack;

/** URL of a picture/Lottie reference: http(s)/data/blob as they are; media:// and file paths through the host. */
export function useAsset() {
  const { assetBase } = useContext(Ctx);
  return (src) => {
    if (!src) return null;
    const s = String(src);
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    if (/^media:/i.test(s)) return assetBase ? `${assetBase}${encodeURIComponent(s)}` : s;
    return assetBase ? `${assetBase}${encodeURIComponent(s)}` : null; // a file path: only the render server can read it
  };
}
