// Adding a bundled sound effect to a timeline: the sound file becomes a media item of the project (once) and an audio
// clip is placed so its accent lands on the given moment (SFX[sound].leadUs earlier), at the sound's default level.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/validation.js";
import { SFX } from "../core/sfx.js";

const SFX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "audio", "sfx").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
export const sfxPath = (sound) => path.join(SFX_DIR, SFX[sound].file);

/** Returns { clipId, sound, atUs } — atUs is where the clip starts. */
export async function addSfx(ctx, timelineId, sound, accentUs, { volumeDb } = {}) {
  const def = SFX[sound];
  if (!def) throw new AppError("VALIDATION", "err.unknownSfx", { sound });
  const S = ctx.services;
  const tl = S.timelines.get(timelineId).timeline;
  const media = (await S.media.importFiles(tl.projectId, [sfxPath(sound)], { origin: "sfx" })).imported[0];
  if (!media) throw new AppError("IO", "err.fileNotFound", { file: def.file });
  const atUs = Math.max(0, Math.round(accentUs - def.leadUs));
  const r = await S.timelines.execAs(ctx.source, timelineId, "addSegment", { kind: "audio", atUs, mediaId: media.id, init: { name: `SFX: ${sound}`, volumeDb: volumeDb ?? def.volumeDb } });
  return { clipId: r.result, sound, atUs, revision: r.revision };
}
