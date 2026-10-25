// Software updates in the interface: the main process (main/updater.js) sends "update:status"; a new version shows
// as a toast — download it (when Settings asks first), then restart to install it. checkForUpdates() is the menu's
// «Check for updates»: it reports every outcome, also «you have the newest version».
import { t } from "../i18n.js";
import { call, on } from "../api.js";
import { toast } from "./toast.js";

let manual = false, shown = "", downloading = null;

function show(s) {
  const key = `${s.status}:${s.version || ""}`;
  if (s.status === "downloading") {
    const text = t("upd.downloading", { v: s.version || "", p: Math.round((s.progress || 0) * 100) });
    if (downloading?.isConnected) downloading.firstChild.textContent = text;
    else if (manual) downloading = toast(text, "info", { ms: 10 * 60_000 });
    return;
  }
  downloading?.remove();
  downloading = null;
  if (key === shown && s.status !== "none") return;
  shown = key;
  if (s.status === "available") toast(t("upd.available", { v: s.version }), "info", { ms: 60_000, action: { label: t("upd.download"), run: () => { manual = true; call("update.download"); } } });
  else if (s.status === "ready") toast(t("upd.ready", { v: s.version }), "success", { ms: 10 * 60_000, action: { label: t("upd.restart"), run: () => call("update.install") } });
  else if (manual && s.status === "none") toast(t("upd.none", { v: s.current }), "success");
  else if (manual && s.status === "unsupported") toast(t("upd.devOnly"), "info");
  else if (manual && s.status === "error") toast(t("upd.error", { message: s.error || "" }), "error");
  if (!["checking", "available"].includes(s.status)) manual = false;
}

export function wireUpdates() { on("update:status", show); }

export async function checkForUpdates() {
  manual = true;
  shown = "";
  toast(t("upd.checking"), "info", { ms: 2500 });
  const s = await call("update.check").catch((e) => ({ status: "error", error: e?.message }));
  if (s && ["none", "unsupported", "error"].includes(s.status)) show(s);
  return s;
}
