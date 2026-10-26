// B-roll search over the user's own footage («لقطة حلة بتغلي», «عربية في الشارع بالليل»). Videos are read in place
// (never copied) and indexed once into a folder of their own:
//   shots      broll/broll.py shots — cuts + long takes split into ≤ 6 s pieces, 4 keyframes each (384 px)
//   captions   the local VLM (broll/llm.js) describes each shot: English sentence, Arabic sentence, keywords
//   embeddings broll/broll.py embed — SigLIP2 and MetaCLIP 2 (keyframes), Qwen3-VL-Embedding (the shot as a video),
//              bge-m3 (the captions)
// A search expands the request (the VLM, or a translator, gives English + MSA phrases; the request itself is used as
// is too), asks every index for its top 100, fuses them (broll/fusion.js: RRF), reranks the top 30 with
// Qwen3-VL-Reranker, and returns diverse shots, the recently used ones pushed down.
// Heavy steps take the GPU in turn (the app's GpuQueue, passed as `gpu`), and stop their models afterwards.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/validation.js";
import { binaries } from "./ffmpeg.js";
import { mediaRuntime, runPy, PyWorker } from "./sfxLibrary/mediaRuntime.js";
import { rrf, blendRerank, diversify, FUSION } from "./broll/fusion.js";
import { LlamaServer, parseJsonAnswer, CAPTION_PROMPT, QUERY_PROMPT } from "./broll/llm.js";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "broll").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const PY = path.join(HERE, "broll.py");
export const BROLL_MODELS = ["google/siglip2-so400m-patch16-naflex", "facebook/metaclip-2-worldwide-huge-quickgelu", "Qwen/Qwen3-VL-Embedding-2B", "BAAI/bge-m3", "Qwen/Qwen3-VL-Reranker-2B"];
const VIDEO_EXT = /\.(mp4|mov|mkv|m4v|avi|mts|webm)$/i;

