#!/usr/bin/env node
// Command line for the cause ↔ reaction links (Phase 6): one links document + one labelling page per timeline.
//
//   node src/services/links/cli.mjs <timeline.json|folder>… --out <dir> [options]
//     --verify qwen3.6|none       the semantic check (default qwen3.6; needs the GPU lock for ~18.5 GB)
//     --gpu-lock <gpu-lock.mjs>   the parallel sessions' lock (default: LINKS_GPU_LOCK / PERCEPTION_GPU_LOCK)
//     --hint <type>               content type for every file (challenge, prank, comedy, vlog…); default: auto
//     --refresh                   ask the model again even when its answers are cached
//     --labels <dir>              evaluate against <dir>/<name>.labels.json (written by the labelling page)
//     --continue <dir>            start the labelling page from <dir>/<name>.labels.json (default: a blank page, so
//                                 nobody's earlier guesses steer the labeller)
//     --runtime <dir>  --cache <dir>  --perception-cache <dir>
// A folder means every *.timeline.json in it (the perception CLI's output); <name> = the timeline's file name
// without ".timeline.json".
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { LinkService } from "./linkService.js";
import { labelPageHtml, evaluate, pooled, validateLabels, indexHtml } from "./labels.js";
import { makeGpuLock } from "../perception/perceptionService.js";

const require = createRequire(import.meta.url);

function parse(argv) {
  const o = { files: [], verify: "qwen3.6" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--out") o.out = v();
    else if (a === "--verify") o.verify = v();
    else if (a === "--gpu-lock") o.gpuLock = v();
    else if (a === "--hint") o.hint = v();
    else if (a === "--refresh") o.refresh = true;
    else if (a === "--labels") o.labels = v();
    else if (a === "--continue") o.cont = v();
    else if (a === "--runtime") o.runtime = v();
    else if (a === "--cache") o.cache = v();
    else if (a === "--perception-cache") o.pcache = v();
    else o.files.push(a);
  }
  return o;
}

const expand = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort().filter((n) => n.endsWith(".timeline.json")).map((n) => path.join(p, n)) : [p]);

async function main() {
  const o = parse(process.argv.slice(2));
  if (!o.out || !o.files.length) { console.error("usage: cli.mjs <timeline.json|folder>… --out <dir> [--verify qwen3.6|none] [--gpu-lock …] [--labels <dir>]"); process.exit(2); }
  const lock = o.gpuLock || process.env.LINKS_GPU_LOCK || process.env.PERCEPTION_GPU_LOCK || null;
  if (o.verify !== "none" && !lock) console.error("WARNING: no GPU lock (--gpu-lock): the vision model will use the card without waiting for other jobs.");
  const svc = new LinkService({ runtimeDir: o.runtime, cacheDir: o.cache, perceptionCache: o.pcache, ffmpeg: require("ffmpeg-static"), gpuLock: makeGpuLock({ script: lock, name: "links" }), log: (l) => process.stderr.write(`${l}\n`) });
  fs.mkdirSync(o.out, { recursive: true });
  const evals = [], rows = [];
  for (const f of o.files.flatMap(expand)) {
    const name = path.basename(f).replace(/\.timeline\.json$/i, "");
    console.error(`== ${name}`);
    let last = -1;
    const doc = await svc.analyze(f, { verify: o.verify, hint: o.hint || null, refresh: !!o.refresh, onProgress: (p) => { const pc = Math.floor(p * 100); if (pc !== last) { last = pc; process.stderr.write(`\r${name} ${pc}%   `); } } });
    process.stderr.write("\n");
    fs.writeFileSync(path.join(o.out, `${name}.links.json`), JSON.stringify(doc, null, 1));
    rows.push({ name, doc });
    const lf = o.labels && path.join(o.labels, `${name}.labels.json`);
    const labels = lf && fs.existsSync(lf) ? JSON.parse(fs.readFileSync(lf, "utf8")) : null;
    const cf = o.cont && path.join(o.cont, `${name}.labels.json`);
    fs.writeFileSync(path.join(o.out, `${name}.labels.html`), labelPageHtml(doc, { labels: cf && fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, "utf8")) : null, fileName: `${name}.labels.json` }));
    const v = doc.report.verify;
    const one = (x) => (!x ? "—" : x.available ? `${x.engine}: ${x.cachedAnswers ?? 0} cached` + (x.runs?.length ? `, last run ${(Object.values(x.runs[x.runs.length - 1].msPerQuestion || {}).reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s` : "") : `${x.engine} unavailable: ${x.reason}`);
    console.error(`  ${doc.profile.kind} (${doc.profile.reason}) · ${JSON.stringify(doc.report.counts)} · verify ${v.engine === "both" ? `${one(v.vision)} + ${one(v.audio)}` : one(v)} · calibration ${JSON.stringify(v.calibration)} · roles ${JSON.stringify(doc.report.roles)}`);
    if (labels) {
      const bad = validateLabels(labels);
      if (bad.length) { console.error(`  labels: ${bad.join(", ")}`); continue; }
      const e = evaluate(doc, labels);
      evals.push(e);
      rows[rows.length - 1].eval = e;
      fs.writeFileSync(path.join(o.out, `${name}.eval.json`), JSON.stringify(e, null, 1));
      console.error(`  eval: ${JSON.stringify({ counts: e.counts, reactions: e.reactions, links: e.links })}`);
    }
  }
  const p = evals.length ? pooled(evals) : null;
  if (p) {
    fs.writeFileSync(path.join(o.out, "eval.pooled.json"), JSON.stringify(p, null, 1));
    console.error(`pooled: ${JSON.stringify(p)}`);
  }
  fs.writeFileSync(path.join(o.out, "index.html"), indexHtml(rows, p));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
