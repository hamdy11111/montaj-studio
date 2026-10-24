// Data table with search, column sort and an optional filter select. Pure view over an array of rows.
// columns: [{key, label, render?(row), sort?(row) → comparable, width?}]
import { h, clear, debounce } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

export function dataTable({ columns, rows, searchKeys = [], filters = null, onRowClick, onRowContext, emptyText, initialSort = null, rowClass }) {
  const state = { q: "", sort: initialSort || { key: null, asc: true }, filter: filters ? filters.value : null };
  const body = h("tbody");
  const head = h("thead", {}, h("tr", {}, columns.map((c) => {
    const th = h("th", { style: c.width ? { width: c.width } : {}, onclick: () => { if (c.sortable === false) return; state.sort = { key: c.key, asc: state.sort.key === c.key ? !state.sort.asc : true }; render(); } }, c.label);
    th.dataset.key = c.key;
    return th;
  })));
  const search = h("input", { type: "search", placeholder: t("c.search"), "aria-label": t("c.search"), oninput: debounce((e) => { state.q = e.target.value.trim().toLowerCase(); render(); }, 150) });
  const filterSel = filters ? h("select", { "aria-label": t("c.filter"), onchange: (e) => { state.filter = e.target.value; render(); } }, filters.options.map((o) => h("option", { value: o.value, selected: o.value === state.filter }, o.label))) : null;
  const empty = h("div", { class: "empty hidden" }, icon("search"), h("div", {}, emptyText || t("home.noResults")));
  let data = rows;

  function render() {
    for (const th of head.querySelectorAll("th")) { th.classList.toggle("sorted", th.dataset.key === state.sort.key); th.classList.toggle("asc", th.dataset.key === state.sort.key && state.sort.asc); }
    let list = data.filter((r) => !state.q || searchKeys.some((k) => String(typeof k === "function" ? k(r) : r[k] ?? "").toLowerCase().includes(state.q)));
    if (filters && state.filter && state.filter !== "all") list = list.filter((r) => filters.test(r, state.filter));
    const col = columns.find((c) => c.key === state.sort.key);
    if (col) {
      const val = col.sort || ((r) => r[col.key]);
      list = [...list].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (state.sort.asc ? 1 : -1); });
    }
    clear(body);
    for (const r of list) {
      const tr = h("tr", { class: rowClass?.(r) || "", onclick: (e) => onRowClick?.(r, e), oncontextmenu: (e) => { if (onRowContext) { e.preventDefault(); onRowContext(r, e); } } },
        columns.map((c) => h("td", {}, c.render ? c.render(r) : String(r[c.key] ?? ""))));
      body.append(tr);
    }
    empty.classList.toggle("hidden", list.length > 0);
  }
  render();
  const el = h("div", { class: "data-table" }, h("div", { class: "row", style: { marginBottom: "8px" } }, h("div", { class: "search grow" }, icon("search"), search), filterSel),
    h("table", { class: "table" }, head, body), empty);
  el.setRows = (r) => { data = r; render(); };
  return el;
}
