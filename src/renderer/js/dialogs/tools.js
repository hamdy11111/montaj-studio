// Home tools: Long video to shorts (local scene/silence analysis, FEAT-106), Text to speech (offline Windows
// voices, FEAT-089) and the honest "requires an external service" panel for cloud-generative features.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, guard } from "../api.js";
import { app } from "../state.js";
import { modal } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { formatDuration } from "../../core/util.js";

export function openProviderOnly(title) {
  const m = modal({
    title, width: 460,
    body: h("div", { class: "col" }, h("div", { class: "row" }, icon("cloud"), h("strong", {}, t("tool.providerOnly"))), h("p", { class: "muted", style: { lineHeight: 1.7 } }, t("tool.providerExplain"))),
    footer: [h("button", { class: "btn primary", onclick: () => m.close() }, t("c.ok"))],
  });
}

export function openShortsTool() {
  const body = h("div", { class: "col" });
  let project = null, media = null, cands = [];
  const pick = h("button", { class: "btn primary", onclick: choose }, icon("upload"), t("shorts.pick"));
  mount(body, h("p", { class: "muted" }, t("shorts.limits")), pick);
  const m = modal({ title: t("tool.longToShorts"), width: 560, body, onClose: () => { if (project && !cands.length) call("project.deleteForever", project.id).catch(() => {}); } });

  async function choose() {
    const [file] = await call("dialog.openFiles", { kind: "media" });
    if (!file) return;
    mount(body, h("div", { class: "loading" }, h("div", { class: "spinner" }), t("shorts.analyzing")));
    const ok = await guard(async () => {
      project = await call("project.create", { ratio: "9:16" });
      const r = await call("media.import", project.id, [file]);
      if (r.errors?.length && !r.imported.length) throw r.errors[0].error;
      media = r.imported[0];
      if (media.type !== "video") throw Object.assign(new Error(), { messageKey: "err.analysisKind" });
      if (media.durationUs > 180 * 60e6) throw Object.assign(new Error(), { messageKey: "err.videoTooLong" });
      cands = await call("analysis.shortsCandidates", media.id, {});
      return true;
    });
    if (!ok) { mount(body, h("p", { class: "muted" }, t("shorts.limits")), pick); return; }
    const chosen = new Set(cands.map((_, i) => i));
    mount(body, h("strong", {}, t("shorts.found", { n: cands.length })),
      h("div", { class: "col", style: { maxHeight: "320px", overflow: "auto" } }, cands.map((c, i) => h("label", { class: "check" },
        h("input", { type: "checkbox", checked: true, onchange: (e) => (e.target.checked ? chosen.add(i) : chosen.delete(i)) }),
        h("span", { class: "ltr" }, `${formatDuration(c.startUs)} → ${formatDuration(c.endUs)}`), h("span", { class: "muted" }, c.reason || "")))),
      h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn primary", disabled: !cands.length, onclick: async () => {
        const sel = cands.filter((_, i) => chosen.has(i));
        if (!sel.length) return;
        mount(body, h("div", { class: "loading" }, h("div", { class: "spinner" }), t("c.loading")));
        const made = await guard(() => call("project.createShorts", project.id, media.id, sel, { ratio: "9:16" }));
        if (made) { toast(t("c.done"), "success"); m.close(true); app.go("editor", { projectId: made[0].id }); }
      } }, t("shorts.create"))));
  }
}

export function openTtsTool() {
  const text = h("textarea", { rows: 5, maxlength: 5000, placeholder: t("in.text"), style: { width: "100%" } });
  const voiceSel = h("select");
  const rate = h("input", { type: "range", min: 0.5, max: 2, step: 0.1, value: 1 });
  const status = h("div", { class: "muted" });
  const go = h("button", { class: "btn primary" }, icon("mic"), t("in.generateSpeech"));
  const m = modal({ title: t("tool.tts"), width: 520, body: h("div", { class: "col" }, text, h("div", { class: "row" }, h("span", { class: "muted" }, t("in.voice")), voiceSel), h("div", { class: "row" }, h("span", { class: "muted" }, t("in.rate")), rate), status), footer: [h("button", { class: "btn", onclick: () => m.close() }, t("c.cancel")), go] });
  guard(() => call("tts.voices")).then((vs) => {
    if (!vs?.length) { status.textContent = t("err.ttsUnavailable"); go.disabled = true; return; }
    mount(voiceSel, ...vs.map((v) => h("option", { value: v.name }, `${v.name} (${v.language})`)));
    const ar = vs.find((v) => /^ar/i.test(v.language)); if (ar) voiceSel.value = ar.name;
  });
  go.onclick = async () => {
    if (!text.value.trim()) { toast(t("err.ttsText"), "warning"); return; }
    go.disabled = true; status.textContent = t("c.loading");
    const r = await guard(async () => {
      const p = await call("project.create", {});
      const a = await call("tts.synthesize", p.id, { text: text.value.trim(), voice: voiceSel.value, rate: Number(rate.value) });
      await call("timeline.exec", p.mainTimelineId, "addMedia", { mediaId: a.id, toMain: false });
      return p;
    });
    go.disabled = false; status.textContent = "";
    if (r) { m.close(); app.go("editor", { projectId: r.id }); }
  };
}
