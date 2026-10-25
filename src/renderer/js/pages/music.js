// «استوديو الموسيقى» (home page view): the music engine's paths in six steps — what to make, the source and length,
// the music's character, generation with its real progress, listening/comparing/refining (each change is a new version
// in the same work group), and the generated-music library. Built with the app's own components; the engine and the
// models are never loaded by opening this page (only "start engine" or a generation does).
import { h, mount, clear } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText, getLang } from "../i18n.js";
import { call, on, libUrl } from "../api.js";
import { toast } from "../ui/toast.js";
import { modal, confirmDialog, promptDialog } from "../ui/modal.js";
import { toggle } from "../ui/controls.js";
import { formatDuration } from "../../core/util.js";
import { US } from "../../core/util.js";

const guard = async (fn) => { try { return await fn(); } catch (e) { toast(errorText(e), "error"); return undefined; } };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const parseTime = (v) => { const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(String(v).trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : Number(v); };
const gb = (mb) => (mb / 1024).toFixed(1);
const bytesGb = (b) => (b / 1e9).toFixed(1);

/** Draws loudness peaks; an optional selection [a, b] (0..1) is shaded. */
function drawWave(canvas, peaks, sel = null, cursor = null) {
  const w = canvas.width = canvas.clientWidth * devicePixelRatio || 600, hh = canvas.height = canvas.clientHeight * devicePixelRatio || 60;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, hh);
  if (sel) { g.fillStyle = "rgba(0,193,205,.18)"; g.fillRect(sel[0] * w, 0, (sel[1] - sel[0]) * w, hh); }
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#00c1cd";
  const n = peaks.length || 1, max = Math.max(0.01, ...peaks);
  for (let i = 0; i < peaks.length; i++) { const v = (peaks[i] / max) * (hh / 2 - 2); g.fillRect((i / n) * w, hh / 2 - v, Math.max(1, w / n - 0.5), v * 2); }
  if (cursor !== null) { g.fillStyle = "#fff"; g.fillRect(cursor * w, 0, 2, hh); }
}

