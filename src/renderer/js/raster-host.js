// Entry of the hidden raster window (see src/main/rasterHost.js). The main process calls window.rasterHost.* with
// webContents.executeJavaScript; results are PNG data URLs (or frame lists for animated captions).
import { buildOverlays } from "./editor/raster.js";

window.rasterHost = {
  overlays: (timeline, W, H, onlyIds) => buildOverlays(timeline, W, H, { onlyIds }),
};
window.rasterHostReady = document.fonts.ready.then(() => true);
