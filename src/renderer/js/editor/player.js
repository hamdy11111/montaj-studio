// Preview compositor (SCREEN-016 Player, FEAT-035..040, FEAT-066..079, FEAT-092..095).
// Draws every visible layer of the timeline onto a <canvas> with the same layer math as the exporter
// (core/layerMath NUM backend), plays media through <video>/<audio> elements synced to the playhead, and routes
// audio through Web Audio so volume keyframes, fades and gains above 0 dB are audible.
// Preview approximations (documented): per-pixel grading runs at preview resolution; voice changer, noise
// reduction and loudness normalization are applied only on export.
import { h } from "../dom.js";
import { US, clamp } from "../../core/util.js";
import { layerState, transitionsFor, gainAt, NUM } from "../../core/layerMath.js";
import { sourceOffsetAt, rateAt } from "../../core/speed.js";
import { makePixelProcessor, applyFilterPreset, isDefaultAdjust } from "../../core/color.js";
import { parseCube } from "../../core/lut.js";
import { mediaUrl, call } from "../api.js";
import { rasterText, rasterSticker, stickerSrc } from "./raster.js";
import { captionCanvas, captionStateAt, captionLayout, stateKey } from "./captionRaster.js";
import { graphicCanvas, graphicStateAt, preloadGraphic } from "./graphicsRaster.js";
import { cutoutLayers, cutoutAfterTrack } from "../../core/cutout.js";

const BLEND = { normal: "source-over", screen: "screen", add: "lighter", multiply: "multiply", darken: "darken", lighten: "lighten", overlay: "overlay" };
const VISUAL = new Set(["video", "image", "text", "sticker", "compound"]);
const GRADE = new Set(["effect", "filter", "adjust"]);

export class Player {
  /** @param {HTMLElement} host  @param {object} ed editor context ({tl(), media(id), settings(), onTime(us), selection(), onTransform(segId, patch, final)}) */
  constructor(host, ed) {
    // A bundled font that finishes loading after a text was drawn: redraw the text layers with it.
    this.onFonts = () => { this.rasters.clear(); this.invalidate(); };
    document.fonts.addEventListener("loadingdone", this.onFonts);
    this.ed = ed;
    this.host = host;
    this.canvas = h("canvas", { class: "player-canvas", "aria-label": "Player" });
    this.overlay = h("canvas", { class: "player-overlay" });
    this.stage = h("div", { class: "player-stage" }, this.canvas, this.overlay);
    host.append(this.stage);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.octx = this.overlay.getContext("2d");
    this.videos = new Map();   // segId → { el, node, gain, src }
    this.audios = new Map();
    this.images = new Map();   // src → HTMLImageElement | Promise
    this.rasters = new Map();  // key → canvas
    this.luts = new Map();     // assetId → parsed LUT | "loading"
    this.procCache = new Map();
    this.mattes = new Map();   // mediaId → { el, failedAt, canvas, key } person-matte video (text behind the person)
    this.timeUs = 0;
    this.playing = false;
    this.zoom = 1;
    this.guides = false;
    this.range = null;         // { startUs, endUs } for Play In/Out
    this.actx = null;
    this.dirty = true;
    this.lastLayout = null;
    this.drag = null;
    this.stats = { renders: 0, renderMs: 0, maxMs: 0, playStart: 0 }; // benchmark counters (read when MONTAJ_BENCH=1)
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.overlay.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.overlay.addEventListener("dblclick", (e) => this.ed.onDoubleClick?.(this.hitTest(e)));
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    document.fonts.removeEventListener("loadingdone", this.onFonts);
    this.ro.disconnect();
    for (const m of [this.videos, this.audios, this.mattes]) for (const v of m.values()) { v.el.pause(); v.el.removeAttribute("src"); v.el.load(); }
    this.actx?.close().catch(() => {});
  }

  // ------------------------------------------------------------------ layout & sizing
  layout() {
    const tl = this.ed.tl();
    if (!tl) return;
    const r = this.host.getBoundingClientRect();
    const ar = tl.canvas.width / tl.canvas.height;
    let w = r.width - 16, hh = r.height - 16;
    if (w / hh > ar) w = hh * ar; else hh = w / ar;
    w *= this.zoom; hh *= this.zoom;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const maxW = 1280;
    let W = Math.round(w * dpr), H = Math.round(hh * dpr);
    if (W > maxW) { H = Math.round(H * maxW / W); W = maxW; }
    W = Math.max(2, W); H = Math.max(2, H);
    const key = `${W}x${H}x${w}`;
    if (key === this.lastLayout) return;
    this.lastLayout = key;
    for (const c of [this.canvas, this.overlay]) { c.width = W; c.height = H; c.style.width = `${w}px`; c.style.height = `${hh}px`; }
    this.rasters.clear();
    this.invalidate();
  }
  get W() { return this.canvas.width; }
  get H() { return this.canvas.height; }

