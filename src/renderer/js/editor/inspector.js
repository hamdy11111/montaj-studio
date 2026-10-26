// Inspector / Details panel (SCREEN-029..039): properties of the selected clip by kind, or the Project panel
// (details, canvas, smart suggestions, global edits) when nothing is selected. Slider drags update the preview
// live and commit one undoable change on release; values with keyframes write keyframes at the playhead.
import { BUNDLED_FAMILIES, SYSTEM_FONTS } from "../../core/fonts.js";
import { h, mount, clear } from "../dom.js";
import { icon } from "../icons.js";
import { t, getLang } from "../i18n.js";
import { call, guard, mediaUrl, thumbUrl } from "../api.js";
import { modal } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { slider, toggle, select, segmented, colorInput, section, check } from "../ui/controls.js";
import { US, formatDuration, clamp } from "../../core/util.js";
import { ANIMATIONS_IN, ANIMATIONS_OUT, ANIMATIONS_COMBO, EASINGS } from "../../core/layerMath.js";
import { CURVE_PRESETS, VELOCITY_EFFECTS, SPEED_MIN, SPEED_MAX } from "../../core/speed.js";
import { FILTER_PRESETS, EFFECTS, TEXT_PRESETS, VOICE_CHANGERS } from "../../core/presets.js";
import { GRAPHIC_TEMPLATES, EMOJI_ALIASES, graphicParams } from "../../core/graphics.js";
import { canGoBehind } from "../../core/cutout.js";
import { duckDbOf, DUCK_DEFAULT_DB } from "../../core/musicBed.js";
import { HSL_CHANNELS, DEFAULT_ADJUST, DEFAULT_TRANSFORM, DEFAULT_VIDEO_FX, DEFAULT_AUDIO_FX, CANVAS_RATIOS, FPS_OPTIONS } from "../../core/model.js";

const FONTS = [...BUNDLED_FAMILIES, ...SYSTEM_FONTS];
// Arabic names of the motion-graphics parameters (core/graphics.js keeps the English titles for agents).
const PARAM_AR = { text: "النص", title: "العنوان", subtitle: "العنوان الفرعي", font: "الخط", color: "لون النص", color2: "اللون السفلي (تدرّج)", accent: "اللون المميّز",
  position: "الموضع", size: "الحجم", x: "الموضع الأفقي", y: "الموضع الرأسي", width: "العرض", w: "العرض", h: "الارتفاع", style: "النمط", emoji: "إيموجي", icon: "أيقونة",
  items: "البنود (سطر لكل بند)", checked: "عدد المنجز", number: "الرقم", label: "التسمية", from: "من", to: "إلى", prefix: "قبل الرقم", suffix: "بعد الرقم",
  decimals: "الأرقام العشرية", author: "القائل", motion: "الحركة", side: "الجهة", box: "خلفية مصمتة", thickness: "السُمك",
  // The graphics kit's parameters (phase 3).
  words: "الكلمات (سطر لكل كلمة)", times: "توقيت كل كلمة (ملي ثانية؛ فاضي = بالتساوي)", direction: "الاتجاه", corner: "المكان", hi: "الجزء الأصفر",
  rot: "الميل (°)", motionBlur: "ضبابية الحركة عند النزول", word: "كلمة (اختياري)", l1: "السطر الأول", l2: "السطر التاني (أصفر)", kicker: "الشريط",
  sub: "وصف في سطر", left: "الشخص على الشمال (صورة مقصوصة)", right: "الشخص على اليمين (صورة مقصوصة)", src: "الصورة أو الملف", cutout: "صورة مقصوصة على لون",
  bg: "لون الخلفية", badge: "إيموجي الشارة", tag: "وسم صغير", still: "الفريم المتجمّد", stills: "الصور (سطر لكل صورة)", n: "عدد القطع", cx: "المركز أفقيًا",
  cy: "المركز رأسيًا", name: "الاسم", role: "الصفة", arrow: "السهم", lines: "السطور", hotLast: "آخر سطر أحمر", swapAt: "التبديل عند (ملي ثانية)",
  dec: "الأرقام العشرية", rollMs: "مدة الدوران (ملي ثانية)", unit: "الوحدة", kind: "النوع", value: "القيمة", max: "الهدف", prev: "القيمة السابقة",
  pos: "المكان", done: "اتحقق", pulse: "نبضة عند (ملي ثانية، ‎-1 = مفيش)", dim: "تغميق الفيديو", cols: "الأعمدة (0 = تلقائي)", leftLabel: "اسم الشمال",
  leftValue: "قيمة الشمال (%)", rightLabel: "اسم اليمين", rightValue: "قيمة اليمين (%)", prevL: "الشمال قبل", prevR: "اليمين قبل", fadeMs: "الظهور التدريجي (ملي ثانية)",
  mode: "طريقة الظهور", emphasis: "كلمات أكبر", weight: "التخانة", type: "العلامة", strokeWidth: "سُمك الخط", x1: "من (أفقي)", y1: "من (رأسي)",
  x2: "إلى (أفقي)", y2: "إلى (رأسي)", bend: "الانحناء", shape: "الشكل", textColor: "لون الكتابة", before: "قبل", after: "بعد", transition: "الانتقال" };
// Graphics parameters that name a picture or a file: a picker (project media or a file) next to the text field.
const MEDIA_PARAMS = new Set(["src", "still", "stills", "left", "right"]);
const HSL_SWATCH = { red: "#e5484d", orange: "#f76b15", yellow: "#ffd400", green: "#30a46c", cyan: "#00c1cd", blue: "#3e63dd", purple: "#8e4ec6", magenta: "#d6409f" };

export class Inspector {
  constructor(host, ed) {
    this.ed = ed;
    this.tab = {};
    this.tabsEl = h("div", { class: "insp-tabs" });
    this.body = h("div", { class: "insp-body" });
    this.el = h("div", { class: "inspector" }, this.tabsEl, this.body);
    host.append(this.el);
  }

  render() {
    const ed = this.ed;
    const ids = ed.selection();
    clear(this.tabsEl); clear(this.body);
    if (ids.length > 1) return this.multi(ids);
    const seg = ids.length ? ed.segment(ids[0]) : null;
    if (!seg) return this.projectPanel();
    const track = ed.trackOf(seg.id);
    const tabs = this.tabsFor(seg);
    const cur = tabs.includes(this.tab[seg.kind]) ? this.tab[seg.kind] : tabs[0];
    mount(this.tabsEl, ...tabs.map((x) => h("button", { class: x === cur ? "active" : "", onclick: () => { this.tab[seg.kind] = x; this.render(); } }, t(`in.${x}`))));
    if (track?.locked) this.body.append(h("div", { class: "banner" }, icon("lock"), t("err.trackLocked")));
    const fn = { video: this.videoTab, audio: this.audioTab, speed: this.speedTab, animation: this.animationTab, adjust: this.adjustTab, text: this.textTab, tts: this.ttsTab, effect: this.effectTab, filter: this.filterTab, sticker: this.videoTab }[cur];
    fn.call(this, seg);
  }

  tabsFor(seg) {
    const m = seg.mediaId ? this.ed.media(seg.mediaId) : null;
    switch (seg.kind) {
      case "video": return ["video", ...(m?.hasAudio && !seg.audioDetached ? ["audio"] : []), "speed", "animation", "adjust"];
      case "compound": return ["video", "audio", "speed", "animation", "adjust"];
      case "image": return ["video", "animation", "adjust"];
      case "audio": return ["audio", "speed"];
      case "text": return ["text", "animation", "tts"];
      case "sticker": return ["sticker", "animation"];
      case "effect": return ["effect"];
      case "filter": return ["filter"];
      case "adjust": return ["adjust"];
      default: return ["video"];
    }
  }

  // ------------------------------------------------------------------ helpers
  /** Live preview while dragging; commit on release with one history entry. */
  bind(seg, build, { coalesce } = {}) {
    return {
      onInput: (v) => { this.ed.patchLive(seg.id, build(v)); },
      onChange: (v) => { this.ed.exec("updateSegment", { segId: seg.id, patch: build(v), coalesceKey: coalesce }); },
    };
  }
  local(seg) { return clamp(this.ed.playhead() - seg.start, 0, seg.duration); }
  kfAt(seg, prop) { const fr = US / (this.ed.tl().fps || 30); const l = this.local(seg); return (seg.keyframes || []).find((k) => k.prop === prop && Math.abs(k.timeUs - l) < fr / 2); }
  hasKf(seg, prop) { return (seg.keyframes || []).some((k) => k.prop === prop); }

