// MCP end to end: launches the real Electron app (isolated user data, its own pipe), turns agents on from the
// Settings UI, creates a client, then starts the MCP bridge exactly as Claude Code / Codex would (the config the app
// generates: the app's executable in Node mode + src/mcp/server.mjs) and drives it with the official MCP SDK client:
// discover tools/resources/prompts, create a project, import, run a skill, see the editor update live, undo, and
// check the denials (read-only client, path outside the allowed folder, approval refused in the UI).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { binaries, run } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-mcp-"));
const allowed = path.join(ud, "_allowed");
const outside = path.join(ud, "_outside");
const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\montaj-e2e-${process.pid}` : path.join(ud, "agents.sock");
let app, win;
const pageErrors = [];
const clients = [];

const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
const shot = (name) => win.screenshot({ path: path.join(ART, `${name}.png`) });
const data = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return r.structuredContent; };
const errorOf = (r) => { assert.equal(r.isError, true, "expected an error result"); return r.structuredContent.error; };

/** Start the MCP bridge from the configuration the app generated for a client and connect the SDK client. */
async function connect(config) {
  const srv = config.json.mcpServers["montaj-studio"];
  const transport = new StdioClientTransport({ command: srv.command, args: srv.args, env: { ...srv.env, SystemRoot: process.env.SystemRoot || "" }, stderr: "pipe" });
  const client = new Client({ name: "montaj-e2e", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

before(async () => {
  fs.mkdirSync(ART, { recursive: true });
  for (const d of [allowed, outside]) fs.mkdirSync(d, { recursive: true });
  const ff = binaries().ffmpeg;
  // 5 s talk: two scenes, a silent gap 1.6–3.0 s.
  await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-filter_complex", "[1:a]volume='if(between(t,1.6,3.0),0,1)':eval=frame[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(allowed, "talk.mp4")], { timeoutMs: 120_000 });
  fs.copyFileSync(path.join(allowed, "talk.mp4"), path.join(outside, "secret.mp4"));
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, MONTAJ_PIPE: PIPE, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => pageErrors.push(e.message));
  win.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await win.waitForSelector(".home", { timeout: 30_000 });
  await api("settings.set", "general", { onboarded: true });
  await win.reload();
  await win.waitForSelector(".home", { timeout: 30_000 });
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await app?.close().catch(() => {});
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
});

let editorCfg, tools;
test("agents are off by default and are turned on from Settings › Agents & MCP", async () => {
  assert.equal(fs.existsSync(path.join(ud, "agents", "endpoint.json")), false);
  assert.equal((await api("agents.status")).listening, false);
  await win.locator(".nav-item", { hasText: "الإعدادات" }).click();
  await win.waitForSelector(".settings");
  await win.locator(".settings-tabs button", { hasText: "الوكلاء" }).click();
  await win.waitForSelector(".settings-pane .toggle");
  await win.locator(".settings-pane .toggle").first().click();
  await win.waitForFunction(() => document.querySelector(".settings-pane .badge.local"), null, { timeout: 10_000 });
  const st = await api("agents.status");
  assert.equal(st.listening, true);
  assert.equal(st.pipe, PIPE);
  await shot("mcp-01-agents-settings");
  await win.keyboard.press("Escape");
});

test("an MCP client discovers tools, skills, resources and prompts", async () => {
  const r = await api("agents.createClient", { name: "Claude Code (e2e)", scopes: ["read", "media", "edit", "skills.run", "delete"], projects: [], importRoots: [allowed] });
  assert.match(r.token, /^mtj_/);
  assert.ok(fs.readFileSync(r.tokenFile, "utf8").startsWith("mtj_"));
  assert.match(r.config.claudeCode, /^claude mcp add montaj-studio /);
  assert.match(r.config.codexToml, /^\[mcp_servers\.montaj-studio\]/);
  assert.ok(!r.config.claudeCode.includes(r.token), "the token is not in the command line");
  editorCfg = r.config;
  const c = await connect(editorCfg);
  assert.equal(c.getServerVersion().name, "montaj-studio");
  tools = (await c.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const n of ["project_create", "media_import", "timeline_inspect", "timeline_remove_silences", "timeline_undo", "skills_execute", "project_trash", "skill__podcast_cleanup", "skill__fast_reels"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("export_start") && !names.includes("skills_save"), "tools without a granted scope are hidden");
  assert.equal(tools.find((t) => t.name === "timeline_inspect").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "project_trash").annotations.destructiveHint, true);
  assert.ok((await c.listResources()).resources.some((x) => x.uri === "montaj://skills"));
  assert.ok((await c.listResourceTemplates()).resourceTemplates.some((x) => x.uriTemplate === "montaj://timeline/{timelineId}"));
  const skills = JSON.parse((await c.readResource({ uri: "montaj://skills" })).contents[0].text);
  assert.ok(skills.some((s) => s.id === "social-repurpose"));
  assert.deepEqual((await c.listPrompts()).prompts.map((p) => p.name).sort(), ["build_skill", "edit_with_skill"]);
});

let projectId, timelineId;
test("the agent builds a project, runs a skill, and the open editor updates live; undo restores it", async () => {
  const c = clients[0];
  const p = data(await c.callTool({ name: "project_create", arguments: { name: "MCP project" } }));
  projectId = p.projectId; timelineId = p.mainTimelineId;
  const imp = data(await c.callTool({ name: "media_import", arguments: { projectId, paths: [path.join(allowed, "talk.mp4")] } }));
  assert.equal(imp.imported.length, 1);
  data(await c.callTool({ name: "timeline_add_clip", arguments: { timelineId, mediaId: imp.imported[0].mediaId } }));
  const before = data(await c.callTool({ name: "timeline_inspect", arguments: { timelineId } }));
  assert.equal(before.durationUs, 5_000_000);

  // The user opens the agent's project in the editor.
  await win.locator(".proj-card", { hasText: "MCP project" }).first().click();
  await win.waitForSelector(".editor");
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-video").length === 1);

  const job = data(await c.callTool({ name: "skill__podcast_cleanup", arguments: { timelineId, expectedRevision: before.revision } }));
  assert.equal(job.status, "done", JSON.stringify(job.error));
  const after = data(await c.callTool({ name: "timeline_inspect", arguments: { timelineId } }));
  assert.ok(after.durationUs < 4_000_000, `silence removed (${after.durationUs})`);
  assert.equal(after.history.undoLabel, "skill:podcast-cleanup");
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-video").length === 2, null, { timeout: 10_000 }); // live, no reload
  await win.waitForSelector(".toast", { timeout: 5000 });
  await shot("mcp-02-editor-after-agent-skill");

  // The user can undo the agent's whole skill run from the app — one step.
  await win.keyboard.press("Control+z");
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-video").length === 1, null, { timeout: 10_000 });
  assert.equal(data(await c.callTool({ name: "timeline_inspect", arguments: { timelineId } })).durationUs, 5_000_000);
  // …and the agent can redo it.
  data(await c.callTool({ name: "timeline_redo", arguments: { timelineId } }));
  await win.waitForFunction(() => document.querySelectorAll(".clip.k-video").length === 2, null, { timeout: 10_000 });

  const stale = errorOf(await c.callTool({ name: "timeline_split", arguments: { timelineId, atUs: 500_000, expectedRevision: before.revision } }));
  assert.equal(stale.messageKey, "err.revisionConflict");
});

test("denials: outside folder, read-only client, user refuses the approval in the app", async () => {
  const c = clients[0];
  assert.equal(errorOf(await c.callTool({ name: "media_import", arguments: { projectId, paths: [path.join(outside, "secret.mp4")] } })).messageKey, "err.pathNotAllowed");
  const other = await api("project.create", { name: "Not shared" });
  assert.equal(errorOf(await c.callTool({ name: "project_inspect", arguments: { projectId: other.id } })).messageKey, "err.projectNotAllowed");

  const ro = await connect((await api("agents.createClient", { name: "Viewer", scopes: ["read"], projects: "*" })).config);
  const roNames = (await ro.listTools()).tools.map((t) => t.name);
  assert.ok(!roNames.some((n) => n.startsWith("skill__") || n === "timeline_split"));
  assert.equal(errorOf(await ro.callTool({ name: "timeline_split", arguments: { timelineId, atUs: 500_000 } })).messageKey, "err.scopeMissing");

  // Moving a project to the trash asks the user in the app; Deny → refused, Allow → done.
  const pending = c.callTool({ name: "project_trash", arguments: { projectId } });
  await win.waitForSelector(".approval-modal", { timeout: 10_000 });
  await shot("mcp-03-approval");
  await win.locator(".approval-modal .modal-foot .btn", { hasText: "رفض" }).click();
  assert.equal(errorOf(await pending).messageKey, "err.userDenied");
  const pending2 = c.callTool({ name: "project_trash", arguments: { projectId } });
  await win.waitForSelector(".approval-modal", { timeout: 10_000 });
  await win.locator(".approval-modal .modal-foot .btn", { hasText: "سماح" }).click();
  assert.deepEqual(data(await pending2), { trashed: true });

  const audit = await api("agents.audit", 100);
  assert.ok(audit.some((e) => e.op === "project_trash" && !e.ok && e.code === "DENIED"));
  assert.ok(audit.some((e) => e.op === "project_trash" && e.ok));
  assert.deepEqual(pageErrors, []);
});

test("revoking a client cuts it off; turning agents off closes the pipe", async () => {
  const st = await api("agents.status");
  const viewer = st.clients.find((x) => x.name === "Viewer");
  await api("agents.revokeClient", viewer.id);
  assert.equal(errorOf(await clients[1].callTool({ name: "project_list", arguments: {} })).messageKey, "err.clientRevoked");
  await api("settings.set", "agents", { enabled: false });
  await win.waitForTimeout(300);
  assert.equal((await api("agents.status")).listening, false);
  assert.equal(fs.existsSync(path.join(ud, "agents", "endpoint.json")), false);
});
