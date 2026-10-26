#!/usr/bin/env node
// Command line for the best-take scorer (Phase 5).
//
//   node src/services/takes/cli.mjs <file|folder>… --out <dir> [options]       score every retake group
//     --timelines <dir>        perception results (<case>__<name>.timeline.json, the perception CLI's output names);
//                              the words come from there when the media has no other transcript
//     --type <type>            content type (comedy, explainer, vlog, interview, cooking, challenge); default: from the name
//     --judge                  ask the AI judge (Qwen2.5-Omni-7B) on close calls; takes the GPU lock
//     --gpu-lock <script>      the parallel sessions' GPU lock (default: TAKES_GPU_LOCK / PERCEPTION_GPU_LOCK)
//     --store <dir>            the picks + learned weights folder (default <runtime>/takes-picks)
//     --stages prosody,…       feature stages (default: all installed)
//   node src/services/takes/cli.mjs --published <video> --raw <file>… --out <dir> [--store <dir>]
//                            match a published video to its raw by sound and store the takes it kept as picks
//   node src/services/takes/cli.mjs --import-picks <picks.json> --out <dir> [--store <dir>]
//                            picks saved by the pick page (<out>/اختار-الإعادة.html)
//   node src/services/takes/cli.mjs --measure [--store <dir>] [--out <dir>]   agreement with the picks, learn weights
// A folder means every video in it; a «خام» folder's files are named after their case folder in the output.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { TakeService } from "./takeService.js";
import { makeGpuLock } from "../perception/perceptionService.js";
import { pickPageHtml } from "./pickPage.js";

const require = createRequire(import.meta.url);
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mts)$/i;

function parse(argv) {
  const o = { files: [], raw: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--out") o.out = v();
    else if (a === "--timelines") o.timelines = v();
    else if (a === "--type") o.type = v();
    else if (a === "--judge") o.judge = true;
    else if (a === "--gpu-lock") o.gpuLock = v();
    else if (a === "--store") o.store = v();
    else if (a === "--stages") o.stages = v().split(",").filter(Boolean);
    else if (a === "--runtime") o.runtime = v();
    else if (a === "--published") o.published = v();
    else if (a === "--raw") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) o.raw.push(argv[++i]); }
    else if (a === "--import-picks") o.importPicks = v();
    else if (a === "--measure") o.measure = true;
    else o.files.push(a);
  }
  return o;
}

const expand = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort().flatMap((n) => expand(path.join(p, n))).filter((f) => VIDEO.test(f)) : [p]);
function nameOf(file) {
  const base = path.basename(file, path.extname(file));
  const parent = path.basename(path.dirname(file));
  return parent === "خام" ? `${path.basename(path.dirname(path.dirname(file)))}__${base}` : base;
}
const loadTimeline = (dir, file) => {
  const f = dir && path.join(dir, `${nameOf(file)}.timeline.json`);
  return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};

async function main() {
  const o = parse(process.argv.slice(2));
  const lockScript = o.gpuLock || process.env.TAKES_GPU_LOCK || process.env.PERCEPTION_GPU_LOCK || null;
  const svc = new TakeService({ runtimeDir: o.runtime, storeDir: o.store, ffmpeg: require("ffmpeg-static"), ffprobe: require("ffprobe-static").path,
    gpuLock: makeGpuLock({ script: lockScript, name: "best-take" }), log: (l) => process.stderr.write(`${l}\n`) });
  if (o.out) fs.mkdirSync(o.out, { recursive: true });

  if (o.measure) {
    const learned = svc.picks.learn();
    const m = svc.picks.measure();
    const report = { ...m, learned };
    console.log(JSON.stringify(report, null, 2));
    if (o.out) fs.writeFileSync(path.join(o.out, "measure.json"), JSON.stringify(report, null, 2));
    return;
  }
  if (o.importPicks) {
    const sheet = JSON.parse(fs.readFileSync(o.importPicks, "utf8"));
    let n = 0;
    for (const p of sheet.picks || []) {
      const res = JSON.parse(fs.readFileSync(path.join(o.out, `${p.name}.takes.json`), "utf8"));
      const g = res.groups[p.group];
      if (!g || !Number.isInteger(p.picked)) continue;
      svc.picks.add({ media: res.media, g, picked: p.picked, source: "hand", note: p.note || null });
      n++;
    }
    console.log(`imported ${n} pick(s) into ${svc.picks.file}`);
    return;
  }
  if (o.published) {
    const results = {};
    for (const raw of o.raw) {
      const f = path.join(o.out, `${nameOf(raw)}.takes.json`);
      results[raw] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : await svc.analyze({ media: raw, timeline: loadTimeline(o.timelines, raw), type: o.type });
    }
    const r = await svc.learnFromPublished(o.published, results);
    console.log(JSON.stringify(r.picks, null, 2));
    fs.writeFileSync(path.join(o.out, `${path.basename(o.published)}.match.json`), JSON.stringify(r, null, 2));
    return;
  }
  if (!o.out || !o.files.length) { console.error("usage: cli.mjs <file|folder>… --out <dir> [--timelines <dir>] [--type …] [--judge]"); process.exit(2); }
  if (o.judge && !lockScript) console.error("WARNING: --judge without a GPU lock (--gpu-lock or TAKES_GPU_LOCK): the judge (~18 GB) will not wait for other jobs.");
  const pages = [];
  for (const f of o.files.flatMap(expand)) {
    const name = nameOf(f);
    const timeline = loadTimeline(o.timelines, f);
    process.stderr.write(`== ${name}${timeline ? "" : " (no timeline)"}\n`);
    const res = await svc.analyze({ media: f, timeline, type: o.type, judge: !!o.judge, stages: o.stages,
      onProgress: (p) => process.stderr.write(`\r${name} ${p.stage} ${Math.round(p.progress * 100)}%   `) });
    process.stderr.write("\n");
    fs.writeFileSync(path.join(o.out, `${name}.takes.json`), JSON.stringify(res, null, 1));
    for (const g of res.groups) console.log(`${name}: «${String(g.line).slice(0, 50)}» ×${g.takes.length} → take ${g.kept + 1} (${g.keptBy}; default ${g.defaultKept + 1}) — ${g.reason}`);
    if (!res.groups.length) console.log(`${name}: no retakes`);
    pages.push({ name, res });
  }
  fs.writeFileSync(path.join(o.out, "اختار-الإعادة.html"), pickPageHtml(pages));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
