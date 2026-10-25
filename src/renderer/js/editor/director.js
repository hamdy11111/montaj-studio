// "Smart edit": the built-in director (core/director.js, run in the main process) plans and applies a whole edit of
// the open timeline — pacing, framing, graphics, sound, captions — as one undo step, then lists what it decided
// and why. Same code path as the agents' edit_auto operation. Before it starts, the dialog shows what the run will
// cost (measured stage times); while it runs, a real progress bar per stage and the time left; for a long video it
// suggests a reel or turning off the slow steps.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t, has, errorText, getLang } from "../i18n.js";
import { call, on } from "../api.js";
import { modal } from "../ui/modal.js";
import { check } from "../ui/controls.js";
import { CAPTION_TEMPLATES } from "../../core/captionTemplates.js";
import { GRAPHIC_TEMPLATES, EMOJI_ALIASES } from "../../core/graphics.js";

const EMOJI_CHAR = Object.fromEntries(Object.entries(EMOJI_ALIASES).map(([ch, name]) => [name, ch]));
const tplName = (id) => (id === "punch" ? t("dir.punchIn") : (getLang() === "ar" ? GRAPHIC_TEMPLATES[id]?.ar : GRAPHIC_TEMPLATES[id]?.name) || id || "");
/** A quality check in the app's language (its English message when there is no translation). */
const qaText = (c) => (has(`qa.${c.id}`) ? t(`qa.${c.id}`, { ...c.args, tpl: tplName(c.args?.template), other: tplName(c.args?.other) }) : c.message);
/** One decision of the director, in the app's language. */
function decisionText(d) {
  switch (d.k) {
    case "graphic": return t("dec.graphic", { at: d.at, tpl: tplName(d.template), what: d.emoji ? EMOJI_CHAR[d.emoji] || d.emoji : `«${d.text || ""}»` });
    case "retention": return t("dec.retention", { at: d.at, tpl: tplName(d.template), text: d.text, gap: d.gap });
    case "kept": case "ending": case "cta": case "silenced": case "noPersonModel": case "personOff": case "noSpeech": return t(`dec.${d.k}`, d);
    default: return null;
  }
}
/** The edit in a few lines: what changed and what was added. */
function summary(r) {
  const plan = r.plan || {}, before = r.before.durationUs / 1e6, after = r.after.durationUs / 1e6;
  const zooms = plan.zooms || [], gfx = (plan.graphics || []).filter((g) => g.template !== "progress-bar");
  const sounds = (plan.sfx || []).length + gfx.filter((g) => g.sfx).length;
  const lines = [t("dir.sumLength", { before: before.toFixed(1), after: after.toFixed(1), pct: Math.round(100 - (100 * after) / Math.max(0.1, before)) })];
  const reel = (r.decisions || []).find((d) => d.k === "reel");
  if (reel) lines.push(t("dir.sumReel", reel));
  lines.push(t("dir.sumParts", { cuts: (plan.cuts || []).length, angles: zooms.filter((z) => /^angle/.test(z.reason || "")).length, punches: zooms.filter((z) => /^(punch|push)/.test(z.reason || "")).length,
    graphics: gfx.filter((g) => g.template !== "head-emoji").length, emoji: gfx.filter((g) => g.template === "head-emoji").length, sfx: sounds }));
  const removed = (r.decisions || []).find((d) => d.k === "pacing")?.removed || {};
  const parts = Object.entries(removed).filter(([k]) => k !== "reel").map(([k, n]) => `${n} ${has(`dir.rm.${k}`) ? t(`dir.rm.${k}`) : k}`);
  if (parts.length) lines.push(t("dir.sumRemoved", { list: parts.join("، ") }));
  return lines;
}

/** «about 12 minutes» / «less than a minute». */
function minutes(sec) {
  if (!(sec > 0)) return "";
  if (sec < 60) return t("dir.lessMinute");
  const n = Math.round(sec / 60);
  if (getLang() === "ar") return n === 1 ? "حوالي دقيقة" : n === 2 ? "حوالي دقيقتين" : n <= 10 ? `حوالي ${n} دقايق` : `حوالي ${n} دقيقة`;
  return t("dir.minutes", { n });
}

