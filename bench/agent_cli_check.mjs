// Cross-agent check: drives Montaj Studio through MCP with the real Claude Code and Codex CLIs (not a test client).
// Launches the app with isolated user data and its own pipe, turns agents on, creates one client per CLI with the
// configuration the app generates, gives each CLI the same task (find a project, inspect, run a skill, inspect again,
// report as JSON), then verifies the result from the app side (timeline history + audit log).
// Uses the CLIs' own accounts (model usage is billed to them). The user's global CLI configuration is not modified:
// Claude Code gets --mcp-config/--strict-mcp-config, Codex gets -c overrides.
//   node bench/agent_cli_check.mjs [claude|codex|both]     (CODEX_MODEL=<slug> overrides the Codex model for this run)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { binaries, run } from "../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2] || "both";
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-cli-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-cli-work-")); // empty cwd for the CLIs
const allowed = path.join(ud, "_allowed");
const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\montaj-cli-${process.pid}` : path.join(ud, "agents.sock");
fs.mkdirSync(allowed, { recursive: true });

const TASK = (project) => `You can use the "montaj-studio" MCP tools (a local video editor). Do exactly this and nothing else:
1) call project_list and find the project named "${project}".
2) call timeline_inspect on its mainTimelineId and note durationUs and revision.
3) run the skill podcast-cleanup on that timeline (tool skill__podcast_cleanup) with expectedRevision set to that revision.
4) call timeline_inspect again.
Then reply with only one line of JSON: {"before": <durationUs before>, "after": <durationUs after>, "undoLabel": "<history.undoLabel after>", "montajTools": <how many montaj-studio tools you can see>}`;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: work, shell: false, windowsHide: true, ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.stdin.end();
    const timer = setTimeout(() => p.kill(), 15 * 60_000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), ms: Date.now() - t0 }); });
  });
}
const lastJson = (text) => { const m = [...String(text).matchAll(/\{[^{}]*"before"[^{}]*\}/g)].pop(); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(", ")}]` : typeof v === "object" ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${toml(x)}`).join(", ")} }` : JSON.stringify(v));

const ff = binaries().ffmpeg;
await run(ff, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
  "-filter_complex", "[1:a]volume='if(between(t,1.6,3.0),0,1)':eval=frame[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(allowed, "talk.mp4")], { timeoutMs: 120_000 });

const app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, MONTAJ_PIPE: PIPE, REALM_DISABLE_ANALYTICS: "1" } });
const win = await app.firstWindow();
await win.waitForSelector(".home", { timeout: 30_000 });
const api = (method, ...args) => win.evaluate(([m, a]) => window.api.call(m, ...a), [method, args]);
await api("settings.set", "agents", { enabled: true });
await new Promise((r) => setTimeout(r, 400));

async function prepare(label) {
  const p = await api("project.create", { name: `CLI test ${label}` });
  const imp = await api("media.import", p.id, [path.join(allowed, "talk.mp4")]);
  await api("timeline.exec", p.mainTimelineId, "addMedia", { mediaId: imp.imported[0].id });
  const c = await api("agents.createClient", { name: `${label} CLI`, scopes: ["read", "media", "edit", "skills.run"], projects: [p.id], importRoots: [] });
  return { project: p, client: c };
}

async function verify(label, { project, client }, res) {
  const tl = await api("timeline.get", project.mainTimelineId);
  const audit = (await api("agents.audit", 500)).filter((e) => e.clientId === client.client.id);
  const reply = lastJson(res.out);
  const durationUs = tl.timeline.tracks.reduce((m, t) => Math.max(m, ...t.segments.map((s) => s.start + s.duration), 0), 0);
  return {
    agent: label, exitCode: res.code, seconds: Math.round(res.ms / 1000), reply,
    app: { undoLabel: tl.history.undoLabel, durationUs, calls: audit.map((e) => `${e.op}:${e.ok ? "ok" : e.code}`), hello: audit.some((e) => e.op === "hello" && e.ok) },
    pass: tl.history.undoLabel === "skill:podcast-cleanup" && durationUs < 4_000_000 && audit.some((e) => e.op === "skills_execute" && e.ok) && reply?.after === durationUs,
    stderrTail: res.code ? res.err.slice(-1500) : undefined,
    stdoutTail: res.code ? String(res.out).slice(-1500) : undefined,
  };
}

const results = [];
try {
  if (which === "claude" || which === "both") {
    const ctx = await prepare("Claude");
    const cfgFile = path.join(work, "mcp.json");
    fs.writeFileSync(cfgFile, JSON.stringify(ctx.client.config.json, null, 1));
    // Run it as from the user's own terminal: drop variables inherited from a host Claude session (they redirect auth).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));
    const res = await exec("claude", ["-p", TASK(ctx.project.name), "--mcp-config", cfgFile, "--strict-mcp-config", "--allowedTools", "mcp__montaj-studio", "--output-format", "json", "--max-turns", "20"], { env });
    let text = res.out;
    try { text = JSON.parse(res.out).result; } catch { /* plain text */ }
    results.push(await verify("Claude Code", ctx, { ...res, out: text }));
  }
  if (which === "codex" || which === "both") {
    const ctx = await prepare("Codex");
    const srv = ctx.client.config.json.mcpServers["montaj-studio"];
    const o = (k, v) => ["-c", `mcp_servers.montaj-studio.${k}=${toml(v)}`];
    const res = await exec("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", ...o("command", srv.command), ...o("args", srv.args), ...o("env", srv.env), "-c", 'approval_policy="never"', ...(process.env.CODEX_MODEL ? ["-c", `model=${JSON.stringify(process.env.CODEX_MODEL)}`, "-c", 'model_reasoning_effort="medium"'] : []), TASK(ctx.project.name)], {});
    results.push(await verify("Codex", ctx, res));
  }
} finally {
  await app.close().catch(() => {});
}
const out = { date: new Date().toISOString(), versions: { claude: (await exec("claude", ["--version"], { shell: true })).out.trim(), codex: (await exec("codex", ["--version"], { shell: true })).out.trim() }, results };
fs.mkdirSync(path.join(APP, "bench", "results"), { recursive: true });
fs.writeFileSync(path.join(APP, "bench", "results", "agent_cli_check.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
try { fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
