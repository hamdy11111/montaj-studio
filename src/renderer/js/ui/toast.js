// Toast messages: success / error / warning / info, optional action button.
import { h } from "../dom.js";

let host = null;
export function toast(message, type = "info", { action = null, ms = null } = {}) {
  if (!host) { host = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(host); }
  const el = h("div", { class: ["toast", type] }, message,
    action ? h("button", { onclick: () => { action.run(); el.remove(); } }, action.label) : null);
  host.append(el);
  setTimeout(() => el.remove(), ms ?? (type === "error" ? 6000 : 3200));
  return el;
}
