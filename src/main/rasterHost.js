// A hidden, sandboxed window that rasterizes text, stickers and captions in the main process's absence of an editor:
// exports started by agents (MCP) and frame previews use it, so they get exactly the pixels the preview draws
// (same Chromium canvas code, js/editor/raster.js). Created on first use, recreated if it crashes; no preload, no
// node access, navigation blocked.
import { BrowserWindow } from "electron";

export class RasterHost {
  constructor() { this.win = null; this.ready = null; }

  ensure() {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready;
    this.win = new BrowserWindow({
      show: false, width: 320, height: 240, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, spellcheck: false },
    });
    this.win.webContents.on("will-navigate", (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("render-process-gone", () => { this.ready = null; });
    this.win.on("closed", () => { this.win = null; this.ready = null; });
    this.ready = this.win.loadURL("app://bundle/raster-host.html")
      .then(() => this.win.webContents.executeJavaScript("window.rasterHostReady", true))
      .catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  /** {segId: dataURL | {frames}} for the text/sticker/caption segments of a timeline at W×H. */
  async overlays(timeline, W, H, onlyIds = null) {
    await this.ensure();
    const args = [timeline, W, H, onlyIds].map((x) => JSON.stringify(x)).join(", ");
    return this.win.webContents.executeJavaScript(`window.rasterHost.overlays(${args})`, true);
  }

  close() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; this.ready = null; }
}
