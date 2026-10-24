// Realm data-access tests: CRUD, transactions, relations, persistence across reopen, migrations v1→v3 and v2→v3.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Realm from "realm";
import { openDatabase, closeDatabase } from "../../src/db/realmClient.js";
import { createRepositories } from "../../src/db/repositories.js";
import { legacySchemaV1, legacySchemaV2 } from "../../src/db/migrations.js";
import { newSegment } from "../../src/core/model.js";
import { addMediaSegment, split } from "../../src/core/timelineOps.js";
import { US } from "../../src/core/util.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-db-"));
const file = path.join(dir, "data.realm");
let realm, repo;

before(async () => { realm = await openDatabase({ file }); repo = createRepositories(realm); });
after(() => { closeDatabase({ shutdown: true }); fs.rmSync(dir, { recursive: true, force: true }); });

test("create project builds a main timeline with a main video track", () => {
  const p = repo.projects.create({ name: "1023" });
  assert.equal(p.name, "1023");
  assert.equal(p.timelines.length, 1);
  const tl = repo.timelines.get(p.mainTimelineId);
  assert.equal(tl.tracks.length, 1);
  assert.equal(tl.tracks[0].isMain, true);
  assert.equal(tl.projectId, p.id);
});

test("name validation rejects forbidden characters and empty names", () => {
  assert.throws(() => repo.projects.create({ name: "a/b" }), /err.nameChars/);
  assert.throws(() => repo.projects.create({ name: "   " }), /err.nameRequired/);
});

test("media + timeline state round-trip through saveState, including embedded blocks", () => {
  const p = repo.projects.create({ name: "roundtrip" });
  const m = repo.media.add(p.id, { name: "clip.mp4", path: "C:/x/clip.mp4", type: "video", durationUs: 10 * US, width: 1920, height: 1080, hasAudio: true, hasVideo: true, origin: "import" });
  const tl = repo.timelines.get(p.mainTimelineId);
  const seg = addMediaSegment(tl, m);
  seg.adjust.hsl.red.h = 12;
  seg.adjust.curves.master = [[0, 0], [0.5, 0.6], [1, 1]];
  seg.keyframes.push({ id: "k1", prop: "scale", timeUs: 0, value: 1, easing: "easeIn" });
  const text = newSegment("text", { start: US, duration: 2 * US });
  text.text.content = "مرحبا";
  const caption = { template: "karaoke-yellow", words: [{ t: "مرحبا", s: 0, e: 600000 }], emphasis: [0], overrides: { accent: "#3EE07B" } };
  text.text.caption = caption;
  tl.tracks.push({ id: "11111111-1111-1111-1111-111111111111", type: "text", order: 1, isMain: false, name: "", locked: false, hidden: false, muted: false, segments: [text] });
  repo.timelines.saveState(tl);
  const back = repo.timelines.get(p.mainTimelineId);
  const vs = back.tracks[0].segments[0];
  assert.equal(vs.mediaId, m.id);
  assert.equal(vs.adjust.hsl.red.h, 12);
  assert.deepEqual(vs.adjust.curves.master, [[0, 0], [0.5, 0.6], [1, 1]]);
  assert.equal(vs.keyframes[0].easing, "easeIn");
  assert.equal(back.tracks[1].segments[0].text.content, "مرحبا");
  assert.deepEqual(back.tracks[1].segments[0].text.caption, caption, "word-timed caption data survives a save");
  assert.equal(repo.projects.get(p.id).durationUs, 10 * US);
});

test("saveState deletes removed segments and tracks (no orphans)", () => {
  const p = repo.projects.create({ name: "orphans" });
  const m = repo.media.add(p.id, { name: "a.mp4", path: "C:/x/a.mp4", type: "video", durationUs: 6 * US, hasVideo: true, origin: "import" });
  const tl = repo.timelines.get(p.mainTimelineId);
  addMediaSegment(tl, m);
  split(tl, 3 * US);
  repo.timelines.saveState(tl);
  assert.equal(repo.timelines.get(tl.id).tracks[0].segments.length, 2);
  tl.tracks[0].segments.pop();
  repo.timelines.saveState(tl);
  assert.equal(repo.timelines.get(tl.id).tracks[0].segments.length, 1);
  assert.equal(realm.objects("Segment").filtered("track.@count == 0").length, 0);
});

test("trash, restore, duplicate and permanent delete with cascade", () => {
  const p = repo.projects.create({ name: "cascade" });
  const m = repo.media.add(p.id, { name: "only.mp4", path: "C:/x/only-here.mp4", type: "video", durationUs: 2 * US, hasVideo: true, origin: "import" });
  const tl = repo.timelines.get(p.mainTimelineId);
  addMediaSegment(tl, m);
  repo.timelines.saveState(tl);
  const dup = repo.projects.duplicate(p.id, "cascade (1)");
  assert.equal(repo.timelines.get(dup.mainTimelineId).tracks[0].segments.length, 1);
  repo.projects.trash(p.id);
  assert.ok(!repo.projects.list().some((x) => x.id === p.id));
  assert.ok(repo.projects.list({ status: "trashed" }).some((x) => x.id === p.id));
  repo.projects.restore(p.id);
  assert.ok(repo.projects.list().some((x) => x.id === p.id));
  const orphans1 = repo.projects.deleteForever(p.id);
  assert.equal(orphans1.length, 0, "media still used by the duplicate must survive");
  const orphans2 = repo.projects.deleteForever(dup.id);
  assert.equal(orphans2.length, 1);
  assert.equal(repo.media.find(m.id), null);
});

