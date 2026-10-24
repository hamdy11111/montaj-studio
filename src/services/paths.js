// Application data layout. `root` is Electron's userData in the app, or a temp dir in tests.
import fs from "node:fs";
import path from "node:path";

export function makePaths(root) {
  const p = {
    root,
    db: path.join(root, "data", "montaj.realm"),
    cache: path.join(root, "cache"),
    thumbs: path.join(root, "cache", "thumbs"),
    waveforms: path.join(root, "cache", "waveforms"),
    proxy: path.join(root, "cache", "proxy"),
    compound: path.join(root, "cache", "compound"),
    overlays: path.join(root, "cache", "overlays"),
    render: path.join(root, "cache", "render"),
    media: path.join(root, "media"), // app-generated media: tts, recordings, freeze frames, reversed clips
    backups: path.join(root, "backups"),
    packages: path.join(root, "packages"),
    luts: path.join(root, "library", "luts"),
    library: path.join(root, "library"),
    logs: path.join(root, "logs"),
  };
  for (const [k, v] of Object.entries(p)) if (k !== "root" && k !== "db") fs.mkdirSync(v, { recursive: true });
  fs.mkdirSync(path.dirname(p.db), { recursive: true });
  return p;
}

export function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    try { total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } catch { /* file vanished */ }
  }
  return total;
}

export function clearDir(dir, { olderThanDays = null } = {}) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const cutoff = olderThanDays === null ? Infinity : Date.now() - olderThanDays * 86_400_000;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    try {
      const st = fs.statSync(f);
      if (olderThanDays !== null && st.mtimeMs > cutoff) continue;
      fs.rmSync(f, { recursive: true, force: true });
      n++;
    } catch { /* in use */ }
  }
  return n;
}
