// The director's language models (PLAN_editor_and_graphics.md, item 2 and item 9 steps 3–4):
//  · local: llama.cpp's llama-server with a Qwen GGUF, text only — Qwen3.8-27B (runtime/models/director/qwen3.8-27b,
//    the planner candidate) or perception's Qwen3.6-35B-A3B (runtime/models/perception/qwen3.6-35b-a3b); answers are
//    constrained to a JSON schema. It holds ~17–21 GB of the shared GPU, so it runs only inside the GPU lock and stops
//    after the job;
//  · cloud (optional, off by default): Claude — the "stronger director" button. The key comes from the user for this
//    run only (or ANTHROPIC_API_KEY): it is never written anywhere, logged or sent to another service.
// Both offer the same three calls the pipeline needs: plan (treatments over numbered moments), judge (one pair of
// cuts), rankGraphics (the graphics ranker for graphics/selection.js, all needs in one call).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { freePort } from "./comfyEngine.js";
import { parseJsonAnswer } from "./broll/llm.js";
import { AppError } from "../core/validation.js";
import { JUDGE_SYSTEM, JUDGE_SCHEMA } from "../core/critic.js";
import { HOOK_KINDS, momentsTable } from "../core/treatments.js";

const exe = (p) => (process.platform === "win32" ? `${p}.exe` : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The planner models found under `runtime`: [{ id, name, model }] (Qwen3.8-27B first). */
export function plannerModels(runtime) {
  const pick = (dir, re) => { try { const f = fs.readdirSync(dir).filter((x) => re.test(x)).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; } };
  const m = path.join(runtime, "models");
  return [
    { id: "qwen3.8-27b", name: "Qwen3.8-27B", model: pick(path.join(m, "director", "qwen3.8-27b"), /^Qwen3\.8-27B.*\.gguf$/i) },
    { id: "qwen3.6-35b-a3b", name: "Qwen3.6-35B-A3B", model: pick(path.join(m, "perception", "qwen3.6-35b-a3b"), /^Qwen3\.6-35B-A3B.*\.gguf$/i), moe: true },
  ].filter((x) => x.model && fs.existsSync(x.model));
}

// ------------------------------------------------------------------ prompts and schemas
export const PLAN_SYSTEM = `You are the director of an automatic video editor for Egyptian Arabic creators (vlogs, challenges, cooking, interviews, explainers, comedy). You get the raw video as numbered MOMENTS (what is said, or what happens when nothing is said), their roles, energy and reactions, and the cause → reaction links. Propose 3 to 5 DIFFERENT treatments (edits) of this video. Make them differ in the hook (result first: a flash-forward of the payoff; question: open on the question the video answers; reaction first: open on the biggest reaction; action: start straight in the action, dropping the slow opening; none), in structure (which moments, in which order) and in length. Rules: refer ONLY to moment numbers that exist — never invent times; keep a cause and its reaction together, cause first; never repeat a line; drop fillers, dead time and the off-topic; a wordless video lives on its action moments — keep the strongest action and reactions, do not cut it down to the few words said; keep the story understandable. The hook moment is shown first as a short flash-forward and stays in its place too. Write "title" and "why" in Egyptian Arabic. Answer only JSON.`;
export const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["treatments"],
  properties: {
    treatments: {
      type: "array", minItems: 3, maxItems: 5,
      items: {
        type: "object", additionalProperties: false, required: ["title", "hook_kind", "hook_moment", "order", "length", "why"],
        properties: {
          title: { type: "string", maxLength: 60, description: "a short name in Egyptian Arabic" },
          hook_kind: { enum: HOOK_KINDS },
          hook_moment: { type: "integer", minimum: 0, description: "the moment shown first; 0 = none" },
          order: { type: "array", minItems: 1, maxItems: 400, items: { type: "integer", minimum: 1 }, description: "the moments kept, in edit order" },
          length: { enum: ["full", "medium", "short"] },
          why: { type: "string", maxLength: 240 },
        },
      },
    },
  },
};
export function planPrompt({ moments, links, durationS, targetS = null, kind = null }) {
  return `Video: ${durationS.toFixed(0)} s${kind ? `, ${kind}` : ""}${targetS ? `; the user wants about ${targetS} s` : ""}. ${moments.length} moments.\n\nMoments (number | time | kind | role | energy | strength | reactions | what):\n${momentsTable(moments, links)}\n\nPropose the treatments.`;
}
/** The planner's answer → treatments for validateTreatment (core/treatments.js). */
export function treatmentsFromAnswer(ans, source) {
  return (ans?.treatments || []).slice(0, 5).map((t, i) => ({
    id: `${source}-${i + 1}`, title: String(t.title || `معالجة ${i + 1}`).slice(0, 60), source,
    hook: t.hook_kind && t.hook_kind !== "none" && t.hook_moment > 0 ? { kind: t.hook_kind, moment: t.hook_moment } : null,
    order: Array.isArray(t.order) ? t.order.map(Number).filter(Number.isInteger) : [], length: ["full", "medium", "short"].includes(t.length) ? t.length : "full", why: String(t.why || "").slice(0, 240),
  }));
}

