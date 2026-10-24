// Shared helpers used by the main process, services and the renderer (pure ES module, no Node/DOM APIs).

export const US = 1_000_000; // microseconds per second — the time unit used everywhere (as in the report's draft model)

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for very old runtimes; RFC4122 v4 shape.
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, p) => a + (b - a) * p;
export const deepClone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function deepMerge(target, patch) {
  const out = Array.isArray(target) ? [...target] : { ...(target || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** "HH:MM:SS:FF" timecode for a microsecond value at the given fps (the report's Time code setting). */
export function formatTimecode(us, fps = 30) {
  const totalFrames = Math.round((Math.max(0, us) / US) * fps);
  const f = totalFrames % Math.round(fps);
  const s = Math.floor(totalFrames / Math.round(fps));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return [hh, mm, ss, f].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Short "mm:ss" (or "h:mm:ss") used on cards and the media bin. */
export function formatDuration(us) {
  const s = Math.round(Math.max(0, us) / US);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  const u = ["B", "K", "M", "G", "T"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g <= 0 ? -60 : 20 * Math.log10(g));

/** Snap a microsecond time to the nearest frame boundary. */
export const snapToFrame = (us, fps) => Math.round((us / US) * fps) * (US / fps);