  /** Keyframe diamond for prop: add at playhead (current value) or remove the one under the playhead. */
  kfButton(seg, prop, current) {
    const at = this.kfAt(seg, prop);
    const inside = this.ed.playhead() >= seg.start && this.ed.playhead() <= seg.start + seg.duration;
    return h("button", { class: ["kf-btn", at && "on", this.hasKf(seg, prop) && "has"], disabled: !inside, title: at ? t("in.removeKeyframe") : t("in.addKeyframe"), "aria-label": at ? t("in.removeKeyframe") : t("in.addKeyframe"),
      onclick: () => (at ? this.ed.exec("removeKeyframe", { segId: seg.id, keyframeId: at.id }) : this.ed.exec("addKeyframe", { segId: seg.id, prop, timeUs: this.local(seg), value: current() })) }, icon("keyframe"));
  }

  /** Slider for a keyframeable transform/volume prop. toModel/fromModel convert display ↔ stored units. */
  kfSlider(seg, prop, label, o) {
    const stored = o.get();
    const ctl = slider({
      label, min: o.min, max: o.max, step: o.step || 1, value: o.fromModel(stored), unit: o.unit,
      keyframe: this.kfButton(seg, prop, () => o.get()),
      onInput: (v) => { if (!this.hasKf(seg, prop)) this.ed.patchLive(seg.id, o.patch(o.toModel(v))); },
      onChange: (v) => {
        if (this.hasKf(seg, prop)) this.ed.exec("addKeyframe", { segId: seg.id, prop, timeUs: this.local(seg), value: o.toModel(v) });
        else this.ed.exec("updateSegment", { segId: seg.id, patch: o.patch(o.toModel(v)), coalesceKey: prop });
      },
    });
    return ctl;
  }

