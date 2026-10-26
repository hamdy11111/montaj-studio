// The set-up of the AI layers — perception («الإدراك»), best take («أحسن إعادة»), cause ↔ reaction links («الربط») and
// the B-roll index — in the studios' style (engineSetupService.js): everything lands in the app's data folder
// (runtime/), from official sources pinned in aiSetup/catalog.json, resumable and SHA-256 checked:
//   runtime/python312          the portable CPython 3.12 the engines share (downloaded when missing)
//   runtime/perception|takes   a venv each with the pinned requirements (aiSetup/requirements-*.txt); torch's CUDA 13.0
//                              wheels are fetched by the app (the video studio's), then pip installs the local files
//   runtime/media              the B-roll index's venv: its own few packages on top of the video studio's runtime
//   runtime/llama              llama.cpp (the dubbing set-up's pinned build) for the Qwen vision models
//   runtime/models/<layer>/…   the model sets, file by file
// Nothing is downloaded twice: "import" adopts what a folder already has (the phases' hand-made runtime, the Hugging
// Face cache…) after checking every file's SHA-256 — a whole folder is linked in place (a junction: no copy, no extra
// disk), single files are hard-linked on the same drive or copied otherwise. A runtime is imported the same way, after
// its health check. "Check" verifies every file / every installed package; "repair" re-downloads damaged or missing
// files and reinstalls exactly the broken packages (a package whose files were deleted still counts as installed for
// pip, so the check reads each package's RECORD). A layer that is missing or partial degrades cleanly: its stages are
// skipped and the director falls back. One task at a time; progress is sent as "ai:setup".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AppError } from "../core/validation.js";
import { EngineSetupService, nvidiaDriver } from "./engineSetupService.js";
import { runProc, sha256File, cpuRequirements } from "./asrSetupService.js";
import { hasNvidia } from "./dubSetupService.js";
import {
  AI_SETUP_DIR, ENVS, DEPENDS, LAYERS, layerDef, layerSets, modelSet, layerState, locateFiles, linkableTops, pinLocalWheels,
  requirementOf, TORCH_WHEELS, TORCH_INDEX, MIN_DRIVER, PYTHON312, LLAMA,
} from "./aiSetup/catalog.js";

const win = process.platform === "win32";
const bin = win ? "Scripts" : "bin";
const exe = (p) => (win ? `${p}.exe` : p);
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

/** Is `p` a junction or symbolic link (never deleted through: only unlinked)? Its target, or null. */
export function linkTarget(p) {
  try { return fs.lstatSync(p).isSymbolicLink() ? fs.realpathSync(p) : null; } catch { return null; }
}

/** The card: { nvidia, name, vramMB, freeMB, driver, minDriver, driverOk } (nvidia-smi; nothing when there is none). */
export function gpuInfo() {
  const out = { nvidia: false, name: null, vramMB: null, freeMB: null, driver: null, minDriver: MIN_DRIVER, driverOk: false };
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10_000, encoding: "utf8" });
    const [name, total, free, driver] = String(r.stdout || "").split(/\r?\n/)[0].split(",").map((s) => s.trim());
    if (r.status === 0 && name) Object.assign(out, { nvidia: true, name, vramMB: Number(total), freeMB: Number(free), driver: parseInt(driver, 10) || nvidiaDriver() });
  } catch { /* no NVIDIA driver */ }
  out.driverOk = out.nvidia && out.driver !== null && out.driver >= MIN_DRIVER;
  return out;
}

/** Files with the given names under `root` (to `depth` folders down, links not followed): name → [paths]. */
export function findByName(root, names, depth = 8) {
  const out = new Map();
  const walk = (dir, d) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d > 0 && !e.name.startsWith(".") && e.name !== "__pycache__" && e.name !== "site-packages") walk(p, d - 1);
      else if ((e.isFile() || e.isSymbolicLink()) && names.has(e.name)) out.set(e.name, [...(out.get(e.name) || []), p]);
    }
  };
  walk(root, depth);
  return out;
}

/** The Hugging Face cache folder of a repository. */
export const hfCacheDir = (repo, home = os.homedir()) => path.join(process.env.HF_HOME || path.join(home, ".cache", "huggingface"), "hub", `models--${repo.replace("/", "--")}`);

