// Software updates from the project's GitHub releases (electron-updater: latest.yml next to the installer, the
// download checked against its SHA-512). Only the installed app goes online for this; a source checkout and the tests
// never do (MONTAJ_NO_UPDATE=1 turns it off too). Settings › General › Software update:
//   "auto"    check at start, download in the background, install when the app closes (or now, from the toast)
//   "notify"  check at start and ask before downloading
// A check from the menu downloads right away. The state goes to the windows as "update:status".
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class Updater {
  constructor({ app, notify = () => {}, mode = () => "auto", log = () => {} }) {
    this.app = app;
    this.notify = notify;
    this.mode = mode;
    this.log = log;
    this.au = null;
    this.state = { status: "idle", current: app.getVersion(), version: null, progress: 0, error: null, notes: "" };
  }

  get usable() { return this.app.isPackaged && process.env.MONTAJ_NO_UPDATE !== "1"; }

  emit(patch) {
    Object.assign(this.state, patch);
    this.notify("update:status", { ...this.state });
    return { ...this.state };
  }

  status() { return { ...this.state, usable: this.usable }; }

  load() {
    if (this.au) return this.au;
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m) => this.log("[update]", m), warn: (m) => this.log("[update]", m), error: (m) => this.log("[update]", m), debug: () => {} };
    autoUpdater.on("update-available", (i) => this.emit({ status: "available", version: i.version, notes: notesText(i.releaseNotes), error: null }));
    autoUpdater.on("update-not-available", () => this.emit({ status: "none", version: null, error: null }));
    autoUpdater.on("download-progress", (p) => this.emit({ status: "downloading", progress: Math.round(p.percent) / 100 }));
    autoUpdater.on("update-downloaded", (i) => this.emit({ status: "ready", version: i.version, progress: 1 }));
    autoUpdater.on("error", (e) => this.emit({ status: "error", error: String(e?.message || e).slice(0, 300) }));
    this.au = autoUpdater;
    return autoUpdater;
  }

  /** Look for a newer release; `download` (a check the user asked for, or mode "auto") fetches it right away. */
  async check({ manual = false } = {}) {
    if (!this.usable) return this.emit({ status: "unsupported" });
    if (["checking", "downloading"].includes(this.state.status)) return this.status();
    if (this.state.status === "ready") return this.emit({});
    const au = this.load();
    this.emit({ status: "checking", error: null });
    try {
      const r = await au.checkForUpdates();
      if (this.state.status === "available" && (manual || this.mode() === "auto")) await this.download();
      return { ...this.status(), found: !!r?.isUpdateAvailable };
    } catch (e) {
      return this.emit({ status: "error", error: String(e?.message || e).slice(0, 300) });
    }
  }

  async download() {
    if (!this.usable || !this.au || this.state.status !== "available") return this.status();
    this.emit({ status: "downloading", progress: 0 });
    try { await this.au.downloadUpdate(); } catch (e) { this.emit({ status: "error", error: String(e?.message || e).slice(0, 300) }); }
    return this.status();
  }

  /** Close the app and run the downloaded installer (silently), then start the new version. */
  install() {
    if (this.state.status !== "ready" || !this.au) return false;
    setImmediate(() => this.au.quitAndInstall(true, true));
    return true;
  }
}

function notesText(n) {
  const s = Array.isArray(n) ? n.map((x) => x.note || "").join("\n") : String(n || "");
  return s.replace(/<[^>]+>/g, "").trim().slice(0, 2000);
}
