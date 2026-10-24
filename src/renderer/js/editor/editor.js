// Editor shell (SCREEN-013..039): top bar, materials, player, inspector and timeline; the command registry
// behind menus, buttons and keyboard shortcuts; selection, clipboard, In/Out, and the bridge to the main-process
// timeline service (every edit is one validated, persisted, undoable command).
import { h, mount, throttle } from "../dom.js";
import { icon } from "../icons.js";
import { t, errorText, fmtDateTime } from "../i18n.js";
import { call, on, guard, pathForFile } from "../api.js";
import { app, refreshSettings } from "../state.js";
import { toast } from "../ui/toast.js";
import { showMenu, dropdown } from "../ui/menu.js";
import { confirmDialog, promptDialog, nameError, anyModalOpen, modal } from "../ui/modal.js";
import { setTitle, titlebarActions } from "../app.js";
import { US, clamp, deepClone, deepMerge, formatTimecode } from "../../core/util.js";
import { chordFromEvent, lookup } from "../../core/shortcuts.js";
import { copyAttributes, cutPoints, nextMarker, ATTRIBUTE_KEYS } from "../../core/timelineOps.js";
import { findSegment, mainTrack, DEFAULT_TEXT } from "../../core/model.js";
import { TEXT_PRESETS, FILTER_PRESETS } from "../../core/presets.js";
import { Player } from "./player.js";
import { TimelineView } from "./timeline.js";
import { Materials } from "./materials.js";
import { Inspector } from "./inspector.js";
import { openExport, overlaysFor } from "./exportDialog.js";
import { record } from "./recorder.js";
import { openPilot } from "./pilot.js";
import { openSkills } from "./skills.js";
import { openSettings } from "../dialogs/settings.js";
import { openShortcuts } from "../dialogs/shortcuts.js";
import { openAbout } from "../dialogs/about.js";

const MARKER_COLORS = ["#00C1CD", "#FFD400", "#FF3B6B", "#30A46C", "#8E4EC6", "#F76B15"];
const LAYOUT_KEY = "montaj.editor.sizes";
const sizesStore = { get() { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; } }, set(v) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(v)); } catch { /* optional */ } } };

