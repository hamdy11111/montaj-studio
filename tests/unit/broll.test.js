// B-roll search: rank fusion, reranker blending, diversity and recent-use penalties, evaluation, caption parsing,
// the VLM file lookup, and the index bookkeeping (no models).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rrf, blendRerank, diversify, evaluate } from "../../src/services/broll/fusion.js";
import { parseJsonAnswer, findVlm } from "../../src/services/broll/llm.js";
import { cleanCaption, mediaKey, BrollService } from "../../src/services/brollService.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-broll-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("RRF: a shot several indexes agree on beats one index's favourite", () => {
  const lists = {
    siglip2: [["a", 0.3], ["b", 0.29], ["c", 0.1]],
    metaclip2: [["b", 0.5], ["c", 0.4]],
    bge: [["b", 0.8], ["a", 0.7]],
  };
  const f = rrf(lists, { k: 60, weights: {} });
  assert.deepEqual(f.map((x) => x.id), ["b", "a", "c"]);
  assert.deepEqual(f[0].ranks, { siglip2: 2, metaclip2: 1, bge: 1 });
  const w = rrf({ siglip2: [["a", 1]], qwen3vl: [["b", 1]] }, { weights: { qwen3vl: 2 } });
  assert.equal(w[0].id, "b", "index weights count");
});

test("rerank blend: the reranker reorders the head; the tail stays below in fused order", () => {
  const cands = [{ id: "a", rrf: 0.05 }, { id: "b", rrf: 0.04 }, { id: "c", rrf: 0.03 }, { id: "d", rrf: 0.02 }];
  const out = blendRerank(cands, [0.1, 0.9, 0.5], { weight: 0.7 });
  assert.deepEqual(out.map((x) => x.id), ["b", "c", "a", "d"]);
  assert.equal(out[0].rerank, 0.9);
  assert.equal(out[3].rerank, undefined);
});

test("diversity: neighbouring slices of one take and recently used shots are pushed down", () => {
  const shots = { a1: { mediaKey: "A", startS: 0, endS: 6 }, a2: { mediaKey: "A", startS: 6, endS: 12 }, b1: { mediaKey: "B", startS: 0, endS: 6 }, a9: { mediaKey: "A", startS: 60, endS: 66 } };
  const cands = [{ id: "a1", score: 1 }, { id: "a2", score: 0.95 }, { id: "b1", score: 0.7 }, { id: "a9", score: 0.6 }];
  const out = diversify(cands, (id) => shots[id], { limit: 4 });
  assert.deepEqual(out.map((x) => x.id), ["a1", "b1", "a9", "a2"], "a2 touches a1 → after the others");
  const rec = diversify(cands, (id) => shots[id], { limit: 2, recent: ["a1"] });
  assert.equal(rec[0].id, "a2", "a recently used shot drops below its neighbour");
  const recMedia = diversify(cands, (id) => shots[id], { limit: 1, recent: ["A"] });
  assert.equal(recMedia[0].id, "b1", "a recently used video drops as a whole");
});

test("evaluation: recall@1/5/10 and MRR", () => {
  const e = evaluate([{ ranked: ["x", "a"], relevant: ["a"] }, { ranked: ["b"], relevant: ["b"] }, { ranked: ["q"], relevant: ["z"] }]);
  assert.deepEqual(e, { n: 3, recall1: 0.333, recall5: 0.667, recall10: 0.667, mrr: 0.5 });
});

test("captions: JSON from the model (fenced, with thinking, or bare) cleaned to the stored shape", () => {
  assert.deepEqual(parseJsonAnswer('<think>hmm</think>```json\n{"en":"a pot","x":1}\n```'), { en: "a pot", x: 1 });
  assert.deepEqual(parseJsonAnswer('Sure: {"en": "b"} done'), { en: "b" });
  assert.equal(parseJsonAnswer("no json"), null);
  const c = cleanCaption({ en: "A pot boiling", ar: "حلة بتغلي", keywordsEn: ["pot", " ", "boil"], keywordsAr: "x", people: "2", shot: "macro" });
  assert.deepEqual(c, { en: "A pot boiling", ar: "حلة بتغلي", keywordsEn: ["pot", "boil"], keywordsAr: [], people: 2, shot: null, textOnScreen: false });
  assert.equal(cleanCaption({ ar: "x" }), null, "no English description → no caption");
});

test("VLM lookup: Qwen3.6 from perception first, else Qwen3.5 + its mmproj", () => {
  const rt = path.join(dir, "runtime");
  fs.mkdirSync(path.join(rt, "models", "translate"), { recursive: true });
  fs.mkdirSync(path.join(rt, "models", "media", "unsloth__Qwen3.5-35B-A3B-GGUF"), { recursive: true });
  assert.equal(findVlm(rt), null);
  fs.writeFileSync(path.join(rt, "models", "translate", "Qwen3.5-35B-A3B-Q4_K_M.gguf"), "");
  fs.writeFileSync(path.join(rt, "models", "media", "unsloth__Qwen3.5-35B-A3B-GGUF", "mmproj-F16.gguf"), "");
  assert.equal(findVlm(rt).name, "Qwen3.5-35B-A3B");
  fs.mkdirSync(path.join(rt, "models", "perception"), { recursive: true });
  fs.writeFileSync(path.join(rt, "models", "perception", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), "");
  assert.equal(findVlm(rt).name, "Qwen3.5-35B-A3B", "no mmproj for 3.6 yet → stays on 3.5");
  fs.writeFileSync(path.join(rt, "models", "perception", "mmproj-F16.gguf"), "");
  assert.equal(findVlm(rt).name, "Qwen3.6-35B-A3B");
});

test("index bookkeeping: a stable media key, status counts", () => {
  const f = path.join(dir, "v.mp4");
  fs.writeFileSync(f, "x");
  assert.equal(mediaKey(f), mediaKey(f));
  assert.match(mediaKey(f), /^[0-9a-f]{12}$/);
  const b = new BrollService({ dir: path.join(dir, "idx") });
  b.write({ version: 1, media: { k: { path: f } }, shots: [{ id: "k-0", mediaKey: "k", startS: 0, endS: 6, frames: [], caption: { en: "x" } }, { id: "k-1", mediaKey: "k", startS: 6, endS: 9, frames: [] }] });
  assert.deepEqual(b.status().shots, 2);
  assert.deepEqual(b.status().captioned, 1);
});
