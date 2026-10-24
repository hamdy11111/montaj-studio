// Settings › Agents & MCP: turn the local Agent Control Server on/off, create agent clients (scopes, projects,
// import folders, export folder), show each client's MCP configuration for Claude Code / Codex / other MCP hosts,
// revoke clients and read the audit log. The token is shown once at creation; afterwards only its file is referenced.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t, fmtDateTime, errorText } from "../i18n.js";
import { call, guard } from "../api.js";
import { app } from "../state.js";
import { modal, confirmDialog } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { toggle, row, check } from "../ui/controls.js";

const SCOPE_DEFAULTS = ["read", "media", "edit", "skills.run"];

const copyBtn = (text) => h("button", { class: "btn small", onclick: async () => { if (await guard(() => call("app.copyText", text))) toast(t("ag.copied"), "success"); } }, t("ag.copy"));
const snippet = (title, text) => h("div", { class: "col" }, h("div", { class: "row" }, h("b", { class: "grow" }, title), copyBtn(text)), h("pre", { class: "code-block ltr" }, text));

/** The MCP configuration for one client, ready to paste into each host. */
export function configView(cfg) {
  return h("div", { class: "col" },
    h("p", { class: "muted small", style: { lineHeight: 1.6 } }, t("ag.configHint")),
    snippet("Claude Code", cfg.claudeCode),
    snippet("Codex (~/.codex/config.toml)", cfg.codexToml),
    snippet(t("ag.genericJson"), JSON.stringify(cfg.json, null, 2)));
}

export async function drawAgentsPane(pane, redraw) {
  const st = await guard(() => call("agents.status"));
  if (!st) return;
  const clients = st.clients.filter((c) => !c.revoked);
  const auditEl = h("div", { class: "col audit-log" });
  mount(pane,
    h("p", { class: "muted", style: { lineHeight: 1.7 } }, t("ag.explain")),
    row(t("ag.enable"), toggle({ checked: st.enabled, label: t("ag.enable"), onChange: async (v) => {
      if (await guard(() => call("settings.set", "agents", { enabled: v })) === undefined) return;
      app.settings.agents = { ...(app.settings.agents || {}), enabled: v };
      setTimeout(redraw, 250);
    } }), st.listening ? h("span", { class: "badge local ltr", title: st.pipe }, t("ag.listening")) : h("span", { class: "badge na" }, t("ag.off"))),
    st.lastError ? h("div", { class: "field-error ltr" }, st.lastError) : null,
    h("div", { class: "row" }, h("h3", { class: "grow" }, t("ag.clients")), h("button", { class: "btn primary small", onclick: () => newClient(redraw) }, icon("plus"), t("ag.newClient"))),
    clients.length ? h("div", { class: "col" }, clients.map((c) => h("div", { class: "row backup-row" },
      h("div", { class: "grow" }, h("div", {}, h("b", {}, c.name)),
        h("div", { class: "muted small ltr" }, c.scopes.join(", ")),
        h("div", { class: "muted small" }, `${c.projects === "*" ? t("ag.allProjects") : t("ag.someProjects", { n: c.projects.length })} · ${c.lastSeenAt ? t("ag.lastSeen", { at: fmtDateTime(c.lastSeenAt) }) : t("ag.neverSeen")}`)),
      h("button", { class: "btn small", onclick: async () => { const cfg = await guard(() => call("agents.config", c.id)); if (cfg) modal({ title: `${t("ag.config")} — ${c.name}`, width: 760, body: configView(cfg) }); } }, t("ag.config")),
      h("button", { class: "btn small danger", onclick: async () => { if (await confirmDialog({ title: t("ag.revoke"), message: t("ag.revokeConfirm", { name: c.name }), danger: true, okLabel: t("ag.revoke") }) && await guard(() => call("agents.revokeClient", c.id))) redraw(); } }, t("ag.revoke"))))) : h("div", { class: "muted" }, t("ag.noClients")),
    h("h3", {}, t("ag.audit")), auditEl);
  const audit = ((await guard(() => call("agents.audit", 50))) || []).reverse();
  mount(auditEl, ...(audit.length ? audit.map((e) => h("div", { class: ["audit-row", e.ok ? "" : "failed"] },
    h("span", { class: "muted small" }, fmtDateTime(e.at)), " ", h("b", {}, e.client || "—"), " · ", h("code", { class: "ltr" }, e.op),
    e.ok ? null : h("span", { class: "field-error" }, ` ${errorText(e)}`))) : [h("div", { class: "muted" }, "—")]));
}

