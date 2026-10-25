// "Dub": the Arabic speech of the open timeline's video becomes speech in another language (main process:
// agent/dub.js → services/dubService.js). The dialog first checks that the video is in Arabic and shows what the
// run will cost; while it runs, the stage, a real progress bar and the time left; after it, the speakers it found
// and every line — its words, feeling and speaker can be changed and voiced again.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t, has, errorText, getLang } from "../i18n.js";
import { call, on } from "../api.js";
import { modal } from "../ui/modal.js";

const EMOTIONS = ["neutral", "happy", "excited", "sad", "angry", "surprised", "serious", "warm", "curious"];
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** «about 12 minutes» / «less than a minute». */
function minutes(sec) {
  if (!(sec > 0)) return "";
  if (sec < 60) return t("dir.lessMinute");
  const n = Math.round(sec / 60);
  if (getLang() === "ar") return n === 1 ? "حوالي دقيقة" : n === 2 ? "حوالي دقيقتين" : n <= 10 ? `حوالي ${n} دقايق` : `حوالي ${n} دقيقة`;
  return t("dir.minutes", { n });
}
const kindOf = (s) => t(`dub.kind.${s.child ? "child" : s.gender === "female" ? "female" : "male"}`);

export function openDub(ed) {
  const lang = h("select", {});
  const context = h("input", { type: "text", maxlength: 300, placeholder: t("dub.context") });
  const info = h("div", { class: "small", style: { lineHeight: 1.7 } }, t("dub.detecting"));
  const bar = h("div");
  const progress = h("div", { class: "col", style: { gap: "6px", display: "none" } }, h("div", { class: "progress" }, bar));
  const status = h("div", { class: "muted small" });
  const result = h("div", { class: "col", style: { gap: "8px" } });
  const go = h("button", { class: "btn primary", disabled: true }, icon("mic"), t("dub.go"));
  const stop = h("button", { class: "btn ghost", style: { display: "none" }, onclick: () => call("dub.cancel") }, t("dub.stop"));
  const row = (label, el) => h("div", { class: "row" }, h("span", { class: "muted", style: { minWidth: "120px" } }, label), el);
  let est = null, arabic = false;

  async function refresh() {
    est = await call("dub.estimate", ed.timelineId(), { lang: lang.value || "en" }).catch((e) => { info.textContent = errorText(e); return null; });
    if (!est) return;
    if (!lang.options.length) {
      lang.append(...est.languages.map((code) => h("option", { value: code }, has(`dub.l.${code}`) ? t(`dub.l.${code}`) : code)));
      lang.value = "en";
    }
    if (!est.ready) { info.replaceChildren(setupPanel()); return; }
    const spoken = est.spoken || await call("dub.detect", ed.timelineId(), {}).catch((e) => { info.textContent = errorText(e); return null; });
    if (!spoken) return;
    arabic = spoken.arabic >= 0.5;
    info.replaceChildren(...[
      h("div", { class: arabic ? "" : "field-error" }, arabic ? t("dub.arabic", { p: Math.round(spoken.arabic * 100) }) : t("dub.notArabic", { lang: spoken.language })),
      h("div", {}, t("dub.estimate", { video: minutes(est.durationS), time: minutes(est.totalSec) })),
      lang.value !== "en" ? h("div", { class: "muted" }, t("dub.enBest")) : null].filter(Boolean));
    go.disabled = !arabic;
    if (est.last && !result.childElementCount) show(est.last);
  }
  // The tools are not on this computer yet: one click downloads and prepares them (resumable).
  function setupPanel() {
    const sbar = h("div"), sstat = h("div", { class: "muted small" });
    const sgo = h("button", { class: "btn primary" }, icon("download"), t("dub.setupGo"));
    const scancel = h("button", { class: "btn ghost", style: { display: "none" }, onclick: () => call("dub.setupCancel") }, t("dub.stop"));
    const show = (st) => {
      sbar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
      if (st.error) sstat.textContent = errorText(st.error);
      else if (st.running) sstat.textContent = `${has(`dub.setup.${st.step}`) ? t(`dub.setup.${st.step}`) : st.step || ""}… ${Math.round((st.progress || 0) * 100)}%`;
    };
    sgo.onclick = async () => {
      sgo.disabled = true; scancel.style.display = "";
      const off = on("dub:setup", show);
      try { await call("dub.setupStart"); sstat.textContent = t("dub.setupDone"); refresh(); }
      catch (e) { sstat.textContent = errorText(e); }
      finally { off(); sgo.disabled = false; scancel.style.display = "none"; }
    };
    call("dub.setupStatus").then((st) => { show(st); if (st.running) sgo.onclick(); }).catch(() => {});
    return h("div", { class: "col", style: { gap: "6px" } },
      h("div", {}, t("err.dubNotReady", { missing: est.missing.join(", ") })),
      h("div", { class: "muted" }, t("dub.setupHint", { gb: 40 })),
      h("div", { class: "row" }, sgo, scancel, sstat), h("div", { class: "progress" }, sbar),
      est.missing.some((k) => k.startsWith("asr"))
        ? h("button", { class: "btn ghost", onclick: () => import("../dialogs/asrSetup.js").then((m) => m.openAsrSetup()) }, t("dub.asrToo")) : null);
  }
  lang.onchange = () => { result.replaceChildren(); refresh(); };
  refresh();

  // Progress of a run: the stage, and the time left — from the measured stage times first, then more and more
  // from this run's real pace.
  async function runJob(method, args, prior) {
    go.disabled = true;
    stop.style.display = "";
    progress.style.display = "";
    bar.style.width = "0%";
    const started = Date.now();
    const off = on("dub:progress", (e) => {
      const p = Math.max(0, Math.min(1, e.progress || 0)), elapsed = (Date.now() - started) / 1000;
      bar.style.width = `${Math.round(p * 100)}%`;
      let left = prior * (1 - p);
      if (p > 0.02 && elapsed > 10) { const a = Math.min(1, p / 0.15); left = (1 - a) * left + a * (elapsed * (1 - p)) / p; }
      status.textContent = `${has(`dub.stage.${e.label}`) ? t(`dub.stage.${e.label}`) : e.label}… ${Math.round(p * 100)}%${left > 5 ? ` · ${t("dir.left", { time: minutes(left) })}` : ""}`;
    });
    try {
      const r = await call(method, ed.timelineId(), args);
      await ed.reloadTimeline();
      bar.style.width = "100%";
      status.textContent = `${t("dub.done", { lines: r.lines.length, speakers: r.speakers.length })} (${minutes((Date.now() - started) / 1000)})`;
      show(r);
      return r;
    } catch (err) {
      status.textContent = errorText(err);
      if (err?.messageKey === "err.whisperNotConfigured") import("../dialogs/asrSetup.js").then((m) => m.openAsrSetup());
      return null;
    } finally { off(); stop.style.display = "none"; go.disabled = !arabic; }
  }

  go.onclick = () => runJob("dub.run", { lang: lang.value, context: context.value.trim() }, est?.totalSec || 0);

  // The speakers and the lines of a dub; changed lines can be voiced again.
  function show(r) {
    const edits = new Map();
    const edit = (n, k, v) => { edits.set(n, { ...(edits.get(n) || { n }), [k]: v }); again.disabled = false; };
    const spkName = (id) => t("dub.speaker", { n: r.speakers.findIndex((s) => s.id === id) + 1, kind: kindOf(r.speakers.find((s) => s.id === id) || {}) });
    const doubt = r.lines.filter((l) => l.check !== null && l.check < 0.7).length, sped = r.lines.filter((l) => (l.speed || 1) > 1.01).length;
    const again = h("button", { class: "btn", disabled: true }, icon("mic"), t("dub.revoice"));
    again.onclick = () => {
      if (!edits.size) { status.textContent = t("dub.noChanges"); return; }
      runJob("dub.revoice", { lang: r.lang, edits: [...edits.values()] }, r.lines.length * 2.5 + 20);
    };
    const remove = h("button", { class: "btn ghost" }, icon("undo"), t("dub.remove"));
    remove.onclick = async () => {
      try { await call("dub.remove", ed.timelineId(), {}); await ed.reloadTimeline(); status.textContent = t("dub.removed"); } catch (e) { status.textContent = errorText(e); }
    };
    const lines = r.lines.map((l) => {
      const text = h("textarea", { rows: 2, maxlength: 400, dir: "auto", style: { width: "100%" } });
      text.value = l.text || "";
      text.oninput = () => edit(l.n, "text", text.value);
      const emo = h("select", { onchange: (e) => edit(l.n, "emotion", e.target.value) }, EMOTIONS.map((x) => h("option", { value: x, selected: x === l.emotion }, t(`dub.emo.${x}`))));
      const force = h("input", { type: "range", min: 0, max: 100, value: Math.round((l.intensity ?? 0.4) * 100), title: t("dub.intensity"), style: { width: "90px" }, oninput: (e) => edit(l.n, "intensity", Number(e.target.value) / 100) });
      const who = h("select", { onchange: (e) => edit(l.n, "speaker", Number(e.target.value)) }, r.speakers.map((s) => h("option", { value: s.id, selected: s.id === l.spk }, spkName(s.id))));
      const flag = l.check !== null && l.check < 0.7;
      return h("div", { class: "col", style: { gap: "4px", padding: "6px 0", borderBottom: "1px solid var(--bg-hover)" } },
        h("div", { class: "row small", style: { gap: "8px", flexWrap: "wrap" } },
          h("span", { class: "muted", dir: "ltr" }, `${clock(l.start)}–${clock(l.end)}`), who, emo, h("span", { class: "muted" }, t("dub.intensity")), force,
          flag ? h("span", { class: "field-error", title: t("dub.doubt") }, `⚠ ${t("dub.doubt")}`) : null),
        h("div", { class: "muted small", dir: "rtl" }, l.ar), text);
    });
    result.replaceChildren(
      h("div", { class: "pilot-msg bot" },
        h("div", {}, r.speakers.map((s) => spkName(s.id)).join(" · ")),
        sped ? h("div", { class: "muted small" }, t("dub.sped", { n: sped })) : null,
        doubt ? h("div", { class: "small", style: { color: "var(--danger)" } }, t("dub.doubtful", { n: doubt })) : null),
      h("div", { class: "muted small" }, t("dub.lines")),
      h("div", { style: { maxHeight: "320px", overflowY: "auto" } }, ...lines),
      h("div", { class: "row", style: { gap: "8px" } }, again, remove));
  }

  return modal({ title: t("dub.title"), width: 620, className: "pilot-modal",
    body: h("div", { class: "col" }, h("p", { class: "muted small" }, t("dub.hint")),
      row(t("dub.lang"), lang), context, info, h("div", { class: "row" }, go, stop, status), progress, result) });
}
