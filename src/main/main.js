// Electron main process: window, security, protocols, services and IPC.
import { createRequire } from "node:module";
import { app, BrowserWindow, session, Menu, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { registerSchemes, handleProtocols } from "./protocols.js";
import { registerIpc } from "./ipc.js";
import { createServices } from "../services/index.js";
import { closeDatabase } from "../db/realmClient.js";
import { AgentHub } from "../agent/controlServer.js";
import { RasterHost } from "./rasterHost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..");
const isDev = process.argv.includes("--dev");
const smoke = process.argv.includes("--smoke-test"); // used by tests: start, report readiness, quit

// Test runs can isolate user data: MONTAJ_USER_DATA=<dir>
if (process.env.MONTAJ_USER_DATA) app.setPath("userData", process.env.MONTAJ_USER_DATA);

let services = null;
let agents = null;
const rasterHost = new RasterHost();
let mainWindow = null;
const pendingOpen = process.argv.find((a) => /\.(mstudio)$/i.test(a)) || null;

registerSchemes();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // A .mstudio package double-clicked while the app is running: hand it to the renderer to import.
    const file = argv.find((a) => /\.(mstudio)$/i.test(a));
    if (file) mainWindow.webContents.send("api:event", "app:openFile", { path: file });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680, show: false, backgroundColor: "#141414",
    title: "Montaj Studio",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#141414", symbolColor: "#E0E0E0", height: 34 },
    icon: path.join(SRC, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(SRC, "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev || !app.isPackaged,
    },
  });
  win.once("ready-to-show", () => { if (!smoke) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://")) e.preventDefault(); });
  win.loadURL("app://bundle/index.html");
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

// Settings › Performance (GPU UI / hardware decoding) must be applied before the app is ready, so the
// settings service mirrors them into a small boot file (see ipc.js "settings.set").
try {
  const boot = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "boot.json"), "utf8"));
  if (boot.gpuUI === false) app.disableHardwareAcceleration();
  if (boot.hwDecode === false) app.commandLine.appendSwitch("disable-accelerated-video-decode");
} catch { /* first run: defaults */ }

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Allow the renderer to use the microphone/camera/screen only for recording features (FEAT-014).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(["media", "display-capture", "notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission) && wc.getURL().startsWith("app://")));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const { desktopCapturer } = await import("electron");
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    callback(sources[0] ? { video: sources[0], audio: "loopback" } : {});
  });
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => cb({ responseHeaders: details.responseHeaders }));

  try {
    services = await createServices({
      root: app.getPath("userData"),
      appVersion: app.getVersion(),
      notify: (event, payload) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("api:event", event, payload); },
      log: (...a) => console.log("[services]", ...a),
    });
  } catch (e) {
    console.error("Failed to start services", e);
    const { dialog } = await import("electron");
    dialog.showErrorBox("Montaj Studio", `The local database could not be opened.\n\n${e?.details?.message || e.message}`);
    app.exit(1);
    return;
  }
  // Agents (MCP bridge): same services, same history. The pipe only listens while Settings › Agents is on.
  services.exporter.rasterize = (tl, W, H) => rasterHost.overlays(tl, W, H);
  const notifyAll = (event, payload) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("api:event", event, payload); };
  const approvals = new Map();
  agents = new AgentHub({
    services, dir: services.paths.agents, appVersion: app.getVersion(), notify: notifyAll,
    approver: (req) => new Promise((resolve) => {
      if (!BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) return resolve(false);
      approvals.set(req.id, resolve);
      notifyAll("agents:approval", req);
      mainWindow?.flashFrame?.(true);
    }),
  });
  agents.respond = (id, allow) => { const r = approvals.get(id); approvals.delete(id); r?.(!!allow); return !!r; };
  services.timelines.onChange = (e) => { if (e.source !== "ui") notifyAll("timeline:changed", e); };
  const applyAgents = async (on) => {
    if (on && !agents.server) { try { await agents.listen(process.env.MONTAJ_PIPE || undefined); } catch (e) { console.error("[agents] listen failed", e.message); } }
    else if (!on && agents.server) agents.close();
  };
  services.settings.onChange((section, merged) => { if (section === "agents") applyAgents(merged.enabled); });
  await applyAgents(services.settings.get("agents").enabled);

  handleProtocols({ rendererDir: path.join(SRC, "renderer"), coreDir: path.join(SRC, "core"), assetsDir: path.join(SRC, "renderer", "assets"), getServices: () => services });
  registerIpc({ getServices: () => services, getAgents: () => agents, getWindow: () => mainWindow, appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, realm: realmVersion(), platform: process.platform, packaged: app.isPackaged, userData: app.getPath("userData"), pendingOpen, smoke, bench: process.env.MONTAJ_BENCH === "1" }) });
  mainWindow = createWindow();
  if (smoke) {
    mainWindow.webContents.once("did-finish-load", () => setTimeout(() => { console.log("SMOKE_OK"); app.quit(); }, 1500));
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
});

app.on("window-all-closed", () => { app.quit(); });

app.on("will-quit", () => {
  try { agents?.close(); } catch { /* not listening */ }
  rasterHost.close();
  try { closeDatabase({ shutdown: true }); } catch { /* already closed */ }
});

process.on("uncaughtException", (e) => {
  const logDir = services?.paths?.logs;
  if (logDir) fs.appendFileSync(path.join(logDir, "main.log"), `[${new Date().toISOString()}] ${e.stack || e}\n`);
  console.error(e);
});

function realmVersion() {
  try { return createRequire(import.meta.url)("realm/package.json").version; } catch { return ""; }
}