test("purgeExpired removes projects trashed more than 30 days ago", () => {
  const p = repo.projects.create({ name: "old" });
  repo.projects.trash(p.id);
  realm.write(() => { realm.objectForPrimaryKey("Project", p.id).trashedAt = new Date(Date.now() - 31 * 86_400_000); });
  const { purged } = repo.projects.purgeExpired();
  assert.deepEqual(purged, [p.id]);
});

test("settings, shortcut presets (dictionary), workspaces, library, exports", () => {
  repo.settings.set("edit.fps", 30);
  assert.equal(repo.settings.get("edit.fps"), 30);
  repo.shortcuts.ensure({ split: "E", undo: "Ctrl+Z" });
  repo.shortcuts.save(2, { split: "Ctrl+B", undo: "Ctrl+Z" });
  assert.equal(repo.shortcuts.get(2).bindings.split, "Ctrl+B");
  assert.equal(repo.shortcuts.get(1).bindings.split, "E");
  const p = repo.projects.create({ name: "ws" });
  const w = repo.workspaces.create("Team A");
  repo.workspaces.addProject(w.id, p.id);
  assert.deepEqual(repo.workspaces.list().find((x) => x.id === w.id).projectIds, [p.id]);
  assert.equal(repo.projects.list({ workspaceId: w.id }).length, 1);
  const li = repo.library.add({ kind: "audio", name: "beat.mp3", path: "C:/x/beat.mp3" });
  repo.library.update(li, { favorite: true });
  assert.equal(repo.library.list({ kind: "audio", favorite: true }).length, 1);
  const ex = repo.exports.create({ projectId: p.id, projectName: p.name, path: "C:/out.mp4" });
  repo.exports.update(ex, { status: "done", progress: 1 });
  assert.equal(repo.exports.list({ projectId: p.id })[0].status, "done");
});

test("data persists after closing and reopening the database", async () => {
  const p = repo.projects.create({ name: "persist-me" });
  closeDatabase();
  realm = await openDatabase({ file });
  repo = createRepositories(realm);
  assert.equal(repo.projects.get(p.id).name, "persist-me");
});

test("migration v1 → v3 (through v2) backfills lastOpenedAt and keeps data", async () => {
  const legacy = path.join(dir, "legacy.realm");
  const old = await Realm.open({ path: legacy, schema: legacySchemaV1(), schemaVersion: 1 });
  const updated = new Date("2026-01-02T03:04:05Z");
  old.write(() => {
    const t = old.create("Timeline", { _id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Timeline 01", createdAt: updated, updatedAt: updated, tracks: [], markers: [] });
    old.create("Project", { _id: "aaaaaaaa-0000-0000-0000-000000000002", name: "legacy", createdAt: updated, updatedAt: updated, mainTimelineId: t._id, timelines: [t], media: [], tags: [] });
  });
  old.close();
  const migrated = await openDatabase({ file: legacy });
  const p = migrated.objectForPrimaryKey("Project", "aaaaaaaa-0000-0000-0000-000000000002");
  assert.equal(p.lastOpenedAt.toISOString(), updated.toISOString());
  assert.equal(migrated.schemaVersion, 3);
  assert.ok(fs.existsSync(`${legacy}.pre-v3.bak`), "a safety copy is written before migrating");
  migrated.close();
  realm = await openDatabase({ file });
  repo = createRepositories(realm);
});

test("migration v2 → v3 adds TextStyle.caption and keeps existing text", async () => {
  const legacy = path.join(dir, "legacy-v2.realm");
  const old = await Realm.open({ path: legacy, schema: legacySchemaV2(), schemaVersion: 2 });
  const at = new Date("2026-05-06T07:08:09Z");
  old.write(() => {
    const seg = old.create("Segment", { _id: "bbbbbbbb-0000-0000-0000-000000000003", kind: "text", start: 0, duration: 1000000, text: { content: "old caption", isCaption: true } });
    const tr = old.create("Track", { _id: "bbbbbbbb-0000-0000-0000-000000000004", type: "text", order: 1, segments: [seg] });
    const t = old.create("Timeline", { _id: "bbbbbbbb-0000-0000-0000-000000000001", name: "Timeline 01", createdAt: at, updatedAt: at, tracks: [tr], markers: [] });
    old.create("Project", { _id: "bbbbbbbb-0000-0000-0000-000000000002", name: "v2", createdAt: at, updatedAt: at, lastOpenedAt: at, mainTimelineId: t._id, timelines: [t], media: [], tags: [] });
  });
  old.close();
  const migrated = await openDatabase({ file: legacy });
  assert.equal(migrated.schemaVersion, 3);
  const s = migrated.objectForPrimaryKey("Segment", "bbbbbbbb-0000-0000-0000-000000000003");
  assert.equal(s.text.content, "old caption");
  assert.equal(s.text.caption, null);
  assert.ok(fs.existsSync(`${legacy}.pre-v3.bak`));
  migrated.close();
});
