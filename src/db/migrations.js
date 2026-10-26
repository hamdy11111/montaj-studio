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
  {
    from: 3,
    description: "v4: TextStyle.graphic (optional JSON of a motion-graphics template and its parameters). New optional field.",
    run() { /* nothing to convert */ },
  },
  {
    from: 4,
    description: "v5: VideoFx.matte (\"none\" | \"person\") and Track.role (\"behind\" = behind the person). New fields with defaults.",
    run(oldRealm, newRealm) { for (const s of newRealm.objects("Segment")) if (s.videoFx && !s.videoFx.matte) s.videoFx.matte = "none"; },
  },
  {
    from: 5,
    description: "v6: Segment.jlUs (J/L cut at the joint before a main-track clip, default 0 = a plain cut). New field with a default.",
    run() { /* nothing to convert */ },
  },
];

export function onMigration(oldRealm, newRealm) {
  const from = oldRealm.schemaVersion;
  for (const step of MIGRATIONS) if (step.from >= from && step.from < newRealm.schemaVersion) step.run(oldRealm, newRealm);
}

const without = (name, ...keys) => (s) => { if (s.name !== name) return s; const p = { ...s.properties }; for (const k of keys) delete p[k]; return { ...s, properties: p }; };
const withoutText = (...keys) => without("TextStyle", ...keys);

/** The v5 schema (before Segment.jlUs), for the v5 → v6 upgrade test. */
export function legacySchemaV5() { return ALL_SCHEMAS.map(without("Segment", "jlUs")); }

/** The v4 schema (before VideoFx.matte), for the v4 → v5 upgrade test. */
export function legacySchemaV4() { return legacySchemaV5().map(without("VideoFx", "matte")).map(without("Track", "role")); }

/** The v3 schema (before TextStyle.graphic), for the v3 → v4 upgrade test. */
export function legacySchemaV3() { return legacySchemaV4().map(withoutText("graphic")); }

/** The v2 schema (before TextStyle.caption), for the v2 → v3 upgrade test. */
export function legacySchemaV2() { return legacySchemaV4().map(withoutText("graphic", "caption")); }

/** The v1 schema, kept so tests can create a legacy database and verify the upgrade path. */
export function legacySchemaV1() {
  return legacySchemaV2().map((s) => {
    if (s.name === "Project") { const p = { ...s.properties }; delete p.lastOpenedAt; return { ...s, properties: p }; }
    if (s.name === "Segment") { const p = { ...s.properties }; delete p.colorTag; delete p.audioDetached; return { ...s, properties: p }; }
    return s;
  });
}
