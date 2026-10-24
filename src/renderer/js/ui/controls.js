// Form controls used by the inspector and dialogs. Each returns an element; callbacks receive parsed values.
// Sliders emit onInput while dragging (coalesced into one undo step by the caller) and onChange on release.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

/** Slider with a synced number box. o: {label, min, max, step, value, unit, onInput, onChange, gradient, keyframe} */
export function slider(o) {
  const step = o.step ?? 1;
  const range = h("input", { type: "range", min: o.min, max: o.max, step, value: o.value, class: o.gradient ? "gradient" : "", "aria-label": o.label });
  if (o.gradient) range.style.setProperty("--track-bg", o.gradient);
  const num = h("input", { type: "number", min: o.min, max: o.max, step, value: fmt(o.value, step), "aria-label": o.label });
  const clampV = (v) => Math.min(o.max, Math.max(o.min, v));
  range.addEventListener("input", () => { num.value = fmt(Number(range.value), step); o.onInput?.(Number(range.value)); });
  range.addEventListener("change", () => o.onChange?.(Number(range.value)));
  num.addEventListener("change", () => {
    const v = Number(num.value);
    if (!Number.isFinite(v)) { num.classList.add("invalid"); return; }
    num.classList.remove("invalid");
    const c = clampV(v); num.value = fmt(c, step); range.value = c;
    o.onInput?.(c); o.onChange?.(c);
  });
  const row = h("div", { class: "slider-row" }, range, h("div", { class: "num" }, num, o.unit ? h("span", { class: "muted", style: { marginInlineStart: "4px" } }, o.unit) : null), o.keyframe || h("span"));
  const el = o.label ? h("div", { class: "ctl" }, h("div", { class: "ctl-label" }, o.label), row) : row;
  el.setValue = (v) => { range.value = v; num.value = fmt(v, step); };
  return el;
}
const fmt = (v, step) => (step < 1 ? Number(v).toFixed(String(step).split(".")[1]?.length || 2) : String(Math.round(v)));

export function toggle({ checked, onChange, label }) {
  const input = h("input", { type: "checkbox", checked: !!checked, "aria-label": label || "" });
  input.addEventListener("change", () => onChange?.(input.checked));
  return h("label", { class: "toggle" }, input, h("span"));
}

export function check({ checked, onChange, label }) {
  const input = h("input", { type: "checkbox", checked: !!checked });
  input.addEventListener("change", () => onChange?.(input.checked));
  return h("label", { class: "check" }, input, label);
}

/** options: [{value, label}] or [value] */
export function select({ value, options, onChange, label, style }) {
  const el = h("select", { "aria-label": label || "", style },
    options.map((op) => { const v = typeof op === "object" ? op.value : op; const l = typeof op === "object" ? op.label : String(op); return h("option", { value: String(v), selected: String(v) === String(value) }, l); }));
  el.addEventListener("change", () => onChange?.(el.value));
  return el;
}

export function segmented({ value, options, onChange }) {
  const el = h("div", { class: "seg", role: "tablist" });
  for (const op of options) {
    const b = h("button", { class: op.value === value ? "active" : "", role: "tab", "aria-selected": op.value === value ? "true" : "false", onclick: () => { el.querySelectorAll("button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); onChange?.(op.value); } }, op.icon ? icon(op.icon) : null, op.label);
    el.append(b);
  }
  return el;
}

export function colorInput({ value, onChange, onInput, label }) {
  const el = h("input", { type: "color", value: (value || "#000000").slice(0, 7), "aria-label": label || "", class: "color-input" });
  el.addEventListener("input", () => onInput?.(el.value.toUpperCase()));
  el.addEventListener("change", () => onChange?.(el.value.toUpperCase()));
  return el;
}

export function textInput({ value, placeholder, onChange, maxLength = 500, style }) {
  const el = h("input", { type: "text", value: value ?? "", placeholder: placeholder || "", maxlength: maxLength, style });
  el.addEventListener("change", () => onChange?.(el.value));
  return el;
}

/** Labelled row: label + control (+ optional hint). */
export function row(label, control, hint) {
  return h("div", { class: "form-row" }, h("div", { class: "label" }, label), h("div", { class: "row" }, control), hint ? h("div", { class: "hint" }, hint) : null);
}

/** Collapsible inspector section with an optional enable toggle and reset button. */
export function section({ title, enabled, onToggle, onReset, open = true, children }) {
  const body = h("div", { class: "sec-body" }, children);
  const head = h("div", { class: "sec-head" },
    h("button", { class: "sec-caret", "aria-expanded": open ? "true" : "false", onclick: () => { body.classList.toggle("hidden"); head.querySelector(".sec-caret").setAttribute("aria-expanded", body.classList.contains("hidden") ? "false" : "true"); } }, icon("chevronDown")),
    enabled !== undefined ? h("input", { type: "checkbox", class: "sec-check", checked: !!enabled, onchange: (e) => onToggle?.(e.target.checked), "aria-label": title }) : null,
    h("span", { class: "grow" }, title),
    onReset ? h("button", { class: "icon-btn", title: t("in.reset"), "aria-label": t("in.reset"), onclick: onReset }, icon("undo")) : null);
  if (!open) body.classList.add("hidden");
  return h("div", { class: "sec" }, head, body);
}

/** Grid of selectable tiles (filters, effects, animations…). */
export function tileGrid({ items, value, onPick, render }) {
  const el = h("div", { class: "tiles" });
  for (const it of items) {
    const tile = h("button", { class: ["tile", it.id === value && "active"], title: it.label, onclick: () => { el.querySelectorAll(".tile").forEach((x) => x.classList.remove("active")); tile.classList.add("active"); onPick(it); } },
      render ? render(it) : h("div", { class: "tile-art" }, icon(it.icon || "effect")), h("div", { class: "tile-label nowrap" }, it.label));
    el.append(tile);
  }
  return el;
}
