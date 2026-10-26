// Compiles a timeline into FFmpeg arguments + one filter graph (FEAT-113..117, FEAT-031 render, FEAT-119 still).
// Layer order = track order (main track at the bottom). Visual layers are composited with overlay; effect /
// filter / adjust tracks re-grade the composite inside their time window. Time inside expressions is seconds
// from the start of the exported range (`t`), produced by shifting every layer's PTS to its position.
import { US } from "./util.js";
import { layerState, transitionsFor, gainAt, EXPR, NUM } from "./layerMath.js";
import { curveChunks, atempoChain } from "./speed.js";
import { adjustToFfmpeg, applyFilterPreset, isDefaultAdjust } from "./color.js";
import { EFFECTS, VOICE_CHANGERS, AUDIO_CHAINS } from "./presets.js";
import { RESOLUTIONS } from "./model.js";
import { AppError } from "./validation.js";
import { cutoutLayers, cutoutAfterTrack } from "./cutout.js";
import { pictureTracks } from "./timelineOps.js";
import { duckDbOf, duckExpr } from "./musicBed.js";

const s = (us) => Number((us / US).toFixed(6));
const hex = (c) => `0x${(c || "#000000").replace("#", "").slice(0, 6)}`;
const isVisualKind = (k) => ["video", "image", "text", "sticker", "compound"].includes(k);

// Grading filters that keep the frame size and are single-input; with timeline support they can be applied in
// place on the composite. (format/scale/crop/split/overlay — or anything with labels — need the general path.)
const IN_PLACE_GRADES = new Set(["lutrgb", "colorchannelmixer", "curves", "colortemperature", "colorbalance", "huesaturation", "lut3d", "exposure",
  "vignette", "gblur", "noise", "negate", "edgedetect", "rgbashift", "pixelize", "drawbox", "eq", "hue", "unsharp"]);