/** A stable key for a source file (path + size + mtime): re-indexed only when it changes. */
export function mediaKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash("sha1").update(`${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex").slice(0, 12);
}

/** Clean a VLM caption answer into the stored shape (or null). */
export function cleanCaption(j) {
  if (!j || typeof j !== "object" || !j.en) return null;
  const arr = (x) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : []);
  return { en: String(j.en).slice(0, 400), ar: String(j.ar || "").slice(0, 300), keywordsEn: arr(j.keywordsEn), keywordsAr: arr(j.keywordsAr),
    people: Number.isFinite(+j.people) ? +j.people : null, shot: ["close-up", "medium", "wide"].includes(j.shot) ? j.shot : null, textOnScreen: !!j.textOnScreen };
}

export class BrollService {
  /** @param {{ dir: string, userData?: string, gpu?: import("./gpuQueue.js").GpuQueue, log?: Function }} o */
  constructor({ dir, userData = null, gpu = null, log = () => {} }) {
    Object.assign(this, { dir, userData, gpu, log });
    fs.mkdirSync(dir, { recursive: true });
    this.worker = null;
    this.llm = null;
  }

  runtime() {
    const rt = mediaRuntime(this.userData);
    if (!rt) throw new AppError("PROVIDER", "err.mediaRuntime", { message: "runtime/media missing" });
    return rt;
  }

  file() { return path.join(this.dir, "shots.json"); }
  read() { try { return JSON.parse(fs.readFileSync(this.file(), "utf8")); } catch { return { version: 1, media: {}, shots: [] }; } }
  write(idx) { fs.writeFileSync(`${this.file()}.tmp`, JSON.stringify(idx)); fs.renameSync(`${this.file()}.tmp`, this.file()); }

  status() {
    const idx = this.read();
    const emb = {};
    for (const n of ["siglip2", "metaclip2", "qwen3vl", "bge"]) { try { emb[n] = JSON.parse(fs.readFileSync(path.join(this.dir, `emb_${n}.json`), "utf8")).rows.length; } catch { emb[n] = 0; } }
    return { dir: this.dir, media: Object.keys(idx.media).length, shots: idx.shots.length, captioned: idx.shots.filter((s) => s.caption).length, embeddings: emb };
  }

  async withGpu(id, fn) {
    if (!this.gpu) return fn();
    const release = await this.gpu.acquire("broll", id);
    try { return await fn(); } finally { release(); }
  }

  /** Shots of new or changed videos (files or folders, read in place). CPU only. */
  async addVideos(inputs, { onProgress, signal } = {}) {
    const files = inputs.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)) : [p])).filter((f) => VIDEO_EXT.test(f));
    const idx = this.read();
    const rt = this.runtime();
    let added = 0;
    for (const [i, f] of files.entries()) {
      const key = mediaKey(f);
      if (idx.media[key]) continue;
      for (const [k, m] of Object.entries(idx.media)) if (m.path === path.resolve(f)) { delete idx.media[k]; idx.shots = idx.shots.filter((s) => s.mediaKey !== k); } // changed file
      const r = await runPy(rt, PY, ["shots", "--video", f, "--out", this.dir, "--key", key, "--ffmpeg", binaries().ffmpeg, "--ffprobe", binaries().ffprobe], { signal, onLine: (l) => l.progress != null && onProgress?.((i + l.progress) / files.length) });
      idx.media[key] = { path: path.resolve(f), width: r.width, height: r.height, durationS: r.durationS, indexedAt: new Date().toISOString() };
      r.shots.forEach((s, n) => idx.shots.push({ id: `${key}-${n}`, mediaKey: key, ...s }));
      added += r.shots.length;
      this.write(idx);
    }
    return { files: files.length, shots: added, total: idx.shots.length };
  }

  /** Captions for the shots that have none (the VLM on the GPU; stopped afterwards). */
  async caption({ onProgress, signal, limit = Infinity } = {}) {
    const idx = this.read();
    const todo = idx.shots.filter((s) => !s.caption).slice(0, limit);
    if (!todo.length) return { captioned: 0 };
    return this.withGpu("broll-caption", async () => {
      const llm = new LlamaServer({ runtime: path.dirname(this.runtime().dir), log: this.log, logFile: path.join(this.dir, "llama.log") });
      const t0 = Date.now();
      let ok = 0, failed = 0;
      try {
        const vlm = await llm.start();
        for (const [i, s] of todo.entries()) {
          if (signal?.aborted) throw new AppError("MEDIA", "err.cancelled");
          const frames = [s.frames[1], s.frames[2]].map((f) => path.join(this.dir, f));
          let cap = null;
          for (let tries = 0; tries < 2 && !cap; tries++) cap = cleanCaption(parseJsonAnswer(await llm.chat(CAPTION_PROMPT, { images: frames, maxTokens: 350 })));
          if (cap) { s.caption = { ...cap, model: vlm.name }; ok++; } else failed++;
          if (i % 10 === 9) this.write(idx);
          onProgress?.((i + 1) / todo.length);
        }
      } finally { llm.stop(); this.write(idx); }
      return { captioned: ok, failed, seconds: Math.round((Date.now() - t0) / 100) / 10, perShotS: Math.round((Date.now() - t0) / Math.max(1, ok + failed)) / 1000 };
    });
  }

  /** Embeddings of new shots in every index (each model loaded in turn, freed after). */
  async embed({ what = "siglip2,metaclip2,qwen3vl,bge", onProgress, signal } = {}) {
    const rt = this.runtime();
    this.worker?.stop(); this.worker = null; // the worker holds the old matrices
    return this.withGpu("broll-embed", () => runPy(rt, PY, ["embed", "--index", this.dir, "--models", rt.models, "--what", what, "--device", "cuda"], { signal, onLine: (l) => l.progress != null && onProgress?.(l) }));
  }

  /** English/MSA phrases for an Egyptian request (the VLM as a text model). */
  async expand(query) {
    const llm = new LlamaServer({ runtime: path.dirname(this.runtime().dir), log: this.log });
    try { await llm.start(); return parseJsonAnswer(await llm.chat(QUERY_PROMPT(query), { maxTokens: 250 })) || {}; } finally { llm.stop(); }
  }

  searchWorker() {
    if (!this.worker) { const rt = this.runtime(); this.worker = new PyWorker(rt, PY, ["serve", "--index", this.dir, "--models", rt.models, "--device", "cuda"], { log: this.log }); }
    return this.worker;
  }

  close() { this.worker?.stop(); this.worker = null; this.llm?.stop(); }

  /**
   * Search. `expanded` ({ en: [], ar: [], keywords: [] }) can be given (a translator ran already); otherwise the
   * request is used as it is for the multilingual indexes. Options: limit, recent (shot ids or media keys used lately),
   * rerank (default true), weights (per index).
   * Returns [{ id, mediaKey, path, startS, endS, frames, caption, score, ranks, rerank }].
   */
  async search(query, { expanded = null, limit = 10, recent = [], rerank = true, weights = FUSION.weights, k = 100 } = {}) {
    const idx = this.read();
    const byId = new Map(idx.shots.map((s) => [s.id, s]));
    const isAr = /[؀-ۿ]/.test(query);
    const en = [...(expanded?.en || []), ...(expanded?.keywords?.length ? [expanded.keywords.join(", ")] : []), ...(isAr ? [] : [query])];
    const ar = [...(expanded?.ar || []), ...(isAr ? [query] : [])];
    const w = this.searchWorker();
    const { lists } = await w.request({ op: "search", en, ar, k });
    let cands = rrf(lists, { weights });
    if (rerank && cands.length) {
      const head = cands.slice(0, FUSION.rerankTop);
      const q = en[0] ? `${en[0]}${isAr ? ` (${query})` : ""}` : query;
      const { scores } = await w.request({ op: "rerank", query: q, shots: head.map((c) => c.id) });
      cands = blendRerank(cands, scores);
    }
    const shotOf = (id) => byId.get(id);
    return diversify(cands, shotOf, { limit, recent }).map((c) => {
      const s = byId.get(c.id);
      return { id: c.id, mediaKey: s.mediaKey, path: idx.media[s.mediaKey]?.path, startS: s.startS, endS: s.endS, frames: s.frames.map((f) => path.join(this.dir, f)), caption: s.caption || null,
        score: c.final, ranks: c.ranks, rerank: c.rerank ?? null };
    });
  }
}
