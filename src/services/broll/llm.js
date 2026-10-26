// The local vision-language model for the B-roll index: llama.cpp's llama-server (runtime/llama) with a Qwen GGUF and
// its vision projector (mmproj). Used for (1) a caption of every shot — English + Arabic description and keywords,
// the text arm of the search — and (2) turning an Egyptian request into English/MSA search phrases.
// Which model: the perception phase's Qwen3.6-35B-A3B when it is installed (runtime/models/perception), otherwise the
// dubbing translator Qwen3.5-35B-A3B (runtime/models/translate) with the mmproj from its own repository
// (runtime/models/media/unsloth__Qwen3.5-35B-A3B-GGUF). The MoE experts of 16 layers stay on the CPU (as the dubbing
// does), so it fits next to what the desktop already holds on the GPU. Started only for a job, stopped after it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { freePort } from "../comfyEngine.js";
import { AppError } from "../../core/validation.js";

const exe = (p) => (process.platform === "win32" ? `${p}.exe` : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The model files: { model, mmproj, name } or null. `runtime` is the runtime folder (…/runtime). */
export function findVlm(runtime) {
  const m = path.join(runtime, "models");
  const pick = (dir, re) => { try { const f = fs.readdirSync(dir).filter((x) => re.test(x)).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; } };
  const per = path.join(m, "perception");
  const candidates = [
    { name: "Qwen3.6-35B-A3B", model: pick(per, /^Qwen3\.6-35B-A3B.*Q4_K_M.*\.gguf$/i) || pick(per, /^Qwen3\.6-35B-A3B.*\.gguf$/i), mmproj: pick(per, /mmproj.*(3\.6|F16|BF16).*\.gguf$/i) },
    { name: "Qwen3.5-35B-A3B", model: path.join(m, "translate", "Qwen3.5-35B-A3B-Q4_K_M.gguf"), mmproj: path.join(m, "media", "unsloth__Qwen3.5-35B-A3B-GGUF", "mmproj-F16.gguf") },
  ];
  return candidates.find((c) => c.model && c.mmproj && fs.existsSync(c.model) && fs.existsSync(c.mmproj)) || null;
}

/** Strict-ish JSON from a model answer (a ```json block, or the first {...}). */
export function parseJsonAnswer(text) {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1] ?? t;
  const a = block.indexOf("{"), b = block.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(block.slice(a, b + 1)); } catch { return null; }
}

export class LlamaServer {
  constructor({ runtime, log = () => {}, ctx = 8192, cpuMoe = 16, logFile = null }) {
    Object.assign(this, { runtime, log, ctx, cpuMoe, logFile });
    this.proc = null; this.url = null; this.vlm = null;
  }

  async start() {
    if (this.proc) return this.vlm;
    const vlm = findVlm(this.runtime);
    if (!vlm) throw new AppError("PROVIDER", "err.mediaModelMissing", { model: "Qwen VLM (gguf + mmproj)" });
    const server = path.join(this.runtime, "llama", exe("llama-server"));
    if (!fs.existsSync(server)) throw new AppError("PROVIDER", "err.mediaModelMissing", { model: "llama.cpp" });
    const port = await freePort();
    const args = ["-m", vlm.model, "--mmproj", vlm.mmproj, "--host", "127.0.0.1", "--port", String(port), "-c", String(this.ctx), "--jinja",
      "-t", "16", "-ngl", "99", "--n-cpu-moe", String(this.cpuMoe), "--reasoning-budget", "0", "-np", "1"];
    const out = this.logFile ? fs.openSync(this.logFile, "a") : "ignore";
    this.proc = spawn(server, args, { windowsHide: true, stdio: ["ignore", out, out] });
    let exited = null;
    this.proc.on("exit", (c) => { exited = c; this.proc = null; });
    this.url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 600; i++) {
      if (exited !== null) throw new AppError("PROVIDER", "err.mediaRuntime", { script: "llama-server", code: exited });
      try { const r = await fetch(`${this.url}/health`); if (r.ok) { this.vlm = vlm; return vlm; } } catch { /* starting */ }
      await sleep(500);
    }
    this.stop();
    throw new AppError("PROVIDER", "err.mediaRuntime", { script: "llama-server", message: "timeout" });
  }

  /** One chat turn. images: file paths (JPEG) shown before the text. */
  async chat(prompt, { images = [], system = null, maxTokens = 400, temperature = 0.2 } = {}) {
    const content = [...images.map((f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` } })), { type: "text", text: prompt }];
    const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content }];
    const r = await fetch(`${this.url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature, chat_template_kwargs: { enable_thinking: false } }) });
    if (!r.ok) throw new AppError("PROVIDER", "err.mediaRuntime", { script: "llama-server", message: `HTTP ${r.status} ${(await r.text()).slice(0, 300)}` });
    const j = await r.json();
    return j.choices?.[0]?.message?.content || "";
  }

  stop() { try { this.proc?.kill(); } catch { /* gone */ } this.proc = null; }
}

export const CAPTION_PROMPT = `You index video shots for an Egyptian video editor's B-roll search. The images are frames of ONE shot.
Answer with JSON only:
{"en": "one factual English sentence: who/what is visible, the action, the place, the shot type (close-up/medium/wide)",
 "ar": "the same in short Arabic",
 "keywordsEn": ["6-10 English keywords: objects, actions, place, food, mood"],
 "keywordsAr": ["6-10 Arabic keywords, Egyptian words welcome (e.g. حلة، طبيخ، عربية، شارع)"],
 "people": 0, "shot": "close-up|medium|wide", "textOnScreen": false}`;

export const QUERY_PROMPT = (q) => `An Egyptian video editor searches their own footage for a B-roll shot. Request (Egyptian Arabic or English): «${q}»
Rewrite it for visual search. Answer with JSON only:
{"en": ["2-3 short English descriptions of what the shot would SHOW (objects, action, place)"], "ar": ["1-2 short Modern Standard Arabic descriptions"], "keywords": ["3-6 English keywords"]}`;