export const GRAPHICS_SYSTEM = `You pick on-screen graphics for an Egyptian Arabic video. For each moment (a sentence said, or a wordless action) you get the eligible templates already filled from what was said. Rank at most 3 templates per moment, best first, by how well the graphic serves the MEANING of the moment (a number becomes a counter, a list a montage, a punchline a stamp, a laugh a sticker…), never because a word merely appears. Skip moments where nothing fits (empty list). Answer only JSON.`;
export const GRAPHICS_SCHEMA = { type: "object", additionalProperties: false, required: ["picks"], properties: { picks: { type: "array", maxItems: 400, items: { type: "object", additionalProperties: false, required: ["need", "templates"], properties: { need: { type: "integer" }, templates: { type: "array", maxItems: 3, items: { type: "string" } } } } } } };
export function graphicsPrompt(needs) {
  return needs.map((x) => `need ${x.i} @${(x.startUs / 1e6).toFixed(1)} s, energy ${x.energy}, tags ${x.tags.join("/")}: ${x.text ? `«${x.text.slice(0, 120)}»` : "[no words]"}\n  candidates: ${x.candidates.map((c) => `${c.template} (${c.use || c.name})`).join("; ")}`).join("\n");
}

// ------------------------------------------------------------------ the local model
export class LocalDirectorLLM {
  /**
   * runtime: the runtime folder; model: "qwen3.8-27b" | "qwen3.6-35b-a3b" | "auto"; gpuLock: { acquire(name) →
   * release } (perception's makeGpuLock shape); think: let the model reason before answering (slower).
   */
  constructor({ runtime, model = "auto", gpuLock = null, log = () => {}, ctx = 16384, think = false, logFile = null }) {
    Object.assign(this, { runtime, want: model, gpuLock, log, ctx, think, logFile });
    this.proc = null; this.url = null; this.info = null; this.release = null; this.calls = [];
  }

  get available() { return !!this.choose(); }
  choose() { const list = plannerModels(this.runtime); return this.want === "auto" ? list[0] || null : list.find((x) => x.id === this.want) || null; }

  async start() {
    if (this.proc) return this.info;
    const info = this.choose();
    if (!info) throw new AppError("PROVIDER", "err.mediaModelMissing", { model: this.want === "auto" ? "Qwen planner (gguf)" : this.want });
    const server = path.join(this.runtime, "llama", exe("llama-server"));
    if (!fs.existsSync(server)) throw new AppError("PROVIDER", "err.mediaModelMissing", { model: "llama.cpp" });
    this.release = this.gpuLock ? await this.gpuLock.acquire(`director-${info.id}`) : null;
    try {
      const port = await freePort();
      const args = ["-m", info.model, "--host", "127.0.0.1", "--port", String(port), "-c", String(this.ctx), "--jinja", "-t", "16", "-ngl", "99", "-np", "1", "-fa", "on",
        ...(this.think ? [] : ["--reasoning-budget", "0"])];
      const out = this.logFile ? fs.openSync(this.logFile, "a") : "ignore";
      this.proc = spawn(server, args, { windowsHide: true, stdio: ["ignore", out, out] });
      let exited = null;
      this.proc.on("exit", (c) => { exited = c; this.proc = null; });
      this.url = `http://127.0.0.1:${port}`;
      const t0 = Date.now();
      for (let i = 0; i < 900; i++) {
        if (exited !== null) throw new AppError("PROVIDER", "err.mediaRuntime", { script: "llama-server", code: exited });
        try { const r = await fetch(`${this.url}/health`); if (r.ok) { this.info = { ...info, loadMs: Date.now() - t0 }; return this.info; } } catch { /* loading */ }
        await sleep(500);
      }
      throw new AppError("PROVIDER", "err.mediaRuntime", { script: "llama-server", message: "timeout" });
    } catch (e) { await this.stop(); throw e; }
  }

