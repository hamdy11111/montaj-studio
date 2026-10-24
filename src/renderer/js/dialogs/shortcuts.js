// Keyboard shortcuts dialog (FEAT-138, SCREEN-046): 5 presets, tabs, click-to-record, conflict override, reset.
// Every change is validated and saved in the main process (Realm ShortcutPreset), then the live registry reloads.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, guard } from "../api.js";
import { app } from "../state.js";
import { modal, confirmDialog } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { chordFromEvent, displayKeys, PRESET_IDS } from "../../core/shortcuts.js";

export async function openShortcuts() {
  let presetId = app.settings.ui.lastShortcutPreset || 1;
  let data = await guard(() => call("shortcuts.get", presetId));
  if (!data) return;
  let tab = "timeline";
  let recording = null; // command id being recorded
  const list = h("div", { class: "sc-list" });
  const tabs = h("div", { class: "tabs inline" });
  const presetSel = h("select", { onchange: async (e) => { presetId = Number(e.target.value); await reload(); await call("settings.set", "ui", { lastShortcutPreset: presetId }); app.settings.ui.lastShortcutPreset = presetId; } },
    PRESET_IDS.map((n) => h("option", { value: n, selected: n === presetId }, t("sc.preset", { n }))));
  const search = h("input", { type: "search", placeholder: t("c.search"), oninput: () => draw() });

  async function reload() { data = await guard(() => call("shortcuts.get", presetId)); app.shortcuts = data; app.events.emit("shortcuts", data); draw(); }
  const label = (c) => c.label; // command labels are the report's English names (kept verbatim for traceability)

  function draw() {
    mount(tabs, ...[["timeline", t("sc.timeline")], ["player", t("sc.player")], ["basic", t("sc.basic")], ["other", t("sc.other")]].map(([id, l]) => h("button", { class: tab === id ? "active" : "", onclick: () => { tab = id; draw(); } }, l)));
    const conflicted = new Set(data.conflicts.flat());
    const q = search.value.trim().toLowerCase();
    const cmds = data.commands.filter((c) => c.tab === tab && (!q || c.label.toLowerCase().includes(q) || (data.bindings[c.id] || "").toLowerCase().includes(q)));
    mount(list, ...cmds.map((c) => {
      const chord = data.bindings[c.id] || "";
      const keyBox = h("button", { class: ["sc-keys", recording === c.id && "recording"], disabled: c.fixed, title: c.fixed ? t("sc.fixed") : t("sc.clickToModify"),
        onclick: () => { recording = c.id; draw(); } },
        recording === c.id ? t("sc.pressKeys") : chord ? displayKeys(chord).map((k) => h("kbd", {}, k)) : h("span", { class: "muted" }, "—"));
      return h("div", { class: "sc-row" }, conflicted.has(c.id) ? icon("warning", "warn") : h("span", { style: { width: "16px" } }), h("span", { class: "grow" }, label(c)), keyBox,
        chord && !c.fixed ? h("button", { class: "icon-btn", "aria-label": t("set.clear"), onclick: () => assign(c.id, "") }, icon("close")) : h("span", { style: { width: "28px" } }));
    }));
  }

  async function assign(cmd, chord, override = false) {
    try {
      const chk = await call("shortcuts.check", presetId, cmd, chord);
      if (chk.conflictWith && !override) {
        const other = data.commands.find((c) => c.id === chk.conflictWith);
        if (!(await confirmDialog({ title: t("sc.title"), message: t("sc.conflict", { a: other?.label || chk.conflictWith }) }))) { recording = null; draw(); return; }
        override = true;
      }
      await call("shortcuts.set", presetId, cmd, chord, override);
    } catch (err) {
      toast(t(err.messageKey || "err.internal"), "error");
    }
    recording = null;
    await reload();
  }

  const onKey = (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopImmediatePropagation(); // keep Escape from also closing the dialog
    if (e.key === "Escape") { recording = null; draw(); return; }
    const chord = chordFromEvent(e);
    if (!chord) return;
    if (chord.split("+").length > 4) { toast(t("err.shortcutTooManyModifiers"), "error"); return; }
    assign(recording, chord);
  };
  document.addEventListener("keydown", onKey, true);

  draw();
  modal({
    title: t("sc.title"), width: 640, className: "shortcuts-modal",
    body: h("div", { class: "col" }, h("div", { class: "row" }, presetSel, h("div", { class: "search grow" }, icon("search"), search)), tabs, list),
    footer: [h("button", { class: "btn", onclick: async () => { if (await confirmDialog({ title: t("sc.reset"), message: t("sc.reset") + "?" })) { await guard(() => call("shortcuts.reset", presetId)); await reload(); } } }, t("sc.reset"))],
    onClose: () => { if (recording) { recording = null; draw(); return false; } document.removeEventListener("keydown", onKey, true); },
  });
}
