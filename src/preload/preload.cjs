// Preload (sandboxed, CommonJS). Exposes a minimal, typed-by-convention API to the renderer:
//   window.api.call(method, ...args) → Promise<data> (rejects with {code, messageKey, details})
//   window.api.on(event, handler) → unsubscribe
// No Node.js objects leak into the page (contextIsolation + sandbox + nodeIntegration:false).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const EVENTS = new Set(["export:progress", "export:done", "export:error", "media:updated", "app:openFile", "timeline:changed", "agents:approval", "agents:job", "agents:connected", "agents:activity",
  "director:progress", "derived:progress", "matte:ready", "stab:ready", "asr:setup", "dub:progress", "dub:setup", "update:status", "music:setup", "music:job", "music:engine", "video:setup", "video:job", "video:engine",
  "imagegen:engine"]);

contextBridge.exposeInMainWorld("api", {
  async call(method, ...args) {
    if (typeof method !== "string") throw new Error("method must be a string");
    const res = await ipcRenderer.invoke("api:call", method, args);
    if (res && res.ok) return res.data;
    const err = new Error((res && res.error && res.error.messageKey) || "err.internal");
    err.code = res?.error?.code || "INTERNAL";
    err.messageKey = res?.error?.messageKey || "err.internal";
    err.details = res?.error?.details || {};
    throw err;
  },
  on(event, handler) {
    if (!EVENTS.has(event) || typeof handler !== "function") return () => {};
    const listener = (_e, name, payload) => { if (name === event) handler(payload); };
    ipcRenderer.on("api:event", listener);
    return () => ipcRenderer.removeListener("api:event", listener);
  },
  /** Absolute path of a file dropped onto the window (drag & drop import, FEAT-013). */
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ""; }
  },
});
