// Home (SCREEN-001..012): sidebar navigation, EditPilot box, creative tools, projects (grid/list, search, sort,
// context menu), trash, templates, AI tools, library, spaces, notifications and share history.
import { h, mount, clear, debounce } from "../dom.js";
import { icon } from "../icons.js";
import { t, fmtDate, fmtDateTime, getLang } from "../i18n.js";
import { call, guard, coverUrl, exportUrl } from "../api.js";
import { app } from "../state.js";
import { toast } from "../ui/toast.js";
import { showMenu, dropdown } from "../ui/menu.js";
import { confirmDialog, promptDialog, nameError, modal } from "../ui/modal.js";
import { dataTable } from "../ui/table.js";
import { formatDuration, formatBytes } from "../../core/util.js";
import { SUGGESTIONS } from "../../core/assistant.js";
import { openSettings } from "../dialogs/settings.js";
import { openTrash } from "../dialogs/trash.js";
import { openAbout } from "../dialogs/about.js";
import { openShortsTool, openTtsTool, openProviderOnly } from "../dialogs/tools.js";

const VIEW_KEY = "montaj.home.view";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* per-viewer convenience only */ } },
};

export function renderHome(root, params = {}) {
  let view = params.view || "projects";
  let spaceId = params.spaceId || null;
  const content = h("section", { class: "home-content" });
  const nav = h("nav", { class: "home-nav", "aria-label": t("nav.home") });
  const offs = [];

  function navItem(id, ic, label, extra = {}) {
    const active = view === id && (id !== "space" || extra.spaceId === spaceId);
    return h("button", { class: ["nav-item", active && "active"], "aria-current": active ? "page" : undefined, onclick: () => { view = id; spaceId = extra.spaceId || null; draw(); }, oncontextmenu: extra.oncontextmenu },
      extra.dot ? h("span", { class: "space-dot", style: { background: extra.dot } }) : icon(ic), h("span", { class: "nowrap" }, label));
  }

  async function drawNav() {
    const spaces = (await guard(() => call("workspace.list"))) || [];
    mount(nav,
      h("div", { class: "nav-group" },
        navItem("projects", "home", t("nav.home")), navItem("templates", "template", t("nav.templates")), navItem("tools", "sparkle", t("nav.tools"))),
      h("div", { class: "nav-title" }, t("nav.management")),
      h("div", { class: "nav-group" }, navItem("library", "library", t("nav.library")), navItem("notifications", "bell", t("notif.title")), navItem("shares", "share", t("share.title"))),
      h("div", { class: "nav-title" }, t("nav.spaces")),
      h("div", { class: "nav-group" },
        spaces.map((s) => navItem("space", "cloud", s.name, { spaceId: s.id, dot: s.color, oncontextmenu: (e) => { e.preventDefault(); spaceMenu(s, e); } })),
        h("button", { class: "nav-item muted", onclick: createSpace }, icon("plus"), h("span", {}, t("nav.createSpace")))),
      h("div", { class: "grow" }),
      h("div", { class: "nav-group" },
        h("button", { class: "nav-item", onclick: () => openSettings() }, icon("gear"), h("span", {}, t("ed.settings"))),
        h("button", { class: "nav-item", onclick: () => openAbout() }, icon("info"), h("span", {}, t("ed.about")))));
  }

  async function createSpace() {
    const name = await promptDialog({ title: t("nav.createSpace"), label: t("space.newName"), validate: nameError });
    if (!name) return;
    const s = await guard(() => call("workspace.create", name));
    if (s) { view = "space"; spaceId = s.id; draw(); }
  }
  function spaceMenu(s, e) {
    showMenu([
      { label: t("c.rename"), icon: "design", run: async () => { const n = await promptDialog({ title: t("c.rename"), value: s.name, validate: nameError }); if (n && await guard(() => call("workspace.rename", s.id, n))) draw(); } },
      { label: t("c.delete"), icon: "trash", danger: true, run: async () => { if (await confirmDialog({ title: t("c.delete"), message: t("space.deleteConfirm", { name: s.name }), danger: true, okLabel: t("c.delete") })) { await guard(() => call("workspace.remove", s.id)); view = "projects"; draw(); } } },
    ], e.clientX, e.clientY);
  }

  function draw() {
    drawNav();
    clear(content);
    if (view === "projects") content.append(projectsView(null));
    else if (view === "space") content.append(projectsView(spaceId));
    else if (view === "templates") content.append(templatesView());
    else if (view === "tools") content.append(toolsView());
    else if (view === "library") content.append(libraryView());
    else if (view === "notifications") content.append(notificationsView());
    else if (view === "shares") content.append(sharesView());
  }

  mount(root, h("div", { class: "home" }, nav, content));
  draw();
  offs.push(app.events.on("notifications", () => { if (view === "notifications") draw(); }));
  return () => { offs.forEach((f) => f()); return true; };
}

