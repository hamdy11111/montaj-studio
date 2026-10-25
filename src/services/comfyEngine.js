// A ComfyUI engine the app runs for one of its studios (music, video): started only when asked, on a free local port,
// with only the app's own node packages enabled, its data in the app's data folder, offline. "Stop" ends the process
// the app started (its pid is recorded) — never another ComfyUI on the machine. Workflows run through /prompt and their
// progress comes back on the engine's WebSocket.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { AppError } from "../core/validation.js";

export const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (file, n = 3000) => { try { const s = fs.readFileSync(file, "utf8"); return s.slice(-n); } catch { return ""; } };

/** Free GPU memory in MiB (NVIDIA), or null. */
export function gpuFree() {
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=memory.free,memory.total,memory.used", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 8000, encoding: "utf8" });
    if (r.status !== 0) return null;
    const [free, total, used] = r.stdout.split("\n")[0].split(",").map((x) => Number(x.trim()));
    return { free, total, used };
  } catch { return null; }
}

/** RAM (MB) of one process, or null. */
function processRam(pid) {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8" });
  const m = /"([\d,.\s]+) K"/.exec(r.stdout || "");
  return m ? Math.round(Number(m[1].replace(/[^\d]/g, "")) / 1024) : null;
}

export class ComfyEngine {
  /**
   * @param {object} o
   * @param {string} o.name        "music" | "video" — the log file and the events are named after it
   * @param {string} o.dir         the engine's own data folder (inputs, outputs, temp, user, pid)
   * @param {string} o.logs        the app's logs folder
   * @param {() => ({python, comfy}|null)} o.runtime
   * @param {() => string} o.modelsDir
   * @param {string[]} o.modelFolders  the model subfolders ComfyUI should look in
   * @param {{name: string, src: string}[]} o.nodePackages  the app's node packages, copied fresh into custom_nodes
   * @param {string[]} [o.customNodes] other packages already in the runtime's custom_nodes that the engine may load
   * @param {string} o.readyNode   a node class that exists once the engine is up with our packages
   * @param {object} [o.env]
   */
  constructor({ name, dir, logs, runtime, modelsDir, modelFolders, nodePackages = [], customNodes = [], readyNode, env = {}, notify = () => {} }) {
    Object.assign(this, { name, dir, logs, runtime, modelsDir, modelFolders, nodePackages, customNodes, readyNode, env, notify });
    this.proc = null; // { child, port, url, pid, workPid, started }
    this.starting = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  get running() { return !!this.proc; }
  get url() { return this.proc?.url; }
  get port() { return this.proc?.port; }

  status() {
    return this.proc ? { running: true, port: this.proc.port, pid: this.proc.pid, workPid: this.proc.workPid, since: this.proc.started } : { running: false, starting: !!this.starting };
  }

  /** RAM, GPU and disk now, and the engine's own RAM (its real process, not the venv's launcher). */
  resources() {
    let disk = null;
    try { const st = fs.statfsSync(this.dir); disk = Math.round((st.bavail * st.bsize) / 2 ** 20); } catch { /* unknown */ }
    return { ramFreeMB: Math.round(os.freemem() / 2 ** 20), ramTotalMB: Math.round(os.totalmem() / 2 ** 20), gpu: gpuFree(), diskFreeMB: disk,
      engineRamMB: this.proc ? processRam(this.proc.workPid) : null };
  }

  /**
   * Before loading models: enough RAM, GPU memory and disk, or a clear message (nothing is started). What the running
   * engine itself holds counts as available — it gives its models back for the next job — so the GPU check applies
   * only before the engine starts.
   */
  checkResources({ ramMB = 4000, vramMB = 5000, diskMB = 2000 } = {}) {
    const r = this.resources();
    const gb = (mb) => Math.round(mb / 1024 * 10) / 10;
    const ram = r.ramFreeMB + (r.engineRamMB || 0);
    if (ram < ramMB) throw new AppError("RESOURCE", "err.engineRam", { free: gb(ram), need: gb(ramMB) });
    if (!this.proc && r.gpu && r.gpu.free < vramMB) throw new AppError("RESOURCE", "err.engineVram", { free: gb(r.gpu.free), need: gb(vramMB) });
    if (r.diskFreeMB !== null && r.diskFreeMB < diskMB) throw new AppError("RESOURCE", "err.diskLow", { free: gb(r.diskFreeMB) });
    return r;
  }

  /** Start the engine (once; a second call while it starts waits for the same start). */
  start() {
    if (this.proc) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    const rt = this.runtime();
    if (!rt) throw new AppError("PROVIDER", "err.engineNotReady", { missing: ["runtime"] });
    // The app's node packages, fresh for this version of the app.
    for (const p of this.nodePackages) {
      const dest = path.join(rt.comfy, "custom_nodes", p.name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(p.src, dest, { recursive: true, filter: (f) => !f.includes("__pycache__") });
    }
    const port = await freePort();
    const dirs = { out: path.join(this.dir, "engine-out"), input: path.join(this.dir, "engine-in"), temp: path.join(this.dir, "engine-temp"), user: path.join(this.dir, "engine-user") };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const allowed = [...this.nodePackages.map((p) => p.name), ...this.customNodes];
    const args = ["-X", "utf8", path.join(rt.comfy, "main.py"), "--listen", "127.0.0.1", "--port", String(port), "--disable-auto-launch",
      "--base-directory", rt.comfy, "--output-directory", dirs.out, "--input-directory", dirs.input, "--temp-directory", dirs.temp, "--user-directory", dirs.user,
      "--database-url", `sqlite:///${path.join(dirs.user, "comfy.db").replace(/\\/g, "/")}`, "--disable-all-custom-nodes", "--whitelist-custom-nodes", ...allowed,
      "--extra-model-paths-config", this.modelPathsFile()];
    const logFile = path.join(this.logs, `${this.name}-engine.log`);
    const out = fs.openSync(logFile, "a");
    const child = spawn(rt.python, args, { cwd: rt.comfy, windowsHide: true, stdio: ["ignore", out, out],
      env: { ...process.env, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HOME: path.join(this.dir, "hf"), ...this.env } });
    let exited = null;
    child.on("exit", (code) => {
      exited = code;
      if (this.proc?.child === child) { this.proc = null; this.notify("stopped", this.status()); }
    });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 600; i++) { // up to 5 minutes (a cold start loads torch)
      if (exited !== null) throw new AppError("PROVIDER", "err.engineFailed", { code: exited, log: tail(logFile) });
      try { const r = await fetch(`${url}/object_info/${this.readyNode}`); if (r.ok && Object.keys(await r.json()).length) break; } catch { /* not up yet */ }
      await sleep(500);
      if (i === 599) { child.kill(); throw new AppError("PROVIDER", "err.engineFailed", { log: tail(logFile) }); }
    }
    // The process that holds the models (the venv's python.exe is a launcher that starts it): measured in resources().
    const work = await fetch(`${url}/montaj/process`).then((r) => r.json()).catch(() => ({}));
    this.proc = { child, port, url, pid: child.pid, workPid: work.pid || child.pid, started: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, "engine.pid"), String(child.pid));
    this.notify("started", this.status());
    return this.status();
  }

