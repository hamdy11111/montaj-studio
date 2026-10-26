// Timeline panel (SCREEN-017, FEAT-019..035, FEAT-037 keyframes, FEAT-093 transitions):
// toolbar, ruler, track headers (lock / hide / mute), clips with thumbnails and waveforms, playhead, markers,
// In/Out range, drag-move with snapping, edge trimming, split mode, zoom and context menus; a J/L handle on each
// main-track joint (drag: the picture cut moves, the sound cut stays); music beds and the library browsers.
// Always laid out LTR (time flows left → right) in both languages.
import { h, mount, clear, throttle } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, thumbUrl } from "../api.js";
import { US, clamp, formatTimecode } from "../../core/util.js";
import { TRACK_COLORS } from "../../core/model.js";
import { snapTime, JL_MAX_US } from "../../core/timelineOps.js";
import { isMusicTrack } from "../../core/musicBed.js";
import { openMusicBed, openSoundLibrary, openBrollSearch } from "./libraryBrowsers.js";
import { loadImage } from "./raster.js";

const ROW_H = { video: 58, audio: 40, text: 28, sticker: 28, effect: 26, filter: 26, adjust: 26 };
const HEAD_W = 92;

export class TimelineView {
  /** @param {HTMLElement} host @param {object} ed editor context */
  constructor(host, ed) {
    this.ed = ed;
    this.pxPerSec = 60;
    this.scrollX = 0;
    this.waves = new Map();
    this.toolbar = h("div", { class: "tl-toolbar" });
    this.heads = h("div", { class: "tl-heads" });
    this.ruler = h("canvas", { class: "tl-ruler", height: 26 });
    this.rows = h("div", { class: "tl-rows" });
    this.playhead = h("div", { class: "tl-playhead" }, h("div", { class: "tl-playhead-cap" }));
    this.rangeEl = h("div", { class: "tl-range hidden" });
    this.markers = h("div", { class: "tl-marker-layer" });
    this.content = h("div", { class: "tl-content" }, this.rangeEl, this.markers, this.rows, this.playhead);
    this.scroller = h("div", { class: "tl-scroll" }, h("div", { class: "tl-ruler-wrap" }, this.ruler), this.content);
    this.el = h("div", { class: "timeline", dir: "ltr" }, this.toolbar, h("div", { class: "tl-body" }, h("div", { class: "tl-heads-wrap" }, h("div", { class: "tl-heads-spacer" }), this.heads), this.scroller));
    host.append(this.el);
    this.drawToolbar();
    this.scroller.addEventListener("scroll", () => { this.scrollX = this.scroller.scrollLeft; this.heads.style.transform = `translateY(${-this.scroller.scrollTop}px)`; this.drawRuler(); });
    this.scroller.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.ruler.addEventListener("pointerdown", (e) => this.scrubFrom(e));
    this.content.addEventListener("pointerdown", (e) => { if (e.target === this.content || e.target.classList.contains("tl-row") || e.target === this.rows) { this.ed.select([]); this.scrubFrom(e); } });
    this.playhead.addEventListener("pointerdown", (e) => this.scrubFrom(e));
    this.content.addEventListener("contextmenu", (e) => { if (!e.target.closest(".clip")) { e.preventDefault(); this.ed.emptyMenu(e, this.xToUs(e.clientX)); } });
    this.content.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].some((x) => x === "text/x-montaj-media" || x === "Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    this.content.addEventListener("drop", (e) => this.onDrop(e));
    this.ro = new ResizeObserver(() => { this.drawRuler(); });
    this.ro.observe(this.scroller);
  }
  destroy() { this.ro.disconnect(); }

  // ------------------------------------------------------------------ coordinates
  usToX(us) { return (us / US) * this.pxPerSec; }
  xToUs(clientX) { const r = this.content.getBoundingClientRect(); return Math.max(0, ((clientX - r.left) / this.pxPerSec) * US); }
  setZoom(pps, anchorUs = null) {
    const a = anchorUs ?? this.ed.playhead();
    const screenX = this.usToX(a) - this.scroller.scrollLeft; // keep the anchor time under the same pixel
    this.pxPerSec = clamp(pps, 1, 800);
    this.render();
    this.scroller.scrollLeft = Math.max(0, this.usToX(a) - screenX);
    this.zoomSlider.value = Math.log(this.pxPerSec);
  }
  zoomFit() {
    const dur = Math.max(10 * US, this.ed.duration()); // short or empty timelines show at least 10 s
    this.pxPerSec = clamp(((this.scroller.clientWidth - 40) / dur) * US, 1, 800);
    this.render();
    this.scroller.scrollLeft = 0;
    this.zoomSlider.value = Math.log(this.pxPerSec);
  }

