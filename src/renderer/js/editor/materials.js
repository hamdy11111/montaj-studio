// Materials panel (SCREEN-018..028): Media, Audio, Text, Stickers, Effects, Transitions, Captions, Filters,
// Adjustment, Templates and AI avatar. Items are added at the playhead by click or dragged onto the timeline.
import { h, mount, clear, debounce } from "../dom.js";
import { icon } from "../icons.js";
import { t, getLang, errorText, has } from "../i18n.js";
import { call, guard, thumbUrl, stickerUrl, libUrl, coverUrl } from "../api.js";
import { toast } from "../ui/toast.js";
import { showMenu, dropdown } from "../ui/menu.js";
import { confirmDialog } from "../ui/modal.js";
import { formatDuration, US } from "../../core/util.js";
import { FILTER_PRESETS, FILTER_CATEGORIES, EFFECTS, EFFECT_CATEGORIES, TEXT_PRESETS, BUILTIN_STICKERS, TRANSITION_CATEGORIES } from "../../core/presets.js";
import { DEFAULT_TEXT } from "../../core/model.js";
import { openProviderOnly } from "../dialogs/tools.js";
import { CAPTION_TEMPLATES } from "../../core/captionTemplates.js";
import { captionCanvas } from "./captionRaster.js";
import { GRAPHIC_TEMPLATES } from "../../core/graphics.js";
import { graphicCanvas, preloadGraphic } from "./graphicsRaster.js";
import { ensureFonts } from "../fonts.js";
import { canGoBehind } from "../../core/cutout.js";

/** Preview of a motion-graphics template (its defaults, mid-animation) over a dark frame; cached per template. */
const gfxPreviews = new Map();
function graphicPreview(id) {
  if (!gfxPreviews.has(id)) {
    gfxPreviews.set(id, (async () => {
      const tpl = GRAPHIC_TEMPLATES[id], g = { template: id, params: {} };
      await ensureFonts([tpl.params.font?.default || "Cairo"]);
      await preloadGraphic(g);
      const W = 320, H = 180, c = document.createElement("canvas");
      c.width = W; c.height = H; c.className = "gfx-preview";
      const x = c.getContext("2d"), bg = x.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#2b3240"); bg.addColorStop(1, "#151821");
      x.fillStyle = bg; x.fillRect(0, 0, W, H);
      x.drawImage(graphicCanvas(g, W, H, Math.min(tpl.durUs * 0.55, 2_200_000), tpl.durUs), 0, 0);
      return c;
    })());
  }
  return gfxPreviews.get(id);
}

/** Small static preview of a caption template (second word spoken). */
function templatePreview(id) {
  const words = (getLang() === "ar" ? "أهم حاجة في الفيديو" : "this changes everything").split(" ");
  const text = { content: words.join(" "), caption: { template: id, words: words.map((w, i) => ({ t: w, s: i * 300_000, e: (i + 1) * 300_000 })), emphasis: [2] } };
  const c = captionCanvas(text, 300, 560, { active: 1, pop: 1, wordPop: 1 });
  c.className = "cap-preview";
  return c;
}

export const TABS = [
  ["media", "media"], ["audio", "audio"], ["text", "text"], ["graphics", "sparkle"], ["stickers", "sticker"], ["effects", "effect"], ["transitions", "transition"],
  ["captions", "captions"], ["filters", "filter"], ["adjustment", "adjust"], ["templates", "template"], ["avatar", "avatar"],
];

export class Materials {
  constructor(host, ed) {
    this.ed = ed;
    this.tab = "media";
    this.mediaFilter = "all";
    this.mediaSearch = "";
    this.tabsEl = h("div", { class: "mat-tabs", role: "tablist" });
    this.body = h("div", { class: "mat-body" });
    this.el = h("div", { class: "materials" }, this.tabsEl, this.body);
    host.append(this.el);
    this.drawTabs();
    this.draw();
  }

  setTab(tab) { this.tab = tab; this.drawTabs(); this.draw(); }
  nextTab() { const i = TABS.findIndex(([id]) => id === this.tab); this.setTab(TABS[(i + 1) % TABS.length][0]); }

  drawTabs() {
    mount(this.tabsEl, ...TABS.map(([id, ic]) => h("button", { class: ["mat-tab", this.tab === id && "active"], role: "tab", "aria-selected": this.tab === id ? "true" : "false", title: t(`tab.${id}`), onclick: () => this.setTab(id) }, icon(ic), h("span", {}, t(`tab.${id}`)))));
  }