function newClient(onDone) {
  const nameIn = h("input", { type: "text", maxlength: 60, value: "Claude Code" });
  const scopes = new Set(SCOPE_DEFAULTS);
  const SCOPES = [["read", t("ag.s.read")], ["media", t("ag.s.media")], ["edit", t("ag.s.edit")], ["skills.run", t("ag.s.skillsRun")], ["skills.write", t("ag.s.skillsWrite")], ["export", t("ag.s.export")], ["delete", t("ag.s.delete")]];
  let allProjects = true;
  const roots = [];
  let exportDir = "";
  const rootsEl = h("div", { class: "col" });
  const drawRoots = () => mount(rootsEl, ...(roots.length ? roots.map((r, i) => h("div", { class: "row" }, h("code", { class: "ltr grow nowrap", title: r }, r), h("button", { class: "btn small ghost", onclick: () => { roots.splice(i, 1); drawRoots(); } }, t("set.clear")))) : [h("div", { class: "muted small" }, t("ag.noRoots"))]));
  drawRoots();
  const exportEl = h("code", { class: "ltr grow nowrap" }, t("ag.defaultExport"));
  const body = h("div", { class: "col" },
    row(t("col.name"), nameIn),
    h("div", {}, h("b", {}, t("ag.permissions")), h("div", { class: "chips" }, SCOPES.map(([k, label]) => check({ checked: scopes.has(k), label, onChange: (v) => { if (v) scopes.add(k); else scopes.delete(k); } })))),
    h("div", { class: "muted small", style: { lineHeight: 1.6 } }, t("ag.permHint")),
    row(t("ag.projects"), h("div", { class: "col" },
      h("label", { class: "radio" }, h("input", { type: "radio", name: "proj", checked: true, onchange: () => { allProjects = true; } }), t("ag.allProjects")),
      h("label", { class: "radio" }, h("input", { type: "radio", name: "proj", onchange: () => { allProjects = false; } }), t("ag.ownProjects")))),
    row(t("ag.roots"), h("div", { class: "col grow" }, rootsEl, h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", { title: t("ag.roots") }); if (d && !roots.includes(d)) { roots.push(d); drawRoots(); } } }, icon("plus"), t("ag.addRoot")))),
    row(t("ag.exportDir"), h("div", { class: "row grow" }, exportEl, h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", { title: t("ag.exportDir") }); if (d) { exportDir = d; exportEl.textContent = d; } } }, t("set.browse")))));
  const create = async () => {
    const r = await guard(() => call("agents.createClient", { name: nameIn.value.trim() || "Agent", scopes: [...scopes], projects: allProjects ? "*" : [], importRoots: roots, exportDir }));
    if (!r) return;
    m.close(true);
    onDone();
    modal({ title: t("ag.created", { name: r.client.name }), width: 760, body: h("div", { class: "col" },
      h("div", { class: "field-error" }, t("ag.tokenOnce")),
      h("div", { class: "row" }, h("code", { class: "ltr grow nowrap token" }, r.token), copyBtn(r.token)),
      h("div", { class: "muted small ltr" }, r.tokenFile),
      configView(r.config)) });
  };
  const m = modal({ title: t("ag.newClient"), width: 620, body, footer: [h("button", { class: "btn", onclick: () => m.close() }, t("c.cancel")), h("button", { class: "btn primary", onclick: create }, t("ag.create"))] });
}