  /** One answer as JSON (schema-constrained). Returns { json, text, ms, tokens }. */
  async json({ system, prompt, schema, maxTokens = 3000, temperature = 0.3 }) {
    await this.start();
    const t0 = Date.now();
    const r = await fetch(`${this.url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: maxTokens, temperature,
        response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } }, chat_template_kwargs: { enable_thinking: !!this.think } }) });
    if (!r.ok) throw new AppError("PROVIDER", "err.mediaRuntime", { script: "llama-server", message: `HTTP ${r.status} ${(await r.text()).slice(0, 300)}` });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || "";
    const out = { json: parseJsonAnswer(text), text, ms: Date.now() - t0, tokens: j.usage?.completion_tokens ?? null };
    this.calls.push({ ms: out.ms, tokens: out.tokens, ok: !!out.json });
    return out;
  }

  async stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } for (let i = 0; i < 40 && this.proc; i++) await sleep(250); }
    this.proc = null; this.url = null;
    if (this.release) { const rel = this.release; this.release = null; await Promise.resolve(rel()).catch(() => {}); }
  }
}

// ------------------------------------------------------------------ Claude (optional)
export const CLAUDE_MODEL = "claude-opus-5-5";
export class ClaudeDirectorLLM {
  /** key: the user's Anthropic API key for this run (kept in memory only). */
  constructor({ key = process.env.ANTHROPIC_API_KEY, model = CLAUDE_MODEL, effort = "medium", log = () => {} } = {}) {
    if (!key) throw new AppError("VALIDATION", "err.claudeKeyMissing");
    const k = String(key);
    // The key lives in this closure only: never on `this`, so it cannot be serialised or logged with the object.
    this.send = (body) => fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": k, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01" }, body: JSON.stringify(body) });
    Object.assign(this, { model, effort, log });
    this.available = true; this.info = { id: "claude", name: model }; this.calls = [];
  }

  async start() { return this.info; }

  async json({ system, prompt, schema, maxTokens = 16000 }) {
    const t0 = Date.now();
    const r = await this.send({ model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }],
      output_config: { effort: this.effort, format: { type: "json_schema", schema } }, fallbacks: "default" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new AppError("PROVIDER", "err.claudeFailed", { status: r.status, message: String(j?.error?.message || "").slice(0, 200) });
    if (j.stop_reason === "refusal") throw new AppError("PROVIDER", "err.claudeFailed", { status: 200, message: `refused (${j.stop_details?.category || "no category"})` });
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const out = { json: parseJsonAnswer(text), text, ms: Date.now() - t0, tokens: j.usage?.output_tokens ?? null };
    this.calls.push({ ms: out.ms, tokens: out.tokens, ok: !!out.json });
    return out;
  }

  async stop() {}
}

// ------------------------------------------------------------------ the three calls
/** Treatments proposed by a model (raw, before validateTreatment). */
export async function llmTreatments(llm, ctx) {
  const r = await llm.json({ system: PLAN_SYSTEM, prompt: planPrompt(ctx), schema: PLAN_SCHEMA, maxTokens: 4000 });
  return { treatments: treatmentsFromAnswer(r.json, llm.info?.id === "claude" ? "claude" : "local"), ms: r.ms, tokens: r.tokens, raw: r.json ? null : r.text.slice(0, 500) };
}

/** A judge for core/critic.js rankTreatments. */
export function llmJudge(llm) {
  return async ({ aText, bText }) => {
    const r = await llm.json({ system: JUDGE_SYSTEM, prompt: `Cut A:\n${aText}\n\nCut B:\n${bText}\n\nWhich cut is better?`, schema: JUDGE_SCHEMA, maxTokens: 300, temperature: 0 });
    return r.json || { winner: "tie", why: "no answer" };
  };
}

/**
 * The graphics ranker for graphics/selection.js, decided for all needs in one call: `needs` = [{ i, startUs, text,
 * tags, energy, candidates }] (what a first heuristic pass saw). Returns ranker(args) — the model's order first, the
 * heuristic's after it (so a need the model skipped still gets the deterministic choice).
 */
export async function llmGraphicsRanker(llm, needs, fallback) {
  if (!needs.length) return { ranker: fallback, ms: 0 };
  const r = await llm.json({ system: GRAPHICS_SYSTEM, prompt: graphicsPrompt(needs), schema: GRAPHICS_SCHEMA, maxTokens: 3000, temperature: 0 });
  const byNeed = new Map((r.json?.picks || []).map((p) => [p.need, (p.templates || []).map(String)]));
  const ranker = async (args) => {
    const base = await fallback(args);
    const want = byNeed.get(args.need.i);
    if (!want) return base;
    if (!want.length) return []; // the model said nothing fits
    const top = want.map((t, k) => base.find((b) => b.template === t) && { ...base.find((b) => b.template === t), score: 100 - k, why: `chosen by the director model (${k + 1})` }).filter(Boolean);
    return [...top, ...base.filter((b) => !want.includes(b.template))];
  };
  return { ranker, ms: r.ms, answered: byNeed.size };
}
