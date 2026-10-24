// Entry of the hidden raster window (see src/main/rasterHost.js). The main process calls window.rasterHost.* with
// webContents.executeJavaScript; results are PNG data URLs (or frame lists for animated captions).
import { buildOverlays } from "./editor/raster.js";
import { installFonts, ensureFonts, fontsOf } from "./fonts.js";

installFonts();
window.rasterHost = {
  // Fonts first: a canvas draws with a fallback font if the timeline's font is not loaded yet.
  overlays: async (timeline, W, H, onlyIds) => { await ensureFonts(fontsOf(timeline)); return buildOverlays(timeline, W, H, { onlyIds }); },
};
window.rasterHostReady = ensureFonts(["Cairo"]).then(() => true);