// ---------------------------------------------------------------- projects
function projectsView(spaceId) {
  const st = { search: "", sort: store.get("montaj.home.sort", "updatedAt"), desc: true, layout: store.get(VIEW_KEY, "grid"), selected: new Set() };
  const listHost = h("div", { class: "projects" });
  const countEl = h("span", { class: "muted" });
  let space = null;

  const header = spaceId ? h("div", { class: "space-head" }) : h("div", { class: "hero" },
    h("h1", {}, t("home.editpilot")),
    editPilotBox(),
    h("div", { class: "suite" },
      suiteCard("plus", t("home.createProject"), t("ed.importHint"), () => createProject(), true),
      suiteCard("scissors", t("tool.longToShorts"), t("tool.longToShortsDesc"), () => openShortsTool()),
      suiteCard("mic", t("tool.tts"), t("tool.ttsDesc"), () => openTtsTool()),
      suiteCard("template", t("nav.templates"), t("lib.templatesEmpty"), () => app.go("home", { view: "templates" }))));

  const sortBtn = h("button", { class: "btn ghost", onclick: (e) => dropdown(e.currentTarget, ["updatedAt", "createdAt", "name", "durationUs", "sizeBytes"].map((k) => ({ label: t(`sort.${k}`), checked: st.sort === k, run: () => { st.desc = st.sort === k ? !st.desc : k !== "name"; st.sort = k; store.set("montaj.home.sort", k); load(); } }))) }, icon("filter"), t("home.sort"));
  const layoutSeg = h("div", { class: "seg" },
    h("button", { class: st.layout === "grid" ? "active" : "", title: t("home.grid"), "aria-label": t("home.grid"), onclick: () => { st.layout = "grid"; store.set(VIEW_KEY, "grid"); redraw(); refreshSeg(); } }, icon("grid")),
    h("button", { class: st.layout === "list" ? "active" : "", title: t("home.list"), "aria-label": t("home.list"), onclick: () => { st.layout = "list"; store.set(VIEW_KEY, "list"); redraw(); refreshSeg(); } }, icon("layout")));
  const refreshSeg = () => { const [a, b] = layoutSeg.children; a.classList.toggle("active", st.layout === "grid"); b.classList.toggle("active", st.layout === "list"); };
  const search = h("input", { type: "search", placeholder: t("home.searchPh"), "aria-label": t("home.searchPh"), oninput: debounce((e) => { st.search = e.target.value.trim(); load(); }, 200) });
  const toolbar = h("div", { class: "proj-toolbar" },
    h("h2", {}, spaceId ? "" : t("home.projects"), " ", countEl),
    h("div", { class: "search" }, icon("search"), search), h("div", { class: "grow" }),
    sortBtn, layoutSeg,
    h("button", { class: "btn ghost", onclick: importPackage }, icon("download"), t("home.importPackage")),
    h("button", { class: "btn ghost", onclick: () => openTrash(() => load()) }, icon("trash"), t("home.trash")));

  let items = [];
  async function load() {
    clear(listHost).append(h("div", { class: "loading" }, h("div", { class: "spinner" }), t("c.loading")));
    if (spaceId) {
      const spaces = (await guard(() => call("workspace.list"))) || [];
      space = spaces.find((s) => s.id === spaceId);
      mount(header, h("div", { class: "row" }, h("span", { class: "space-dot big", style: { background: space?.color } }), h("h1", {}, space?.name || ""), h("span", { class: "muted" }, t("space.used", { used: formatBytes(space?.usedBytes || 0), quota: space?.quotaBytes ? formatBytes(space.quotaBytes) : t("space.unlimited") }))));
    }
    const r = await guard(() => call("project.list", { search: st.search, sort: st.sort, desc: st.desc, workspaceId: spaceId }));
    items = r || [];
    if (spaceId && space) items = items.filter((p) => space.projectIds.includes(p.id));
    redraw();
  }

  function redraw() {
    countEl.textContent = items.length ? `(${items.length})` : "";
    clear(listHost);
    if (!items.length) {
      listHost.append(h("div", { class: "empty" }, icon(st.search ? "search" : "video"), h("div", {}, st.search ? t("home.noResults") : spaceId ? t("space.empty") : t("home.empty")),
        !st.search && !spaceId ? h("button", { class: "btn primary", onclick: () => createProject() }, icon("plus"), t("home.createProject")) : null));
      return;
    }
    if (st.layout === "grid") {
      listHost.append(h("div", { class: "proj-grid" }, items.map((p) => h("div", { class: "proj-card", tabindex: 0, title: p.name,
        ondblclick: () => openProject(p), onkeydown: (e) => { if (e.key === "Enter") openProject(p); }, onclick: () => openProject(p), oncontextmenu: (e) => { e.preventDefault(); projectMenu(p, e); } },
      h("div", { class: "proj-cover" }, p.coverPath ? h("img", { src: coverUrl(p.id, p.updatedAt), alt: "", loading: "lazy", onerror: (e) => e.target.remove() }) : icon("video"),
        h("span", { class: "proj-dur" }, formatDuration(p.durationUs)),
        h("button", { class: "icon-btn proj-more", "aria-label": t("ed.more"), onclick: (e) => { e.stopPropagation(); projectMenu(p, e); } }, icon("more"))),
      h("div", { class: "proj-name nowrap" }, p.name),
      h("div", { class: "proj-meta muted" }, `${formatBytes(p.sizeBytes)} · ${fmtDate(p.updatedAt)}`)))));
    } else {
      const table = dataTable({
        columns: [
          { key: "name", label: t("col.name"), render: (p) => h("div", { class: "row" }, p.coverPath ? h("img", { class: "thumb", src: coverUrl(p.id, p.updatedAt), alt: "" }) : h("div", { class: "thumb" }), h("span", { class: "nowrap" }, p.name)), sort: (p) => p.name.toLowerCase() },
          { key: "sizeBytes", label: t("col.size"), render: (p) => formatBytes(p.sizeBytes) },
          { key: "durationUs", label: t("col.duration"), render: (p) => formatDuration(p.durationUs) },
          { key: "updatedAt", label: t("col.lastEdited"), render: (p) => fmtDateTime(p.updatedAt) },
          { key: "createdAt", label: t("col.created"), render: (p) => fmtDateTime(p.createdAt) },
        ],
        rows: items, searchKeys: ["name"], onRowClick: (p) => openProject(p), onRowContext: (p, e) => projectMenu(p, e), initialSort: { key: st.sort, asc: !st.desc },
      });
      table.querySelector(".search")?.parentElement?.remove(); // the page-level search already filters
      listHost.append(table);
    }
  }

  async function projectMenu(p, e) {
    const spaces = (await guard(() => call("workspace.list"))) || [];
    showMenu([
      { label: t("proj.open"), icon: "video", run: () => openProject(p) },
      { label: t("proj.rename"), icon: "design", run: async () => { const n = await promptDialog({ title: t("proj.rename"), label: t("proj.renamePrompt"), value: p.name, validate: nameError }); if (n && await guard(() => call("project.rename", p.id, n))) load(); } },
      { label: t("proj.duplicate"), icon: "layers", run: async () => { if (await guard(() => call("project.duplicate", p.id))) load(); } },
      { label: t("proj.saveTemplate"), icon: "template", run: async () => { const r = await guard(() => call("template.save", p.id, { name: p.name })); if (r) toast(t("c.saved"), "success"); } },
      { label: t("proj.share"), icon: "share", run: () => exportPackage(p) },
      spaces.length ? { label: t("proj.addToSpace"), icon: "cloud", items: spaces.map((s) => ({ label: s.name, checked: s.projectIds.includes(p.id), run: async () => { await guard(() => call(s.projectIds.includes(p.id) ? "workspace.removeProject" : "workspace.addProject", s.id, p.id)); load(); } })) } : null,
      "-",
      { label: t("proj.delete"), icon: "trash", danger: true, run: async () => { if (await confirmDialog({ title: t("proj.delete"), message: t("proj.deleteConfirm", { name: p.name }), okLabel: t("c.delete"), danger: true })) { if (await guard(() => call("project.trash", p.id)) !== undefined) { toast(t("trash.title"), "success", { action: { label: t("trash.restore"), run: async () => { await guard(() => call("project.restore", p.id)); load(); } } }); load(); } } } },
    ], e.clientX, e.clientY);
  }

  load();
  return h("div", { class: "projects-view" }, header, toolbar, listHost);
}