export async function openEditor(root, params) {
  mount(root, h("div", { class: "loading" }, h("div", { class: "spinner" }), t("c.loading")));
  const opened = await guard(() => call("project.open", params.projectId));
  if (!opened) { app.go("home", {}); return () => true; }
  const st = {
    project: opened.project, timelineId: opened.project.mainTimelineId, timeline: null, history: { canUndo: false, canRedo: false },
    media: [], selection: [], tool: "select", inPoint: null, outPoint: null, clipboard: null, attrClipboard: null, cut: false,
    markerColor: 0, savedAt: null, openedAt: Date.now(), compoundVersions: {}, compoundReady: {}, playing: false,
  };
  const r = await guard(() => call("timeline.get", st.timelineId));
  if (!r) { app.go("home", {}); return () => true; }
  st.timeline = r.timeline; st.history = r.history;
  st.media = (await guard(() => call("media.list", st.project.id))) || [];
  if (opened.missingMedia?.length) toast(`${t("err.mediaMissing")} (${opened.missingMedia.length})`, "warning", { ms: 7000 });

  // ------------------------------------------------------------------ editor context shared with the panels
  const ed = {
    app,
    tl: () => st.timeline,
    project: () => st.project,
    timelineId: () => st.timelineId,
    history: () => st.history,
    settings: () => app.settings,
    media: (id) => st.media.find((m) => m.id === id),
    mediaList: () => st.media,
    mediaMissing: (seg) => !!(seg.mediaId && st.media.find((m) => m.id === seg.mediaId)?.status === "missing"),
    selection: () => st.selection,
    segment: (id) => findSegment(st.timeline, id)?.segment || null,
    trackOf: (id) => findSegment(st.timeline, id)?.track || null,
    isLocked: (id) => !!findSegment(st.timeline, id)?.track.locked,
    selectedSegment: () => (st.selection.length === 1 ? ed.segment(st.selection[0]) : null),
    playhead: () => player.timeUs,
    isPlaying: () => player.playing,
    duration: () => player.endUs(),
    tool: () => st.tool,
    inOut: () => ({ in: st.inPoint, out: st.outPoint }),
    compoundVersion: (id) => st.compoundVersions[id] || 0,
    compoundReady: (id) => !!st.compoundReady[id],
    reloadTimeline,
    select, seek, exec, run, patchLive, dropItem, behindPerson, importDropped, importDialog, importFolder, refreshMedia, globalEdit, autoCaptions, importCaptions, deleteCaptions,
    applyFilterToClip, openPanel: (tab) => materials.setTab(tab), openSettings: (tab) => openSettings(tab), relayout: () => { player.lastLayout = null; player.layout(); },
    segmentAtPlayhead, clipMenu, emptyMenu, markerMenu, pickColor, coverMenu,
    onTime: (us) => { timeline.movePlayhead(us); updateTime(); },
    onPlayState: (p) => { st.playing = p; playBtn.replaceChildren(icon(p ? "pause" : "play")); },
    onTransform: (segId, patch, final) => { if (final) exec("updateSegment", { segId, patch: { transform: patch } }); else inspectorRefresh(); },
    onDoubleClick: (seg) => { if (seg?.kind === "text") { select([seg.id]); setTimeout(() => inspector.textArea?.focus(), 30); } },
    focusInspector: (seg) => { if (seg.kind === "text") setTimeout(() => inspector.textArea?.focus(), 30); },
  };

  // ------------------------------------------------------------------ layout
  const sizes = { left: 340, right: 330, bottom: 300, ...sizesStore.get() };
  const leftPane = h("section", { class: "ed-left", "aria-label": t("tab.media") });
  const playerHost = h("div", { class: "player-host" });
  const timeEl = h("span", { class: "time ltr" });
  const playBtn = h("button", { class: "icon-btn big", "aria-label": "Play/Pause (Space)", title: "Play/Pause (Space)", onclick: () => player.toggle() }, icon("play"));
  const ratioBtn = h("button", { class: "btn ghost small", onclick: (e) => dropdown(e.currentTarget, ["original", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "4:5", "2:1", "2.35:1"].map((x) => ({ label: x === "original" ? "Original" : x, checked: st.timeline.canvas.ratio === x, run: () => exec("setCanvas", { ratio: x }).then(() => ed.relayout()) }))) }, icon("fit"), h("span", {}, ""));
  const playerBar = h("div", { class: "player-bar" }, timeEl, h("div", { class: "grow" }), playBtn, h("div", { class: "grow" }),
    ratioBtn,
    h("button", { class: "icon-btn", title: "Guides (Ctrl+;)", "aria-label": "Guides", onclick: () => run("toggleGuides") }, icon("grid")),
    h("button", { class: "icon-btn", title: "Zoom fit (Alt+Shift+Z)", "aria-label": "Zoom fit", onclick: () => run("playerZoomFit") }, icon("fit")),
    h("button", { class: "icon-btn", title: "Full screen (Ctrl+Shift+F)", "aria-label": "Full screen", onclick: () => run("fullscreen") }, icon("layout")));
  const centerPane = h("section", { class: "ed-center", "aria-label": t("ed.player") }, h("div", { class: "pane-head" }, h("span", { class: "nowrap" }, t("ed.timelineTitle", { name: st.timeline.name }))), playerHost, playerBar);
  const rightPane = h("section", { class: "ed-right", "aria-label": t("ed.details") });
  const bottomPane = h("section", { class: "ed-bottom", "aria-label": "Timeline" });
  const splitV1 = h("div", { class: "splitter v", role: "separator" }), splitV2 = h("div", { class: "splitter v", role: "separator" }), splitH = h("div", { class: "splitter h", role: "separator" });
  const top = h("div", { class: "ed-top" }, leftPane, splitV1, centerPane, splitV2, rightPane);
  const savedEl = h("span", { class: "muted small" });
  const tlSel = h("button", { class: "btn ghost small", onclick: (e) => timelinesMenu(e.currentTarget) }, icon("layers"), h("span", { class: "nowrap" }, st.timeline.name));
  const topbar = h("div", { class: "ed-topbar" },
    h("button", { class: "btn ghost", onclick: (e) => mainMenu(e.currentTarget) }, icon("logo"), t("ed.menu"), icon("chevronDown")),
    savedEl, tlSel, h("div", { class: "grow" }),
    h("button", { class: "btn ghost", title: t("ai.title"), onclick: () => openPilot(ed) }, icon("sparkle"), t("ai.title")),
    h("button", { class: "btn ghost", title: t("sk.title"), onclick: () => openSkills(ed) }, icon("layers"), t("sk.title")),
    h("button", { class: "icon-btn", title: t("ed.layout"), "aria-label": t("ed.layout"), onclick: (e) => layoutMenu(e.currentTarget) }, icon("layout")),
    h("button", { class: "icon-btn", title: t("ed.shortcuts"), "aria-label": t("ed.shortcuts"), onclick: () => openShortcuts() }, icon("shortcuts")),
    h("button", { class: "btn", onclick: () => sharePackage() }, icon("share"), t("ed.share")),
    h("button", { class: "btn primary", onclick: () => run("export") }, icon("upload"), t("ed.export")));
  const shell = h("div", { class: ["editor", `layout-${app.settings.general.layout || "default"}`] }, topbar, top, splitH, bottomPane);
  mount(root, shell);
  setTitle(st.project.name);
  const applySizes = () => { shell.style.setProperty("--left-w", `${sizes.left}px`); shell.style.setProperty("--right-w", `${sizes.right}px`); shell.style.setProperty("--bottom-h", `${sizes.bottom}px`); };
  applySizes();
  dragSplit(splitV1, (dx) => { sizes.left = clamp(sizes.left + (document.dir === "rtl" ? -dx : dx), 220, 640); applySizes(); });
  dragSplit(splitV2, (dx) => { sizes.right = clamp(sizes.right - (document.dir === "rtl" ? -dx : dx), 240, 620); applySizes(); });
  dragSplit(splitH, (_dx, dy) => { sizes.bottom = clamp(sizes.bottom - dy, 160, innerHeight - 300); applySizes(); });
  function dragSplit(el, fn) {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      let x = e.clientX, y = e.clientY;
      const move = (ev) => { fn(ev.clientX - x, ev.clientY - y); x = ev.clientX; y = ev.clientY; };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); sizesStore.set(sizes); player.layout(); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    });
  }

  const player = new Player(playerHost, ed);
  ed.player = player;
  if (app.info.bench) window.__montaj = { player, ed, timeline: () => st.timeline }; // benchmark hook (MONTAJ_BENCH=1 only)
  const materials = new Materials(leftPane, ed);
  const inspector = new Inspector(rightPane, ed);
  const timeline = new TimelineView(bottomPane, ed);
  player.layout();
  renderAll();
  requestAnimationFrame(() => timeline.zoomFit());

  // ------------------------------------------------------------------ state updates
  function renderAll() {
    timeline.drawToolbar();
    timeline.render();
    inspector.render();
    player.invalidate();
    updateTime();
    ratioBtn.lastChild.textContent = st.timeline.canvas.ratio === "original" ? "Original" : st.timeline.canvas.ratio;
    tlSel.lastChild.textContent = st.timeline.name;
    savedEl.textContent = st.savedAt ? t("ed.autoSaved", { time: new Date(st.savedAt).toLocaleTimeString() }) : "";
  }
  const inspectorRefresh = throttle(() => inspector.render(), 120);
  function updateTime() { timeEl.textContent = `${formatTimecode(player.timeUs, st.timeline.fps)} / ${formatTimecode(player.endUs(), st.timeline.fps)}`; }

  function select(ids, { soft = false } = {}) {
    st.selection = [...new Set(ids)].filter((id) => ed.segment(id));
    if (soft) timeline.markSelection(st.selection); else timeline.render();
    inspector.render();
    player.invalidate();
  }
  function seek(us, o) { player.seek(us, o); timeline.movePlayhead(player.timeUs); updateTime(); inspectorRefresh(); }

  /** Run a timeline command in the main process and adopt the returned state. */
  async function exec(cmd, args = {}) {
    try {
      const before = player.endUs();
      const res = await call("timeline.exec", st.timelineId, cmd, args);
      st.timeline = res.timeline; st.history = res.history; st.savedAt = Date.now();
      st.selection = st.selection.filter((id) => ed.segment(id));
      if (["addMedia", "addSegment", "freeze"].includes(cmd) && typeof res.result === "string" && ed.segment(res.result)) st.selection = [res.result];
      if (cmd === "pasteSegments" && Array.isArray(res.result)) st.selection = res.result;
      if (cmd === "createCompound" && typeof res.result === "string") { st.selection = [res.result]; preprocessCompound(res.compoundTimelineId); }
      renderAll();
      if (before === 0 && player.endUs() > 0) timeline.zoomFit(); // first material added: fit it
      return res;
    } catch (err) {
      toast(errorText(err), "error");
      if (!err?.messageKey) console.error(err);
      // Re-sync the view (a live preview patch may have diverged from the stored state).
      const cur = await call("timeline.get", st.timelineId).catch(() => null);
      if (cur) { st.timeline = cur.timeline; st.history = cur.history; renderAll(); }
      return null;
    }
  }

  /** Preview-only patch while dragging a control (committed by exec on release). */
  function patchLive(segId, patch) {
    const seg = ed.segment(segId);
    if (!seg) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && !Array.isArray(v) && seg[k] && typeof seg[k] === "object") seg[k] = deepMerge(seg[k], v);
      else seg[k] = deepClone(v);
    }
    player.invalidate();
  }

  /** Adopt the stored timeline state (after a skill run or an edit made by an agent through MCP). */
  async function reloadTimeline() {
    const cur = await call("timeline.get", st.timelineId).catch(() => null);
    if (!cur) return;
    st.timeline = cur.timeline; st.history = cur.history; st.savedAt = Date.now();
    st.selection = st.selection.filter((id) => ed.segment(id));
    await refreshMedia();
    renderAll();
  }
  // An agent edited a timeline (source "agent:<name>"): show the change live and say who made it.
  let agentToastAt = 0;
  const offAgentEdit = on("timeline:changed", throttle((e) => {
    if (e.timelineId !== st.timelineId) return;
    reloadTimeline();
    // One notice per burst (a skill run is many small edits), not one per edit.
    if (String(e.source).startsWith("agent:") && Date.now() - agentToastAt > 4000) { agentToastAt = Date.now(); toast(t("ag.edited", { name: e.source.slice(6) }), "info", { ms: 3000 }); }
  }, 250));

  async function refreshMedia() { st.media = (await guard(() => call("media.list", st.project.id))) || st.media; materials.refresh(); timeline.render(); player.invalidate(); }
  // Thumbnails / waveforms / proxies finished (or media imported elsewhere, e.g. TTS, recording): reload the list.
  const offMedia = on("media:updated", throttle(() => refreshMedia(), 300));
  // A person matte finished (here or for an agent): the preview loads it at once.
  const offMatte = on("matte:ready", (e) => { for (const mid of e.mediaIds || []) player.mattes.delete(mid); player.invalidate(); });

  /** Put layers behind the person (or back in front); the first time per video, its person matte is made. */
  async function behindPerson(ids, value = true) {
    const res = await exec("setBehindPerson", { ids, value });
    if (!res || !value) return res;
    const tst = toast(t("lib.matteWorking", { p: 0 }), "info", { ms: 30 * 60_000 });
    const offP = on("matte:progress", (e) => { tst.firstChild.textContent = t("lib.matteWorking", { p: Math.round(e.progress * 100) }); });
    try {
      const r = await call("mattes.prepare", st.timelineId);
      if (r.made) toast(t("lib.matteDone"), "success");
    } catch (err) { toast(errorText(err), "error", { ms: 8000 }); } finally { offP(); tst.remove(); }
    return res;
  }

  // ------------------------------------------------------------------ import
  async function importPaths(paths, { atUs = null, toMain = true, addToTimeline = false } = {}) {
    if (!paths.length) return;
    const tst = toast(t("c.loading"), "info", { ms: 120_000 });
    const res = await guard(() => call("media.import", st.project.id, paths));
    tst.remove();
    if (!res) return;
    for (const e of res.errors || []) toast(`${e.file.split(/[\\/]/).pop()}: ${t(e.error.messageKey || "err.internal")}`, "error");
    await refreshMedia();
    if (addToTimeline) {
      let at = atUs;
      for (const m of res.imported) {
        const r2 = await exec("addMedia", { mediaId: m.id, atUs: at, toMain: m.type !== "audio" && toMain });
        if (r2 && at !== null) { const s = ed.segment(r2.result); if (s) at = s.start + s.duration; }
      }
    }
  }
  async function importDialog() { const files = await call("dialog.openFiles", { kind: "media", multi: true }); await importPaths(files); }
  async function importFolder() { const dir = await call("dialog.openFolder", {}); if (!dir) return; const tst = toast(t("c.loading"), "info", { ms: 120_000 }); const res = await guard(() => call("media.importFolder", st.project.id, dir)); tst.remove(); if (res) { for (const e of res.errors || []) toast(`${e.file}: ${t(e.error.messageKey)}`, "error"); await refreshMedia(); } }
  function importDropped(files, opts) { importPaths(files.map((f) => pathForFile(f)).filter(Boolean), opts); }
  // Dropping files anywhere on the editor (outside the timeline) imports them into Media.
  shell.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  shell.addEventListener("drop", (e) => { if (e.defaultPrevented || !e.dataTransfer.files.length) return; e.preventDefault(); importDropped([...e.dataTransfer.files], {}); });

  /** Add a material item (text, sticker, effect, filter, adjust, library audio) at a time. */
  async function dropItem(item, atUs, { durationUs = 3 * US } = {}) {
    const at = Math.max(0, Math.round(atUs ?? player.timeUs));
    if (item.type === "libAudio") {
      const m = await guard(() => call("library.useAudio", st.project.id, item.id));
      if (!m) return null;
      await refreshMedia();
      return exec("addMedia", { mediaId: m.id, toMain: false, atUs: at });
    }
    const init = {};
    let kind = item.type;
    if (item.type === "text") init.text = { ...DEFAULT_TEXT, ...(TEXT_PRESETS[item.preset] || {}), preset: item.preset || "none", content: item.content || (document.documentElement.lang === "ar" ? "نص افتراضي" : DEFAULT_TEXT.content) };
    if (item.type === "sticker") init.sticker = { builtin: item.builtin || null, assetId: item.assetId || null };
    if (item.type === "effect") init.effect = { type: item.effect, intensity: 50 };
    if (item.type === "filter") init.filter = { preset: item.preset, intensity: 100 };
    if (item.type === "adjust") kind = "adjust";
    return exec("addSegment", { kind, atUs: at, durationUs, init });
  }

  function applyFilterToClip(seg, preset) {
    const p = FILTER_PRESETS[preset];
    if (!p || !seg.adjust) return;
    exec("updateSegment", { segId: seg.id, patch: { adjust: { ...p.adjust } } });
  }

  // ------------------------------------------------------------------ captions, global edits
  async function importCaptions() {
    const [file] = await call("dialog.openFiles", { kind: "captions" });
    if (!file) return;
    const cues = await guard(() => call("captions.importFile", file));
    if (!cues) return;
    if (!cues.length) { toast(t("err.captionFormat"), "error"); return; }
    await addCaptionSegments(cues, "auto");
  }
  async function addCaptionSegments(cues, language) {
    const segs = await guard(() => call("captions.segmentsFromCues", cues, { offsetUs: 0, canvasHeight: st.timeline.canvas.height, language }));
    if (!segs?.length) return;
    // One caption track: insert each cue as a text segment (validated by the main process).
    let n = 0;
    for (const s of segs) { const r2 = await call("timeline.exec", st.timelineId, "addSegment", { kind: "text", atUs: s.start, durationUs: s.duration, init: { name: s.name, text: s.text, transform: s.transform } }).catch((e) => { toast(errorText(e), "error"); return null; }); if (r2) { st.timeline = r2.timeline; st.history = r2.history; n++; } }
    st.savedAt = Date.now();
    renderAll();
    toast(`${t("lib.addCaptions")}: ${n}`, "success");
  }
  async function deleteCaptions() {
    const ids = []; for (const tr of st.timeline.tracks) for (const s of tr.segments) if (s.kind === "text" && s.text?.isCaption) ids.push(s.id);
    if (ids.length) await exec("delete", { ids });
  }
  async function autoCaptions(language = "auto") {
    const clips = (st.selection.length ? st.selection.map(ed.segment) : mainTrack(st.timeline).segments).filter((s) => s && ["video", "audio"].includes(s.kind) && ed.media(s.mediaId)?.hasAudio);
    if (!clips.length) { toast(t("err.noAudio"), "warning"); return; }
    const tst = toast(t("c.loading"), "info", { ms: 30 * 60_000 });
    const all = [];
    try {
      for (const s of clips) {
        const cues = await call("captions.transcribe", { mediaId: s.mediaId, sourceStartUs: s.sourceStart, durationUs: s.duration, timelineStartUs: s.start, speed: s.speedMode === "curve" ? 1 : s.speed || 1, language });
        all.push(...cues.filter((c) => c.endUs > s.start && c.startUs < s.start + s.duration));
      }
    } catch (err) { tst.remove(); toast(errorText(err), "error"); return; }
    tst.remove();
    if (!all.length) { toast(t("err.noCaptions"), "warning"); return; }
    await addCaptionSegments(all, language);
  }
  async function globalEdit(kind) {
    const tst = toast(t("c.loading"), "info", { ms: 10 * 60_000 });
    const patches = await guard(() => call("analysis.globalEditPatches", st.timelineId, kind));
    tst.remove();
    if (!patches) return;
    if (!patches.length) { toast(t("ge." + kind) + " ✓", "info"); return; }
    await exec("patchMany", { items: patches, label: kind });
    toast(`${t("ge." + kind)} ✓`, "success");
  }

  // ------------------------------------------------------------------ helpers for commands
  function segmentAtPlayhead(kinds = null) {
    const ph = player.timeUs;
    const sel = st.selection.map(ed.segment).filter((s) => s && ph >= s.start && ph < s.start + s.duration && (!kinds || kinds.includes(s.kind)));
    if (sel.length) return sel[0];
    const tracks = [...st.timeline.tracks].sort((a, b) => b.order - a.order);
    for (const tr of tracks) for (const s of tr.segments) if (ph >= s.start && ph < s.start + s.duration && (!kinds || kinds.includes(s.kind)) && !tr.locked) return s;
    return null;
  }
  const targetIds = () => (st.selection.length ? st.selection : (segmentAtPlayhead() ? [segmentAtPlayhead().id] : []));
  function needSel(kinds) { const s = st.selection.length === 1 ? ed.segment(st.selection[0]) : segmentAtPlayhead(kinds); if (!s || (kinds && !kinds.includes(s.kind))) { toast(t("err.selectionEmpty"), "warning"); return null; } return s; }
  async function toggleEdit(key) { const v = !app.settings.edit[key]; await guard(() => call("settings.set", "edit", { [key]: v })); await refreshSettings(); timeline.drawToolbar(); player.invalidate(); toast(`${{ magnet: t("tl.magnet"), snapping: t("tl.snap"), linkageEnabled: t("tl.linkage"), previewAxis: t("tl.previewAxis") }[key]}: ${v ? "ON" : "OFF"}`, "info", { ms: 1200 }); }
  function step(frames) { seek(player.timeUs + (frames * US) / (st.timeline.fps || 30)); }
  async function preprocessCompound(childId) {
    const id = childId || ed.selectedSegment()?.compoundTimelineId;
    if (!id) { toast(t("err.selectionEmpty"), "warning"); return; }
    const tst = toast(t("ex.preprocessing"), "info", { ms: 10 * 60_000 });
    const child = (await call("timeline.get", id)).timeline;
    const ov = await overlaysFor(ed, child, "1080p");
    const r2 = await guard(() => call("export.renderCompound", id, ov.overlays));
    tst.remove();
    if (r2) { st.compoundReady[id] = true; st.compoundVersions[id] = Date.now(); player.videos.forEach((v, k) => { if (ed.segment(k)?.compoundTimelineId === id) player.videos.delete(k); }); renderAll(); toast(t("in.preprocessed"), "success"); }
  }
  for (const tr of st.timeline.tracks) for (const s of tr.segments) if (s.kind === "compound") call("export.compoundStatus", s.compoundTimelineId).then((ok) => { st.compoundReady[s.compoundTimelineId] = ok; if (ok) player.invalidate(); }).catch(() => {});

  async function savePreset() {
    const s = needSel(); if (!s) return;
    const name = await promptDialog({ title: t("ctx.savePreset"), value: s.name || s.kind, validate: nameError });
    if (!name) return;
    const list = [...(app.settings.ui.presets || []), JSON.stringify({ name, kind: s.kind, attrs: copyAttributes(s) })];
    if (await guard(() => call("settings.set", "ui", { presets: list }))) { await refreshSettings(); toast(t("c.saved"), "success"); }
  }
  const presets = () => (app.settings.ui.presets || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);

  async function replaceClip() {
    const s = needSel(["video", "image", "audio"]); if (!s) return;
    const [file] = await call("dialog.openFiles", { kind: s.kind === "audio" ? "audio" : "media" });
    if (!file) return;
    const res = await guard(() => call("media.import", st.project.id, [file]));
    if (!res?.imported?.length) { if (res?.errors?.[0]) toast(t(res.errors[0].error.messageKey), "error"); return; }
    await refreshMedia();
    await exec("replaceClip", { segId: s.id, mediaId: res.imported[0].id });
  }

  function pickColor(cb) {
    toast("🎯", "info", { ms: 1500 });
    const handler = (e) => {
      e.stopPropagation(); e.preventDefault();
      player.overlay.removeEventListener("pointerdown", handler, true);
      const p = player.toCanvas(e);
      const d = player.ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      cb(`#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
    };
    player.overlay.addEventListener("pointerdown", handler, true);
  }

  // ------------------------------------------------------------------ command registry (menus, toolbar, shortcuts)
  const commands = {
    // timeline
    split: () => { const ids = st.selection.length ? st.selection : null; return exec("split", { atUs: player.timeUs, ids }); },
    splitAll: () => exec("splitAll", { atUs: player.timeUs }),
    selectMode: () => { st.tool = "select"; shell.classList.remove("tool-split"); timeline.drawToolbar(); },
    splitMode: () => { st.tool = "split"; shell.classList.add("tool-split"); timeline.drawToolbar(); },
    selectLeftward: () => select(st.timeline.tracks.flatMap((tr) => tr.segments.filter((s) => s.start < player.timeUs).map((s) => s.id))),
    selectRightward: () => select(st.timeline.tracks.flatMap((tr) => tr.segments.filter((s) => s.start + s.duration > player.timeUs).map((s) => s.id))),
    toggleMagnet: () => toggleEdit("magnet"), toggleSnapping: () => toggleEdit("snapping"), toggleLinkage: () => toggleEdit("linkageEnabled"), togglePreviewAxis: () => toggleEdit("previewAxis"),
    zoomIn: () => timeline.setZoom(timeline.pxPerSec * 1.4), zoomOut: () => timeline.setZoom(timeline.pxPerSec / 1.4), zoomFit: () => timeline.zoomFit(),
    toggleClipActive: () => { const ids = targetIds(); if (!ids.length) return; const anyOn = ids.some((id) => !ed.segment(id)?.disabled); return exec("setDisabled", { ids, value: anyOn }); },
    extractAudio: () => { const s = needSel(["video", "compound"]); if (s) return exec("extractAudio", { segId: s.id }); },
    addMarker: () => exec("addMarker", { timeUs: player.timeUs, color: MARKER_COLORS[st.markerColor] }),
    addMarkerColor: () => { st.markerColor = (st.markerColor + 1) % MARKER_COLORS.length; return exec("addMarker", { timeUs: player.timeUs, color: MARKER_COLORS[st.markerColor] }); },
    nextMarker: () => { const m = nextMarker(st.timeline, player.timeUs, 1); if (m) seek(m.timeUs); },
    prevMarker: () => { const m = nextMarker(st.timeline, player.timeUs, -1); if (m) seek(m.timeUs); },
    prevFrame: () => step(-1), nextFrame: () => step(1), firstFrame: () => seek(0), lastFrame: () => seek(player.endUs()),
    stepForwardMany: () => step(app.settings.edit.stepFrames || 10), stepBackMany: () => step(-(app.settings.edit.stepFrames || 10)),
    prevCut: () => { const p = cutPoints(st.timeline).filter((x) => x < player.timeUs - 1).pop(); if (p !== undefined) seek(p); },
    nextCut: () => { const p = cutPoints(st.timeline).find((x) => x > player.timeUs + 1); if (p !== undefined) seek(p); },
    inPoint: () => { st.inPoint = player.timeUs; if (st.outPoint !== null && st.outPoint <= st.inPoint) st.outPoint = null; timeline.drawRange(); timeline.drawRuler(); },
    outPoint: () => { st.outPoint = player.timeUs; if (st.inPoint !== null && st.inPoint >= st.outPoint) st.inPoint = null; timeline.drawRange(); timeline.drawRuler(); },
    clearInOut: () => { st.inPoint = st.outPoint = null; timeline.drawRange(); timeline.drawRuler(); },
    selectByClip: () => { const s = segmentAtPlayhead(); if (s) select([s.id]); },
    deselect: () => select([]),
    group: () => exec("group", { ids: st.selection }), ungroup: () => exec("ungroup", { ids: st.selection }),
    speedPanel: () => { const s = needSel(["video", "audio", "compound"]); if (s) { select([s.id]); inspector.tab[s.kind] = "speed"; inspector.render(); } },
    curveSpeed: () => { const s = needSel(["video", "audio", "compound"]); if (s) { select([s.id]); inspector.tab[s.kind] = "speed"; exec("setCurve", { segId: s.id, preset: s.speedMode === "curve" ? "none" : "montage" }); } },
    createCompound: () => (st.selection.length ? exec("createCompound", { ids: st.selection, name: `${t("in.compound")} ${new Date().toLocaleTimeString()}` }) : toast(t("err.selectionEmpty"), "warning")),
    undoCompound: () => { const s = needSel(["compound"]); if (s) return exec("undoCompound", { segId: s.id }); },
    preprocessCompound: () => preprocessCompound(),
    volumeUp: () => { const ids = targetIds(); if (ids.length) return exec("patchMany", { items: ids.map((id) => ({ segId: id, patch: { volumeDb: clamp((ed.segment(id).volumeDb || 0) + 0.1, -60, 20) } })), label: "volume" }); },
    volumeDown: () => { const ids = targetIds(); if (ids.length) return exec("patchMany", { items: ids.map((id) => ({ segId: id, patch: { volumeDb: clamp((ed.segment(id).volumeDb || 0) - 0.1, -60, 20) } })), label: "volume" }); },
    playInOut: () => { if (st.inPoint === null && st.outPoint === null) { toast(t("ex.rangeInOut"), "info"); return; } player.range = { startUs: st.inPoint ?? 0, endUs: st.outPoint ?? player.endUs() }; player.seek(player.range.startUs); player.play().then(() => {}); const off = setInterval(() => { if (!player.playing) { player.range = null; clearInterval(off); } }, 200); },
    shuttleLeft: () => { player.pause(); seek(player.timeUs - US); },
    shuttleStop: () => player.pause(),
    shuttleRight: () => player.play(),
    deleteLeft: () => { const s = segmentAtPlayhead(); if (s) return exec("deleteSide", { segId: s.id, atUs: player.timeUs, side: "left" }); },
    deleteRight: () => { const s = segmentAtPlayhead(); if (s) return exec("deleteSide", { segId: s.id, atUs: player.timeUs, side: "right" }); },
    keyframePanel: () => { const s = needSel(); if (s) { select([s.id]); inspector.tab[s.kind] = ["text"].includes(s.kind) ? "text" : "video"; inspector.render(); } },
    addKeyframe: async () => {
      const s = needSel(["video", "image", "text", "sticker", "compound"]); if (!s) return;
      const local = clamp(player.timeUs - s.start, 0, s.duration);
      const tr = s.transform || {};
      for (const [prop, value] of [["x", tr.x || 0], ["y", tr.y || 0], ["scale", tr.scale ?? 1], ["rotation", tr.rotation || 0], ["opacity", tr.opacity ?? 1]]) await exec("addKeyframe", { segId: s.id, prop, timeUs: local, value });
    },
    easeIn: () => easing("easeIn"), easeOut: () => easing("easeOut"), easing: () => easing("easeInOut"), linear: () => easing("linear"),
    freeze: () => { const s = needSel(["video"]); if (s) return exec("freeze", { segId: s.id, atUs: clamp(player.timeUs, s.start, s.start + s.duration - 1) }); },
    reverse: () => { const s = needSel(["video"]); if (s) { toast(t("c.loading"), "info"); return exec("reverse", { segId: s.id }); } },
    mirror: () => { const s = needSel(["video", "image", "text", "sticker", "compound"]); if (s) return exec("updateSegment", { segId: s.id, patch: { transform: { flipH: !s.transform?.flipH } } }); },
    rotate: () => { const s = needSel(["video", "image", "text", "sticker", "compound"]); if (s) return exec("updateSegment", { segId: s.id, patch: { transform: { rotation: ((s.transform?.rotation || 0) + 90) % 360 } } }); },
    crop: () => { const s = needSel(["video", "image", "compound"]); if (s) { select([s.id]); inspector.tab[s.kind] = "video"; inspector.render(); rightPane.querySelector(".sec:nth-of-type(4)")?.scrollIntoView({ behavior: "smooth" }); } },
    trimClip: async () => { const s = needSel(); if (!s) return; if (st.inPoint !== null && st.inPoint > s.start) await exec("trim", { segId: s.id, edge: "start", timeUs: st.inPoint }); const s2 = ed.segment(s.id); if (s2 && st.outPoint !== null && st.outPoint < s2.start + s2.duration) await exec("trim", { segId: s.id, edge: "end", timeUs: st.outPoint }); },
    generateCaptions: () => autoCaptions(app.settings.providers.whisperLanguage),
    isolateNone: () => isolate("none"), keepVocal: () => isolate("keep_vocal"), removeVocal: () => isolate("remove_vocal"),
    openFileLocation: () => { const s = needSel(); const m = s && ed.media(s.mediaId); if (m) call("app.showInFolder", m.path); },
    linkToMedia: () => { const s = needSel(); const m = s && ed.media(s.mediaId); if (m) materials.relink(m); },
    splitScenes: async () => { const { runAction } = await import("./pilot.js"); const r2 = await guard(() => runAction(ed, { type: "splitScenes", args: { scope: st.selection.length ? "selection" : "all" } })); if (r2) toast(r2, "success"); },
    removeSilences: async () => { const { runAction } = await import("./pilot.js"); const tst = toast(t("c.loading"), "info", { ms: 600_000 }); const r2 = await guard(() => runAction(ed, { type: "removeSilences", args: { scope: st.selection.length ? "selection" : "all" } })); tst.remove(); if (r2) toast(r2, "success"); },
    replaceClip: () => replaceClip(),
    exportSelected: () => (st.selection.length ? openExport(ed, { selectedOnly: true }) : toast(t("err.selectionEmpty"), "warning")),
    savePreset: () => savePreset(),
    clearBeats: async () => { if (st.timeline.markers.length && await confirmDialog({ title: "Clear beats", message: `${st.timeline.markers.length} ✕`, danger: true, okLabel: t("c.delete") })) for (const m of [...st.timeline.markers]) await exec("removeMarker", { id: m.id }); },
    voiceover: () => record(ed, "voice"),
    recordScreen: () => record(ed, "screen"),
    // player
    playPause: () => player.toggle(),
    fullscreen: () => { if (document.fullscreenElement) document.exitFullscreen(); else centerPane.requestFullscreen().then(() => setTimeout(() => ed.relayout(), 100)).catch(() => {}); },
    playerZoomIn: () => player.setZoom(player.zoom * 1.25), playerZoomOut: () => player.setZoom(player.zoom / 1.25), playerZoomFit: () => player.setZoom(1),
    toggleRulers: () => { player.guides = !player.guides; player.invalidate(); }, toggleGuides: () => { player.guides = !player.guides; player.invalidate(); },
    // basic
    copy: () => { if (!st.selection.length) return; st.clipboard = st.selection.map((id) => deepClone(ed.segment(id))); st.cut = false; toast(t("ctx.copy"), "info", { ms: 900 }); },
    cut: async () => { if (!st.selection.length) return; st.clipboard = st.selection.map((id) => deepClone(ed.segment(id))); await exec("delete", { ids: st.selection }); },
    paste: () => (st.clipboard?.length ? exec("pasteSegments", { clips: st.clipboard, atUs: player.timeUs }) : null),
    copyAttributes: () => { const s = needSel(); if (s) { st.attrClipboard = copyAttributes(s); toast(t("ctx.copyAttrs"), "info", { ms: 900 }); } },
    pasteAttributes: () => (st.attrClipboard && st.selection.length ? exec("pasteAttributes", { ids: st.selection, attrs: st.attrClipboard }) : null),
    delete: () => (st.selection.length ? exec("delete", { ids: st.selection }) : null),
    undo: async () => { const r2 = await exec("undo"); if (r2) toast(r2.result ? t("c.undoDone", { label: r2.result }) : t("c.nothingToUndo"), "info", { ms: 1000 }); },
    redo: async () => { const r2 = await exec("redo"); if (r2?.result) toast(t("c.redoDone", { label: r2.result }), "info", { ms: 1000 }); },
    importMedia: () => importDialog(),
    exportStill: () => openExport(ed, { still: true }),
    export: () => openExport(ed),
    newProject: async () => { const p = await guard(() => call("project.create", {})); if (p) app.go("editor", { projectId: p.id }); },
    switchMaterialPanel: () => materials.nextTab(),
    backToHome: () => app.go("home", {}),
    quit: () => call("app.quit"),
    exitFullscreen: () => { if (document.fullscreenElement) document.exitFullscreen(); },
    selectAll: () => select(st.timeline.tracks.flatMap((tr) => tr.segments.map((s) => s.id))),
  };
  function easing(e) { const s = needSel(); if (s?.keyframes?.length) return exec("setKeyframeEasing", { segId: s.id, easing: e }); }
  function isolate(v) { const s = needSel(["video", "audio"]); if (s) return exec("updateSegment", { segId: s.id, patch: { audioFx: { isolate: v } } }); }
  function run(id) { const fn = commands[id]; if (fn) return fn(); console.warn("unknown command", id); return null; }

  // ------------------------------------------------------------------ keyboard
  const onKey = (e) => {
    if (anyModalOpen() || document.querySelector(".menu")) return;
    const tag = e.target?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable;
    const chord = chordFromEvent(e);
    if (!chord) return;
    if (typing && !/^(Ctrl\+(S|E|Q|N)|Escape)$/.test(chord)) return;
    const id = lookup(app.shortcuts.bindings, chord) || (chord === "Delete" ? "delete" : null);
    if (!id || !commands[id]) return;
    e.preventDefault();
    Promise.resolve(run(id)).catch((err) => toast(errorText(err), "error"));
  };
  document.addEventListener("keydown", onKey);
  const offShortcuts = app.events.on("shortcuts", (d) => { app.shortcuts = d; });
  const offSettings = app.events.on("settings", () => { timeline.drawToolbar(); player.invalidate(); });

  // ------------------------------------------------------------------ menus
  function mainMenu(anchor) {
    dropdown(anchor, [
      { label: t("ed.file"), items: [
        { label: t("ed.newProject"), kbd: "Ctrl+N", run: () => run("newProject") },
        { label: t("ed.newTimeline"), run: newTimeline },
        { label: t("ed.import"), kbd: "Ctrl+I", run: () => run("importMedia") },
        { label: t("ed.importFolder"), run: importFolder },
        "-",
        { label: t("ed.export"), kbd: "Ctrl+E", run: () => run("export") },
        { label: t("ex.stillFrame"), run: () => run("exportStill") },
        { label: t("proj.share"), run: sharePackage },
        { label: t("proj.saveTemplate"), run: async () => { if (await guard(() => call("template.save", st.project.id, { name: st.project.name }))) toast(t("c.saved"), "success"); } },
        "-",
        { label: t("ed.backHome"), kbd: "Ctrl+Alt+Q", run: () => run("backToHome") },
        { label: t("ed.quit"), kbd: "Ctrl+Q", run: () => run("quit") },
      ] },
      { label: t("ed.edit"), items: [
        { label: t("tl.undo"), kbd: "Ctrl+Z", disabled: !st.history.canUndo, run: () => run("undo") },
        { label: t("tl.redo"), kbd: "Ctrl+Shift+Z", disabled: !st.history.canRedo, run: () => run("redo") },
        "-",
        { label: t("ctx.copy"), kbd: "Ctrl+C", run: () => run("copy") }, { label: t("ctx.cut"), kbd: "Ctrl+X", run: () => run("cut") }, { label: t("ctx.paste"), kbd: "Ctrl+V", run: () => run("paste") },
        { label: t("ctx.delete"), kbd: "Backspace", run: () => run("delete") }, { label: t("c.selectAll"), kbd: "Ctrl+A", run: () => run("selectAll") },
      ] },
      { label: t("ed.settings"), run: () => openSettings() },
      { label: t("ed.shortcuts"), run: () => openShortcuts() },
      { label: t("ed.help"), items: [
        { label: t("ed.walkthrough"), run: walkthrough },
        { label: t("ed.about"), run: openAbout },
      ] },
    ]);
  }
  function layoutMenu(anchor) {
    dropdown(anchor, ["default", "media", "attributes", "vertical"].map((l) => ({ label: l, checked: (app.settings.general.layout || "default") === l, run: async () => {
      await guard(() => call("settings.set", "general", { layout: l })); await refreshSettings();
      shell.className = `editor layout-${l}`; ed.relayout();
    } })));
  }
  async function timelinesMenu(anchor) {
    const p = await guard(() => call("project.get", st.project.id));
    if (!p) return;
    st.project = p;
    dropdown(anchor, [
      ...p.timelines.filter((x) => !x.isCompound).map((x) => ({ label: x.name, checked: x.id === st.timelineId, items: [
        { label: t("proj.open"), run: () => switchTimeline(x.id) },
        { label: t("c.rename"), run: async () => { const n = await promptDialog({ title: t("c.rename"), value: x.name, validate: nameError }); if (n && await guard(() => call("timeline.rename", x.id, n))) { if (x.id === st.timelineId) { st.timeline.name = n; renderAll(); } } } },
        { label: t("c.delete"), danger: true, disabled: x.id === p.mainTimelineId, run: async () => { if (await confirmDialog({ title: t("c.delete"), message: x.name, danger: true, okLabel: t("c.delete") })) { if (x.id === st.timelineId) await switchTimeline(p.mainTimelineId); await guard(() => call("timeline.delete", x.id)); } } },
      ] })),
      "-",
      { label: t("ed.newTimeline"), icon: "plus", run: newTimeline },
    ]);
  }
  async function newTimeline() { const tl = await guard(() => call("timeline.create", st.project.id)); if (tl) await switchTimeline(tl.id); }
  async function switchTimeline(id) {
    const r2 = await guard(() => call("timeline.get", id));
    if (!r2) return;
    player.pause();
    st.timelineId = id; st.timeline = r2.timeline; st.history = r2.history; st.selection = []; st.inPoint = st.outPoint = null;
    player.seek(0); ed.relayout(); renderAll(); timeline.zoomFit();
  }
  async function sharePackage() {
    const file = await call("dialog.saveFile", { title: t("proj.share"), defaultPath: `${st.project.name}.mstudio`, filters: [{ name: "Montaj package", extensions: ["mstudio"] }] });
    if (!file) return;
    const tst = toast(t("c.loading"), "info", { ms: 300_000 });
    const res = await guard(() => call("package.export", st.project.id, file));
    tst.remove();
    if (res) toast(t("c.done"), "success", { action: { label: t("ex.openFolder"), run: () => call("app.showInFolder", file) } });
  }

  function clipMenu(e, seg) {
    const ids = st.selection.length ? st.selection : [seg.id];
    const m = ed.media(seg.mediaId);
    const isVisual = ["video", "image", "compound"].includes(seg.kind);
    const ps = presets().filter((p) => p.kind === seg.kind || (isVisual && ["video", "image", "compound"].includes(p.kind)));
    showMenu([
      { label: t("ctx.copy"), kbd: "Ctrl+C", run: () => run("copy") }, { label: t("ctx.cut"), kbd: "Ctrl+X", run: () => run("cut") },
      { label: t("ctx.paste"), kbd: "Ctrl+V", disabled: !st.clipboard, run: () => run("paste") },
      { label: t("ctx.delete"), kbd: "Backspace", run: () => run("delete") },
      "-",
      { label: t("ctx.copyAttrs"), kbd: "Ctrl+Shift+C", run: () => run("copyAttributes") },
      { label: t("ctx.pasteAttrs"), kbd: "Ctrl+Shift+V", disabled: !st.attrClipboard, run: () => run("pasteAttributes") },
      { label: t("ctx.savePreset"), run: savePreset },
      ps.length ? { label: t("in.presetStyle"), items: ps.map((p) => ({ label: p.name, run: () => exec("pasteAttributes", { ids, attrs: Object.fromEntries(Object.entries(p.attrs).filter(([k]) => ATTRIBUTE_KEYS.includes(k))) }) })) } : null,
      "-",
      seg.kind === "video" || seg.kind === "compound" ? { label: seg.audioDetached ? t("ctx.restoreAudio") : t("ctx.extractAudio"), run: () => exec("extractAudio", { segId: seg.id }) } : null,
      ["video", "audio"].includes(seg.kind) ? { label: t("ctx.isolate"), items: [{ label: t("ctx.dontIsolate"), checked: (seg.audioFx?.isolate || "none") === "none", run: () => isolate("none") }, { label: t("ctx.removeVocal"), checked: seg.audioFx?.isolate === "remove_vocal", run: () => isolate("remove_vocal") }, { label: t("ctx.keepVocal"), checked: seg.audioFx?.isolate === "keep_vocal", run: () => isolate("keep_vocal") }] } : null,
      ["video", "audio"].includes(seg.kind) ? { label: t("lib.autoCaptions"), run: () => autoCaptions(app.settings.providers.whisperLanguage) } : null,
      ids.length > 1 ? { label: t("ctx.group"), kbd: "Ctrl+G", run: () => run("group") } : null,
      seg.groupId ? { label: t("ctx.ungroup"), kbd: "Ctrl+Shift+G", run: () => run("ungroup") } : null,
      { label: t("ctx.compound"), kbd: "Alt+G", run: () => run("createCompound") },
      seg.kind === "compound" ? { label: t("ctx.uncompound"), kbd: "Alt+Shift+G", run: () => exec("undoCompound", { segId: seg.id }) } : null,
      seg.kind === "compound" ? { label: t("in.preprocess"), run: () => preprocessCompound(seg.compoundTimelineId) } : null,
      { label: t("ctx.exportSelected"), run: () => run("exportSelected") },
      { label: seg.disabled ? t("ctx.activate") : t("ctx.deactivate"), run: () => exec("setDisabled", { ids, value: !seg.disabled }) },
      "-",
      isVisual || seg.kind === "audio" ? { label: t("ctx.replace"), run: replaceClip } : null,
      seg.kind === "video" ? { label: t("tl.splitScenes"), run: () => run("splitScenes") } : null,
      m ? { label: t("ctx.openLocation"), run: () => call("app.showInFolder", m.path) } : null,
      m?.status === "missing" ? { label: t("ed.linkMedia"), run: () => materials.relink(m) } : null,
      { label: t("ctx.render"), items: [{ label: t("ctx.wholeTimeline"), run: () => run("export") }, { label: t("ctx.inOut"), disabled: st.inPoint === null && st.outPoint === null, run: () => run("export") }, { label: t("ctx.deleteCache"), run: async () => { if (await guard(() => call("settings.clearCache", "render")) !== undefined) toast(t("set.cacheCleared"), "success"); } }] },
      { label: t("ctx.editPilot"), run: () => openPilot(ed) },
    ], e.clientX, e.clientY);
  }
  function emptyMenu(e, atUs) {
    showMenu([
      { label: t("ctx.paste"), kbd: "Ctrl+V", disabled: !st.clipboard, run: () => exec("pasteSegments", { clips: st.clipboard, atUs }) },
      { label: t("tl.marker"), run: () => exec("addMarker", { timeUs: atUs, color: MARKER_COLORS[st.markerColor] }) },
      "-",
      { label: t("ctx.range"), items: [
        { label: "In", kbd: "I", run: () => { seek(atUs); run("inPoint"); } }, { label: "Out", kbd: "O", run: () => { seek(atUs); run("outPoint"); } },
        { label: t("ctx.deselectRange"), disabled: st.inPoint === null && st.outPoint === null, run: () => run("clearInOut") },
        { label: t("ctx.selectByClip"), kbd: "Shift+X", run: () => run("selectByClip") },
      ] },
      { label: t("c.selectAll"), kbd: "Ctrl+A", run: () => run("selectAll") },
    ], e.clientX, e.clientY);
  }
  function markerMenu(m, e) {
    showMenu([
      { label: "Note…", run: async () => { const n = await promptDialog({ title: t("tl.marker"), value: m.note, validate: () => null, maxLength: 500 }); if (n !== null) exec("updateMarker", { id: m.id, note: n }); } },
      { label: t("in.color"), items: MARKER_COLORS.map((c) => ({ label: c, checked: c === m.color, run: () => exec("updateMarker", { id: m.id, color: c }) })) },
      { label: t("c.delete"), danger: true, run: () => exec("removeMarker", { id: m.id }) },
    ], e.clientX, e.clientY);
  }

  function coverMenu(e) {
    showMenu([
      { label: t("tl.editCover"), icon: "image", run: async () => { const p = await guard(() => call("project.setCover", st.project.id, { atUs: Math.round(player.timeUs) })); if (p) { st.project = p; toast(t("c.saved"), "success"); } } },
      { label: t("tl.resetCover"), icon: "sync", run: async () => { const p = await guard(() => call("project.setCover", st.project.id, { reset: true })); if (p) st.project = p; } },
    ], e.clientX, e.clientY);
  }

  // Low memory / disk warnings (FEAT-142).
  call("app.resources").then((r) => {
    if (r.freeMem < 512 * 1024 * 1024) toast(t("low.memory"), "warning", { ms: 8000 });
    const disk = Math.min(r.freeDiskMedia ?? Infinity, r.freeDiskExport ?? Infinity);
    if (disk < 2 * 1024 ** 3) toast(t("low.disk", { free: `${(disk / 1024 ** 3).toFixed(1)} GB` }), "warning", { ms: 8000 });
  }).catch(() => {});

  function walkthrough() {
    let i = 1;
    const txt = h("p", { style: { lineHeight: 1.7 } }, t("walk.1"));
    const next = h("button", { class: "btn primary" }, t("walk.next"));
    // Finishing or skipping both count as onboarded (shown once per installation).
    const markOnboarded = () => { app.settings.general.onboarded = true; call("settings.set", "general", { onboarded: true }).catch(() => {}); };
    const wm = modal({ title: t("ed.walkthrough"), width: 420, body: txt, footer: [h("button", { class: "btn", onclick: () => wm.close() }, t("walk.skip")), next], onClose: markOnboarded });
    next.onclick = () => { i++; if (i > 4) { wm.close(); return; } txt.textContent = t(`walk.${i}`); if (i === 4) next.textContent = t("c.done"); };
  }
  if (!app.settings.general.onboarded) setTimeout(walkthrough, 600);
  if (params.pilot) setTimeout(() => openPilot(ed, params.pilot), 400);

  // Title bar: back to home
  titlebarActions()?.append(h("button", { class: "btn ghost small", onclick: () => app.go("home", {}) }, icon("home"), t("nav.home")));

  // ------------------------------------------------------------------ teardown (leaving the editor)
  return async () => {
    player.pause();
    document.removeEventListener("keydown", onKey);
    offMedia(); offMatte(); offShortcuts(); offSettings(); offAgentEdit();
    player.destroy(); timeline.destroy();
    const editSeconds = Math.round((Date.now() - st.openedAt) / 1000);
    await call("project.finalize", st.project.id, { editSeconds }).catch(() => {});
    setTitle("");
    return true;
  };
}

export { fmtDateTime };