  refresh() { if (this.tab === "media" || this.tab === "captions") this.draw(); }

  draw() {
    const fn = { media: this.mediaTab, audio: this.audioTab, text: this.textTab, graphics: this.graphicsTab, stickers: this.stickerTab, effects: this.effectsTab, transitions: this.transitionsTab, captions: this.captionsTab, filters: this.filtersTab, adjustment: this.adjustTab, templates: this.templatesTab, avatar: this.avatarTab }[this.tab];
    clear(this.body);
    fn.call(this);
  }

  // ------------------------------------------------------------------ media
  mediaTab() {
    const ed = this.ed;
    const used = new Set(); for (const tr of ed.tl().tracks) for (const s of tr.segments) if (s.mediaId) used.add(s.mediaId);
    const importBtn = h("div", { class: "split-btn" },
      h("button", { class: "btn primary", onclick: () => ed.importDialog() }, icon("upload"), t("c.import")),
      h("button", { class: "btn primary", "aria-label": t("ed.more"), onclick: (e) => dropdown(e.currentTarget, [
        { label: t("ed.fromDevice"), icon: "upload", run: () => ed.importDialog() },
        { label: t("ed.importFolder"), icon: "folder", run: () => ed.importFolder() },
        "-",
        { label: t("ed.recordScreen"), icon: "record", run: () => ed.run("recordScreen") },
        { label: t("ed.recordVoice"), icon: "mic", run: () => ed.run("voiceover") },
      ]) }, icon("chevronDown")));
    const search = h("input", { type: "search", placeholder: t("ed.searchMedia"), value: this.mediaSearch, oninput: debounce((e) => { this.mediaSearch = e.target.value.trim().toLowerCase(); drawGrid(); }, 150) });
    const chips = h("div", { class: "chips" }, ["all", "video", "image", "audio", "favorite"].map((f) => h("button", { class: ["chip", this.mediaFilter === f && "active"], onclick: () => { this.mediaFilter = f; this.draw(); } }, f === "all" ? t("c.all") : f === "favorite" ? t("lib.favorites") : f)));
    const grid = h("div", { class: "media-grid" });
    const drawGrid = () => {
      const items = ed.mediaList().filter((m) => (this.mediaFilter === "all" || (this.mediaFilter === "favorite" ? m.favorite : m.type === this.mediaFilter)) && (!this.mediaSearch || m.name.toLowerCase().includes(this.mediaSearch)));
      clear(grid);
      if (!ed.mediaList().length) {
        grid.append(h("div", { class: "drop-hint" }, icon("upload"), h("div", {}, t("ed.importHint")), h("button", { class: "btn primary", onclick: () => ed.importDialog() }, t("c.import"))));
        return;
      }
      if (!items.length) { grid.append(h("div", { class: "empty" }, icon("search"), t("home.noResults"))); return; }
      for (const m of items) grid.append(this.mediaCard(m, used.has(m.id)));
    };
    drawGrid();
    // Generated videos («الفيديوهات المولّدة»): drag onto the timeline or add at the playhead; the studio opens with this project.
    const gen = h("div", { class: "vg-strip" });
    call("video.library", {}).then((items) => {
      if (!items?.length) return;
      mount(gen, h("div", { class: "row", style: { gap: "6px" } }, h("b", { class: "small" }, t("vg.s6")), h("span", { class: "muted small" }, String(items.length))),
        h("div", { class: "media-grid" }, items.slice(0, 12).map((x) => h("div", { class: "media-card", draggable: x.exists, title: x.name,
          ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "libVideo", id: x.id })) },
        h("div", { class: "media-thumb" }, h("img", { src: `media://vidthumb/${encodeURIComponent(x.id)}`, alt: "" }), h("span", { class: "media-dur" }, formatDuration(x.durationUs)),
          h("button", { class: "icon-btn media-add", "aria-label": t("vg.addToTimeline"), title: t("vg.addToTimeline"), onclick: (e) => { e.stopPropagation(); ed.dropItem({ type: "libVideo", id: x.id }, ed.playhead()); } }, icon("plus"))),
        h("div", { class: "media-name nowrap" }, x.name)))));
    }).catch(() => {});
    const studioBtn = h("button", { class: "btn", title: t("vg.openStudioHint"), onclick: () => ed.openVideoStudio() }, icon("sparkle"), t("nav.video"));
    this.body.append(h("div", { class: "mat-head" }, importBtn, studioBtn, h("div", { class: "search grow" }, icon("search"), search)), chips, grid, gen);
    // Drop files from Explorer onto the panel to import them.
    this.body.ondragover = (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); this.body.classList.add("drop"); } };
    this.body.ondragleave = () => this.body.classList.remove("drop");
    this.body.ondrop = (e) => { e.preventDefault(); this.body.classList.remove("drop"); if (e.dataTransfer.files.length) ed.importDropped([...e.dataTransfer.files], { addToTimeline: false }); };
  }

  mediaCard(m, isUsed) {
    const ed = this.ed;
    const card = h("div", { class: ["media-card", m.status === "missing" && "missing"], draggable: m.status !== "missing", title: m.name, tabindex: 0,
      ondragstart: (e) => { e.dataTransfer.setData("text/x-montaj-media", m.id); e.dataTransfer.effectAllowed = "copy"; },
      ondblclick: () => ed.previewMedia?.(m),
      oncontextmenu: (e) => { e.preventDefault(); this.mediaMenu(m, e, isUsed); } },
    h("div", { class: "media-thumb" },
      m.thumbPath ? h("img", { src: thumbUrl(m.id, m.thumbCount), alt: "", style: m.thumbCount > 1 ? { objectPosition: "0 0", objectFit: "cover", width: `${m.thumbCount * 100}%`, maxWidth: "none" } : {} }) : icon(m.type === "audio" ? "audio" : m.type === "image" ? "image" : "video"),
      m.type !== "image" ? h("span", { class: "media-dur" }, formatDuration(m.durationUs)) : null,
      isUsed ? h("span", { class: "media-added" }, t("ed.added")) : null,
      m.status === "missing" ? h("button", { class: "btn small danger media-relink", onclick: (e) => { e.stopPropagation(); this.relink(m); } }, t("ed.linkMedia")) : null,
      m.status !== "missing" ? h("button", { class: "icon-btn media-add", "aria-label": t("c.import"), title: t("c.import"), onclick: (e) => { e.stopPropagation(); ed.exec("addMedia", { mediaId: m.id, toMain: m.type !== "audio", atUs: ed.playhead() }); } }, icon("plus")) : null),
    h("div", { class: "media-name nowrap" }, m.favorite ? icon("starFill", "fav") : null, m.name));
    return card;
  }

  mediaMenu(m, e, isUsed) {
    const ed = this.ed;
    showMenu([
      { label: t("c.import"), icon: "plus", disabled: m.status === "missing", run: () => ed.exec("addMedia", { mediaId: m.id, toMain: m.type !== "audio", atUs: ed.playhead() }) },
      { label: t("c.favorite"), checked: !!m.favorite, run: async () => { await guard(() => call("media.setFavorite", m.id, !m.favorite)); ed.refreshMedia(); } },
      { label: t("ed.linkMedia"), icon: "link", run: () => this.relink(m) },
      { label: t("ctx.openLocation"), icon: "folder", run: () => call("app.showInFolder", m.path) },
      { label: t("ctx.replace"), icon: "sync", disabled: ed.selection().length !== 1 || m.status === "missing", run: () => ed.exec("replaceClip", { segId: ed.selection()[0], mediaId: m.id }) },
      "-",
      { label: t("c.remove"), icon: "trash", danger: true, run: async () => {
        if (isUsed) { toast(t("err.mediaInUse"), "warning"); return; }
        if (await confirmDialog({ title: t("c.remove"), message: m.name, danger: true, okLabel: t("c.remove") })) { await guard(() => call("media.detach", ed.project().id, m.id)); ed.refreshMedia(); }
      } },
    ], e.clientX, e.clientY);
  }

  async relink(m) {
    const [file] = await call("dialog.openFiles", { kind: m.type === "audio" ? "audio" : "media" });
    if (!file) return;
    if (await guard(() => call("media.relink", m.id, file))) { toast(t("c.done"), "success"); this.ed.refreshMedia(); }
  }

  // ------------------------------------------------------------------ audio
  async audioTab() {
    const ed = this.ed;
    const list = h("div", { class: "list" });
    this.body.append(h("div", { class: "mat-head" }, h("button", { class: "btn primary", onclick: async () => { const files = await call("dialog.openFiles", { kind: "audio", multi: true }); if (files.length && await guard(() => call("library.importFiles", "audio", files, "yours"))) this.draw(); } }, icon("upload"), t("lib.importAudio")),
      h("button", { class: "btn", onclick: () => ed.run("voiceover") }, icon("mic"), t("ed.recordVoice")),
      // Music for this video: the music studio opens with the length of the In/Out range (or the whole timeline) and
      // this project as the place to add the result.
      h("button", { class: "btn", title: t("mu.forVideoHint"), onclick: async () => {
        const io = ed.inOut(), start = io.in ?? 0, end = io.out ?? ed.duration();
        const { app } = await import("../state.js");
        app.go("home", { view: "music", musicSeconds: Math.max(4, Math.min(180, Math.round((end - start) / US))), musicProject: ed.project().id, musicRange: io.in !== null || io.out !== null });
      } }, icon("audio"), t("nav.music"))), h("p", { class: "muted small" }, t("lib.audioEmpty")), list);
    const items = (await guard(() => call("library.list", { kind: "audio" }))) || [];
    const projectAudio = ed.mediaList().filter((m) => m.type === "audio");
    if (!items.length && !projectAudio.length) { list.append(h("div", { class: "empty" }, icon("audio"), t("lib.audioEmpty"))); return; }
    // Generated music (music studio) first, under its own heading; then the user's own sounds.
    const music = items.filter((it) => it.category === "music");
    const own = items.filter((it) => it.category !== "music");
    if (music.length) list.append(h("div", { class: "muted small", style: { margin: "4px 0" } }, t("mu.generatedMusic")));
    for (const it of [...music, ...own]) {
      if (it === own[0] && music.length) list.append(h("div", { class: "muted small", style: { margin: "8px 0 4px" } }, t("lib.yours")));
      const preview = h("button", { class: "icon-btn", "aria-label": t("ex.play"), onclick: () => this.previewAudio(libUrl(it.id), preview) }, icon("play"));
      list.append(h("div", { class: "list-row", draggable: true, ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "libAudio", id: it.id })) },
        preview, h("span", { class: "grow nowrap" }, it.name), h("span", { class: "muted" }, formatDuration(it.durationUs)),
        h("button", { class: "icon-btn", "aria-label": t("c.import"), onclick: () => ed.dropItem({ type: "libAudio", id: it.id }, ed.playhead()) }, icon("plus"))));
    }
    for (const m of projectAudio) list.append(h("div", { class: "list-row", draggable: true, ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-media", m.id) },
      icon(m.origin === "tts" ? "mic" : "audio"), h("span", { class: "grow nowrap" }, m.name), h("span", { class: "muted" }, formatDuration(m.durationUs)),
      h("button", { class: "icon-btn", "aria-label": t("c.import"), onclick: () => ed.exec("addMedia", { mediaId: m.id, toMain: false, atUs: ed.playhead() }) }, icon("plus"))));
  }
  previewAudio(src, btn) {
    if (this.audioEl && !this.audioEl.paused) { this.audioEl.pause(); this.audioBtn?.replaceChildren(icon("play")); if (this.audioEl.dataset.src === src) return; }
    this.audioEl = new Audio(src); this.audioEl.dataset.src = src; this.audioBtn = btn;
    this.audioEl.play().catch(() => {}); btn.replaceChildren(icon("pause"));
    this.audioEl.onended = () => btn.replaceChildren(icon("play"));
  }

  // ------------------------------------------------------------------ text
  textTab() {
    const ed = this.ed;
    const add = (preset) => ed.dropItem({ type: "text", preset }, ed.playhead());
    this.body.append(h("button", { class: "btn primary block", onclick: () => add("none") }, icon("plus"), t("lib.addText")),
      h("h4", {}, t("lib.textEffects")),
      h("div", { class: "tiles" }, Object.keys(TEXT_PRESETS).map((p) => {
        const st = { ...DEFAULT_TEXT, ...TEXT_PRESETS[p] };
        return h("button", { class: "tile", title: p, draggable: true, ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "text", preset: p })), onclick: () => add(p) },
          h("div", { class: "tile-art text-art", style: { color: st.color, background: st.bgOpacity ? hexA(st.bgColor, st.bgOpacity / 100) : "#1b1b1b", WebkitTextStroke: st.strokeWidth ? `1px ${st.strokeColor}` : "", fontWeight: st.bold ? 700 : 400 } }, "Aa"),
          h("div", { class: "tile-label nowrap" }, p === "none" ? t("lib.defaultText") : p.replace(/_/g, " ")));
      })));
  }

  // ------------------------------------------------------------------ motion graphics
  async graphicsTab() {
    const ed = this.ed;
    const tiles = h("div", { class: "tiles gfx-tiles" });
    for (const [id, tpl] of Object.entries(GRAPHIC_TEMPLATES)) {
      const art = h("div", { class: "tile-art gfx-art" });
      tiles.append(h("button", { class: "tile gfx-tile", title: tpl.use, onclick: () => this.addGraphic(id) }, art, h("div", { class: "tile-label nowrap" }, getLang() === "ar" ? tpl.ar : tpl.name)));
      graphicPreview(id).then((c) => art.append(copyCanvas(c))).catch(() => {});
    }
    const sel = ed.selectedSegment();
    const track = sel ? ed.trackOf(sel.id) : null;
    const canBehind = sel && !track?.isMain && canGoBehind(sel);
    const isBehind = track?.role === "behind";
    const status = await guard(() => call("mattes.status"));
    this.body.append(
      h("p", { class: "muted small" }, t("lib.graphicsHint")),
      tiles,
      h("div", { class: "card pad col" },
        h("strong", {}, t("lib.behindPerson"), " ", h("span", { class: "badge local" }, t("c.local"))),
        h("p", { class: "muted small" }, t("lib.behindHint")),
        status?.available ? null : h("p", { class: "muted small" }, t("err.matteUnavailable")),
        h("button", { class: "btn", disabled: !canBehind || !status?.available, onclick: async () => { await ed.behindPerson([sel.id], !isBehind); this.draw(); } },
          icon("layers"), isBehind ? t("lib.frontOfPerson") : t("lib.putBehind"))));
  }

  /** Add a template at the playhead (its default length); a "behind" title goes behind the person at once. */
  async addGraphic(id) {
    const ed = this.ed, tpl = GRAPHIC_TEMPLATES[id];
    const def = Object.fromEntries(Object.entries(tpl.params).map(([k, s]) => [k, s.default]));
    const label = String(def.text || def.title || def.label || def.emoji || tpl.name).slice(0, 40);
    if (tpl.subject || tpl.behind) {
      // Follows the person / plays behind them: the app finds the head first (the first time per video: a while).
      const { subject, ...params } = def;
      const tst = toast(t("lib.matteWorking", { p: "…" }), "info", { ms: 30 * 60_000 });
      try {
        const r = await call("graphics.add", ed.timelineId(), { template: id, params, atUs: ed.playhead() });
        await ed.reloadTimeline();
        if (r?.clipId) ed.select([r.clipId]);
      } catch (err) { toast(errorText(err), "error", { ms: 8000 }); } finally { tst.remove(); }
      return;
    }
    const res = await ed.exec("addSegment", { kind: "text", atUs: ed.playhead(), durationUs: tpl.durUs,
      init: { name: `${getLang() === "ar" ? tpl.ar : tpl.name}: ${label}`, text: { ...DEFAULT_TEXT, content: label, graphic: { template: id, params: def } } } });
    if (res && id === "behind-title") await ed.behindPerson([res.result], true);
  }

  // ------------------------------------------------------------------ stickers
  async stickerTab() {
    const ed = this.ed;
    const grid = h("div", { class: "tiles" });
    this.body.append(h("div", { class: "mat-head" }, h("button", { class: "btn", onclick: async () => { const files = await call("dialog.openFiles", { kind: "image", multi: true }); if (files.length && await guard(() => call("library.importFiles", "sticker", files, "yours"))) this.draw(); } }, icon("upload"), t("lib.importSticker"))), grid);
    const tile = (item, src, label) => h("button", { class: "tile", title: label, draggable: true, ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify(item)), onclick: () => ed.dropItem(item, ed.playhead()) },
      h("div", { class: "tile-art" }, h("img", { src, alt: label, draggable: false })), h("div", { class: "tile-label nowrap" }, label));
    for (const s of BUILTIN_STICKERS) grid.append(tile({ type: "sticker", builtin: s.id }, stickerUrl(s.id), s.id.replace(/_/g, " ")));
    const mine = (await guard(() => call("library.list", { kind: "sticker" }))) || [];
    for (const s of mine) grid.append(tile({ type: "sticker", assetId: s.id }, libUrl(s.id), s.name));
  }

  // ------------------------------------------------------------------ effects
  effectsTab() {
    const ed = this.ed;
    const sel = ed.selectedSegment();
    const toClip = sel && ["video", "image", "compound"].includes(sel.kind);
    this.body.append(h("p", { class: "muted small" }, toClip ? `${t("in.effect")} → ${sel.name || sel.kind}` : t("tab.effects")));
    for (const cat of EFFECT_CATEGORIES) {
      const items = Object.entries(EFFECTS).filter(([, v]) => v.cat === cat);
      if (!items.length) continue;
      this.body.append(h("h4", {}, cat), h("div", { class: "tiles" }, items.map(([id]) => h("button", { class: "tile", title: id, draggable: true,
        ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "effect", effect: id })),
        onclick: () => {
          if (toClip) ed.exec("updateSegment", { segId: sel.id, patch: { clipEffects: [...(sel.clipEffects || []).filter((x) => x.type !== id), { type: id, intensity: 50, velocity: false }] } });
          else ed.dropItem({ type: "effect", effect: id }, ed.playhead());
        } }, h("div", { class: `tile-art fx-${id}` }, icon("effect")), h("div", { class: "tile-label nowrap" }, id.replace(/_/g, " "))))));
    }
  }

  // ------------------------------------------------------------------ transitions
  transitionsTab() {
    const ed = this.ed;
    const target = () => {
      const s = ed.selectedSegment();
      const main = ed.tl().tracks.find((x) => x.isMain);
      if (s && main.segments.some((x) => x.id === s.id) && main.segments[main.segments.length - 1].id !== s.id) return s;
      // nearest boundary to the playhead
      const ph = ed.playhead();
      let best = null, d = Infinity;
      for (const x of main.segments.slice(0, -1)) { const dd = Math.abs(x.start + x.duration - ph); if (dd < d) { d = dd; best = x; } }
      return best;
    };
    const cur = target();
    this.body.append(h("p", { class: "muted small" }, t("in.transitionHint")));
    for (const [cat, ids] of Object.entries(TRANSITION_CATEGORIES)) {
      this.body.append(h("h4", {}, cat), h("div", { class: "tiles" }, ids.map((id) => h("button", { class: ["tile", cur?.transitionOut?.type === id && "active"], title: id, onclick: () => {
        const tg = target();
        if (!tg) { toast(t("err.transitionMainOnly"), "warning"); return; }
        ed.exec("setTransition", { segId: tg.id, type: id, durationUs: tg.transitionOut?.durationUs || 500_000 }).then(() => this.draw());
      } }, h("div", { class: "tile-art" }, icon("transition")), h("div", { class: "tile-label nowrap" }, id.replace(/_/g, " "))))));
    }
    this.body.append(h("div", { class: "row", style: { marginTop: "10px" } },
      h("button", { class: "btn", disabled: !cur || cur.transitionOut?.type === "none", onclick: () => ed.exec("applyTransitionToAll", { type: cur.transitionOut.type, durationUs: cur.transitionOut.durationUs }) }, t("in.applyAllTransitions")),
      h("button", { class: "btn ghost", disabled: !cur || cur.transitionOut?.type === "none", onclick: () => ed.exec("setTransition", { segId: cur.id, type: "none" }).then(() => this.draw()) }, t("c.remove"))));
  }

  // ------------------------------------------------------------------ captions
  async captionsTab() {
    const ed = this.ed;
    const status = await guard(() => call("captions.status"));
    const lang = h("select", {}, [["auto", "Auto"], ["ar", "العربية"], ["en", "English"], ["fr", "Français"], ["tr", "Türkçe"], ["es", "Español"], ["de", "Deutsch"]].map(([v, l]) => h("option", { value: v, selected: v === ed.settings().providers.whisperLanguage }, l)));
    const hasCaptions = ed.tl().tracks.some((x) => x.segments.some((s) => s.kind === "text" && s.text?.isCaption));
    const hasAnimated = ed.tl().tracks.some((x) => x.segments.some((s) => s.kind === "text" && s.text?.caption));
    let chosen = ed.tl().tracks.flatMap((x) => x.segments).find((s) => s.text?.caption)?.text.caption.template || "karaoke-yellow";
    const tiles = h("div", { class: "tiles cap-tiles" });
    const drawTiles = () => mount(tiles, ...Object.entries(CAPTION_TEMPLATES).map(([id, tp]) => h("button", { class: ["tile", "cap-tile", chosen === id && "active"], title: tp.use, onclick: () => { chosen = id; drawTiles(); } },
      h("div", { class: "tile-art cap-art" }, templatePreview(id)), h("div", { class: "tile-label nowrap" }, has(`cap.${id}`) ? t(`cap.${id}`) : tp.name))));
    drawTiles();
    const keywords = h("input", { type: "text", maxlength: 300, placeholder: t("lib.keywordsPh") });
    // Recognition fixes, one per line: «wrong = right» (dialect words, names).
    const fixes = h("textarea", { rows: 2, maxlength: 4000, dir: "auto", placeholder: t("lib.correctionsPh"), style: { width: "100%" } });
    const corrections = () => fixes.value.split(/\r?\n/).map((l) => l.split("=")).filter((p) => p.length === 2 && p[0].trim()).map(([from, to]) => ({ from: from.trim(), to: to.trim() }));
    const firstCap = ed.tl().tracks.flatMap((x) => x.segments).find((s) => s.text?.caption);
    let reveal = firstCap ? !!firstCap.text.caption.reveal : true;
    const revealBox = h("label", { class: "check" }, h("input", { type: "checkbox", checked: reveal, onchange: (e) => { reveal = e.target.checked; } }), t("lib.revealSpoken"));
    const generate = async () => {
      const tst = toast(t("lib.captionsWorking"), "info", { ms: 30 * 60_000 });
      try {
        const r = await call("captions.generatePro", ed.timelineId(), { template: chosen, language: lang.value, keywords: keywords.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean), reveal, corrections: corrections() });
        await ed.reloadTimeline();
        toast(t("lib.captionsDone", { pages: r.pages, words: r.words }), "success");
        if (r.qc?.issues?.length) toast(t("lib.captionsFast", { n: r.qc.issues.length, cps: r.qc.maxCps }), "warning", { ms: 6000 });
        this.draw();
      } catch (err) { toast(errorText(err), "error"); } finally { tst.remove(); }
    };
    const restyle = async () => { if (await guard(() => call("captions.restyle", ed.timelineId(), { template: chosen, reveal }))) { await ed.reloadTimeline(); this.draw(); } };
    this.body.append(
      h("div", { class: "card pad col" },
        h("strong", {}, t("lib.animatedCaptions"), " ", h("span", { class: "badge local" }, t("c.local"))),
        h("p", { class: "muted small" }, t("lib.animatedHint")),
        tiles,
        h("div", { class: "row" }, h("span", { class: "muted" }, t("lib.spokenLanguage")), lang),
        keywords,
        fixes,
        revealBox,
        h("div", { class: "row wrap" },
          h("button", { class: "btn primary", disabled: !status?.words, onclick: generate }, icon("captions"), hasAnimated ? t("lib.regenerate") : t("lib.generate")),
          hasAnimated ? h("button", { class: "btn", onclick: restyle }, t("lib.applyStyle")) : null),
        status?.words ? null : h("button", { class: "btn small", onclick: () => ed.openSettings("providers") }, t("set.providers"))),
      h("div", { class: "card pad col" },
        h("strong", {}, t("lib.autoCaptions"), " ", h("span", { class: "badge local" }, t("c.local"))),
        status?.autoCaptions ? null : h("p", { class: "muted small" }, t("lib.whisperMissing")),
        h("button", { class: "btn", disabled: !status?.autoCaptions, onclick: () => ed.autoCaptions(lang.value) }, icon("captions"), t("lib.generatePlain")),
        status?.autoCaptions ? null : h("button", { class: "btn small", onclick: () => ed.openSettings("providers") }, t("set.providers"))),
      h("div", { class: "card pad col" },
        h("strong", {}, t("lib.localCaptions")),
        h("button", { class: "btn", onclick: () => ed.importCaptions() }, icon("upload"), t("lib.addCaptions"), " (SRT / VTT)")),
      hasCaptions ? h("button", { class: "btn danger", onclick: async () => { if (await confirmDialog({ title: t("lib.deleteCurrentCaptions"), message: t("lib.deleteCurrentCaptions") + "?", danger: true, okLabel: t("c.delete") })) ed.deleteCaptions(); } }, icon("trash"), t("lib.deleteCurrentCaptions")) : null);
  }

  // ------------------------------------------------------------------ filters
  filtersTab() {
    const ed = this.ed;
    const sel = ed.selectedSegment();
    const toClip = sel && ["video", "image", "compound"].includes(sel.kind);
    this.body.append(h("p", { class: "muted small" }, toClip ? `${t("in.filter")} → ${sel.name || sel.kind}` : t("tab.filters")));
    for (const cat of FILTER_CATEGORIES) {
      const items = Object.entries(FILTER_PRESETS).filter(([, v]) => v.cat === cat);
      if (!items.length) continue;
      this.body.append(h("h4", {}, cat), h("div", { class: "tiles" }, items.map(([id, p]) => h("button", { class: "tile", title: id, draggable: true,
        ondragstart: (e) => e.dataTransfer.setData("text/x-montaj-item", JSON.stringify({ type: "filter", preset: id })),
        onclick: () => (toClip ? ed.applyFilterToClip(sel, id) : ed.dropItem({ type: "filter", preset: id }, ed.playhead())) },
      h("div", { class: "tile-art", style: { background: filterSwatch(p.adjust) } }), h("div", { class: "tile-label nowrap" }, id)))));
    }
  }

  // ------------------------------------------------------------------ adjustment
  async adjustTab() {
    const ed = this.ed;
    const luts = h("div", { class: "list" });
    this.body.append(h("button", { class: "btn primary block", onclick: () => ed.dropItem({ type: "adjust" }, ed.playhead()) }, icon("plus"), t("lib.addAdjustment")),
      h("h4", {}, t("lib.lut")),
      h("button", { class: "btn", onclick: async () => { const files = await call("dialog.openFiles", { kind: "lut", multi: true }); if (files.length && await guard(() => call("library.importFiles", "lut", files, "yours"))) this.draw(); } }, icon("upload"), t("lib.importLut")), luts);
    const items = (await guard(() => call("library.list", { kind: "lut" }))) || [];
    if (!items.length) luts.append(h("div", { class: "muted small" }, "—"));
    for (const it of items) luts.append(h("div", { class: "list-row" }, icon("filter"), h("span", { class: "grow nowrap" }, it.name),
      h("button", { class: "btn small", onclick: () => { const s = ed.selectedSegment(); if (!s || !s.adjust) { toast(t("in.noSelection"), "warning"); return; } ed.exec("updateSegment", { segId: s.id, patch: { adjust: { lut: { assetId: it.id, intensity: s.adjust.lut?.intensity ?? 100 } } } }); } }, t("c.apply"))));
  }

  // ------------------------------------------------------------------ templates
  async templatesTab() {
    const ed = this.ed;
    const grid = h("div", { class: "tiles big" });
    this.body.append(grid);
    const items = (await guard(() => call("template.list", {}))) || [];
    if (!items.length) { grid.append(h("div", { class: "empty" }, icon("template"), t("lib.templatesEmpty"))); return; }
    for (const tp of items) grid.append(h("button", { class: "tile", title: tp.name, onclick: async () => { const p = await guard(() => call("template.use", tp.id)); if (p) ed.app.go("editor", { projectId: p.id }); } },
      h("div", { class: "tile-art" }, tp.coverPath ? h("img", { src: coverUrl(tp.id, tp.updatedAt), alt: "" }) : icon("template")), h("div", { class: "tile-label nowrap" }, tp.name)));
  }

  avatarTab() {
    this.body.append(h("div", { class: "empty" }, icon("avatar"), h("div", {}, t("lib.avatarNa")), h("button", { class: "btn", onclick: () => openProviderOnly(t("tab.avatar")) }, t("ed.more"))));
  }
}

const hexA = (hex, a) => { const n = parseInt((hex || "#000000").slice(1, 7), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
function copyCanvas(c) {
  const d = document.createElement("canvas");
  d.width = c.width; d.height = c.height; d.className = c.className;
  d.getContext("2d").drawImage(c, 0, 0);
  return d;
}

function filterSwatch(a) {
  const warm = (a.temperature || 0) / 100, sat = 1 + (a.saturation || 0) / 100, bri = 1 + ((a.brightness || 0) + (a.exposure || 0)) / 100;
  const base = [90 + warm * 60, 120, 150 - warm * 60].map((v) => Math.round(Math.max(0, Math.min(255, (128 + (v - 128) * sat) * bri))));
  return `linear-gradient(135deg, rgb(${base.join(",")}), rgb(${base.map((v) => Math.round(v * 0.45)).join(",")}))`;
}

export { US };