function suiteCard(ic, title, desc, run, primary = false) {
  return h("button", { class: ["suite-card", primary && "primary"], onclick: run }, h("div", { class: "suite-icon" }, icon(ic)), h("div", { class: "suite-title" }, title), h("div", { class: "suite-desc muted" }, desc));
}

function editPilotBox() {
  const ta = h("textarea", { rows: 2, placeholder: t("home.editpilotPh"), "aria-label": t("home.editpilotPh"), maxlength: 2000 });
  const go = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const plan = await guard(() => call("assistant.plan", text, { hasSelection: false }));
    if (!plan) return;
    if (!plan.understood) { toast(t("ai.notUnderstood"), "warning"); return; }
    const p = await guard(() => call("project.create", {}));
    if (p) app.go("editor", { projectId: p.id, pilot: text });
  };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
  return h("div", { class: "pilot" }, ta,
    h("div", { class: "row" },
      h("div", { class: "chips grow" }, SUGGESTIONS.slice(0, 4).map((s) => h("button", { class: "chip", onclick: () => { ta.value = getLang() === "ar" ? s.ar : s.en; ta.focus(); } }, getLang() === "ar" ? s.ar : s.en))),
      h("span", { class: "badge local" }, t("c.local")),
      h("button", { class: "icon-btn active", "aria-label": t("ai.title"), onclick: go }, icon("send"))),
    h("div", { class: "muted small" }, t("ai.local")));
}

