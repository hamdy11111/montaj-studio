// Trash dialog (FEAT-005, SCREEN-004): days remaining, restore, permanent delete, empty trash.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, guard, coverUrl } from "../api.js";
import { modal, confirmDialog } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { formatDuration } from "../../core/util.js";

export function openTrash(onChange = () => {}) {
  const body = h("div", { class: "trash" });
  const title = h("span");
  const emptyBtn = h("button", { class: "btn danger", onclick: emptyAll }, icon("trash"), t("trash.emptyAll"));
  let items = [];
  async function load() {
    mount(body, h("div", { class: "loading" }, h("div", { class: "spinner" })));
    items = (await guard(() => call("project.list", { status: "trashed", sort: "updatedAt" }))) || [];
    title.textContent = t("trash.recently", { n: items.length });
    emptyBtn.disabled = !items.length;
    if (!items.length) { mount(body, h("div", { class: "empty" }, icon("trash"), h("div", {}, t("trash.empty")))); return; }
    mount(body, h("p", { class: "muted" }, t("trash.hint")), h("div", { class: "proj-grid small" }, items.map((p) => h("div", { class: "proj-card" },
      h("div", { class: "proj-cover" }, p.coverPath ? h("img", { src: coverUrl(p.id), alt: "" }) : icon("video"), h("span", { class: "proj-dur" }, formatDuration(p.durationUs)),
        h("span", { class: "days-left" }, t("trash.daysLeft", { n: p.daysLeft }))),
      h("div", { class: "proj-name nowrap", title: p.name }, p.name),
      h("div", { class: "row" },
        h("button", { class: "btn small grow", onclick: async () => { if (await guard(() => call("project.restore", p.id)) !== undefined) { toast(t("trash.restore"), "success"); onChange(); load(); } } }, t("trash.restore")),
        h("button", { class: "btn small danger", onclick: async () => {
          if (!(await confirmDialog({ title: t("trash.deleteForever"), message: t("trash.deleteForeverConfirm", { name: p.name }), okLabel: t("c.delete"), danger: true }))) return;
          if (await guard(() => call("project.deleteForever", p.id)) !== undefined) { onChange(); load(); }
        } }, t("trash.deleteForever")))))));
  }
  async function emptyAll() {
    if (!(await confirmDialog({ title: t("trash.emptyAll"), message: t("trash.emptyConfirm", { n: items.length }), okLabel: t("c.delete"), danger: true }))) return;
    if (await guard(() => call("project.emptyTrash")) !== undefined) { onChange(); load(); }
  }
  modal({ title: t("trash.title"), width: 760, body: h("div", {}, h("div", { class: "row", style: { marginBottom: "8px" } }, h("strong", { class: "grow" }, title), emptyBtn), body) });
  load();
}
