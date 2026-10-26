// Read-only access to the libraries' files for the editor's library browsers (media://libfile/<id>): a sound of the
// sound library before it is added, a B-roll shot's keyframe, the video a shot was cut from. Nothing else of the disk:
// the path in the URL is only a key — the file served is its real path (links resolved), and only when it lies inside
// the sound library or the B-roll index folder, or is a file those libraries list from elsewhere (a sound folder the
// user imported by path, the videos the B-roll index was made from). Only pictures, sounds and videos; no writes.
import fs from "node:fs";
import path from "node:path";

/** File types a preview may read. */
export const PREVIEW_EXT = new Set([".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".aif", ".aiff", ".jpg", ".jpeg", ".png", ".webp", ".mp4", ".m4v", ".mov", ".webm", ".mkv"]);

/** URL id of a file (base64url of its UTF-8 path; the media protocol's ids are [A-Za-z0-9_-]). */
export const libraryFileId = (file) => Buffer.from(String(file), "utf8").toString("base64url");

/** The path an id names, or null when it is not an absolute path. */
export function libraryFileFromId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,2800}$/.test(id)) return null;
  const p = Buffer.from(id, "base64url").toString("utf8");
  return p && !p.includes("\0") && path.isAbsolute(p) ? p : null;
}

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Whether `file` lies strictly inside `root` (both real paths). */
export function isInside(file, root) {
  const rel = path.relative(norm(root), norm(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A resolver over the libraries. `roots()` → the folders whose files may be read (the sound library, the B-roll
 * index); `listed()` → files the libraries name outside them; `stamp()` → a value that changes when those lists do
 * (their index files' times), so the real paths of the listed files are computed once per change.
 * resolve(file) → the real path to serve, or null.
 */
export function libraryFiles({ roots = () => [], listed = () => [], stamp = () => "" } = {}) {
  let cache = { stamp: null, set: new Set() };
  const listedSet = () => {
    const st = stamp();
    if (cache.stamp !== st) cache = { stamp: st, set: new Set(listed().map(realOf).filter(Boolean).map(norm)) };
    return cache.set;
  };
  return {
    resolve(file) {
      if (typeof file !== "string" || !path.isAbsolute(file) || !PREVIEW_EXT.has(path.extname(file).toLowerCase())) return null;
      const real = realOf(file);
      if (!real || !PREVIEW_EXT.has(path.extname(real).toLowerCase())) return null;
      try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
      for (const r of roots()) { const root = r && realOf(r); if (root && isInside(real, root)) return real; }
      return listedSet().has(norm(real)) ? real : null;
    },
  };
}

/** The resolver of the app's services (the sound library `sfxLib`, the B-roll index `broll`). */
export function servicesLibraryFiles(getServices) {
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const sfxManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8")).sounds || []; } catch { return []; } };
  return libraryFiles({
    roots: () => { const s = getServices(); return [s?.sfxLib?.dir, s?.broll?.dir]; },
    stamp: () => { const s = getServices(); return `${s?.sfxLib?.dir}|${mtime(path.join(s?.sfxLib?.dir || "", "library.json"))}|${s?.broll?.dir}|${mtime(s?.broll?.file?.() || "")}`; },
    listed: () => {
      const s = getServices();
      const sounds = s?.sfxLib?.dir ? sfxManifest(s.sfxLib.dir).filter((x) => x.abs && x.file).map((x) => x.file) : [];
      const videos = s?.broll?.read ? Object.values(s.broll.read().media || {}).map((m) => m.path).filter(Boolean) : [];
      return [...sounds, ...videos];
    },
  });
}