async function createProject(opts = {}) {
  const p = await guard(() => call("project.create", opts));
  if (p) app.go("editor", { projectId: p.id });
}
function openProject(p) { app.go("editor", { projectId: p.id }); }

async function exportPackage(p) {
  const file = await call("dialog.saveFile", { title: t("proj.share"), defaultPath: `${p.name}.mstudio`, filters: [{ name: "Montaj package", extensions: ["mstudio"] }] });
  if (!file) return;
  const tst = toast(t("c.loading"), "info", { ms: 60_000 });
  const r = await guard(() => call("package.export", p.id, file));
  tst.remove();
  if (r) toast(t("c.done"), "success", { action: { label: t("ex.openFolder"), run: () => call("app.showInFolder", file) } });
}
async function importPackage() {
  const [file] = await call("dialog.openFiles", { kind: "package" });
  if (!file) return;
  const tst = toast(t("c.loading"), "info", { ms: 60_000 });
  const p = await guard(() => call("package.import", file));
  tst.remove();
  if (p) { toast(t("c.done"), "success"); app.go("editor", { projectId: p.id }); }
}

// ---------------------------------------------------------------- templates (SCREEN-005)
function templatesView() {
  const st = { search: "", orientation: "all", clips: "any", duration: "any", favorite: false };
  const grid = h("div", { class: "proj-grid" });
  const filters = h("div", { class: "proj-toolbar" },
    h("div", { class: "search" }, icon("search"), h("input", { type: "search", placeholder: t("c.search"), oninput: debounce((e) => { st.search = e.target.value.trim(); load(); }, 200) })),
    sel(t("c.orientation"), "orientation", [["all", t("c.all")], ["landscape", t("c.landscape")], ["portrait", t("c.portrait")], ["square", t("c.square")]]),
    sel(t("c.clips"), "clips", [["any", t("c.noLimit")], ["1", "1"], ["2-5", "2–5"], ["6-10", "6–10"], [">10", ">10"]]),
    sel(t("c.duration"), "duration", [["any", t("c.noLimit")], ["0-15", "0–15s"], ["15-60", "15–60s"], ["60-180", "1–3m"], [">180", ">3m"]]),
    h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { st.favorite = e.target.checked; load(); } }), t("lib.favorites")));
  function sel(label, key, opts) {
    return h("label", { class: "row" }, h("span", { class: "muted" }, label), h("select", { onchange: (e) => { st[key] = e.target.value; load(); } }, opts.map(([v, l]) => h("option", { value: v }, l))));
  }
  async function load() {
    mount(grid, h("div", { class: "loading" }, h("div", { class: "spinner" })));
    const items = (await guard(() => call("template.list", st))) || [];
    clear(grid);
    if (!items.length) { grid.append(h("div", { class: "empty", style: { gridColumn: "1/-1" } }, icon("template"), h("div", {}, st.search ? t("home.noResults") : t("lib.templatesEmpty")))); return; }
    for (const tp of items) {
      grid.append(h("div", { class: "proj-card", tabindex: 0, title: tp.name, oncontextmenu: (e) => { e.preventDefault(); menu(tp, e); } },
        h("div", { class: "proj-cover" }, tp.coverPath ? h("img", { src: coverUrl(tp.id, tp.updatedAt), alt: "" }) : icon("template"),
          h("span", { class: "proj-dur" }, formatDuration(tp.durationUs)),
          h("button", { class: "icon-btn proj-fav", "aria-label": t("c.favorite"), onclick: async (e) => { e.stopPropagation(); await guard(() => call("template.toggleFavorite", tp.id)); load(); } }, icon(tp.template?.favorite ? "starFill" : "star"))),
        h("div", { class: "proj-name nowrap" }, tp.name),
        h("div", { class: "proj-meta muted" }, `${t("c.clips")}: ${tp.template?.clipCount || 0} · ${t("c.used", { n: tp.template?.usageCount || 0 })}`),
        h("button", { class: "btn primary small block", onclick: async () => { const p = await guard(() => call("template.use", tp.id)); if (p) app.go("editor", { projectId: p.id }); } }, t("c.useTemplate"))));
    }
  }
  function menu(tp, e) {
    showMenu([
      { label: t("c.rename"), run: async () => { const n = await promptDialog({ title: t("c.rename"), value: tp.name, validate: nameError }); if (n && await guard(() => call("project.rename", tp.id, n))) load(); } },
      { label: t("c.delete"), danger: true, run: async () => { if (await confirmDialog({ title: t("c.delete"), message: t("trash.deleteForeverConfirm", { name: tp.name }), danger: true, okLabel: t("c.delete") })) { await guard(() => call("project.deleteForever", tp.id)); load(); } } },
    ], e.clientX, e.clientY);
  }
  load();
  return h("div", {}, h("h1", {}, t("nav.templates")), filters, grid);
}

