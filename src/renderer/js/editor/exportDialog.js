// Export dialog (SCREEN-047, FEAT-113..119, FEAT-030): name, folder, video (resolution, bit rate, codec, format,
// frame rate), audio, GIF, captions, range, size estimate, progress with cancel, and the result actions.
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, guard, on } from "../api.js";
import { modal, nameError } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { toggle, select, segmented } from "../ui/controls.js";
import { formatDuration, formatBytes, US } from "../../core/util.js";
import { outputSize } from "../../core/exportGraph.js";
import { buildOverlays } from "./raster.js";

/** Rasterize overlays for the timeline and for every compound child timeline it uses (recursively). */
export async function overlaysFor(ed, tl, resolution, onlyIds = null) {
  const size = outputSize(tl.canvas, resolution);
  const overlays = await buildOverlays(tl, size.width, size.height, { onlyIds });
  const compoundOverlays = {};
  const seen = new Set();
  const walk = async (timeline) => {
    for (const tr of timeline.tracks) for (const s of tr.segments) {
      if (s.kind !== "compound" || !s.compoundTimelineId || seen.has(s.compoundTimelineId)) continue;
      seen.add(s.compoundTimelineId);
      const child = (await call("timeline.get", s.compoundTimelineId)).timeline;
      const cs = outputSize(child.canvas, "1080p");
      compoundOverlays[child.id] = await buildOverlays(child, cs.width, cs.height);
      await walk(child);
    }
  };
  await walk(tl);
  return { overlays, compoundOverlays };
}

