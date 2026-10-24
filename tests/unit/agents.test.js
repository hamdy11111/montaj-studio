// Agent platform through the real services (Realm + FFmpeg, no Electron): skill registry validation and trust,
// the offline skill builder, the skill runtime (one undo step, rollback, composition conflicts), the client policy
// (scopes, project allowlist, import sandbox, approvals, rate limit, revision conflicts) and the pipe protocol.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServices } from "../../src/services/index.js";
import { closeDatabase } from "../../src/db/realmClient.js";
import { binaries, run } from "../../src/services/ffmpeg.js";
import { AgentHub } from "../../src/agent/controlServer.js";
import { SkillRegistry, BUILTIN_DIR } from "../../src/agent/skills/registry.js";
import { buildSkillFromText } from "../../src/agent/skills/builder.js";
import { US } from "../../src/core/util.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-agents-"));
const mediaDir = path.join(root, "footage");
let S, hub, editor, clip;

const durationOf = (tl) => tl.tracks.reduce((m, t) => Math.max(m, ...t.segments.map((s) => s.start + s.duration), 0), 0);
const code = (c, key) => (e) => { assert.equal(e.code, c); if (key) assert.equal(e.messageKey, key); return true; };
const userSkill = (over = {}) => ({ schema: "montaj.skill/1", id: "test-skill", name: "Test", version: "1.0.0", description: "test skill", permissions: ["read", "edit"], steps: [{ id: "look", op: "timeline_add_layer", with: { timelineId: "{{ctx.timelineId}}", kind: "filter", settings: { preset: "warm" } } }], ...over });

before(async () => {
  S = await createServices({ root, notify: () => {} });
  fs.mkdirSync(mediaDir, { recursive: true });
  clip = path.join(mediaDir, "talk.mp4");
  // 4 s, scene cut at 2 s, silence 1.5–2.7 s.
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=2", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=500:duration=4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v];[2:a]volume='if(between(t,1.5,2.7),0,1)':eval=frame[a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip], { timeoutMs: 120_000 });
  fs.writeFileSync(path.join(mediaDir, "tool.exe"), "MZ");
  hub = new AgentHub({ services: S, dir: S.paths.agents, appVersion: "1.0.0" });
  editor = hub.clients.create({ name: "editor", scopes: ["read", "media", "edit", "skills.run", "skills.write"], projects: [], importRoots: [mediaDir] }).client;
});

after(() => { hub.close(); closeDatabase({ shutdown: true }); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a Realm file */ } });

const live = (c) => hub.clients.all().find((x) => x.id === c.id);
const call = (c, name, args) => hub.call(live(c), name, args);

test("official skills validate; invalid definitions are rejected with reasons", () => {
  const reg = new SkillRegistry({ userDir: path.join(root, "reg1"), appVersion: "1.0.0" });
  const official = fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".skill.json"));
  assert.ok(official.length >= 5);
  for (const f of official) assert.deepEqual(reg.validate(JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, f), "utf8"))), { valid: true, errors: [] }, f);
  const bad = (over) => reg.validate(userSkill(over)).errors.map((e) => e.message).join(" | ");
  assert.match(bad({ steps: [{ id: "x", op: "no_such_op" }] }), /unknown operation/);
  assert.match(bad({ steps: [{ id: "x", op: "timeline_remove_silences", with: {} }] }), /needs permission "media"/);
  assert.match(bad({ permissions: ["read", "edit"], steps: [{ id: "x", op: "project_trash", with: {} }] }), /needs permission "delete"|cannot be used inside a skill/);
  assert.match(bad({ steps: [{ id: "x", op: "timeline_add_layer", with: { kind: "{{inputs.missing}}" } }] }), /unknown input missing/);
  assert.match(bad({ steps: [{ id: "x", skill: "test-skill" }] }), /cyclic/);
  assert.match(bad({ steps: [{ id: "x", skill: "podcast-cleanup" }] }), /must be listed in dependsOn/);
  assert.equal(reg.validate({ id: "x" }).valid, false);
});