  // ------------------------------------------------------------------ toolbar
  drawToolbar() {
    const ed = this.ed;
    const b = (ic, title, run, opts = {}) => {
      const el = h("button", { class: ["icon-btn", opts.active && "active"], title, "aria-label": title, disabled: opts.disabled, onclick: run }, icon(ic));
      if (opts.id) el.dataset.id = opts.id;
      return el;
    };
    const s = ed.settings().edit;
    this.zoomSlider = h("input", { type: "range", min: Math.log(1), max: Math.log(800), step: 0.01, value: Math.log(this.pxPerSec), class: "tl-zoom", "aria-label": t("tl.zoomIn"), oninput: (e) => this.setZoom(Math.exp(Number(e.target.value))) });
    const hist = ed.history();
    mount(this.toolbar,
      h("div", { class: "row" },
        b(ed.tool() === "split" ? "scissors" : "cursor", ed.tool() === "split" ? t("tl.splitMode") : t("tl.select"), () => ed.run(ed.tool() === "split" ? "selectMode" : "splitMode"), { active: ed.tool() === "split" }),
        h("span", { class: "tl-sep" }),
        b("undo", `${t("tl.undo")} (Ctrl+Z)`, () => ed.run("undo"), { disabled: !hist.canUndo }),
        b("redo", `${t("tl.redo")} (Ctrl+Shift+Z)`, () => ed.run("redo"), { disabled: !hist.canRedo }),
        h("span", { class: "tl-sep" }),
        b("split", `${t("tl.split")} (E)`, () => ed.run("split")),
        b("splitLeft", `${t("tl.deleteLeft")} (Q)`, () => ed.run("deleteLeft")),
        b("splitRight", `${t("tl.deleteRight")} (W)`, () => ed.run("deleteRight")),
        b("trash", `${t("tl.delete")} (Backspace)`, () => ed.run("delete")),
        b("marker", `${t("tl.marker")} (M)`, () => ed.run("addMarker")),
        b("crop", t("tl.crop"), () => ed.run("crop")),
        b("freeze", t("tl.freeze"), () => ed.run("freeze")),
        b("reverse", t("tl.reverse"), () => ed.run("reverse")),
        b("mirror", t("tl.mirror"), () => ed.run("mirror")),
        b("rotate", t("tl.rotate"), () => ed.run("rotate")),
        b("scenes", t("tl.splitScenes"), () => ed.run("splitScenes")),
        b("silence", t("tl.removeSilences"), () => ed.run("removeSilences"))),
      h("div", { class: "grow" }),
      h("div", { class: "row" },
        b("mic", t("tl.recordVoice"), () => ed.run("voiceover")),
        b("audio", t("tl.musicBed"), () => openMusicBed(ed)),
        b("library", t("tl.sfxLib"), () => openSoundLibrary(ed)),
        b("search", t("tl.broll"), () => openBrollSearch(ed)),
        h("span", { class: "tl-sep" }),
        b("magnet", t("tl.magnet"), () => ed.run("toggleMagnet"), { active: s.magnet }),
        b("snap", t("tl.snap"), () => ed.run("toggleSnapping"), { active: s.snapping }),
        b("link", t("tl.linkage"), () => ed.run("toggleLinkage"), { active: s.linkageEnabled }),
        b("axis", t("tl.previewAxis"), () => ed.run("togglePreviewAxis"), { active: s.previewAxis }),
        h("span", { class: "tl-sep" }),
        b("zoomOut", t("tl.zoomOut"), () => this.setZoom(this.pxPerSec / 1.4)), this.zoomSlider, b("zoomIn", t("tl.zoomIn"), () => this.setZoom(this.pxPerSec * 1.4)),
        b("fit", t("tl.zoomFit"), () => this.zoomFit())));
  }

