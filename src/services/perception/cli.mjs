#!/usr/bin/env node
// Command line for the perception pipeline: one event timeline (+ a short Arabic HTML page) per media file.
//
//   node src/services/perception/cli.mjs <file|folder>… --out <dir> [options]
//     --stages words,speakers,…   only these stages (and what they need); default: all
//     --asr nemo|file             speech engine (default nemo); --asr-file <json> with --asr file
//     --gpu-lock <gpu-lock.mjs>   take the shared GPU lock around every model run (the parallel sessions' lock)
//     --runtime <dir>             the runtime folder (venvs + models); default: the project's runtime/
//     --cache <dir>               result cache (default <runtime>/perception-cache)
//     --refresh stage,…           run these stages again even when cached
//     --num-speakers N            a known number of speakers
//     --asd light-asd             the fast active-speaker model
//     --status                    print what is installed and exit
// A folder means every video in it; a «خام» folder's files are named after their case folder in the output.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PerceptionService, makeGpuLock, STAGES } from "./perceptionService.js";
import { summaryHtml } from "./summary.js";

const require = createRequire(import.meta.url);
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mts|wav|mp3|m4a)$/i;

function parse(argv) {
  const o = { files: [], stages: STAGES, refresh: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--out") o.out = v();
    else if (a === "--stages") o.stages = v().split(",").filter(Boolean);
    else if (a === "--asr") o.asr = v();
    else if (a === "--asr-file") o.options.asrFile = v();
    else if (a === "--gpu-lock") o.gpuLock = v();
    else if (a === "--runtime") o.runtime = v();
    else if (a === "--cache") o.cache = v();
    else if (a === "--refresh") o.refresh = v().split(",");
    else if (a === "--num-speakers") o.options.numSpeakers = Number(v());
    else if (a === "--asd") o.options.asdModel = v();
    else if (a === "--nemo-model") o.options.nemoModel = v();
    else if (a === "--status") o.status = true;
    else o.files.push(a);
  }
  return o;
}

function expand(p) {
  if (!fs.existsSync(p)) throw new Error(`not found: ${p}`);
  if (fs.statSync(p).isDirectory()) return fs.readdirSync(p).sort().flatMap((n) => expand(path.join(p, n))).filter((f) => VIDEO.test(f));
  return [p];
}

function nameOf(file) {
  const base = path.basename(file, path.extname(file));
  const parent = path.basename(path.dirname(file));
  return parent === "خام" ? `${path.basename(path.dirname(path.dirname(file)))}__${base}` : base;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const ffmpeg = require("ffmpeg-static");
  const ffprobe = require("ffprobe-static").path;
  const svc = new PerceptionService({ runtimeDir: o.runtime, cacheDir: o.cache, ffmpeg, ffprobe, gpuLock: makeGpuLock({ script: o.gpuLock }), log: (l) => process.stderr.write(`${l}\n`) });
  if (o.status) { console.log(JSON.stringify(svc.status(), null, 2)); return; }
  if (!o.out || !o.files.length) { console.error("usage: cli.mjs <file|folder>… --out <dir> [--stages …] [--gpu-lock …]"); process.exit(2); }
  fs.mkdirSync(o.out, { recursive: true });
  const files = o.files.flatMap(expand);
  for (const f of files) {
    const name = nameOf(f);
    console.error(`== ${name}`);
    let last = -1;
    const tl = await svc.analyze(f, {
      stages: o.stages, asr: o.asr || "nemo", options: o.options, refresh: o.refresh,
      onProgress: (p) => { const pc = Math.floor(p.progress * 100); if (pc !== last) { last = pc; process.stderr.write(`\r${name} ${p.stage} ${pc}%   `); } },
    });
    process.stderr.write("\n");
    const thumbs = {};
    for (const p of tl.faces || []) {
      const file = tl.artifacts?.faces && p.thumb ? path.join(tl.artifacts.faces, p.thumb) : null;
      if (file && fs.existsSync(file)) thumbs[p.id] = `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
    }
    fs.writeFileSync(path.join(o.out, `${name}.timeline.json`), JSON.stringify(tl, null, 1));
    fs.writeFileSync(path.join(o.out, `${name}.html`), summaryHtml(tl, { thumbs }));
    const r = tl.report.stages;
    console.error(Object.entries(r).map(([s, x]) => `  ${s}: ${x.failed ? `FAILED ${x.failed.slice(0, 300)}` : x.skipped ? `skipped (${x.skipped})` : `${((x.ms || 0) / 1000).toFixed(1)} s${x.cached ? " (cache)" : ""}, VRAM +${x.vram?.deltaMB ?? "?"} MB`}`).join("\n"));
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
