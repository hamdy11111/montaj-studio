// One-click set-up of the Egyptian Arabic speech engine for an installed copy (the installer carries neither the model
// nor Python). Everything lands in the app's data folder, where updates leave it alone:
//   runtime/python   a portable CPython 3.11 (astral-sh/python-build-standalone, pinned build, SHA-256 checked)
//   runtime/asr      its virtual environment with the pinned packages of requirements-nemo.txt — torch from PyPI, whose
//                    Windows build runs on the CPU (the engine's default device), so no CUDA download is needed
//   models/          the model from its source, huggingface.co/Janaymn/asr-egyptian-nemo-v2.0 (Apache 2.0), pinned
//                    revision, SHA-256 checked
// Each step is skipped when already done, so a cancelled or failed set-up resumes. Progress is sent as "asr:setup".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/validation.js";

const ASR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "asr").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

export const PYTHON = {
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.11.17%2B20261009-x86_64-pc-windows-msvc-install_only.tar.gz",
  sha256: "4d307648d2fe5f8d927e10380cc33eb7afd8a34a7efe0ed786b5860b5f2d3408",
  size: 48_233_938,
};
export const MODEL = {
  url: "https://huggingface.co/Janaymn/asr-egyptian-nemo-v2.0/resolve/9d9500d66ca4eae991d202ef8838c61c37c6eace/asr-egyptian-nemo-v2.0.nemo",
  file: "asr-egyptian-nemo-v2.0.nemo",
  sha256: "6fbaa3740d17a11956f009ce0d39a8aa713a6889f13226c18106d3e02c333481",
  size: 459_243_520,
};
/** Approximate download for the dialog: Python + packages (CPU build) + model. */
export const DOWNLOAD_BYTES = 1_700_000_000;

// Share of the whole progress bar per step.
const STEPS = [["python", 0.04], ["venv", 0.02], ["packages", 0.6], ["model", 0.31], ["check", 0.03]];

/** The pinned requirements with the CUDA builds of torch swapped for the PyPI ones (CPU on Windows). */
export function cpuRequirements(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/^(torch|torchaudio|torchvision)==([^+\s]+)\+cu\d+\s*$/, "$1==$2")).join("\n");
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

function runProc(cmd, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
    let tail = "", buf = "";
    const feed = (d) => {
      const s = d.toString("utf8");
      tail = (tail + s).slice(-4000);
      buf += s;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) onLine?.(l);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => reject(new AppError("PROVIDER", "err.asrSetupFailed", { message: e.message })));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new AppError("CONFLICT", "err.cancelled", { cancelled: true }));
      else if (code === 0) resolve(tail);
      else reject(new AppError("PROVIDER", "err.asrSetupFailed", { code, output: tail.slice(-1500) }));
    });
  });
}

export class AsrSetupService {
  constructor({ paths, notify = () => {}, log = () => {} }) {
    this.paths = paths;
    this.notify = notify;
    this.log = log;
    this.state = { running: false, step: null, progress: 0, error: null };
    this.ctrl = null;
  }

  get dirs() {
    const rt = path.join(this.paths.root, "runtime");
    return { runtime: rt, python: path.join(rt, "python"), venv: path.join(rt, "asr"), models: path.join(this.paths.root, "models") };
  }

  status() { return { ...this.state, downloadBytes: DOWNLOAD_BYTES }; }

  emit(patch) {
    Object.assign(this.state, patch);
    this.notify("asr:setup", this.status());
  }

  cancel() { this.ctrl?.abort(); return this.status(); }

  /** Start (or resume) the set-up; resolves when finished. A second call while running returns the running promise. */
  start() {
    if (this.running) return this.running;
    this.ctrl = new AbortController();
    this.emit({ running: true, step: "python", progress: 0, error: null });
    this.running = this.run(this.ctrl.signal)
      .then(() => { this.emit({ running: false, step: "done", progress: 1 }); return this.status(); })
      .catch((e) => {
        const error = e?.messageKey ? { code: e.code, messageKey: e.messageKey, details: e.details } : { code: "PROVIDER", messageKey: "err.asrSetupFailed", details: { message: String(e?.message || e) } };
        this.log("asr setup failed", JSON.stringify(error).slice(0, 2000));
        this.emit({ running: false, error });
        throw e;
      })
      .finally(() => { this.running = null; this.ctrl = null; });
    return this.running;
  }

