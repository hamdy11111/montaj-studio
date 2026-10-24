// Context / dropdown menus with submenus, check marks, shortcut hints and disabled items.
// items: [{label, icon?, kbd?, checked?, disabled?, danger?, run?, items?: [...]}, "-" (separator)]
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { getLang } from "../i18n.js";

let open = [];
export function closeMenus() { for (const m of open) m.remove(); open = []; document.removeEventListener("mousedown", outside, true); }
function outside(e) { if (!open.some((m) => m.contains(e.target))) closeMenus(); }

function build(items, level) {
  const el = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it === "-" ) { el.append(h("div", { class: "menu-sep" })); continue; }
    if (!it) continue;
    const row = h("div", { class: ["menu-item", it.disabled && "disabled"], role: "menuitem", tabindex: -1, "aria-disabled": it.disabled ? "true" : undefined },
      it.checked !== undefined ? h("span", { class: "check-mark" }, it.checked ? icon("check") : null) : it.icon ? icon(it.icon) : null,
      h("span", { style: it.danger ? { color: "var(--danger)" } : {} }, it.label),
      it.kbd ? h("span", { class: "kbd" }, it.kbd.split("+").map((k) => h("span", {}, k))) : null,
      it.items ? h("span", { class: "arrow" }, icon(getLang() === "ar" ? "chevronRight" : "chevronRight")) : null);
    row.querySelector("svg")?.setAttribute("width", "14");
    if (it.items && !it.disabled) {
      row.addEventListener("mouseenter", () => {
        closeFrom(level + 1);
        row.classList.add("open");
        const r = row.getBoundingClientRect();
        const sub = build(it.items, level + 1);
        place(sub, getLang() === "ar" ? r.left - 4 : r.right + 4, r.top - 4, getLang() === "ar");
      });
    } else {
      row.addEventListener("mouseenter", () => closeFrom(level + 1));
      if (!it.disabled) row.addEventListener("click", () => { closeMenus(); it.run?.(); });
    }
    el.append(row);
  }
  el.dataset.level = level;
  return el;
}
function closeFrom(level) {
  open = open.filter((m) => { if (Number(m.dataset.level) >= level) { m.remove(); return false; } return true; });
  for (const m of open) if (Number(m.dataset.level) === level - 1) m.querySelectorAll(".menu-item.open").forEach((x) => x.classList.remove("open"));
}
function place(el, x, y, alignEnd = false) {
  document.body.append(el);
  open.push(el);
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let left = alignEnd ? x - w : x;
  if (left + w > innerWidth - 4) left = innerWidth - w - 4;
  if (left < 4) left = 4;
  let top = y;
  if (top + hgt > innerHeight - 4) top = Math.max(4, innerHeight - hgt - 4);
  el.style.left = `${left}px`; el.style.top = `${top}px`;
}

export function showMenu(items, x, y) {
  closeMenus();
  const el = build(items, 0);
  place(el, x, y, getLang() === "ar" && x > innerWidth / 2);
  setTimeout(() => document.addEventListener("mousedown", outside, true));
  return el;
}

/** Dropdown under an anchor element. */
export function dropdown(anchor, items) {
  const r = anchor.getBoundingClientRect();
  return showMenu(items, getLang() === "ar" ? r.right : r.left, r.bottom + 4);
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open.length) { e.stopPropagation(); closeMenus(); } }, true);
window.addEventListener("blur", closeMenus);
