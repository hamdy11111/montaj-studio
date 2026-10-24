// "Smart edit": the built-in director (core/director.js, run in the main process) plans and applies a whole edit of
// the open timeline — pacing, framing, graphics, sound, captions — as one undo step, then lists what it decided
// and why. Same code path as the agents' edit_auto operation.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText } from "../i18n.js";
import { call, on } from "../api.js";
import { modal } from "../ui/modal.js";
import { CAPTION_TEMPLATES } from "../../core/captionTemplates.js";

export function openDirector(ed) {
  const style = h("select", {}, [["energetic", t("dir.energetic")], ["calm", t("dir.calm")]].map(([v, l]) => h("option", { value: v }, l)));
  const tplSel = h("select", {}, Object.entries(CAPTION_TEMPLATES).map(([id, tp]) => h("option", { value: id, selected: id === "clean-pro" }, t(`cap.${id}`) || tp.name)));
  const cta = h("input", { type: "text", maxlength: 80, placeholder: t("dir.ctaPh") });
  const keywords = h("input", { type: "text", maxlength: 300, placeholder: t("lib.keywordsPh") });
  const fixes = h("textarea", { rows: 2, maxlength: 4000, dir: "auto", placeholder: t("lib.correctionsPh"), style: { width: "100%" } });
  const status = h("div", { class: "muted small" });
  const log = h("div", { class: "pilot-log", style: { maxHeight: "220px" } });
  const go = h("button", { class: "btn primary" }, icon("sparkle"), t("dir.go"));
  const row = (label, el) => h("div", { class: "row" }, h("span", { class: "muted", style: { minWidth: "120px" } }, label), el);
  go.onclick = async () => {
    go.disabled = true;
    log.replaceChildren();
    const off = on("director:progress", (e) => { status.textContent = `${t(`dir.stage.${e.label}`) || e.label}… ${Math.round(e.progress * 100)}%`; });
    try {
      const r = await call("director.run", ed.timelineId(), {
        style: style.value, captionTemplate: tplSel.value, cta: cta.value.trim(),
        keywords: keywords.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean),
        corrections: fixes.value.split(/\r?\n/).map((l) => l.split("=")).filter((p) => p.length === 2 && p[0].trim()).map(([from, to]) => ({ from: from.trim(), to: to.trim() })),
      });
      await ed.reloadTimeline();
      status.textContent = t("dir.done", { before: (r.before.durationUs / 1e6).toFixed(1), after: (r.after.durationUs / 1e6).toFixed(1) });
      for (const n of r.notes || []) log.append(h("div", { class: "pilot-msg bot" }, n));
    } catch (err) { status.textContent = errorText(err); } finally { off(); go.disabled = false; }
  };
  return modal({ title: t("dir.title"), width: 520, className: "pilot-modal",
    body: h("div", { class: "col" }, h("p", { class: "muted small" }, t("dir.hint")),
      row(t("dir.style"), style), row(t("lib.animatedCaptions"), tplSel), row(t("dir.cta"), cta), keywords, fixes,
      h("div", { class: "row" }, go, status), log) });
}
