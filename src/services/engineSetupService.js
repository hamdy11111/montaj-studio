// The set-up and model manager of one of the app's ComfyUI engines (music, video). Nothing here runs a model: it only
// puts files in place.
//   runtime/python312      a portable CPython 3.12 (python-build-standalone, SHA-256 checked), shared by the engines
//   runtime/<engine>       a virtual environment of it with the engine's pinned packages (torch's CUDA build: the app
//                          downloads its big wheels itself, resumable and checked, and pip installs the local files)
//   runtime/<engine>/comfyui  ComfyUI from its GitHub tag (SHA-256 checked); the app's own node packages are copied
//                          into its custom_nodes each time the engine starts
//   <models folder>        the engine's model sets — downloaded from their official sources (resuming an interrupted
//                          download), or imported from a folder that already has them; every file checked against its
//                          published SHA-256. The folder is the user's choice (Settings › <engine>.modelsDir); the
//                          default is the app's data folder. A set whose licence asks for it is used only after the
//                          user accepts that licence in the model manager.
// The runtime goes next to the app (a development checkout) or into the app's data folder. Progress: "<engine>:setup".
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppError } from "../core/validation.js";
import { runProc, sha256File, cpuRequirements } from "./asrSetupService.js";
import { hasNvidia } from "./dubSetupService.js";

const exe = (p) => (process.platform === "win32" ? `${p}.exe` : p);
const bin = process.platform === "win32" ? "Scripts" : "bin";

/** Where an engine's runtime is: next to the app first (a checkout or an install that carries it), then the data folder. */
export function runtimeDirs(name, userData) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const base = /\.asar$/i.test(root) ? path.dirname(root) : root;
  return [path.join(base, "runtime", name), ...(userData ? [path.join(userData, "runtime", name)] : [])];
}

/** The engine's runtime ({ dir, python, comfy }) or null when it is not installed. */
export function engineRuntime(name, userData) {
  for (const dir of runtimeDirs(name, userData)) {
    const python = path.join(dir, bin, exe("python")), comfy = path.join(dir, "comfyui");
    if (fs.existsSync(python) && fs.existsSync(path.join(comfy, "main.py"))) { relinkVenv(dir); return { dir, python, comfy }; }
  }
  return null;
}

/** A venv names its base Python by absolute path: when the runtime folder was moved (another drive, another user
 * folder), point it at the base Python that moved with it, next to it in runtime/python312. */
export function relinkVenv(dir) {
  const cfg = path.join(dir, "pyvenv.cfg"), base = path.join(path.dirname(dir), "python312");
  try {
    const text = fs.readFileSync(cfg, "utf8");
    const home = /^home\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!home || fs.existsSync(home) || !fs.existsSync(path.join(base, exe("python")))) return;
    fs.writeFileSync(cfg, text.split(home).join(base));
  } catch { /* no config: the engine's start says what is wrong */ }
}