test("user skills: versions must increase, official ids can't be shadowed, imports start disabled, tampering is ignored", () => {
  const dir = path.join(root, "reg2");
  const reg = new SkillRegistry({ userDir: dir, appVersion: "1.0.0" });
  reg.save(userSkill());
  assert.throws(() => reg.save(userSkill()), code("CONFLICT", "err.skillVersion"));
  assert.equal(reg.save(userSkill({ version: "1.1.0" })).version, "1.1.0");
  assert.throws(() => reg.save(userSkill({ id: "podcast-cleanup" })), code("CONFLICT", "err.skillOfficial"));
  const imp = reg.importSkill(userSkill({ id: "from-web", name: "Web" }), { from: "web.json" });
  assert.equal(imp.trust, "external");
  assert.equal(imp.enabled, false);
  assert.throws(() => reg.get("from-web"), code("FORBIDDEN", "err.skillDisabled"));
  reg.setEnabled("from-web", true);
  assert.equal(reg.get("from-web").enabled, true);
  // Edit a saved file on disk: its integrity hash no longer matches and the registry ignores that version.
  const f = path.join(dir, "test-skill", "1.1.0.json");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"warm"', '"noir"'));
  reg.reload();
  assert.equal(reg.get("test-skill").version, "1.0.0");
  assert.ok(reg.history("test-skill").some((e) => e.action === "update"));
});

test("skill builder maps a description to real operations and reports what it can't do", () => {
  const r = buildSkillFromText("خليه ريلز بالطول، احذف السكتات، نظف الصوت، حط ترجمة عربية صفراء متحركة، وزوم عند الجمل المهمة، وحسن الوجه");
  const ops = r.skill.steps.map((s) => s.op);
  for (const op of ["timeline_set_canvas", "timeline_remove_silences", "audio_enhance_voice", "timeline_add_captions"]) assert.ok(ops.includes(op), op);
  assert.ok(r.unsupported.some((u) => /Face/.test(u)));
  assert.ok(r.unsupported.some((u) => /zoom/i.test(u)));
  assert.ok(r.unsupported.some((u) => /Caption colours/.test(u)));
  assert.deepEqual(r.skill.requires, { providers: ["whisper"] });
  assert.equal(new SkillRegistry({ userDir: path.join(root, "reg3") }).validate(r.skill).valid, true);
});

let projectId, timelineId;
test("an agent client creates a project, imports inside its folder, and runs a skill as one undo step", async () => {
  const p = await call(editor, "project_create", { name: "Agent project" });
  projectId = p.projectId; timelineId = p.mainTimelineId;
  assert.deepEqual(live(editor).projects, [projectId]); // created projects are granted to the client
  const imp = await call(editor, "media_import", { projectId, paths: [clip] });
  const mediaId = imp.imported[0].mediaId;
  await call(editor, "timeline_add_clip", { timelineId, mediaId });
  const before = await call(editor, "timeline_inspect", { timelineId });
  assert.equal(before.durationUs, 4 * US);
  const depth = S.timelines.get(timelineId).history.depth;
  const job = await call(editor, "skills_execute", { skillId: "podcast-cleanup", timelineId, expectedRevision: before.revision });
  assert.equal(job.status, "done", JSON.stringify(job.error));
  const after = S.timelines.get(timelineId);
  assert.ok(durationOf(after.timeline) < 3.6 * US, `silence removed (${durationOf(after.timeline)})`);
  assert.equal(after.history.depth, depth + 1);
  assert.equal(after.history.undoLabel, "skill:podcast-cleanup");
  assert.ok(after.timeline.tracks.some((t) => t.segments.some((s) => s.audioFx?.normalize?.enabled)));
  await call(editor, "timeline_undo", { timelineId });
  assert.equal(durationOf(S.timelines.get(timelineId).timeline), 4 * US);
  await call(editor, "timeline_redo", { timelineId });
  const audit = hub.recentAudit(20).filter((e) => e.clientId === editor.id);
  assert.ok(audit.some((e) => e.op === "skills_execute" && e.ok));
  assert.ok(audit.every((e) => !JSON.stringify(e.args).includes(mediaDir)), "audit keeps file names, not paths");
});