  /** Report `p` (0..1) inside step `name`. */
  at(name, p) {
    let base = 0;
    for (const [n, w] of STEPS) { if (n === name) { this.emit({ step: name, progress: Math.min(1, base + w * Math.max(0, Math.min(1, p))) }); return; } base += w; }
  }

  async download({ url, sha256, size }, dest, step, signal) {
    if (fs.existsSync(dest) && (await sha256File(dest)) === sha256) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let res;
    try { res = await fetch(url, { signal, redirect: "follow" }); } catch (e) {
      if (signal.aborted) throw new AppError("CONFLICT", "err.cancelled", { cancelled: true });
      throw new AppError("NETWORK", "err.asrDownload", { message: e.message, url });
    }
    if (!res.ok || !res.body) throw new AppError("NETWORK", "err.asrDownload", { status: res.status, url });
    const total = Number(res.headers.get("content-length")) || size;
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(part);
    let got = 0, last = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        if (got - last > 4_000_000) { last = got; this.at(step, got / total); }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      out.destroy();
      fs.rmSync(part, { force: true });
      if (signal.aborted) throw new AppError("CONFLICT", "err.cancelled", { cancelled: true });
      throw new AppError("NETWORK", "err.asrDownload", { message: e.message, url });
    }
    const digest = hash.digest("hex");
    if (digest !== sha256) { fs.rmSync(part, { force: true }); throw new AppError("IO", "err.asrChecksum", { file: path.basename(dest) }); }
    fs.renameSync(part, dest);
    return dest;
  }

  async run(signal) {
    if (process.platform !== "win32") throw new AppError("PROVIDER", "err.asrSetupWindows");
    const d = this.dirs;
    fs.mkdirSync(d.runtime, { recursive: true });
    const venvPy = path.join(d.venv, "Scripts", "python.exe");

    // 1. Portable Python (skipped when the environment already exists).
    const basePy = path.join(d.python, "python.exe");
    if (!fs.existsSync(venvPy) && !fs.existsSync(basePy)) {
      const archive = await this.download(PYTHON, path.join(d.runtime, "python.tar.gz"), "python", signal);
      fs.rmSync(d.python, { recursive: true, force: true });
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      await runProc(tar, ["-xzf", archive, "-C", d.runtime], { signal }); // the archive's root folder is "python"
      fs.rmSync(archive, { force: true });
      if (!fs.existsSync(basePy)) throw new AppError("PROVIDER", "err.asrSetupFailed", { message: "python.exe missing after extraction" });
    }
    this.at("python", 1);

    // 2. Its virtual environment.
    if (!fs.existsSync(venvPy)) await runProc(basePy, ["-m", "venv", d.venv], { signal });
    this.at("venv", 1);

    // 3. The pinned packages. pip skips what is already installed, so a resumed set-up is quick.
    const req = path.join(d.runtime, "requirements-cpu.txt");
    fs.writeFileSync(req, cpuRequirements(fs.readFileSync(path.join(ASR_DIR, "requirements-nemo.txt"), "utf8")));
    const total = fs.readFileSync(req, "utf8").split("\n").filter((l) => /^[A-Za-z0-9]/.test(l)).length;
    let seen = 0;
    await runProc(venvPy, ["-m", "pip", "install", "--progress-bar", "off", "-r", req], {
      signal,
      onLine: (l) => {
        if (/^(Collecting|Requirement already satisfied)/.test(l)) this.at("packages", 0.85 * (++seen / total));
        else if (/^Installing collected packages/.test(l)) this.at("packages", 0.9);
      },
    });
    this.at("packages", 1);

    // 4. The model from its source.
    await this.download(MODEL, path.join(d.models, MODEL.file), "model", signal);
    this.at("model", 1);

    // 5. The engine loads and sees the model.
    const out = await runProc(venvPy, ["-X", "utf8", path.join(ASR_DIR, "nemo_words.py"), "--audio", "-", "--check", "--model", path.join(d.models, MODEL.file)], { signal });
    const m = out.match(/\{"nemo"[^{}]*\}/); // stdout's JSON; NeMo's own logging shares the captured output
    if (!m || !JSON.parse(m[0]).model) throw new AppError("PROVIDER", "err.asrSetupFailed", { message: "model not found by the engine" });
    this.at("check", 1);
  }
}
