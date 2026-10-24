// Modal dialogs, confirmation and text prompts. Escape / backdrop click close; focus goes to the first field.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

const stack = [];

/**
 * @param {{title: string, body: Node|Node[], footer?: Node[], width?: number, onClose?: () => (boolean|void), className?: string, closable?: boolean}} o
 * @returns {{el: HTMLElement, close: () => void}}
 */
export function modal(o) {
  const card = h("div", { class: ["modal", o.className], role: "dialog", "aria-modal": "true", "aria-label": o.title, style: o.width ? { width: `${o.width}px` } : {} },
    h("div", { class: "modal-head" }, h("span", {}, o.title),
      o.closable === false ? null : h("button", { class: "icon-btn", "aria-label": t("c.close"), onclick: () => close() }, icon("close"))),
    h("div", { class: "modal-body" }, o.body),
    o.footer ? h("div", { class: ["modal-foot", o.equalFooter && "equal"] }, o.footer) : null);
  const back = h("div", { class: "backdrop", onmousedown: (e) => { if (e.target === back && o.closable !== false) close(); } }, card);
  const onKey = (e) => { if (e.key === "Escape" && stack[stack.length - 1] === api && o.closable !== false) { e.stopPropagation(); close(); } };
  let closed = false;
  function close(force = false) {
    if (closed) return;
    if (!force && o.onClose && o.onClose() === false) return;
    closed = true;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    stack.splice(stack.indexOf(api), 1);
  }
  const api = { el: card, close, backdrop: back };
  stack.push(api);
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  requestAnimationFrame(() => card.querySelector("input:not([type=hidden]), textarea, select, button.primary")?.focus());
  return api;
}

export const anyModalOpen = () => stack.length > 0;

/** Confirmation dialog; resolves true/false. */
export function confirmDialog({ title, message, okLabel = t("c.ok"), cancelLabel = t("c.cancel"), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title, width: 420, body: h("p", { style: { margin: "4px 0 8px", lineHeight: 1.6 } }, message),
      footer: [h("button", { class: "btn", onclick: () => m.close() }, cancelLabel),
        h("button", { class: ["btn", danger ? "danger" : "primary"], onclick: () => { result = true; m.close(); } }, okLabel)],
      onClose: () => { setTimeout(() => resolve(result)); },
    });
  });
}

/** Text prompt with validation; validate(value) returns an error string or null. Resolves string or null. */
export function promptDialog({ title, label = "", value = "", placeholder = "", okLabel = t("c.ok"), validate = null, maxLength = 255 }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h("input", { type: "text", value, placeholder, maxlength: maxLength, style: { width: "100%" } });
    const err = h("div", { class: "field-error" });
    const ok = h("button", { class: "btn primary" }, okLabel);
    const submit = () => {
      const v = input.value.trim();
      const e = validate ? validate(v) : v ? null : t("err.nameRequired");
      if (e) { err.textContent = e; input.classList.add("invalid"); return; }
      result = v; m.close();
    };
    ok.onclick = submit;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    input.addEventListener("input", () => { err.textContent = ""; input.classList.remove("invalid"); });
    const m = modal({
      title, width: 420,
      body: h("div", { class: "col" }, label ? h("label", { class: "muted" }, label) : null, input, err),
      footer: [h("button", { class: "btn", onclick: () => m.close() }, t("c.cancel")), ok],
      onClose: () => { setTimeout(() => resolve(result)); },
    });
    requestAnimationFrame(() => input.select());
  });
}

/** Client-side mirror of the main-process name rule (validation.js) for instant feedback. */
export function nameError(v) {
  if (!v) return t("err.nameRequired");
  if (v.length > 255) return t("err.nameTooLong");
  if (/[\\/:*?"<>|]/.test(v)) return t("err.nameChars");
  if (v.startsWith(".")) return t("err.nameDot");
  return null;
}