  // ------------------------------------------------------------------ rendering
  orderedTracks() {
    const tl = this.ed.tl();
    const nonAudio = tl.tracks.filter((x) => x.type !== "audio").sort((a, b) => b.order - a.order);
    const audio = tl.tracks.filter((x) => x.type === "audio").sort((a, b) => a.order - b.order);
    return [...nonAudio, ...audio];
  }

  render() {
    // A clip drag/trim owns its element: re-rendering now (a waveform or thumbnail arriving, an agent's edit) would
    // replace that element and drop the gesture, so the render waits for the pointer to be released.
    if (this.gesture) { this.pendingRender = true; return; }
    this.pendingRender = false;
    const tl = this.ed.tl();
    if (!tl) return;
    const dur = this.ed.duration();
    const width = Math.max(this.scroller.clientWidth, this.usToX(dur) + 400);
    this.content.style.width = `${width}px`;
    clear(this.heads); clear(this.rows); clear(this.markers);
    const sel = new Set(this.ed.selection());
    for (const track of this.orderedTracks()) {
      const hgt = ROW_H[track.type] || 30;
      this.heads.append(h("div", { class: ["tl-head", track.isMain && "main"], style: { height: `${hgt}px` } },
        h("span", { class: "tl-head-type", title: track.role === "behind" ? t("lib.behindPerson") : isMusicTrack(track) ? t("in.musicBed") : track.type }, icon(track.role === "behind" ? "layers" : isMusicTrack(track) ? "audio" : { video: "video", audio: "audio", text: "text", sticker: "sticker", effect: "effect", filter: "filter", adjust: "adjust" }[track.type] || "layers")),
        h("button", { class: ["icon-btn", track.locked && "active"], title: t("tl.lock"), "aria-label": t("tl.lock"), onclick: () => this.ed.exec("setTrackFlag", { trackId: track.id, flag: "locked", value: !track.locked }) }, icon(track.locked ? "lock" : "unlock")),
        track.type !== "audio" ? h("button", { class: ["icon-btn", track.hidden && "active"], title: t("tl.hide"), "aria-label": t("tl.hide"), onclick: () => this.ed.exec("setTrackFlag", { trackId: track.id, flag: "hidden", value: !track.hidden }) }, icon(track.hidden ? "eyeOff" : "eye")) : null,
        ["video", "audio"].includes(track.type) ? h("button", { class: ["icon-btn", track.muted && "active"], title: t("tl.mute"), "aria-label": t("tl.mute"), onclick: () => this.ed.exec("setTrackFlag", { trackId: track.id, flag: "muted", value: !track.muted }) }, icon(track.muted ? "mute" : "volume")) : null,
        track.isMain ? h("button", { class: "tl-cover", title: t("tl.editCover"), onclick: (e) => this.ed.coverMenu(e) }, t("tl.cover")) : null));
      const row = h("div", { class: ["tl-row", track.locked && "locked", track.hidden && "hidden-track"], style: { height: `${hgt}px` } });
      row.dataset.trackId = track.id; row.dataset.type = track.type;
      for (const seg of track.segments) row.append(this.clipEl(track, seg, hgt, sel.has(seg.id)));
      if (track.isMain) for (let i = 0; i < track.segments.length - 1; i++) row.append(this.transitionEl(track.segments[i], track.segments[i + 1]));
      if (track.isMain && !track.locked) {
        const segs = [...track.segments].sort((x, y) => x.start - y.start);
        for (let i = 1; i < segs.length; i++) { const el = this.jlEl(segs[i - 1], segs[i], hgt); if (el) row.append(el); }
      }
      this.rows.append(row);
    }
    if (tl.tracks.every((x) => !x.segments.length)) this.rows.append(h("div", { class: "tl-empty" }, icon("media"), t("ed.dragHere")));
    for (const m of tl.markers) {
      const mk = h("div", { class: "tl-marker", title: m.note || formatTimecode(m.timeUs, tl.fps), style: { left: `${this.usToX(m.timeUs)}px`, background: m.color },
        onclick: (e) => { e.stopPropagation(); this.ed.seek(m.timeUs); }, oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.ed.markerMenu(m, e); } });
      this.markers.append(mk);
    }
    this.drawRange();
    this.drawRuler();
    this.movePlayhead(this.ed.playhead());
  }

  clipEl(track, seg, hgt, selected) {
    const left = this.usToX(seg.start), w = Math.max(2, this.usToX(seg.duration));
    const m = seg.mediaId ? this.ed.media(seg.mediaId) : null;
    const color = seg.kind === "audio" && m?.origin === "tts" ? TRACK_COLORS.tts : TRACK_COLORS[track.type] || "#444";
    const label = seg.kind === "text" ? seg.text?.content : seg.kind === "effect" ? seg.effect?.type : seg.kind === "filter" ? seg.filter?.preset : seg.kind === "sticker" ? seg.sticker?.builtin || seg.name : seg.name;
    const el = h("div", { class: ["clip", `k-${seg.kind}`, selected && "selected", seg.disabled && "disabled", m?.status === "missing" && "missing"], style: { left: `${left}px`, width: `${w}px`, background: color }, tabindex: -1, "aria-label": label || seg.kind });
    el.dataset.segId = seg.id;
    if (seg.kind === "video" || seg.kind === "image") el.append(this.thumbCanvas(seg, m, w, hgt));
    if (seg.kind === "audio" || (seg.kind === "video" && m?.hasAudio && !seg.audioDetached && hgt >= 50)) el.append(this.waveCanvas(seg, m, w, seg.kind === "audio" ? hgt : 16));
    el.append(h("div", { class: "clip-label nowrap" },
      seg.speed !== 1 || seg.speedMode === "curve" ? h("span", { class: "clip-badge" }, seg.speedMode === "curve" ? "∿" : `${Number(seg.speed.toFixed(2))}x`) : null,
      seg.kind === "compound" ? h("span", { class: "clip-badge" }, "▣") : null,
      seg.groupId ? h("span", { class: "clip-badge" }, "⛓") : null,
      m?.status === "missing" ? h("span", { class: "clip-badge warn" }, t("ed.missing")) : null,
      label || ""));
    if (selected) for (const k of seg.keyframes || []) el.append(h("div", { class: "kf", title: `${k.prop} = ${k.value}`, style: { left: `${this.usToX(k.timeUs) - 4}px` }, onclick: (e) => { e.stopPropagation(); this.ed.seek(seg.start + k.timeUs); } }));
    if (seg.fadeInUs > 0) el.append(h("div", { class: "fade in", style: { width: `${this.usToX(seg.fadeInUs)}px` } }));
    if (seg.fadeOutUs > 0) el.append(h("div", { class: "fade out", style: { width: `${this.usToX(seg.fadeOutUs)}px` } }));
    if (!track.locked) {
      el.append(h("div", { class: "trim l", onpointerdown: (e) => this.trimDrag(e, seg, "start") }), h("div", { class: "trim r", onpointerdown: (e) => this.trimDrag(e, seg, "end") }));
      el.addEventListener("pointerdown", (e) => { if (!e.target.classList.contains("trim") && !e.target.classList.contains("kf")) this.clipDown(e, track, seg); });
    } else el.addEventListener("pointerdown", (e) => this.ed.select([seg.id]));
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!this.ed.selection().includes(seg.id)) this.ed.select([seg.id]); this.ed.clipMenu(e, seg); });
    el.addEventListener("dblclick", () => this.ed.focusInspector?.(seg));
    return el;
  }

  transitionEl(a, b) {
    const has = a.transitionOut?.type && a.transitionOut.type !== "none";
    const x = this.usToX(b.start);
    return h("button", { class: ["tl-trans", has && "on"], style: { left: `${x - 8}px` }, title: has ? a.transitionOut.type : t("tab.transitions"), "aria-label": t("tab.transitions"),
      onclick: (e) => { e.stopPropagation(); this.ed.select([a.id]); this.ed.openPanel("transitions"); } }, icon("transition"));
  }

  /**
   * J/L handle on a joint of two picture clips (no transition, no gap): it sits where the picture cuts; drag it right
   * for a J (the next clip's sound starts first), left for an L (the sound of the clip before runs on). ±0.5 s.
   */
  jlEl(a, b, hgt) {
    const pic = (k) => ["video", "image", "compound"].includes(k);
    if (!pic(a.kind) || !pic(b.kind) || Math.abs(a.start + a.duration - b.start) > 1000 || (a.transitionOut?.type && a.transitionOut.type !== "none")) return null;
    const jl = b.jlUs || 0, label = (us) => (us < 0 ? "J" : us > 0 ? "L" : "J/L");
    const x0 = this.usToX(b.start);
    const tip = (us) => `${label(us)} ${Math.abs(Math.round(us / 1000))} ms · ${t("in.jlHint")}`;
    const el = h("div", { class: ["tl-jl", jl && "on"], title: tip(jl), "aria-label": t("in.jl"),
      style: { position: "absolute", left: `${x0 - this.usToX(jl) - 7}px`, bottom: "2px", width: "14px", height: "14px", borderRadius: "3px", zIndex: 6, cursor: "ew-resize",
        display: "grid", placeItems: "center", fontSize: "9px", fontWeight: "700", color: jl ? "var(--accent-ink)" : "#ddd", background: jl ? "var(--accent)" : "rgba(0,0,0,.55)", opacity: jl ? 1 : 0.55 } }, label(jl).slice(0, 1));
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const release = this.holdRender(el);
      let us = jl;
      const move = (ev) => {
        // The handle is the picture cut: right of the joint = the picture comes later = a J (negative J/L).
        us = Math.round(Math.max(-JL_MAX_US, Math.min(JL_MAX_US, -(this.xToUs(ev.clientX) - b.start))) / 10_000) * 10_000;
        el.style.left = `${x0 - this.usToX(us) - 7}px`;
        el.textContent = label(us).slice(0, 1);
        el.title = tip(us);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        if (us === jl) { release(true); return; }
        release();
        this.ed.exec("setJL", { segId: b.id, jlUs: us });
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", (e) => { e.stopPropagation(); if (jl) this.ed.exec("setJL", { segId: b.id, jlUs: 0 }); });
    return el;
  }

  thumbCanvas(seg, m, w, hgt) {
    const c = h("canvas", { class: "clip-thumbs", width: Math.min(4096, Math.ceil(w)), height: hgt - 2 });
    if (!m?.thumbPath) return c;
    loadImage(thumbUrl(m.id, m.thumbCount)).then((img) => {
      const g = c.getContext("2d");
      const n = Math.max(1, m.thumbCount || 1);
      const fw = img.naturalWidth / n, fh = img.naturalHeight;
      const tw = Math.max(8, (fw / fh) * c.height);
      const visible = this.visibleRange();
      for (let x = 0; x < c.width; x += tw) {
        const absX = this.usToX(seg.start) + x;
        if (absX + tw < visible[0] - 200 || absX > visible[1] + 200) continue;
        const local = (x / Math.max(1, w)) * seg.duration;
        const src = seg.kind === "image" ? 0 : seg.sourceStart + local * (seg.speedMode === "curve" ? 1 : seg.speed || 1);
        const idx = seg.kind === "image" ? 0 : clamp(Math.floor((src / Math.max(1, m.durationUs)) * n), 0, n - 1);
        g.drawImage(img, idx * fw, 0, fw, fh, x, 0, tw, c.height);
      }
    }).catch(() => {});
    return c;
  }

  waveCanvas(seg, m, w, hgt) {
    const c = h("canvas", { class: "clip-wave", width: Math.min(4096, Math.ceil(w)), height: hgt });
    if (!m?.waveformPath) return c;
    const draw = (wave) => {
      const g = c.getContext("2d");
      g.fillStyle = "rgba(160, 210, 255, .55)";
      const speed = seg.speedMode === "curve" ? 1 : seg.speed || 1;
      const gain = 10 ** ((seg.volumeDb || 0) / 20);
      for (let x = 0; x < c.width; x++) {
        const srcUs = seg.sourceStart + ((x / w) * seg.duration) * speed;
        const p = wave.peaks[Math.floor((srcUs / US) * wave.rate)] || 0;
        const v = Math.min(1, p * gain) * (hgt - 2);
        g.fillRect(x, (hgt - v) / 2, 1, Math.max(1, v));
      }
    };
    const cached = this.waves.get(m.id);
    if (cached && cached !== "loading") draw(cached);
    else if (!cached) {
      this.waves.set(m.id, "loading");
      call("media.waveform", m.id).then((wv) => { if (wv) { this.waves.set(m.id, wv); this.render(); } else this.waves.delete(m.id); }).catch(() => this.waves.delete(m.id));
    }
    return c;
  }

  /** Update selection highlight in place (used while a pointer gesture owns the clip element). */
  markSelection(ids) {
    const set = new Set(ids);
    for (const el of this.rows.querySelectorAll(".clip")) el.classList.toggle("selected", set.has(el.dataset.segId));
  }

  visibleRange() { return [this.scroller.scrollLeft, this.scroller.scrollLeft + this.scroller.clientWidth]; }

  drawRuler() {
    const c = this.ruler, w = this.scroller.clientWidth;
    const dpr = devicePixelRatio || 1;
    c.width = Math.max(1, w * dpr); c.height = 26 * dpr; c.style.width = `${w}px`; c.style.height = "26px";
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, 26);
    g.fillStyle = "#8a8a8a"; g.strokeStyle = "#4a4a4a"; g.font = "10px Segoe UI";
    const steps = [1 / 30, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800];
    const major = steps.find((s) => s * this.pxPerSec >= 70) || 3600;
    const minor = major / 5;
    const x0 = this.scroller.scrollLeft;
    const t0 = Math.floor(x0 / this.pxPerSec / minor) * minor;
    g.beginPath();
    for (let s = t0; (s - x0 / this.pxPerSec) * this.pxPerSec < w; s += minor) {
      const x = s * this.pxPerSec - x0;
      const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
      g.moveTo(Math.round(x) + 0.5, isMajor ? 12 : 19); g.lineTo(Math.round(x) + 0.5, 26);
      if (isMajor) g.fillText(formatTimecode(Math.round(s * US), this.ed.tl().fps).replace(/^00:/, ""), x + 3, 10);
    }
    g.stroke();
    // In / Out markers on the ruler
    const io = this.ed.inOut();
    g.fillStyle = "#00c1cd";
    if (io.in !== null) g.fillRect(this.usToX(io.in) - x0, 0, 2, 26);
    if (io.out !== null) g.fillRect(this.usToX(io.out) - x0 - 2, 0, 2, 26);
  }

  drawRange() {
    const io = this.ed.inOut();
    if (io.in === null && io.out === null) { this.rangeEl.classList.add("hidden"); return; }
    const a = io.in ?? 0, b = io.out ?? this.ed.duration();
    this.rangeEl.classList.remove("hidden");
    Object.assign(this.rangeEl.style, { left: `${this.usToX(Math.min(a, b))}px`, width: `${Math.abs(this.usToX(b - a))}px` });
  }

  movePlayhead(us) {
    const x = this.usToX(us);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.ed.isPlaying()) {
      const [a, b] = this.visibleRange();
      if (x > b - 40 || x < a) this.scroller.scrollLeft = Math.max(0, x - 80);
    }
  }

  // ------------------------------------------------------------------ interactions
  scrubFrom(e) {
    if (e.button !== 0) return;
    const move = throttle((ev) => this.ed.seek(this.snapIf(this.xToUs(ev.clientX), [], ev), { scrub: true }), 16);
    this.ed.seek(this.xToUs(e.clientX), { scrub: true });
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const up = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  snapIf(us, exclude, ev) {
    if (!this.ed.settings().edit.snapping || ev?.altKey) return us;
    return snapTime(this.ed.tl(), us, (8 / this.pxPerSec) * US, { exclude, playheadUs: this.ed.playhead() });
  }

  /** Mark a pointer gesture on a clip; returns end() which releases it (and renders if something waited). */
  holdRender(target) {
    this.gesture = true;
    let ended = false;
    const end = (renderNow = false) => {
      if (ended) return; ended = true;
      this.gesture = false;
      if (renderNow || this.pendingRender) this.render();
    };
    target.addEventListener("lostpointercapture", () => end(), { once: true });
    return end;
  }

  clipDown(e, track, seg) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (this.ed.tool() === "split") { this.ed.exec("split", { atUs: this.snapIf(this.xToUs(e.clientX), [], e), ids: [seg.id] }); return; }
    const sel = this.ed.selection();
    if (e.ctrlKey || e.metaKey || e.shiftKey) { this.ed.select(sel.includes(seg.id) ? sel.filter((x) => x !== seg.id) : [...sel, seg.id]); return; }
    if (!sel.includes(seg.id)) this.ed.select([seg.id], { soft: true }); // keep this element alive for the drag
    const el = e.currentTarget;
    const startX = e.clientX, startY = e.clientY;
    const offsetUs = this.xToUs(e.clientX) - seg.start;
    let moved = false, targetRow = null;
    el.setPointerCapture(e.pointerId);
    const release = this.holdRender(el);
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      let ns = Math.max(0, this.xToUs(ev.clientX) - offsetUs);
      const snappedStart = this.snapIf(ns, [seg.id], ev);
      const snappedEnd = this.snapIf(ns + seg.duration, [seg.id], ev) - seg.duration;
      ns = Math.abs(snappedStart - ns) <= Math.abs(snappedEnd - ns) ? snappedStart : snappedEnd;
      el.style.left = `${this.usToX(ns)}px`;
      el.classList.add("dragging");
      el.dataset.newStart = String(Math.round(ns));
      const rowEl = document.elementsFromPoint(ev.clientX, ev.clientY).find((x) => x.classList?.contains("tl-row"));
      targetRow = rowEl && rowEl.dataset.type === track.type ? rowEl : null;
      const rowsRect = this.rows.getBoundingClientRect();
      const outside = ev.clientY < rowsRect.top + 4 || ev.clientY > rowsRect.bottom - 4;
      el.dataset.newTrack = outside ? "new" : targetRow && targetRow.dataset.trackId !== track.id ? targetRow.dataset.trackId : "";
      if (targetRow && targetRow !== el.parentElement) { el.style.transform = `translateY(${targetRow.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top}px)`; }
      else if (outside) el.style.transform = `translateY(${ev.clientY < rowsRect.top + 4 ? -20 : 20}px)`;
      else el.style.transform = "";
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (!moved) { release(true); return; }
      const ns = Number(el.dataset.newStart);
      const trackId = el.dataset.newTrack || null;
      if (ns === seg.start && !trackId) { release(true); return; }
      release();
      this.ed.exec("move", { segId: seg.id, start: ns, trackId });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  trimDrag(e, seg, edge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.ed.select([seg.id], { soft: true });
    const el = e.currentTarget.parentElement;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const release = this.holdRender(handle);
    let timeUs = edge === "start" ? seg.start : seg.start + seg.duration;
    const tip = h("div", { class: "tl-tip" });
    el.append(tip);
    const move = (ev) => {
      timeUs = this.snapIf(this.xToUs(ev.clientX), [seg.id], ev);
      if (edge === "start") { timeUs = Math.min(timeUs, seg.start + seg.duration - US / 30); el.style.left = `${this.usToX(timeUs)}px`; el.style.width = `${this.usToX(seg.start + seg.duration - timeUs)}px`; }
      else { timeUs = Math.max(timeUs, seg.start + US / 30); el.style.width = `${this.usToX(timeUs - seg.start)}px`; }
      tip.textContent = formatTimecode(edge === "start" ? seg.start + seg.duration - timeUs : timeUs - seg.start, this.ed.tl().fps);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      tip.remove();
      const cur = edge === "start" ? seg.start : seg.start + seg.duration;
      if (Math.abs(timeUs - cur) < 1000) { release(true); return; }
      release();
      this.ed.exec("trim", { segId: seg.id, edge, timeUs: Math.round(timeUs) });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  onWheel(e) {
    if (e.ctrlKey) { e.preventDefault(); this.setZoom(this.pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15), this.xToUs(e.clientX)); }
    else if (e.altKey || e.shiftKey) { e.preventDefault(); this.scroller.scrollLeft += e.deltaY; }
  }

  async onDrop(e) {
    e.preventDefault();
    const atUs = this.snapIf(this.xToUs(e.clientX), [], e);
    const rowEl = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains("tl-row"));
    const toMain = !rowEl || this.ed.tl().tracks.find((x) => x.id === rowEl.dataset.trackId)?.isMain;
    const mediaId = e.dataTransfer.getData("text/x-montaj-media");
    if (mediaId) { this.ed.exec("addMedia", { mediaId, atUs, toMain: !!toMain }); return; }
    const kind = e.dataTransfer.getData("text/x-montaj-item");
    if (kind) { this.ed.dropItem(JSON.parse(kind), atUs); return; }
    if (e.dataTransfer.files?.length) this.ed.importDropped([...e.dataTransfer.files], { atUs, toMain: !!toMain, addToTimeline: true });
  }
}