// ---------------------------------------------------------------- AI tools (SCREEN-006/007)
function toolsView() {
  const local = [
    ["scissors", t("tool.longToShorts"), t("tool.longToShortsDesc"), openShortsTool],
    ["mic", t("tool.tts"), t("tool.ttsDesc"), openTtsTool],
  ];
  const remote = [["video", t("tool.aiVideo")], ["image", t("tool.aiImage")], ["fit", t("tool.extend")], ["sparkle", t("tool.adMaker")], ["design", t("tool.designStudio")], ["media", t("tool.videoStudio")], ["chat", t("tool.marketing")]];
  return h("div", {},
    h("h1", {}, t("nav.tools")),
    h("div", { class: "suite" }, local.map(([ic, title, desc, run]) => h("button", { class: "suite-card", onclick: () => run() }, h("div", { class: "suite-icon" }, icon(ic)), h("div", { class: "suite-title" }, title, " ", h("span", { class: "badge local" }, t("c.local"))), h("div", { class: "suite-desc muted" }, desc)))),
    h("h2", { style: { marginTop: "24px" } }, t("tool.providerOnly")),
    h("div", { class: "suite" }, remote.map(([ic, title]) => h("button", { class: "suite-card disabled-card", onclick: () => openProviderOnly(title) }, h("div", { class: "suite-icon" }, icon(ic)), h("div", { class: "suite-title" }, title, " ", h("span", { class: "badge na" }, t("c.notAvailable"))), h("div", { class: "suite-desc muted" }, t("tool.providerOnly"))))));
}

