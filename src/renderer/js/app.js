// Renderer entry: boot (settings, language, shortcuts), router (home ↔ editor), global events and drag & drop guard.
import { h, mount, $ } from "./dom.js";
import { icon } from "./icons.js";
import { setLang, t, errorText } from "./i18n.js";
import { call, on } from "./api.js";
import { app, pushNotification } from "./state.js";
import { toast } from "./ui/toast.js";
import { renderHome } from "./pages/home.js";
import { formatBytes } from "../core/util.js";

let disposeRoute = null;

async function boot() {
  try {
    const [info, settings, caps] = await Promise.all([call("app.info"), call("settings.all"), call("app.capabilities").catch(() => null)]);
    app.info = info; app.settings = settings; app.caps = caps;
    setLang(settings.general.language);
    app.shortcuts = await call("shortcuts.get", settings.ui.lastShortcutPreset || 1);
  } catch (err) {
    mount($("#app"), h("div", { class: "empty" }, icon("warning"), h("div", {}, errorText(err)), h("button", { class: "btn", onclick: () => location.reload() }, t("c.retry"))));
    return;
  }
  app.go = go;
  wireGlobalEvents();
  renderTitlebar();
  if (app.info.startup?.purged) toast(`${t("trash.title")}: ${app.info.startup.purged}`, "info");
  if (app.info.startup?.interruptedExports) toast(t("ex.failed"), "warning");
  go("home", {});
  // Opened with a .mstudio package (file association, FEAT-120/137): import it and open the project.
  if (app.info.pendingOpen) openPackage(app.info.pendingOpen);
}

async function openPackage(file) {
  const tst = toast(t("c.loading"), "info", { ms: 120_000 });
  try { const p = await call("package.import", file); tst.remove(); toast(t("c.done"), "success"); go("editor", { projectId: p.id }); }
  catch (err) { tst.remove(); toast(errorText(err), "error"); }
}

function renderTitlebar(title = "") {
  mount($("#titlebar"), h("div", { class: "brand" }, icon("logo"), h("span", {}, t("app.name"))), h("div", { class: "title nowrap" }, title), h("div", { id: "titlebar-actions", class: "row" }));
}
export function setTitle(title) { const el = $("#titlebar .title"); if (el) el.textContent = title; }
export function titlebarActions() { return $("#titlebar-actions"); }

async function go(route, params = {}) {
  if (disposeRoute) { const ok = await disposeRoute(); if (ok === false) return; }
  disposeRoute = null;
  app.current = { route, params };
  renderTitlebar(route === "editor" ? "" : "");
  const root = $("#app");
  if (route === "editor") {
    const { openEditor } = await import("./editor/editor.js");
    disposeRoute = await openEditor(root, params);
  } else {
    disposeRoute = renderHome(root, params);
  }
  app.events.emit("route", app.current);
}

function wireGlobalEvents() {
  on("export:done", (p) => {
    pushNotification({ kind: "export", ok: true, path: p.path, text: `${t("ex.done")} · ${formatBytes(p.sizeBytes || 0)}` });
    if (app.settings.edit.exportSound) new Audio(beepUrl()).play().catch(() => {});
    call("app.notify", t("ex.done"), p.path).catch(() => {});
  });
  on("app:openFile", (p) => openPackage(p.path));
  on("export:error", (p) => pushNotification({ kind: "export", ok: false, text: p.cancelled ? t("ex.cancelled") : `${t("ex.failed")}: ${errorText(p.error)}` }));
  // Files dropped outside an import zone must not navigate the window.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  window.addEventListener("unhandledrejection", (e) => { if (e.reason?.messageKey) { toast(errorText(e.reason), "error"); e.preventDefault(); } });
  app.events.on("settings", (s) => { const before = document.documentElement.lang; setLang(s.general.language); if (before !== document.documentElement.lang) go(app.current.route, app.current.params); });
}

/** Short 880 Hz notification tone as a WAV blob URL (no bundled audio assets needed; CSP allows blob: media). */
let beepCache = null;
function beepUrl() {
  if (beepCache) return beepCache;
  const sr = 22050, n = Math.round(sr * 0.25), buf = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); buf.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, sr, true); buf.setUint32(28, sr * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); w(36, "data"); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 880 * i) / sr) * 9000 * Math.min(1, (n - i) / 2000), true);
  beepCache = URL.createObjectURL(new Blob([buf.buffer], { type: "audio/wav" }));
  return beepCache;
}

boot();