/** The NVIDIA driver's major version (e.g. 610), or null. */
export function nvidiaDriver() {
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"], { windowsHide: true, timeout: 10_000, encoding: "utf8" });
    const v = parseInt(String(r.stdout || "").trim(), 10);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export class EngineSetupService {
  /**
   * @param {object} cfg
   * @param {string} cfg.name            "music" | "video": runtime/<name>, Settings › <name>.modelsDir, "<name>:setup"
   * @param {object} cfg.comfyui         { version, url, sha256, size, root, license }
   * @param {object} cfg.python          { url, sha256, size }
   * @param {object[]} cfg.torchWheels   [{ url, file, sha256, size }]
   * @param {string} cfg.torchIndex      pip's extra index for the CUDA build
   * @param {string} cfg.requirements    the pinned requirements file
   * @param {object[]} cfg.modelSets     [{ id, name, files: [{ url, file, dir, sha256, size }], license, accept?, ... }]
   * @param {number} cfg.runtimeBytes
   * @param {boolean} [cfg.needsGpu]     no CPU build: an NVIDIA GPU is required
   * @param {number} [cfg.minDriver]     the NVIDIA driver the CUDA build needs
   * @param {string} cfg.importCheck     Python that must import once the runtime is installed
   */
  constructor({ paths, settings, notify = () => {}, log = () => {} }, cfg) {
    this.paths = paths;
    this.settings = settings;
    this.notify = notify;
    this.log = log;
    this.cfg = cfg;
    this.state = { running: false, task: null, step: null, progress: 0, bytes: 0, total: 0, error: null };
    this.ctrl = null;
  }

  get name() { return this.cfg.name; }
  modelSet(id) { return this.cfg.modelSets.find((s) => s.id === id) || null; }
  setBytes(s) { return s.files.reduce((n, f) => n + f.size, 0); }
  runtime() { return engineRuntime(this.name, this.paths.root); }

  /** The models folder: the user's choice, or the app's data folder. */
  modelsDir() {
    const chosen = this.settings?.get(this.name)?.modelsDir;
    return chosen ? chosen : path.join(this.paths.root, "models", this.name);
  }

  emit(patch) {
    Object.assign(this.state, patch);
    this.notify(`${this.name}:setup`, { ...this.state });
  }

  // Licences the user accepted in the model manager (set id → when), kept in the app's data folder.
  get acceptedFile() { return path.join(this.paths.root, this.name, "accepted-licenses.json"); }
  accepted() { try { return JSON.parse(fs.readFileSync(this.acceptedFile, "utf8")); } catch { return {}; } }
  accept(setId) {
    const set = this.modelSet(setId);
    if (!set) throw new AppError("VALIDATION", "err.enum", { field: "set" });
    if (!set.accept) return this.status();
    // Keyed by the licence: one acceptance covers every set under it (e.g. MiniMax H3 and its Turbo LoRA).
    const all = { ...this.accepted(), [set.accept.key]: { at: new Date().toISOString(), license: set.license } };
    fs.mkdirSync(path.dirname(this.acceptedFile), { recursive: true });
    fs.writeFileSync(this.acceptedFile, JSON.stringify(all, null, 1));
    return this.status();
  }
  needsAcceptance(set) { return !!set.accept && !this.accepted()[set.accept.key]; }

  /** Runtime and every model set: installed or not, file by file (by size; `verify` checks the hashes too). */
  async status({ verify = false } = {}) {
    const rt = this.runtime();
    const dir = this.modelsDir();
    const accepted = this.accepted();
    const sets = [];
    for (const s of this.cfg.modelSets) {
      const files = [];
      for (const f of s.files) {
        const p = path.join(dir, f.dir, f.file);
        let state = "missing";
        if (fs.existsSync(p)) {
          const size = fs.statSync(p).size;
          state = size !== f.size ? "damaged" : verify ? ((await sha256File(p)) === f.sha256 ? "ok" : "damaged") : "ok";
        } else if (fs.existsSync(`${p}.part`)) state = "partial";
        files.push({ file: f.file, dir: f.dir, size: f.size, state, partBytes: state === "partial" ? fs.statSync(`${p}.part`).size : 0 });
      }
      sets.push({ id: s.id, name: s.name, version: s.version, engine: s.engine, paths: s.paths, license: s.license, licenseUrl: s.licenseUrl, restrictions: s.restrictions,
        needs: s.needs, source: s.source, status: s.status, optional: !!s.optional, accept: s.accept || null, accepted: !s.accept || !!accepted[s.accept.key],
        bytes: this.setBytes(s), installed: files.every((f) => f.state === "ok"), files });
    }
    const driver = this.cfg.minDriver ? nvidiaDriver() : null;
    return { runtime: rt ? { installed: true, dir: rt.dir } : { installed: false, bytes: this.cfg.runtimeBytes }, modelsDir: dir, sets, gpu: hasNvidia(), task: { ...this.state },
      driver, minDriver: this.cfg.minDriver || null, comfyui: { version: this.cfg.comfyui.version, license: this.cfg.comfyui.license } };
  }

  /** One set-up task at a time: "runtime", "download:<set>", "import:<set>", "repair:<set>". */
  run(task, fn) {
    if (this.running) throw new AppError("CONFLICT", "err.musicSetupBusy");
    this.ctrl = new AbortController();
    this.emit({ running: true, task, step: null, progress: 0, bytes: 0, total: 0, error: null });
    this.running = fn(this.ctrl.signal)
      .then((r) => { this.emit({ running: false, step: "done", progress: 1 }); return r; })
      .catch((e) => {
        const error = e?.messageKey ? { code: e.code, messageKey: e.messageKey, details: e.details } : { code: "PROVIDER", messageKey: "err.musicSetupFailed", details: { message: String(e?.message || e) } };
        this.log(`${this.name} setup failed`, JSON.stringify(error).slice(0, 2000));
        this.emit({ running: false, error });
        throw e;
      })
      .finally(() => { this.running = null; this.ctrl = null; });
    return this.running;
  }

  cancel() { this.ctrl?.abort(); return { ...this.state }; }

  /** Download `url` to `dest`, resuming a `.part` left by an interrupted run; checks size and SHA-256. */
  async fetchFile({ url, sha256, size }, dest, signal, onBytes = () => {}) {
    if (fs.existsSync(dest) && fs.statSync(dest).size === size && (await sha256File(dest)) === sha256) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > size) { fs.rmSync(part, { force: true }); have = 0; }
    if (have < size) {
      let res;
      try { res = await fetch(url, { signal, redirect: "follow", headers: have ? { Range: `bytes=${have}-` } : {} }); } catch (e) {
        if (signal.aborted) throw new AppError("CONFLICT", "err.cancelled", { cancelled: true });
        throw new AppError("NETWORK", "err.musicDownload", { message: e.message, url });
      }
      if (!res.ok || !res.body) throw new AppError("NETWORK", "err.musicDownload", { status: res.status, url });
      if (have && res.status !== 206) have = 0; // the server ignored the range: start over
      const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
      let got = have, last = 0;
      try {
        for await (const chunk of Readable.fromWeb(res.body)) {
          got += chunk.length;
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          if (got - last > 8_000_000) { last = got; onBytes(got); }
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      } catch (e) {
        // What arrived is kept (flushed to the .part) so the next run resumes from there.
        await new Promise((resolve) => out.end(resolve));
        if (signal.aborted) throw new AppError("CONFLICT", "err.cancelled", { cancelled: true });
        throw new AppError("NETWORK", "err.musicDownload", { message: e.message, url });
      }
    }
    if (fs.statSync(part).size !== size || (await sha256File(part)) !== sha256) {
      fs.rmSync(part, { force: true });
      throw new AppError("IO", "err.asrChecksum", { file: path.basename(dest) });
    }
    fs.renameSync(part, dest);
    return dest;
  }

  /** Portable Python 3.12 + the engine's environment + ComfyUI. */
  installRuntime() {
    const { cfg } = this;
    return this.run("runtime", async (signal) => {
      if (process.platform !== "win32") throw new AppError("PROVIDER", "err.asrSetupWindows");
      const cuda = hasNvidia();
      if (cfg.needsGpu && !cuda) throw new AppError("PROVIDER", "err.engineNeedsNvidia");
      const driver = cfg.minDriver ? nvidiaDriver() : null;
      if (cfg.minDriver && driver !== null && driver < cfg.minDriver) throw new AppError("PROVIDER", "err.engineDriver", { have: driver, need: cfg.minDriver });
      const runtimeRoot = path.join(this.paths.root, "runtime");
      const rt = path.join(runtimeRoot, cfg.name);
      const base = path.join(runtimeRoot, "python312");
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      this.emit({ step: "python", progress: 0.01 });
      if (!fs.existsSync(path.join(base, "python.exe"))) {
        const archive = await this.fetchFile(cfg.python, path.join(runtimeRoot, "python312.tar.gz"), signal);
        const tmp = path.join(runtimeRoot, "python312-unpack");
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        await runProc(tar, ["-xzf", archive, "-C", tmp], { signal });
        fs.renameSync(path.join(tmp, "python"), base);
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(archive, { force: true });
      }
      this.emit({ step: "env", progress: 0.05 });
      const py = path.join(rt, bin, exe("python"));
      if (!fs.existsSync(py)) await runProc(path.join(base, "python.exe"), ["-m", "venv", rt], { signal });
      let text = fs.readFileSync(cfg.requirements, "utf8");
      const wheels = path.join(runtimeRoot, `wheels-${cfg.name}`);
      if (cuda) {
        // The big CUDA wheels first, by the app (resumable, checked), then pip installs them from the local files.
        const total = cfg.torchWheels.reduce((n, w) => n + w.size, 0);
        let done = 0;
        for (const w of cfg.torchWheels) {
          const file = await this.fetchFile(w, path.join(wheels, w.file), signal, (b) => this.emit({ step: "torch", bytes: done + b, total, progress: 0.05 + 0.4 * ((done + b) / total) }));
          done += w.size;
          const name = w.file.split("-")[0];
          text = text.replace(new RegExp(`^${name}==\\S+$`, "m"), `${name} @ ${pathToFileURL(file).href}`);
        }
      }
      const req = path.join(rt, "requirements.txt");
      fs.writeFileSync(req, cuda ? text : cpuRequirements(text));
      const total = text.split(/\r?\n/).filter((l) => /^[A-Za-z0-9]/.test(l)).length;
      let seen = 0;
      await runProc(py, ["-m", "pip", "install", "--progress-bar", "off", "-r", req, ...(cuda ? ["--extra-index-url", cfg.torchIndex] : [])], {
        signal, onLine: (l) => { if (/^(Collecting|Requirement already satisfied|Processing)/.test(l)) this.emit({ step: "packages", progress: 0.45 + 0.4 * (++seen / total) }); },
      });
      this.emit({ step: "comfyui", progress: 0.86 });
      const comfy = path.join(rt, "comfyui");
      if (!fs.existsSync(path.join(comfy, "main.py"))) {
        const zip = await this.fetchFile(cfg.comfyui, path.join(rt, "comfyui.zip"), signal);
        const tmp = path.join(rt, "comfyui-unpack");
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        await runProc(tar, ["-xf", zip, "-C", tmp], { signal });
        fs.renameSync(path.join(tmp, cfg.comfyui.root), comfy);
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
      }
      this.emit({ step: "check", progress: 0.97 });
      await runProc(py, ["-c", cfg.importCheck], { signal });
      // Installed and checked: the downloaded wheels are not needed any more.
      fs.rmSync(wheels, { recursive: true, force: true });
      return { dir: rt };
    });
  }

  /** Download a model set (asks nothing: the UI shows the size and asks first; a licence that needs it must be accepted). */
  download(setId) {
    const set = this.modelSet(setId);
    if (!set) throw new AppError("VALIDATION", "err.enum", { field: "set" });
    if (this.needsAcceptance(set)) throw new AppError("CONFLICT", "err.licenseNotAccepted", { set: set.name });
    return this.run(`download:${setId}`, async (signal) => {
      const dir = this.modelsDir(), total = this.setBytes(set);
      let done = 0;
      for (const f of set.files) {
        await this.fetchFile(f, path.join(dir, f.dir, f.file), signal, (b) => this.emit({ step: f.file, bytes: done + b, total, progress: (done + b) / total }));
        done += f.size;
        this.emit({ step: f.file, bytes: done, total, progress: done / total });
      }
      return this.status();
    });
  }

  /**
   * Import a model set from a folder that already has its files (any layout): each file is found by name, its
   * SHA-256 checked against the official one, then copied (the source folder is only read).
   */
  importFrom(setId, folder) {
    const set = this.modelSet(setId);
    if (!set) throw new AppError("VALIDATION", "err.enum", { field: "set" });
    if (this.needsAcceptance(set)) throw new AppError("CONFLICT", "err.licenseNotAccepted", { set: set.name });
    if (!folder || !fs.existsSync(folder)) throw new AppError("NOT_FOUND", "err.fileNotFound", { file: folder });
    return this.run(`import:${setId}`, async (signal) => {
      const found = findFiles(folder, new Set(set.files.map((f) => f.file)), 6);
      const dir = this.modelsDir(), total = this.setBytes(set);
      let done = 0;
      const report = [];
      for (const f of set.files) {
        if (signal.aborted) throw new AppError("CONFLICT", "err.cancelled", { cancelled: true });
        const dest = path.join(dir, f.dir, f.file);
        const src = (found.get(f.file) || []).find((p) => fs.statSync(p).size === f.size);
        if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && (await sha256File(dest)) === f.sha256) { report.push({ file: f.file, result: "already" }); done += f.size; continue; }
        if (!src) { report.push({ file: f.file, result: "notFound" }); continue; }
        this.emit({ step: f.file, bytes: done, total, progress: done / total });
        if ((await sha256File(src)) !== f.sha256) { report.push({ file: f.file, result: "mismatch", from: src }); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await copyWithProgress(src, `${dest}.part`, signal, (b) => this.emit({ step: f.file, bytes: done + b, total, progress: (done + b) / total }));
        fs.renameSync(`${dest}.part`, dest);
        done += f.size;
        report.push({ file: f.file, result: "copied", from: src });
      }
      return { report, status: await this.status() };
    });
  }

  /** Check every file's hash; damaged or missing files are downloaded again. */
  repair(setId) {
    const set = this.modelSet(setId);
    if (!set) throw new AppError("VALIDATION", "err.enum", { field: "set" });
    if (this.needsAcceptance(set)) throw new AppError("CONFLICT", "err.licenseNotAccepted", { set: set.name });
    return this.run(`repair:${setId}`, async (signal) => {
      const dir = this.modelsDir();
      for (const f of set.files) {
        const p = path.join(dir, f.dir, f.file);
        if (fs.existsSync(p) && (fs.statSync(p).size !== f.size || (await sha256File(p)) !== f.sha256)) fs.rmSync(p, { force: true });
        this.emit({ step: f.file });
        await this.fetchFile(f, p, signal, (b) => this.emit({ step: f.file, bytes: b, total: f.size, progress: b / f.size }));
      }
      return this.status({ verify: true });
    });
  }
}

/** Files with the given names under `root` (to `depth` folders down): name → [paths]. */
function findFiles(root, names, depth) {
  const out = new Map();
  const walk = (dir, d) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d > 0 && !e.name.startsWith(".")) walk(p, d - 1);
      else if (e.isFile() && names.has(e.name)) out.set(e.name, [...(out.get(e.name) || []), p]);
    }
  };
  walk(root, depth);
  return out;
}

async function copyWithProgress(src, dest, signal, onBytes) {
  await new Promise((resolve, reject) => {
    const r = fs.createReadStream(src), w = fs.createWriteStream(dest);
    let got = 0, last = 0;
    const abort = () => { r.destroy(); w.destroy(); fs.rmSync(dest, { force: true }); reject(new AppError("CONFLICT", "err.cancelled", { cancelled: true })); };
    signal.addEventListener("abort", abort, { once: true });
    r.on("data", (c) => { got += c.length; if (got - last > 16_000_000) { last = got; onBytes(got); } });
    r.on("error", reject); w.on("error", reject);
    w.on("finish", () => { signal.removeEventListener("abort", abort); resolve(); });
    r.pipe(w);
  });
}