// ---------------------------------------------------------------- library (SCREEN-008)
function libraryView() {
  let tab = "generated";
  const body = h("div");
  const tabs = h("div", { class: "tabs inline" });
  function drawTabs() {
    mount(tabs, ...[["generated", t("lib.generated")], ["elements", t("lib.elements")]].map(([id, label]) => h("button", { class: tab === id ? "active" : "", onclick: () => { tab = id; drawTabs(); load(); } }, label)));
  }
  async function load() {
    mount(body, h("div", { class: "loading" }, h("div", { class: "spinner" })));
    if (tab === "generated") {
      const rows = (await guard(() => call("export.list", {}))) || [];
      mount(body, h("p", { class: "muted" }, t("lib.genHint")), dataTable({
        columns: [
          { key: "projectName", label: t("col.name"), render: (r) => h("span", { class: "nowrap" }, r.path.split(/[\\/]/).pop()) },
          { key: "kind", label: t("ex.format") },
          { key: "status", label: "", render: (r) => h("span", { class: ["badge", r.status === "done" ? "local" : "na"] }, r.status) },
          { key: "sizeBytes", label: t("col.size"), render: (r) => formatBytes(r.sizeBytes || 0) },
          { key: "startedAt", label: t("col.created"), render: (r) => fmtDateTime(r.startedAt) },
          { key: "actions", label: "", sortable: false, render: (r) => h("div", { class: "row" },
            r.status === "done" ? h("button", { class: "btn small", onclick: (e) => { e.stopPropagation(); call("app.openPath", r.path).catch(() => toast(t("err.fileNotFound"), "error")); } }, t("ex.play")) : null,
            h("button", { class: "btn small ghost", onclick: (e) => { e.stopPropagation(); call("app.showInFolder", r.path); } }, t("ex.openFolder")),
            h("button", { class: "icon-btn", "aria-label": t("c.remove"), onclick: async (e) => { e.stopPropagation(); await guard(() => call("export.remove", r.id)); load(); } }, icon("close"))) },
        ],
        rows, searchKeys: ["projectName", "path"], initialSort: { key: "startedAt", asc: false }, emptyText: t("lib.genHint"),
        filters: { value: "all", options: [{ value: "all", label: t("c.all") }, ...["video", "audio", "gif", "still", "captions"].map((k) => ({ value: k, label: k }))], test: (r, v) => r.kind === v },
      }));
    } else {
      const rows = (await guard(() => call("library.list", {}))) || [];
      const add = (kind, dialogKind) => async () => {
        const files = await call("dialog.openFiles", { kind: dialogKind, multi: true });
        if (files.length && await guard(() => call("library.importFiles", kind, files, "yours"))) load();
      };
      mount(body, h("div", { class: "row", style: { marginBottom: "8px" } }, h("p", { class: "muted grow" }, t("lib.elemHint")),
        h("button", { class: "btn", onclick: add("audio", "audio") }, icon("audio"), t("lib.importAudio")),
        h("button", { class: "btn", onclick: add("sticker", "image") }, icon("sticker"), t("lib.importSticker")),
        h("button", { class: "btn", onclick: add("lut", "lut") }, icon("filter"), t("lib.importLut"))),
      dataTable({
        columns: [
          { key: "name", label: t("col.name") }, { key: "kind", label: t("ex.format") },
          { key: "sizeBytes", label: t("col.size"), render: (r) => formatBytes(r.sizeBytes || 0) },
          { key: "createdAt", label: t("col.created"), render: (r) => fmtDateTime(r.createdAt) },
          { key: "x", label: "", sortable: false, render: (r) => h("button", { class: "icon-btn", "aria-label": t("c.remove"), onclick: async (e) => { e.stopPropagation(); if (await confirmDialog({ title: t("c.remove"), message: r.name, danger: true, okLabel: t("c.delete") })) { await guard(() => call("library.remove", r.id)); load(); } } }, icon("trash")) },
        ],
        rows, searchKeys: ["name"], emptyText: t("lib.elemHint"),
        filters: { value: "all", options: [{ value: "all", label: t("c.all") }, ...["audio", "sticker", "lut"].map((k) => ({ value: k, label: k }))], test: (r, v) => r.kind === v },
      }));
    }
  }
  drawTabs(); load();
  return h("div", {}, h("h1", {}, t("nav.library")), tabs, body);
}

