// «توليد الفيديو» (home page view): «استوديو توليد الفيديو بالذكاء الاصطناعي» in six sections — what to do, the video
// and the reference pictures, the part and the settings, generation with its real progress, watching/comparing/
// improving (each change is a new version of the same work), and «الفيديوهات المولّدة». Built with the app's own
// components. Opening the page loads no model and starts no engine (only "start engine", a generation or an
// improvement does). Engine and model names appear only in the engine details and the advanced settings.
import { h, mount, clear } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText, getLang } from "../i18n.js";
import { call, on } from "../api.js";
import { toast } from "../ui/toast.js";
import { modal, confirmDialog, promptDialog } from "../ui/modal.js";
import { toggle } from "../ui/controls.js";
import { formatDuration, US } from "../../core/util.js";

const guard = async (fn) => { try { return await fn(); } catch (e) { toast(errorText(e), "error"); return undefined; } };
const secs = (s) => `${(Math.round(s * 10) / 10).toLocaleString(getLang() === "ar" ? "ar-EG" : "en-GB")}`;
const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const parseTime = (v) => { const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(String(v).trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : Number(v); };
const gb = (mb) => (mb / 1024).toFixed(1);
const bytesGb = (b) => (b / 1e9).toFixed(1);
const ACTIVE = ["queued", "waiting", "starting", "running"];
const libVideo = (id) => `media://lib/${encodeURIComponent(id)}`;
const thumb = (id) => `media://vidthumb/${encodeURIComponent(id)}`;
const srcUrl = (id, pic = false) => `media://vidsrc/${encodeURIComponent(id)}${pic ? "?thumb=1" : ""}`;
const inputUrl = (id, w) => `media://vidinput/${encodeURIComponent(id)}?w=${w}`;
const closeModal = () => document.querySelector(".backdrop .modal-head .icon-btn")?.click();

export function videoView(params = {}) {
  const root = h("div", { class: "music vgen" });
  const st = {
    choices: null, setup: null, status: null, source: null, refs: [], job: null, group: null, title: "",
    s: null, end: null, plan: null, planError: null, selection: { scene: "general", style: "reference", priorities: [] }, history: [],
    libSearch: "", libFav: false, libKind: "",
    // Opened from the editor: the project to add results to, where its playhead is, and its selected range.
    project: params.videoProject || null, atUs: Number.isFinite(params.videoAtUs) ? params.videoAtUs : null,
    range: params.videoRange || null, // { timelineId, startUs, endUs }
  };
  const offs = [];
  let timer = null;

  // ---------------------------------------------------------------- engine header and model manager
  const engineBox = h("div", { class: "card pad mu-engine" });
  async function drawEngine() {
    const [status, res] = await Promise.all([call("video.status").catch(() => null), call("video.resources").catch(() => null)]);
    st.status = status;
    const running = status?.engine?.running, starting = status?.engine?.starting;
    const chip = h("span", { class: ["badge", running ? "local" : "na"] }, running ? t("vg.engineOn") : starting ? t("vg.engineStarting") : t("vg.engineOff"));
    const resText = res ? t("mu.resources", { ram: gb(res.ramFreeMB), vram: res.gpu ? gb(res.gpu.free) : "—", disk: res.diskFreeMB !== null ? gb(res.diskFreeMB) : "—" }) + (res.engineRamMB ? ` · ${t("mu.engineRam", { ram: gb(res.engineRamMB) })}` : "") : "";
    mount(engineBox,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        icon("video"), h("b", {}, t("vg.engine")), chip,
        running ? h("button", { class: "btn small", onclick: async () => { await guard(() => call("video.stop")); drawEngine(); } }, t("vg.stopEngine"))
          : h("button", { class: "btn small primary", disabled: !status?.runtime, onclick: async (e) => { e.target.disabled = true; e.target.textContent = t("vg.engineStarting"); await guard(() => call("video.start")); drawEngine(); } }, t("vg.startEngine")),
        running ? h("button", { class: "btn small ghost", title: t("mu.releaseHint"), onclick: async () => { await guard(() => call("video.release")); toast(t("mu.released"), "success"); drawEngine(); } }, t("mu.release")) : null,
        h("div", { class: "grow" }),
        h("button", { class: "btn small", onclick: openModelManager }, icon("download"), t("vg.models"))),
      h("div", { class: "muted small" }, resText),
      h("div", { class: "row small", style: { gap: "8px" } }, toggle({ checked: !!(st.setupSettings?.keepLoaded), label: t("mu.keepLoaded"), onChange: async (v) => { await guard(() => call("settings.set", "video", { keepLoaded: v })); } }), h("span", { class: "muted" }, t("vg.keepLoadedHint"))));
  }

  async function openModelManager() {
    const body = h("div", { class: "col", style: { gap: "10px" } });
    const prog = h("div", { class: "muted small" });
    const bar = h("div");
    const progBox = h("div", { class: "col", style: { gap: "4px", display: "none" } }, prog, h("div", { class: "progress" }, bar));
    const off = on("video:setup", (s) => {
      progBox.style.display = s.running ? "" : "none";
      bar.style.width = `${Math.round((s.progress || 0) * 100)}%`;
      prog.textContent = s.error ? errorText(s.error) : `${s.step ? t(`vg.setupStep.${s.step}`) === `vg.setupStep.${s.step}` ? s.step : t(`vg.setupStep.${s.step}`) : ""} ${s.total ? `${bytesGb(s.bytes)} / ${bytesGb(s.total)} GB` : `${Math.round((s.progress || 0) * 100)}%`}`;
    });
    const act = async (fn) => { await guard(fn); draw(); drawEngine(); refreshReady(); };
    const licenseOk = async (m) => {
      if (!m.accept || m.accepted) return true;
      const ok = await confirmDialog({ title: t("vg.licenseTitle", { name: m.license }), message: `${m.restrictions}\n\n${t("vg.licenseAsk")}\n${m.licenseUrl}`, okLabel: t("vg.licenseAccept") });
      if (ok) await guard(() => call("video.acceptLicense", m.id));
      return ok;
    };
    async function draw(verify = false) {
      const s = await guard(() => call("video.setupStatus", { verify }));
      if (!s) return;
      st.setup = s;
      const driverBad = s.minDriver && s.driver !== null && s.driver < s.minDriver;
      mount(body,
        h("p", { class: "muted small" }, t("vg.modelsHint")),
        s.gpu ? null : h("div", { class: "field-error small" }, t("vg.needsNvidia")),
        driverBad ? h("div", { class: "field-error small" }, t("vg.driverOld", { have: s.driver, need: s.minDriver })) : null,
        h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("span", { class: "muted" }, t("mu.modelsDir")), h("code", { class: "ltr nowrap grow", title: s.modelsDir }, s.modelsDir),
          h("button", { class: "btn small", onclick: async () => { const d = await call("dialog.openFolder", { title: t("mu.modelsDir") }); if (d) act(() => call("video.setModelsDir", d)); } }, t("set.browse"))),
        h("div", { class: "card pad" },
          h("div", { class: "row", style: { gap: "8px" } }, h("b", {}, t("vg.runtime")), h("span", { class: ["badge", s.runtime.installed ? "local" : "na"] }, s.runtime.installed ? t("mu.installed") : t("mu.notInstalled"))),
          h("div", { class: "muted small" }, t("vg.runtimeDesc", { gb: bytesGb(s.runtime.bytes || 0), comfy: s.comfyui.version, lic: s.comfyui.license })),
          s.runtime.installed ? null : h("button", { class: "btn small primary", disabled: !s.gpu || driverBad, onclick: async () => { if (await confirmDialog({ title: t("vg.runtime"), message: t("vg.confirmRuntime", { gb: "3.5", disk: bytesGb(s.runtime.bytes) }) })) act(() => call("video.installRuntime")); } }, icon("download"), t("mu.installRuntime"))),
        ...s.sets.map((m) => h("div", { class: "card pad col", style: { gap: "4px" } },
          h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("b", {}, m.name), h("span", { class: ["badge", m.installed ? "local" : "na"] }, m.installed ? t("mu.installed") : t("mu.notInstalled")),
            m.optional ? h("span", { class: "badge na" }, t("vg.optional")) : null,
            h("span", { class: "muted small" }, `${bytesGb(m.bytes)} GB`), h("span", { class: "badge na" }, t(`mu.status.${m.status}`))),
          h("div", { class: "small" }, t(`vg.set.${m.id}`)),
          h("div", { class: "small" }, `${t("mu.version")}: ${m.version}`),
          h("div", { class: "small" }, `${t("mu.license")}: ${m.license} `, m.accept ? h("span", { class: ["badge", m.accepted ? "local" : "na"] }, m.accepted ? t("vg.licenseAccepted") : t("vg.licenseNeeded")) : null,
            m.restrictions ? h("div", { class: "field-error" }, m.restrictions) : null, h("div", { class: "ltr muted" }, m.licenseUrl)),
          h("div", { class: "small muted" }, `${t("mu.needs")}: ${m.needs}`),
          h("div", { class: "small muted ltr" }, m.source),
          h("details", {}, h("summary", { class: "small" }, t("mu.files")), ...m.files.map((f) => h("div", { class: "small ltr" }, `${f.dir}/${f.file} · ${bytesGb(f.size)} GB · ${t(`mu.file.${f.state}`)}${f.partBytes ? ` (${bytesGb(f.partBytes)} GB)` : ""}`))),
          h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
            m.installed ? null : h("button", { class: "btn small primary", onclick: async () => { if (await licenseOk(m) && await confirmDialog({ title: m.name, message: t("mu.confirmDownload", { gb: bytesGb(m.bytes) }) })) act(() => call("video.downloadSet", m.id)); } }, icon("download"), m.files.some((f) => f.state === "partial") ? t("mu.resume") : t("mu.download")),
            h("button", { class: "btn small", onclick: async () => { if (!(await licenseOk(m))) return; const d = await call("dialog.openFolder", { title: t("mu.importFrom") }); if (d) act(async () => { const r = await call("video.importSet", m.id, d); toast(t("mu.imported", { n: r.report.filter((x) => ["copied", "already"].includes(x.result)).length, all: r.report.length }), "success"); }); } }, t("mu.importFrom")),
            h("button", { class: "btn small ghost", onclick: () => draw(true) }, t("mu.verify")),
            m.files.some((f) => f.state === "damaged") ? h("button", { class: "btn small", onclick: () => act(() => call("video.repairSet", m.id)) }, t("mu.repair")) : null))),
        progBox,
        h("div", { class: "row" }, h("button", { class: "btn small ghost", onclick: () => call("video.setupCancel") }, t("c.cancel"))));
    }
    modal({ title: t("vg.models"), width: 680, body, onClose: off });
    draw();
  }

  // ---------------------------------------------------------------- 1: what to do
  const readyBox = h("div");
  async function refreshReady() {
    const s = st.setup || (st.setup = await call("video.setupStatus").catch(() => null));
    const need = ["h3", "sam31"].map((id) => s?.sets.find((x) => x.id === id));
    if (!s || (s.runtime.installed && need.every((x) => x?.installed && x.accepted))) { clear(readyBox); return; }
    mount(readyBox, h("div", { class: "card pad", style: { borderColor: "var(--warning)" } },
      h("b", {}, t("vg.notReady")), h("div", { class: "small muted" }, t("vg.notReadyHint")),
      h("button", { class: "btn small primary", onclick: openModelManager }, icon("download"), t("vg.models"))));
  }
  const PATHS = [
    { id: "replace", icon: "avatar", ready: true },
    { id: "improve", icon: "hd", ready: true, note: true },
    { id: "text", icon: "text", ready: false },
    { id: "image", icon: "image", ready: false },
  ];
  const step1 = h("div");
  function drawStep1() {
    mount(step1, h("div", { class: "suite" }, PATHS.map((p) => h("button", { class: ["suite-card", p.id === "replace" && "primary", !p.ready && "disabled-card"], disabled: !p.ready,
      onclick: () => { if (p.id === "improve") document.querySelector(".vgen .vg-results")?.scrollIntoView({ behavior: "smooth" }); } },
      h("div", { class: "suite-icon" }, icon(p.icon)), h("div", { class: "suite-title" }, t(`vg.path.${p.id}`), " ", h("span", { class: "badge na" }, p.ready ? t("mu.experimental") : t("mu.notYet"))),
      h("div", { class: "suite-desc muted" }, t(`vg.path.${p.id}Desc`))))));
  }

  // ---------------------------------------------------------------- 2: the video and the reference pictures
  const step2 = h("div", { class: "col", style: { gap: "10px" } });
  const player = h("video", { class: "vg-player", controls: true, preload: "metadata" });
  function drawStep2() {
    const setSource = (src) => { st.source = src; if (!st.title) st.title = src.name.replace(/\.[^.]+$/, ""); st.end = null; if (st.s) st.s.start = 0; drawStep2(); drawStep3(); replan(); };
    const pickVideo = h("button", { class: "btn small", onclick: async () => { const [f] = await call("dialog.openFiles", { kind: "video" }); if (f) { const s = await guard(() => call("video.addSource", f)); if (s) setSource(s); } } }, icon("upload"), t("vg.pickVideo"));
    const fromProject = h("button", { class: "btn small", onclick: () => pickFromProject("video", setSource) }, icon("folder"), t("vg.fromProject"));
    const fromRange = st.range ? h("button", { class: "btn small", onclick: async () => {
      const tst = toast(t("vg.renderingRange"), "info", { ms: 120_000 });
      const s = await guard(() => call("video.addRangeSource", st.range.timelineId, st.range.startUs, st.range.endUs));
      tst.remove();
      if (s) setSource(s);
    } }, icon("scissors"), t("vg.fromRange", { s: secs((st.range.endUs - st.range.startUs) / US) })) : null;
    const recent = st.sources?.filter((x) => x.kind === "video").slice(0, 6) || [];
    const drop = h("div", { class: "mu-drop", ondragover: (e) => e.preventDefault(), ondrop: async (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f?.path) { const s = await guard(() => call("video.addSource", f.path)); if (s) setSource(s); } } }, t("vg.dropVideo"));
    if (st.source) { player.src = srcUrl(st.source.id); player.dataset.id = st.source.id; } else player.removeAttribute("src");
    const refBox = h("div", { class: "vg-refs" });
    const addRef = async (file) => { if (st.refs.length >= 3) { toast(t("vg.maxRefs"), "error"); return; } const s = await guard(() => call("video.addSource", file)); if (!s) return; if (s.kind !== "image") { toast(t("vg.refNotImage"), "error"); return; } st.refs.push(s); drawRefs(); replan(); };
    const drawRefs = () => mount(refBox,
      ...st.refs.map((r, i) => h("div", { class: "vg-ref" }, h("img", { src: srcUrl(r.id), alt: r.name }), h("span", { class: "small" }, i === 0 ? t("vg.refMain") : t("vg.refExtra", { n: i + 1 })),
        h("button", { class: "icon-btn", "aria-label": t("c.delete"), onclick: () => { st.refs.splice(i, 1); drawRefs(); replan(); } }, icon("close")))),
      st.refs.length < 3 ? h("div", { class: "vg-ref add", ondragover: (e) => e.preventDefault(), ondrop: async (e) => { e.preventDefault(); e.stopPropagation(); for (const f of [...e.dataTransfer.files].slice(0, 3)) if (f.path) await addRef(f.path); } },
        h("button", { class: "btn small", onclick: async () => { const files = await call("dialog.openFiles", { kind: "refimage", multi: true }); for (const f of (files || []).slice(0, 3 - st.refs.length)) await addRef(f); } }, icon("plus"), st.refs.length ? t("vg.addRefExtra") : t("vg.addRefMain")),
        h("button", { class: "btn small ghost", onclick: () => pickFromProject("image", (s) => { if (st.refs.length < 3) { st.refs.push(s); drawRefs(); replan(); } }) }, t("vg.fromProject")),
        h("span", { class: "muted small" }, t("vg.dropImages")),
        // Pictures used before, one click away.
        (() => { const used = new Set(st.refs.map((r) => r.id)); const imgs = (st.sources || []).filter((x) => x.kind === "image" && !used.has(x.id)).slice(0, 6);
          return imgs.length ? h("div", { class: "chips" }, h("span", { class: "muted small" }, t("vg.recent")), ...imgs.map((x) => h("button", { class: "chip", title: x.name, onclick: () => { if (st.refs.length < 3) { st.refs.push(x); drawRefs(); replan(); } } }, x.name))) : null; })()) : null);
    drawRefs();
    mount(step2,
      h("div", { class: "vg-two" },
        h("div", { class: "col", style: { gap: "6px" } },
          h("b", {}, t("vg.sourceVideo")),
          h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, pickVideo, fromProject, fromRange),
          st.source ? h("div", { class: "row small", style: { gap: "8px", flexWrap: "wrap" } }, h("b", { class: "nowrap" }, st.source.name), h("span", { class: "muted ltr" }, `${secs(st.source.durationUs / US)} ${t("mu.seconds")} · ${st.source.width}×${st.source.height}`),
            st.source.hasAudio ? null : h("span", { class: "badge na" }, t("vg.silentSource"))) : drop,
          st.source ? player : null,
          !st.source && recent.length ? h("div", { class: "chips" }, h("span", { class: "muted small" }, t("vg.recent")), ...recent.map((x) => h("button", { class: "chip", onclick: () => setSource(x) }, x.name))) : null),
        h("div", { class: "col", style: { gap: "6px" } },
          h("b", {}, t("vg.refs")), h("p", { class: "muted small" }, t("vg.refsHint")), refBox)));
  }
  async function pickFromProject(kind, pick) {
    const projects = (await call("project.list", {}).catch(() => [])) || [];
    const list = h("div", { class: "col", style: { gap: "4px", maxHeight: "360px", overflowY: "auto" } });
    modal({ title: t("vg.fromProject"), width: 520, body: list });
    for (const p of projects.slice(0, 40)) {
      const items = ((await call("media.list", p.id, {}).catch(() => [])) || []).filter((x) => x.type === kind);
      if (!items.length) continue;
      list.append(h("div", { class: "muted small" }, p.name), ...items.map((x) => h("button", { class: "list-row", onclick: async () => { const s = await guard(() => call("video.addMediaSource", x.id)); if (s) { pick(s); closeModal(); } } },
        icon(kind), h("span", { class: "grow nowrap" }, x.name), kind === "video" ? h("span", { class: "muted" }, formatDuration(x.durationUs)) : null)));
    }
    if (!list.childElementCount) list.append(h("div", { class: "empty" }, t("vg.noProjectMedia")));
  }

  // ---------------------------------------------------------------- 3: the part and the settings
  const step3 = h("div", { class: "col", style: { gap: "12px" } });
  const planLine = h("div", { class: "card pad small" });
  function drawStep3() {
    const c = st.choices;
    if (!c || !st.s) return;
    const s = st.s;
    const fps = c.fps;
    const startIn = h("input", { type: "text", class: "ltr", style: { width: "80px" }, value: mmss(s.start), onchange: (e) => { const v = parseTime(e.target.value); if (Number.isFinite(v) && v >= 0) { s.start = v; replan(); } e.target.value = mmss(s.start); } });
    const endIn = h("input", { type: "text", class: "ltr", style: { width: "80px" }, value: st.end !== null ? mmss(st.end) : "", placeholder: "0:00.0", onchange: (e) => { const v = parseTime(e.target.value); st.end = Number.isFinite(v) && v > s.start ? v : null; e.target.value = st.end !== null ? mmss(st.end) : ""; replan(); } });
    const fromPlayer = (which) => h("button", { class: "btn small ghost", disabled: !st.source, title: t("vg.fromPlayerHint"), onclick: () => { const v = Math.round(player.currentTime * fps) / fps; if (which === "start") s.start = v; else st.end = v; drawStep3(); replan(); } }, which === "start" ? t("vg.startHere") : t("vg.endHere"));
    const mode = (id, label, help) => h("button", { class: ["chip", s.durationMode === id && "active"], title: help, onclick: () => { s.durationMode = id; drawStep3(); replan(); } }, label);
    const sel = (key, items, fmt) => h("div", { class: "chips" }, items.map((v) => h("button", { class: ["chip", s[key] === v && "active"], onclick: () => { s[key] = v; drawStep3(); replan(); } }, fmt(v))));
    // The description helper.
    const pickSel = (items, key) => h("div", { class: "mu-cards" }, items.map((x) => h("button", { class: ["mu-card", st.selection[key] === x.id && "active"], title: x.help, onclick: () => { st.selection[key] = x.id; drawStep3(); } }, h("b", {}, x.ar), h("span", { class: "muted small" }, x.help))));
    const notes = h("textarea", { rows: 3, maxlength: 3000, dir: "auto", class: "ltr", style: { width: "100%" }, placeholder: t("vg.notesPh"), oninput: (e) => { s.characterNotes = e.target.value; } });
    notes.value = s.characterNotes;
    const instr = h("textarea", { rows: 3, maxlength: 3000, dir: "auto", class: "ltr", style: { width: "100%" }, placeholder: t("vg.instrPh"), oninput: (e) => { s.instructions = e.target.value; } });
    instr.value = s.instructions;
    const useDesc = h("button", { class: "btn small primary", onclick: async () => {
      const d = await guard(() => call("video.describe", st.selection));
      if (!d) return;
      st.history.push({ characterNotes: s.characterNotes, instructions: s.instructions, promptStyle: s.promptStyle });
      Object.assign(s, d); drawStep3(); toast(t("vg.descApplied"), "success");
    } }, t("vg.useDesc"));
    const undo = h("button", { class: "btn small ghost", disabled: !st.history.length, onclick: () => { const p = st.history.pop(); if (p) { Object.assign(s, p); drawStep3(); } } }, t("vg.undoDesc"));
    const seed = h("input", { type: "number", min: 0, class: "ltr", style: { width: "160px" }, value: s.seed, onchange: (e) => { s.seed = Math.max(0, Math.floor(Number(e.target.value) || 0)); } });
    mount(step3,
      h("div", { class: "col", style: { gap: "6px" } },
        h("b", {}, t("vg.part")),
        h("div", { class: "chips" },
          ...c.frameOptions.map((f) => h("button", { class: ["chip", s.durationMode === "preset" && s.frames === f && "active"], onclick: () => { s.durationMode = "preset"; s.frames = f; drawStep3(); replan(); } }, t("vg.secondsN", { s: secs(f / fps) }))),
          mode("range", t("vg.modeRange"), t("vg.modeRangeHelp")),
          mode("full", t("vg.modeFull", { s: secs(c.maxFrames / fps) }), t("vg.modeFullHelp"))),
        h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("span", {}, t("mu.from")), startIn, fromPlayer("start"),
          s.durationMode === "range" ? [h("span", {}, t("mu.to")), endIn, fromPlayer("end")] : null),
        h("div", { class: "muted small" }, t("vg.partHint", { s: secs(c.maxFrames / fps) })),
        planLine),
      h("div", { class: "mu-grid" },
        h("div", {}, h("b", {}, t("vg.quality")), sel("megapixels", c.quality, (v) => t(`vg.q.${String(v).replace(".", "_")}`)), h("div", { class: "muted small" }, t("vg.qualityHelp"))),
        h("div", {}, h("b", {}, t("vg.sound")), toggle({ checked: s.sound, label: t("vg.soundLabel"), onChange: (v) => { s.sound = v; replan(); } }), h("div", { class: "muted small" }, t("vg.soundHelp")))),
      h("div", { class: "col", style: { gap: "6px" } },
        h("b", {}, t("vg.descHelper")), h("p", { class: "muted small" }, t("vg.descHelperHint")),
        h("div", { class: "muted small" }, t("vg.scene")), pickSel(c.scenes, "scene"),
        h("div", { class: "muted small" }, t("vg.style")), pickSel(c.styles, "style"),
        h("div", { class: "muted small" }, t("vg.extra")),
        h("div", { class: "chips" }, c.priorities.map((p) => h("button", { class: ["chip", st.selection.priorities.includes(p.id) && "active"], title: p.help, onclick: () => { const a = st.selection.priorities; const i = a.indexOf(p.id); if (i >= 0) a.splice(i, 1); else a.push(p.id); drawStep3(); } }, p.ar))),
        h("div", { class: "row", style: { gap: "8px" } }, useDesc, undo, h("span", { class: "muted small" }, t("vg.styleNow", { name: c.styles.find((x) => x.id === s.promptStyle)?.ar || "" })))),
      h("div", { class: "mu-grid" },
        h("label", { class: "col" }, t("vg.notes"), notes, h("span", { class: "muted small" }, t("vg.notesHelp"))),
        h("label", { class: "col" }, t("vg.instructions"), instr, h("span", { class: "muted small" }, t("vg.instrHelp")))),
      h("details", {}, h("summary", {}, t("mu.advanced")),
        h("div", { class: "mu-grid", style: { marginTop: "8px" } },
          h("div", {}, h("b", {}, t("vg.care")), sel("steps", c.steps, (v) => t("vg.stepsN", { n: v })), h("div", { class: "muted small" }, t("vg.careHelp"))),
          h("div", {}, h("b", {}, t("vg.fast")), toggle({ checked: s.turbo, label: t("vg.fastLabel"), onChange: (v) => { s.turbo = v; drawStep3(); replan(); } }),
            s.turbo ? h("div", { class: "col", style: { gap: "4px" } }, sel("turboSteps", c.turboSteps, (v) => t("vg.stepsN", { n: v })), sel("turboStrength", [1, 0.8, 0.5], (v) => `${Math.round(v * 100)}%`)) : null,
            h("div", { class: "muted small" }, t("vg.fastHelp"))),
          h("label", { class: "col" }, t("mu.seed"), h("div", { class: "row" }, seed, h("button", { class: "btn small ghost", onclick: () => { s.seed = Math.floor(Math.random() * 2 ** 40); drawStep3(); } }, t("mu.newSeed"))), h("span", { class: "muted small" }, t("vg.seedHelp")))),
        h("div", { class: "row", style: { gap: "8px", marginTop: "8px" } },
          h("button", { class: "btn small", onclick: async () => { const r = await guard(() => call("video.saveDefaults", { generate: st.s })); if (r) toast(t("vg.defaultsSaved"), "success"); } }, t("vg.saveDefaults")),
          h("span", { class: "muted small" }, t("vg.saveDefaultsHint"))),
        h("details", { class: "small", style: { marginTop: "8px" } }, h("summary", {}, t("vg.engineDetails")), h("div", { class: "muted ltr" }, "MiniMax H3 (Reference → Video) · SAM 3.1 · SeedVR2 3B · ComfyUI"), h("div", { class: "muted" }, t("vg.engineDetailsHint")))));
    drawPlan();
  }
  async function replan() {
    clearTimeout(replan.tm);
    replan.tm = setTimeout(async () => {
      st.plan = null; st.planError = null;
      if (st.source && st.refs.length && st.s) {
        try { st.plan = await call("video.plan", { source: st.source.id, refs: st.refs.map((r) => r.id), end: st.end, settings: st.s }); } catch (e) { st.planError = e; }
      }
      drawPlan(); drawStep4();
    }, 150);
  }
  function drawPlan() {
    if (!st.source || !st.refs.length) { mount(planLine, h("span", { class: "muted" }, !st.source ? t("vg.needSource") : t("vg.needRef"))); return; }
    if (st.planError) { mount(planLine, h("span", { class: "field-error" }, errorText(st.planError))); return; }
    const p = st.plan;
    if (!p) { clear(planLine); return; }
    mount(planLine,
      h("div", {}, t("vg.planLine", { s: secs(p.seconds), from: mmss(p.start), frames: p.frames, w: p.width, h: p.height })),
      p.leftOut > 0.05 ? h("div", { class: "field-error" }, t("vg.leftOut", { s: secs(p.leftOut) })) : null,
      h("div", { class: "muted" }, p.sound ? t("vg.planSound") : t("vg.planSilent")));
  }

  // ---------------------------------------------------------------- 4: generation and progress
  const step4 = h("div", { class: "col", style: { gap: "8px" } });
  const progressBox = h("div", { class: "card pad col", style: { gap: "6px", display: "none" } });
  function drawStep4() {
    const busy = st.job && ACTIVE.includes(st.job.state);
    const can = !busy && st.plan && !st.planError;
    mount(step4,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        h("button", { class: "btn primary", disabled: !can, onclick: () => generate() }, icon("sparkle"), t("vg.generate")),
        st.plan ? h("span", { class: "muted small" }, t("vg.genSummary", { s: secs(st.plan.seconds), steps: st.plan.steps })) : null),
      h("div", { class: "muted small" }, t("vg.genHint")), progressBox);
    drawProgress();
  }
  function drawProgress() {
    const j = st.job;
    if (!j) { progressBox.style.display = "none"; return; }
    progressBox.style.display = "";
    const running = ACTIVE.includes(j.state);
    const since = j.startedAt || j.created;
    const elapsed = since ? ((j.endedAt ? new Date(j.endedAt) : new Date()) - new Date(since)) / 1000 : 0;
    const stateChip = h("span", { class: ["badge", j.state === "done" ? "local" : j.state === "failed" ? "danger" : "na"] }, t(`mu.state.${j.state}`));
    const stageText = j.state === "waiting" ? t(j.stage === "waitQueue" ? "vg.waitQueue" : "mu.waitExport") : t(`vg.stage.${j.stage}`);
    mount(progressBox,
      h("div", { class: "row", style: { gap: "8px" } }, stateChip, h("b", {}, j.kind === "enhance" ? `${t("vg.improving")} · ${stageText}` : stageText), h("div", { class: "grow" }),
        h("span", { class: "muted ltr" }, mmss(elapsed).replace(/\.\d$/, "")),
        running ? h("button", { class: "btn small ghost", onclick: async (e) => { e.target.disabled = true; await guard(() => call("video.cancel", j.id)); } }, t("c.cancel")) : null),
      j.steps ? h("div", { class: "col", style: { gap: "2px" } }, h("div", { class: "progress" }, h("div", { style: { width: `${Math.round((j.step / j.steps) * 100)}%` } })), h("span", { class: "muted small" }, t("mu.steps", { a: j.step, b: j.steps }))) : null,
      running && !j.steps ? h("div", { class: "muted small" }, t("vg.noFakeProgress")) : null,
      j.state === "failed" ? h("div", { class: "field-error small" }, errorText(j.error || {})) : null,
      j.state === "interrupted" ? h("div", { class: "muted small" }, t("vg.interrupted")) : null);
  }
  async function generate(extra = {}) {
    const req = { kind: "generate", source: st.source.id, refs: st.refs.map((r) => r.id), end: st.end, settings: { ...st.s, ...(extra.settings || {}) },
      title: st.title || t("vg.video"), group: extra.group || st.group || undefined, parent: extra.parent };
    const j = await guard(() => call("video.submit", req));
    if (!j) return;
    st.job = j; st.group = j.group;
    toast(t("mu.received"), "info", { ms: 2500 });
    drawStep4();
  }

  // ---------------------------------------------------------------- 5: watch, compare, improve (this work)
  const step5 = h("div", { class: "col vg-results", style: { gap: "10px" } });
  async function drawStep5() {
    if (!st.group) { mount(step5, h("div", { class: "muted small" }, t("vg.noResultsYet"))); return; }
    const items = (await call("video.library", { group: st.group }).catch(() => [])) || [];
    if (!items.length) { mount(step5, h("div", { class: "muted small" }, t("vg.noResultsYet"))); return; }
    mount(step5, ...items.map((x) => resultCard(x, items)));
  }
  function resultCard(x, versions) {
    const m = x.meta || {};
    const main = h("video", { class: "vg-player", controls: true, preload: "metadata", src: libVideo(x.id), poster: thumb(x.id) });
    const side = h("video", { class: "vg-player", muted: true, preload: "metadata" });
    const others = [{ id: "source", label: t("vg.cmpSource"), src: inputUrl(x.id, "source") }, ...versions.filter((v) => v.id !== x.id).map((v) => ({ id: v.id, label: v.name, src: libVideo(v.id) }))];
    const cmpSel = h("select", { onchange: () => { const o = others.find((k) => k.id === cmpSel.value); side.src = o.src; side.currentTime = main.currentTime; } }, others.map((o) => h("option", { value: o.id }, o.label)));
    side.src = others[0].src;
    // The comparison follows the result's own player.
    main.onplay = () => { side.currentTime = main.currentTime; side.play().catch(() => {}); };
    main.onpause = () => side.pause();
    main.onseeked = () => { side.currentTime = main.currentTime; };
    const cmp = h("div", { class: "vg-compare", style: { display: "none" } }, h("div", { class: "col" }, h("span", { class: "muted small" }, t("vg.cmpWith")), cmpSel, side));
    const rate = (r) => guard(async () => { const reason = r === "dislike" ? await promptDialog({ title: t("mu.whyDislike"), label: t("mu.optional") }) : ""; await call("video.rate", x.id, m.rating === r ? null : r, reason || ""); drawStep5(); drawLibrary(); });
    return h("div", { class: "card pad col", style: { gap: "8px" } },
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, h("b", { class: "nowrap" }, x.name), h("span", { class: "muted" }, formatDuration(x.durationUs)),
        m.width ? h("span", { class: "muted ltr small" }, `${m.width}×${m.height}`) : null, m.kind === "enhance" ? h("span", { class: "badge local" }, t("vg.improved")) : null, h("div", { class: "grow" }),
        h("button", { class: ["icon-btn", m.rating === "like" && "active"], title: t("mu.like"), onclick: () => rate("like") }, "👍"),
        h("button", { class: ["icon-btn", m.rating === "dislike" && "active"], title: t("mu.dislike"), onclick: () => rate("dislike") }, "👎"),
        h("button", { class: "icon-btn", title: t("mu.more"), onclick: (e) => itemMenu(x, e) }, icon("more"))),
      h("div", { class: "vg-two" }, main, cmp),
      h("div", { class: "muted small" }, [m.kind === "enhance" ? t("vg.fromVersion") : null, m.seed !== undefined ? `${t("mu.seed")} ${m.seed}` : "", m.generationSeconds ? t("mu.tookS", { s: Math.round(m.generationSeconds) }) : "", m.reason ? `«${m.reason}»` : ""].filter(Boolean).join(" · ")),
      h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        h("button", { class: "btn small primary", onclick: () => addToTimeline(x) }, icon("plus"), t("vg.addToTimeline")),
        h("button", { class: "btn small", onclick: () => { cmp.style.display = cmp.style.display === "none" ? "" : "none"; } }, icon("layout"), t("vg.compare")),
        m.kind === "generate" ? h("button", { class: "btn small", onclick: () => alternate(x) }, icon("sync"), t("vg.alternate")) : null,
        h("button", { class: "btn small", onclick: () => improve(x) }, icon("hd"), t("vg.improve")),
        h("button", { class: "btn small ghost", onclick: () => saveAs(x) }, icon("download"), t("mu.saveAs"))));
  }
  function alternate(x) {
    const m = x.meta;
    if (!st.source || !st.refs.length) { toast(t("vg.alternateNeedsInputs"), "error"); return; }
    generate({ settings: { ...m.settings, seed: Math.floor(Math.random() * 2 ** 40) }, parent: x.id, group: m.group });
  }
  async function improve(x) {
    const c = st.choices;
    const e = { ...c.enhance };
    const o = c.enhanceOptions;
    const chips = (key, items, fmt) => { const box = h("div", { class: "chips" }); const draw = () => mount(box, items.map((v) => h("button", { class: ["chip", e[key] === v && "active"], onclick: () => { e[key] = v; draw(); } }, fmt(v)))); draw(); return box; };
    const strength = h("input", { type: "range", min: 25, max: 100, value: Math.round(e.strength * 100), oninput: (ev) => { e.strength = Number(ev.target.value) / 100; sv.textContent = `${ev.target.value}%`; } });
    const sv = h("span", { class: "muted" }, `${Math.round(e.strength * 100)}%`);
    const body = h("div", { class: "col", style: { gap: "10px" } },
      h("p", { class: "muted small" }, t("vg.improveHint")),
      h("b", {}, t("vg.improveSize")), chips("shortEdge", o.shortEdge, (v) => `${v}p`),
      h("b", {}, t("vg.improveStrength")), h("div", { class: "row", style: { gap: "8px" } }, strength, sv), h("span", { class: "muted small" }, t("vg.improveStrengthHelp")),
      toggle({ checked: e.sound, label: t("vg.keepSound"), onChange: (v) => { e.sound = v; } }),
      h("details", {}, h("summary", {}, t("mu.advanced")),
        h("div", { class: "col", style: { gap: "6px", marginTop: "6px" } },
          h("span", { class: "small" }, t("vg.color")), chips("color", o.color, (v) => t(`vg.color.${v}`)),
          h("span", { class: "small" }, t("vg.chunk")), chips("chunkFrames", o.chunkFrames, (v) => (v ? t("vg.framesN", { n: v }) : t("vg.auto"))),
          h("span", { class: "small" }, t("vg.tile")), chips("tileSize", o.tileSize, (v) => `${v}`),
          h("span", { class: "small" }, t("vg.crf")), chips("crf", o.crf, (v) => t(`vg.crf.${v}`)),
          h("span", { class: "muted small" }, t("vg.improveAdvHelp")))),
      h("div", { class: "row", style: { gap: "8px" } }, h("button", { class: "btn small ghost", onclick: async () => { const r = await guard(() => call("video.saveDefaults", { enhance: e })); if (r) toast(t("vg.defaultsSaved"), "success"); } }, t("vg.saveDefaults"))));
    const ok = h("button", { class: "btn primary", onclick: async () => {
      const j = await guard(() => call("video.submit", { kind: "enhance", item: x.id, settings: e }));
      if (j) { st.job = j; st.group = j.group; closeModal(); toast(t("mu.received"), "info", { ms: 2500 }); drawStep4(); }
    } }, icon("hd"), t("vg.improve"));
    modal({ title: t("vg.improve"), width: 520, body, footer: [ok] });
  }
  async function saveAs(x) {
    const dest = await call("dialog.saveFile", { title: t("mu.saveAs"), defaultPath: `${x.name.replace(/[<>:"/\\|?*]/g, " ")}.mp4`, filters: [{ name: "MP4", extensions: ["mp4"] }] });
    if (dest) { const res = await guard(() => call("video.saveAs", x.id, dest)); if (res) toast(t("mu.savedTo", { path: res.path }), "success", { action: { label: t("ex.openFolder"), run: () => call("app.showInFolder", res.path) } }); }
  }
  /** Onto a timeline: the project this page was opened from (at its playhead or the selected range's start), or one the user picks. */
  async function addToTimeline(x) {
    const go = async (projectId, atUs) => {
      const r = await guard(() => call("video.addToTimeline", x.id, projectId, atUs));
      if (r) toast(t("vg.addedToTimeline"), "success", { action: { label: t("mu.backToEditor"), run: () => import("../state.js").then(({ app }) => app.go("editor", { projectId })) } });
    };
    if (st.project) { go(st.project, st.range ? st.range.startUs : st.atUs); return; }
    const projects = (await call("project.list", {}).catch(() => [])) || [];
    if (!projects.length) { toast(t("vg.noProjects"), "error"); return; }
    const sel = h("select", {}, projects.map((p) => h("option", { value: p.id }, p.name)));
    const ok = h("button", { class: "btn primary", onclick: () => { closeModal(); go(sel.value, null); } }, t("mu.add"));
    modal({ title: t("vg.addToTimeline"), width: 420, body: h("div", { class: "col", style: { gap: "8px" } }, h("p", { class: "muted small" }, t("vg.addToTimelineHint")), sel), footer: [ok] });
  }
  async function addToProject(x) {
    const projects = (await call("project.list", {}).catch(() => [])) || [];
    const sel = h("select", {}, projects.map((p) => h("option", { value: p.id, selected: p.id === st.project }, p.name)));
    const ok = h("button", { class: "btn primary", onclick: async () => {
      const r = await guard(() => call("video.addToProject", x.id, sel.value));
      if (r) { toast(t("mu.addedToProject", { name: projects.find((p) => p.id === sel.value)?.name || "" }), "success"); closeModal(); }
    } }, t("mu.add"));
    modal({ title: t("mu.addToProject"), width: 420, body: h("div", { class: "col", style: { gap: "8px" } }, h("p", { class: "muted small" }, t("vg.addToProjectHint")), sel), footer: [ok] });
  }
  async function itemMenu(x, e) {
    const { showMenu } = await import("../ui/menu.js");
    const r = e.target.getBoundingClientRect();
    showMenu([
      { label: t("vg.addToTimeline"), icon: "plus", run: () => addToTimeline(x) },
      { label: t("mu.addToProject"), icon: "folder", run: () => addToProject(x) },
      { label: t("mu.saveAs"), icon: "download", run: () => saveAs(x) },
      { label: t("vg.openResult"), icon: "play", run: () => { st.group = x.meta.group; drawStep5(); step5.scrollIntoView({ behavior: "smooth" }); } },
      { label: t("mu.openSettings"), icon: "adjust", run: () => { if (x.meta.kind === "generate") { st.s = { ...st.s, ...x.meta.settings }; st.group = x.meta.group; drawStep3(); replan(); step3.scrollIntoView({ behavior: "smooth" }); } } },
      { label: x.favorite ? t("mu.unfavorite") : t("mu.favorite"), icon: "star", run: async () => { await guard(() => call("video.favorite", x.id, !x.favorite)); drawLibrary(); } },
      { label: t("c.rename"), icon: "design", run: async () => { const n = await promptDialog({ title: t("c.rename"), value: x.name }); if (n) { await guard(() => call("video.rename", x.id, n)); drawLibrary(); drawStep5(); } } },
      { label: t("c.delete"), icon: "trash", danger: true, run: async () => { if (await confirmDialog({ title: t("c.delete"), message: `${x.name}\n${t("vg.deleteHint")}`, danger: true, okLabel: t("c.delete") })) { await guard(() => call("video.remove", x.id)); drawLibrary(); drawStep5(); } } },
    ], r.left, r.bottom);
  }

  // ---------------------------------------------------------------- 6: «الفيديوهات المولّدة»
  const libBox = h("div", { class: "col", style: { gap: "8px" } });
  async function drawLibrary() {
    const items = (await call("video.library", { search: st.libSearch, favorite: st.libFav, kind: st.libKind || undefined }).catch(() => [])) || [];
    const search = h("input", { type: "search", class: "search", placeholder: t("vg.searchLib"), value: st.libSearch, style: { maxWidth: "260px" }, oninput: (e) => { st.libSearch = e.target.value; clearTimeout(drawLibrary.tm); drawLibrary.tm = setTimeout(drawLibrary, 250); } });
    const kindChip = (k, label) => h("button", { class: ["chip", st.libKind === k && "active"], onclick: () => { st.libKind = k; drawLibrary(); } }, label);
    mount(libBox,
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, search, h("button", { class: ["chip", st.libFav && "active"], onclick: () => { st.libFav = !st.libFav; drawLibrary(); } }, "★ ", t("lib.favorites")),
        kindChip("", t("vg.all")), kindChip("generate", t("vg.generated")), kindChip("enhance", t("vg.improved")), h("span", { class: "muted small" }, t("vg.libCount", { n: items.length }))),
      items.length ? h("div", { class: "vg-grid" }, items.map((x) => libTile(x))) : h("div", { class: "empty" }, icon("video"), t("vg.libEmpty")));
  }
  function libTile(x) {
    const img = h("img", { src: thumb(x.id), alt: "", loading: "lazy" });
    const tile = h("div", { class: "vg-tile", draggable: true, title: t("vg.dragHint"),
      ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "libVideo", id: x.id })),
      // A short preview on hover.
      onmouseenter: () => { if (!x.exists) return; const v = h("video", { src: libVideo(x.id), muted: true, autoplay: true, loop: true, playsinline: true }); img.replaceWith(v); tile._v = v; },
      onmouseleave: () => { if (tile._v) { tile._v.replaceWith(img); tile._v = null; } } },
      img, h("div", { class: "vg-tile-meta" }, x.favorite ? h("span", {}, "★") : null, h("span", { class: "grow nowrap small" }, x.name),
        x.exists ? null : h("span", { class: "field-error small" }, t("mu.fileMissing")),
        h("span", { class: "muted small" }, formatDuration(x.durationUs)), h("button", { class: "icon-btn", onclick: (e) => { e.stopPropagation(); itemMenu(x, e); } }, icon("more"))));
    return tile;
  }

  // ---------------------------------------------------------------- layout
  const stepEl = (n, title, body, hint) => h("section", { class: "mu-step" }, h("h2", {}, h("span", { class: "mu-n" }, String(n)), title), hint ? h("p", { class: "muted small" }, hint) : null, body);
  function drawAll() { drawStep1(); drawStep2(); drawStep3(); drawStep4(); drawStep5(); refreshReady(); }
  mount(root,
    h("h1", {}, t("vg.title")),
    engineBox, readyBox,
    stepEl(1, t("vg.s1"), step1),
    stepEl(2, t("vg.s2"), step2),
    stepEl(3, t("vg.s3"), step3),
    stepEl(4, t("vg.s4"), step4),
    stepEl(5, t("vg.s5"), step5, t("vg.s5Hint")),
    stepEl(6, t("vg.s6"), libBox, t("vg.s6Hint")));

  (async () => {
    st.choices = await call("video.choices").catch(() => null);
    st.s = st.choices ? { ...st.choices.generate } : null;
    st.setupSettings = (await call("settings.all").catch(() => null))?.video;
    st.sources = (await call("video.sources").catch(() => [])) || [];
    if (params.videoSourceMedia) { // "استخدام في توليد الفيديو" on a clip: its file, from the clip's own start
      const s = await guard(() => call("video.addMediaSource", params.videoSourceMedia));
      if (s) { st.source = s; st.title = s.name.replace(/\.[^.]+$/, ""); if (st.s && params.videoStart > 0 && params.videoStart < s.durationUs / US) st.s.start = Math.round(params.videoStart * 24) / 24; }
    }
    const jobs = (await call("video.jobs").catch(() => [])) || [];
    st.job = jobs.find((j) => ACTIVE.includes(j.state)) || jobs[0] || null;
    if (st.job?.group) st.group = st.job.group;
    drawEngine(); drawAll(); drawLibrary(); replan();
  })();
  offs.push(on("video:job", (j) => {
    if (!st.job || st.job.id === j.id) st.job = j;
    drawProgress();
    if (j.state === "done") { drawStep4(); drawStep5(); drawLibrary(); drawEngine(); toast(t("vg.doneToast"), "success"); }
    if (["failed", "cancelled"].includes(j.state)) { drawStep4(); drawEngine(); }
  }));
  offs.push(on("video:engine", () => drawEngine()));
  timer = setInterval(() => { if (st.job && ["starting", "running", "waiting"].includes(st.job.state)) drawProgress(); }, 1000);
  root.dispose = () => { offs.forEach((f) => f()); clearInterval(timer); player.pause(); };
  return root;
}
