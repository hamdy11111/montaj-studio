// Opens the local Realm database (main process only — Realm is a native Node-API module and must never be
// loaded in the sandboxed renderer). Handles migrations, a safety copy before upgrades, and open errors.
import fs from "node:fs";
import path from "node:path";
import Realm from "realm";
import { ALL_SCHEMAS, SCHEMA_VERSION } from "./schemas.js";
import { onMigration } from "./migrations.js";
import { AppError } from "../core/validation.js";

let current = null;

/** Read the on-disk schema version without opening for write (returns -1 when the file does not exist). */
export function diskSchemaVersion(file) {
  if (!fs.existsSync(file)) return -1;
  try { return Realm.schemaVersion(file); } catch { return -1; }
}

export async function openDatabase({ file, schema = ALL_SCHEMAS, schemaVersion = SCHEMA_VERSION, backupBeforeMigration = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const onDisk = diskSchemaVersion(file);
  if (onDisk > schemaVersion) throw new AppError("IO", "err.dbNewerVersion", { onDisk, schemaVersion });
  if (backupBeforeMigration && onDisk >= 0 && onDisk < schemaVersion) {
    fs.copyFileSync(file, `${file}.pre-v${schemaVersion}.bak`); // safety copy before an upgrade
  }
  try {
    const realm = await Realm.open({ path: file, schema, schemaVersion, onMigration });
    current = realm;
    return realm;
  } catch (err) {
    throw new AppError("IO", "err.dbOpen", { message: String(err?.message || err), file });
  }
}

export function getRealm() {
  if (!current || current.isClosed) throw new AppError("INTERNAL", "err.dbClosed");
  return current;
}

export function setRealm(realm) { current = realm; }

export function closeDatabase({ shutdown = false } = {}) {
  if (current && !current.isClosed) current.close();
  current = null;
  // Realm keeps native worker threads alive; shutdown() lets the Node process exit (used on app quit / tests).
  if (shutdown) Realm.shutdown();
}

/** Run `fn` inside a write transaction; nested calls reuse the open transaction. */
export function write(realm, fn) {
  if (realm.isInTransaction) return fn();
  let out;
  realm.write(() => { out = fn(); });
  return out;
}

export { Realm };