test("a failing step rolls the whole skill back; stale revisions and composition conflicts are refused", async () => {
  const snapshot = JSON.stringify(S.timelines.get(timelineId).timeline);
  const depth = S.timelines.get(timelineId).history.depth;
  await call(editor, "skills_save", { skill: userSkill({ id: "breaks-midway", steps: [
    { id: "look", op: "timeline_add_layer", with: { timelineId: "{{ctx.timelineId}}", kind: "filter", settings: { preset: "warm" } } },
    { id: "bad", op: "timeline_add_layer", with: { timelineId: "{{ctx.timelineId}}", kind: "effect", settings: { type: "no_such_effect" } } }] }) });
  const job = await call(editor, "skills_execute", { skillId: "breaks-midway", timelineId });
  assert.equal(job.status, "failed");
  assert.equal(job.error.details.rolledBack, true);
  assert.equal(job.error.details.failedStep, "breaks-midway/bad");
  assert.equal(JSON.stringify(S.timelines.get(timelineId).timeline), snapshot);
  assert.equal(S.timelines.get(timelineId).history.depth, depth);

  const rev = S.timelines.get(timelineId).revision;
  await assert.rejects(call(editor, "timeline_split", { timelineId, atUs: US, expectedRevision: rev - 1 }), code("CONFLICT", "err.revisionConflict"));
  const stale = await call(editor, "skills_execute", { skillId: "cinematic-look", timelineId, expectedRevision: rev - 1 });
  assert.equal(stale.status, "failed");
  assert.equal(stale.error.messageKey, "err.revisionConflict");

  for (const [id, v] of [["loud-a", "-14"], ["loud-b", "-23"]]) await call(editor, "skills_save", { skill: userSkill({ id, settings: { "audio.loudness": v } }) });
  await call(editor, "skills_save", { skill: userSkill({ id: "both", dependsOn: [{ id: "loud-a" }, { id: "loud-b" }], steps: [{ id: "a", skill: "loud-a" }, { id: "b", skill: "loud-b" }] }) });
  const clash = await call(editor, "skills_execute", { skillId: "both", timelineId });
  assert.equal(clash.status, "failed");
  assert.equal(clash.error.messageKey, "err.skillConflict");
  await call(editor, "skills_save", { skill: userSkill({ id: "both", version: "1.1.0", settings: { "audio.loudness": "-16" }, dependsOn: [{ id: "loud-a" }, { id: "loud-b" }], steps: [{ id: "a", skill: "loud-a" }, { id: "b", skill: "loud-b" }] }) });
  assert.equal((await call(editor, "skills_execute", { skillId: "both", timelineId })).status, "done"); // the parent decides the key
  assert.equal(S.timelines.get(timelineId).history.undoLabel, "skill:both");

  // The composing skill's setting reaches the child's steps: podcast-cleanup normalizes to -16 alone, -20 here.
  const lufs = () => [...new Set(S.timelines.get(timelineId).timeline.tracks.flatMap((t) => t.segments).map((s) => s.audioFx?.normalize?.targetLufs).filter((v) => v !== undefined))];
  assert.equal((await call(editor, "skills_execute", { skillId: "podcast-cleanup", timelineId, inputs: { removeSilences: false } })).status, "done");
  assert.deepEqual(lufs(), [-16]);
  await call(editor, "skills_save", { skill: userSkill({ id: "quiet-master", permissions: ["read", "media", "edit"], settings: { "audio.loudness": -20 }, dependsOn: [{ id: "podcast-cleanup", version: "^1.1.0" }], steps: [{ id: "clean", skill: "podcast-cleanup", with: { removeSilences: false } }] }) });
  assert.equal((await call(editor, "skills_execute", { skillId: "quiet-master", timelineId })).status, "done");
  assert.deepEqual(lufs(), [-20]);
});