  /** ComfyUI's extra model paths: the models folder the user chose. */
  modelPathsFile() {
    const f = path.join(this.dir, "model-paths.yaml");
    const q = (p) => JSON.stringify(p.replace(/\\/g, "/"));
    fs.writeFileSync(f, `montaj:\n  base_path: ${q(this.modelsDir())}\n${this.modelFolders.map((x) => `  ${x}: ${x}\n`).join("")}`);
    return f;
  }

  /** Stop the engine the app started: frees its RAM and GPU memory. */
  stop() {
    const p = this.proc;
    if (!p) return this.status();
    this.proc = null;
    try { spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }); } catch { p.child.kill(); }
    fs.rmSync(path.join(this.dir, "engine.pid"), { force: true });
    this.notify("stopped", this.status());
    return this.status();
  }

  /** Free the models from memory without stopping the engine. */
  async release() {
    if (!this.proc) return false;
    await this.post("/free", { unload_models: true, free_memory: true }).catch(() => {});
    return true;
  }

  post(route, body) {
    return fetch(`${this.proc.url}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  /**
   * Run a workflow. `onEvent(type, data)` gets the engine's events for this prompt (progress, executing, custom
   * events). Resolves when it finishes; rejects with err.cancelled ({cancelled: true}) when interrupted, or with
   * `failKey` and the engine's message when a node fails. `onQueued(promptId)` is called once it is accepted.
   */
  async runPrompt(prompt, { clientId, onEvent = () => {}, onQueued = () => {}, failKey = "err.engineFailed" }) {
    if (!this.proc) throw new AppError("PROVIDER", "err.engineStopped");
    const ws = new WebSocket(`ws://127.0.0.1:${this.proc.port}/ws?clientId=${encodeURIComponent(clientId)}`);
    let promptId = null;
    const finished = new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
        const d = m.data || {};
        if (d.prompt_id && promptId && d.prompt_id !== promptId) return;
        if (m.type === "execution_error") reject(new AppError("PROVIDER", failKey, { message: String(d.exception_message || "").slice(0, 800), node: d.node_type }));
        else if (m.type === "execution_interrupted") reject(new AppError("CONFLICT", "err.cancelled", { cancelled: true }));
        else if (m.type === "execution_success" || (m.type === "executing" && d.node === null && promptId)) resolve();
        else onEvent(m.type, d);
      };
      ws.onerror = () => reject(new AppError("PROVIDER", "err.engineStopped"));
      ws.onclose = () => { if (!this.proc) reject(new AppError("PROVIDER", "err.engineStopped")); };
    });
    finished.catch(() => {}); // handled by the caller once it awaits
    await new Promise((r) => { ws.onopen = r; setTimeout(r, 3000); });
    const res = await this.post("/prompt", { client_id: clientId, prompt });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.prompt_id) { ws.close(); throw new AppError("PROVIDER", failKey, { message: JSON.stringify(body.error || body.node_errors || body).slice(0, 800) }); }
    promptId = body.prompt_id;
    onQueued(promptId);
    try { await finished; } finally { ws.close(); }
    return promptId;
  }

  /** Stop the running prompt (and drop it from the queue). */
  async interrupt(promptId) {
    if (!this.proc || !promptId) return;
    await this.post("/interrupt", { prompt_id: promptId }).catch(() => {});
    await this.post("/queue", { delete: [promptId] }).catch(() => {});
  }
}
