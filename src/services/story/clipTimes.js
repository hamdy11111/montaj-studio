// Phase 8 (story order): when each clip was shot — the time hints of core/story.js. A phone writes the moment it
// started recording into the file (QuickTime `com.apple.quicktime.creationdate`, MP4 `creation_time` in the
// container or the video stream); without it the file's own modified time is used, marked as weaker (a copy or a
// messenger resets it). Pieces of one file share its time and keep their offset in it.
import fs from "node:fs";
import { ffprobe } from "../ffmpeg.js";

/** The recording time a probe result carries (ms since 1970) and where it came from, or null. Pure. */
export function probeTime(info) {
  const tags = [info?.format?.tags || {}, ...(info?.streams || []).map((s) => s.tags || {})];
  for (const key of ["com.apple.quicktime.creationdate", "creation_time", "date"]) {
    for (const t of tags) {
      const v = t[key] ?? t[key.toUpperCase()];
      const ms = v ? Date.parse(v) : NaN;
      // 1970 / 1904 placeholders (an empty QuickTime date) are not a time.
      if (Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1)) return { ms, source: key };
    }
  }
  return null;
}

/**
 * Recording times of media files: Map(path → { ms, source: "creation_time" | "com.apple.quicktime.creationdate" |
 * "file" } | null). probe: injectable (tests); a file that cannot be read gets null.
 */
export async function mediaTimes(paths, { probe = ffprobe } = {}) {
  const out = new Map();
  for (const p of [...new Set(paths)]) {
    let t = null;
    try { t = probeTime(await probe(p)); } catch { /* unreadable: the file time below */ }
    if (!t) { try { t = { ms: fs.statSync(p).mtimeMs, source: "file" }; } catch { t = null; } }
    out.set(p, t);
  }
  return out;
}
