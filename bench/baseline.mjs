// Phase 0 baseline: the app's CURRENT automatic editor on every bench case, through the real app (Electron, a
// temporary profile — the user's projects are never touched; the raw files are imported in place, never copied).
// For each case: a project with the raw file(s) on the timeline in the source's own orientation → «Smart edit»
// (director.run) → a 1080p export → the quality report and the story (what was kept, in what order).
//
//   node bench/baseline.mjs [--cases "<...\montaj-bench\الحالات>"] [--out "<...\montaj-bench\النتائج\baseline>"] [--only 01-فلوق]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { rawFiles } from "./align.mjs";
import { report } from "./quality.mjs";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BENCH = path.resolve(APP, "..", "montaj-bench");
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const casesDir = opt("--cases", path.join(BENCH, "الحالات"));
const out = opt("--out", path.join(BENCH, "النتائج", "baseline"));
const only = opt("--only", null);
const skip = new Set((opt("--skip", "") || "").split(",").filter(Boolean));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cases = fs.readdirSync(casesDir).filter((c) => (!only || c === only) && !skip.has(c) && rawFiles(path.join(casesDir, c)).length);
fs.mkdirSync(out, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-baseline-"));
const app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, MONTAJ_USER_DATA: ud, REALM_DISABLE_ANALYTICS: "1" } });
// The app's own output (crashes, main-process errors) is kept next to the results.
const appLog = fs.createWriteStream(path.join(out, "baseline-app.log"), { flags: "a" });
app.process().stdout?.on("data", (d) => appLog.write(d));
app.process().stderr?.on("data", (d) => appLog.write(d));
app.on("close", () => appLog.write(`
[app closed at ${new Date().toISOString()}]
`));
const win = await app.firstWindow();
win.on("crash", () => appLog.write(`
[renderer crashed at ${new Date().toISOString()}]
`));
await win.waitForSelector(".home");
const api = (method, ...args) => win.evaluate(([m, x]) => window.api.call(m, ...x), [method, args]);
await api("settings.set", "general", { onboarded: true });
// Earlier runs stay: a case measured again replaces its own row only.
const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(out, "baseline.json"), "utf8")).cases || []; } catch { return []; } })();
const summary = prev.filter((r) => !cases.includes(r.case));
try {
  for (const c of cases) {
    const raws = rawFiles(path.join(casesDir, c));
    const t0 = Date.now();
    const row = { case: c, raws: raws.map((r) => path.basename(r)) };
    try {
      const p = await api("project.create", { name: `baseline ${c}` });
      await api("media.import", p.id, raws);
      const media = await api("media.list", p.id, {});
      // The source's own orientation (never turn a horizontal video vertical): 9:16 for portrait footage.
      const portrait = media.some((m) => m.height > m.width);
      await api("timeline.exec", p.mainTimelineId, "setCanvas", { ratio: portrait ? "9:16" : "16:9" });
      for (const m of media.filter((x) => x.type === "video")) await api("timeline.exec", p.mainTimelineId, "addMedia", { mediaId: m.id, toMain: true });
      const tDir = Date.now();
      const r = await api("director.run", p.mainTimelineId, {});
      row.directorSec = Math.round((Date.now() - tDir) / 1000);
      row.notes = r?.notes || [];
      row.qa = r?.qa ? { warnings: (r.qa.warnings || r.qa.issues || []).length } : null;
      const name = c;
      const tEx = Date.now();
      const job = await api("export.start", { timelineId: p.mainTimelineId, mode: "video", name, dir: out, resolution: "1080p", codec: "h264", format: "mp4", fps: 30 });
      for (;;) {
        await sleep(3000);
        const rec = (await api("export.list", {})).find((x) => x.path === job.path);
        if (rec && ["done", "error", "cancelled", "failed"].includes(rec.status)) { row.exportStatus = rec.status; if (rec.error) row.exportError = String(rec.error).slice(0, 400); break; }
        if (Date.now() - tEx > 2 * 60 * 60_000) { row.exportStatus = "timeout"; break; }
      }
      row.exportSec = Math.round((Date.now() - tEx) / 1000);
      row.file = job.path;
      if (row.exportStatus === "done") {
        const q = await report(job.path, { out, name: `${c}.baseline`, raws });
        row.quality = { verdict: q.verdict.map((v) => ({ ok: v.ok, text: v.text })), video: { duration: q.video.duration, cuts: q.video.cuts, median: q.video.shot.median, deadOver2: q.video.deadAir.over2s.length, still: q.video.stillestSec },
          story: q.story && !q.story.error ? { keptOfRawPct: q.story.keptOfRawPct, orderTau: q.story.orderTau, openingFromRawPct: q.story.openingFromRawPct } : q.story };
        row.report = q.html;
      }
    } catch (e) {
      row.error = String(e?.message || e).slice(0, 800);
    }
    row.totalSec = Math.round((Date.now() - t0) / 1000);
    summary.push(row);
    fs.writeFileSync(path.join(out, "baseline.json"), JSON.stringify({ schema: "montaj-bench.baseline/1", at: new Date().toISOString(), cases: summary }, null, 1));
    console.log(`${c}: ${row.error ? `ERROR ${row.error}` : `${row.exportStatus}, director ${row.directorSec}s, export ${row.exportSec}s`}`);
  }
} finally {
  await app.close().catch(() => {});
  // Kept when something failed: its logs folder says why.
  if (summary.some((r) => r.error && cases.includes(r.case))) console.log(`app data kept for diagnosis: ${ud}`);
  else try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* Windows may hold a file */ }
}