export function musicView(params = {}) {
  const root = h("div", { class: "music" });
  const st = {
    mode: "compose", choices: null, setup: null, status: null, source: null, range: [0, 0], group: null, title: "",
    s: { preset: "reference_vibe", energy: "auto", vibe: "balanced", bpm: 0, duration: 30, loop: false, description: "", style_override: "", keyscale: "D minor", meter: 0, seed: Math.floor(Math.random() * 2 ** 31) },
    originalDescription: null, job: null, libSearch: "", libFav: false,
    // Opened from the editor: the length of the timeline's range and the project to add the result to.
    project: params.musicProject || null, fromTimeline: params.musicSeconds ? { seconds: params.musicSeconds, range: !!params.musicRange } : null,
  };
  if (st.fromTimeline) st.s.duration = st.fromTimeline.seconds;
  const offs = [];
  let player = null, playerBtn = null, timer = null;

  function play(src, btn) {
    if (player && !player.paused) { player.pause(); playerBtn?.replaceChildren(icon("play")); if (player.dataset.src === src) return; }
    player = new Audio(src); player.dataset.src = src; playerBtn = btn;
    player.play().catch(() => {}); btn?.replaceChildren(icon("pause"));
    player.onended = () => btn?.replaceChildren(icon("play"));
  }

  // ---------------------------------------------------------------- engine header and model manager
  const engineBox = h("div", { class: "card pad mu-engine" });
  async function drawEngine() {
    const [status, res] = await Promise.all([call("music.status").catch(() => null), call("music.resources").catch(() => null)]);
    st.status = status;
    const running = status?.engine?.running, starting = status?.engine?.starting;
    const chip = h("span", { class: ["badge", running ? "local" : "na"] }, running ? t("mu.engineOn") : starting ? t("mu.engineStarting") : t("mu.engineOff"));
    const resText = res ? t("mu.resources", { ram: gb(res.ramFreeMB), vram: res.gpu ? gb(res.gpu.free) : "—", disk: res.diskFreeMB !== null ? gb(res.diskFreeMB) : "—" }) + (res.engineRamMB ? ` · ${t("mu.engineRam", { ram: gb(res.engineRamMB) })}` : "") : "";
    mount(engineBox,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        icon("audio"), h("b", {}, t("mu.engine")), chip,
        running ? h("button", { class: "btn small", onclick: async () => { await guard(() => call("music.stop")); drawEngine(); } }, t("mu.stopEngine"))
          : h("button", { class: "btn small primary", disabled: !status?.runtime, onclick: async (e) => { e.target.disabled = true; e.target.textContent = t("mu.engineStarting"); await guard(() => call("music.start")); drawEngine(); } }, t("mu.startEngine")),
        running ? h("button", { class: "btn small ghost", title: t("mu.releaseHint"), onclick: async () => { await guard(() => call("music.release")); toast(t("mu.released"), "success"); drawEngine(); } }, t("mu.release")) : null,
        h("div", { class: "grow" }),
        h("button", { class: "btn small", onclick: openModelManager }, icon("download"), t("mu.models"))),
      h("div", { class: "muted small" }, resText),
      h("div", { class: "row small", style: { gap: "8px" } }, toggle({ checked: !!status?.keepLoaded, label: t("mu.keepLoaded"), onChange: async (v) => { await guard(() => call("settings.set", "music", { keepLoaded: v })); } }), h("span", { class: "muted" }, t("mu.keepLoadedHint"))));
  }

  async function openModelManager() {
    const body = h("div", { class: "col", style: { gap: "10px" } });
    const prog = h("div", { class: "muted small" });
    const bar = h("div");
    const progBox = h("div", { class: "col", style: { gap: "4px", display: "none" } }, prog, h("div", { class: "progress" }, bar));
    const off = on("music:setup", (s) => {
      progBox.style.display = s.running ? "" : "none";
      bar.style.width = `${Math.round((s.progress || 0) * 100)}%`;
      prog.textContent = s.error ? errorText(s.error) : `${s.step || ""} ${s.total ? `${bytesGb(s.bytes)} / ${bytesGb(s.total)} GB` : `${Math.round((s.progress || 0) * 100)}%`}`;
    });
    const act = async (fn) => { await guard(fn); draw(); drawEngine(); refreshReady(); };
    async function draw(verify = false) {
      const s = await guard(() => call("music.setupStatus", { verify }));
      if (!s) return;
      st.setup = s;
      mount(body,
        h("p", { class: "muted small" }, t("mu.modelsHint")),
        h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("span", { class: "muted" }, t("mu.modelsDir")), h("code", { class: "ltr nowrap grow", title: s.modelsDir }, s.modelsDir),
          h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", { title: t("mu.modelsDir") }); if (d) act(() => call("music.setModelsDir", d)); } }, t("set.browse"))),
        h("div", { class: "card pad" },
          h("div", { class: "row", style: { gap: "8px" } }, h("b", {}, t("mu.runtime")), h("span", { class: ["badge", s.runtime.installed ? "local" : "na"] }, s.runtime.installed ? t("mu.installed") : t("mu.notInstalled"))),
          h("div", { class: "muted small" }, t("mu.runtimeDesc", { gb: bytesGb(s.runtime.bytes || 0), comfy: s.comfyui.version, lic: s.comfyui.license })),
          s.runtime.installed ? null : h("button", { class: "btn small primary", onclick: async () => { if (await confirmDialog({ title: t("mu.runtime"), message: t("mu.confirmDownload", { gb: bytesGb(s.runtime.bytes) }) })) act(() => call("music.installRuntime")); } }, icon("download"), t("mu.installRuntime"))),
        ...s.sets.map((m) => h("div", { class: "card pad col", style: { gap: "4px" } },
          h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("b", {}, m.name), h("span", { class: ["badge", m.installed ? "local" : "na"] }, m.installed ? t("mu.installed") : t("mu.notInstalled")),
            h("span", { class: "muted small" }, `${bytesGb(m.bytes)} GB · ${m.engine}`), h("span", { class: ["badge", m.status === "proven" ? "local" : "na"] }, t(`mu.status.${m.status}`))),
          h("div", { class: "small" }, `${t("mu.version")}: ${m.version}`),
          h("div", { class: "small" }, `${t("mu.license")}: ${m.license}`, m.restrictions ? h("div", { class: "field-error" }, m.restrictions) : null),
          h("div", { class: "small muted" }, `${t("mu.needs")}: ${m.needs}`),
          h("div", { class: "small muted ltr" }, m.source),
          h("details", {}, h("summary", { class: "small" }, t("mu.files")), ...m.files.map((f) => h("div", { class: "small ltr" }, `${f.dir}/${f.file} · ${bytesGb(f.size)} GB · ${t(`mu.file.${f.state}`)}${f.partBytes ? ` (${bytesGb(f.partBytes)} GB)` : ""}`))),
          h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
            m.installed ? null : h("button", { class: "btn small primary", onclick: async () => { if (await confirmDialog({ title: m.name, message: t("mu.confirmDownload", { gb: bytesGb(m.bytes) }) })) act(() => call("music.downloadSet", m.id)); } }, icon("download"), m.files.some((f) => f.state === "partial") ? t("mu.resume") : t("mu.download")),
            h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", { title: t("mu.importFrom") }); if (d) act(async () => { const r = await call("music.importSet", m.id, d); toast(t("mu.imported", { n: r.report.filter((x) => ["copied", "already"].includes(x.result)).length, all: r.report.length }), "success"); }); } }, t("mu.importFrom")),
            h("button", { class: "btn small ghost", onclick: () => draw(true) }, t("mu.verify")),
            m.files.some((f) => f.state === "damaged") ? h("button", { class: "btn small", onclick: () => act(() => call("music.repairSet", m.id)) }, t("mu.repair")) : null))),
        progBox,
        h("div", { class: "row" }, h("button", { class: "btn small ghost", onclick: () => call("music.setupCancel") }, t("c.cancel"))));
    }
    modal({ title: t("mu.models"), width: 640, body, onClose: off });
    draw();
  }

  // ---------------------------------------------------------------- step 1: what to make
  const readyBox = h("div");
  async function refreshReady() {
    const s = st.setup || (st.setup = await call("music.setupStatus").catch(() => null));
    const set = s?.sets.find((x) => x.paths.includes(st.mode));
    if (!s || (s.runtime.installed && set?.installed)) { clear(readyBox); return; }
    mount(readyBox, h("div", { class: "card pad", style: { borderColor: "var(--warning)" } },
      h("b", {}, t("mu.notReady")), h("div", { class: "small muted" }, t("mu.notReadyHint")),
      h("button", { class: "btn small primary", onclick: openModelManager }, icon("download"), t("mu.models"))));
  }
  const PATHS = [
    { id: "compose", icon: "sparkle", ready: true },
    { id: "inspired", icon: "audio", ready: true, experimental: true },
    { id: "cover", icon: "sync", ready: false },
    { id: "tools", icon: "adjust", ready: false },
  ];
  const step1 = h("div");
  function drawStep1() {
    mount(step1, h("div", { class: "suite" }, PATHS.map((p) => h("button", { class: ["suite-card", st.mode === p.id && "primary", !p.ready && "disabled-card"], disabled: !p.ready,
      onclick: () => { st.mode = p.id; drawAll(); } },
      h("div", { class: "suite-icon" }, icon(p.icon)), h("div", { class: "suite-title" }, t(`mu.path.${p.id}`), " ", p.experimental ? h("span", { class: "badge na" }, t("mu.experimental")) : null, !p.ready ? h("span", { class: "badge na" }, t("mu.notYet")) : null),
      h("div", { class: "suite-desc muted" }, t(`mu.path.${p.id}Desc`))))),
    h("p", { class: "muted small" }, t("mu.newVsKeep")));
  }

  // ---------------------------------------------------------------- step 2: source and length
  const step2 = h("div", { class: "col", style: { gap: "8px" } });
  function drawStep2() {
    const dur = h("input", { type: "number", min: 4, max: 180, step: 1, value: st.s.duration, style: { width: "90px" }, onchange: (e) => { const v = Math.max(4, Math.min(180, Number(e.target.value) || 30)); st.s.duration = v; e.target.value = v; drawStep4(); } });
    const durRow = h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("span", {}, t("mu.duration")), dur, h("span", { class: "muted" }, t("mu.seconds")),
      ...[15, 30, 60, 90].map((n) => h("button", { class: ["chip", st.s.duration === n && "active"], onclick: () => { st.s.duration = n; drawStep2(); drawStep4(); } }, mmss(n))),
      h("span", { class: "muted small" }, t("mu.durationHint")),
      st.fromTimeline ? h("button", { class: ["chip", st.s.duration === st.fromTimeline.seconds && "active"], onclick: () => { st.s.duration = st.fromTimeline.seconds; drawStep2(); drawStep4(); } }, t(st.fromTimeline.range ? "mu.timelineRange" : "mu.timelineWhole", { t: mmss(st.fromTimeline.seconds) })) : null);
    if (st.mode !== "inspired") { mount(step2, durRow); return; }
    const canvas = h("canvas", { class: "mu-wave" });
    const startIn = h("input", { type: "text", value: mmss(st.range[0]), style: { width: "70px" }, class: "ltr" });
    const endIn = h("input", { type: "text", value: mmss(st.range[1]), style: { width: "70px" }, class: "ltr" });
    const info = h("span", { class: "muted small" });
    const err = h("div", { class: "field-error small" });
    const apply = () => {
      const a = parseTime(startIn.value), b = parseTime(endIn.value), D = st.source?.durationS || 0;
      if (!(a >= 0 && b > a && b <= D + 0.01)) { err.textContent = t("mu.badRange", { max: mmss(D) }); return; }
      if (b - a < 4) { err.textContent = t("mu.rangeShort"); return; }
      err.textContent = ""; st.range = [a, b]; redraw();
    };
    const redraw = () => {
      const D = st.source?.durationS || 1;
      info.textContent = t("mu.rangeInfo", { a: mmss(st.range[0]), b: mmss(st.range[1]), d: (st.range[1] - st.range[0]).toFixed(1) }) + (st.range[1] - st.range[0] > 20 ? ` · ${t("mu.refFirst20")}` : "");
      startIn.value = mmss(st.range[0]); endIn.value = mmss(st.range[1]);
      if (st.source) requestAnimationFrame(() => drawWave(canvas, st.source.peaks, [st.range[0] / D, st.range[1] / D]));
    };
    startIn.onchange = apply; endIn.onchange = apply;
    // Drag on the waveform to pick the part.
    let dragFrom = null;
    canvas.onmousedown = (e) => { if (!st.source) return; const r = canvas.getBoundingClientRect(); dragFrom = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    canvas.onmousemove = (e) => { if (dragFrom === null) return; const r = canvas.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), D = st.source.durationS; st.range = [Math.min(dragFrom, x) * D, Math.max(dragFrom, x) * D]; redraw(); };
    window.addEventListener("mouseup", () => { if (dragFrom !== null) { dragFrom = null; if (st.range[1] - st.range[0] < 4) err.textContent = t("mu.rangeShort"); else err.textContent = ""; } }, { once: false });
    const setSource = (src) => { st.source = src; st.range = [0, Math.min(src.durationS, 30)]; if (!st.title) st.title = src.name.replace(/\.[^.]+$/, ""); drawStep2(); };
    const pick = h("button", { class: "btn small", onclick: async () => { const [f] = await call("dialog.openFiles", { kind: "audio" }); if (f) { const s = await guard(() => call("music.addSource", f)); if (s) setSource(s); } } }, icon("upload"), t("mu.pickFile"));
    const projectPick = h("button", { class: "btn small", onclick: pickFromProject }, icon("folder"), t("mu.fromProject"));
    async function pickFromProject() {
      const projects = (await call("project.list", {}).catch(() => [])) || [];
      const list = h("div", { class: "col", style: { gap: "4px", maxHeight: "360px", overflowY: "auto" } });
      const m = modal({ title: t("mu.fromProject"), width: 520, body: list });
      for (const p of projects.slice(0, 40)) {
        const items = ((await call("media.list", p.id, {}).catch(() => [])) || []).filter((x) => x.hasAudio);
        if (!items.length) continue;
        list.append(h("div", { class: "muted small" }, p.name), ...items.map((x) => h("button", { class: "list-row", onclick: async () => { const s = await guard(() => call("music.addMediaSource", x.id)); if (s) { setSource(s); m.close?.(); document.querySelector(".backdrop .modal-head .icon-btn")?.click(); } } }, icon(x.type === "audio" ? "audio" : "video"), h("span", { class: "grow nowrap" }, x.name), h("span", { class: "muted" }, formatDuration(x.durationUs)))));
      }
      if (!list.childElementCount) list.append(h("div", { class: "empty" }, t("mu.noProjectAudio")));
    }
    const drop = h("div", { class: "mu-drop", ondragover: (e) => e.preventDefault(), ondrop: async (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f?.path) { const s = await guard(() => call("music.addSource", f.path)); if (s) setSource(s); } } }, t("mu.dropHere"));
    const playBtn = h("button", { class: "icon-btn", disabled: !st.source, onclick: () => play(`media://musicsrc/${st.source.id}`, playBtn) }, icon("play"));
    mount(step2,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, pick, projectPick, st.source ? h("b", { class: "nowrap" }, st.source.name) : h("span", { class: "muted" }, t("mu.noSource")), st.source ? h("span", { class: "muted" }, mmss(st.source.durationS)) : null, playBtn),
      st.source ? null : drop,
      st.source ? canvas : null,
      st.source ? h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        h("button", { class: "chip", onclick: () => { st.range = [0, st.source.durationS]; redraw(); } }, t("mu.whole")),
        h("span", {}, t("mu.from")), startIn, h("span", {}, t("mu.to")), endIn, info) : null,
      err, durRow);
    redraw();
  }

  // ---------------------------------------------------------------- step 3: character
  const step3 = h("div", { class: "col", style: { gap: "10px" } });
  function drawStep3() {
    const c = st.choices;
    if (!c) return;
    const search = h("input", { type: "search", placeholder: t("mu.searchStyles"), class: "search", style: { maxWidth: "260px" } });
    const cards = h("div", { class: "mu-cards" });
    const drawCards = () => {
      const q = search.value.trim();
      mount(cards, ...c.presets.filter((p) => !q || p.ar.includes(q) || p.help.includes(q)).map((p) => h("button", { class: ["mu-card", st.s.preset === p.id && "active"], title: p.help, onclick: () => { st.s.preset = p.id; drawCards(); } },
        h("b", {}, p.ar), h("span", { class: "muted small" }, p.help))));
    };
    search.oninput = drawCards;
    drawCards();
    const seg = (items, key, help) => h("div", { class: "col", style: { gap: "4px" } }, h("div", { class: "chips" }, items.map((x) => h("button", { class: ["chip", st.s[key] === x.id && "active"], title: x.help, onclick: () => { st.s[key] = x.id; drawStep3(); } }, x.ar))),
      h("div", { class: "muted small" }, (items.find((x) => x.id === st.s[key]) || {}).help || help || ""));
    const bpmIn = h("input", { type: "number", min: 30, max: 250, value: st.s.bpm || 100, style: { width: "80px" }, disabled: !st.s.bpm, onchange: (e) => { st.s.bpm = Math.max(30, Math.min(250, Number(e.target.value) || 100)); e.target.value = st.s.bpm; } });
    const desc = h("textarea", { rows: 2, maxlength: 1500, dir: "auto", placeholder: t("mu.descPh"), style: { width: "100%" }, oninput: (e) => { st.s.description = e.target.value; } });
    desc.value = st.s.description;
    const sugg = h("div", { class: "chips" });
    const interpret = h("button", { class: "btn small", onclick: async () => {
      const r = await guard(() => call("music.interpret", desc.value));
      if (!r) return;
      const entries = Object.entries(r.suggestions);
      if (!entries.length) { mount(sugg, h("span", { class: "muted small" }, t("mu.noSuggest"))); return; }
      mount(sugg, ...entries.map(([k, v]) => h("button", { class: "chip", onclick: () => {
        if (k === "description") { st.originalDescription ??= st.s.description; st.s.description = `${st.s.description} ${v}`.trim(); }
        else st.s[k] = v;
        drawStep3();
      } }, `${t("mu.apply")}: ${t(`mu.k.${k}`)} = ${labelOf(k, v)}`)), h("span", { class: "muted small" }, r.scope));
    } }, t("mu.suggest"));
    const revert = st.originalDescription !== null ? h("button", { class: "btn small ghost", onclick: () => { st.s.description = st.originalDescription; st.originalDescription = null; drawStep3(); } }, t("mu.revertDesc")) : null;
    const key = h("select", { onchange: (e) => { st.s.keyscale = e.target.value; } }, c.keys.map((k) => h("option", { value: k, selected: st.s.keyscale === k }, k)));
    const meter = h("select", { onchange: (e) => { st.s.meter = Number(e.target.value); } }, c.meters.map((m) => h("option", { value: m.id, selected: st.s.meter === m.id }, m.ar)));
    const seed = h("input", { type: "number", min: 0, value: st.s.seed, style: { width: "140px" }, class: "ltr", onchange: (e) => { st.s.seed = Math.max(0, Math.floor(Number(e.target.value) || 0)); } });
    const styleOv = h("textarea", { rows: 2, maxlength: 1500, class: "ltr", placeholder: t("mu.stylePh"), style: { width: "100%" }, oninput: (e) => { st.s.style_override = e.target.value; } });
    styleOv.value = st.s.style_override;
    const templates = h("select", { onchange: async (e) => { const all = await call("music.templates"); const tp = all.find((x) => x.id === e.target.value); if (tp) { st.s = { ...st.s, ...tp.settings }; drawAll(); toast(t("mu.templateApplied", { name: tp.name }), "success"); } } }, h("option", { value: "" }, t("mu.templates")));
    call("music.templates").then((all) => templates.append(...all.map((x) => h("option", { value: x.id }, x.name)))).catch(() => {});
    mount(step3,
      h("div", { class: "row", style: { gap: "8px" } }, h("b", {}, t("mu.style")), search, h("div", { class: "grow" }), templates,
        h("button", { class: "btn small ghost", onclick: async () => { const n = await promptDialog({ title: t("mu.saveTemplate"), label: t("col.name") }); if (n) { await guard(() => call("music.saveTemplate", n, st.s)); toast(t("c.saved"), "success"); drawStep3(); } } }, t("mu.saveTemplate"))),
      cards,
      h("div", { class: "mu-grid" },
        h("div", {}, h("b", {}, t("mu.energy")), seg(c.energies, "energy")),
        h("div", {}, h("b", {}, t("mu.vibe")), seg(c.vibes, "vibe")),
        h("div", {}, h("b", {}, t("mu.speed")), h("div", { class: "chips" },
          h("button", { class: ["chip", !st.s.bpm && "active"], onclick: () => { st.s.bpm = 0; drawStep3(); } }, t("mu.speedAuto")),
          h("button", { class: ["chip", !!st.s.bpm && "active"], onclick: () => { st.s.bpm = st.s.bpm || 100; drawStep3(); } }, t("mu.speedCustom")), bpmIn, h("span", { class: "muted small" }, "BPM")),
          h("div", { class: "muted small" }, st.s.bpm ? t("mu.speedCustomHelp") : t("mu.speedAutoHelp"))),
        h("div", {}, h("b", {}, t("mu.loop")), toggle({ checked: st.s.loop, label: t("mu.loopLabel"), onChange: (v) => { st.s.loop = v; } }), h("div", { class: "muted small" }, t("mu.loopHelp")))),
      h("div", {}, h("b", {}, t("mu.desc")), desc, h("div", { class: "row", style: { gap: "8px", marginTop: "4px" } }, interpret, revert), sugg),
      h("div", { class: "muted small" }, t("mu.guideOnly")),
      h("details", {}, h("summary", {}, t("mu.advanced")),
        h("div", { class: "mu-grid", style: { marginTop: "8px" } },
          h("label", { class: "col" }, t("mu.key"), key, h("span", { class: "muted small" }, t("mu.keyHelp"))),
          h("label", { class: "col" }, t("mu.meter"), meter, h("span", { class: "muted small" }, t("mu.meterHelp"))),
          h("label", { class: "col" }, t("mu.seed"), h("div", { class: "row" }, seed, h("button", { class: "btn small ghost", onclick: () => { st.s.seed = Math.floor(Math.random() * 2 ** 31); drawStep3(); } }, t("mu.newSeed"))), h("span", { class: "muted small" }, t("mu.seedHelp")))),
        h("label", { class: "col" }, t("mu.styleOverride"), styleOv, h("span", { class: "muted small" }, t("mu.styleOverrideHelp")))));
  }
  const labelOf = (k, v) => {
    const c = st.choices;
    if (k === "preset") return c.presets.find((x) => x.id === v)?.ar || v;
    if (k === "energy") return c.energies.find((x) => x.id === v)?.ar || v;
    if (k === "vibe") return c.vibes.find((x) => x.id === v)?.ar || v;
    if (k === "description") return t("mu.noDrums");
    return v;
  };

  // ---------------------------------------------------------------- step 4: generate and progress
  const step4 = h("div", { class: "col", style: { gap: "8px" } });
  const progressBox = h("div", { class: "card pad col", style: { gap: "6px", display: "none" } });
  function drawStep4() {
    const busy = st.job && ["queued", "waiting", "starting", "running"].includes(st.job.state);
    const preview = Math.min(15, st.s.duration);
    mount(step4,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        h("button", { class: "btn", disabled: busy, onclick: () => generate(preview) }, icon("play"), t("mu.genPreview", { s: preview })),
        h("button", { class: "btn primary", disabled: busy, onclick: () => generate(st.s.duration) }, icon("sparkle"), st.mode === "inspired" ? t("mu.genSelected", { s: st.s.duration }) : t("mu.genFull", { s: st.s.duration }))),
      h("div", { class: "muted small" }, t("mu.genHint")), progressBox);
    drawProgress();
  }
  function drawProgress() {
    const j = st.job;
    if (!j) { progressBox.style.display = "none"; return; }
    progressBox.style.display = "";
    const running = ["queued", "waiting", "starting", "running"].includes(j.state);
    const since = j.startedAt || j.created;
    const elapsed = since ? ((j.endedAt ? new Date(j.endedAt) : new Date()) - new Date(since)) / 1000 : 0;
    const stateChip = h("span", { class: ["badge", j.state === "done" ? "local" : j.state === "failed" ? "danger" : "na"] }, t(`mu.state.${j.state}`));
    mount(progressBox,
      h("div", { class: "row", style: { gap: "8px" } }, stateChip, h("b", {}, j.state === "waiting" ? t(j.stage === "waitQueue" ? "mu.waitQueue" : "mu.waitExport") : j.message || t(`mu.stage.${j.stage}`) || j.stage), h("div", { class: "grow" }),
        h("span", { class: "muted ltr" }, mmss(elapsed)),
        running ? h("button", { class: "btn small ghost", onclick: async () => { await guard(() => call("music.cancel", j.id)); } }, t("c.cancel")) : null),
      j.steps ? h("div", { class: "col", style: { gap: "2px" } }, h("div", { class: "progress" }, h("div", { style: { width: `${Math.round((j.step / j.steps) * 100)}%` } })), h("span", { class: "muted small" }, t("mu.steps", { a: j.step, b: j.steps }))) : null,
      j.state === "failed" ? h("div", { class: "field-error small" }, errorText(j.error || {})) : null,
      j.state === "interrupted" ? h("div", { class: "muted small" }, t("mu.interrupted")) : null);
  }
  async function generate(seconds, extra = {}) {
    if (st.mode === "inspired" && !st.source) { toast(t("mu.noSource"), "error"); return; }
    const preset = st.choices.presets.find((p) => p.id === st.s.preset);
    const title = st.title || preset?.ar || t("mu.music");
    const req = { path: st.mode, ...st.s, duration: seconds, ...extra, title, group: extra.group || st.group || undefined,
      reference: st.mode === "inspired" ? { file: st.source.file, start: st.range[0], seconds: Math.min(20, st.range[1] - st.range[0]) } : null, sourceName: st.source?.name };
    const j = await guard(() => call("music.submit", req));
    if (!j) return;
    st.job = j; st.group = j.group;
    toast(t("mu.received"), "info", { ms: 2500 });
    drawStep4();
  }

  // ---------------------------------------------------------------- step 5: listen, compare, refine (this work group)
  const step5 = h("div", { class: "col", style: { gap: "8px" } });
  async function drawStep5() {
    if (!st.group) { mount(step5, h("div", { class: "muted small" }, t("mu.noResultsYet"))); return; }
    const items = (await call("music.library", { group: st.group }).catch(() => [])) || [];
    if (!items.length) { mount(step5, h("div", { class: "muted small" }, t("mu.noResultsYet"))); return; }
    mount(step5, ...items.map((x) => resultCard(x, true)),
      items.length > 1 ? h("button", { class: "btn small ghost", onclick: () => playAll(items) }, t("mu.playAll")) : null);
  }
  function playAll(items) {
    let k = 0;
    const next = () => { if (k >= items.length) return; const a = new Audio(libUrl(items[k++].id)); a.onended = next; a.play().catch(() => {}); player?.pause(); player = a; };
    next();
  }
  function resultCard(x, refine) {
    const m = x.meta || {};
    const btn = h("button", { class: "icon-btn", disabled: !x.exists, onclick: () => play(libUrl(x.id), btn) }, icon("play"));
    const canvas = h("canvas", { class: "mu-wave small" });
    if (x.exists) call("music.peaks", x.id).then((p) => drawWave(canvas, p || [])).catch(() => {});
    const rate = (r) => guard(async () => { const reason = r === "dislike" ? await promptDialog({ title: t("mu.whyDislike"), label: t("mu.optional") }) : ""; await call("music.rate", x.id, m.rating === r ? null : r, reason || ""); drawStep5(); drawLibrary(); });
    const variant = (patch, label) => h("button", { class: "btn small", onclick: () => {
      const s = { ...m.settings, ...patch, seed: patch.seed ?? m.settings?.seed };
      st.s = { ...st.s, ...s }; st.group = m.group;
      generate(Math.round(x.durationUs / US) || s.duration, { ...patch, parent: x.id, group: m.group });
    } }, label);
    return h("div", { class: "card pad col mu-result", style: { gap: "6px" } },
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, btn, h("b", { class: "nowrap" }, x.name), h("span", { class: "muted" }, formatDuration(x.durationUs)),
        m.status ? h("span", { class: "badge na", title: t("mu.listenNote") }, t("mu.listenRequired")) : null, h("div", { class: "grow" }),
        h("button", { class: ["icon-btn", m.rating === "like" && "active"], title: t("mu.like"), onclick: () => rate("like") }, "👍"),
        h("button", { class: ["icon-btn", m.rating === "dislike" && "active"], title: t("mu.dislike"), onclick: () => rate("dislike") }, "👎"),
        st.project ? h("button", { class: "btn small", title: t("mu.addToCurrentHint"), onclick: async () => { const r = await guard(() => call("music.addToProject", x.id, st.project)); if (r) toast(t("mu.addedToCurrent"), "success", { action: { label: t("mu.backToEditor"), run: () => import("../state.js").then(({ app }) => app.go("editor", { projectId: st.project })) } }); } }, icon("plus"), t("mu.addToCurrent")) : null,
        h("button", { class: "icon-btn", title: t("mu.more"), onclick: (e) => itemMenu(x, e) }, icon("more"))),
      canvas,
      h("div", { class: "muted small" }, [m.engine, m.seed !== undefined ? `${t("mu.seed")} ${m.seed}` : "", m.generationSeconds ? t("mu.tookS", { s: Math.round(m.generationSeconds) }) : "", m.reason ? `«${m.reason}»` : ""].filter(Boolean).join(" · ")),
      refine ? h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } }, h("span", { class: "muted small" }, t("mu.refine")),
        variant({ seed: ((m.settings?.seed || 0) + 7919) % 2 ** 32 }, t("mu.r.variant")),
        variant({ energy: "calm" }, t("mu.r.calmer")),
        variant({ energy: "energetic" }, t("mu.r.energetic")),
        variant({ vibe: "free", seed: ((m.settings?.seed || 0) + 104729) % 2 ** 32 }, t("mu.r.free")),
        variant({ vibe: "close" }, t("mu.r.close")),
        variant({ loop: true }, t("mu.r.loop"))) : null);
  }

  async function itemMenu(x, e) {
    const { showMenu } = await import("../ui/menu.js");
    const r = e.target.getBoundingClientRect();
    showMenu([
      { label: t("mu.saveAs"), icon: "download", run: async () => {
        const dest = await call("dialog.saveFile", { title: t("mu.saveAs"), defaultPath: `${x.name.replace(/[<>:"/\\|?*]/g, " ")}.wav`, filters: [{ name: "WAV", extensions: ["wav"] }, { name: "MP3", extensions: ["mp3"] }, { name: "FLAC", extensions: ["flac"] }] });
        if (dest) { const res = await guard(() => call("music.saveAs", x.id, dest)); if (res) toast(t("mu.savedTo", { path: res.path }), "success", { action: { label: t("ex.openFolder"), run: () => call("app.showInFolder", res.path) } }); }
      } },
      { label: t("mu.addToProject"), icon: "plus", run: () => addToProject(x) },
      { label: t("mu.openSettings"), icon: "adjust", run: () => { st.s = { ...st.s, ...(x.meta.settings || {}) }; st.group = x.meta.group; st.mode = x.meta.path || "compose"; drawAll(); root.scrollIntoView({ behavior: "smooth" }); } },
      { label: x.favorite ? t("mu.unfavorite") : t("mu.favorite"), icon: "star", run: async () => { await guard(() => call("music.favorite", x.id, !x.favorite)); drawLibrary(); } },
      { label: t("c.rename"), icon: "design", run: async () => { const n = await promptDialog({ title: t("c.rename"), value: x.name }); if (n) { await guard(() => call("music.rename", x.id, n)); drawLibrary(); drawStep5(); } } },
      { label: t("c.delete"), icon: "trash", danger: true, run: async () => { if (await confirmDialog({ title: t("c.delete"), message: x.name, danger: true, okLabel: t("c.delete") })) { await guard(() => call("music.remove", x.id)); drawLibrary(); drawStep5(); } } },
    ], r.left, r.bottom);
  }

  async function addToProject(x) {
    const projects = (await call("project.list", {}).catch(() => [])) || [];
    const sel = h("select", {}, projects.map((p) => h("option", { value: p.id }, p.name)));
    const body = h("div", { class: "col", style: { gap: "8px" } }, h("p", { class: "muted small" }, t("mu.addToProjectHint")), sel);
    const ok = h("button", { class: "btn primary", onclick: async () => {
      const r = await guard(() => call("music.addToProject", x.id, sel.value));
      if (r) { toast(t("mu.addedToProject", { name: projects.find((p) => p.id === sel.value)?.name || "" }), "success"); document.querySelector(".backdrop .modal-head .icon-btn")?.click(); }
    } }, t("mu.add"));
    modal({ title: t("mu.addToProject"), width: 420, body, footer: [ok] });
  }

  // ---------------------------------------------------------------- step 6: library
  const libBox = h("div", { class: "col", style: { gap: "6px" } });
  async function drawLibrary() {
    const items = (await call("music.library", { search: st.libSearch, favorite: st.libFav }).catch(() => [])) || [];
    const search = h("input", { type: "search", class: "search", placeholder: t("mu.searchLib"), value: st.libSearch, style: { maxWidth: "260px" }, oninput: (e) => { st.libSearch = e.target.value; clearTimeout(drawLibrary.tm); drawLibrary.tm = setTimeout(drawLibrary, 250); } });
    const groups = new Map();
    for (const x of items) groups.set(x.meta.group, [...(groups.get(x.meta.group) || []), x]);
    mount(libBox,
      h("div", { class: "row", style: { gap: "8px" } }, search, h("button", { class: ["chip", st.libFav && "active"], onclick: () => { st.libFav = !st.libFav; drawLibrary(); } }, "★ ", t("lib.favorites")), h("span", { class: "muted small" }, t("mu.libCount", { n: items.length }))),
      items.length ? null : h("div", { class: "empty" }, icon("audio"), t("mu.libEmpty")),
      ...[...groups.values()].map((vs) => h("div", { class: "col", style: { gap: "4px" } },
        h("div", { class: "muted small" }, `${vs[0].meta.settings ? (st.choices?.presets.find((p) => p.id === vs[0].meta.settings.preset)?.ar || "") : ""} · ${t("mu.versions", { n: vs.length })} · ${new Date(vs[vs.length - 1].createdAt).toLocaleDateString(getLang() === "ar" ? "ar-EG" : "en-GB")}`),
        ...vs.map((x) => libRow(x)))));
  }
  function libRow(x) {
    const btn = h("button", { class: "icon-btn", disabled: !x.exists, onclick: () => play(libUrl(x.id), btn) }, icon("play"));
    return h("div", { class: "list-row", draggable: true, ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "libAudio", id: x.id })) },
      btn, x.favorite ? h("span", {}, "★") : null, h("span", { class: "grow nowrap" }, x.name), x.exists ? null : h("span", { class: "field-error small" }, t("mu.fileMissing")),
      h("span", { class: "muted" }, formatDuration(x.durationUs)), h("button", { class: "icon-btn", onclick: (e) => itemMenu(x, e) }, icon("more")));
  }

  // ---------------------------------------------------------------- layout
  const stepEl = (n, title, body, hint) => h("section", { class: "mu-step" }, h("h2", {}, h("span", { class: "mu-n" }, String(n)), title), hint ? h("p", { class: "muted small" }, hint) : null, body);
  function drawAll() {
    drawStep1(); drawStep2(); drawStep3(); drawStep4(); drawStep5(); refreshReady();
  }
  mount(root,
    h("h1", {}, t("nav.music")),
    engineBox, readyBox,
    stepEl(1, t("mu.s1"), step1),
    stepEl(2, t("mu.s2"), step2),
    stepEl(3, t("mu.s3"), step3),
    stepEl(4, t("mu.s4"), step4),
    stepEl(5, t("mu.s5"), step5, t("mu.s5Hint")),
    stepEl(6, t("mu.s6"), libBox, t("mu.s6Hint")));

  (async () => {
    st.choices = await call("music.choices").catch(() => null);
    const jobs = (await call("music.jobs").catch(() => [])) || [];
    st.job = jobs.find((j) => ["queued", "waiting", "starting", "running"].includes(j.state)) || jobs[0] || null;
    if (st.job?.group) st.group = st.job.group;
    drawEngine(); drawAll(); drawLibrary();
  })();
  offs.push(on("music:job", (j) => {
    if (!st.job || st.job.id === j.id) st.job = j;
    drawProgress();
    if (j.state === "done") { drawStep4(); drawStep5(); drawLibrary(); drawEngine(); toast(t("mu.doneToast"), "success"); }
    if (["failed", "cancelled"].includes(j.state)) { drawStep4(); drawEngine(); }
  }));
  offs.push(on("music:engine", () => drawEngine()));
  timer = setInterval(() => { if (st.job && ["starting", "running", "waiting"].includes(st.job.state)) drawProgress(); }, 1000);
  root.dispose = () => { offs.forEach((f) => f()); clearInterval(timer); player?.pause(); };
  return root;
}
