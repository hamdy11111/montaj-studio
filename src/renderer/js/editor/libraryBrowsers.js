// Simple library browsers of the editor (phase 10), opened from the timeline toolbar:
// - «موسيقى تحت الكلام»: a music-studio result or a sound of the project goes under the edit (or the In/Out range) on a
//   music track that ducks under the speech, at a level measured against the speech (services/musicBedService.js);
// - «مكتبة الأصوات»: search the sound library by meaning (phase 9's sfxlib.search) and add a sound at the playhead, its
//   accent on the playhead;
// - «بحث البي-رول»: search the B-roll index by meaning (broll.search) and lay the shot's span on a track above, at the
//   playhead.
// Each addition is one undo step; files are imported into the project the first time they are used. A sound can be
// heard and a shot seen (its keyframe, then its span played) before it is added, through media://libfile, which serves
// only the libraries' own files, read-only (main/libraryFiles.js).
import { h, mount } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, guard } from "../api.js";
import { toast } from "../ui/toast.js";
import { modal } from "../ui/modal.js";
import { select, toggle } from "../ui/controls.js";
import { US, formatDuration } from "../../core/util.js";

const fmtS = (s) => formatDuration(Math.round((s || 0) * US));

/** media://libfile URL of a library file (base64url of its UTF-8 path; main/libraryFiles.js decodes and checks it). */
export function libFileUrl(file) {
  let bin = "";
  for (const b of new TextEncoder().encode(String(file))) bin += String.fromCharCode(b);
  return `media://libfile/${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** One player for the rows of a browser: play(url, button, span?) toggles; the span [from, to] s stops itself. */
function previewPlayer(el) {
  let btn = null, stopAt = null;
  const idle = () => { if (btn) { btn.classList.remove("active"); btn.title = t("lb.listen"); } btn = null; stopAt = null; };
  el.addEventListener("timeupdate", () => { if (stopAt !== null && el.currentTime >= stopAt) { el.pause(); idle(); } });
  el.addEventListener("ended", idle);
  el.addEventListener("error", () => { if (btn) toast(t("lb.previewFailed"), "warning"); idle(); });
  return {
    el,
    async play(url, button, span = null) {
      const again = btn === button;
      el.pause(); idle();
      if (again) return; // the same row: stop
      btn = button; button.classList.add("active"); button.title = t("lb.stopListen");
      if (el.src !== url) el.src = url;
      stopAt = span ? span[1] : null;
      try {
        if (span) { if (el.readyState < 1) await new Promise((r) => el.addEventListener("loadedmetadata", r, { once: true })); el.currentTime = span[0]; } else el.currentTime = 0;
        await el.play();
      } catch { if (btn === button) { toast(t("lb.previewFailed"), "warning"); idle(); } }
    },
    stop() { el.pause(); idle(); },
  };
}

/** A file of the project for `file` (imported when it is not there yet). */
async function projectMedia(ed, file) {
  const have = ed.mediaList().find((m) => m.path === file);
  if (have) return have;
  const r = await guard(() => call("media.import", ed.project().id, [file]));
  const m = r?.imported?.[0];
  if (!m) { toast(t("lb.importFailed"), "error"); return null; }
  await ed.refreshMedia();
  return m;
}

export async function openMusicBed(ed) {
  const st = { pick: null, duck: 12, auto: true, range: !!(ed.inOut().in !== null && ed.inOut().out !== null) };
  const list = h("div", { class: "col", style: { gap: "4px", maxHeight: "300px", overflowY: "auto" } });
  const lib = (await call("music.library", {}).catch(() => [])) || [];
  const sounds = ed.mediaList().filter((m) => m.type === "audio" && m.status !== "missing");
  const row = (key, label, sub) => h("button", { class: ["list-row", st.pick?.key === key && "active"], onclick: () => { st.pick = { key, ...(key.startsWith("lib:") ? { libraryId: key.slice(4) } : { mediaId: key.slice(4) }) }; draw(); } },
    icon("audio"), h("span", { class: "grow nowrap" }, label), h("span", { class: "muted small" }, sub));
  const draw = () => mount(list,
    lib.length ? h("div", { class: "muted small" }, t("lb.fromStudio")) : null,
    ...lib.filter((x) => x.exists).map((x) => row(`lib:${x.id}`, x.name, formatDuration(x.durationUs))),
    sounds.length ? h("div", { class: "muted small" }, t("lb.fromProject")) : null,
    ...sounds.map((m) => row(`med:${m.id}`, m.name, formatDuration(m.durationUs))),
    !lib.length && !sounds.length ? h("div", { class: "empty" }, t("lb.noMusic")) : null);
  draw();
  const { in: a, out: b } = ed.inOut();
  const body = h("div", { class: "col", style: { gap: "10px" } },
    h("p", { class: "muted small" }, t("lb.bedHint")), list,
    h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
      h("span", {}, t("in.bedDuck")), select({ value: String(st.duck), options: [0, 6, 9, 12, 15, 18, 24].map((v) => ({ value: String(v), label: v ? `${v} dB` : t("lb.noDuck") })), onChange: (v) => { st.duck = Number(v); } }),
      toggle({ checked: st.auto, label: t("lb.autoLevel"), onChange: (v) => { st.auto = v; } }),
      a !== null && b !== null ? toggle({ checked: st.range, label: t("lb.inOutOnly"), onChange: (v) => { st.range = v; } }) : null),
    h("div", { class: "muted small" }, t("lb.bedFades")));
  const go = h("button", { class: "btn primary", onclick: async () => {
    if (!st.pick) { toast(t("lb.pickFirst"), "warning"); return; }
    go.disabled = true; go.textContent = t("lb.measuring");
    const r = await guard(() => call("musicbed.place", ed.timelineId(), { ...st.pick, projectId: ed.project().id, duckDb: st.duck, autoLevel: st.auto, ...(st.range ? { fromUs: a, toUs: b } : {}) }));
    go.disabled = false; go.textContent = t("lb.placeBed");
    if (!r) return;
    await ed.reloadTimeline();
    dlg.close();
    toast(r.level?.measured ? t("in.bedLevelDone", { db: r.level.volumeDb }) : t("lb.bedPlaced"), "success");
  } }, icon("plus"), t("lb.placeBed"));
  const dlg = modal({ title: t("tl.musicBed"), width: 520, body, footer: [go] });
}

export function openSoundLibrary(ed) {
  const input = h("input", { type: "search", class: "search grow", placeholder: t("lb.sfxPh"), dir: "auto" });
  const mood = select({ value: "neutral", options: ["neutral", "comic", "joy", "shock", "tense", "serious", "sad", "emotional"].map((v) => ({ value: v, label: t(`lb.mood.${v}`) })) });
  const out = h("div", { class: "col", style: { gap: "4px", maxHeight: "360px", overflowY: "auto" } });
  const status = h("div", { class: "muted small" });
  const player = previewPlayer(new Audio());
  call("sfxlib.status").then((s) => { status.textContent = t("lb.sfxStatus", { n: s.sounds, idx: s.indexed }); }).catch(() => { status.textContent = t("lb.sfxNone"); });
  const search = async () => {
    const q = input.value.trim();
    if (!q) return;
    mount(out, h("div", { class: "muted" }, t("lb.searching")));
    const r = await guard(() => call("sfxlib.search", q, { mood: mood.value || "neutral", limit: 30 }));
    if (!r) { mount(out); return; }
    if (r.blocked) { mount(out, h("div", { class: "empty" }, t("lb.sfxBlocked"))); return; }
    mount(out, ...(r.results.length ? r.results.map((x) => h("div", { class: "list-row" },
      h("button", { class: "icon-btn", title: t("lb.listen"), "aria-label": t("lb.listen"), disabled: !x.file, onclick: (e) => player.play(libFileUrl(x.file), e.currentTarget) }, icon("play")),
      h("div", { class: "col grow" }, h("b", { class: "nowrap" }, x.title), h("span", { class: "muted small" }, [x.tagsAr.slice(0, 4).join("، "), x.source, x.license].filter(Boolean).join(" · "))),
      h("span", { class: "muted small" }, fmtS(x.durationS)),
      h("button", { class: "btn small", title: t("lb.addAtPlayhead"), onclick: async () => {
        const m = await projectMedia(ed, x.file);
        if (m) await ed.exec("addMedia", { mediaId: m.id, atUs: Math.max(0, ed.playhead() - (x.leadUs || 0)), toMain: false });
      } }, icon("plus"), t("lb.add")))) : [h("div", { class: "empty" }, t("lb.noResults"))]));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  const body = h("div", { class: "col", style: { gap: "8px" } },
    h("div", { class: "row", style: { gap: "8px" } }, input, mood, h("button", { class: "btn primary", onclick: search }, icon("search"), t("lb.search"))), status, out);
  modal({ title: t("tl.sfxLib"), width: 600, body, onClose: () => player.stop() });
}

/** `search` (query → shots) is the B-roll index's search; a test may pass its own (the index's models need the GPU). */
export function openBrollSearch(ed, { search: find = (q) => call("broll.search", q, { limit: 20 }) } = {}) {
  const input = h("input", { type: "search", class: "search grow", placeholder: t("lb.brollPh"), dir: "auto" });
  const out = h("div", { class: "col", style: { gap: "4px", maxHeight: "360px", overflowY: "auto" } });
  const status = h("div", { class: "muted small" });
  const video = h("video", { class: "lb-preview", muted: false, playsInline: true, style: { display: "none", width: "100%", maxHeight: "240px", background: "#000", borderRadius: "6px" } });
  const player = previewPlayer(video);
  const watch = (x, button) => { video.style.display = ""; video.poster = x.frames?.[1] || x.frames?.[0] ? libFileUrl(x.frames[1] || x.frames[0]) : ""; player.play(libFileUrl(x.path), button, [x.startS, x.endS]); };
  call("broll.status").then((s) => { status.textContent = t("lb.brollStatus", { media: s.media, shots: s.shots }); }).catch(() => { status.textContent = t("lb.brollNone"); });
  const search = async () => {
    const q = input.value.trim();
    if (!q) return;
    mount(out, h("div", { class: "muted" }, t("lb.searching")));
    const r = await guard(() => find(q));
    if (!r) { mount(out); return; }
    player.stop(); video.style.display = "none";
    mount(out, ...(r.length ? r.map((x) => h("div", { class: "list-row" },
      x.frames?.length && x.path
        ? h("button", { class: "lb-thumb", title: t("lb.watchShot"), "aria-label": t("lb.watchShot"), style: { padding: 0, border: 0, background: "none", cursor: "pointer", flex: "none" }, onclick: (e) => watch(x, e.currentTarget) },
          h("img", { src: libFileUrl(x.frames[1] || x.frames[0]), alt: "", loading: "lazy", style: { width: "96px", height: "54px", objectFit: "cover", borderRadius: "4px", display: "block" } }))
        : icon("video"),
      h("div", { class: "col grow" }, h("b", { class: "nowrap", title: x.path }, x.caption || x.path?.split(/[\\/]/).pop() || x.id), h("span", { class: "muted small ltr" }, `${x.path?.split(/[\\/]/).pop() || ""} · ${fmtS(x.startS)}–${fmtS(x.endS)}`)),
      h("button", { class: "btn small", title: t("lb.addAtPlayhead"), disabled: !x.path, onclick: async () => {
        const m = await projectMedia(ed, x.path);
        if (!m) return;
        const from = Math.round(x.startS * US), dur = Math.max(US / 10, Math.round((x.endS - x.startS) * US));
        await ed.exec("addSegment", { kind: "video", mediaId: m.id, atUs: ed.playhead(), durationUs: dur, init: { sourceStart: from, sourceDuration: dur, name: m.name } });
      } }, icon("plus"), t("lb.add")))) : [h("div", { class: "empty" }, t("lb.noResults"))]));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  const body = h("div", { class: "col", style: { gap: "8px" } },
    h("div", { class: "row", style: { gap: "8px" } }, input, h("button", { class: "btn primary", onclick: search }, icon("search"), t("lb.search"))), status, video, out);
  modal({ title: t("tl.broll"), width: 640, body, onClose: () => { player.stop(); video.removeAttribute("src"); video.load(); } });
}