  setZoom(z) { this.zoom = clamp(z, 0.25, 4); this.lastLayout = null; this.layout(); }
  invalidate() { this.dirty = true; }

  // ------------------------------------------------------------------ transport
  async play() {
    const tl = this.ed.tl();
    const end = this.endUs();
    if (!tl || end <= 0) return;
    if (this.range && (this.timeUs < this.range.startUs || this.timeUs >= this.range.endUs - 1000)) this.timeUs = this.range.startUs;
    else if (this.timeUs >= end - 1000) this.timeUs = 0;
    this.ensureAudio();
    if (this.actx.state === "suspended") await this.actx.resume().catch(() => {});
    this.playing = true;
    this.clock = { at: performance.now(), us: this.timeUs };
    this.ed.onPlayState?.(true);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const m of [this.videos, this.audios]) for (const v of m.values()) v.el.pause();
    this.ed.onPlayState?.(false);
    this.invalidate();
  }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(us, { scrub = false } = {}) {
    this.timeUs = clamp(Math.round(us), 0, Math.max(0, this.endUs()));
    if (this.playing) this.clock = { at: performance.now(), us: this.timeUs };
    this.invalidate();
    if (scrub && !this.playing && this.ed.settings().edit.scrubAudio) this.scrubBlip();
  }
  endUs() { const tl = this.ed.tl(); let e = 0; for (const t of tl?.tracks || []) for (const s of t.segments) e = Math.max(e, s.start + s.duration); return e; }

  scrubBlip() {
    this.ensureAudio();
    this.actx.resume().catch(() => {});
    const t = this.timeUs;
    for (const [segId, v] of [...this.videos, ...this.audios]) {
      const seg = this.findSeg(segId);
      if (!seg || t < seg.start || t >= seg.start + seg.duration) continue;
      v.el.play().catch(() => {});
      setTimeout(() => { if (!this.playing) v.el.pause(); }, 90);
    }
  }

  loop(now) {
    this.raf = requestAnimationFrame(this.loop);
    if (this.playing) {
      const t = this.clock.us + (now - this.clock.at) * 1000;
      const stop = this.range ? this.range.endUs : this.endUs();
      if (t >= stop) { this.timeUs = stop; this.pause(); this.ed.onTime(this.timeUs); return; }
      this.timeUs = t;
      this.ed.onTime(this.timeUs);
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      const t0 = performance.now();
      this.render();
      const dt = performance.now() - t0;
      this.stats.renders++; this.stats.renderMs += dt; if (dt > this.stats.maxMs) this.stats.maxMs = dt;
    }
  }

  ensureAudio() {
    if (!this.actx) { this.actx = new AudioContext({ latencyHint: "interactive" }); this.master = this.actx.createGain(); this.master.connect(this.actx.destination); }
  }

  findSeg(segId) { for (const t of this.ed.tl()?.tracks || []) for (const s of t.segments) if (s.id === segId) return s; return null; }

  // ------------------------------------------------------------------ person matte (text behind the person)
  /**
   * The person matte of a video clip at its current frame, as an alpha canvas, with the source region that matches
   * the layer's crop; null while it loads (or when the matte has not been made: see timeline_behind_person).
   * The matte video plays alongside the clip's own element (same media time), corrected when it drifts.
   */
  matteFrame(seg, s) {
    const main = this.videos.get(seg.id)?.el;
    if (!main) return null;
    let m = this.mattes.get(seg.mediaId);
    if (m?.failedAt && performance.now() - m.failedAt > 5000) { this.mattes.delete(seg.mediaId); m = null; } // made meanwhile?
    if (!m) {
      const el = document.createElement("video");
      el.crossOrigin = "anonymous"; el.muted = true; el.preload = "auto";
      el.src = `media://matte/${encodeURIComponent(seg.mediaId)}`;
      m = { el, failedAt: 0, canvas: document.createElement("canvas"), key: "" };
      el.addEventListener("seeked", () => this.invalidate());
      el.addEventListener("loadeddata", () => this.invalidate());
      el.addEventListener("error", () => { m.failedAt = performance.now(); });
      this.mattes.set(seg.mediaId, m);
    }
    const el = m.el;
    m.usedIn = this.stats.renders;
    if (m.failedAt || el.readyState < 2) return null;
    const want = main.currentTime;
    if (!main.paused) {
      if (Math.abs(el.playbackRate - main.playbackRate) > 0.01) el.playbackRate = main.playbackRate;
      if (Math.abs(el.currentTime - want) > 0.12 && !el.seeking) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.5 / 60 && !el.seeking) el.currentTime = want;
    }
    const mw = el.videoWidth, mh = el.videoHeight;
    if (!mw || !mh) return null;
    const key = `${el.currentTime.toFixed(4)}:${mw}x${mh}`;
    if (m.key !== key) { // luminance → alpha (the matte is white on black)
      const c = m.canvas;
      if (c.width !== mw || c.height !== mh) { c.width = mw; c.height = mh; }
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(el, 0, 0);
      const d = g.getImageData(0, 0, mw, mh), px = d.data;
      for (let i = 0; i < px.length; i += 4) { px[i + 3] = px[i]; px[i] = px[i + 1] = px[i + 2] = 255; }
      g.putImageData(d, 0, 0);
      m.key = key;
    }
    const vw = main.videoWidth || mw, vh = main.videoHeight || mh;
    return { canvas: m.canvas, sx: ((s.sx || 0) * mw) / vw, sy: ((s.sy || 0) * mh) / vh, sw: (s.sw * mw) / vw, sh: (s.sh * mh) / vh };
  }

  // ------------------------------------------------------------------ media elements
  mediaElement(pool, seg, kind) {
    const m = seg.kind === "compound" ? null : this.ed.media(seg.mediaId);
    const useProxy = !!(m?.proxyPath && this.ed.settings().performance.proxy);
    const src = seg.kind === "compound" ? `media://compound/${seg.compoundTimelineId}?v=${this.ed.compoundVersion(seg.compoundTimelineId)}` : m && m.status !== "missing" ? mediaUrl(m.id, { proxy: useProxy }) : null;
    if (!src) return null;
    let v = pool.get(seg.id);
    if (v && v.src !== src) { v.el.pause(); pool.delete(seg.id); v = null; }
    if (!v) {
      const el = document.createElement(kind);
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.src = src;
      el.addEventListener("seeked", () => this.invalidate());
      el.addEventListener("loadeddata", () => this.invalidate());
      el.addEventListener("error", () => { v.failed = true; this.invalidate(); });
      v = { el, src, node: null, gain: null, failed: false };
      if (this.actx) this.connect(v);
      pool.set(seg.id, v);
    }
    if (!v.node && this.actx) this.connect(v);
    return v;
  }
  connect(v) {
    try { v.node = this.actx.createMediaElementSource(v.el); v.gain = this.actx.createGain(); v.node.connect(v.gain).connect(this.master); } catch { /* already connected */ }
  }

  /** Keep a media element on the source time for segment-local time; play/pause with the transport. */
  syncMedia(v, seg, localUs, audible, gain) {
    const el = v.el;
    const want = (seg.sourceStart + sourceOffsetAt(seg, clamp(localUs, 0, seg.duration))) / US;
    const rate = clamp(rateAt(seg, clamp(localUs, 0, seg.duration)), 0.0625, 16);
    if (v.gain) v.gain.gain.value = audible ? gain : 0;
    else el.volume = audible ? clamp(gain, 0, 1) : 0;
    el.muted = !audible && !v.gain;
    if (this.playing && localUs >= 0 && localUs < seg.duration) {
      el.preservesPitch = !seg.changePitch;
      if (Math.abs(el.playbackRate - rate) > 0.01) el.playbackRate = rate;
      if (Math.abs(el.currentTime - want) > 0.25 || el.readyState < 2) { if (!el.seeking) el.currentTime = want; }
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.5 / 30 && !el.seeking) el.currentTime = want;
    }
  }

  image(src) {
    const c = this.images.get(src);
    if (c instanceof HTMLImageElement) return c.complete && c.naturalWidth ? c : null;
    if (!c) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => this.invalidate();
      img.src = src;
      this.images.set(src, img);
    }
    return null;
  }

  lut(assetId) {
    if (!assetId) return null;
    const v = this.luts.get(assetId);
    if (v === "loading") return null;
    if (v) return v;
    this.luts.set(assetId, "loading");
    call("library.readLut", assetId).then((txt) => { this.luts.set(assetId, parseCube(txt)); this.procCache.clear(); this.invalidate(); }).catch(() => this.luts.set(assetId, null));
    return null;
  }

  processor(adjust, width, height) {
    if (!adjust || adjust.enabled === false) return null;
    const key = JSON.stringify(adjust) + width + "x" + height;
    if (this.procCache.has(key)) return this.procCache.get(key);
    const p = makePixelProcessor(adjust, { lut: this.lut(adjust.lut?.assetId), width, height });
    if (this.procCache.size > 64) this.procCache.clear();
    this.procCache.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------ rendering
  render() {
    const tl = this.ed.tl();
    const g = this.ctx, W = this.W, H = this.H;
    if (!tl) return;
    const t = this.timeUs;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; g.filter = "none";
    g.fillStyle = tl.canvas.bgColor || "#000";
    g.fillRect(0, 0, W, H);
    const tracks = [...tl.tracks].sort((a, b) => a.order - b.order);
    const live = new Set();
    const cutoutAfter = cutoutAfterTrack(tl);
    for (const track of tracks) {
      if (track.id === cutoutAfter) this.pendingCutouts = true;
      const segs = track.segments.filter((s) => !s.disabled).sort((a, b) => a.start - b.start);
      if (track.isMain && !track.hidden && tl.canvas.bgType === "blur") {
        // Blurred backgrounds sit under every main-track clip on screen, also during a transition (as in the export).
        segs.forEach((seg, i) => {
          if (!VISUAL.has(seg.kind)) return;
          const tr = transitionsFor(segs, i);
          const pre = tr.transIn ? (tr.transIn.d * US) / 2 : 0, post = tr.transOut ? (tr.transOut.d * US) / 2 : 0;
          if (t >= seg.start - pre && t < seg.start + seg.duration + post) this.drawBlurBackground(seg);
        });
      }
      segs.forEach((seg, i) => {
        // Audio first (any audible kind), independent of visibility.
        if (seg.kind === "audio" || ((seg.kind === "video" || seg.kind === "compound") && !this.ed.mediaMissing(seg))) {
          const isAudioTrack = seg.kind === "audio";
          const pool = isAudioTrack ? this.audios : this.videos;
          const active = t >= seg.start - 2 * US && t < seg.start + seg.duration + US;
          if (active) {
            const v = this.mediaElement(pool, seg, isAudioTrack ? "audio" : "video");
            if (v) {
              live.add(seg.id);
              const local = t - seg.start;
              const inside = local >= 0 && local < seg.duration;
              const audible = inside && !track.muted && !(seg.kind !== "audio" && seg.audioDetached);
              this.syncMedia(v, seg, local, audible, gainAt(NUM, seg, local / US));
            }
          }
        }
        if (track.hidden) return;
        if (GRADE.has(seg.kind)) { if (t >= seg.start && t < seg.start + seg.duration) this.gradeComposite(seg, t); return; }
        if (!VISUAL.has(seg.kind)) return;
        const tr = track.isMain ? transitionsFor(segs, i) : { transIn: null, transOut: null };
        const pre = tr.transIn ? (tr.transIn.d * US) / 2 : 0, post = tr.transOut ? (tr.transOut.d * US) / 2 : 0;
        if (t < seg.start - pre || t >= seg.start + seg.duration + post) return;
        this.drawLayer(seg, t, tr);
      });
      if (this.pendingCutouts) {
        // Text behind the person: the person, cut out of the main clip, over the behind tracks (core/cutout.js).
        this.pendingCutouts = false;
        for (const c of cutoutLayers(tl, { startUs: t, endUs: t + 1 })) this.drawLayer(c.seg, t, { transIn: null, transOut: null });
      }
    }
    // Pause elements of segments that are no longer near the playhead.
    for (const pool of [this.videos, this.audios]) for (const [id, v] of pool) if (!live.has(id)) { if (!v.el.paused) v.el.pause(); if (!this.findSeg(id)) pool.delete(id); }
    for (const m of this.mattes.values()) if (m.usedIn !== this.stats.renders && !m.el.paused) m.el.pause(); // no cutout on screen
    this.drawOverlay();
  }

  /** Returns a drawable + its base (fit) size, or null if not ready yet. */
  source(seg) {
    const W = this.W, H = this.H;
    if (seg.kind === "text" && seg.text?.graphic) {
      // Motion graphic: the full-frame picture of its current frame state (held frames are drawn once).
      const gr = seg.text.graphic;
      const base = `g:${JSON.stringify(gr)}:${seg.duration}:${W}x${H}`;
      if (!this.rasters.has(`${base}:assets`)) { this.rasters.set(`${base}:assets`, true); preloadGraphic(gr).then(() => { for (const k of [...this.rasters.keys()]) if (k.startsWith(base) && !k.endsWith(":assets")) this.rasters.delete(k); this.invalidate(); }); }
      const st = graphicStateAt(gr, seg.duration, this.ed.tl().fps || 30, this.timeUs - seg.start);
      const key = `${base}:${st.key}`;
      let c = this.rasters.get(key);
      if (c === undefined) {
        c = graphicCanvas(gr, W, H, st.tUs, seg.duration);
        if (this.rasters.size > 400) for (const k of [...this.rasters.keys()]) if (k.startsWith("g:") && !k.endsWith(":assets")) this.rasters.delete(k);
        this.rasters.set(key, c);
      }
      return { img: c, w: c.width, h: c.height, sw: c.width, sh: c.height };
    }
    if (seg.kind === "text" && seg.text?.caption) {
      // Word-timed caption: the state (spoken word, pop) at the playhead, drawn like the export draws it.
      const base = `c:${JSON.stringify(seg.text)}:${seg.duration}:${W}x${H}`;
      const st = captionStateAt(seg.text, seg.duration, this.ed.tl().fps || 30, this.timeUs - seg.start);
      const key = `${base}:${stateKey(st)}`;
      let c = this.rasters.get(key);
      if (c === undefined) {
        let L = this.rasters.get(`${base}:L`);
        if (!L) { L = captionLayout(seg.text, W, H); this.rasters.set(`${base}:L`, L); }
        c = captionCanvas(seg.text, W, H, st, L);
        if (this.rasters.size > 400) for (const k of [...this.rasters.keys()]) if (k.startsWith("c:")) this.rasters.delete(k); // bound the cache
        this.rasters.set(key, c);
      }
      return { img: c, w: c.width, h: c.height, sw: c.width, sh: c.height };
    }
    if (seg.kind === "text") {
      const key = `t:${JSON.stringify(seg.text)}:${W}x${H}`;
      let c = this.rasters.get(key);
      if (c === undefined) { c = rasterText(seg.text, W, H); this.rasters.set(key, c); }
      return c ? { img: c, w: c.width, h: c.height, sw: c.width, sh: c.height } : null;
    }
    if (seg.kind === "sticker") {
      const key = `s:${stickerSrc(seg.sticker)}:${W}x${H}`;
      const c = this.rasters.get(key);
      if (c === undefined) { this.rasters.set(key, null); rasterSticker(seg.sticker, W, H).then((x) => { this.rasters.set(key, x); this.invalidate(); }).catch(() => {}); return null; }
      return c ? { img: c, w: c.width, h: c.height, sw: c.width, sh: c.height } : null;
    }
    let img, sw, sh;
    if (seg.kind === "image") {
      const m = this.ed.media(seg.mediaId);
      if (!m) return null;
      img = this.image(mediaUrl(m.id));
      if (!img) return null;
      sw = img.naturalWidth; sh = img.naturalHeight;
    } else {
      const v = this.videos.get(seg.id) || this.mediaElement(this.videos, seg, "video");
      if (!v || v.failed || v.el.readyState < 2) return null;
      img = v.el; sw = img.videoWidth; sh = img.videoHeight;
    }
    if (!sw || !sh) return null;
    const c = seg.crop || { x: 0, y: 0, w: 1, h: 1 };
    const cw = sw * (c.w ?? 1), ch = sh * (c.h ?? 1);
    const fit = Math.min(W / cw, H / ch);
    return { img, sx: sw * (c.x || 0), sy: sh * (c.y || 0), sw: cw, sh: ch, w: cw * fit, h: ch * fit };
  }

  drawBlurBackground(seg) {
    if (!["video", "image", "compound"].includes(seg.kind)) return;
    const s = this.source(seg);
    if (!s) return;
    const g = this.ctx, W = this.W, H = this.H;
    const k = Math.max(W / s.sw, H / s.sh);
    g.save();
    g.filter = `blur(${((8 + (this.ed.tl().canvas.bgBlur || 50) / 4) * W / 1920 * 2).toFixed(1)}px)`;
    g.drawImage(s.img, s.sx || 0, s.sy || 0, s.sw, s.sh, (W - s.sw * k) / 2, (H - s.sh * k) / 2, s.sw * k, s.sh * k);
    g.restore();
  }

  drawLayer(seg, t, tr) {
    const s = this.source(seg);
    if (!s) return;
    const W = this.W, H = this.H;
    const st = layerState(NUM, seg, (t - seg.start) / US, { W, H, transIn: tr.transIn, transOut: tr.transOut });
    const lw = Math.max(1, s.w * st.scaleX), lh = Math.max(1, s.h * st.scaleY);
    // Render the layer "look" (grade, effects, keying, mask) on an offscreen canvas at its on-screen size.
    const off = this.layerCanvas(seg, s, lw, lh, t);
    if (!off) return; // a cutout whose person matte is not loaded yet
    const g = this.ctx;
    g.save();
    g.globalAlpha = st.opacity;
    g.globalCompositeOperation = BLEND[seg.transform?.blend] || "source-over";
    g.translate(W / 2 + st.x, H / 2 + st.y);
    g.rotate((st.rotation * Math.PI) / 180);
    g.scale(seg.transform?.flipH ? -1 : 1, seg.transform?.flipV ? -1 : 1);
    g.drawImage(off, -lw / 2, -lh / 2, lw, lh);
    g.restore();
    if (!seg.cutout) seg._box = { cx: W / 2 + st.x, cy: H / 2 + st.y, w: lw, h: lh, rot: st.rotation }; // for hit-testing / handles
  }

  layerCanvas(seg, s, lw, lh, t) {
    const matte = seg.kind === "video" && seg.videoFx?.matte?.type === "person" ? this.matteFrame(seg, s) : null;
    if (seg.kind === "video" && seg.videoFx?.matte?.type === "person" && !matte) return null;
    const needsLook = (seg.adjust && seg.adjust.enabled !== false && !isDefaultAdjust(seg.adjust)) || seg.clipEffects?.length || seg.videoFx?.chroma?.enabled || (seg.videoFx?.mask && seg.videoFx.mask.type !== "none") || !!matte;
    const cw = Math.max(1, Math.min(Math.round(lw), this.W * 2)), ch = Math.max(1, Math.min(Math.round(lh), this.H * 2));
    if (!needsLook && !(s.sx || s.sy || s.sw !== s.img.width)) {
      if (s.img instanceof HTMLCanvasElement) return s.img;
    }
    if (!this.scratch) this.scratch = document.createElement("canvas");
    const c = this.scratch.width === cw && this.scratch.height === ch ? this.scratch : Object.assign(this.scratch, { width: cw, height: ch });
    const g = c.getContext("2d", { willReadFrequently: true });
    g.clearRect(0, 0, cw, ch);
    g.drawImage(s.img, s.sx || 0, s.sy || 0, s.sw, s.sh, 0, 0, cw, ch);
    if (needsLook) {
      const proc = seg.adjust ? this.processor(seg.adjust, cw, ch) : null;
      const fx = seg.videoFx;
      if (proc || fx?.chroma?.enabled) {
        const data = g.getImageData(0, 0, cw, ch);
        if (proc) proc(data.data);
        if (fx?.chroma?.enabled) chromaKey(data.data, fx.chroma);
        g.putImageData(data, 0, 0);
      }
      for (const ce of seg.clipEffects || []) applyEffect(g, c, ce.type, ce.intensity ?? 50, (t - seg.start) / US);
      if (fx?.mask && fx.mask.type !== "none") applyMask(g, cw, ch, fx.mask);
      if (matte) { // keep only the person: the matte's alpha over the same source region
        g.save();
        g.globalCompositeOperation = "destination-in";
        g.drawImage(matte.canvas, matte.sx, matte.sy, matte.sw, matte.sh, 0, 0, cw, ch);
        g.restore();
      }
    }
    // Return a copy so the next layer can reuse the scratch canvas.
    const out = document.createElement("canvas");
    out.width = cw; out.height = ch;
    out.getContext("2d").drawImage(c, 0, 0);
    return out;
  }

  gradeComposite(seg, t) {
    const g = this.ctx, W = this.W, H = this.H;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (seg.kind === "effect") { applyEffect(g, this.canvas, seg.effect?.type, seg.effect?.intensity ?? 50, (t - seg.start) / US); return; }
    const adjust = seg.kind === "filter" ? applyFilterPreset(null, seg.filter?.preset, seg.filter?.intensity ?? 100) : seg.adjust;
    const proc = this.processor(adjust, W, H);
    if (!proc) return;
    const data = g.getImageData(0, 0, W, H);
    proc(data.data);
    g.putImageData(data, 0, 0);
  }

  // ------------------------------------------------------------------ selection overlay & direct manipulation
  drawOverlay() {
    const g = this.octx, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    if (this.guides || this.ed.settings().edit.previewAxis) {
      g.strokeStyle = "rgba(0,193,205,.5)"; g.setLineDash([6, 6]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); g.setLineDash([]);
      if (this.guides) { g.strokeStyle = "rgba(255,255,255,.25)"; g.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9); }
    }
    const sel = this.selectedVisual();
    if (!sel?._box || this.playing) return;
    const b = sel._box;
    g.save();
    g.translate(b.cx, b.cy); g.rotate((b.rot * Math.PI) / 180);
    g.strokeStyle = "#fff"; g.lineWidth = 1.5;
    g.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
    g.fillStyle = "#fff";
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.arc((x * b.w) / 2, (y * b.h) / 2, 5, 0, Math.PI * 2); g.fill(); }
    g.beginPath(); g.arc(0, -b.h / 2 - 22, 6, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(0, -b.h / 2); g.lineTo(0, -b.h / 2 - 16); g.stroke();
    g.restore();
  }
  selectedVisual() {
    const ids = this.ed.selection();
    if (ids.length !== 1) return null;
    const s = this.findSeg(ids[0]);
    return s && VISUAL.has(s.kind) && this.timeUs >= s.start && this.timeUs < s.start + s.duration ? s : null;
  }
  toCanvas(e) { const r = this.overlay.getBoundingClientRect(); return { x: ((e.clientX - r.left) * this.W) / r.width, y: ((e.clientY - r.top) * this.H) / r.height }; }
  local(p, b) { const a = (-b.rot * Math.PI) / 180, dx = p.x - b.cx, dy = p.y - b.cy; return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) }; }

  hitTest(e) {
    const p = this.toCanvas(e);
    const tl = this.ed.tl();
    const tracks = [...tl.tracks].sort((a, b) => b.order - a.order);
    for (const tr of tracks) {
      if (tr.hidden || tr.locked) continue;
      for (const s of tr.segments) {
        if (!VISUAL.has(s.kind) || !s._box || s.disabled || this.timeUs < s.start || this.timeUs >= s.start + s.duration) continue;
        const q = this.local(p, s._box);
        if (Math.abs(q.x) <= s._box.w / 2 && Math.abs(q.y) <= s._box.h / 2) return s;
      }
    }
    return null;
  }

  onPointerDown(e) {
    if (this.playing) return;
    const p = this.toCanvas(e);
    let seg = this.selectedVisual();
    let mode = null;
    if (seg?._box) {
      const b = seg._box, q = this.local(p, b);
      if (Math.hypot(q.x, q.y + b.h / 2 + 22) < 12) mode = "rotate";
      else if ([[-1, -1], [1, -1], [1, 1], [-1, 1]].some(([x, y]) => Math.hypot(q.x - (x * b.w) / 2, q.y - (y * b.h) / 2) < 10)) mode = "scale";
      else if (Math.abs(q.x) <= b.w / 2 && Math.abs(q.y) <= b.h / 2) mode = "move";
    }
    if (!mode) {
      const hit = this.hitTest(e);
      this.ed.select(hit ? [hit.id] : []);
      if (!hit) return;
      seg = hit; mode = "move";
    }
    if (this.ed.isLocked(seg.id)) return;
    const tr0 = { ...seg.transform };
    const start = { p, box: { ...seg._box }, tr: tr0 };
    this.overlay.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const q = this.toCanvas(ev);
      const patch = {};
      if (mode === "move") {
        let nx = tr0.x + (q.x - start.p.x) / this.W, ny = tr0.y + (q.y - start.p.y) / this.H;
        if (Math.abs(nx) < 0.01) nx = 0; // snap to centre axis
        if (Math.abs(ny) < 0.01) ny = 0;
        patch.x = Number(nx.toFixed(4)); patch.y = Number(ny.toFixed(4));
      } else if (mode === "scale") {
        const d0 = Math.hypot(start.p.x - start.box.cx, start.p.y - start.box.cy), d1 = Math.hypot(q.x - start.box.cx, q.y - start.box.cy);
        patch.scale = Number(clamp((tr0.scale ?? 1) * (d1 / Math.max(1, d0)), 0.01, 50).toFixed(4));
      } else {
        const a0 = Math.atan2(start.p.y - start.box.cy, start.p.x - start.box.cx), a1 = Math.atan2(q.y - start.box.cy, q.x - start.box.cx);
        let r = (tr0.rotation || 0) + ((a1 - a0) * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        patch.rotation = Number(r.toFixed(2));
      }
      Object.assign(seg.transform, patch);
      this.invalidate();
      this.ed.onTransform(seg.id, { ...patch }, false);
    };
    const up = () => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", up);
      const changed = ["x", "y", "scale", "rotation"].filter((k) => seg.transform[k] !== tr0[k]);
      if (changed.length) this.ed.onTransform(seg.id, Object.fromEntries(changed.map((k) => [k, seg.transform[k]])), true);
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", up);
  }

  /** Current frame as a PNG data URL (cover / still frame preview). */
  snapshot() { return this.canvas.toDataURL("image/png"); }
}

