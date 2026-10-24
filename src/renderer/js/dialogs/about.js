// About dialog: versions, engine capabilities and data location.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { app } from "../state.js";
import { call } from "../api.js";
import { modal } from "../ui/modal.js";

export function openAbout() {
  const i = app.info || {};
  const caps = app.caps?.ffmpeg;
  modal({
    title: t("about.title"), width: 480,
    body: h("div", { class: "col" },
      h("p", {}, t("about.body", { v: i.version || "", e: i.electron || "" })),
      caps ? h("p", { class: "muted ltr" }, `FFmpeg ${caps.version || ""} · ${caps.encoders?.some((e) => /_(nvenc|qsv|amf)$/.test(e)) ? caps.encoders.filter((e) => /_(nvenc|qsv|amf)$/.test(e)).join(", ") : "software encoding"}`) : null,
      h("p", { class: "muted" }, `Realm ${i.realm || ""} · Node ${i.node || ""} · Chromium ${i.chrome || ""}`),
      h("details", {}, h("summary", {}, t("about.licenses")),
        h("ul", { class: "muted small ltr", style: { lineHeight: 1.7 } },
          ...[["Electron", "MIT"], ["Chromium", "BSD-3-Clause and others"], ["Node.js", "MIT"], ["Realm JavaScript SDK", "Apache-2.0"],
            ["FFmpeg (ffmpeg-static build)", "GPL-3.0 — the bundled binary is used as a separate program"], ["ffprobe-static", "MIT (wrapper) / FFmpeg licence"]].map(([n, l]) => h("li", {}, `${n} — ${l}`)))),
      h("div", { class: "row" }, h("span", { class: "muted" }, t("set.dataLocation")), h("code", { class: "ltr nowrap grow", title: i.userData }, i.userData || ""),
        h("button", { class: "btn small", onclick: () => call("app.openPath", i.userData) }, t("ex.openFolder")))),
    footer: [h("button", { class: "btn primary", onclick: (e) => e.target.closest(".backdrop").querySelector(".modal-head .icon-btn").click() }, t("c.close"))],
  });
}
