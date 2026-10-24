// Skills panel: the user's view of the Skills Engine. Run an installed skill on the open timeline (one undo step,
// rolled back on failure), build a new skill from a description, enable/disable, import/export, remove. Runs use
// the same SkillRuntime (main process) that MCP agents use, so a skill behaves identically from both sides.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText } from "../i18n.js";
import { call, guard } from "../api.js";
import { modal, confirmDialog } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { toggle, select } from "../ui/controls.js";
import { US } from "../../core/util.js";

const secs = (us) => `${(us / US).toFixed(2)}s`;

/** Form for a skill's input schema (boolean / number / integer / enum / string). Returns { el, values() }. */
function inputsForm(schema) {
  const props = schema?.properties || {};
  const vals = {};
  const rows = Object.entries(props).map(([key, p]) => {
    if (p.default !== undefined) vals[key] = p.default;
    const label = h("div", { class: "ctl-label" }, p.title || key, p.description ? h("span", { class: "muted small" }, ` — ${p.description}`) : null);
    let ctl;
    if (p.type === "boolean") ctl = toggle({ checked: !!p.default, onChange: (v) => { vals[key] = v; }, label: key });
    else if (Array.isArray(p.enum)) ctl = select({ value: p.default ?? p.enum[0], options: p.enum.map((v) => ({ value: v, label: String(v) })), onChange: (v) => { vals[key] = p.type === "number" || p.type === "integer" ? Number(v) : v; }, label: key });
    else if (p.type === "number" || p.type === "integer") {
      ctl = h("input", { type: "number", min: p.minimum, max: p.maximum, step: p.type === "integer" ? 1 : "any", value: p.default ?? "", style: { width: "120px" } });
      ctl.addEventListener("change", () => { if (ctl.value === "") delete vals[key]; else vals[key] = p.type === "integer" ? Math.round(Number(ctl.value)) : Number(ctl.value); });
    } else {
      ctl = h("input", { type: "text", value: p.default ?? "", maxlength: p.maxLength || 500 });
      ctl.addEventListener("change", () => { if (ctl.value === "") delete vals[key]; else vals[key] = ctl.value; });
    }
    return h("div", { class: "ctl" }, label, ctl);
  });
  return { el: rows.length ? h("div", { class: "col" }, rows) : h("div", { class: "muted small" }, t("sk.noInputs")), values: () => ({ ...vals }) };
}