// ---------------------------------------------------------------- preview effects (approximations of presets.js)
function chromaKey(px, c) {
  const n = parseInt((c.color || "#00FF00").slice(1, 7), 16);
  const kr = (n >> 16) & 255, kg = (n >> 8) & 255, kb = n & 255;
  const sim = (0.01 + c.intensity / 250) * 441, blend = (c.shadow / 200 + 0.02) * 441;
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.hypot(px[i] - kr, px[i + 1] - kg, px[i + 2] - kb);
    if (d < sim) px[i + 3] = 0;
    else if (d < sim + blend) px[i + 3] = Math.round(px[i + 3] * ((d - sim) / blend));
  }
}

function applyMask(g, w, hh, m) {
  const cx = w / 2 + (m.x * w) / 2, cy = hh / 2 + (m.y * hh) / 2;
  const fe = Math.max(0.001, m.feather / 100) * Math.min(w, hh);
  const mask = document.createElement("canvas");
  mask.width = w; mask.height = hh;
  const mg = mask.getContext("2d");
  mg.filter = fe > 1 ? `blur(${fe / 2}px)` : "none";
  mg.fillStyle = "#fff";
  if (m.type === "circle") { mg.beginPath(); mg.ellipse(cx, cy, (m.w * w) / 2, (m.h * hh) / 2, (m.rotation * Math.PI) / 180, 0, Math.PI * 2); mg.fill(); }
  else if (m.type === "linear") { mg.fillRect(0, cy, w, hh - cy); }
  else { mg.save(); mg.translate(cx, cy); mg.rotate((m.rotation * Math.PI) / 180); mg.fillRect((-m.w * w) / 2, (-m.h * hh) / 2, m.w * w, m.h * hh); mg.restore(); }
  g.save();
  g.globalCompositeOperation = m.invert ? "destination-out" : "destination-in";
  g.drawImage(mask, 0, 0);
  g.restore();
}

