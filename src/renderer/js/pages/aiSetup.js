// «تجهيز الذكاء» (home page view): the AI layers that make the smart edit understand the footage — perception, best
// take, cause ↔ reaction links, the B-roll index — each with what it does, what happens without it, what is on this
// PC (sizes), one button that prepares it, and the details (runtime, parts it needs, model sets with their sizes,
// licences and sources; download / import from a folder / check / repair each). Opening the page downloads nothing
// and runs no model: only the health check of a runtime (a few seconds) when asked.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText } from "../i18n.js";
import { call, on } from "../api.js";
import { toast } from "../ui/toast.js";
import { confirmDialog } from "../ui/modal.js";

const guard = async (fn) => { try { return await fn(); } catch (e) { if (!e?.details?.cancelled) toast(errorText(e), "error"); return undefined; } };
const size = (b) => (b >= 1e9 ? t("ai.gb", { n: (b / 1e9).toFixed(1) }) : t("ai.mb", { n: Math.max(1, Math.round(b / 1e6)) }));
const STATE_BADGE = { ready: "local", partial: "na", missing: "na" };

export function aiSetupView() {
  const root = h("div", { class: "music ai-setup" });
  const head = h("div", { class: "card pad col", style: { gap: "6px" } });
  const prog = h("div", { class: "card pad col", style: { gap: "4px", display: "none" } });
  const list = h("div", { class: "col", style: { gap: "12px" } });
  let st = null;

  const off = on("ai:setup", (s) => {
    prog.style.display = s.running || s.error ? "" : "none";
    const label = s.error ? errorText(s.error) : `${t(`ai.task.${String(s.task || "").split(":")[0]}`)} ${s.step ? `· ${t(`ai.step.${s.step}`) === `ai.step.${s.step}` ? s.step : t(`ai.step.${s.step}`)}` : ""}`;
    mount(prog,
      h("div", { class: ["small", s.error && "field-error"] }, label),
      s.running ? h("div", { class: "progress" }, h("div", { style: { width: `${Math.round((s.progress || 0) * 100)}%` } })) : null,
      h("div", { class: "row small muted", style: { gap: "8px" } }, s.total ? `${size(s.bytes || 0)} / ${size(s.total)}` : `${Math.round((s.progress || 0) * 100)}%`, h("div", { class: "grow" }),
        s.running ? h("button", { class: "btn small ghost", onclick: () => call("ai.setupCancel") }, t("c.cancel")) : null));
    if (!s.running) draw();
  });

  /** Run a task; the page redraws when it ends (the "ai:setup" event). */
  const act = async (fn, done) => { const r = await guard(fn); if (r !== undefined && done) done(r); draw(); return r; };
  const pickFolder = () => call("dialog.openFolder", { title: t("ai.pickFolder") });

  async function draw() {
    const s = await guard(() => call("ai.setupStatus"));
    if (!s) return;
    st = s;
    const g = s.gpu;
    mount(head,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, icon("sparkle"), h("b", {}, t("ai.title"))),
      h("p", { class: "muted small", style: { margin: 0, lineHeight: 1.8 } }, t("ai.intro")),
      h("div", { class: "row small", style: { gap: "8px", flexWrap: "wrap" } }, icon(g.nvidia && g.driverOk ? "check" : "warning"),
        g.nvidia ? t("ai.gpu", { name: g.name, vram: (g.vramMB / 1024).toFixed(0), driver: g.driver }) : t("ai.noGpu"),
        g.nvidia && !g.driverOk ? h("span", { class: "field-error" }, t("ai.driverOld", { need: g.minDriver })) : null),
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        h("button", { class: "btn small", title: t("ai.importAllHint"), onclick: async () => {
          const d = await pickFolder();
          if (d) act(() => call("ai.importAll", d), (r) => toast(t("ai.importedAll", { envs: r.envs.filter((x) => ["linked", "already"].includes(x.result)).length, sets: r.sets.filter((x) => !x.notFound && !x.mismatch).length, all: r.sets.length }), "success"));
        } }, icon("folder"), t("ai.importAll")),
        h("span", { class: "muted small" }, t("ai.importAllHint"))),
      h("div", { class: "muted small ltr" }, s.root));
    mount(list, ...s.layers.map(layerCard));
  }

  function layerCard(L) {
    const own = L.sets.filter((x) => !x.borrowed);
    const needDownload = (L.env.installed ? 0 : L.env.bytes) + L.sets.filter((x) => !x.installed && !x.optional && !x.importOnly).reduce((n, x) => n + x.bytes - x.haveBytes, 0);
    const blocked = L.sets.filter((x) => !x.installed && !x.optional && x.importOnly);
    const prepare = async () => {
      const lic = [...new Set(L.sets.filter((x) => !x.installed && !x.optional && !x.importOnly).map((x) => `• ${x.name}: ${x.license}`))].join("\n");
      const ok = await confirmDialog({ title: t(`ai.layer.${L.id}`), okLabel: t("ai.prepare"),
        message: `${t("ai.confirmPrepare", { size: size(needDownload) })}${lic ? `\n\n${t("ai.licences")}\n${lic}` : ""}${blocked.length ? `\n\n${t("ai.blockedNote", { sets: blocked.map((x) => x.name).join("، ") })}` : ""}` });
      if (ok) act(() => call("ai.prepareLayer", L.id), () => toast(t("ai.prepared", { name: t(`ai.layer.${L.id}`) }), "success"));
    };
    const envRow = h("div", { class: "row small", style: { gap: "8px", flexWrap: "wrap" } },
      h("b", {}, t("ai.runtime")), h("span", { class: "ltr muted" }, L.env.name),
      h("span", { class: ["badge", L.env.installed && L.env.ok !== false ? "local" : "na"] }, !L.env.installed ? t("ai.notInstalled") : L.env.ok === true ? t("ai.healthy") : L.env.ok === false ? t("ai.broken") : t("ai.unchecked")),
      L.env.link ? h("span", { class: "badge na", title: L.env.link }, t("ai.linked")) : null,
      h("span", { class: "muted" }, size(L.env.bytes)),
      h("div", { class: "grow" }),
      L.env.installed ? h("button", { class: "btn small ghost", onclick: () => act(() => call("ai.checkEnv", L.id), (r) => toast(r.ok ? t("ai.envOk") : t("ai.envBad"), r.ok ? "success" : "warning")) }, t("ai.check")) : null,
      L.env.installed ? h("button", { class: "btn small", onclick: () => act(() => call("ai.repairEnv", L.id), () => toast(t("ai.repaired"), "success")) }, t("ai.repair"))
        : h("button", { class: "btn small", onclick: async () => { const d = await pickFolder(); if (d) act(() => call("ai.importEnv", L.id, d), (r) => toast(t(`ai.envImport.${r.result}`), r.result === "linked" ? "success" : "warning")); } }, t("ai.importFrom")));
    const problems = L.env.problems ? h("div", { class: "small field-error ltr" }, [
      ...(L.env.problems.broken || []).map((b) => `${b.name} ${b.version}: ${b.files.join(", ")}`),
      ...(L.env.problems.missing || []).map((m) => `missing ${m}`),
      ...Object.entries(L.env.problems.imports || {}).map(([m, e]) => `import ${m}: ${e}`),
      L.env.problems.error || ""].filter(Boolean).slice(0, 6).join("\n")) : null;
    const deps = L.deps.map((d) => h("div", { class: "row small", style: { gap: "8px", flexWrap: "wrap" } },
      icon(d.ok ? "check" : "warning"), h("span", {}, t(`ai.dep.${d.id}`)), h("span", { class: ["badge", d.ok ? "local" : "na"] }, d.ok ? t("ai.installedShort") : t("ai.notInstalled")),
      d.ok ? null : d.installable ? h("button", { class: "btn small", onclick: () => act(() => call("ai.installLlama")) }, icon("download"), t("ai.install"))
        : d.setup === "asr" ? h("button", { class: "btn small", onclick: async () => { const { openAsrSetup } = await import("../dialogs/asrSetup.js"); openAsrSetup({ onReady: draw }); } }, t("ai.openSetup"))
          : h("span", { class: "muted" }, t(`ai.depHow.${d.id}`))));
    const sets = L.sets.map(setRow);
    return h("div", { class: "card pad col", style: { gap: "6px" } },
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        h("b", {}, t(`ai.layer.${L.id}`)), h("span", { class: ["badge", STATE_BADGE[L.state]] }, t(`ai.state.${L.state}`)),
        h("span", { class: "muted small" }, t("ai.onDisk", { have: size(L.haveBytes + (L.env.installed ? L.env.bytes : 0)), all: size(L.bytes) })),
        h("div", { class: "grow" }),
        L.state === "ready" ? null : h("button", { class: "btn small primary", disabled: !!st?.task?.running, onclick: prepare }, icon("download"), t("ai.prepare"))),
      h("div", { class: "small", style: { lineHeight: 1.7 } }, t(`ai.layer.${L.id}.what`)),
      h("div", { class: "small muted", style: { lineHeight: 1.7 } }, t(`ai.layer.${L.id}.without`)),
      L.after.length ? h("div", { class: "small muted" }, t("ai.after", { names: L.after.map((x) => t(`ai.layer.${x}`)).join("، ") })) : null,
      L.gpuShort ? h("div", { class: "small field-error" }, t("ai.gpuShort", { gb: L.needGB })) : null,
      blocked.length && L.state !== "ready" ? h("div", { class: "small field-error" }, t("ai.blockedNote", { sets: blocked.map((x) => x.name).join("، ") })) : null,
      h("details", {}, h("summary", { class: "small" }, t("ai.details", { n: own.length })),
        h("div", { class: "col", style: { gap: "6px", marginTop: "6px" } }, envRow, problems, ...deps, ...sets)));
  }

  function setRow(x) {
    const damaged = x.files.some((f) => f.state === "damaged" || f.state === "partial");
    return h("div", { class: "card pad col", style: { gap: "3px" } },
      h("div", { class: "row small", style: { gap: "8px", flexWrap: "wrap" } },
        h("b", {}, x.name), h("span", { class: ["badge", x.installed ? "local" : "na"] }, x.installed ? t("ai.installedShort") : damaged ? t("ai.damaged") : t("ai.notInstalled")),
        x.optional ? h("span", { class: "badge na" }, t("ai.optional")) : null,
        x.borrowed ? h("span", { class: "badge na" }, t("ai.shared")) : null,
        Object.keys(x.links).length ? h("span", { class: "badge na", title: Object.values(x.links).join("\n") }, t("ai.linked")) : null,
        h("span", { class: "muted" }, size(x.bytes)), x.gpuGB >= 3 ? h("span", { class: "muted" }, t("ai.vram", { gb: x.gpuGB })) : null),
      h("div", { class: "small muted" }, `${t("ai.licence")}: ${x.license}`),
      h("div", { class: "small muted ltr" }, x.sources.join(" · ")),
      x.gated ? h("div", { class: "small field-error" }, t("ai.gated"), " ", h("span", { class: "ltr" }, x.gated.url)) : x.importOnly ? h("div", { class: "small muted" }, t("ai.importOnly")) : null,
      h("details", {}, h("summary", { class: "small" }, t("ai.files")), ...x.files.map((f) => h("div", { class: "small ltr" }, `${f.dir}/${f.file} · ${size(f.size)} · ${t(`ai.file.${f.state}`)}${f.partBytes ? ` (${size(f.partBytes)})` : ""}`))),
      x.borrowed ? null : h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        x.installed || x.importOnly ? null : h("button", { class: "btn small primary", onclick: async () => {
          if (await confirmDialog({ title: x.name, message: `${t("ai.confirmDownload", { size: size(x.bytes - x.haveBytes) })}\n${t("ai.licence")}: ${x.license}` })) act(() => call("ai.downloadSet", x.key));
        } }, icon("download"), x.files.some((f) => f.state === "partial") ? t("ai.resume") : t("ai.download")),
        h("button", { class: "btn small", onclick: async () => { const d = await pickFolder(); if (d) act(() => call("ai.importSet", x.key, d), (r) => toast(t("ai.imported", { n: r.report.filter((y) => y.result !== "notFound" && y.result !== "mismatch").length, all: r.report.length }), "success")); } }, t("ai.importFrom")),
        h("button", { class: "btn small ghost", onclick: () => act(() => call("ai.verifySet", x.key), (r) => toast(r.installed ? t("ai.verifiedOk") : t("ai.verifiedBad"), r.installed ? "success" : "warning")) }, t("ai.verify")),
        damaged && !x.importOnly ? h("button", { class: "btn small", onclick: () => act(() => call("ai.repairSet", x.key)) }, t("ai.repair")) : null));
  }

  root.append(h("h1", {}, t("ai.pageTitle")), head, prog, list);
  draw();
  root.dispose = () => off();
  return root;
}
