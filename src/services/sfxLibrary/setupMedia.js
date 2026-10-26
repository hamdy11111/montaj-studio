// Sets up the media runtime next to the video runtime (it needs it: torch + transformers + ComfyUI's code), resumably:
//   1. runtime/media: a venv of runtime/python312 + a .pth file to runtime/video's site-packages + requirements-media.txt
//   2. runtime/media/src: MatAnyone2 and CoTracker sources (pinned commits), each on the path by a .pth file
//   3. runtime/models/media: the models of mediaModels.js (Hugging Face, pinned revisions; files already there are kept)
//   node src/services/sfxLibrary/setupMedia.js "<...>/runtime" [--skip-models] [--only clap,siglip2,…] [--no-images]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MEDIA_MODELS, MEDIA_COMFY_FILES, MEDIA_SOURCES } from "./mediaModels.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === "win32";
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { stdio: "inherit", ...opts }); if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(" ")} failed (${r.status})`); };

export function setupMedia(runtime, { skipModels = false, only = null, images = true, log = console.log } = {}) {
  const base = path.join(runtime, "python312", win ? "python.exe" : "bin/python3");
  const video = path.join(runtime, "video");
  if (!fs.existsSync(base) || !fs.existsSync(video)) throw new Error("the video runtime (runtime/python312 + runtime/video) must be set up first");
  const dir = path.join(runtime, "media");
  const py = path.join(dir, win ? "Scripts/python.exe" : "bin/python");
  const site = win ? path.join(dir, "Lib", "site-packages") : path.join(dir, "lib", "python3.12", "site-packages");
  if (!fs.existsSync(py)) { log("venv runtime/media"); run(base, ["-m", "venv", dir]); }
  fs.writeFileSync(path.join(site, "zz_video_runtime.pth"), `${win ? path.join(video, "Lib", "site-packages") : path.join(video, "lib", "python3.12", "site-packages")}\n`);
  log("pip install requirements-media.txt");
  run(py, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(HERE, "requirements-media.txt")]);
  const src = path.join(dir, "src");
  fs.mkdirSync(src, { recursive: true });
  for (const s of MEDIA_SOURCES) {
    const dest = path.join(src, s.name);
    if (!fs.existsSync(dest)) {
      log(`source ${s.name}`);
      const zip = path.join(src, `${s.name}.zip`);
      run(py, ["-c", "import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])", s.url, zip]);
      const tmp = path.join(src, `_${s.name}`);
      run(py, ["-c", "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zip, tmp]);
      fs.renameSync(path.join(tmp, fs.readdirSync(tmp)[0]), dest);
      fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true });
    }
    fs.writeFileSync(path.join(site, `${s.name.toLowerCase().replace(/[^a-z0-9]/g, "")}_src.pth`), `${dest}\n`);
  }
  if (skipModels) return;
  const models = path.join(runtime, "models", "media");
  fs.mkdirSync(models, { recursive: true });
  for (const m of MEDIA_MODELS) {
    if (only && !only.includes(m.id)) continue;
    log(`model ${m.repo}@${m.rev.slice(0, 7)} (${(m.bytes / 1e9).toFixed(1)} GB, ${m.license})`);
    run(py, ["-c", "import sys,json;from huggingface_hub import snapshot_download as s;a=json.loads(sys.argv[1]);s(a['repo'],revision=a['rev'],local_dir=a['dir'],allow_patterns=a['allow'],max_workers=8)",
      JSON.stringify({ repo: m.repo, rev: m.rev, dir: path.join(models, m.repo.replace("/", "__")), allow: m.allow || null })]);
  }
  if (!images) return;
  for (const f of MEDIA_COMFY_FILES) {
    const [sub, name] = f.path.split("/").slice(-2);
    const dest = path.join(models, "comfy", sub, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.bytes) continue;
    log(`image model ${name} (${(f.bytes / 1e9).toFixed(1)} GB, ${f.license})`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    run(py, ["-c", "import sys,shutil;from huggingface_hub import hf_hub_download as d;p=d(sys.argv[1],sys.argv[2],revision=sys.argv[3],local_dir=sys.argv[4]);shutil.move(p,sys.argv[5])",
      f.repo, f.path, f.rev, path.join(models, "comfy", "_dl"), dest]);
  }
  fs.rmSync(path.join(models, "comfy", "_dl"), { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rt = process.argv[2];
  if (!rt) { console.error("usage: setupMedia.js <runtime dir> [--skip-models] [--only a,b] [--no-images]"); process.exit(1); }
  const i = process.argv.indexOf("--only");
  setupMedia(rt, { skipModels: process.argv.includes("--skip-models"), only: i > 0 ? process.argv[i + 1].split(",") : null, images: !process.argv.includes("--no-images") });
}