export function applyEffect(g, canvas, type, k, tSec) {
  const w = canvas.width, hh = canvas.height;
  const copy = () => { const c = document.createElement("canvas"); c.width = w; c.height = hh; c.getContext("2d").drawImage(canvas, 0, 0); return c; };
  const filt = (f) => { const c = copy(); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, hh); g.filter = f; g.drawImage(c, 0, 0); g.restore(); };
  switch (type) {
    case "blur": filt(`blur(${((0.5 + k * 0.2) * w) / 960}px)`); break;
    case "mono": filt("grayscale(1)"); break;
    case "sepia": filt(`sepia(${k / 100})`); break;
    case "invert": filt("invert(1)"); break;
    case "old_film": filt(`sepia(0.8) contrast(1.05)`); grain(g, w, hh, k / 3); vignette(g, w, hh, 0.6); break;
    case "noise": grain(g, w, hh, k / 2); break;
    case "vignette": vignette(g, w, hh, 0.2 + k * 0.008); break;
    case "edge": filt("grayscale(1) contrast(3) invert(1)"); break;
    case "glow": { const c = copy(); g.save(); g.globalCompositeOperation = "screen"; g.globalAlpha = k / 150; g.filter = `blur(${((4 + k / 10) * w) / 960}px)`; g.drawImage(c, 0, 0); g.restore(); break; }
    case "letterbox": { const bh = hh * (0.04 + k * 0.0012); g.save(); g.fillStyle = "#000"; g.fillRect(0, 0, w, bh); g.fillRect(0, hh - bh, w, bh); g.restore(); break; }
    case "flash": { const a = (k / 120) * Math.max(0, 1 - Math.abs(Math.sin(Math.PI * tSec * 2))); g.save(); g.fillStyle = `rgba(255,255,255,${a})`; g.fillRect(0, 0, w, hh); g.restore(); break; }
    case "mirror": { const c = copy(); g.save(); g.translate(w, 0); g.scale(-1, 1); g.drawImage(c, w / 2, 0, w / 2, hh, 0, 0, w / 2, hh); g.restore(); break; }
    case "pixelate": { const c = copy(); const n = 4 + Math.round(k / 4); const sw = Math.max(1, Math.round(w / n)), sh = Math.max(1, Math.round(hh / n)); const s = document.createElement("canvas"); s.width = sw; s.height = sh; s.getContext("2d").drawImage(c, 0, 0, sw, sh); g.save(); g.imageSmoothingEnabled = false; g.clearRect(0, 0, w, hh); g.drawImage(s, 0, 0, w, hh); g.restore(); break; }
    case "rgb_split": { const c = copy(); const d = ((k / 8) * w) / 960; g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.5; g.drawImage(c, d, 0); g.drawImage(c, -d, 0); g.restore(); break; }
    case "shake": { const c = copy(); const a = k / 100; g.save(); g.clearRect(0, 0, w, hh); g.drawImage(c, w * 0.03 * a * Math.sin(2 * Math.PI * tSec * 9), hh * 0.03 * a * Math.cos(2 * Math.PI * tSec * 7)); g.restore(); break; }
    case "zoom_pulse": { const c = copy(); const z = 1 + (k / 400) * Math.abs(Math.sin(Math.PI * tSec)); g.save(); g.clearRect(0, 0, w, hh); g.drawImage(c, (w - w * z) / 2, (hh - hh * z) / 2, w * z, hh * z); g.restore(); break; }
    default: break;
  }
}
function grain(g, w, hh, amt) {
  const d = g.getImageData(0, 0, w, hh), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const n = (Math.random() - 0.5) * amt * 2; p[i] += n; p[i + 1] += n; p[i + 2] += n; }
  g.putImageData(d, 0, 0);
}
function vignette(g, w, hh, angle) {
  const r = Math.hypot(w, hh) / 2;
  const grd = g.createRadialGradient(w / 2, hh / 2, r * Math.max(0.05, 1 - angle), w / 2, hh / 2, r);
  grd.addColorStop(0, "rgba(0,0,0,0)"); grd.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, angle)})`);
  g.save(); g.fillStyle = grd; g.fillRect(0, 0, w, hh); g.restore();
}