export function openSkills(ed) {
  const listEl = h("div", { class: "skills-list" });
  const detail = h("div", { class: "skills-detail grow" });
  const search = h("input", { type: "search", placeholder: t("sk.search"), "aria-label": t("sk.search") });
  let skills = [];
  let current = null;

  async function load(keepId = current?.id) {
    skills = (await guard(() => call("skills.list", { query: search.value }))) || [];
    current = skills.find((s) => s.id === keepId) || skills[0] || null;
    drawList(); drawDetail();
  }
  search.addEventListener("input", () => load());

  function drawList() {
    mount(listEl, ...(skills.length ? skills.map((s) => h("button", { class: ["skill-item", current?.id === s.id && "active", !s.enabled && "off"], onclick: () => { current = s; drawList(); drawDetail(); } },
      h("div", { class: "skill-name" }, s.name),
      h("div", { class: "muted small ltr" }, `${s.id}@${s.version}`),
      h("span", { class: ["badge", s.trust === "official" ? "local" : s.trust === "external" ? "na" : ""] }, t(`sk.trust.${s.trust}`)))) : [h("div", { class: "muted" }, "—")]));
  }

  function drawDetail() {
    if (!current) { mount(detail, h("div", { class: "muted" }, t("sk.none"))); return; }
    const s = current;
    const form = inputsForm(s.inputs);
    const result = h("div", { class: "skill-result" });
    const runBtn = h("button", { class: "btn primary", disabled: !s.enabled }, icon("play"), t("sk.run"));
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      mount(result, h("div", { class: "row" }, h("div", { class: "spinner" }), t("sk.running")));
      try {
        const job = await call("skills.run", s.id, ed.timelineId(), form.values());
        await ed.reloadTimeline();
        if (job.status === "done") showReport(result, job.result);
        else mount(result, h("div", { class: "field-error" }, `${t("sk.failed")}: ${errorText(job.error)}${job.error?.details?.rolledBack ? ` — ${t("sk.rolledBack")}` : ""}`));
      } catch (err) { mount(result, h("div", { class: "field-error" }, errorText(err))); } finally { runBtn.disabled = !s.enabled; }
    };
    const actions = h("div", { class: "row wrap" }, runBtn,
      s.trust !== "official" ? h("label", { class: "row" }, toggle({ checked: s.enabled, onChange: async (v) => { if (await guard(() => call("skills.setEnabled", s.id, v)) !== undefined) load(s.id); }, label: t("sk.enabled") }), t("sk.enabled")) : null,
      h("button", { class: "btn small", onclick: async () => { const f = await call("dialog.saveFile", { title: t("sk.export"), defaultPath: `${s.id}.skill.json`, filters: [{ name: "Skill", extensions: ["json"] }] }); if (f && await guard(() => call("skills.export", s.id, f))) toast(t("c.saved"), "success"); } }, icon("upload"), t("sk.export")),
      s.trust !== "official" ? h("button", { class: "btn small danger", onclick: async () => { if (await confirmDialog({ title: t("c.delete"), message: t("sk.removeConfirm", { name: s.name }), danger: true, okLabel: t("c.delete") }) && await guard(() => call("skills.remove", s.id))) load(null); } }, t("c.delete")) : null);
    mount(detail,
      h("h3", {}, s.name), h("p", { class: "muted", style: { lineHeight: 1.6 } }, s.description),
      s.trust === "external" ? h("div", { class: "field-error" }, t("sk.externalHint")) : null,
      h("div", { class: "muted small" }, `${t("sk.permissions")}: ${s.permissions.join(", ")}${s.requires?.providers?.length ? ` · ${t("sk.requires")}: ${s.requires.providers.join(", ")}` : ""}`),
      h("ol", { class: "skill-steps" }, s.steps.map((x) => h("li", {}, x))),
      h("h4", {}, t("sk.inputs")), form.el, actions, result);
  }

  function showReport(el, rep) {
    const rows = rep.steps.map((x) => h("li", { class: x.status }, `${x.status === "done" ? "✓" : "–"} ${x.title || x.id}${x.reason ? ` (${x.reason})` : ""}${x.error ? ` (${t(x.error)})` : ""}`));
    mount(el,
      h("div", { class: "row" }, icon("check"), t("sk.doneReport", { before: secs(rep.before.durationUs), after: secs(rep.after.durationUs) })),
      h("ul", { class: "skill-steps" }, rows),
      h("button", { class: "btn small", onclick: async () => { await ed.run("undo"); toast(t("sk.undone"), "success"); mount(el); } }, t("tl.undo")));
  }

  function openBuilder() {
    const ta = h("textarea", { rows: 4, maxlength: 2000, placeholder: t("sk.buildPh"), style: { width: "100%" } });
    const nameIn = h("input", { type: "text", maxlength: 60, placeholder: t("sk.buildName") });
    const out = h("div", { class: "col" });
    let draft = null;
    const saveBtn = h("button", { class: "btn primary", disabled: true }, t("sk.save"));
    const build = async () => {
      const r = await guard(() => call("skills.buildFromText", ta.value, { name: nameIn.value.trim() }));
      if (!r) return;
      draft = r.skill;
      saveBtn.disabled = !r.validation.valid || !r.understood.length;
      mount(out,
        h("div", {}, h("b", {}, t("sk.understood")), r.understood.length ? h("ul", {}, r.understood.map((x) => h("li", {}, x))) : h("div", { class: "muted" }, t("sk.nothing"))),
        r.unsupported.length ? h("div", {}, h("b", {}, t("sk.unsupported")), h("ul", { class: "field-error" }, r.unsupported.map((x) => h("li", {}, x)))) : null,
        r.validation.valid ? null : h("ul", { class: "field-error" }, r.validation.errors.map((e) => h("li", { class: "ltr" }, `${e.path}: ${e.message}`))),
        h("ol", { class: "skill-steps" }, draft.steps.map((x) => h("li", {}, x.title || x.op))));
    };
    saveBtn.onclick = async () => {
      if (!draft) return;
      const card = await guard(() => call("skills.save", draft));
      if (card) { toast(t("c.saved"), "success"); bm.close(); load(card.id); }
    };
    const bm = modal({ title: t("sk.build"), width: 560,
      body: h("div", { class: "col" }, h("p", { class: "muted small", style: { lineHeight: 1.6 } }, t("sk.buildHint")), nameIn, ta, h("button", { class: "btn", onclick: build }, icon("sparkle"), t("sk.draft")), out),
      footer: [h("button", { class: "btn", onclick: () => bm.close() }, t("c.cancel")), saveBtn] });
  }

  async function importFile() {
    const [f] = (await call("dialog.openFiles", { kind: "json" })) || [];
    if (!f) return;
    const card = await guard(() => call("skills.import", f));
    if (card) { toast(t("sk.imported"), "success"); load(card.id); }
  }

  const m = modal({ title: t("sk.title"), width: 900, className: "skills-modal",
    body: h("div", { class: "col" },
      h("div", { class: "row" }, search, h("div", { class: "grow" }), h("button", { class: "btn", onclick: openBuilder }, icon("plus"), t("sk.build")), h("button", { class: "btn", onclick: importFile }, icon("download"), t("sk.import"))),
      h("div", { class: "skills-body row" }, listEl, detail)) });
  load();
  return m;
}
