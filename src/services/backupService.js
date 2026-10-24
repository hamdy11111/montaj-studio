// Backup & restore of the local database (+ app-generated media), and auto-backup (local alternative to the
// report's cloud Auto sync, FEAT-131). A backup is a folder: data.realm + media/ + manifest.json.
import fs from "node:fs";
import path from "node:path";
import { getRealm, closeDatabase, openDatabase } from "../db/realmClient.js";
import { SCHEMA_VERSION } from "../db/schemas.js";
import { AppError } from "../core/validation.js";

const stamp = (d = new Date()) => d.toISOString().replace(/[:T]/g, "-").slice(0, 19);

export class BackupService {
  constructor({ paths, appVersion = "1.0.0", onReopen = () => {} }) {
    this.paths = paths;
    this.appVersion = appVersion;
    this.onReopen = onReopen; // called with the new Realm after a restore
  }

  backup(destDir = this.paths.backups, { includeMedia = true } = {}) {
    if (!fs.existsSync(destDir)) throw new AppError("IO", "err.folderNotFound", { dir: destDir });
    const dir = path.join(destDir, `MontajBackup-${stamp()}`);
    fs.mkdirSync(dir, { recursive: true });
    const realm = getRealm();
    realm.writeCopyTo({ path: path.join(dir, "data.realm") }); // consistent, compacted snapshot
    let mediaFiles = 0;
    if (includeMedia && fs.existsSync(this.paths.media)) {
      fs.cpSync(this.paths.media, path.join(dir, "media"), { recursive: true });
      mediaFiles = fs.readdirSync(this.paths.media).length;
    }
    const manifest = {
      app: "Montaj Studio", appVersion: this.appVersion, schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(),
      counts: { projects: realm.objects("Project").length, media: realm.objects("MediaAsset").length, segments: realm.objects("Segment").length, mediaFiles },
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { dir, manifest };
  }

  list(destDir = this.paths.backups) {
    if (!fs.existsSync(destDir)) return [];
    return fs.readdirSync(destDir).filter((d) => d.startsWith("MontajBackup-")).map((d) => {
      try { return { dir: path.join(destDir, d), manifest: JSON.parse(fs.readFileSync(path.join(destDir, d, "manifest.json"), "utf8")) }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  }

  readManifest(dir) {
    const mf = path.join(dir, "manifest.json");
    if (!fs.existsSync(mf) || !fs.existsSync(path.join(dir, "data.realm"))) throw new AppError("VALIDATION", "err.backupInvalid");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    if (m.app !== "Montaj Studio") throw new AppError("VALIDATION", "err.backupInvalid");
    if (m.schemaVersion > SCHEMA_VERSION) throw new AppError("VALIDATION", "err.backupNewer");
    return m;
  }

  /** Restore: the current database is kept as data.before-restore-<stamp>.realm, then replaced and reopened. */
  async restore(dir) {
    const manifest = this.readManifest(dir);
    const keep = `${this.paths.db}.before-restore-${stamp()}`;
    closeDatabase();
    try {
      if (fs.existsSync(this.paths.db)) fs.copyFileSync(this.paths.db, keep);
      for (const ext of ["", ".lock", ".note", ".management"]) fs.rmSync(this.paths.db + ext, { recursive: true, force: true });
      fs.copyFileSync(path.join(dir, "data.realm"), this.paths.db);
      if (fs.existsSync(path.join(dir, "media"))) fs.cpSync(path.join(dir, "media"), this.paths.media, { recursive: true });
      const realm = await openDatabase({ file: this.paths.db }); // migrates older backups automatically
      this.onReopen(realm);
      return { manifest, previous: keep };
    } catch (e) {
      // Roll back to the previous database if anything failed.
      if (fs.existsSync(keep)) fs.copyFileSync(keep, this.paths.db);
      const realm = await openDatabase({ file: this.paths.db });
      this.onReopen(realm);
      throw e instanceof AppError ? e : new AppError("IO", "err.restoreFailed", { message: e.message });
    }
  }

  /** Daily automatic backup, keeping the newest `keep` copies. */
  autoBackup({ keep = 7 } = {}) {
    const last = this.list()[0];
    if (last && Date.now() - new Date(last.manifest.createdAt).getTime() < 24 * 3_600_000) return null;
    const r = this.backup(this.paths.backups, { includeMedia: false });
    for (const old of this.list().slice(keep)) fs.rmSync(old.dir, { recursive: true, force: true });
    return r;
  }
}
