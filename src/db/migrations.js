// Schema migrations. Each step upgrades from version `from` to `from + 1` inside Realm's migration callback.
// To evolve the schema: bump SCHEMA_VERSION in schemas.js, change the schema, add a step here, add a test.
import { ALL_SCHEMAS } from "./schemas.js";

export const MIGRATIONS = [
  {
    from: 1,
    description: "v2: Project.lastOpenedAt (backfilled from updatedAt), Segment.colorTag (default empty) and Segment.audioDetached (default false).",
    run(oldRealm, newRealm) {
      for (const p of oldRealm.objects("Project")) {
        const np = newRealm.objectForPrimaryKey("Project", p._id);
        if (np) np.lastOpenedAt = p.updatedAt;
      }
      for (const s of newRealm.objects("Segment")) if (!s.colorTag) s.colorTag = "";
    },
  },
  {
    from: 2,
    description: "v3: TextStyle.caption (optional JSON of a word-timed caption page). New optional field; existing data is unchanged.",
    run() { /* nothing to convert */ },
  },
];

export function onMigration(oldRealm, newRealm) {
  const from = oldRealm.schemaVersion;
  for (const step of MIGRATIONS) if (step.from >= from && step.from < newRealm.schemaVersion) step.run(oldRealm, newRealm);
}

const withoutCaption = (s) => { if (s.name !== "TextStyle") return s; const p = { ...s.properties }; delete p.caption; return { ...s, properties: p }; };

/** The v2 schema (before TextStyle.caption), for the v2 → v3 upgrade test. */
export function legacySchemaV2() { return ALL_SCHEMAS.map(withoutCaption); }

/** The v1 schema, kept so tests can create a legacy database and verify the upgrade path. */
export function legacySchemaV1() {
  return legacySchemaV2().map((s) => {
    if (s.name === "Project") { const p = { ...s.properties }; delete p.lastOpenedAt; return { ...s, properties: p }; }
    if (s.name === "Segment") { const p = { ...s.properties }; delete p.colorTag; delete p.audioDetached; return { ...s, properties: p }; }
    return s;
  });
}