export function openDirector(ed) {
  const style = h("select", {}, [["energetic", t("dir.energetic")], ["explain", t("dir.explain")], ["calm", t("dir.calm")]].map(([v, l]) => h("option", { value: v }, l)));
  const tplSel = h("select", {}, Object.entries(CAPTION_TEMPLATES).map(([id, tp]) => h("option", { value: id, selected: id === "clean-pro" }, t(`cap.${id}`) || tp.name)));
  const length = h("select", {}, [["", t("dir.lenFull")], ["60", t("dir.lenReel", { n: 60 })], ["90", t("dir.lenReel", { n: 90 })]].map(([v, l]) => h("option", { value: v }, l)));
  const opts = { stabilize: true, person: true };
  const stabBox = check({ checked: true, label: t("dir.optStab"), onChange: (v) => { opts.stabilize = v; refresh(); } });
  const personBox = check({ checked: true, label: t("dir.optPerson"), onChange: (v) => { opts.person = v; refresh(); } });
  const cta = h("input", { type: "text", maxlength: 80, placeholder: t("dir.ctaPh") });
  const keywords = h("input", { type: "text", maxlength: 300, placeholder: t("lib.keywordsPh") });
  const fixes = h("textarea", { rows: 2, maxlength: 4000, dir: "auto", placeholder: t("lib.correctionsPh"), style: { width: "100%" } });
  const estimate = h("div", { class: "small", style: { lineHeight: 1.7 } });
  const bar = h("div");
  const progress = h("div", { class: "col", style: { gap: "6px", display: "none" } }, h("div", { class: "progress" }, bar));
  const status = h("div", { class: "muted small" });
  const log = h("div", { class: "pilot-log", style: { maxHeight: "220px" } });
  const go = h("button", { class: "btn primary" }, icon("sparkle"), t("dir.go"));
  const row = (label, el) => h("div", { class: "row" }, h("span", { class: "muted", style: { minWidth: "120px" } }, label), el);
  let est = null;

  // What the run will cost, before it starts (and a way out for a long video).
  async function refresh() {
    est = await call("director.estimate", ed.timelineId(), opts).catch(() => null);
    if (!est) { estimate.replaceChildren(); return; }
    const parts = [h("div", {}, t("dir.estimate", { video: minutes(est.durationS), time: minutes(est.totalSec) }))];
    if (est.durationS > 300 && est.totalSec > 600) {
      const stab = est.stages.find((x) => x.key === "stabilize")?.sec || 0;
      parts.push(h("div", { class: "field-error" }, t("dir.longVideo", { time: minutes(est.totalSec) })),
        h("div", { class: "muted" }, stab > 60 ? t("dir.longTipStab", { save: minutes(stab) }) : t("dir.longTip")));
    }
    estimate.replaceChildren(...parts);
  }
  refresh();

  go.onclick = async () => {
    go.disabled = true;
    log.replaceChildren();
    progress.style.display = "";
    bar.style.width = "0%";
    const started = Date.now();
    const prior = est?.totalSec || 0;
    // Time left: from the measured stage times at first, then more and more from the real pace of this run.
    const off = on("director:progress", (e) => {
      const p = Math.max(0, Math.min(1, e.progress || 0)), elapsed = (Date.now() - started) / 1000;
      bar.style.width = `${Math.round(p * 100)}%`;
      let left = prior * (1 - p);
      if (p > 0.02 && elapsed > 10) { const a = Math.min(1, p / 0.15); left = (1 - a) * left + a * (elapsed * (1 - p)) / p; }
      status.textContent = `${has(`dir.stage.${e.label}`) ? t(`dir.stage.${e.label}`) : e.label}… ${Math.round(p * 100)}%${left > 5 ? ` · ${t("dir.left", { time: minutes(left) })}` : ""}`;
    });
    try {
      const r = await call("director.run", ed.timelineId(), {
        style: style.value, captionTemplate: tplSel.value, cta: cta.value.trim(), ...opts,
        ...(length.value ? { targetSec: Number(length.value) } : {}),
        keywords: keywords.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean),
        corrections: fixes.value.split(/\r?\n/).map((l) => l.split("=")).filter((p) => p.length === 2 && p[0].trim()).map(([from, to]) => ({ from: from.trim(), to: to.trim() })),
      });
      await ed.reloadTimeline();
      bar.style.width = "100%";
      status.textContent = `${t("dir.done", { before: (r.before.durationUs / 1e6).toFixed(1), after: (r.after.durationUs / 1e6).toFixed(1) })} (${minutes((Date.now() - started) / 1000)})`;
      log.append(h("div", { class: "pilot-msg bot" }, ...summary(r).map((l) => h("div", {}, l))));
      if (r.qa) {
        const fails = r.qa.checks.filter((c) => c.level === "fail"), warns = r.qa.checks.filter((c) => c.level === "warn");
        log.append(h("div", { class: "pilot-msg bot" },
          h("div", { style: { fontWeight: 700, color: fails.length ? "var(--danger)" : "var(--accent)" } }, fails.length ? t("dir.qaFail", { n: fails.length }) : t("dir.qaOk", { n: r.qa.passed.length })),
          h("div", { class: "muted small" }, t("dir.qaStats", { cpm: r.qa.stats.cutsPerMin, median: r.qa.stats.medianShot, epm: r.qa.stats.elementsPerMin })),
          ...[...fails, ...warns].map((c) => h("div", { class: "small", style: { color: c.level === "fail" ? "var(--danger)" : "inherit" } }, `${c.level === "fail" ? "✗" : "!"} ${qaText(c)}`))));
      }
      const lines = (r.decisions || []).map(decisionText).filter(Boolean);
      if (lines.length) log.append(h("details", { class: "pilot-msg bot" }, h("summary", { style: { cursor: "pointer" } }, t("dir.decisions", { n: lines.length })), ...lines.map((l) => h("div", { class: "small" }, l))));
    } catch (err) {
      status.textContent = errorText(err);
      if (err?.messageKey === "err.whisperNotConfigured") import("../dialogs/asrSetup.js").then((m) => m.openAsrSetup());
    } finally { off(); go.disabled = false; }
  };
  return modal({ title: t("dir.title"), width: 540, className: "pilot-modal",
    body: h("div", { class: "col" }, h("p", { class: "muted small" }, t("dir.hint")),
      row(t("dir.style"), style), row(t("dir.length"), length), row(t("lib.animatedCaptions"), tplSel), row(t("dir.cta"), cta), keywords, fixes,
      h("div", { class: "row", style: { gap: "16px", flexWrap: "wrap" } }, stabBox, personBox),
      estimate, h("div", { class: "row" }, go, status), progress, log) });
}