/** The Hugging Face cache snapshots of a repository (newest first), where an earlier download may already be. */
export function hfCacheSnapshots(repo, home = os.homedir()) {
  const snaps = path.join(hfCacheDir(repo, home), "snapshots");
  try { return fs.readdirSync(snaps).map((d) => path.join(snaps, d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); } catch { return []; }
}

export class AiSetupService extends EngineSetupService {
  /** runtimeRoot: where the runtimes and models go (default: <data folder>/runtime). */
  constructor({ paths, settings = null, notify = () => {}, log = () => {}, runtimeRoot = null }) {
    super({ paths, settings, notify, log }, { name: "ai", modelSets: [] });
    this.root = runtimeRoot || path.join(paths.root, "runtime");
    this.healthFile = path.join(this.root, "ai-setup-health.json");
  }

  // ---------------------------------------------------------------- where things are
  envDir(env) { return path.join(this.root, ENVS[env].name); }
  envPython(env) { return path.join(this.envDir(env), bin, exe("python")); }
  modelsDir(root) { return path.join(this.root, "models", root); }
  fileDest(set, f) { return path.join(this.modelsDir(set.root), ...f.dir.split("/"), f.file); }
  depPath(dep) { return path.join(this.root, ...DEPENDS[dep].path.flatMap((p) => p.split("/"))); }
  health() { try { return JSON.parse(fs.readFileSync(this.healthFile, "utf8")); } catch { return {}; } }
  saveHealth(env, h) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.healthFile, JSON.stringify({ ...this.health(), [env]: { ...h, at: new Date().toISOString() } }, null, 1));
  }
  setOf(key) {
    const [layer, id] = String(key).split("/");
    const s = modelSet(layer, id);
    if (!s) throw new AppError("VALIDATION", "err.enum", { field: "set" });
    return s;
  }

  // ---------------------------------------------------------------- status
  /** One set, file by file: ok / missing / partial / damaged (by size; `verify` checks the SHA-256 too). */
  async setStatus(set, { verify = false } = {}) {
    const files = [];
    for (const f of set.files) {
      const p = this.fileDest(set, f);
      let state = "missing", partBytes = 0;
      if (fs.existsSync(p)) {
        const size = fs.statSync(p).size;
        state = size !== f.size ? "damaged" : verify ? ((await sha256File(p)) === f.sha256 ? "ok" : "damaged") : "ok";
      } else if (fs.existsSync(`${p}.part`)) { state = "partial"; partBytes = fs.statSync(`${p}.part`).size; }
      files.push({ file: f.file, dir: f.dir, size: f.size, state, partBytes, source: f.source, derived: f.derived || null });
    }
    const links = Object.fromEntries(set.dirs.map((d) => [d, linkTarget(path.join(this.modelsDir(set.root), d))]).filter(([, t]) => t));
    return {
      key: set.key, id: set.id, layer: set.layer, name: set.name, license: set.license, sources: set.sources, gpuGB: set.gpuGB, stages: set.stages,
      optional: set.optional, gated: set.gated, importOnly: set.importOnly, borrowed: !!set.borrowed, bytes: set.bytes,
      installed: files.every((f) => f.state === "ok"), haveBytes: files.filter((f) => f.state === "ok").reduce((n, f) => n + f.size, 0),
      missing: files.filter((f) => f.state !== "ok").length, links, files,
    };
  }

  envStatus(env) {
    const dir = this.envDir(env), h = this.health()[env] || null;
    const installed = fs.existsSync(this.envPython(env));
    return { name: env, dir, installed, link: linkTarget(dir), ok: installed ? (h ? h.ok : null) : false, checkedAt: h?.at || null, problems: h && !h.ok ? h : null, bytes: ENVS[env].bytes, overlay: ENVS[env].overlay || null };
  }

  depStatus(dep) { const p = this.depPath(dep); return { id: dep, what: DEPENDS[dep].what, ok: fs.existsSync(p), link: linkTarget(path.dirname(p).split(path.sep).slice(0, this.root.split(path.sep).length + 1).join(path.sep)), installable: !!DEPENDS[dep].installable, setup: DEPENDS[dep].setup || null }; }

  /** Every layer: its runtime, sets, dependencies and state; the card; the running task. */
  async status({ verify = false } = {}) {
    const gpu = gpuInfo();
    const layers = [];
    for (const L of LAYERS) {
      const sets = [];
      for (const s of layerSets(L.id)) sets.push(await this.setStatus(s, { verify }));
      const env = this.envStatus(L.env), deps = L.depends.map((d) => this.depStatus(d));
      const needGB = Math.max(0, ...sets.filter((s) => s.installed || !s.optional).map((s) => s.gpuGB));
      layers.push({ id: L.id, env, sets, deps, after: L.after || [], state: layerState({ env, sets, deps }), needGB,
        gpuShort: gpu.vramMB !== null && needGB * 1024 > gpu.vramMB, bytes: sets.filter((s) => !s.borrowed).reduce((n, s) => n + s.bytes, 0) + env.bytes,
        haveBytes: sets.filter((s) => !s.borrowed).reduce((n, s) => n + s.haveBytes, 0) });
    }
    return { root: this.root, gpu, layers, task: { ...this.state } };
  }

  /** Is this layer usable at all (runtime present and at least one required set)? For other services' quick checks. */
  async ready(layer) { return (await this.status()).layers.find((l) => l.id === layer)?.state !== "missing"; }

  // ---------------------------------------------------------------- runtimes
  /** Runs aiSetup/venv_check.py in the env: broken packages, missing pins, failed imports. Saved as the env's health. */
  async checkEnv(env, { python = this.envPython(env), signal } = {}) {
    if (!fs.existsSync(python)) return { ok: false, notInstalled: true };
    const req = path.join(AI_SETUP_DIR, ENVS[env].requirements);
    let out = "", line = null;
    try {
      // The report is one JSON line on stdout; it can be long, so the whole line is kept (runProc returns a tail).
      out = await runProc(python, ["-I", path.join(AI_SETUP_DIR, "venv_check.py"), req, ENVS[env].imports.join(",")], { signal, onLine: (l) => { if (l.startsWith("{")) line = l; } });
    } catch (e) { const h = { ok: false, error: String(e?.details?.output || e.message).slice(-1500) }; if (python === this.envPython(env)) this.saveHealth(env, h); return h; }
    let h;
    try { h = JSON.parse(line); } catch { h = { ok: false, error: out.slice(-1500) }; }
    if (python === this.envPython(env)) this.saveHealth(env, h);
    return h;
  }

  /** The portable Python 3.12 (shared with the studios), downloaded when this runtime folder has none. */
  async basePython(signal) {
    const base = path.join(this.root, "python312");
    const py = path.join(base, exe("python"));
    if (fs.existsSync(py)) return py;
    if (!win) throw new AppError("PROVIDER", "err.asrSetupWindows");
    this.emit({ step: "python" });
    const archive = await this.fetchFile(PYTHON312, path.join(this.root, "python312.tar.gz"), signal);
    const tmp = path.join(this.root, "python312-unpack");
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await runProc(TAR, ["-xzf", archive, "-C", tmp], { signal });
    fs.renameSync(path.join(tmp, "python"), base);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    return py;
  }

  /** torch's CUDA wheels fetched by the app (resumable, checked): name → file URL for pip. */
  async torchWheels(signal, from = 0.05, span = 0.35) {
    const dir = path.join(this.root, "wheels-ai");
    const total = TORCH_WHEELS.reduce((n, w) => n + w.size, 0);
    const files = {};
    let done = 0;
    for (const w of TORCH_WHEELS) {
      const file = await this.fetchFile(w, path.join(dir, w.file), signal, (b) => this.emit({ step: "torch", bytes: done + b, total, progress: from + span * ((done + b) / total) }));
      done += w.size;
      files[w.file.split("-")[0]] = pathToFileURL(file).href;
    }
    return files;
  }

  /** Create (or complete) a runtime: venv + pinned packages (+ the CUDA wheels, + the overlay link), then its check. */
  async #installEnv(env, signal) {
    const E = ENVS[env];
    if (!win) throw new AppError("PROVIDER", "err.asrSetupWindows");
    const cuda = hasNvidia();
    if (E.torch && cuda) { const d = nvidiaDriver(); if (d !== null && d < MIN_DRIVER) throw new AppError("PROVIDER", "err.engineDriver", { have: d, need: MIN_DRIVER }); }
    if (E.overlay && !fs.existsSync(this.depPath(E.overlay))) throw new AppError("PROVIDER", "err.aiNeedsDep", { dep: E.overlay });
    fs.mkdirSync(this.root, { recursive: true });
    const base = await this.basePython(signal);
    const dir = this.envDir(env), py = this.envPython(env);
    this.emit({ step: "env", progress: 0.04 });
    if (!fs.existsSync(py)) await runProc(base, ["-m", "venv", dir], { signal });
    if (E.overlay) {
      // The overlay's own packages sit on top of the other runtime's site-packages (no second 5 GB torch).
      const site = (d) => (win ? path.join(d, "Lib", "site-packages") : path.join(d, "lib", "python3.12", "site-packages"));
      fs.writeFileSync(path.join(site(dir), "zz_video_runtime.pth"), `${site(path.join(this.root, E.overlay))}\n`);
    }
    let text = fs.readFileSync(path.join(AI_SETUP_DIR, E.requirements), "utf8");
    if (E.torch && cuda) text = pinLocalWheels(text, await this.torchWheels(signal));
    const req = path.join(dir, "requirements.txt");
    fs.writeFileSync(req, E.torch && !cuda ? cpuRequirements(text) : text);
    const total = text.split(/\r?\n/).filter((l) => /^[A-Za-z0-9]/.test(l)).length;
    let seen = 0;
    await runProc(py, ["-m", "pip", "install", "--progress-bar", "off", "-r", req, ...(E.torch && cuda ? ["--extra-index-url", TORCH_INDEX] : [])], {
      signal, onLine: (l) => { if (/^(Collecting|Requirement already satisfied|Processing)/.test(l)) this.emit({ step: "packages", progress: 0.4 + 0.5 * (++seen / total) }); },
    });
    this.emit({ step: "check", progress: 0.95 });
    const h = await this.checkEnv(env, { signal });
    if (!h.ok) throw new AppError("PROVIDER", "err.aiEnvCheck", { env, problems: JSON.stringify(h).slice(0, 600) });
    fs.rmSync(path.join(this.root, "wheels-ai"), { recursive: true, force: true });
    return h;
  }

  /**
   * Repair a runtime: reinstall exactly the packages whose files are gone or damaged (pip would call them installed),
   * install missing pins, then check again; if it is still broken, rebuild it from scratch.
   */
  async #repairEnv(env, signal) {
    const E = ENVS[env], dir = this.envDir(env), py = this.envPython(env);
    if (!fs.existsSync(py)) return this.#installEnv(env, signal);
    this.emit({ step: "check", progress: 0.05 });
    let h = await this.checkEnv(env, { signal });
    if (h.ok) return { ...h, repaired: [] };
    const text = fs.readFileSync(path.join(AI_SETUP_DIR, E.requirements), "utf8");
    const cuda = hasNvidia();
    const wheels = E.torch && cuda && [...(h.broken || []), ...(h.lost || [])].some((b) => /^torch(audio|vision)?$/i.test(b.name)) ? await this.torchWheels(signal, 0.1, 0.3) : {};
    // Packages whose files are gone (by RECORD), and those providing a module that no longer imports at all.
    const lines = [...(h.broken || []), ...(h.lost || [])].map((b) => (wheels[b.name.toLowerCase()] ? `${b.name.toLowerCase()} @ ${wheels[b.name.toLowerCase()]}` : requirementOf(text, b.name) || `${b.name}==${b.version}`));
    const extra = E.torch && cuda ? ["--extra-index-url", TORCH_INDEX] : [];
    this.emit({ step: "packages", progress: 0.5 });
    if (lines.length) {
      const fix = path.join(dir, "repair.txt");
      fs.writeFileSync(fix, `${(E.torch && !cuda ? cpuRequirements(lines.join("\n")) : lines.join("\n"))}\n`);
      await runProc(py, ["-m", "pip", "install", "--progress-bar", "off", "--force-reinstall", "--no-deps", "-r", fix, ...extra], { signal });
      fs.rmSync(fix, { force: true });
    }
    if ((h.missing || []).length || (h.other || []).length) {
      const req = path.join(dir, "requirements.txt");
      fs.writeFileSync(req, E.torch && !cuda ? cpuRequirements(pinLocalWheels(text, wheels)) : pinLocalWheels(text, wheels));
      await runProc(py, ["-m", "pip", "install", "--progress-bar", "off", "-r", req, ...extra], { signal });
    }
    this.emit({ step: "check", progress: 0.9 });
    const before = h;
    h = await this.checkEnv(env, { signal });
    if (!h.ok) {
      // Still broken (a damaged interpreter, a half-written venv): build it again. A linked runtime is only unlinked.
      this.log("ai setup: rebuilding", env, JSON.stringify(h).slice(0, 500));
      if (linkTarget(dir)) fs.unlinkSync(dir); else fs.rmSync(dir, { recursive: true, force: true });
      h = await this.#installEnv(env, signal);
      return { ...h, repaired: lines, rebuilt: true, before };
    }
    fs.rmSync(path.join(this.root, "wheels-ai"), { recursive: true, force: true });
    return { ...h, repaired: lines, before };
  }

  /**
   * Adopt an existing runtime: `folder` is the runtime itself or a folder that has it (e.g. a development checkout's
   * runtime/). It must pass the health check; then it is linked in place (no copy). Its overlay comes with it.
   */
  async #importEnv(env, folder, signal) {
    const E = ENVS[env];
    const cands = [folder, path.join(folder, E.name)];
    const src = cands.find((d) => fs.existsSync(path.join(d, bin, exe("python"))) && path.basename(d).toLowerCase() === E.name);
    if (!src) return { env, result: "notFound" };
    const dest = this.envDir(env);
    if (path.resolve(src) === path.resolve(dest) || linkTarget(dest) === fs.realpathSync(src)) return { env, result: "already" };
    if (fs.existsSync(dest)) return { env, result: "exists", dest };
    const h = await this.checkEnv(env, { python: path.join(src, bin, exe("python")), signal });
    if (!h.ok) return { env, result: "unhealthy", from: src, problems: h };
    if (E.overlay && !fs.existsSync(this.depPath(E.overlay))) {
      const o = path.join(path.dirname(src), E.overlay);
      if (fs.existsSync(o)) this.link(o, path.join(this.root, E.overlay));
    }
    this.link(src, dest);
    this.saveHealth(env, h);
    return { env, result: "linked", from: src };
  }

  link(target, at) {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(path.resolve(target), at, "junction");
  }

  /** llama.cpp's server (the dubbing set-up's pinned build), when the runtime folder has none. */
  async #installLlama(signal) {
    const dest = path.join(this.root, "llama");
    if (fs.existsSync(path.join(dest, exe("llama-server")))) return { result: "already" };
    if (!win) throw new AppError("PROVIDER", "err.asrSetupWindows");
    fs.mkdirSync(dest, { recursive: true });
    const parts = hasNvidia() ? LLAMA.cuda : LLAMA.cpu;
    for (const [i, part] of parts.entries()) {
      this.emit({ step: "llama", progress: i / parts.length });
      const zip = await this.fetchFile(part, path.join(this.root, path.basename(new URL(part.url).pathname)), signal);
      await runProc(TAR, ["-xf", zip, "-C", dest], { signal });
      fs.rmSync(zip, { force: true });
    }
    return { result: "installed" };
  }

  // ---------------------------------------------------------------- model sets
  /** Download what a set lacks from its pinned sources (an archive is fetched once, its members unpacked, it is removed). */
  async #downloadSet(set, signal, from = 0, span = 1) {
    if (set.gated) throw new AppError("CONFLICT", "err.aiGated", { set: set.name, url: set.gated.url });
    const st = await this.setStatus(set);
    const todo = set.files.filter((f, i) => st.files[i].state !== "ok");
    const derived = todo.filter((f) => f.derived);
    if (derived.length) throw new AppError("CONFLICT", "err.aiImportOnly", { set: set.name, file: derived[0].file });
    const total = todo.reduce((n, f) => n + (f.archive ? 0 : f.size), 0) + [...new Map(todo.filter((f) => f.archive).map((f) => [f.archive.url, f.archive.size])).values()].reduce((a, b) => a + b, 0);
    let done = 0;
    const tick = (step, b) => this.emit({ step, bytes: done + b, total, progress: from + span * (total ? (done + b) / total : 1) });
    for (const f of todo.filter((x) => !x.archive)) {
      const dest = this.fileDest(set, f);
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true }); // wrong size: the resumable fetch would keep it
      await this.fetchFile(f, dest, signal, (b) => tick(f.file, b));
      done += f.size;
    }
    const archives = new Map();
    for (const f of todo.filter((x) => x.archive)) archives.set(f.archive.url, [...(archives.get(f.archive.url) || []), f]);
    for (const [url, members] of archives) {
      const a = members[0].archive;
      const tmp = path.join(this.root, "downloads", `${set.layer}-${set.id}`);
      const zip = await this.fetchFile(a, path.join(tmp, path.basename(new URL(url).pathname) || "archive.zip"), signal, (b) => tick(path.basename(url), b));
      const out = path.join(tmp, "unpacked");
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await runProc(TAR, ["-xf", zip, "-C", out, ...members.map((m) => m.archive.member)], { signal });
      for (const m of members) {
        const p = path.join(out, ...m.archive.member.split("/"));
        if ((await sha256File(p)) !== m.sha256) throw new AppError("IO", "err.asrChecksum", { file: m.file });
        const dest = this.fileDest(set, m);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.rmSync(dest, { force: true });
        fs.renameSync(p, dest);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      done += a.size;
    }
    return this.setStatus(set);
  }

  /**
   * Adopt a set from a folder that already has its files (its own folder, a runtime/models/<layer> folder, a whole
   * runtime folder, or the Hugging Face cache): every file's SHA-256 is checked; a set folder found complete in place is
   * linked (junction, no copy); single files are hard-linked on the same drive, copied otherwise.
   */
  async #importSet(set, folder, signal, { copy = false, noCopy = false } = {}) {
    const roots = [...new Set([folder, path.join(folder, "models", set.root), path.join(folder, set.root)])].filter((d) => fs.existsSync(d));
    const hf = set.files[0]?.source?.match(/^huggingface\.co\/([^@]+)@/)?.[1];
    if (hf) roots.push(...hfCacheSnapshots(hf));
    // By place first (the set's folders where they belong: these can be linked whole), in each candidate root…
    let best = null;
    for (const r of roots) {
      const loc = locateFiles(set, r);
      const n = loc.filter((x) => x.path).length;
      if (!best || n > best.n) best = { loc, n, base: r };
      if (n === set.files.length) break;
    }
    let located = best ? best.loc : set.files.map((file) => ({ file, path: null, how: null }));
    const base = best?.base || null;
    // …then the gaps by name and size anywhere under the picked folder (every same-sized candidate is kept: the hash
    // check below takes the one that matches — two sets may both have a LICENSE of the same size)…
    if (located.some((x) => !x.path)) {
      const found = findByName(folder, new Set(located.filter((x) => !x.path).map((x) => x.file.file)), 8);
      located = located.map((x) => (x.path ? x : { ...x, how: "name", cands: (found.get(x.file.file) || []).filter((p) => fs.statSync(p).size === x.file.size) }))
        .map((x) => (x.how === "name" ? { ...x, path: x.cands[0] || null, how: x.cands.length ? "name" : null } : x));
    }
    // …and the Hugging Face cache, which keeps every file once under blobs/<its SHA-256 (LFS) or git id> — also when
    // the snapshot folder that names them was emptied.
    if (hf) {
      const blobs = path.join(hfCacheDir(hf), "blobs");
      for (const x of located) {
        if (x.path) continue;
        const p = path.join(blobs, x.file.git || x.file.sha256);
        if (fs.existsSync(p) && fs.statSync(p).size === x.file.size) Object.assign(x, { path: p, how: "blob" });
      }
    }
    const report = [];
    const total = located.filter((x) => x.path).reduce((n, x) => n + x.file.size, 0);
    let done = 0;
    // Check every found file first: nothing is linked or copied unless it is the pinned file.
    for (const x of located) {
      if (signal.aborted) throw new AppError("CONFLICT", "err.cancelled", { cancelled: true });
      if (!x.path) continue;
      this.emit({ step: `check ${x.file.file}`, bytes: done, total, progress: total ? (0.8 * done) / total : 0 });
      x.ok = (await sha256File(x.path)) === x.file.sha256;
      for (const c of x.cands || []) { if (x.ok) break; if (c !== x.path && (await sha256File(c)) === x.file.sha256) Object.assign(x, { path: c, ok: true }); }
      done += x.file.size;
    }
    const tops = copy ? {} : linkableTops(set, located.filter((x) => x.ok));
    for (const [top, src] of Object.entries(tops)) {
      const at = path.join(this.modelsDir(set.root), top);
      const mine = located.filter((x) => x.file.dir.split("/")[0] === top);
      if (!mine.every((x) => x.ok)) continue;
      if (fs.existsSync(at) && !linkTarget(at)) {
        // A real folder is already there: link only when it holds none of this set's files (never replace data).
        if (fs.readdirSync(at).length) continue;
        fs.rmdirSync(at);
      }
      if (linkTarget(at)) { if (linkTarget(at) === fs.realpathSync(src)) { for (const x of mine) { x.done = true; report.push({ file: x.file.file, result: "already" }); } continue; } fs.unlinkSync(at); }
      this.link(src, at);
      for (const x of mine) { x.done = true; report.push({ file: x.file.file, result: "linked", from: src }); }
    }
    for (const x of located) {
      if (x.done) continue;
      const dest = this.fileDest(set, x.file);
      if (fs.existsSync(dest) && fs.statSync(dest).size === x.file.size && (!x.path || path.resolve(dest) === path.resolve(x.path) || (await sha256File(dest)) === x.file.sha256)) { report.push({ file: x.file.file, result: "already" }); continue; }
      if (!x.path) { report.push({ file: x.file.file, result: "notFound" }); continue; }
      if (!x.ok) { report.push({ file: x.file.file, result: "mismatch", from: x.path }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { force: true });
      let how = "hardlinked";
      try { if (copy) throw new Error("copy asked"); fs.linkSync(x.path, dest); } catch {
        // Another drive: a copy. "Import everything" never copies (it reports the size instead): no data twice.
        if (noCopy) { report.push({ file: x.file.file, result: "copyNeeded", from: x.path, size: x.file.size }); continue; }
        how = "copied";
        await new Promise((resolve, reject) => fs.createReadStream(x.path).pipe(fs.createWriteStream(`${dest}.part`)).on("finish", resolve).on("error", reject));
        fs.renameSync(`${dest}.part`, dest);
      }
      report.push({ file: x.file.file, result: how, from: x.path });
    }
    return { set: set.key, base, report, status: await this.setStatus(set) };
  }

  /** Re-check every file's hash; damaged or missing files are fetched again (an import-only set must be imported). */
  async #repairSet(set, signal) {
    const st = await this.setStatus(set, { verify: true });
    for (const [i, f] of set.files.entries()) if (st.files[i].state === "damaged") fs.rmSync(this.fileDest(set, f), { force: true });
    if (st.installed) return st;
    await this.#downloadSet(set, signal);
    return this.setStatus(set, { verify: true });
  }

  // ---------------------------------------------------------------- public tasks (one at a time, "ai:setup")
  installEnv(layer) { const L = this.#layer(layer); return this.run(`env:${L.id}`, async (s) => { const r = await this.#installEnv(L.env, s); if (L.depends.includes("llama")) await this.#installLlama(s); return r; }); }
  repairEnv(layer) { const L = this.#layer(layer); return this.run(`repairEnv:${L.id}`, (s) => this.#repairEnv(L.env, s)); }
  checkEnvTask(layer) { const L = this.#layer(layer); return this.run(`checkEnv:${L.id}`, (s) => this.checkEnv(L.env, { signal: s })); }
  importEnv(layer, folder) { const L = this.#layer(layer); this.#folder(folder); return this.run(`importEnv:${L.id}`, (s) => this.#importEnv(L.env, folder, s)); }
  installLlama() { return this.run("llama", (s) => this.#installLlama(s)); }
  downloadSet(key) { const set = this.setOf(key); return this.run(`download:${key}`, (s) => this.#downloadSet(set, s)); }
  importSet(key, folder, o = {}) { const set = this.setOf(key); this.#folder(folder); return this.run(`import:${key}`, (s) => this.#importSet(set, folder, s, o)); }
  repairSet(key) { const set = this.setOf(key); return this.run(`repair:${key}`, (s) => this.#repairSet(set, s)); }
  verifySet(key) { const set = this.setOf(key); return this.run(`verify:${key}`, () => this.setStatus(set, { verify: true })); }

  /**
   * The one button of a layer: its runtime (installed or repaired), llama.cpp when it needs it, and every required set
   * it lacks that can be downloaded (optional, gated and import-only sets are left for their own buttons).
   */
  prepareLayer(layer) {
    const L = this.#layer(layer);
    return this.run(`prepare:${L.id}`, async (signal) => {
      const out = { env: null, llama: null, sets: [] };
      out.env = fs.existsSync(this.envPython(L.env)) ? await this.#repairEnv(L.env, signal) : await this.#installEnv(L.env, signal);
      if (L.depends.includes("llama")) out.llama = await this.#installLlama(signal);
      const sets = layerSets(L.id).filter((s) => !s.optional && !s.importOnly);
      for (const [i, s] of sets.entries()) {
        if ((await this.setStatus(s)).installed) continue;
        await this.#downloadSet(s, signal, i / sets.length, 1 / sets.length);
        out.sets.push(s.key);
      }
      return out;
    });
  }

  /**
   * Import everything a folder already has (a development checkout's runtime/, a backup…): every runtime that passes
   * its check, llama.cpp, and every model set — linked in place, or hard-linked file by file. Nothing is downloaded or
   * copied (a set that would need a copy from another drive says how much; its own import button copies it).
   */
  importAll(folder) {
    this.#folder(folder);
    return this.run("importAll", async (signal) => {
      const out = { envs: [], deps: [], sets: [] };
      for (const env of Object.keys(ENVS)) out.envs.push(await this.#importEnv(env, folder, signal));
      const asr = path.join(folder, "asr");
      if (!fs.existsSync(this.depPath("asr")) && fs.existsSync(path.join(asr, bin, exe("python")))) { this.link(asr, path.join(this.root, "asr")); out.deps.push({ dep: "asr", result: "linked" }); }
      const llama = path.join(folder, "llama");
      if (!fs.existsSync(this.depPath("llama")) && fs.existsSync(path.join(llama, exe("llama-server")))) { this.link(llama, path.join(this.root, "llama")); out.deps.push({ dep: "llama", result: "linked" }); }
      const seen = new Set();
      for (const L of LAYERS) for (const s of layerSets(L.id)) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        const r = await this.#importSet(s, folder, signal, { noCopy: true });
        out.sets.push({ set: s.key, copyNeeded: r.report.filter((x) => x.result === "copyNeeded").reduce((n, x) => n + x.size, 0), linked: r.report.filter((x) => x.result === "linked").length, already: r.report.filter((x) => x.result === "already").length, copied: r.report.filter((x) => /copied|hardlinked/.test(x.result)).length, notFound: r.report.filter((x) => x.result === "notFound").length, mismatch: r.report.filter((x) => x.result === "mismatch").length });
      }
      return out;
    });
  }

  #layer(id) { const L = layerDef(id); if (!L) throw new AppError("VALIDATION", "err.enum", { field: "layer" }); return L; }
  #folder(folder) { if (!folder || !fs.existsSync(folder)) throw new AppError("NOT_FOUND", "err.fileNotFound", { file: folder }); }
}
