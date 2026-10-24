// Text behind the person. Layers on tracks with role "behind" (right above the main track) show UNDER a cutout of
// the person: the main-track clip itself, drawn again over them with its person matte (videoFx.matte), only while
// a behind layer is on screen. The cutout is derived at render time, never stored — trims, moves and ripple edits
// of the clip cannot put it out of sync. Used by the export graph, the preview and the editing operations.
export const BEHIND = "behind";
export const isBehindTrack = (t) => t?.role === BEHIND;
const BEHIND_KINDS = new Set(["text", "sticker", "image", "video"]);
export const canGoBehind = (seg) => BEHIND_KINDS.has(seg.kind);

/** Merged windows [a, b) in which a behind layer is visible, clipped to `range` ({ startUs, endUs }) if given. */
export function behindWindows(tl, range = null) {
  const spans = [];
  for (const t of tl.tracks) {
    if (!isBehindTrack(t) || t.hidden) continue;
    for (const s of t.segments) {
      if (s.disabled) continue;
      const a = Math.max(s.start, range?.startUs ?? -Infinity), b = Math.min(s.start + s.duration, range?.endUs ?? Infinity);
      if (b > a) spans.push([a, b]);
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/** The main-track clip shown as a cutout: same clip, person matte on, silent (its audio plays once, from the clip). */
export const cutoutOf = (seg) => ({ ...seg, videoFx: { ...(seg.videoFx || {}), matte: { type: "person" } }, audioDetached: true, cutout: true });

/** Cutout layers [{ seg, a, b }]: main-track video clips × behind windows. */
export function cutoutLayers(tl, range = null) {
  const main = tl.tracks.find((t) => t.isMain);
  if (!main || main.hidden) return [];
  const wins = behindWindows(tl, range);
  if (!wins.length) return [];
  const out = [];
  for (const seg of main.segments) {
    if (seg.disabled || seg.kind !== "video") continue;
    const s0 = seg.start, s1 = seg.start + seg.duration;
    for (const [a, b] of wins) {
      const u = Math.max(a, s0), v = Math.min(b, s1);
      if (v > u) out.push({ seg: cutoutOf(seg), a: u, b: v });
    }
  }
  return out;
}

/** Media ids the cutouts need a person matte for. */
export const cutoutMedia = (tl) => [...new Set(cutoutLayers(tl).map((c) => c.seg.mediaId))];

/** Id of the track the cutouts are drawn right after: the topmost behind track (above the main track), or null. */
export function cutoutAfterTrack(tl) {
  const main = tl.tracks.find((t) => t.isMain);
  const behind = tl.tracks.filter((t) => isBehindTrack(t) && (!main || t.order > main.order)).sort((x, y) => y.order - x.order);
  return behind[0]?.id || null;
}