  // ------------------------------------------------------------------ video / image / sticker
  videoTab(seg) {
    const ed = this.ed, tr = { ...DEFAULT_TRANSFORM, ...seg.transform };
    const tl = ed.tl(), W = tl.canvas.width, H = tl.canvas.height;
    const kfv = (prop) => { const k = (seg.keyframes || []).filter((x) => x.prop === prop); if (!k.length) return null; const at = this.kfAt(seg, prop); return at ? at.value : null; };
    const transform = section({ title: t("in.transform"), onReset: () => ed.exec("updateSegment", { segId: seg.id, patch: { transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, uniform: true, rotation: 0, flipH: false, flipV: false } } }), children: [
      this.kfSlider(seg, "scale", t("in.scale"), { min: 1, max: 500, unit: "%", get: () => kfv("scale") ?? tr.scale, fromModel: (v) => Math.round(v * 100), toModel: (v) => v / 100, patch: (v) => ({ transform: { scale: v } }) }),
      h("div", { class: "row" }, check({ checked: tr.uniform !== false, label: t("in.uniformScale"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { transform: { uniform: v } } }) })),
      tr.uniform === false ? slider({ label: "X", min: 1, max: 500, value: Math.round((tr.scaleX ?? 1) * 100), unit: "%", ...this.bind(seg, (v) => ({ transform: { scaleX: v / 100 } }), { coalesce: "scaleX" }) }) : null,
      tr.uniform === false ? slider({ label: "Y", min: 1, max: 500, value: Math.round((tr.scaleY ?? 1) * 100), unit: "%", ...this.bind(seg, (v) => ({ transform: { scaleY: v / 100 } }), { coalesce: "scaleY" }) }) : null,
      this.kfSlider(seg, "x", `${t("in.position")} X`, { min: -W * 2, max: W * 2, unit: "px", get: () => kfv("x") ?? tr.x, fromModel: (v) => Math.round(v * W), toModel: (v) => Number((v / W).toFixed(5)), patch: (v) => ({ transform: { x: v } }) }),
      this.kfSlider(seg, "y", `${t("in.position")} Y`, { min: -H * 2, max: H * 2, unit: "px", get: () => kfv("y") ?? tr.y, fromModel: (v) => Math.round(v * H), toModel: (v) => Number((v / H).toFixed(5)), patch: (v) => ({ transform: { y: v } }) }),
      this.kfSlider(seg, "rotation", t("in.rotate"), { min: -360, max: 360, unit: "°", get: () => kfv("rotation") ?? tr.rotation, fromModel: (v) => Math.round(v), toModel: (v) => v, patch: (v) => ({ transform: { rotation: v } }) }),
      h("div", { class: "row" },
        h("button", { class: ["btn small", tr.flipH && "active-btn"], onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: { transform: { flipH: !tr.flipH } } }) }, icon("mirror"), "↔"),
        h("button", { class: ["btn small", tr.flipV && "active-btn"], onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: { transform: { flipV: !tr.flipV } } }) }, icon("mirror"), "↕"),
        h("button", { class: "btn small", onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: { transform: { rotation: ((tr.rotation || 0) + 90) % 360 } } }) }, icon("rotate"), "90°")),
      this.kfButtonsRow(seg),
    ] });
    const blend = section({ title: t("in.blend"), children: [
      h("div", { class: "row" }, h("span", { class: "muted" }, t("in.blendMode")), select({ value: tr.blend || "normal", options: ["normal", "screen", "add", "multiply", "darken", "lighten"], onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { transform: { blend: v } } }) })),
      this.kfSlider(seg, "opacity", t("in.opacity"), { min: 0, max: 100, unit: "%", get: () => kfv("opacity") ?? tr.opacity, fromModel: (v) => Math.round(v * 100), toModel: (v) => v / 100, patch: (v) => ({ transform: { opacity: v } }) }),
    ] });
    const parts = [this.jlSection(seg), transform, blend].filter(Boolean);
    if (["video", "image", "compound"].includes(seg.kind)) {
      const fx = { ...DEFAULT_VIDEO_FX, ...(seg.videoFx || {}) };
      const isMain = ed.trackOf(seg.id)?.isMain;
      if (isMain) parts.push(this.canvasSection());
      parts.push(
        section({ title: t("in.crop"), children: this.cropControls(seg) }),
        // A stabilized copy of the video is made once (two-pass, 0.75 s smoothing) and used by preview and export.
        section({ title: t("in.stabilize"), enabled: fx.stabilize.enabled, onToggle: (v) => ed.stabilize(seg.id, v), open: false, children: [] }),
        section({ title: t("in.denoise"), enabled: fx.denoise.enabled, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { videoFx: { denoise: { enabled: v } } } }), open: fx.denoise.enabled, children: [
          slider({ label: t("in.intensity"), min: 0, max: 100, value: fx.denoise.level, ...this.bind(seg, (v) => ({ videoFx: { denoise: { level: v, enabled: true } } }), { coalesce: "denoise" }) })] }),
        section({ title: t("in.motionBlur"), enabled: fx.motionBlur.enabled, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { videoFx: { motionBlur: { enabled: v } } } }), open: fx.motionBlur.enabled, children: [
          slider({ label: t("in.intensity"), min: 2, max: 10, value: fx.motionBlur.amount, ...this.bind(seg, (v) => ({ videoFx: { motionBlur: { amount: v, enabled: true } } }), { coalesce: "mblur" }) })] }),
        section({ title: `${t("in.removeBg")} · ${t("in.chroma")}`, enabled: fx.chroma.enabled, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { videoFx: { chroma: { enabled: v } } } }), open: fx.chroma.enabled, children: [
          h("div", { class: "row" }, h("span", { class: "muted" }, t("in.color")), colorInput({ value: fx.chroma.color, onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { videoFx: { chroma: { color: v, enabled: true } } } }) }),
            h("button", { class: "btn small", title: "Pick from player", onclick: () => ed.pickColor((c) => ed.exec("updateSegment", { segId: seg.id, patch: { videoFx: { chroma: { color: c, enabled: true } } } })) }, icon("wand"))),
          slider({ label: t("in.intensity"), min: 0, max: 100, value: fx.chroma.intensity, ...this.bind(seg, (v) => ({ videoFx: { chroma: { intensity: v, enabled: true } } }), { coalesce: "chromaI" }) }),
          slider({ label: t("in.shadow"), min: 0, max: 100, value: fx.chroma.shadow, ...this.bind(seg, (v) => ({ videoFx: { chroma: { shadow: v, enabled: true } } }), { coalesce: "chromaS" }) }),
          h("div", { class: "muted small" }, `${t("in.autoRemoval")}: ${t("c.notAvailable")}`)] }),
        this.maskSection(seg, fx.mask),
        this.clipEffectsSection(seg));
    }
    if (seg.kind === "compound") parts.push(section({ title: t("in.compound"), children: [h("div", { class: "row" }, h("span", { class: ["badge", ed.compoundReady(seg.compoundTimelineId) ? "local" : "na"] }, ed.compoundReady(seg.compoundTimelineId) ? t("in.preprocessed") : t("err.compoundNotRendered")), h("button", { class: "btn small", onclick: () => ed.run("preprocessCompound") }, t("in.preprocess")))] }));
    if (seg.kind !== "sticker") parts.push(h("button", { class: "btn block", onclick: () => ed.exec("applyToAll", { segId: seg.id, key: "transform" }).then((r) => r && toast(t("c.done"), "success")) }, t("in.applyAll")));
    this.body.append(...parts);
  }

  kfButtonsRow(seg) {
    const ks = seg.keyframes || [];
    if (!ks.length) return null;
    const at = ks.filter((k) => Math.abs(k.timeUs - this.local(seg)) < US / 60);
    return h("div", { class: "row" }, h("span", { class: "muted" }, `${t("in.keyframes")}: ${ks.length}`), h("span", { class: "grow" }),
      select({ value: at[0]?.easing || "linear", options: EASINGS.map((e) => ({ value: e, label: e })), label: t("in.easing"), onChange: (v) => this.ed.exec("setKeyframeEasing", { segId: seg.id, keyframeId: at[0]?.id || null, easing: v }) }));
  }

  cropControls(seg) {
    const c = { x: 0, y: 0, w: 1, h: 1, ...(seg.crop || {}) };
    const set = (patch) => { const n = { ...c, ...patch }; n.w = clamp(n.w, 0.05, 1 - n.x); n.h = clamp(n.h, 0.05, 1 - n.y); return { crop: n }; };
    return [
      slider({ label: "X", min: 0, max: 95, value: Math.round(c.x * 100), unit: "%", ...this.bind(seg, (v) => set({ x: v / 100 }), { coalesce: "cropx" }) }),
      slider({ label: "Y", min: 0, max: 95, value: Math.round(c.y * 100), unit: "%", ...this.bind(seg, (v) => set({ y: v / 100 }), { coalesce: "cropy" }) }),
      slider({ label: "W", min: 5, max: 100, value: Math.round(c.w * 100), unit: "%", ...this.bind(seg, (v) => set({ w: v / 100 }), { coalesce: "cropw" }) }),
      slider({ label: "H", min: 5, max: 100, value: Math.round(c.h * 100), unit: "%", ...this.bind(seg, (v) => set({ h: v / 100 }), { coalesce: "croph" }) }),
      h("div", { class: "row" }, ...[["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3]].map(([l, r]) => h("button", { class: "btn small", onclick: () => {
        const m = this.ed.media(seg.mediaId); const ar = (m?.width || 16) / (m?.height || 9);
        let w = 1, hh = 1; if (r > ar) hh = ar / r; else w = r / ar;
        this.ed.exec("updateSegment", { segId: seg.id, patch: { crop: { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh } } });
      } }, l)), h("button", { class: "btn small ghost", onclick: () => this.ed.exec("updateSegment", { segId: seg.id, patch: { crop: { x: 0, y: 0, w: 1, h: 1 } } }) }, t("in.reset"))),
    ];
  }

  canvasSection() {
    const ed = this.ed, cv = ed.tl().canvas;
    return section({ title: t("in.canvas"), children: [
      segmented({ value: cv.bgType, options: [{ value: "color", label: t("in.canvasColor") }, { value: "blur", label: t("in.canvasBlur") }], onChange: (v) => ed.exec("setCanvas", { bgType: v }) }),
      cv.bgType === "color" ? h("div", { class: "row" }, colorInput({ value: cv.bgColor, onChange: (v) => ed.exec("setCanvas", { bgColor: v }) }), ...["#000000", "#FFFFFF", "#1A5F64", "#9C4937", "#47418B"].map((c) => h("button", { class: "swatch", style: { background: c }, "aria-label": c, onclick: () => ed.exec("setCanvas", { bgColor: c }) })))
        : slider({ label: t("in.intensity"), min: 0, max: 100, value: cv.bgBlur || 50, onChange: (v) => ed.exec("setCanvas", { bgBlur: v }) }),
    ] });
  }

  maskSection(seg, mask) {
    const ed = this.ed, m = { ...DEFAULT_VIDEO_FX.mask, ...mask };
    const p = (patch) => ({ videoFx: { mask: patch } });
    return section({ title: t("in.mask"), open: m.type !== "none", children: [
      segmented({ value: m.type, options: [{ value: "none", label: t("c.none") }, { value: "rect", label: "▭" }, { value: "circle", label: "◯" }, { value: "linear", label: "▤" }], onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ type: v }) }) }),
      ...(m.type === "none" ? [] : [
        slider({ label: `${t("in.position")} X`, min: -100, max: 100, value: Math.round(m.x * 100), ...this.bind(seg, (v) => p({ x: v / 100 }), { coalesce: "mx" }) }),
        slider({ label: `${t("in.position")} Y`, min: -100, max: 100, value: Math.round(m.y * 100), ...this.bind(seg, (v) => p({ y: v / 100 }), { coalesce: "my" }) }),
        m.type !== "linear" ? slider({ label: "W", min: 2, max: 200, value: Math.round(m.w * 100), ...this.bind(seg, (v) => p({ w: v / 100 }), { coalesce: "mw" }) }) : null,
        m.type !== "linear" ? slider({ label: "H", min: 2, max: 200, value: Math.round(m.h * 100), ...this.bind(seg, (v) => p({ h: v / 100 }), { coalesce: "mh" }) }) : null,
        m.type === "rect" ? slider({ label: t("in.rotate"), min: -180, max: 180, value: m.rotation, ...this.bind(seg, (v) => p({ rotation: v }), { coalesce: "mr" }) }) : null,
        slider({ label: t("in.feather"), min: 0, max: 100, value: m.feather, ...this.bind(seg, (v) => p({ feather: v }), { coalesce: "mf" }) }),
        check({ checked: m.invert, label: t("in.invert"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ invert: v }) }) }),
      ]),
    ] });
  }

  clipEffectsSection(seg) {
    const list = seg.clipEffects || [];
    return section({ title: t("tab.effects"), open: list.length > 0, children: list.length ? list.map((e, i) => h("div", { class: "col" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, e.type.replace(/_/g, " "), e.velocity ? " (velocity)" : ""),
        h("button", { class: "icon-btn", "aria-label": t("c.remove"), onclick: () => this.ed.exec("updateSegment", { segId: seg.id, patch: { clipEffects: list.filter((_, j) => j !== i) } }) }, icon("close"))),
      slider({ label: t("in.intensity"), min: 0, max: 100, value: e.intensity ?? 50, ...this.bind(seg, (v) => ({ clipEffects: list.map((x, j) => (j === i ? { ...x, intensity: v } : x)) }), { coalesce: `ce${i}` }) })))
      : [h("button", { class: "btn small", onclick: () => this.ed.openPanel("effects") }, icon("plus"), t("tab.effects"))] });
  }

  // ------------------------------------------------------------------ audio
  audioTab(seg) {
    const ed = this.ed;
    const a = { ...DEFAULT_AUDIO_FX, ...(seg.audioFx || {}) };
    const kv = (seg.keyframes || []).some((k) => k.prop === "volumeDb") ? this.kfAt(seg, "volumeDb")?.value : null;
    const p = (patch) => ({ audioFx: patch });
    this.body.append(
      section({ title: t("in.basic"), children: [
        this.kfSlider(seg, "volumeDb", t("in.volume"), { min: -60, max: 20, step: 0.1, unit: "dB", get: () => kv ?? seg.volumeDb ?? 0, fromModel: (v) => v, toModel: (v) => Number(v.toFixed(1)), patch: (v) => ({ volumeDb: v }) }),
        slider({ label: t("in.fadeIn"), min: 0, max: Math.min(10, seg.duration / US), step: 0.1, unit: "s", value: (seg.fadeInUs || 0) / US, ...this.bind(seg, (v) => ({ fadeInUs: Math.round(v * US) }), { coalesce: "fadeIn" }) }),
        slider({ label: t("in.fadeOut"), min: 0, max: Math.min(10, seg.duration / US), step: 0.1, unit: "s", value: (seg.fadeOutUs || 0) / US, ...this.bind(seg, (v) => ({ fadeOutUs: Math.round(v * US) }), { coalesce: "fadeOut" }) }),
      ] }),
      this.musicBedSection(seg),
      section({ title: t("in.normalize"), enabled: a.normalize.enabled, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ normalize: { enabled: v, targetLufs: ed.settings().edit.targetLufs } }) }), open: a.normalize.enabled, children: [h("div", { class: "muted small" }, t("in.normalizeHint"), ` (${a.normalize.targetLufs} LUFS)`)] }),
      section({ title: t("in.enhanceVoice"), enabled: a.enhanceVoice.enabled, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ enhanceVoice: { enabled: v } }) }), open: false, children: [] }),
      section({ title: t("in.reduceNoise"), enabled: a.denoise.enabled, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ denoise: { enabled: v } }) }), open: false, children: [] }),
      section({ title: t("in.isolateVoice"), children: [segmented({ value: a.isolate, options: [{ value: "none", label: t("ctx.dontIsolate") }, { value: "remove_vocal", label: t("ctx.removeVocal") }, { value: "keep_vocal", label: t("ctx.keepVocal") }], onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ isolate: v }) }) })] }),
      section({ title: t("in.voiceChanger"), children: [h("div", { class: "chips" }, Object.keys(VOICE_CHANGERS).map((k) => h("button", { class: ["chip", a.voiceChanger === k && "active"], onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: p({ voiceChanger: k }) }) }, k)))] }),
      h("p", { class: "muted small" }, "Voice changer, noise reduction, isolation and loudness are rendered on export."),
      h("button", { class: "btn block", onclick: () => ed.exec("applyToAll", { segId: seg.id, key: "audioFx" }).then((r) => r && toast(t("c.done"), "success")) }, t("in.applyAll")));
  }

  /** Music under speech: this sound ducks under the timeline's speech (the track's role), by how much, its level. */
  musicBedSection(seg) {
    const ed = this.ed, track = ed.trackOf(seg.id);
    if (!track || track.isMain) return null;
    const db = duckDbOf(track);
    const run = async (fn) => { const r = await guard(fn); if (r !== undefined) { await ed.reloadTimeline(); return r; } return undefined; };
    const setDuck = (v) => run(() => call("musicbed.setDuck", ed.timelineId(), seg.id, v));
    const info = h("div", { class: "muted small" }, t("in.bedHint"));
    if (db) call("musicbed.speech", ed.timelineId()).then((r) => {
      const kinds = new Set(Object.values(r?.sources || {}).filter(Boolean));
      info.textContent = `${t("in.bedHint")} ${t("in.bedSpans", { n: r?.spans?.length || 0 })}${kinds.has("vad") ? ` ${t("in.bedVad")}` : ""}`;
    }).catch(() => {});
    return section({ title: t("in.musicBed"), enabled: db !== null, onToggle: (v) => setDuck(v ? DUCK_DEFAULT_DB : null), open: db !== null, children: db === null ? [info] : [
      slider({ label: t("in.bedDuck"), min: 0, max: 30, step: 1, unit: "dB", value: db, onInput: () => {}, onChange: (v) => setDuck(Math.round(v)) }),
      h("button", { class: "btn small", onclick: async () => { const r = await run(() => call("musicbed.autoLevel", ed.timelineId(), seg.id)); if (r) toast(r.level?.measured ? t("in.bedLevelDone", { db: r.level.volumeDb }) : t("in.bedLevelDefault"), "success"); } }, icon("volume"), t("in.bedAutoLevel")),
      info] });
  }

  /** J/L of the joint before a main-track clip: its sound starts before its picture (J, negative) or after (L). */
  jlSection(seg) {
    const ed = this.ed, track = ed.trackOf(seg.id);
    if (!track?.isMain || !["video", "image", "compound"].includes(seg.kind)) return null;
    const segs = [...track.segments].sort((a, b) => a.start - b.start), prev = segs[segs.indexOf(seg) - 1];
    if (!prev || prev.start + prev.duration !== seg.start || !["video", "image", "compound"].includes(prev.kind) || (prev.transitionOut?.type && prev.transitionOut.type !== "none")) return null;
    const ms = Math.round((seg.jlUs || 0) / 1000);
    return section({ title: t("in.jl"), open: !!ms, children: [
      slider({ label: t("in.jlShift"), min: -500, max: 500, step: 10, unit: "ms", value: ms, onInput: () => {}, onChange: (v) => ed.exec("setJL", { segId: seg.id, jlUs: Math.round(v) * 1000, coalesceKey: true }) }),
      h("div", { class: "muted small" }, t("in.jlHint"))] });
  }

  // ------------------------------------------------------------------ speed
  speedTab(seg) {
    const ed = this.ed;
    const mode = seg.speedMode === "curve" ? "curve" : "standard";
    const top = segmented({ value: mode, options: [{ value: "standard", label: t("in.standard") }, { value: "curve", label: t("in.curve") }], onChange: (v) => { if (v === "standard") ed.exec("setCurve", { segId: seg.id, preset: "none" }); else { this.tab[`${seg.kind}:speed`] = "curve"; ed.exec("setCurve", { segId: seg.id, preset: "montage" }); } } });
    this.body.append(top);
    if (mode === "standard") {
      // Logarithmic slider 0.1x … 100x
      const toSlider = (s) => Math.round((Math.log(s) / Math.log(100)) * 100);
      const fromSlider = (v) => Number(Math.min(SPEED_MAX, Math.max(SPEED_MIN, 100 ** (v / 100))).toFixed(2));
      const num = h("input", { type: "number", min: SPEED_MIN, max: SPEED_MAX, step: 0.1, value: seg.speed, style: { width: "70px" } });
      const durEl = h("span", { class: "muted ltr" }, formatDuration(seg.duration));
      const rng = h("input", { type: "range", min: -50, max: 100, value: toSlider(seg.speed || 1), "aria-label": t("in.speed") });
      rng.addEventListener("input", () => { num.value = fromSlider(Number(rng.value)); });
      rng.addEventListener("change", () => ed.exec("setSpeed", { segId: seg.id, speed: fromSlider(Number(rng.value)) }));
      num.addEventListener("change", () => { const v = Number(num.value); if (!(v >= SPEED_MIN && v <= SPEED_MAX)) { toast(t("err.range", { min: SPEED_MIN, max: SPEED_MAX }), "warning"); return; } ed.exec("setSpeed", { segId: seg.id, speed: v }); });
      this.body.append(section({ title: t("in.speed"), children: [h("div", { class: "row" }, rng, num, h("span", {}, "x")), h("div", { class: "row" }, h("span", { class: "muted" }, t("in.duration")), durEl),
        h("div", { class: "row" }, ...[0.5, 1, 1.5, 2, 4].map((s) => h("button", { class: "btn small", onclick: () => ed.exec("setSpeed", { segId: seg.id, speed: s }) }, `${s}x`))),
        check({ checked: seg.changePitch, label: t("in.changePitch"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { changePitch: v } }) })] }));
    } else {
      this.body.append(section({ title: t("in.curve"), children: [
        h("div", { class: "tiles" }, Object.keys(CURVE_PRESETS).filter((k) => k !== "none").map((k) => h("button", { class: ["tile", seg.curve?.preset === k && "active"], onclick: () => ed.exec("setCurve", { segId: seg.id, preset: k }) }, h("div", { class: "tile-art" }, curveSvg(CURVE_PRESETS[k])), h("div", { class: "tile-label" }, k.replace(/_/g, " "))))),
        seg.curve?.points?.length ? this.curveEditor(seg) : null,
        h("div", { class: "row" }, h("span", { class: "muted" }, t("in.duration")), h("span", { class: "ltr" }, formatDuration(seg.duration)))] }));
    }
    if (seg.kind === "video") this.body.append(section({ title: t("in.velocity"), children: [h("div", { class: "chips" }, Object.keys(VELOCITY_EFFECTS).map((k) => h("button", { class: ["chip", (seg.clipEffects || []).some((e) => e.velocity && VELOCITY_EFFECTS[k].effect === e.type) && "active"], onclick: () => ed.exec("setVelocityEffect", { segId: seg.id, type: k }) }, k.replace(/_/g, " "))))] }));
  }

  /** Drag the speed-curve points vertically (0.1x–10x, log scale). */
  curveEditor(seg) {
    const W = 260, H = 110;
    const pts = seg.curve.points.map((p) => [...p]);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "curve-editor");
    const yOf = (s) => H / 2 - (Math.log10(s) / 1) * (H / 2 - 6);
    const sOf = (y) => Number(clamp(10 ** ((H / 2 - y) / (H / 2 - 6)), 0.1, 10).toFixed(2));
    const draw = () => {
      svg.replaceChildren();
      const mid = document.createElementNS(svg.namespaceURI, "line"); mid.setAttribute("x1", 0); mid.setAttribute("x2", W); mid.setAttribute("y1", H / 2); mid.setAttribute("y2", H / 2); mid.setAttribute("class", "mid"); svg.append(mid);
      const path = document.createElementNS(svg.namespaceURI, "polyline"); path.setAttribute("points", pts.map(([x, s]) => `${x * W},${yOf(s)}`).join(" ")); svg.append(path);
      pts.forEach(([x, s], i) => {
        const c = document.createElementNS(svg.namespaceURI, "circle"); c.setAttribute("cx", x * W); c.setAttribute("cy", yOf(s)); c.setAttribute("r", 5);
        c.addEventListener("pointerdown", (e) => {
          c.setPointerCapture(e.pointerId);
          const rect = svg.getBoundingClientRect();
          const move = (ev) => { pts[i][1] = sOf(((ev.clientY - rect.top) / rect.height) * H); draw(); };
          const up = () => { c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up); this.ed.exec("setCurve", { segId: seg.id, preset: "custom", points: pts, coalesceKey: true }); };
          c.addEventListener("pointermove", move); c.addEventListener("pointerup", up);
        });
        svg.append(c);
      });
    };
    draw();
    return svg;
  }

  // ------------------------------------------------------------------ animation
  animationTab(seg) {
    const ed = this.ed;
    const which = this.tab[`${seg.id}:anim`] || "in";
    const lists = { in: ANIMATIONS_IN, out: ANIMATIONS_OUT, combo: ANIMATIONS_COMBO };
    const cur = seg.animation?.[which] || { type: "none", durationUs: 500_000 };
    this.body.append(
      segmented({ value: which, options: [{ value: "in", label: t("in.in") }, { value: "out", label: t("in.out") }, { value: "combo", label: t("in.combo") }], onChange: (v) => { this.tab[`${seg.id}:anim`] = v; this.render(); } }),
      h("div", { class: "tiles" }, lists[which].map((a) => h("button", { class: ["tile", cur.type === a && "active"], onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: { animation: { [which]: { type: a, durationUs: cur.durationUs } } } }) }, h("div", { class: `tile-art anim-${a}` }, icon(a === "none" ? "close" : "sparkle")), h("div", { class: "tile-label nowrap" }, a.replace(/_/g, " "))))),
      cur.type !== "none" ? slider({ label: t("in.duration"), min: 0.1, max: Math.max(0.2, Math.min(which === "combo" ? 10 : 5, seg.duration / US)), step: 0.1, unit: "s", value: cur.durationUs / US, ...this.bind(seg, (v) => ({ animation: { [which]: { type: cur.type, durationUs: Math.round(v * US) } } }), { coalesce: `anim-${which}` }) }) : null,
      h("button", { class: "btn block", onclick: () => ed.exec("applyToAll", { segId: seg.id, key: "animation" }).then((r) => r && toast(t("c.done"), "success")) }, t("in.applyAll")));
  }

  // ------------------------------------------------------------------ adjust (basic, HSL, curves, wheels, LUT)
  adjustTab(seg) {
    const ed = this.ed;
    const a = { ...structuredClone(DEFAULT_ADJUST), ...(seg.adjust || {}) };
    const sub = this.tab[`${seg.id}:adj`] || "basic";
    const p = (patch) => ({ adjust: patch });
    const s = (key, label, min = -100, max = 100) => slider({ label, min, max, value: Math.round(a[key] || 0), ...this.bind(seg, (v) => p({ [key]: v }), { coalesce: `adj-${key}` }) });
    this.body.append(segmented({ value: sub, options: [{ value: "basic", label: t("in.basic") }, { value: "hsl", label: t("in.hsl") }, { value: "curves", label: t("in.curves") }, { value: "wheels", label: t("in.colorWheel") }], onChange: (v) => { this.tab[`${seg.id}:adj`] = v; this.render(); } }));
    if (sub === "basic") {
      this.body.append(
        section({ title: t("in.adjust"), enabled: a.enabled !== false, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ enabled: v }) }), onReset: () => ed.exec("updateSegment", { segId: seg.id, patch: { adjust: { ...structuredClone(DEFAULT_ADJUST), lut: a.lut } } }), children: [
          s("temperature", "Temperature"), s("tint", "Tint"), s("saturation", "Saturation"), s("exposure", "Exposure"), s("contrast", "Contrast"),
          s("highlights", "Highlights"), s("shadows", "Shadows"), s("brightness", "Brightness"), s("hue", "Hue", -180, 180), s("sharpen", "Sharpen", 0, 100), s("vignette", "Vignette", 0, 100)] }),
        section({ title: t("lib.lut"), children: [this.lutPicker(seg, a), a.lut?.assetId ? slider({ label: t("in.intensity"), min: 0, max: 100, value: a.lut.intensity ?? 100, ...this.bind(seg, (v) => p({ lut: { assetId: a.lut.assetId, intensity: v } }), { coalesce: "lutI" }) }) : null] }));
    } else if (sub === "hsl") {
      const ch = this.tab[`${seg.id}:hslc`] || "red";
      const v = a.hsl?.[ch] || { h: 0, s: 0, l: 0 };
      this.body.append(h("div", { class: "row hsl-swatches" }, HSL_CHANNELS.map((c) => h("button", { class: ["swatch round", c === ch && "active"], style: { background: HSL_SWATCH[c] }, title: c, "aria-label": c, onclick: () => { this.tab[`${seg.id}:hslc`] = c; this.render(); } }))),
        slider({ label: "Hue", min: -100, max: 100, value: v.h, ...this.bind(seg, (x) => p({ hsl: { [ch]: { ...v, h: x } } }), { coalesce: `hsl-${ch}-h` }) }),
        slider({ label: "Saturation", min: -100, max: 100, value: v.s, ...this.bind(seg, (x) => p({ hsl: { [ch]: { ...v, s: x } } }), { coalesce: `hsl-${ch}-s` }) }),
        slider({ label: "Lightness", min: -100, max: 100, value: v.l, ...this.bind(seg, (x) => p({ hsl: { [ch]: { ...v, l: x } } }), { coalesce: `hsl-${ch}-l` }) }),
        h("button", { class: "btn small", onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: p({ hsl: Object.fromEntries(HSL_CHANNELS.map((c) => [c, { h: 0, s: 0, l: 0 }])) }) }) }, t("in.reset")));
    } else if (sub === "curves") {
      const ch = this.tab[`${seg.id}:curve`] || "master";
      this.body.append(segmented({ value: ch, options: ["master", "r", "g", "b"].map((c) => ({ value: c, label: c === "master" ? "RGB" : c.toUpperCase() })), onChange: (v) => { this.tab[`${seg.id}:curve`] = v; this.render(); } }),
        this.toneCurve(seg, ch, a.curves?.[ch] || [[0, 0], [1, 1]]),
        h("div", { class: "muted small" }, "Click to add a point, drag to move, double-click to remove."),
        h("button", { class: "btn small", onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: p({ curves: { [ch]: [[0, 0], [1, 1]] } }) }) }, t("in.reset")));
    } else {
      const w = a.wheels || DEFAULT_ADJUST.wheels;
      for (const range of ["shadows", "midtones", "highlights", "offset"]) {
        const v = w[range] || { r: 0, g: 0, b: 0 };
        this.body.append(section({ title: range, children: ["r", "g", "b"].map((c) => slider({ label: c.toUpperCase(), min: -100, max: 100, value: Math.round(v[c] * 100), gradient: c === "r" ? "linear-gradient(90deg,#0ff,#f00)" : c === "g" ? "linear-gradient(90deg,#f0f,#0f0)" : "linear-gradient(90deg,#ff0,#00f)", ...this.bind(seg, (x) => p({ wheels: { [range]: { ...v, [c]: x / 100 } } }), { coalesce: `wh-${range}-${c}` }) })) }));
      }
      this.body.append(slider({ label: t("in.intensity"), min: 0, max: 100, value: w.intensity ?? 100, ...this.bind(seg, (x) => p({ wheels: { intensity: x } }), { coalesce: "wh-i" }) }));
    }
    if (seg.kind !== "adjust") this.body.append(h("button", { class: "btn block", onclick: () => ed.exec("applyToAll", { segId: seg.id, key: "adjust" }).then((r) => r && toast(t("c.done"), "success")) }, t("in.applyAll")));
  }

  lutPicker(seg, a) {
    const sel = h("select", { "aria-label": t("lib.lut") }, h("option", { value: "" }, t("c.none")));
    call("library.list", { kind: "lut" }).then((items) => { for (const i of items) sel.append(h("option", { value: i.id, selected: i.id === a.lut?.assetId }, i.name)); }).catch(() => {});
    sel.addEventListener("change", () => this.ed.exec("updateSegment", { segId: seg.id, patch: { adjust: { lut: { assetId: sel.value || null, intensity: a.lut?.intensity ?? 100 } } } }));
    return h("div", { class: "row" }, sel, h("button", { class: "btn small", onclick: async () => { const files = await call("dialog.openFiles", { kind: "lut" }); if (files.length) { const r = await guard(() => call("library.importFiles", "lut", files, "yours")); if (r?.[0]) this.ed.exec("updateSegment", { segId: seg.id, patch: { adjust: { lut: { assetId: r[0].id, intensity: 100 } } } }); } } }, icon("upload")));
  }

  toneCurve(seg, ch, points) {
    const S = 220;
    const pts = points.map((p) => [...p]).sort((x, y) => x[0] - y[0]);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${S} ${S}`); svg.setAttribute("class", "tone-curve");
    const commit = () => this.ed.exec("updateSegment", { segId: seg.id, patch: { adjust: { curves: { [ch]: pts.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]) } } }, coalesceKey: `curve-${ch}` });
    const toXY = (ev) => { const r = svg.getBoundingClientRect(); return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1)]; };
    const draw = () => {
      svg.replaceChildren();
      for (let i = 1; i < 4; i++) for (const [x1, y1, x2, y2] of [[(S * i) / 4, 0, (S * i) / 4, S], [0, (S * i) / 4, S, (S * i) / 4]]) { const l = document.createElementNS(svg.namespaceURI, "line"); Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => l.setAttribute(k, v)); l.setAttribute("class", "grid"); svg.append(l); }
      const pl = document.createElementNS(svg.namespaceURI, "polyline"); pl.setAttribute("points", pts.map(([x, y]) => `${x * S},${(1 - y) * S}`).join(" ")); pl.setAttribute("class", `c-${ch}`); svg.append(pl);
      pts.forEach((p, i) => {
        const c = document.createElementNS(svg.namespaceURI, "circle"); c.setAttribute("cx", p[0] * S); c.setAttribute("cy", (1 - p[1]) * S); c.setAttribute("r", 5);
        c.addEventListener("pointerdown", (e) => {
          e.stopPropagation(); c.setPointerCapture(e.pointerId);
          const move = (ev) => { const [x, y] = toXY(ev); const lo = i === 0 ? 0 : pts[i - 1][0] + 0.01, hi = i === pts.length - 1 ? 1 : pts[i + 1][0] - 0.01; pts[i] = [i === 0 || i === pts.length - 1 ? p[0] : clamp(x, lo, hi), y]; draw(); };
          const up = () => { c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up); commit(); };
          c.addEventListener("pointermove", move); c.addEventListener("pointerup", up);
        });
        c.addEventListener("dblclick", (e) => { e.stopPropagation(); if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); draw(); commit(); } });
        svg.append(c);
      });
    };
    svg.addEventListener("pointerdown", (e) => { if (pts.length >= 16) return; const [x, y] = toXY(e); pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); draw(); commit(); });
    draw();
    return svg;
  }

  // ------------------------------------------------------------------ text
  /** "Behind the person" switch for layers that can go there (not the main track). */
  behindRow(seg) {
    const track = this.ed.trackOf(seg.id);
    if (!track || track.isMain || !canGoBehind(seg)) return null;
    return h("div", { class: "row" }, check({ checked: track.role === "behind", label: t("lib.behindPerson"), onChange: (v) => this.ed.behindPerson([seg.id], v) }));
  }

  /**
   * "Choose…" for a graphics media field: a picture or video of this project (its media:// link) or a file on the
   * computer (its path). A Lottie template's src takes a JSON file.
   */
  mediaPickButton(template, key, onPick) {
    const lottie = template === "lottie-sticker" && key === "src";
    const pick = () => {
      const items = this.ed.mediaList().filter((m) => (lottie ? false : m.type === "image" || (m.type === "video" && ["still", "stills", "src"].includes(key))) && m.status !== "missing");
      const list = h("div", { class: "col", style: { gap: "4px", maxHeight: "360px", overflowY: "auto" } },
        items.length ? items.map((m) => h("button", { class: "list-row", onclick: () => { onPick(mediaUrl(m.id)); dlg.close(); } },
          m.thumbPath ? h("img", { src: thumbUrl(m.id, m.thumbCount), alt: "", style: { width: "48px", height: "27px", objectFit: "cover" } }) : icon(m.type === "image" ? "image" : "video"),
          h("span", { class: "grow nowrap" }, m.name))) : h("div", { class: "empty" }, t("in.pickNone")));
      const fromFile = h("button", { class: "btn", onclick: async () => { const [f] = await call("dialog.openFiles", { kind: lottie ? "json" : "image" }); if (f) { onPick(f); dlg.close(); } } }, icon("upload"), t("in.pickFile"));
      const dlg = modal({ title: t("in.pickMedia"), width: 460, body: list, footer: [fromFile] });
    };
    return h("button", { class: "btn small", title: t("in.pickMedia"), onclick: pick }, icon("folder"), t("in.pick"));
  }

  /** Motion graphic: one control per template parameter (text, numbers, colours, choices, fonts, emoji, icon). */
  graphicTab(seg) {
    const ed = this.ed, gr = seg.text.graphic, tpl = GRAPHIC_TEMPLATES[gr.template];
    if (!tpl) { this.body.append(h("p", { class: "muted" }, gr.template)); return; }
    const P = graphicParams(gr);
    const patch = (k, v) => ({ text: { graphic: { params: { [k]: v } }, ...(["text", "title"].includes(k) && typeof v === "string" ? { content: v.slice(0, 2000) } : {}) } });
    const live = (k, v) => ed.patchLive(seg.id, patch(k, v));
    const commit = (k, v) => ed.exec("updateSegment", { segId: seg.id, patch: patch(k, v), coalesceKey: `g-${k}` });
    const row = (label, ctl) => h("div", { class: "row" }, h("span", { class: "muted grow" }, label), ctl);
    const field = (k, sch) => {
      const label = (getLang() === "ar" && PARAM_AR[k]) || sch.title || k;
      if (sch.enum) return row(label, select({ value: P[k], options: sch.enum, onChange: (v) => commit(k, v) }));
      if (sch.type === "boolean") return h("div", { class: "row" }, check({ checked: !!P[k], label, onChange: (v) => commit(k, v) }));
      if (sch.type === "number" || sch.type === "integer") {
        if (sch.maximum - sch.minimum > 10_000) {
          const el = h("input", { type: "number", value: P[k], step: sch.type === "integer" ? 1 : "any", style: { width: "110px" } });
          el.addEventListener("change", () => { const v = Number(el.value); if (Number.isFinite(v)) commit(k, clamp(v, sch.minimum, sch.maximum)); });
          return row(label, el);
        }
        const step = sch.type === "integer" ? 1 : (sch.maximum - sch.minimum) / 100;
        return slider({ label, min: sch.minimum, max: sch.maximum, step, value: P[k], onInput: (v) => live(k, v), onChange: (v) => commit(k, v) });
      }
      if (sch.pattern?.startsWith("^#")) return row(label, colorInput({ value: P[k], onInput: (v) => live(k, v), onChange: (v) => commit(k, v) }));
      if (k === "font") return row(label, select({ value: P[k], options: FONTS, onChange: (v) => commit(k, v) }));
      if (sch.type === "array") {
        const area = h("textarea", { rows: Math.min(6, (P[k] || []).length + 1), dir: "auto", style: { width: "100%" } });
        area.value = (P[k] || []).join("\n");
        const lines = () => area.value.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, sch.maxItems || 6).map((x) => (sch.items?.type === "number" ? Number(x) || 0 : x.slice(0, sch.items?.maxLength || 50)));
        area.addEventListener("input", () => live(k, lines()));
        area.addEventListener("change", () => commit(k, lines()));
        const add = MEDIA_PARAMS.has(k) ? this.mediaPickButton(gr.template, k, (ref) => { area.value = [...area.value.split("\n").map((x) => x.trim()).filter(Boolean), ref].join("\n"); commit(k, lines()); }) : null;
        return h("div", { class: "col" }, h("div", { class: "row" }, h("span", { class: "muted grow" }, label), add), area);
      }
      const input = h("input", { type: "text", value: P[k] ?? "", maxlength: sch.maxLength || 120, dir: "auto", style: { width: "100%" } });
      input.addEventListener("input", () => live(k, input.value));
      input.addEventListener("change", () => commit(k, input.value));
      const out = [MEDIA_PARAMS.has(k) ? h("div", { class: "row" }, h("span", { class: "muted grow" }, label), this.mediaPickButton(gr.template, k, (ref) => { input.value = ref; commit(k, ref); })) : h("span", { class: "muted" }, label), input];
      if (k === "emoji") { // the bundled 3D emoji
        const seen = new Set();
        out.push(h("div", { class: "emoji-pick" }, Object.entries(EMOJI_ALIASES).filter(([, name]) => !seen.has(name) && seen.add(name)).map(([ch, name]) =>
          h("button", { class: ["icon-btn", P[k] === ch && "active"], title: name, onclick: () => { input.value = ch; commit(k, ch); } }, h("img", { src: `assets/emoji/${name}.png`, alt: name, loading: "lazy" })))));
      }
      if (k === "icon") {
        const list = h("datalist", { id: `icons-${seg.id}` });
        input.setAttribute("list", list.id);
        fetch("assets/icons/index.json").then((r) => r.json()).then((names) => mount(list, ...names.map((n) => h("option", { value: n })))).catch(() => {});
        out.push(list);
      }
      return h("div", { class: "col" }, ...out);
    };
    this.body.append(
      h("div", { class: "col" }, h("strong", {}, `${t("in.graphic")} · ${getLang() === "ar" ? tpl.ar : tpl.name}`), h("p", { class: "muted small" }, tpl.use)),
      this.behindRow(seg),
      section({ title: t("in.basic"), children: Object.entries(tpl.params).filter(([k]) => k !== "subject").map(([k, sch]) => field(k, sch)) }),
      section({ title: t("in.transform"), open: false, children: [
        slider({ label: t("in.opacity"), min: 0, max: 100, unit: "%", value: Math.round((seg.transform?.opacity ?? 1) * 100), ...this.bind(seg, (v) => ({ transform: { opacity: v / 100 } }), { coalesce: "opacity" }) })] }),
      h("button", { class: "btn block", onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: { text: { graphic: { template: gr.template, params: Object.fromEntries(Object.entries(tpl.params).map(([k, s]) => [k, s.default])) } } } }) }, t("in.reset")));
  }

  textTab(seg) {
    if (seg.text?.graphic) return this.graphicTab(seg);
    const ed = this.ed, tx = seg.text;
    const p = (patch) => ({ text: patch });
    const area = h("textarea", { rows: 3, maxlength: 2000, value: tx.content, "aria-label": t("in.text"), dir: "auto", style: { width: "100%" } });
    area.addEventListener("input", () => ed.patchLive(seg.id, p({ content: area.value })));
    area.addEventListener("change", () => ed.exec("updateSegment", { segId: seg.id, patch: p({ content: area.value }), coalesceKey: "content" }));
    this.textArea = area;
    const btn = (key, label) => h("button", { class: ["btn small", tx[key] && "active-btn"], "aria-pressed": tx[key] ? "true" : "false", onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: p({ [key]: !tx[key] }) }) }, label);
    this.body.append(
      area,
      section({ title: t("in.basic"), children: [
        h("div", { class: "row" }, h("span", { class: "muted" }, t("in.font")), select({ value: tx.font, options: FONTS, onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ font: v }) }) })),
        slider({ label: t("in.fontSize"), min: 1, max: 200, value: tx.size, ...this.bind(seg, (v) => p({ size: v }), { coalesce: "size" }) }),
        h("div", { class: "row" }, btn("bold", "B"), btn("italic", "I"), btn("underline", "U"),
          select({ value: tx.textCase, options: [{ value: "none", label: "Aa" }, { value: "upper", label: "AA" }, { value: "lower", label: "aa" }, { value: "title", label: "Ab" }], label: t("in.case"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ textCase: v }) }) })),
        h("div", { class: "row" }, h("span", { class: "muted" }, t("in.color")), colorInput({ value: tx.color, onInput: (v) => ed.patchLive(seg.id, p({ color: v })), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ color: v }) }) })),
        slider({ label: t("in.character"), min: -10, max: 50, value: tx.letterSpacing, ...this.bind(seg, (v) => p({ letterSpacing: v }), { coalesce: "ls" }) }),
        slider({ label: t("in.line"), min: -10, max: 50, value: tx.lineSpacing, ...this.bind(seg, (v) => p({ lineSpacing: v }), { coalesce: "lh" }) }),
        h("div", { class: "row" }, h("span", { class: "muted" }, t("in.alignment")), segmented({ value: tx.align, options: [{ value: "left", label: "⯇" }, { value: "center", label: "≡" }, { value: "right", label: "⯈" }], onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ align: v }) }) })),
        h("div", { class: "row" }, h("span", { class: "muted" }, t("in.direction")), segmented({ value: tx.direction || "auto", options: [{ value: "auto", label: "Auto" }, { value: "rtl", label: "RTL" }, { value: "ltr", label: "LTR" }], onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ direction: v }) }) })),
      ] }),
      section({ title: t("in.stroke"), children: [h("div", { class: "row" }, colorInput({ value: tx.strokeColor, onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ strokeColor: v }) }) })), slider({ label: t("in.size"), min: 0, max: 20, value: tx.strokeWidth, ...this.bind(seg, (v) => p({ strokeWidth: v }), { coalesce: "sw" }) })] }),
      section({ title: t("in.background"), children: [h("div", { class: "row" }, colorInput({ value: tx.bgColor, onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ bgColor: v }) }) })), slider({ label: t("in.opacity"), min: 0, max: 100, value: tx.bgOpacity, ...this.bind(seg, (v) => p({ bgOpacity: v }), { coalesce: "bgo" }) })] }),
      section({ title: t("in.shadow"), enabled: tx.shadow, onToggle: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ shadow: v }) }), open: false, children: [] }),
      section({ title: t("in.presetStyle"), children: [h("div", { class: "chips" }, Object.keys(TEXT_PRESETS).map((k) => h("button", { class: ["chip", tx.preset === k && "active"], onclick: () => ed.exec("updateSegment", { segId: seg.id, patch: p({ ...TEXT_PRESETS[k], preset: k }) }) }, k.replace(/_/g, " "))))] }),
      h("div", { class: "row" }, check({ checked: tx.isCaption, label: t("in.isCaption"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: p({ isCaption: v }) }) })),
      this.behindRow(seg),
      section({ title: t("in.transform"), open: false, children: [
        slider({ label: t("in.scale"), min: 1, max: 500, unit: "%", value: Math.round((seg.transform?.scale ?? 1) * 100), ...this.bind(seg, (v) => ({ transform: { scale: v / 100 } }), { coalesce: "scale" }) }),
        slider({ label: t("in.rotate"), min: -360, max: 360, unit: "°", value: seg.transform?.rotation || 0, ...this.bind(seg, (v) => ({ transform: { rotation: v } }), { coalesce: "rotation" }) }),
        slider({ label: t("in.opacity"), min: 0, max: 100, unit: "%", value: Math.round((seg.transform?.opacity ?? 1) * 100), ...this.bind(seg, (v) => ({ transform: { opacity: v / 100 } }), { coalesce: "opacity" }) })] }),
      h("button", { class: "btn block", onclick: () => ed.exec("applyToAll", { segId: seg.id, key: "transform" }).then((r) => r && toast(t("c.done"), "success")) }, t("in.applyAll")));
  }

  ttsTab(seg) {
    const ed = this.ed;
    const voice = h("select", { "aria-label": t("in.voice") });
    const rate = slider({ label: t("in.rate"), min: 0.5, max: 2, step: 0.1, value: 1 });
    const status = h("div", { class: "muted small" });
    const go = h("button", { class: "btn primary block" }, icon("mic"), t("in.generateSpeech"));
    call("tts.voices").then((vs) => {
      if (!vs.length) { status.textContent = t("err.ttsUnavailable"); go.disabled = true; return; }
      for (const v of vs) voice.append(h("option", { value: v.name }, `${v.name} · ${v.language}`));
      const pref = vs.find((v) => (/[؀-ۿ]/.test(seg.text.content) ? /^ar/i : /^en/i).test(v.language));
      if (pref) voice.value = pref.name;
    }).catch(() => { status.textContent = t("err.ttsUnavailable"); go.disabled = true; });
    go.onclick = async () => {
      go.disabled = true; status.textContent = t("c.loading");
      const num = rate.querySelector("input[type=number]");
      const a = await guard(() => call("tts.synthesize", ed.project().id, { text: seg.text.content, voice: voice.value, rate: Number(num.value) || 1 }));
      go.disabled = false; status.textContent = "";
      if (!a) return;
      await ed.refreshMedia();
      await ed.exec("addMedia", { mediaId: a.id, toMain: false, atUs: seg.start });
      toast(t("c.done"), "success");
    };
    this.body.append(h("p", { class: "muted small" }, t("tool.ttsDesc")), h("div", { class: "row" }, h("span", { class: "muted" }, t("in.voice")), voice), rate, go, status);
  }

  effectTab(seg) {
    const ed = this.ed;
    this.body.append(section({ title: t("in.effect"), children: [
      select({ value: seg.effect?.type, options: Object.keys(EFFECTS), label: t("in.effect"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { effect: { type: v } } }) }),
      slider({ label: t("in.intensity"), min: 0, max: 100, value: seg.effect?.intensity ?? 50, ...this.bind(seg, (v) => ({ effect: { intensity: v } }), { coalesce: "fxI" }) })] }));
  }
  filterTab(seg) {
    const ed = this.ed;
    this.body.append(section({ title: t("in.filter"), children: [
      select({ value: seg.filter?.preset, options: Object.keys(FILTER_PRESETS), label: t("in.filter"), onChange: (v) => ed.exec("updateSegment", { segId: seg.id, patch: { filter: { preset: v } } }) }),
      slider({ label: t("in.intensity"), min: 0, max: 100, value: seg.filter?.intensity ?? 100, ...this.bind(seg, (v) => ({ filter: { intensity: v } }), { coalesce: "flI" }) })] }));
  }

  // ------------------------------------------------------------------ multi-selection & project panel
  multi(ids) {
    const ed = this.ed;
    this.body.append(h("div", { class: "empty" }, icon("layers"), h("div", {}, t("ed.itemsSelected", { n: ids.length })),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => ed.run("group") }, t("ctx.group")), h("button", { class: "btn", onclick: () => ed.run("createCompound") }, t("ctx.compound")), h("button", { class: "btn danger", onclick: () => ed.run("delete") }, t("ctx.delete")))));
  }

  projectPanel() {
    const ed = this.ed, tl = ed.tl(), p = ed.project();
    mount(this.tabsEl, h("button", { class: "active" }, t("ed.project")));
    const sugg = h("div", { class: "col" });
    this.body.append(
      section({ title: t("ed.details"), children: [
        h("div", { class: "kv" }, h("span", { class: "muted" }, t("col.name")), h("span", { class: "nowrap" }, p.name)),
        h("div", { class: "kv" }, h("span", { class: "muted" }, t("in.aspect")), select({ value: tl.canvas.ratio, options: Object.keys(CANVAS_RATIOS).map((r) => ({ value: r, label: r === "original" ? "Original" : r })), onChange: (v) => ed.exec("setCanvas", { ratio: v }).then(() => ed.relayout()) })),
        h("div", { class: "kv" }, h("span", { class: "muted" }, t("in.resolution")), h("span", { class: "ltr" }, `${tl.canvas.width} × ${tl.canvas.height}`)),
        h("div", { class: "kv" }, h("span", { class: "muted" }, t("in.fps")), select({ value: String(tl.fps), options: FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })), onChange: (v) => ed.exec("setCanvas", { fps: Number(v) }) })),
        h("div", { class: "kv" }, h("span", { class: "muted" }, t("col.duration")), h("span", { class: "ltr" }, formatDuration(ed.duration()))),
        h("div", { class: "kv" }, h("span", { class: "muted" }, t("in.importedMedia")), h("span", {}, t("in.stayOriginal"))),
      ] }),
      this.canvasSection(),
      section({ title: t("in.smartSuggestions"), children: [h("p", { class: "muted small" }, t("in.findImprove")), h("button", { class: "btn", onclick: async () => {
        mount(sugg, h("div", { class: "loading" }, h("div", { class: "spinner" })));
        const r = await guard(() => call("analysis.suggestions", ed.timelineId()));
        clear(sugg);
        if (!r) return;
        if (!r.suggestions.length) { sugg.append(h("div", { class: "muted small" }, "✓ ", t("c.done"))); return; }
        for (const s of r.suggestions) sugg.append(h("div", { class: "suggestion" }, icon("info"), h("span", { class: "grow" }, t(`ge.${s.id}`), s.spreadDb ? ` (±${s.spreadDb} dB)` : ""), h("button", { class: "btn small", onclick: () => ed.globalEdit(s.id) }, t("c.apply"))));
      } }, icon("sparkle"), t("in.analyze")), sugg] }),
      section({ title: t("in.globalEdits"), children: ["colorsBetter", "colorsConsistent", "volumeConsistent", "voiceClearer", "videoClearer"].map((k) => h("button", { class: "btn block", onclick: () => ed.globalEdit(k) }, t(`ge.${k}`))) }),
      h("p", { class: "muted small" }, t("in.noSelection")));
  }
}

function curveSvg(points) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 60 30");
  const pl = document.createElementNS(svg.namespaceURI, "polyline");
  pl.setAttribute("points", (points || []).map(([x, s]) => `${x * 60},${15 - Math.log10(s) * 13}`).join(" "));
  pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "currentColor"); pl.setAttribute("stroke-width", "2");
  svg.append(pl);
  return svg;
}