/** Split a filter chain on top-level commas (commas inside quotes belong to expressions). */
export function splitFilters(chain) {
  const out = []; let cur = "", q = false;
  for (const ch of chain) { if (ch === "'") q = !q; if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
}
const filterName = (f) => f.split("=")[0].trim();
const isInPlaceGrade = (f, caps) => !/[[\]]/.test(f) && IN_PLACE_GRADES.has(filterName(f)) && (!caps?.timeline || caps.timeline.has(filterName(f)));
const withEnable = (f, enable) => (f.includes("=") ? `${f}:enable='${enable}'` : `${f}=enable='${enable}'`);

// YUV↔RGB conversions must use the source's matrix. FFmpeg's implicit conversions default to BT.601, which
// shifted every HD export's colours (BT.709 sources, BT.709-tagged output). HD video without metadata is
// assumed BT.709 (ITU-R BT.709 / common practice), SD video BT.601. Images keep FFmpeg's auto handling.
export const sourceMatrix = (media) => media?.colorMatrix || ((media?.height || 1080) >= 720 ? "bt709" : "bt601");
const toRgba = (matrix) => `scale=in_color_matrix=${matrix}:in_range=tv,format=rgba`;
// Overlays composite in RGB (format=auto): their yuv420 default would re-encode every layer with BT.601.
const OUT_YUV = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
// A composited RGBA layer going onto a YUV composite: same matrix and range as OUT_YUV, alpha kept.
const TO_YUVA = "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p";
const BLEND_NEUTRAL = { screen: "black", add: "black", lighten: "black", multiply: "white", darken: "white" };
const BLEND_MODE = { screen: "screen", add: "addition", lighten: "lighten", multiply: "multiply", darken: "darken" };
const isGrade = (k) => k === "effect" || k === "filter" || k === "adjust";
// Video codecs without an alpha channel: such clips are opaque, so a frame-filling one hides what is under it.
const OPAQUE_CODECS = new Set(["h264", "hevc", "av1", "mpeg4", "mpeg2video", "mjpeg", "vc1", "wmv3"]);
// Transitions that leave the outgoing clip untouched (layerMath transitionContribution has no "out" part).
const OUT_IDLE = new Set(["dissolve", "slide_left", "slide_right", "slide_up", "slide_down", "zoom_in", "spin"]);

/** Output frame size for a timeline at a resolution preset (short side), keeping the canvas ratio. */
export function outputSize(canvas, resolution = "1080p") {
  const short = typeof resolution === "number" ? resolution : RESOLUTIONS[resolution] || 1080;
  const w = canvas.width, h = canvas.height;
  const k = short / Math.min(w, h);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

/** Recommended bitrates (kbps) by pixel rate; lower/higher scale it (report: Lower / Recommended / Higher / Custom). */
export function videoBitrateKbps({ width, height, fps, bitrate = "recommended", codec = "h264" }) {
  if (bitrate && typeof bitrate === "object" && bitrate.customKbps) return Math.max(200, Math.round(bitrate.customKbps));
  const base = (width * height * Math.min(fps, 60) * 0.13) / 1000; // ≈ 8 Mbps for 1080p30
  const codecK = codec === "h264" ? 1 : codec === "prores" ? 6 : 0.7;
  const k = { lower: 0.6, recommended: 1, higher: 1.6 }[bitrate] ?? 1;
  return Math.round(base * codecK * k);
}

export function estimateSizeBytes(durationUs, videoKbps, audioKbps = 192) {
  return Math.round((((videoKbps || 0) + (audioKbps || 0)) * 1000 * (durationUs / US)) / 8);
}

/**
 * @param {object} tl plain timeline
 * @param {object} o
 *   media: {id: MediaAsset}, overlays: {segId: png path | { path, x, y, w, h } (a Remotion clip and its band)}, luts: {assetId: path}, compoundFiles: {timelineId: path}
 *   width, height, fps, range: {startUs, endUs} | null, video: {codec, format, bitrate, hw}, audio: {enabled, format} ,
 *   mode: "video" | "audio" | "gif" | "still", stillAtUs, gifFps, caps, ffmpegMajor, out
 *
 * Only the exported range is processed: graph time is range-local (t = 0 at the range start), each source is
 * opened at the part it contributes and layers outside the range are skipped. The main track is rendered as a
 * sequence of pieces joined with concat — one piece per stretch in which the same clips are on screen — so a
 * frame composites only the clips visible in it, and a frame-filling clip on its own is passed through as is.
 */
/**
 * Gain expression that keeps the voice and lowers what is between words to -20 dB, for audio that starts at source
 * time `srcFromUs` and plays at `speed` for `durUs`. `regions` = speechRegions() of the file (source µs). 50 ms ramps.
 * Null when the file's words are unknown (nothing is lowered then).
 */
export function betweenWords(regions, srcFromUs, speed, durUs) {
  if (!regions?.length) return null;
  const from = srcFromUs, to = srcFromUs + durUs * speed;
  const r = 0.05, FLOOR = 0.1;
  const T = `(${s(from)}+if(isnan(t),0,t)*${Number(speed.toFixed(6))})`;
  const terms = regions.filter(([a, b]) => b > from && a < to).map(([a, b]) => `clip(min((${T}-${s(a)})/${r},(${s(b)}-${T})/${r}),0,1)`);
  if (!terms.length) return String(FLOOR);
  return `${FLOOR}+${1 - FLOOR}*min(1,${terms.join("+")})`;
}

/**
 * Kept action whose own sound the voice clean-up must leave alone (the edit plan's `audio.keepAmbience`, written by
 * the director): `[{ mediaId, fromUs, toUs }]` in SOURCE time → `{ [mediaId]: [[fromUs, toUs], …] }`, sorted, with
 * overlapping or touching spans merged and anything malformed dropped. Empty → null (the export is unchanged).
 */
export function ambienceByMedia(list) {
  const by = {};
  for (const x of Array.isArray(list) ? list : []) {
    const a = Math.round(Number(x?.fromUs)), b = Math.round(Number(x?.toUs));
    if (typeof x?.mediaId !== "string" || !x.mediaId || !Number.isFinite(a) || !Number.isFinite(b) || b - a < 1000) continue;
    (by[x.mediaId] ||= []).push([Math.max(0, a), b]);
  }
  for (const id of Object.keys(by)) {
    const merged = [];
    for (const [a, b] of by[id].sort((p, q) => p[0] - q[0])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    by[id] = merged;
  }
  return Object.keys(by).length ? by : null;
}

/** Hand-off between the cleaned voice and the kept action's own sound at a span's edges (s, outside the span). */
export const AMBIENCE_RAMP_S = 0.3;

/**
 * Gain expression (0…1) for the kept action's own sound: 1 inside a kept span, ramping over AMBIENCE_RAMP_S outside
 * its edges, 0 elsewhere — for audio that starts at source time `srcFromUs` and plays at `speed` for `durUs` (the same
 * clock as betweenWords). The cleaned voice gets 1 − this, so the two cross-fade. Null when no span touches the piece.
 */
export function keepMask(spans, srcFromUs, speed, durUs) {
  if (!spans?.length) return null;
  const r = AMBIENCE_RAMP_S, rUs = r * US;
  const from = srcFromUs, to = srcFromUs + durUs * speed;
  const near = spans.filter(([a, b]) => b + rUs > from && a - rUs < to);
  if (!near.length) return null;
  const T = `(${s(from)}+if(isnan(t),0,t)*${Number(speed.toFixed(6))})`;
  const terms = near.map(([a, b]) => `clip(min((${T}-${s(a - rUs)})/${r},(${s(b + rUs)}-${T})/${r}),0,1)`);
  return `min(1,${terms.join("+")})`;
}

/** How much a dub's background is lowered under the dubbed voice (dB). */
export const DUB_DUCK_DB = 6;

export function buildExport(tl, o) {
  const W = o.width, H = o.height, FPS = o.fps;
  const FRAME = US / FPS;
  const inputs = [];
  const chains = [];
  let lbl = 0;
  const L = (p = "v") => `${p}${lbl++}`;
  const addInput = (args) => { inputs.push(args); return inputs.length - 1; };

  const tracks = [...tl.tracks].sort((a, b) => a.order - b.order);
  // A dub's background (track "dub:<media>:bg") is lowered under the dub's voice where its clips are now (the voice
  // tracks of that media that are heard), so a line moved by hand takes its ducking with it.
  const trackOf = new Map(tracks.flatMap((t) => t.segments.map((x) => [x.id, t])));
  const duckUnderDub = (seg, tVar) => {
    const m = /^dub:(.+):bg$/.exec(trackOf.get(seg.id)?.role || "");
    if (!m) return null;
    const r = 0.15, ivs = [];
    for (const t of tracks) {
      if (t.muted || !(t.role || "").startsWith(`dub:${m[1]}:voice:`)) continue;
      for (const v of t.segments) {
        const a = (v.start - seg.start) / US, b = (v.start + v.duration - seg.start) / US;
        if (!v.disabled && b > -r && a < seg.duration / US + r) ivs.push(`clip((${tVar}-${a.toFixed(3)}+${r})/${r},0,1)*clip((${b.toFixed(3)}+${r}-${tVar})/${r},0,1)`);
      }
    }
    return ivs.length ? `volume='1-${(1 - 10 ** (-DUB_DUCK_DB / 20)).toFixed(4)}*min(1,${ivs.join("+")})':eval=frame` : null;
  };
  // Music under speech (core/musicBed.js): a music track's clips are lowered where speech is heard (o.musicBed.spans).
  const duckUnderSpeech = (seg, tVar) => {
    const db = duckDbOf(trackOf.get(seg.id));
    return db && o.musicBed?.spans ? duckExpr(o.musicBed.spans, seg.start, seg.duration, tVar, db) : null;
  };

  const total = tracks.reduce((m, t) => Math.max(m, ...t.segments.map((x) => x.start + x.duration), 0), 0);
  if (total <= 0) throw new AppError("VALIDATION", "err.timelineEmpty");
  let rangeStart, rangeEnd;
  if (o.mode === "still") {
    rangeStart = Math.max(0, Math.min(total - 1, o.stillAtUs ?? 0));
    rangeEnd = rangeStart + FRAME;
  } else {
    rangeStart = o.range?.startUs ?? 0;
    rangeEnd = Math.min(o.range?.endUs ?? total, total);
    if (rangeEnd - rangeStart < FRAME) throw new AppError("VALIDATION", "err.rangeEmpty");
  }
  const T0 = rangeStart, LEN = rangeEnd - rangeStart;
  const rel = (us) => s(us - T0); // range-local seconds
  // A layer shows on the output frames whose time falls in [start, end): the first frame at or after a time.
  const frameAt = (us) => Math.ceil((us - T0) / FRAME - 1e-6);
  const snap = (us) => T0 + frameAt(us) * FRAME;
  const inRange = (a, b) => a < rangeEnd && b > rangeStart;
  // Timeline enable window [a, b) in range-local seconds; 1 µs below both ends so a frame exactly at a bound
  // (times print with 6 decimals) is on the right side.
  const during = (a, b) => `between(t,${s(Math.max(0, a - T0 - 1))},${s(b - T0 - 1)})`;
  const wantVideo = o.mode !== "audio";
  const wantAudio = o.mode === "video" ? o.audio?.enabled !== false : o.mode === "audio";
  const bgColor = hex(tl.canvas?.bgColor);
  const blurBg = tl.canvas?.bgType === "blur";
  const hasPixels = (seg) => seg.kind === "video" || seg.kind === "image" || seg.kind === "compound";
  // True when the whole picture stays in the sources' YUV (no RGBA round trip): see mainSequence.
  let yuv = false;
  let rgbCompositeNeeded = true; // set before the main sequence is built

  /** Solid colour stream of `frames` frames whose timestamps start at timeline time `startUs`. */
  function colorStream(color, startUs, frames) {
    const ci = addInput(["-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=${FPS}:d=${s((frames + 1) * FRAME)}`]);
    const out = L();
    chains.push(`[${ci}:v]format=${yuv ? "yuv420p" : "rgba"},trim=end_frame=${frames},setpts=PTS-STARTPTS+${frameAt(startUs)}[${out}]`);
    return out;
  }

  /** True when a clip plays from the stabilized copy of its video (StabilizeService). */
  const usesStab = (seg) => seg.kind === "video" && !!seg.videoFx?.stabilize?.enabled && !!o.stabilized?.[seg.mediaId];
  const mediaOf = (seg) => {
    if (seg.kind === "compound") {
      const p = o.compoundFiles?.[seg.compoundTimelineId];
      if (!p) throw new AppError("MEDIA", "err.compoundNotRendered", { timelineId: seg.compoundTimelineId });
      return { path: p, type: "video", durationUs: seg.sourceDuration || seg.duration, hasAudio: true, hasVideo: true, width: W, height: H, sampleRate: 48000 };
    }
    const m = o.media[seg.mediaId];
    if (!m) throw new AppError("MEDIA", "err.mediaMissing", { segId: seg.id });
    return usesStab(seg) ? o.stabilized[seg.mediaId] : m; // the stabilized copy (same timing and audio)
  };

  /**
   * Source video of a segment for the timeline window [w0, w1] (inside its visible span, which includes the
   * transition pre/post-roll). Timestamps are range-local timeline time; only that part of the file is decoded.
   */
  function videoSource(seg, media, preUs, postUs, w0, w1) {
    const out = rawSource(seg, media, preUs, postUs, w0, w1);
    if (seg.kind !== "video" || seg.videoFx?.matte?.type !== "person") return out;
    // Person cutout: the cached mask video opened with the clip's own timing (source times, speed, pads), stretched
    // to the source frame and merged as alpha — what is under this layer shows around the person.
    const file = o.mattes?.[usesStab(seg) ? `${seg.mediaId}|stab` : seg.mediaId];
    if (!file) throw new AppError("MEDIA", "err.matteMissing", { segId: seg.id });
    const m = rawSource(seg, { ...media, path: file }, preUs, postUs, w0, w1);
    const yv = L(), a = L(), merged = L();
    chains.push(`[${out}]format=yuv420p[${yv}]`);
    chains.push(`[${m}]scale=${media.width || W}:${media.height || H}:flags=bicubic,format=gray[${a}]`);
    chains.push(`[${yv}][${a}]alphamerge[${merged}]`);
    return merged;
  }
  function rawSource(seg, media, preUs, postUs, w0, w1) {
    const speedStd = seg.speedMode === "curve" ? null : seg.speed || 1;
    const visStart = seg.start - preUs, visEnd = seg.start + seg.duration + postUs;
    w0 = Math.max(snap(w0), w0); w1 = Math.max(w0 + FRAME, snap(w1)); // the frames that show it
    const at = (us) => `setpts=PTS-STARTPTS+${frameAt(us)}`; // after fps=…: one tick per frame
    const toWindow = w0 > visStart + 1 || w1 < visEnd - 1 ? `,trim=start=${rel(w0)}:end=${rel(w1)}` : "";
    const out = L();
    if (seg.kind === "image" || seg.kind === "text" || seg.kind === "sticker") {
      // A Remotion graphic's overlay is { path, x, y, w, h }: its clip and the band of the frame it covers.
      const ov = seg.kind === "image" ? media.path : o.overlays?.[seg.id];
      const file = ov && typeof ov === "object" ? ov.path : ov;
      if (!file) throw new AppError("MEDIA", "err.overlayMissing", { segId: seg.id });
      if (/\.ffconcat$/i.test(file)) { // word-timed caption: a timed image sequence from the segment start
        const ii = addInput(["-f", "concat", "-safe", "0", "-i", file]);
        chains.push(`[${ii}:v]format=rgba,fps=${FPS},${at(visStart)}${toWindow}[${out}]`);
      } else if (/\.(mov|webm|mkv)$/i.test(file)) { // Remotion graphic: a transparent clip from the segment start
        const ii = addInput(["-i", file]);
        const band = ov && typeof ov === "object" && (ov.w !== W || ov.h !== H || ov.x || ov.y) ? `,pad=${W}:${H}:${ov.x || 0}:${ov.y || 0}:color=black@0` : ""; // back to the full frame
        chains.push(`[${ii}:v]format=rgba${band},fps=${FPS},${at(visStart)}${toWindow}[${out}]`);
      } else if (/\.gif$/i.test(file)) { // animated: keep its own clock from the visible start
        const ii = addInput(["-ignore_loop", "0", "-t", String(s(visEnd - visStart)), "-i", file]);
        chains.push(`[${ii}:v]fps=${FPS},${at(visStart)}${toWindow}[${out}]`);
      } else {
        const ii = addInput(["-loop", "1", "-framerate", String(FPS), "-t", String(s(w1 - w0 + FRAME)), "-i", file]);
        chains.push(`[${ii}:v]fps=${FPS},${at(w0)}[${out}]`);
      }
      return out;
    }
    if (speedStd) {
      const srcAt = (us) => seg.sourceStart + (us - seg.start) * speedStd;
      const srcFrom = srcAt(w0), srcTo = srcAt(w1);
      let a = Math.max(0, srcFrom), b = Math.min(media.durationUs || srcTo, srcTo);
      if (b - a < FRAME) { a = Math.max(0, Math.min(a, b) - FRAME); b = a + FRAME; } // window past the media end: hold its last frame
      // Pads in whole frames (a duration may round down by one); the end gets a spare frame, cut by trim/enable.
      const padStart = Math.round(Math.max(0, (a - srcFrom) / speedStd) / FRAME), padEnd = srcTo - b > 1000 ? Math.ceil((srcTo - b) / speedStd / FRAME) + 1 : 0;
      const ii = addInput(["-ss", String(s(a)), "-t", String(s(b - a + FRAME / 2)), "-i", media.path]);
      chains.push(`[${ii}:v]setpts=(PTS-STARTPTS)/${speedStd},fps=${FPS}${tpadFrames(padStart, padEnd)},${at(w0)}[${out}]`);
      return out;
    }
    // Speed curve: constant-speed chunks concatenated, then cut to the window.
    const chunks = curveChunks(seg);
    const span = chunks.reduce((m, c) => Math.max(m, c.srcStart + c.srcDur), 0);
    const ii = addInput(["-ss", String(s(seg.sourceStart)), "-t", String(s(Math.min(span, (media.durationUs || span) - seg.sourceStart) + FRAME)), "-i", media.path]);
    const splits = chunks.map(() => L("c"));
    chains.push(`[${ii}:v]split=${chunks.length}${splits.map((x) => `[${x}]`).join("")}`);
    const parts = chunks.map((c, k) => { const p = L("cp"); chains.push(`[${splits[k]}]trim=start=${s(c.srcStart)}:duration=${s(c.srcDur)},setpts=(PTS-STARTPTS)/${Number(c.speed.toFixed(5))},fps=${FPS}[${p}]`); return p; });
    const tpad = tpadFrames(Math.round(preUs / FRAME), postUs ? Math.ceil(postUs / FRAME) + 1 : 0);
    chains.push(`${parts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=1:a=0${tpad},${at(visStart)}${toWindow}[${out}]`);
    return out;
  }

  const tpadFrames = (n0, n1) => (n0 || n1 ? `,tpad=start=${n0}:stop=${n1}:start_mode=clone:stop_mode=clone` : "");
  const uniq = (str) => str.replace(/\[([a-zA-Z]{1,4})\]/g, (_, n) => `[${n}_${lbl}]`);

  /** Per-clip effects, grade, keying and masking; returns new label. */
  function layerLook(seg, inLbl, media) {
    const f = [];
    const isMedia = hasPixels(seg);
    if (isMedia) {
      const c = seg.crop || {};
      if (c.w < 0.999 || c.h < 0.999 || c.x > 0.001 || c.y > 0.001) f.push(`crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y}`);
      const fx = seg.videoFx;
      if (fx?.stabilize?.enabled && !usesStab(seg)) f.push(fx.stabilize.level === "most_stable" ? "deshake=rx=32:ry=32" : "deshake");
      if (fx?.denoise?.enabled) f.push(`hqdn3d=${(1 + fx.denoise.level / 25).toFixed(2)}`);
      if (fx?.motionBlur?.enabled) f.push(`tmix=frames=${Math.max(2, Math.min(10, Math.round(fx.motionBlur.amount)))}`);
      if (seg.kind !== "image") f.push(toRgba(sourceMatrix(media))); // before any RGB grading filter
      f.push(...adjustToFfmpeg(seg.adjust, { lutPath: o.luts?.[seg.adjust?.lut?.assetId], uid: lbl, caps: o.caps }));
      for (const ce of seg.clipEffects || []) if (EFFECTS[ce.type]) f.push(uniq(EFFECTS[ce.type].ffmpeg(ce.intensity ?? 50, rel(seg.start), FPS)));
      if (fx?.chroma?.enabled) f.push(`format=yuva444p,chromakey=color=${hex(fx.chroma.color)}:similarity=${(0.01 + fx.chroma.intensity / 250).toFixed(3)}:blend=${(fx.chroma.shadow / 200 + 0.02).toFixed(3)}`);
    }
    if (seg.transform?.flipH) f.push("hflip");
    if (seg.transform?.flipV) f.push("vflip");
    f.push("format=rgba");
    const m = seg.videoFx?.mask;
    if (isMedia && m && m.type !== "none") f.push(maskGeq(m));
    const out = L();
    chains.push(`[${inLbl}]${f.join(",")}[${out}]`);
    return out;
  }

  /** YUV path look: limited range 4:2:0 (a no-op for the usual H.264/HEVC source), flips only. */
  function yuvLook(seg, inLbl) {
    const out = L();
    chains.push(`[${inLbl}]scale=out_range=tv,format=yuv420p${seg.transform?.flipH ? ",hflip" : ""}${seg.transform?.flipV ? ",vflip" : ""}[${out}]`);
    return out;
  }

  /** geq alpha mask: rect / circle / linear, feather in % of the shorter side, optional invert. */
  function maskGeq(m) {
    const cx = `(W/2+${m.x}*W/2)`, cy = `(H/2+${m.y}*H/2)`;
    const fe = Math.max(0.001, m.feather / 100);
    let inside;
    if (m.type === "circle") inside = `clip((1-hypot((X-${cx})/(${m.w}*W/2),(Y-${cy})/(${m.h}*H/2)))/${fe},0,1)`;
    else if (m.type === "linear") inside = `clip(((Y-${cy})*-1)/(${fe}*H)+0.5,0,1)`;
    else inside = `clip(min((${m.w}*W/2-abs(X-${cx}))/(${fe}*min(W,H)+1),(${m.h}*H/2-abs(Y-${cy}))/(${fe}*min(W,H)+1)),0,1)`;
    const a = m.invert ? `(1-${inside})` : inside;
    return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${a}'`;
  }

  /**
   * Per-frame values of a filter option, set with sendcmd on the frames where they change (cheap filters such as
   * colorchannelmixer then follow an animation exactly, without per-pixel expressions). `values(us)` returns
   * { option: number } for a timeline time; frames [u, v). Returns a filter chain, or "" when nothing is needed.
   */
  function perFrame(filter, u, v, values, isIdentity) {
    const name = `${filter}@k${lbl++}`;
    const frames = [];
    for (let k = frameAt(u); k < frameAt(v); k++) frames.push(values(T0 + k * FRAME));
    const fmt = (o) => Object.entries(o).map(([key, x]) => [key, Number(x.toFixed(6))]);
    if (frames.every((o) => isIdentity(o))) return "";
    const cmds = [];
    for (let i = 1; i < frames.length; i++) {
      const diff = fmt(frames[i]).filter(([key, x]) => x !== Number(frames[i - 1][key].toFixed(6)));
      // A command takes effect from the first frame at or after its time (1 µs early: times print with 6 decimals).
      if (diff.length) cmds.push(`${s(Math.max(0, (frameAt(u) + i) * FRAME - 1))} ${diff.map(([key, x]) => `${name} ${key} ${x}`).join(",")}`);
    }
    const init = `${name}=${fmt(frames[0]).map(([key, x]) => `${key}=${x}`).join(":")}`;
    return cmds.length ? `sendcmd=c='${cmds.join(";")}',${init}` : init;
  }

  /** Clip opacity on frames [u, v) — the formula the preview draws (layerState), applied to the alpha channel. */
  const opacityFrames = (seg, ctx, u, v) => perFrame("colorchannelmixer", u, v, (us) => ({ aa: layerState(NUM, seg, (us - seg.start) / US, ctx).opacity }), (o) => o.aa >= 0.9995);

  /** A frame-filling clip fading to the canvas colour (colour = clip·f + canvas·(1−f)), on frames [u, v). */
  function colourFadeFrames(seg, ctx, u, v) {
    const bg = (tl.canvas?.bgColor || "#000000").replace("#", "");
    const rgb = [0, 2, 4].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255 || 0);
    return perFrame("colorlevels", u, v, (us) => {
      const f = layerState(NUM, seg, (us - seg.start) / US, ctx).opacity;
      const o = {};
      ["r", "g", "b"].forEach((ch, i) => { o[`${ch}omin`] = rgb[i] * (1 - f); o[`${ch}omax`] = rgb[i] * (1 - f) + f; });
      return o;
    }, (o) => o.romin === 0 && o.gomin === 0 && o.bomin === 0 && o.romax === 1 && o.gomax === 1 && o.bomax === 1);
  }

  /**
   * Scale/rotate/opacity per frame and overlay onto the composite during [w0, w1]. `span` = the composite's frames.
   * Layer streams end with their window, so overlays pass the composite through afterwards (eof_action=pass): the
   * default (repeat) keeps working on every later frame — 20 ended layers cost 40 s on a 60 s 1080p export.
   */
  function placeLayer(seg, inLbl, media, ctx, w0, w1, span) {
    const tLocal = `(t-(${rel(seg.start)}))`;
    const st = layerState(EXPR, seg, tLocal, ctx);
    const animated = (e) => /t-/.test(String(e));
    let baseW, baseH;
    if (seg.kind === "text" || seg.kind === "sticker") { baseW = "iw"; baseH = "ih"; }
    else {
      const c = seg.crop || { w: 1, h: 1 };
      const mw = (media.width || W) * (c.w ?? 1), mh = (media.height || H) * (c.h ?? 1);
      const fit = Math.min(W / mw, H / mh);
      baseW = Number((mw * fit).toFixed(3)); baseH = Number((mh * fit).toFixed(3));
    }
    const f = [];
    // Opacity first: geq crashes in FFmpeg 6.1 when its input size changes per frame (animated scale).
    // Transitions only ramp opacity inside their window: set per frame with sendcmd, not with a per-pixel geq.
    if (animated(layerState(EXPR, seg, tLocal, { ...ctx, transIn: null, transOut: null }).opacity)) f.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${String(st.opacity).replace(/\bt\b/g, "T")})'`);
    else { const op = opacityFrames(seg, ctx, w0, w1); if (op) f.push(op); }
    const sx = st.scaleX, sy = st.scaleY;
    if (animated(sx) || animated(sy)) {
      // The layer's size changes per frame; frames leaving a filter at a changing size can stall the graph (seen
      // as a hung export with a zoom transition), so they are centred on a transparent canvas of the largest size.
      let mx = 0, my = 0;
      for (let k = frameAt(w0); k <= frameAt(w1); k++) {
        const v = layerState(NUM, seg, (T0 + k * FRAME - seg.start) / US, ctx);
        mx = Math.max(mx, v.scaleX); my = Math.max(my, v.scaleY);
      }
      const pw = Math.max(2, Math.ceil((Number(baseW === "iw" ? 0 : baseW) * mx) / 2) * 2 + 2), ph = Math.max(2, Math.ceil((Number(baseH === "ih" ? 0 : baseH) * my) / 2) * 2 + 2);
      f.push(`scale=w='max(2,${baseW}*${sx})':h='max(2,${baseH}*${sy})':eval=frame`);
      if (baseW !== "iw") f.push(`format=rgba,pad=w=${pw}:h=${ph}:x='(ow-iw)/2':y='(oh-ih)/2':color=0x00000000:eval=frame`);
    }
    else f.push(`scale=w='max(2,${baseW}*${sx})':h='max(2,${baseH}*${sy})'`);
    if (animated(st.rotation) || Math.abs(Number(st.rotation) || 0) > 0.01) f.push(`rotate=a='(${st.rotation})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none`);
    const placed = L();
    chains.push(`[${inLbl}]${f.join(",")}[${placed}]`);
    const enable = during(w0, w1);
    const x = `(W-w)/2+(${st.x})`, y = `(H-h)/2+(${st.y})`;
    const mode = seg.transform?.blend || "normal";
    const next = L();
    if (mode !== "normal" && BLEND_MODE[mode]) {
      // Blend modes: pad the layer onto a neutral full frame, then blend with the composite.
      const neutral = colorStream(BLEND_NEUTRAL[mode], span.startUs, span.frames);
      const padded = L(), split1 = L(), split2 = L(), blended = L();
      chains.push(`[${neutral}][${placed}]overlay=x='${x}':y='${y}':eval=frame:format=auto:eof_action=pass[${padded}]`);
      chains.push(`[${comp}]split[${split1}][${split2}]`);
      chains.push(`[${split2}][${padded}]blend=all_mode=${BLEND_MODE[mode]}[${blended}]`);
      chains.push(`[${split1}][${blended}]overlay=enable='${enable}':format=auto[${next}]`);
    } else if (yuv) {
      const yl = L();
      chains.push(`[${placed}]${TO_YUVA}[${yl}]`);
      chains.push(`[${comp}][${yl}]overlay=x='${x}':y='${y}':eval=frame:format=yuv420:eof_action=pass:enable='${enable}'[${next}]`);
    } else {
      chains.push(`[${comp}][${placed}]overlay=x='${x}':y='${y}':eval=frame:format=auto:eof_action=pass:enable='${enable}'[${next}]`);
    }
    comp = next;
  }

  /** Blurred, frame-filling copy of a main-track clip (canvas background "blur"). */
  function blurStream(seg, media, inLbl) {
    const out = L();
    chains.push(`[${inLbl}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${(8 + (tl.canvas.bgBlur || 50) / 4).toFixed(1)},${seg.kind === "image" ? "format=rgba" : toRgba(sourceMatrix(media))}[${out}]`);
    return out;
  }
  function overlayFull(inLbl, w0, w1) {
    const next = L();
    if (yuv) { const yl = L(); chains.push(`[${inLbl}]${TO_YUVA}[${yl}]`); inLbl = yl; }
    chains.push(`[${comp}][${inLbl}]overlay=enable='${during(w0, w1)}':format=${yuv ? "yuv420" : "auto"}:eof_action=pass[${next}]`);
    comp = next;
  }

  /** Effect / filter / adjust layer: re-grade the composite inside the segment window. */
  function gradeComposite(seg) {
    let fl = [];
    if (seg.kind === "effect" && EFFECTS[seg.effect?.type]) fl = [uniq(EFFECTS[seg.effect.type].ffmpeg(seg.effect.intensity ?? 50, rel(seg.start), FPS))];
    else if (seg.kind === "filter") fl = adjustToFfmpeg(applyFilterPreset(null, seg.filter?.preset, seg.filter?.intensity ?? 100), { uid: lbl, caps: o.caps });
    else if (seg.kind === "adjust") fl = adjustToFfmpeg(seg.adjust, { lutPath: o.luts?.[seg.adjust?.lut?.assetId], uid: lbl, caps: o.caps });
    if (!fl.length) return;
    const enable = during(seg.start, seg.start + seg.duration);
    // Fast path: every filter is single-input, keeps the frame size and supports the timeline → apply them to
    // the composite in place with enable=… (no split, no full-frame overlay per frame).
    const parts = fl.flatMap(splitFilters);
    if (parts.every((p) => isInPlaceGrade(p, o.caps))) {
      const next = L();
      chains.push(`[${comp}]${parts.map((p) => withEnable(p, enable)).join(",")}[${next}]`);
      comp = next;
      return;
    }
    const a = L(), b = L(), c = L(), next = L();
    chains.push(`[${comp}]split[${a}][${b}]`);
    chains.push(`[${b}]${fl.join(",")},format=rgba[${c}]`);
    chains.push(`[${a}][${c}]overlay=enable='${enable}':format=auto[${next}]`);
    comp = next;
  }

  // ------------------------------------------------------------------ main track as a sequence
  /** True when the clip, as placed, fills the whole frame with opaque pixels and does not move. */
  function coversFrame(c) {
    const { seg, media } = c;
    if (!(seg.kind === "video" || seg.kind === "compound" || (seg.kind === "image" && /\.jpe?g$/i.test(media.path || "")))) return false;
    if (seg.kind === "video" && !OPAQUE_CODECS.has(media.videoCodec)) return false;
    const cr = seg.crop || {};
    if (cr.w < 0.999 || cr.h < 0.999 || cr.x > 0.001 || cr.y > 0.001) return false;
    const tr = seg.transform || {};
    const sx = tr.uniform === false ? tr.scaleX ?? 1 : 1, sy = tr.uniform === false ? tr.scaleY ?? 1 : 1;
    if ((tr.scale ?? 1) !== 1 || sx !== 1 || sy !== 1 || tr.x || tr.y || tr.rotation || (tr.opacity ?? 1) < 1 || (tr.blend && tr.blend !== "normal")) return false;
    if ((seg.keyframes || []).some((k) => k.prop !== "volumeDb")) return false;
    const an = seg.animation || {};
    if ([an.in, an.out, an.combo].some((a) => a && a.type !== "none")) return false;
    const fx = seg.videoFx || {};
    if (fx.chroma?.enabled || (fx.mask && fx.mask.type !== "none") || (fx.matte && fx.matte.type !== "none")) return false;
    const mw = media.width || W, mh = media.height || H, fit = Math.min(W / mw, H / mh);
    return Math.abs(mw * fit - W) < 1 && Math.abs(mh * fit - H) < 1;
  }

  /**
   * Main track as a sequence, or null when its clips overlap (then the general path renders it).
   * Only pieces that need no compositing go into the concat: a frame-filling, unmoving clip passes through as
   * is, gaps are canvas colour. Everything composited — the incoming clip of a transition during its window, a
   * clip that does not fill the frame, blurred backgrounds — is overlaid on the sequence afterwards, so it
   * advances at the output's pace: an overlay inside a piece would pull its inputs ahead of concat and queue
   * frames in memory. Each clip is decoded once (an incoming window, then the clip itself in the sequence),
   * except an outgoing window that has to be composited, which seeks separately.
   */
  function mainSequence(track) {
    const segs = [...track.segments].filter((x) => !x.disabled).sort((a, b) => a.start - b.start);
    const clips = [];
    segs.forEach((seg, i) => {
      if (!isVisualKind(seg.kind)) return;
      const tr = transitionsFor(segs, i);
      const pre = tr.transIn ? (tr.transIn.d * US) / 2 : 0, post = tr.transOut ? (tr.transOut.d * US) / 2 : 0;
      const c = { seg, tr, pre, post, visStart: seg.start - pre, visEnd: seg.start + seg.duration + post };
      c.v0 = snap(Math.max(c.visStart, rangeStart)); c.v1 = snap(Math.min(c.visEnd, rangeEnd)); // frames it shows on
      if (c.v1 <= c.v0) return;
      c.media = seg.kind === "text" || seg.kind === "sticker" ? {} : mediaOf(seg);
      clips.push(c);
    });
    const clip = (u, v, c) => [Math.max(u, c.v0), Math.min(v, c.v1)];
    const temporal = (seg) => { const fx = seg.videoFx || {}; return !!((fx.stabilize?.enabled && !usesStab(seg)) || fx.denoise?.enabled || fx.motionBlur?.enabled); };
    const groups = []; // decode groups: { c, uses: [{ kind: "seq" | "over", u, v, ctx, fades }] }
    for (const c of clips) {
      const end = c.seg.start + c.seg.duration;
      if (!coversFrame(c)) { groups.push({ c, uses: [{ kind: "over", u: c.v0, v: c.v1, ctx: c.tr }] }); continue; }
      const ti = c.tr.transIn, to = c.tr.transOut;
      const outMode = !to || OUT_IDLE.has(to.type) ? "seq" : to.type === "fade_black" && !blurBg ? "fade" : "over";
      const bodyStart = ti ? snap(c.seg.start + c.pre) : c.v0, bodyEnd = outMode === "over" ? snap(end - c.post) : c.v1;
      const first = { c, uses: [] };
      if (ti) { const [u, v] = clip(c.v0, bodyStart, c); if (v > u) first.uses.push({ kind: "over", u, v, ctx: { transIn: ti, transOut: null } }); }
      const [bu, bv] = clip(bodyStart, bodyEnd, c);
      // A frame-filling clip fading to the canvas colour needs no compositing: fade its colour.
      if (bv > bu) first.uses.push({ kind: "seq", c, u: bu, v: bv, fade: outMode === "fade" ? { transIn: null, transOut: to } : null });
      if (first.uses.length) groups.push(first);
      if (outMode === "over") { const [u, v] = clip(bodyEnd, c.v1, c); if (v > u) groups.push({ c, uses: [{ kind: "over", u, v, ctx: { transIn: null, transOut: to } }] }); }
    }
    const seq = groups.flatMap((g) => g.uses.filter((x) => x.kind === "seq")).sort((a, b) => a.u - b.u);
    for (let k = 1; k < seq.length; k++) if (seq[k].u < seq[k - 1].v) return null; // overlapping clips (magnet off)
    // Nothing to composite or grade: frame-filling BT.709 clips with no look, nothing above them, black gaps
    // (the canvas colour is the same in any matrix). Then the picture stays in YUV from decoder to encoder —
    // no RGBA round trip, the source values are kept exactly, and the graph is ~1.5× faster.
    const untouched = (c) => (c.seg.kind === "video" || c.seg.kind === "compound") && sourceMatrix(c.media) === "bt709" && isDefaultAdjust(c.seg.adjust)
      && !c.seg.clipEffects?.length && !temporal(c.seg);
    // The composite can also stay YUV when layers are composited over that sequence (transition windows, text,
    // captions, blurred backgrounds): each layer is converted to YUVA with the BT.709 matrix and blended in YUV,
    // which is what the encoder receives anyway. Only RGB grading (grade layers, colour fades, blend modes) needs
    // an RGBA composite. A timeline of many clips with transitions renders ~2× faster this way.
    yuv = o.mode === "video" && bgColor === "0x000000" && !rgbCompositeNeeded && groups.every((g) => g.uses.every((x) => !x.fade)) && clips.every(untouched);
    // Decode each group once and fan it out to its uses (an overlay window first, then the sequence part).
    const lead = Math.round(US / FRAME) * FRAME;
    const cut = (label, u, v) => { const out = L(); chains.push(`[${label}]trim=start_pts=${frameAt(u)}:end_pts=${frameAt(v)}[${out}]`); return out; };
    const fan = (label, k) => {
      if (k <= 1) return [label];
      const outs = Array.from({ length: k }, () => L());
      chains.push(`[${label}]split=${k}${outs.map((x) => `[${x}]`).join("")}`);
      return outs;
    };
    const seqCovers = (u, v) => seq.some((x) => x.u <= u && x.v >= v);
    for (const g of groups) {
      const { c } = g;
      const u0 = g.uses[0].u, u1 = g.uses[g.uses.length - 1].v;
      for (const x of g.uses) x.blur = x.kind === "over" && blurBg && hasPixels(c.seg) && !seqCovers(x.u, x.v);
      let src = videoSource(c.seg, c.media, c.pre, c.post, temporal(c.seg) ? Math.max(snap(c.visStart), u0 - lead) : u0, u1);
      const blurs = g.uses.filter((x) => x.blur);
      if (blurs.length) {
        const a = L(), b = L();
        chains.push(`[${src}]split[${a}][${b}]`);
        src = a;
        fan(blurStream(c.seg, c.media, b), blurs.length).forEach((lb, k) => { blurs[k].blurLbl = cut(lb, blurs[k].u, blurs[k].v); });
      }
      if (!yuv) fan(layerLook(c.seg, src, c.media), g.uses.length).forEach((lb, k) => { g.uses[k].lbl = cut(lb, g.uses[k].u, g.uses[k].v); });
      else {
        // Sequence parts stay YUV; composited windows get the RGBA look (placeLayer converts them back to YUVA).
        const seqUses = g.uses.filter((x) => x.kind === "seq"), overUses = g.uses.filter((x) => x.kind !== "seq");
        let ys = src, rs = src;
        if (seqUses.length && overUses.length) { ys = L(); rs = L(); chains.push(`[${src}]split[${ys}][${rs}]`); }
        if (seqUses.length) fan(yuvLook(c.seg, ys), seqUses.length).forEach((lb, k) => { seqUses[k].lbl = cut(lb, seqUses[k].u, seqUses[k].v); });
        // Trim first: only the window's frames are converted to RGBA (untouched clips have no time-based look).
        if (overUses.length) fan(rs, overUses.length).forEach((lb, k) => { overUses[k].lbl = layerLook(c.seg, cut(lb, overUses[k].u, overUses[k].v), c.media); });
      }
    }
    // The sequence: clip parts and canvas-colour gaps, frame-exact.
    const pieces = [];
    const gap = (u, v) => { const g = colorStream(bgColor, u, frameAt(v) - frameAt(u)), out = L(); chains.push(`[${g}]setpts=PTS-STARTPTS[${out}]`); pieces.push(out); };
    let at = snap(rangeStart);
    for (const x of seq) {
      if (x.u > at) gap(at, x.u);
      const out = L(), fade = x.fade ? colourFadeFrames(x.c.seg, x.fade, x.u, x.v) : "";
      chains.push(`[${x.lbl}]scale=${W}:${H},setsar=1${fade ? "," + fade : ""},setpts=PTS-STARTPTS,tpad=stop=2:stop_mode=clone,trim=end_frame=${frameAt(x.v) - frameAt(x.u)}[${out}]`);
      pieces.push(out);
      at = x.v;
    }
    if (snap(rangeEnd) > at) gap(at, snap(rangeEnd));
    if (pieces.length === 1) comp = pieces[0];
    else {
      comp = L();
      // concat stamps in microseconds (frame 180 at 30 fps → 5.999999 s): back to one tick per frame.
      chains.push(`${pieces.map((p) => `[${p}]`).join("")}concat=n=${pieces.length}:v=1:a=0,settb=1/${FPS},setpts=N[${comp}]`);
    }
    // Composited parts, bottom first: blurred backgrounds under all clips, then clips in timeline order.
    const overs = groups.flatMap((g) => g.uses.filter((x) => x.kind === "over").map((x) => ({ c: g.c, ...x })));
    for (const x of overs) if (x.blur) overlayFull(x.blurLbl, x.u, x.v);
    const span = { startUs: T0, frames: frameAt(rangeEnd) + FPS };
    for (const x of overs.sort((a, b) => a.c.seg.start - b.c.seg.start || a.u - b.u)) placeLayer(x.c.seg, x.lbl, x.c.media, { W, H, ...x.ctx }, x.u, x.v, span);
    return comp;
  }

  /** General path for a main track that holds grade segments or has visible tracks under it. */
  function mainOverlays(track, span) {
    const segs = [...track.segments].filter((x) => !x.disabled).sort((a, b) => a.start - b.start);
    const items = [];
    segs.forEach((seg, i) => {
      if (isGrade(seg.kind)) { if (inRange(seg.start, seg.start + seg.duration)) items.push({ grade: seg }); return; }
      if (!isVisualKind(seg.kind)) return;
      const tr = transitionsFor(segs, i);
      const pre = tr.transIn ? (tr.transIn.d * US) / 2 : 0, post = tr.transOut ? (tr.transOut.d * US) / 2 : 0;
      const w0 = Math.max(seg.start - pre, rangeStart), w1 = Math.min(seg.start + seg.duration + post, rangeEnd);
      if (w1 <= w0) return;
      const media = seg.kind === "text" || seg.kind === "sticker" ? {} : mediaOf(seg);
      let src = videoSource(seg, media, pre, post, w0, w1);
      if (blurBg && hasPixels(seg)) { const a = L(), b = L(); chains.push(`[${src}]split[${a}][${b}]`); src = a; overlayFull(blurStream(seg, media, b), w0, w1); }
      items.push({ seg, media, src, tr, w0, w1 });
    });
    for (const it of items) {
      if (it.grade) gradeComposite(it.grade);
      else placeLayer(it.seg, layerLook(it.seg, it.src, it.media), it.media, { W, H, ...it.tr }, it.w0, it.w1, span);
    }
  }

  // ------------------------------------------------------------------ video layers
  let comp = null;
  const allTracks = tracks;
  if (wantVideo) {
    // J/L cuts: the picture is laid with its own edit points (core/timelineOps.js pictureTracks); the sound below keeps
    // the clips' edit points.
    const tracks = pictureTracks(allTracks, (seg) => o.media[seg.mediaId]?.durationUs || null);
    const main = tracks.find((t) => t.isMain);
    const shows = (t) => !t.hidden && t.segments.some((x) => !x.disabled && (isVisualKind(x.kind) || isGrade(x.kind)));
    const sequence = main && !main.hidden && !main.segments.some((x) => !x.disabled && isGrade(x.kind)) && !tracks.some((t) => t !== main && t.order <= main.order && shows(t));
    const span = { startUs: T0, frames: frameAt(rangeEnd) + FPS };
    rgbCompositeNeeded = tracks.some((t) => !t.hidden && t.segments.some((x) => !x.disabled && inRange(x.start, x.start + x.duration) && (isGrade(x.kind) || (x.transform?.blend && x.transform.blend !== "normal"))));
    const inSequence = sequence && mainSequence(main) !== null;
    if (!inSequence) comp = colorStream(bgColor, T0, span.frames);
    const cutoutAfter = cutoutAfterTrack(tl);
    const layTrack = (track) => {
      if (track.hidden || (inSequence && track === main)) return;
      if (track.isMain) { mainOverlays(track, span); return; }
      const segs = [...track.segments].filter((x) => !x.disabled).sort((a, b) => a.start - b.start);
      for (const seg of segs) {
        if (isGrade(seg.kind)) { if (inRange(seg.start, seg.start + seg.duration)) gradeComposite(seg); continue; }
        if (!isVisualKind(seg.kind)) continue;
        const w0 = Math.max(seg.start, rangeStart), w1 = Math.min(seg.start + seg.duration, rangeEnd);
        if (w1 <= w0) continue;
        const media = seg.kind === "text" || seg.kind === "sticker" ? {} : mediaOf(seg);
        const src = videoSource(seg, media, 0, 0, w0, w1);
        placeLayer(seg, layerLook(seg, src, media), media, { W, H, transIn: null, transOut: null }, w0, w1, span);
      }
    };
    for (const track of tracks) {
      layTrack(track);
      // Text behind the person: the person, cut out of the main clip, over the behind tracks (core/cutout.js).
      if (track.id === cutoutAfter) {
        for (const c of cutoutLayers({ ...tl, tracks }, { startUs: rangeStart, endUs: rangeEnd })) {
          const media = mediaOf(c.seg);
          placeLayer(c.seg, layerLook(c.seg, videoSource(c.seg, media, 0, 0, c.a, c.b), media), media, { W, H, transIn: null, transOut: null }, c.a, c.b, span);
        }
      }
    }
  }

  // ------------------------------------------------------------------ audio
  const audioLabels = [];
  // Constant-speed segments cut from the same file share ONE audio input (opened at the earliest part used and
  // split), instead of one demuxer per segment: a 30-cut timeline opened the file 30 times. Video is not demuxed.
  const sharedAudio = new Map(); // path -> { base, end, n, labels: [], next }
  const audioSpan = (seg) => {
    const a0 = Math.max(seg.start, rangeStart), a1 = Math.min(seg.start + seg.duration, rangeEnd), speed = seg.speed || 1;
    const from = seg.sourceStart + (a0 - seg.start) * speed;
    return { from, srcDur: (a1 - a0) * speed };
  };
  if (wantAudio) {
    for (const track of tracks) {
      if (track.muted) continue;
      for (const seg of track.segments) {
        const audible = seg.kind === "audio" || ((seg.kind === "video" || seg.kind === "compound") && !seg.audioDetached);
        if (seg.disabled || !audible || seg.speedMode === "curve" || !inRange(seg.start, seg.start + seg.duration)) continue;
        const media = mediaOf(seg);
        if (!media.hasAudio) continue;
        const { from, srcDur } = audioSpan(seg);
        const e = sharedAudio.get(media.path) || { base: Infinity, end: 0, n: 0 };
        e.base = Math.min(e.base, from); e.end = Math.max(e.end, Math.min(from + srcDur, media.durationUs || from + srcDur)); e.n++;
        sharedAudio.set(media.path, e);
      }
    }
    for (const [p, e] of sharedAudio) {
      if (e.n < 2) { sharedAudio.delete(p); continue; }
      const ii = addInput(["-vn", "-ss", String(s(e.base)), "-t", String(s(e.end - e.base + US / 10)), "-i", p]);
      e.labels = Array.from({ length: e.n }, () => L("as"));
      e.next = 0;
      chains.push(`[${ii}:a]asplit=${e.n}${e.labels.map((x) => `[${x}]`).join("")}`);
    }
    for (const track of tracks) {
      if (track.muted) continue;
      for (const seg of track.segments) {
        if (seg.disabled) continue;
        const audible = seg.kind === "audio" || ((seg.kind === "video" || seg.kind === "compound") && !seg.audioDetached);
        if (!audible) continue;
        if (!inRange(seg.start, seg.start + seg.duration)) continue;
        const media = mediaOf(seg);
        if (!media.hasAudio) continue;
        audioLabels.push(audioChain(seg, media));
      }
    }
  }

  /** Audio of the part of a segment inside the range, delayed to its range-local position. */
  function audioChain(seg, media) {
    const sr = media.sampleRate || 48000;
    const a0 = Math.max(seg.start, rangeStart), a1 = Math.min(seg.start + seg.duration, rangeEnd);
    const skip = a0 - seg.start; // part of the segment before the range
    const fx = [];
    let head, tail;
    if (seg.speedMode === "curve") {
      const chunks = curveChunks(seg);
      const span = chunks.reduce((m, c) => Math.max(m, c.srcStart + c.srcDur), 0);
      const ii = addInput(["-ss", String(s(seg.sourceStart)), "-t", String(s(span + US / 10)), "-i", media.path]);
      const splits = chunks.map(() => L("ac"));
      chains.push(`[${ii}:a]asplit=${chunks.length}${splits.map((x) => `[${x}]`).join("")}`);
      const parts = chunks.map((c, k) => { const p = L("ap"); chains.push(`[${splits[k]}]atrim=start=${s(c.srcStart)}:duration=${s(c.srcDur)},asetpts=PTS-STARTPTS,${atempoChain(c.speed)}[${p}]`); return p; });
      head = L("a");
      chains.push(`${parts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=0:a=1[${head}]`);
      tail = `atrim=start=${s(skip)}:duration=${s(a1 - a0)},asetpts=PTS-STARTPTS`;
    } else {
      const speed = seg.speed || 1;
      const from = seg.sourceStart + skip * speed, srcDur = (a1 - a0) * speed;
      head = L("a");
      const sp = Math.abs(speed - 1) < 1e-6 ? "" : seg.changePitch ? `,asetrate=${Math.round(sr * speed)},aresample=${sr}` : `,${atempoChain(speed)}`;
      const shared = sharedAudio.get(media.path);
      if (shared) {
        const lb = shared.labels[shared.next++];
        chains.push(`[${lb}]atrim=start=${s(from - shared.base)}:duration=${s(Math.max(US / 100, srcDur))},asetpts=PTS-STARTPTS,aresample=48000${sp}[${head}]`);
      } else {
        const ii = addInput(["-vn", "-ss", String(s(from)), "-t", String(s(Math.max(US / 100, Math.min(srcDur, (media.durationUs || srcDur + from) - from)))), "-i", media.path]);
        chains.push(`[${ii}:a]asetpts=PTS-STARTPTS,aresample=48000${sp}[${head}]`);
      }
      tail = `atrim=duration=${s(a1 - a0)}`;
    }
    const a = seg.audioFx;
    if (a?.denoise?.enabled) {
      // Neural speech denoiser (RNNoise) when its model is available, else the FFT denoiser; then, when the words
      // of this file are known, everything between them (breaths, handling noise, room tone) is lowered smoothly.
      const clean = [o.rnnModel ? `highpass=f=70,arnndn=model='${o.rnnModel.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : AUDIO_CHAINS.denoise];
      const srcFrom = seg.sourceStart + skip * (seg.speed || 1);
      const duck = seg.speedMode === "curve" ? null : betweenWords(o.speech?.[seg.mediaId], srcFrom, seg.speed || 1, a1 - a0);
      if (duck) clean.push(`volume='${duck}':eval=frame`);
      // Kept wordless action (the plan's keepAmbience): RNNoise would gate a crowd or a game away and the between-words
      // gain would lower it to −20 dB, so over those spans the clip's own sound is used instead, cross-faded with the
      // cleaned voice over AMBIENCE_RAMP_S at each edge. Without spans the chain is exactly as before.
      const keep = seg.speedMode === "curve" ? null : keepMask(o.keepAmbience?.[seg.mediaId], srcFrom, seg.speed || 1, a1 - a0);
      if (keep) {
        const toClean = L("ac"), toRaw = L("ar"), cleaned = L("ac"), raw = L("ar"), both = L("a");
        chains.push(`[${head}]asplit=2[${toClean}][${toRaw}]`);
        chains.push(`[${toClean}]${clean.join(",")},volume='1-${keep}':eval=frame[${cleaned}]`);
        chains.push(`[${toRaw}]volume='${keep}':eval=frame[${raw}]`);
        chains.push(`[${cleaned}][${raw}]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0[${both}]`);
        head = both;
      } else fx.push(...clean);
    }
    if (a?.enhanceVoice?.enabled) fx.push(AUDIO_CHAINS.enhanceVoice);
    if (a?.isolate === "remove_vocal" || a?.isolate === "keep_vocal") fx.push(AUDIO_CHAINS[a.isolate]);
    if (a?.voiceChanger && a.voiceChanger !== "none" && VOICE_CHANGERS[a.voiceChanger]) fx.push(VOICE_CHANGERS[a.voiceChanger](48000));
    // Loudness: one static gain on the whole mix when the export measured it (o.masterGainDb, two passes) — a
    // per-clip dynamic loudnorm lifted the pauses and noise between words by >10 dB.
    if (a?.normalize?.enabled && o.masterGainDb === undefined && !o.measureLoudness) fx.push(`loudnorm=I=${a.normalize.targetLufs}:TP=-1.5:LRA=11`);
    // t is NAN on frames without a timestamp; a curve keeps the whole segment until `tail`, a constant speed
    // starts `skip` into it.
    const tSeg = seg.speedMode === "curve" || !skip ? "if(isnan(t),0,t)" : `(if(isnan(t),0,t)+${s(skip)})`;
    fx.push(`aformat=sample_rates=48000:channel_layouts=stereo`);
    fx.push(`volume='${gainAt(EXPR, seg, tSeg)}':eval=frame`);
    fx.push(duckUnderDub(seg, tSeg));
    fx.push(duckUnderSpeech(seg, tSeg));
    fx.push(tail);
    const delay = Math.max(0, Math.round((a0 - rangeStart) / 1000));
    fx.push(`adelay=${delay}|${delay}`);
    const out = L("a");
    chains.push(`[${head}]${fx.filter(Boolean).join(",")}[${out}]`);
    return out;
  }

  // ------------------------------------------------------------------ outputs
  const lenS = s(LEN);
  let vOut = null, aOut = null;
  if (wantVideo) {
    vOut = "vout";
    if (o.mode === "gif") {
      const g = o.gifHeight || 320;
      chains.push(`[${comp}]trim=end=${lenS},setpts=PTS-STARTPTS,fps=${o.gifFps || 15},scale=-2:${g}:flags=lanczos,split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=bayer:bayer_scale=4[${vOut}]`);
    } else if (o.mode === "still") {
      chains.push(`[${comp}]trim=end_frame=1,setpts=PTS-STARTPTS,format=rgb24[${vOut}]`);
    } else {
      chains.push(`[${comp}]trim=end=${lenS},setpts=PTS-STARTPTS,${yuv ? "format=yuv420p" : OUT_YUV}[${vOut}]`);
    }
  }
  if (wantAudio && o.mode !== "gif" && o.mode !== "still") {
    aOut = "aout";
    // Master: the measured static gain (two-pass loudness), then a true-peak-safe limiter. alimiter's auto level is
    // off: it raised the whole mix back to 0 dB peak, noise included.
    const master = o.measureLoudness ? "ebur128=framelog=quiet" : o.masterGainDb !== undefined ? `volume=${o.masterGainDb.toFixed(2)}dB,alimiter=limit=0.84:attack=5:release=60:level=0` : "alimiter=limit=0.97:level=0";
    if (audioLabels.length) chains.push(`${audioLabels.map((x) => `[${x}]`).join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=${lenS},atrim=end=${lenS},asetpts=PTS-STARTPTS,${master}[${aOut}]`);
    else { const ni = addInput(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${lenS}`]); chains.push(`[${ni}:a]anull[${aOut}]`); }
  }

  const graph = chains.join(";\n");
  const encode = [];
  if (vOut) encode.push("-map", `[${vOut}]`);
  if (aOut) encode.push("-map", `[${aOut}]`);
  if (o.mode === "video") encode.push(...videoCodecArgs(o, W, H, FPS), ...(aOut ? audioCodecArgs(o.video?.format === "mov" ? "aac" : "aac") : []), "-movflags", "+faststart");
  else if (o.mode === "audio") encode.push(...audioCodecArgs(o.audio?.format || "flac"));
  else if (o.mode === "gif") encode.push("-loop", "0");
  else if (o.mode === "still") encode.push("-frames:v", "1");
  const durationUs = o.mode === "still" ? FRAME : LEN;
  return { inputs: inputs.flat(), graph, encode, durationUs, width: W, height: H };
}

/**
 * Frame-aligned parts for rendering a long video export in several FFmpeg runs (each part is a range export —
 * frame-identical to the same frames of a single run — and the parts are joined by stream copy). One graph per
 * long timeline would open every clip's decoder at once and pass every frame through every layer's overlay;
 * a part closes at a main-track cut once it holds `maxItems` timeline items. Returns [{ startUs, endUs }].
 */
export function planSegments(tl, { range = null, fps, maxItems = 8, minUs = 2 * US }) {
  const FRAME = US / fps;
  const total = tl.tracks.reduce((m, t) => Math.max(m, ...t.segments.map((x) => x.start + x.duration), 0), 0);
  const a = range?.startUs ?? 0, b = Math.min(range?.endUs ?? total, total);
  const grid = (us) => a + Math.ceil((us - a) / FRAME - 1e-6) * FRAME;
  const items = tl.tracks.filter((t) => !t.hidden).flatMap((t) => t.segments.filter((x) => !x.disabled));
  const main = tl.tracks.find((t) => t.isMain);
  const cuts = [...new Set((main?.segments || []).map((x) => grid(x.start)))].filter((x) => x > a && x < b).sort((x, y) => x - y);
  const count = (u, v) => items.filter((x) => x.start < v && x.start + x.duration > u).length;
  const parts = [];
  let from = a, last = null;
  for (const c of cuts) {
    if (last !== null && count(from, c) > maxItems) { parts.push({ startUs: from, endUs: last }); from = last; last = null; }
    if (c - from >= minUs && b - c >= minUs) last = c;
  }
  parts.push({ startUs: from, endUs: b });
  return parts;
}

// Largest frame side each hardware encoder accepts (H.264 NVENC/QSV/AMF stop at 4096, HEVC at 8192).
const HW_MAX_SIDE = { h264_nvenc: 4096, h264_qsv: 4096, h264_amf: 4096, hevc_nvenc: 8192, hevc_qsv: 8192 };

/**
 * Choose the video encoder for a codec at a frame size. Hardware encoders are used only when enabled, present
 * and able to encode the size. Above the H.264 hardware limit (4096 px, e.g. 8K) an H.264 export switches to
 * hardware HEVC when the GPU has it — as CapCut does — rather than to software x264, which is ~5× slower;
 * otherwise the software encoder of the same codec is used. Returns { name, hwFallback, switchedTo }:
 * hwFallback is true when hardware was wanted but software is used; switchedTo names a changed codec.
 */
export function pickVideoEncoder(codec, { hw = false, encoders = null, width, height }) {
  const side = Math.max(width, height);
  const hwFor = (c) => (hw && encoders ? ({ hevc: ["hevc_nvenc", "hevc_qsv"], h264: ["h264_nvenc", "h264_qsv", "h264_amf"] }[c] || []).filter((e) => encoders.has(e)) : []);
  const kind = codec === "hevc" ? "hevc" : codec === "h264" || !codec ? "h264" : "none";
  const available = hwFor(kind);
  const usable = available.find((e) => side <= HW_MAX_SIDE[e]);
  if (usable) return { name: usable, hwFallback: false, switchedTo: null };
  if (kind === "h264") {
    const hevc = hwFor("hevc").find((e) => side <= HW_MAX_SIDE[e]);
    if (hevc) return { name: hevc, hwFallback: false, switchedTo: "hevc" };
  }
  const software = { hevc: "libx265", av1: encoders?.has("libsvtav1") ? "libsvtav1" : "libaom-av1", prores: "prores_ks", prores_alpha: "prores_ks" }[codec] || "libx264";
  return { name: software, hwFallback: available.length > 0, switchedTo: null };
}

/**
 * NVENC speed presets, chosen by measurement (bench/results/nvenc_presets.json): 7 kinds of content (grain,
 * fine random detail, dark gradients, pan, fractal zoom, geometry, test pattern) at the Recommended bitrate,
 * VMAF/PSNR/SSIM against near-lossless masters. The fastest preset whose worst-case VMAF is within 1 point of
 * p5: H.264 p3 (worst −0.57; ≈2× faster than p5 at 1080p and 4K). HEVC keeps p4 (p3 loses 3.5 VMAF on fine
 * random detail).
 */
export const NVENC_PRESET = { h264: "p3", hevc: "p4" };

function videoCodecArgs(o, W, H, FPS) {
  const v = o.video || {};
  const enc = o.caps?.encoders;
  const kbps = videoBitrateKbps({ width: W, height: H, fps: FPS, bitrate: v.bitrate, codec: v.codec });
  const rate = ["-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps * 2}k`];
  const color = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  const { name } = pickVideoEncoder(v.codec || "h264", { hw: !!v.hw, encoders: enc, width: W, height: H });
  // Software encoders above 4096 px: with automatic threads x264 peaked at 30 GB at 8K and failed to allocate on a
  // 64 GB machine (2 runs in 6); 16 threads and a 20-frame lookahead keep it near 13 GB, at ~40 % more time.
  // (Hardware HEVC is the default above 4096 px; this is the path with hardware encoding off.)
  const big = Math.max(W, H) > 4096 ? ["-threads", "16", "-rc-lookahead", "20"] : [];
  switch (name) {
    case "hevc_nvenc": return ["-c:v", "hevc_nvenc", "-preset", NVENC_PRESET.hevc, ...rate, "-pix_fmt", "yuv420p", "-tag:v", "hvc1", ...color];
    case "hevc_qsv": return ["-c:v", "hevc_qsv", ...rate, "-tag:v", "hvc1", ...color];
    case "libx265": return ["-c:v", "libx265", "-preset", "medium", ...(big.length ? ["-threads", "16"] : []), ...rate, "-pix_fmt", "yuv420p", "-tag:v", "hvc1", ...color];
    case "libsvtav1": return ["-c:v", "libsvtav1", ...rate, "-pix_fmt", "yuv420p", ...color];
    case "libaom-av1": return ["-c:v", "libaom-av1", "-cpu-used", "6", "-row-mt", "1", ...rate, "-pix_fmt", "yuv420p", ...color];
    case "prores_ks":
      return v.codec === "prores_alpha" ? ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"] : ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", ...color];
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", NVENC_PRESET.h264, ...rate, "-pix_fmt", "yuv420p", ...color];
    case "h264_qsv": return ["-c:v", "h264_qsv", ...rate, ...color];
    case "h264_amf": return ["-c:v", "h264_amf", ...rate, ...color];
    default: return ["-c:v", "libx264", "-preset", "medium", ...big, ...rate, "-pix_fmt", "yuv420p", "-profile:v", "high", ...color];
  }
}

function audioCodecArgs(format) {
  switch (format) {
    case "flac": return ["-c:a", "flac"];
    case "mp3": return ["-c:a", "libmp3lame", "-b:a", "256k"];
    case "wav": return ["-c:a", "pcm_s16le"];
    default: return ["-c:a", "aac", "-b:a", "192k"];
  }
}
