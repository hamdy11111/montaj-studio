// Settings dialog (SCREEN-040..045, FEAT-129..135, FEAT-147): Draft / Edit / Performance / General / Providers /
// Backup. Edits are collected per section and saved together (validated in the main process) on Save.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t, fmtDateTime } from "../i18n.js";
import { call, guard } from "../api.js";
import { app, refreshSettings } from "../state.js";
import { modal, confirmDialog } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { toggle, select, row, check } from "../ui/controls.js";
import { formatBytes } from "../../core/util.js";

const LINK_TYPES = ["text", "effect", "sticker", "filter", "adjust", "sfx", "tts"];

export function openSettings(initialTab = "draft") {
  const s = structuredClone(app.settings);
  const pending = {};
  const set = (section, key, value) => { s[section][key] = value; (pending[section] ||= {})[key] = value; };
  let tab = initialTab;
  const side = h("div", { class: "settings-tabs", role: "tablist" });
  const pane = h("div", { class: "settings-pane" });
  const TABS = [["draft", t("set.draft"), "folder"], ["edit", t("set.edit"), "scissors"], ["performance", t("set.performance"), "speed"], ["general", t("set.general"), "gear"], ["providers", t("set.providers"), "sparkle"], ["agents", t("ag.tab"), "layers"], ["backup", t("set.backup"), "backup"]];

  function drawTabs() {
    mount(side, ...TABS.map(([id, label, ic]) => h("button", { class: tab === id ? "active" : "", role: "tab", "aria-selected": tab === id ? "true" : "false", onclick: () => { tab = id; drawTabs(); drawPane(); } }, icon(ic), label)));
  }

  const folderRow = (label, section, key) => {
    const val = h("code", { class: "ltr nowrap grow", title: s[section][key] }, s[section][key] || "—");
    return row(label, h("div", { class: "row grow" }, val, h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", { title: label }); if (d) { set(section, key, d); val.textContent = d; val.title = d; } } }, t("set.browse"))));
  };
  const fileRow = (label, section, key, kind) => {
    const val = h("code", { class: "ltr nowrap grow", title: s[section][key] }, s[section][key] || "—");
    return row(label, h("div", { class: "row grow" }, val,
      h("button", { class: "btn small", onclick: async () => { const [f] = await call("dialog.openFiles", { kind }); if (f) { set(section, key, f); val.textContent = f; } } }, t("set.browse")),
      h("button", { class: "btn small ghost", onclick: () => { set(section, key, ""); val.textContent = "—"; } }, t("set.clear"))));
  };
  const tg = (section, key) => toggle({ checked: s[section][key], onChange: (v) => set(section, key, v) });
  const num = (section, key, min, max, step = 1) => { const el = h("input", { type: "number", min, max, step, value: s[section][key], style: { width: "80px" } }); el.addEventListener("change", () => { const v = Number(el.value); if (!Number.isFinite(v) || v < min || v > max) { el.classList.add("invalid"); toast(t("err.range", { min, max }), "warning"); return; } el.classList.remove("invalid"); set(section, key, v); }); return el; };
  const sel = (section, key, options) => select({ value: s[section][key], options, onChange: (v) => set(section, key, typeof s[section][key] === "number" ? Number(v) : v) });

  async function drawPane() {
    const d = s.draft, e = s.edit;
    if (tab === "draft") {
      const sizeEl = h("span", { class: "muted" }, "…");
      call("settings.cacheInfo").then((c) => { sizeEl.textContent = `${formatBytes(c.cacheBytes)} (proxy ${formatBytes(c.proxyBytes)}, render ${formatBytes(c.renderBytes)})`; }).catch(() => {});
      mount(pane,
        folderRow(t("set.mediaDir"), "draft", "mediaDir"), folderRow(t("set.recordDir"), "draft", "recordDir"), folderRow(t("set.downloadDir"), "export", "dir"),
        row(t("set.cache"), h("div", { class: "row" },
          h("label", { class: "radio" }, h("input", { type: "radio", name: "cache", checked: d.cachePolicy === "keep", onchange: () => set("draft", "cachePolicy", "keep") }), t("set.dontDelete")),
          h("label", { class: "radio" }, h("input", { type: "radio", name: "cache", checked: d.cachePolicy === "auto", onchange: () => set("draft", "cachePolicy", "auto") }), t("set.autoDelete")),
          sel("draft", "cacheDays", [7, 15, 30, 60, 90].map((n) => ({ value: n, label: String(n) }))), h("span", {}, t("set.daysAgo")))),
        row(t("set.cacheSize"), h("div", { class: "row" }, sizeEl, h("button", { class: "btn small", onclick: async () => {
          if (!(await confirmDialog({ title: t("set.cache"), message: t("set.clearCacheConfirm"), danger: true, okLabel: t("set.clear") }))) return;
          if (await guard(() => call("settings.clearCache", "all")) !== undefined) { await guard(() => call("settings.clearCache", "proxy")); toast(t("set.cacheCleared"), "success"); drawPane(); }
        } }, t("set.clear")))),
        folderRow(t("set.presetDir"), "draft", "presetDir"),
        row(t("set.autoBackup"), tg("draft", "autoBackup"), t("set.autoBackupHint")));
    } else if (tab === "edit") {
      const linkBox = h("div", { class: "chips" }, LINK_TYPES.map((k) => check({ checked: e.linkage.includes(k), label: k, onChange: (v) => set("edit", "linkage", v ? [...new Set([...s.edit.linkage, k])] : s.edit.linkage.filter((x) => x !== k)) })));
      mount(pane,
        row(t("set.stepFrames"), h("div", { class: "row" }, num("edit", "stepFrames", 1, 300), h("span", {}, t("set.frames")))),
        row(t("set.valueStep"), h("div", { class: "row" }, num("edit", "valueStep", 1, 100), h("span", {}, t("set.units")))),
        row(t("set.imageDuration"), h("div", { class: "row" }, num("edit", "imageDurationS", 0.1, 600, 0.1), h("span", {}, "s"))),
        row(t("set.targetLoudness"), sel("edit", "targetLufs", [{ value: -23, label: "-23 LUFS (EBU R128)" }, { value: -14, label: "-14 LUFS (streaming)" }, { value: -12, label: "-12 LUFS" }])),
        row(t("set.scrubAudio"), tg("edit", "scrubAudio"), t("set.scrubHint")),
        row(t("set.linkage"), h("div", { class: "col" }, tg("edit", "linkageEnabled"), linkBox), t("set.linkageHint")),
        row(t("set.arrangeLayers"), tg("edit", "arrangeLayers"), t("set.arrangeHint")),
        row(t("in.fps"), sel("edit", "fps", [24, 25, 29.97, 30, 50, 59.94, 60].map((n) => ({ value: n, label: `${n} fps` })))),
        row(t("set.timecode"), sel("edit", "timecode", [{ value: "HH:MM:SS+frame", label: "HH:MM:SS:frame" }, { value: "HH:MM:SS.ms", label: "HH:MM:SS.ms" }])),
        row(t("set.exportSound"), tg("edit", "exportSound"), t("set.exportSoundHint")));
    } else if (tab === "performance") {
      const caps = app.caps?.ffmpeg;
      mount(pane,
        row(t("set.hwEncode"), tg("performance", "hwEncode"), t("ex.hwHint")),
        row(t("set.hwDecode"), tg("performance", "hwDecode"), t("set.restartHint")),
        row(t("set.gpuUI"), tg("performance", "gpuUI"), t("set.restartHint")),
        row(t("set.autoOptimize"), sel("performance", "autoOptimize", [{ value: "smart", label: t("set.smart") }, { value: "none", label: t("set.none") }])),
        row(t("set.proxy"), tg("performance", "proxy"), t("set.proxyHint")),
        row(t("set.autoClear"), h("div", { class: "row" }, num("performance", "autoClearGB", 1, 500), h("span", {}, "GB")), t("set.autoClearHint")),
        row(t("set.autoRender"), tg("performance", "autoRender")),
        fileRow(t("set.ffmpegPath"), "performance", "ffmpegPath", "exe"),
        row(t("set.ffmpegInfo"), h("span", { class: "muted ltr" }, caps ? `FFmpeg ${caps.version} · ${caps.encoders.join(", ")}` : "—")));
    } else if (tab === "general") {
      mount(pane,
        row(t("set.language"), sel("general", "language", [{ value: "ar", label: "العربية" }, { value: "en", label: "English" }])),
        row(t("set.notifications"), tg("general", "notifications")),
        row(t("set.updates"), h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          sel("general", "updates", [{ value: "auto", label: t("upd.auto") }, { value: "notify", label: t("upd.notify") }]),
          h("button", { class: "btn small", onclick: async () => { const { checkForUpdates } = await import("../ui/updates.js"); checkForUpdates(); } }, t("upd.check"))), t("set.updatesHint")),
        row(t("set.shellMenu"), toggle({ checked: s.general.shellMenu, onChange: async (v) => { if (await guard(() => call("settings.shellMenu", v)) !== undefined) set("general", "shellMenu", v); } })),
        row(t("ed.shortcuts"), h("button", { class: "btn small", onclick: async () => { const { openShortcuts } = await import("./shortcuts.js"); openShortcuts(); } }, icon("shortcuts"), t("ed.shortcuts"))));
    } else if (tab === "providers") {
      const st = app.caps?.captions;
      const fwStatus = h("span", { class: "muted" }, "…"), nemoStatus = h("span", { class: "muted" }, "…");
      const nemoBtn = h("button", { class: "btn small primary", style: { display: "none" }, onclick: async () => {
        const { openAsrSetup } = await import("./asrSetup.js");
        openAsrSetup({ onReady: (c) => showFw(c) });
      } }, icon("download"), t("asr.go"));
      const showFw = (c) => {
        const nm = c?.nemo;
        nemoBtn.style.display = nm?.ready ? "none" : "";
        nemoStatus.textContent = nm?.ready ? t("set.nemoReady", { version: nm.version, device: "CPU" })
          : !nm?.modelFile ? t("set.nemoNoModel") : !nm?.python ? t("set.nemoNoRuntime") : t("set.nemoBroken");
        nemoStatus.className = nm?.ready ? "badge local" : "muted";
        if (nm?.error) nemoStatus.title = nm.error;
        const fw = c?.fasterWhisper;
        if (!fw) { fwStatus.textContent = t("set.fwUnused"); fwStatus.className = "muted"; return; }
        fwStatus.textContent = !fw?.installed ? t("set.fwMissing") : fw.modelCached ? t("set.fwReady", { version: fw.version, device: fw.cuda ? "GPU" : "CPU" }) : t("set.fwNoModel");
        fwStatus.className = fw?.modelCached ? "badge local" : "muted";
      };
      call("captions.status").then(showFw).catch(() => {});
      const modelIn = h("input", { type: "text", value: s.providers.fwModel || "large-v3-turbo", style: { width: "220px" }, class: "ltr" });
      modelIn.addEventListener("change", () => set("providers", "fwModel", modelIn.value.trim()));
      mount(pane,
        row(t("set.asrEngine"), sel("providers", "asrEngine", [{ value: "auto", label: t("set.asrAuto") }, { value: "nemo", label: t("set.nemo") }, { value: "fasterwhisper", label: "faster-whisper (Python)" }, { value: "whispercpp", label: "whisper.cpp" }])),
        row(t("set.nemo"), h("div", { class: "row" }, nemoStatus, nemoBtn)),
        fileRow(t("set.pythonPath"), "providers", "pythonPath", "exe"),
        row(t("set.fwModel"), modelIn),
        row(t("set.asrStatus"), h("div", { class: "row" }, fwStatus, h("button", { class: "btn small", onclick: async () => { for (const [k, v] of Object.entries(pending.providers || {})) await guard(() => call("settings.set", "providers", { [k]: v })); fwStatus.textContent = "…"; showFw(await guard(() => call("captions.status", true))); } }, t("set.check")))),
        h("p", { class: "muted", style: { lineHeight: 1.7 } }, t("lib.whisperMissing")),
        fileRow(t("set.whisperPath"), "providers", "whisperPath", "exe"),
        fileRow(t("set.whisperModel"), "providers", "whisperModel", "model"),
        row(t("set.whisperLang"), sel("providers", "whisperLanguage", [["auto", "Auto"], ["ar", "العربية"], ["en", "English"], ["fr", "Français"], ["tr", "Türkçe"], ["es", "Español"], ["de", "Deutsch"]].map(([value, label]) => ({ value, label })))),
        row(t("lib.autoCaptions"), h("span", { class: ["badge", st?.autoCaptions ? "local" : "na"] }, st?.autoCaptions ? t("c.done") : t("c.notAvailable"))),
        h("p", { class: "muted", style: { lineHeight: 1.7 } }, t("tool.providerExplain")));
    } else if (tab === "agents") {
      const { drawAgentsPane } = await import("./agents.js");
      await drawAgentsPane(pane, () => { if (tab === "agents") drawPane(); });
    } else if (tab === "backup") {
      const list = h("div", { class: "col" }, h("div", { class: "loading" }, h("div", { class: "spinner" })));
      mount(pane,
        h("p", { class: "muted" }, t("set.autoBackupHint")),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onclick: async () => { const r = await guard(() => call("backup.create")); if (r) { toast(t("set.backupDone"), "success"); drawPane(); } } }, icon("backup"), t("set.backupNow")),
          h("button", { class: "btn", onclick: async () => { const dir = await call("dialog.openFolder", {}); if (dir) { const r = await guard(() => call("backup.create", dir)); if (r) toast(t("set.backupDone"), "success", { action: { label: t("ex.openFolder"), run: () => call("app.openPath", r.dir) } }); } } }, icon("folder"), t("set.browse")),
          h("button", { class: "btn", onclick: async () => { const dir = await call("dialog.openFolder", {}); if (dir) restore(dir, dir); } }, icon("upload"), t("set.restore"))),
        h("h3", {}, t("set.backups")), list);
      const items = (await guard(() => call("backup.list"))) || [];
      mount(list, ...(items.length ? items.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt)).map((b) => h("div", { class: "row backup-row" },
        h("div", { class: "grow" }, h("div", {}, fmtDateTime(b.manifest.createdAt)), h("div", { class: "muted small" }, `${b.manifest.counts.projects} ${t("home.projects")} · v${b.manifest.appVersion} · schema ${b.manifest.schemaVersion}`)),
        h("button", { class: "btn small", onclick: () => call("app.openPath", b.dir) }, t("ex.openFolder")),
        h("button", { class: "btn small", onclick: () => restore(b.dir, fmtDateTime(b.manifest.createdAt)) }, t("set.restore")))) : [h("div", { class: "muted" }, "—")]));
    }
  }

  async function restore(dir, label) {
    if (!(await confirmDialog({ title: t("set.restore"), message: t("set.restoreConfirm", { date: label }), danger: true, okLabel: t("set.restore") }))) return;
    const r = await guard(() => call("backup.restore", dir));
    if (r) { toast(t("set.restoreDone"), "success"); m.close(true); await refreshSettings(); app.go("home", {}); }
  }

  async function save() {
    for (const [section, patch] of Object.entries(pending)) {
      const ok = await guard(() => call("settings.set", section, patch));
      if (ok === undefined) return;
      delete pending[section];
    }
    await refreshSettings();
    app.caps = await call("app.capabilities").catch(() => app.caps);
    toast(t("set.saved"), "success");
    m.close(true);
  }

  drawTabs(); drawPane();
  const m = modal({
    title: t("set.title"), width: 860, className: "settings-modal",
    body: h("div", { class: "settings" }, side, pane),
    footer: [h("button", { class: "btn", onclick: () => m.close() }, t("set.cancel")), h("button", { class: "btn primary", onclick: save }, t("set.save"))],
  });
}
