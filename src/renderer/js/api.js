// Thin wrapper over the preload bridge. call() resolves with data or rejects with {code, messageKey, details};
// safe() shows the error as a toast and resolves to `fallback` instead of throwing.
import { toast } from "./ui/toast.js";
import { errorText, t } from "./i18n.js";

export const call = (method, ...args) => window.api.call(method, ...args);
export const on = (event, fn) => window.api.on(event, fn);
export const pathForFile = (file) => window.api.pathForFile(file);

/** An error toast; "speech not ready" offers to prepare the Egyptian model right there. */
export function errorToast(err) {
  const setup = err?.messageKey === "err.whisperNotConfigured"
    ? { label: t("asr.setupNow"), run: () => import("./dialogs/asrSetup.js").then((m) => m.openAsrSetup()) } : null;
  return toast(errorText(err), "error", { action: setup, ms: setup ? 12000 : null });
}

export async function safe(method, ...args) {
  try { return await call(method, ...args); } catch (err) { errorToast(err); return undefined; }
}

/** Run an async action, reporting failures as toasts; returns the result or undefined. */
export async function guard(fn) {
  try { return await fn(); } catch (err) { errorToast(err); if (!err?.messageKey) console.error(err); return undefined; }
}

export const mediaUrl = (id, { proxy = false } = {}) => `media://asset/${encodeURIComponent(id)}${proxy ? "?proxy=1" : ""}`;
export const thumbUrl = (id, v = "") => `media://thumb/${encodeURIComponent(id)}${v ? `?v=${v}` : ""}`;
export const coverUrl = (id, v = "") => `media://cover/${encodeURIComponent(id)}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
export const libUrl = (id) => `media://lib/${encodeURIComponent(id)}`;
export const stickerUrl = (builtin) => `media://sticker/${encodeURIComponent(builtin)}`;
export const exportUrl = (id) => `media://export/${encodeURIComponent(id)}`;
