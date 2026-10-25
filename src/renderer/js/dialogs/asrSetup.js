// "Prepare the Egyptian speech model": one button downloads a portable Python, the engine's packages and the model from
// its source, inside the app's data folder (services/asrSetupService.js). Progress, cancel, resume after a failure.
// Opened from Settings › Providers, from the first-run prompt on the home page and from a speech error's toast.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText } from "../i18n.js";
import { call, on } from "../api.js";
import { modal } from "../ui/modal.js";
import { formatBytes } from "../../core/util.js";

/** Opens the dialog; `onReady(status)` runs once the engine is ready. Returns the modal. */
export async function openAsrSetup({ onReady } = {}) {
  const st = await call("asr.setupStatus").catch(() => ({ running: false, downloadBytes: 1.7e9 }));
  const bar = h("div");
  const pct = h("span", { class: "muted small" });
  const status = h("div", { class: "small", style: { minHeight: "1.4em" } });
  const prog = h("div", { class: "col", style: { gap: "6px", display: "none" } }, h("div", { class: "progress" }, bar), h("div", { class: "row" }, status, h("div", { class: "grow" }), pct));
  const go = h("button", { class: "btn primary" }, icon("download"), t("asr.go"));
  const stop = h("button", { class: "btn", style: { display: "none" } }, t("c.cancel"));
  const show = (s) => {
    prog.style.display = "";
    const p = Math.round((s.progress || 0) * 100);
    bar.style.width = `${p}%`;
    pct.textContent = `${p}%`;
    status.textContent = s.error ? errorText(s.error) : s.step ? t(`asr.step.${s.step}`) : "";
    status.className = s.error ? "small field-error" : "small";
    go.style.display = s.running ? "none" : "";
    stop.style.display = s.running ? "" : "none";
    if (s.error) go.replaceChildren(icon("download"), t("asr.retry"));
    if (s.step === "done" && !s.running) { go.replaceChildren(t("c.close")); go.onclick = () => m.close(); }
  };
  const off = on("asr:setup", show);
  const start = async () => {
    show({ running: true, step: "python", progress: st.progress || 0 });
    try {
      const r = await call("asr.setupStart");
      show({ running: false, step: "done", progress: 1 });
      onReady?.(r);
    } catch (err) { if (!err?.details?.cancelled) show({ running: false, error: err, progress: 0 }); else show({ running: false, step: "cancelled", progress: 0 }); }
  };
  go.onclick = start;
  stop.onclick = () => call("asr.setupCancel").catch(() => {});
  const m = modal({
    title: t("asr.title"), width: 500,
    body: h("div", { class: "col", style: { gap: "10px" } },
      h("p", { style: { margin: 0, lineHeight: 1.7 } }, t("asr.explain")),
      h("ul", { class: "muted small", style: { margin: 0, paddingInlineStart: "18px", lineHeight: 1.8 } },
        h("li", {}, t("asr.size", { size: formatBytes(st.downloadBytes || 1.7e9) })),
        h("li", {}, t("asr.once")),
        h("li", {}, t("asr.source"))),
      prog),
    footer: [stop, go],
    onClose: () => { off(); },
  });
  if (st.running) show(st);
  return m;
}