test("policy: scopes, project allowlist, import sandbox, approvals and rate limit", async () => {
  const reader = hub.clients.create({ name: "reader", scopes: ["read"], projects: "*" }).client;
  await assert.rejects(call(reader, "timeline_split", { timelineId, atUs: US }), code("FORBIDDEN", "err.scopeMissing"));
  await assert.rejects(call(reader, "skills_execute", { skillId: "cinematic-look", timelineId }), code("FORBIDDEN", "err.scopeMissing"));
  assert.ok(!hub.visibleOperations(live(reader)).some((o) => o.name === "timeline_split"));
  assert.ok(hub.visibleOperations(live(reader)).every((o) => o.readOnly));

  const other = S.projects.create({ name: "Private" });
  await assert.rejects(call(editor, "project_inspect", { projectId: other.id }), code("FORBIDDEN", "err.projectNotAllowed"));
  await assert.rejects(call(editor, "timeline_inspect", { timelineId: other.mainTimelineId }), code("FORBIDDEN", "err.projectNotAllowed"));
  assert.ok(!(await call(editor, "project_list", {})).some((p) => p.projectId === other.id));

  await assert.rejects(call(editor, "media_import", { projectId, paths: [path.join(mediaDir, "tool.exe")] }), code("FORBIDDEN", "err.fileTypeNotAllowed"));
  const outside = path.join(root, "outside.mp4");
  fs.copyFileSync(clip, outside);
  await assert.rejects(call(editor, "media_import", { projectId, paths: [outside] }), code("FORBIDDEN", "err.pathNotAllowed"));
  await assert.rejects(call(editor, "media_import", { projectId, paths: [path.join(mediaDir, "..", "outside.mp4")] }), code("FORBIDDEN", "err.pathNotAllowed"));
  await assert.rejects(call(editor, "media_import", { projectId, paths: ["talk.mp4"] }), code("VALIDATION", "err.pathAbsolute"));
  await assert.rejects(call(editor, "timeline_split", { timelineId, atUs: US, extra: 1 }), code("VALIDATION", "err.inputsInvalid"));

  const remover = hub.clients.create({ name: "remover", scopes: ["read", "delete"], projects: "*" }).client;
  await assert.rejects(call(remover, "project_trash", { projectId: other.id }), code("DENIED", "err.userDenied")); // no approver → denied
  hub.approver = async () => true;
  assert.deepEqual(await call(remover, "project_trash", { projectId: other.id }), { trashed: true });
  hub.approver = null;

  const flood = await Promise.allSettled(Array.from({ length: 60 }, () => call(reader, "project_list", {})));
  assert.ok(flood.some((r) => r.status === "rejected" && r.reason.code === "RATE_LIMITED"));
});

test("pipe protocol: token hello, scoped tool list, revocation applies immediately", async () => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\montaj-test-${process.pid}` : path.join(root, "t.sock");
  await hub.listen(pipe);
  assert.equal(JSON.parse(fs.readFileSync(path.join(S.paths.agents, "endpoint.json"), "utf8")).pipe, pipe);
  const { client, token } = hub.clients.create({ name: "pipe", scopes: ["read", "edit"], projects: "*" });
  const connect = () => new Promise((resolve, reject) => {
    const s = net.createConnection(pipe);
    let buf = "", id = 0;
    const waiting = new Map();
    s.setEncoding("utf8");
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
    s.on("connect", () => resolve({ s, req: (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r); s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); }) }));
    s.on("error", reject);
  });
  const a = await connect();
  assert.equal((await a.req("ops.list", {})).error.data.messageKey, "err.notAuthenticated");
  const b = await connect();
  assert.equal((await b.req("hello", { token: "mtj_wrong-token-wrong-token" })).error.data.messageKey, "err.badToken");
  const c = await connect();
  const hello = await c.req("hello", { token, agent: "test" });
  assert.equal(hello.result.client.name, "pipe");
  const list = (await c.req("ops.list", {})).result;
  assert.ok(list.operations.some((o) => o.name === "timeline_split"));
  assert.ok(!list.operations.some((o) => o.name === "media_import" || o.name === "export_start"));
  assert.deepEqual(list.skills, []); // no skills.run scope → no skills
  assert.ok((await c.req("ops.call", { name: "project_list", args: {} })).result.length >= 1);
  hub.clients.revoke(client.id);
  assert.equal((await c.req("ops.call", { name: "project_list", args: {} })).error.data.messageKey, "err.clientRevoked");
  for (const x of [a, b, c]) x.s.destroy();
  hub.close();
  assert.equal(fs.existsSync(path.join(S.paths.agents, "endpoint.json")), false);
});