// ---------------------------------------------------------------- notifications & shares (SCREEN-011/012)
function notificationsView() {
  const list = app.notifications;
  return h("div", {}, h("h1", {}, t("notif.title")),
    list.length ? h("div", { class: "notif-list" }, list.map((n) => h("div", { class: "notif" }, icon(n.ok === false ? "warning" : "check"), h("div", { class: "grow" }, h("div", {}, n.text), h("div", { class: "muted small" }, fmtDateTime(n.at))),
      n.path ? h("button", { class: "btn small", onclick: () => call("app.showInFolder", n.path) }, t("ex.openFolder")) : null)))
      : h("div", { class: "empty" }, icon("bell"), h("div", {}, t("notif.empty"))));
}

function sharesView() {
  const body = h("div");
  let dir = "out";
  const tabs = h("div", { class: "tabs inline" });
  const drawTabs = () => mount(tabs, ...[["out", t("share.byYou")], ["in", t("share.withYou")]].map(([id, l]) => h("button", { class: dir === id ? "active" : "", onclick: () => { dir = id; drawTabs(); load(); } }, l)));
  async function load() {
    const rows = (await guard(() => call("share.list", dir))) || [];
    mount(body, dataTable({
      columns: [{ key: "projectName", label: t("col.name") }, { key: "packagePath", label: t("in.path"), render: (r) => h("span", { class: "nowrap ltr", title: r.packagePath }, r.packagePath) },
        { key: "createdAt", label: t("col.created"), render: (r) => fmtDateTime(r.createdAt) },
        { key: "x", label: "", sortable: false, render: (r) => h("button", { class: "btn small ghost", onclick: () => call("app.showInFolder", r.packagePath) }, t("ex.openFolder")) }],
      rows, searchKeys: ["projectName", "packagePath"], emptyText: t("share.empty"), initialSort: { key: "createdAt", asc: false },
    }));
  }
  drawTabs(); load();
  return h("div", {}, h("h1", {}, t("share.title")), tabs, body);
}

export { exportUrl, modal };
