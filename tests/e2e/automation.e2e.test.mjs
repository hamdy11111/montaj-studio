// Editing automation end to end, in the real app with a real MCP client (official SDK) and the real local speech
// model: the agent analyses spoken audio (word timings), applies a whole edit plan with animated captions, and
// looks at the result with timeline_frames — images rendered through the export graph and the hidden raster window.
// The frame with captions is compared with the same frame after undo, so the captions are proven to be drawn.
// Skipped when no local speech provider is configured or Windows speech synthesis is unavailable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { binaries, run } from "../../src/services/ffmpeg.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ART = path.join(APP, "tests", "e2e", "artifacts");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-auto-e2e-"));
const media = path.join(ud, "_media");
const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\montaj-auto-${process.pid}` : path.join(ud, "agents.sock");
let app, win, client, skip = null;
const errors = [];
const api = (m, ...a) => win.evaluate(([mm, aa]) => window.api.call(mm, ...aa), [m, a]);
const data = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return r.structuredContent; };

/** English test speech with a filler, a pause and a restarted sentence (Windows speech synthesis). */
function speak(wav) {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">So today I want to show you, um, three editing tricks. <break time="1500ms"/> The first trick is to cut the silence. The first trick is to cut every silence between sentences. <break time="800ms"/> The second trick is to add captions, because most people watch without sound.</speak>`;
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.SpeakSsml(@'\n${ssml}\n'@); $s.Dispose()`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "pipe", timeout: 60_000 });
}

before(async () => {
  fs.mkdirSync(media, { recursive: true });
  fs.mkdirSync(ART, { recursive: true });
  try { speak(path.join(media, "talk.wav")); } catch { skip = "Windows speech synthesis unavailable"; return; }
  await run(binaries().ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=25", "-i", path.join(media, "talk.wav"), "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(media, "talk.mp4")], { timeoutMs: 120_000 });
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, MONTAJ_PIPE: PIPE, REALM_DISABLE_ANALYTICS: "1" } });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForSelector(".home", { timeout: 30_000 });
  await api("settings.set", "general", { onboarded: true });
  if (!(await api("captions.status", true)).words) { skip = "no local speech provider (Settings › Providers)"; return; }
  await api("settings.set", "agents", { enabled: true });
  await win.waitForTimeout(300);
  const cfg = (await api("agents.createClient", { name: "Automation e2e", scopes: ["read", "media", "edit"], projects: "*", importRoots: [media] })).config.json.mcpServers["montaj-studio"];
  client = new Client({ name: "automation-e2e", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...cfg.env, SystemRoot: process.env.SystemRoot || "" }, stderr: "pipe" }));
});

after(async () => {
  await client?.close().catch(() => {});
  await app?.close().catch(() => {});
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may hold a file */ }
});

let tid, mid;
test("the agent finds fillers, pauses and the retake in real speech", async (t) => {
  if (skip) return t.skip(skip);
  const tools = (await client.listTools()).tools.map((x) => x.name);
  for (const n of ["media_analyze_speech", "media_transcribe", "media_frames", "timeline_frames", "edit_plan_schema", "edit_plan_validate", "edit_plan_apply", "timeline_add_captions_pro", "captions_templates"]) assert.ok(tools.includes(n), n);
  const p = data(await client.callTool({ name: "project_create", arguments: { name: "Automation", ratio: "9:16" } }));
  tid = p.mainTimelineId;
  mid = data(await client.callTool({ name: "media_import", arguments: { projectId: p.projectId, paths: [path.join(media, "talk.mp4")] } })).imported[0].mediaId;
  data(await client.callTool({ name: "timeline_add_clip", arguments: { timelineId: tid, mediaId: mid } }));
  const job = data(await client.callTool({ name: "media_analyze_speech", arguments: { mediaId: mid, language: "en", style: "natural" } }));
  assert.equal(job.status, "done", JSON.stringify(job.error));
  const a = job.result;
  assert.ok(a.stats.words > 30);
  assert.ok(a.fillers.some((f) => f.sure && /^um/i.test(f.text)), JSON.stringify(a.fillers));
  assert.ok(a.retakes.some((r) => r.kind === "restart" && /first trick/i.test(r.text)), JSON.stringify(a.retakes));
  assert.ok(a.pauses.some((x) => x.durUs >= 1_200_000));
  const look = await client.callTool({ name: "media_frames", arguments: { mediaId: mid, count: 2, short: 160 } });
  assert.equal(look.content.filter((c) => c.type === "image").length, 2, "the agent receives real images");
  t.diagnostic(`speech: ${a.stats.words} words, ${a.suggestedCuts.length} cuts, ${(a.stats.durationUs / 1e6).toFixed(1)} s → ${(a.stats.afterCutsUs / 1e6).toFixed(1)} s`);
  globalThis.__analysis = a;
});

test("the agent applies a plan with captions and sees them in the rendered frames; undo removes everything", async (t) => {
  if (skip) return t.skip(skip);
  const a = globalThis.__analysis;
  const plan = { schema: "montaj.editplan/1", title: "e2e reel", canvas: { ratio: "9:16", bgType: "blur" },
    cuts: a.suggestedCuts.map((c) => ({ mediaId: mid, fromUs: c.fromUs, toUs: c.toUs, reason: c.reason })),
    audio: { normalizeLufs: -14 }, captions: { template: "box-highlight", language: "en", keywords: ["captions"] } };
  const v = data(await client.callTool({ name: "edit_plan_validate", arguments: { timelineId: tid, plan } }));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const start = data(await client.callTool({ name: "timeline_inspect", arguments: { timelineId: tid } }));
  const rev = start.revision;
  const job = data(await client.callTool({ name: "edit_plan_apply", arguments: { timelineId: tid, plan, expectedRevision: rev } }));
  assert.equal(job.status, "done", JSON.stringify(job.error));
  assert.equal(job.result.after.durationUs, v.summary.afterUs);
  const caps = (await api("timeline.get", tid)).timeline.tracks.flatMap((x) => x.segments).filter((s) => s.text?.caption);
  assert.ok(caps.length >= 4);
  const at = caps[2].start + 200_000;
  const withCaps = await client.callTool({ name: "timeline_frames", arguments: { timelineId: tid, timesUs: [at], short: 360 } });
  assert.equal(withCaps.structuredContent.textOmitted, undefined, "captions are rasterized by the app");
  const img = withCaps.content.find((c) => c.type === "image");
  fs.writeFileSync(path.join(ART, "auto-frame-captions.jpg"), Buffer.from(img.data, "base64"));
  data(await client.callTool({ name: "timeline_undo", arguments: { timelineId: tid } }));
  data(await client.callTool({ name: "timeline_redo", arguments: { timelineId: tid } }));
  // Same frame without the caption track: hide it by deleting captions through the app, then compare.
  const ids = (await api("timeline.get", tid)).timeline.tracks.flatMap((x) => x.segments).filter((s) => s.text?.caption).map((s) => s.id);
  await api("timeline.exec", tid, "delete", { ids });
  const noCaps = await client.callTool({ name: "timeline_frames", arguments: { timelineId: tid, timesUs: [at], short: 360 } });
  fs.writeFileSync(path.join(ART, "auto-frame-plain.jpg"), Buffer.from(noCaps.content.find((c) => c.type === "image").data, "base64"));
  // The caption band differs (captions drawn there); the top of the frame is the same picture.
  const psnr = async (y, h) => {
    const r = await run(binaries().ffmpeg, ["-hide_banner", "-i", path.join(ART, "auto-frame-captions.jpg"), "-i", path.join(ART, "auto-frame-plain.jpg"), "-filter_complex", `[0]crop=iw:ih*${h}:0:ih*${y}[a];[1]crop=iw:ih*${h}:0:ih*${y}[b];[a][b]psnr`, "-f", "null", "-"]);
    return Number(/average:([\d.inf]+)/.exec(r.stderr.toString())?.[1].replace("inf", "99"));
  };
  const band = await psnr(0.55, 0.25), top = await psnr(0.0, 0.25);
  t.diagnostic(`PSNR caption band ${band} dB, top ${top} dB`);
  assert.ok(band < 30, `captions visible in the frame (band PSNR ${band})`);
  assert.ok(top > 35, `rest of the frame unchanged (top PSNR ${top})`);
  await api("timeline.exec", tid, "undo", {});
  data(await client.callTool({ name: "timeline_undo", arguments: { timelineId: tid } }));
  const back = data(await client.callTool({ name: "timeline_inspect", arguments: { timelineId: tid } }));
  assert.equal(back.durationUs, start.durationUs, "the cuts are undone too");
  assert.ok(!back.tracks.some((tr) => tr.clips.some((c) => c.text?.isCaption)), "one undo removes the whole plan, captions included");
  assert.deepEqual(errors, []);
});