export async function openExport(ed, { still = false, selectedOnly = false } = {}) {
  // Read the export defaults fresh (they may have been changed in Settings or by a previous export).
  const s = (await call("settings.all").catch(() => null))?.export || structuredClone(ed.settings().export);
  const tl = ed.tl();
  const project = ed.project();
  const io = ed.inOut();
  const st = {
    name: project.name, dir: s.dir, video: !still, audio: false, gif: false, captions: false,
    resolution: s.resolution, bitrate: s.bitrate, customKbps: 8000, codec: s.codec, format: s.format, fps: tl.fps || s.fps,
    audioFormat: s.audioFormat, gifResolution: s.gifResolution, captionsFormat: s.captionsFormat,
    range: selectedOnly ? "selected" : io.in !== null || io.out !== null ? "inout" : "all",
  };
  const nameIn = h("input", { type: "text", value: st.name, maxlength: 200, style: { width: "100%" } });
  const nameErr = h("div", { class: "field-error" });
  nameIn.addEventListener("input", () => { st.name = nameIn.value.trim(); const e = nameError(st.name); nameErr.textContent = e || ""; nameIn.classList.toggle("invalid", !!e); estimate(); });
  const dirEl = h("code", { class: "ltr nowrap grow", title: st.dir }, st.dir);
  const estEl = h("div", { class: "muted" }, "…");
  const encEl = h("div", { class: "banner hidden" });
  const body = h("div", { class: "export-form" });
  const prog = h("div", { class: "export-progress hidden" });
  const btn = h("button", { class: "btn primary" }, still ? t("ex.stillFrame") : t("ed.export"));

  const rangeObj = () => {
    if (st.range === "inout") return { startUs: io.in ?? 0, endUs: io.out ?? ed.duration() };
    return null;
  };
  const req = () => ({ timelineId: ed.timelineId(), name: st.name, dir: st.dir, resolution: st.resolution, bitrate: st.bitrate === "custom" ? { customKbps: st.customKbps } : st.bitrate, codec: st.codec, format: st.format, fps: Number(st.fps),
    audioFormat: st.audioFormat, gifResolution: st.gifResolution, captionsFormat: st.captionsFormat, range: rangeObj(), onlySegmentIds: st.range === "selected" ? ed.selection() : null, audioEnabled: true, videoEnabled: st.video });

  async function estimate() {
    const r = await call("export.estimate", ed.timelineId(), req()).catch(() => null);
    estEl.textContent = r ? `${t("ex.estimate", { dur: formatDuration(r.durationUs), size: formatBytes(r.sizeBytes) })} · ${r.width}×${r.height} · ${r.videoKbps} ${t("ex.kbps")} · ${r.encoder}` : "—";
    // Hardware encoder cannot take this frame size: say so (and how to stay on the GPU) instead of failing.
    encEl.classList.toggle("hidden", !((r?.hwFallback || r?.switchedTo) && st.video && !still));
    mount(encEl, icon("info"), h("span", {}, t(r?.switchedTo ? "ex.codecSwitched" : "ex.hwFallback")));
  }

  const sel = (key, options, onChange) => select({ value: st[key], options, onChange: (v) => { st[key] = v; onChange?.(); estimate(); } });
  const tg = (key) => toggle({ checked: st[key], onChange: (v) => { st[key] = v; draw(); estimate(); } });

  function draw() {
    const customKbps = h("input", { type: "number", min: 200, max: 200000, value: st.customKbps, style: { width: "90px" }, onchange: (e) => { st.customKbps = Number(e.target.value) || 8000; estimate(); } });
    mount(body,
      h("div", { class: "form-row" }, h("div", { class: "label" }, t("ex.name")), h("div", {}, nameIn, nameErr)),
      h("div", { class: "form-row" }, h("div", { class: "label" }, t("ex.exportTo")), h("div", { class: "row" }, dirEl, h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", {}); if (d) { st.dir = d; dirEl.textContent = d; dirEl.title = d; } } }, icon("folder")))),
      h("div", { class: "form-row" }, h("div", { class: "label" }, t("ex.range")), segmented({ value: st.range, options: [{ value: "all", label: t("ex.rangeAll") }, { value: "inout", label: t("ex.rangeInOut") }, { value: "selected", label: t("ex.selected") }], onChange: (v) => { st.range = v; estimate(); } })),
      still ? null : h("div", { class: "export-section" },
        h("div", { class: "row" }, tg("video"), h("strong", {}, t("ex.video"))),
        st.video ? h("div", { class: "export-grid" },
          h("span", { class: "muted" }, t("in.resolution")), sel("resolution", ["480p", "720p", "1080p", "2k", "4k", "8k"].map((r) => ({ value: r, label: r.toUpperCase() }))),
          h("span", { class: "muted" }, t("ex.bitrate")), h("div", { class: "row" }, sel("bitrate", [{ value: "lower", label: t("ex.lower") }, { value: "recommended", label: t("ex.recommended") }, { value: "higher", label: t("ex.higher") }, { value: "custom", label: t("ex.custom") }], draw), st.bitrate === "custom" ? customKbps : null, st.bitrate === "custom" ? h("span", {}, t("ex.kbps")) : null),
          h("span", { class: "muted" }, t("ex.codec")), sel("codec", [{ value: "h264", label: "H.264" }, { value: "hevc", label: "HEVC" }, { value: "av1", label: "AV1" }, { value: "prores", label: "ProRes" }, { value: "prores_alpha", label: "ProRes 4444 (alpha)" }], () => { if (st.codec.startsWith("prores")) st.format = "mov"; draw(); }),
          h("span", { class: "muted" }, t("ex.format")), sel("format", st.codec.startsWith("prores") ? ["mov"] : ["mp4", "mov"]),
          h("span", { class: "muted" }, t("in.fps")), sel("fps", [24, 25, 29.97, 30, 50, 59.94, 60].map((f) => ({ value: f, label: `${f}fps` }))),
          h("span", { class: "muted small", style: { gridColumn: "1/-1" } }, t("ex.hwHint"))) : null),
      still ? null : h("div", { class: "export-section" }, h("div", { class: "row" }, tg("audio"), h("strong", {}, t("ex.audio"))),
        st.audio ? h("div", { class: "export-grid" }, h("span", { class: "muted" }, t("ex.format")), sel("audioFormat", ["flac", "mp3", "wav", "aac"].map((f) => ({ value: f, label: f.toUpperCase() })))) : null),
      still ? null : h("div", { class: "export-section" }, h("div", { class: "row" }, tg("gif"), h("strong", {}, t("ex.gif"))),
        st.gif ? h("div", { class: "export-grid" }, h("span", { class: "muted" }, t("in.resolution")), sel("gifResolution", ["240p", "320p", "480p"])) : null),
      still ? null : h("div", { class: "export-section" }, h("div", { class: "row" }, tg("captions"), h("strong", {}, t("ex.captions"))),
        st.captions ? h("div", { class: "export-grid" }, h("span", { class: "muted" }, t("ex.format")), sel("captionsFormat", ["srt", "txt"].map((f) => ({ value: f, label: f.toUpperCase() }))), h("span", { class: "muted" }, t("ex.encoding")), h("span", {}, "UTF-8")) : null),
      encEl, estEl);
  }

  const jobs = new Map(); // jobId → {row, bar, mode, path}
  let offs = [];
  function jobRow(mode, path) {
    const bar = h("div");
    const pct = h("span", { class: "muted ltr" }, "0%");
    const row = h("div", { class: "job" }, h("div", { class: "row" }, h("strong", { class: "grow" }, mode.toUpperCase()), pct), h("div", { class: "progress" }, bar), h("div", { class: "muted small nowrap ltr", title: path }, path));
    return { row, bar, pct, mode, path };
  }

  async function start() {
    const e = nameError(st.name);
    if (e) { nameErr.textContent = e; nameIn.focus(); return; }
    const modes = still ? ["still"] : [st.video && "video", !st.video && st.audio && "audio", st.video && st.audio && "audio", st.gif && "gif", st.captions && "captions"].filter(Boolean);
    const uniqModes = [...new Set(modes)];
    if (!uniqModes.length) { toast(t("ex.video"), "warning"); return; }
    if (st.range === "selected" && !ed.selection().length) { toast(t("err.selectionEmpty"), "warning"); return; }
    btn.disabled = true;
    body.classList.add("hidden"); prog.classList.remove("hidden");
    mount(prog, h("div", { class: "loading" }, h("div", { class: "spinner" }), t("ex.preparing")));
    // Persist the chosen defaults for next time.
    call("settings.set", "export", { resolution: st.resolution, bitrate: typeof st.bitrate === "string" ? st.bitrate : "recommended", codec: st.codec, format: st.format, audioFormat: st.audioFormat, gifResolution: st.gifResolution, captionsFormat: st.captionsFormat, dir: st.dir }).catch(() => {});
    const ov = await guard(() => overlaysFor(ed, tl, st.resolution, st.range === "selected" ? ed.selection() : null));
    if (!ov) { reset(); return; }
    mount(prog);
    offs = [
      on("export:progress", (p) => { const j = jobs.get(p.jobId); if (j) { j.bar.style.width = `${Math.round(p.progress * 100)}%`; j.pct.textContent = `${Math.round(p.progress * 100)}%`; } }),
      on("export:done", (p) => { const j = jobs.get(p.jobId); if (!j) return; j.bar.style.width = "100%"; j.pct.textContent = formatBytes(p.sizeBytes); j.done = true; finishRow(j); }),
      on("export:error", (p) => { const j = jobs.get(p.jobId); if (!j) return; j.failed = true; j.row.classList.add("failed"); j.pct.textContent = p.cancelled ? t("ex.cancelled") : t("ex.failed"); if (!p.cancelled) j.row.append(h("div", { class: "field-error" }, t(p.error?.messageKey || "err.exportFailed"))); checkAll(); }),
    ];
    for (const mode of uniqModes) {
      const r = await guard(() => call("export.start", { ...req(), mode, stillAtUs: Math.max(0, ed.playhead() - (st.range === "selected" ? 0 : 0)), ...ov }));
      if (!r) continue;
      const j = jobRow(mode, r.path);
      jobs.set(r.jobId, j);
      prog.append(j.row);
      if (r.done) { j.done = true; j.bar.style.width = "100%"; j.pct.textContent = t("c.done"); finishRow(j); }
    }
    if (!jobs.size) { reset(); return; }
    btn.textContent = t("c.cancel");
    btn.disabled = false;
    btn.classList.remove("primary");
    btn.onclick = cancelAll;
  }
  function finishRow(j) {
    j.row.append(h("div", { class: "row" },
      h("button", { class: "btn small", onclick: () => call("app.showInFolder", j.path) }, icon("folder"), t("ex.openFolder")),
      j.mode !== "captions" ? h("button", { class: "btn small", onclick: () => call("app.openPath", j.path).catch(() => {}) }, icon("play"), t("ex.play")) : null));
    checkAll();
  }
  function checkAll() {
    if ([...jobs.values()].every((j) => j.done || j.failed)) {
      const ok = [...jobs.values()].some((j) => j.done);
      if (ok) toast(t("ex.done"), "success");
      btn.textContent = t("c.close"); btn.classList.add("primary"); btn.onclick = () => m.close(true);
    }
  }
  async function cancelAll() {
    for (const [id, j] of jobs) if (!j.done && !j.failed) await call("export.cancel", id).catch(() => {});
  }
  function reset() { btn.disabled = false; body.classList.remove("hidden"); prog.classList.add("hidden"); }

  btn.onclick = start;
  draw(); estimate();
  const m = modal({
    title: t("ex.title", { name: project.name }), width: 560, body: h("div", {}, body, prog),
    footer: [btn],
    onClose: () => {
      const running = [...jobs.values()].some((j) => !j.done && !j.failed);
      if (running) { toast(t("ex.exporting", { p: "…" }), "warning"); return false; }
      offs.forEach((f) => f());
    },
  });
  return m;
}

export { US };
