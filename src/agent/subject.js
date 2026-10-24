// Where the person's head is on screen during a stretch of the timeline — for graphics that follow the person or
// come out from behind them. Read from the person matte of the main-track clip under each moment (its stabilized
// copy when the clip is stabilized) and placed like the export places the clip: fit to the canvas, then the clip's
// own position, zoom, keyframes and animations (layerState). 10 samples a second.
import { US } from "../core/util.js";
import { mainTrack } from "../core/model.js";
import { layerState, NUM } from "../core/layerMath.js";

const r3 = (x) => Math.round(x * 1000) / 1000;

/** True when the mattes this stretch needs exist already (no model run). */
export function subjectReady(ctx, timelineId, atUs, durationUs) {
  const S = ctx.services, tl = S.timelines.get(timelineId).timeline;
  return clipsUnder(tl, atUs, durationUs).every((seg) => S.mattes.ready(seg.mediaId, seg.videoFx?.stabilize?.enabled && S.stabilizer ? "stab" : ""));
}

function clipsUnder(tl, atUs, durationUs) {
  return (mainTrack(tl)?.segments || []).filter((s) => s.kind === "video" && !s.disabled && s.start < atUs + durationUs && s.start + s.duration > atUs);
}

/** { track: [[ms, hx, hy, hw, hh, x0, x1], …] } relative to atUs; empty track when no video is under it. */
export async function subjectTrack(ctx, timelineId, atUs, durationUs, { onProgress } = {}) {
  const S = ctx.services, tl = S.timelines.get(timelineId).timeline;
  const W = tl.canvas?.width || 1920, H = tl.canvas?.height || 1080;
  const segs = clipsUnder(tl, atUs, durationUs);
  const tracks = new Map(), out = [];
  for (let t = atUs; t <= atUs + durationUs; t += US / 10) {
    const seg = segs.find((s) => t >= s.start && t < s.start + s.duration);
    if (!seg) continue;
    const stab = !!seg.videoFx?.stabilize?.enabled && !!S.stabilizer;
    const key = `${seg.mediaId}|${stab}`;
    if (!tracks.has(key)) {
      const opts = stab ? { variant: "stab", source: await S.stabilizer.ensure(seg.mediaId, { fps: tl.fps || 30 }) } : {};
      tracks.set(key, await S.mattes.track(seg.mediaId, { ...opts, onProgress }));
    }
    const tr = tracks.get(key);
    if (!tr.length) continue;
    const src = seg.sourceStart + (t - seg.start) * (seg.speedMode === "curve" ? 1 : seg.speed || 1);
    let lo = 0, hi = tr.length - 1; // nearest sample by source time
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tr[mid][0] < src) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(tr[lo - 1][0] - src) < Math.abs(tr[lo][0] - src)) lo--;
    const [, x0, , x1, , hx, hy, hw, hh] = tr[lo];
    // Place like the export: the media fitted to the canvas, then the clip's position and zoom at that moment.
    const m = S.repos.media.get(seg.mediaId);
    const fit = Math.min(W / (m.width || W), H / (m.height || H));
    const bw = ((m.width || W) * fit) / W, bh = ((m.height || H) * fit) / H;
    const st = layerState(NUM, seg, (t - seg.start) / US, { W, H, transIn: null, transOut: null });
    const X = (nx) => 0.5 + st.x / W + (nx - 0.5) * bw * st.scaleX, Y = (ny) => 0.5 + st.y / H + (ny - 0.5) * bh * st.scaleY;
    out.push([Math.round((t - atUs) / 1000), r3(X(hx)), r3(Y(hy)), r3(hw * bw * st.scaleX), r3(hh * bh * st.scaleY), r3(X(x0)), r3(X(x1))]);
  }
  return { track: out };
}
