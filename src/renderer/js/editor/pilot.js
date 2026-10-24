// EditPilot panel (FEAT-098): local rule-based planner (core/assistant.js, run in the main process) whose plan is
// executed here through the normal undoable editor commands. Every step is reported back to the user.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t, getLang } from "../i18n.js";
import { call } from "../api.js";
import { modal } from "../ui/modal.js";
import { SUGGESTIONS } from "../../core/assistant.js";
import { US } from "../../core/util.js";

export function openPilot(ed, initial = "") {
  const log = h("div", { class: "pilot-log" }, h("div", { class: "pilot-msg bot" }, t("ai.hello")));
  const ta = h("textarea", { rows: 2, placeholder: t("ai.placeholder"), maxlength: 2000, value: initial, style: { width: "100%" } });
  const send = h("button", { class: "btn primary" }, icon("send"));
  const say = (text, who = "bot") => { log.append(h("div", { class: ["pilot-msg", who] }, text)); log.scrollTop = log.scrollHeight; };
  async function submit() {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    say(text, "me");
    send.disabled = true;
    try {
      const plan = await call("assistant.plan", text, { hasSelection: ed.selection().length > 0 });
      if (!plan.understood) { say(t("ai.notUnderstood")); return; }
      const done = [];
      for (const a of plan.actions) {
        try { done.push(await runAction(ed, a)); } catch (err) { done.push(`✗ ${a.type}: ${t(err.messageKey || "err.internal")}`); }
      }
      say(t("ai.done", { list: done.join(" · ") }));
    } finally { send.disabled = false; }
  }
  send.onclick = submit;
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  const m = modal({ title: t("ai.title"), width: 460, className: "pilot-modal",
    body: h("div", { class: "col" }, log, h("div", { class: "chips" }, SUGGESTIONS.map((s) => h("button", { class: "chip", onclick: () => { ta.value = getLang() === "ar" ? s.ar : s.en; ta.focus(); } }, getLang() === "ar" ? s.ar : s.en))),
      h("div", { class: "row" }, ta, send), h("div", { class: "muted small" }, t("ai.local"))) });
  if (initial) setTimeout(submit, 300);
  return m;
}

/** Target clips for a scope: the selection, or every main-track video/image clip. */
function targets(ed, scope, kinds = ["video", "image", "compound"]) {
  const sel = ed.selection().map((id) => ed.segment(id)).filter(Boolean);
  if (scope === "selection" && sel.length) return sel.filter((s) => kinds.includes(s.kind));
  return ed.tl().tracks.find((x) => x.isMain).segments.filter((s) => kinds.includes(s.kind));
}

export async function runAction(ed, a) {
  const x = a.args || {};
  switch (a.type) {
    case "setRatio": await ed.exec("setCanvas", { ratio: x.ratio }); ed.relayout(); return `✓ ${x.ratio}`;
    case "setSpeed": for (const s of targets(ed, x.scope, ["video", "audio", "compound"])) await ed.exec("setSpeed", { segId: s.id, speed: x.speed }); return `✓ ${x.speed}x`;
    case "removeSilences": {
      let removed = 0;
      const segs = targets(ed, x.scope, ["video", "audio"]).sort((p, q) => q.start - p.start);
      for (const s of segs) {
        const m = ed.media(s.mediaId);
        if (!m?.hasAudio) continue;
        const ranges = await call("analysis.silences", s.mediaId, { fromUs: s.sourceStart, durUs: Math.round(s.duration * (s.speed || 1)) });
        if (ranges.length) { const r = await ed.exec("removeRanges", { segId: s.id, ranges }); removed += r?.result || 0; }
      }
      return `✓ ${t("tl.removeSilences")} (${(removed / US).toFixed(1)}s)`;
    }
    case "splitScenes": {
      let n = 0;
      for (const s of targets(ed, x.scope, ["video"]).sort((p, q) => q.start - p.start)) {
        const src = await call("analysis.scenes", s.mediaId, { fromUs: s.sourceStart, durUs: Math.round(s.duration * (s.speed || 1)) });
        const times = src.map((u) => Math.round(s.start + (u - s.sourceStart) / (s.speed || 1))).filter((u) => u > s.start + 100_000 && u < s.start + s.duration - 100_000);
        if (times.length) { await ed.exec("splitAtTimes", { segId: s.id, timesUs: times }); n += times.length; }
      }
      return `✓ ${t("tl.splitScenes")} (${n})`;
    }
    case "globalEdit": await ed.globalEdit(x.kind); return `✓ ${t(`ge.${x.kind}`)}`;
    case "addFilter": await ed.dropItem({ type: "filter", preset: x.preset }, 0, { durationUs: Math.max(US, ed.duration()) }); return `✓ ${x.preset}`;
    case "transitionAll": await ed.exec("applyTransitionToAll", { type: x.type, durationUs: 500_000 }); return `✓ ${x.type}`;
    case "animate": { const items = targets(ed, x.scope, ["video", "image", "text", "sticker"]).map((s) => ({ segId: s.id, patch: { animation: { [x.which]: { type: x.anim, durationUs: 500_000 } } } })); await ed.exec("patchMany", { items, label: "animation" }); return `✓ ${x.anim}`; }
    case "addText": await ed.dropItem({ type: "text", preset: "outline_white", content: x.content }, ed.playhead()); return `✓ "${x.content}"`;
    case "canvasBlur": await ed.exec("setCanvas", { bgType: "blur", bgBlur: 50 }); return `✓ ${t("in.canvasBlur")}`;
    case "mute": {
      if (x.scope === "selection" && ed.selection().length) await ed.exec("patchMany", { items: ed.selection().map((id) => ({ segId: id, patch: { volumeDb: -60 } })), label: "mute" });
      else for (const tr of ed.tl().tracks.filter((q) => q.type === "video" || q.type === "audio")) await ed.exec("setTrackFlag", { trackId: tr.id, flag: "muted", value: true });
      return `✓ ${t("tl.mute")}`;
    }
    case "autoCaptions": await ed.autoCaptions(ed.settings().providers.whisperLanguage); return `✓ ${t("lib.autoCaptions")}`;
    case "reverse": { const s = targets(ed, "selection", ["video"])[0]; if (!s) throw Object.assign(new Error(), { messageKey: "err.selectionEmpty" }); await ed.exec("reverse", { segId: s.id }); return `✓ ${t("tl.reverse")}`; }
    case "freeze": { const s = ed.segmentAtPlayhead(["video"]); if (!s) throw Object.assign(new Error(), { messageKey: "err.freezeKind" }); await ed.exec("freeze", { segId: s.id, atUs: ed.playhead() }); return `✓ ${t("tl.freeze")}`; }
    case "mirror": await ed.exec("patchMany", { items: targets(ed, x.scope).map((s) => ({ segId: s.id, patch: { transform: { flipH: !s.transform?.flipH } } })), label: "mirror" }); return `✓ ${t("tl.mirror")}`;
    case "openExport": ed.run("export"); return `✓ ${t("ed.export")}`;
    default: return `? ${a.type}`;
  }
}

export { mount };
