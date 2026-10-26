// The AI layers' set-up (aiSetupService.js + aiSetup/catalog.js): the pinned catalog's integrity, the layer states,
// finding a set's files in a folder (by place, by name), when a whole set folder can be linked, the CUDA wheel pins,
// requirement lookup; and, when this PC has the phases' runtime, a real import / missing / damaged / repair cycle of
// the smallest set into a temporary runtime folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG, LAYERS, ENVS, layerSets, modelSet, layerState, locateFiles, linkableTops, pinLocalWheels, requirementOf, fmtBytes, AI_SETUP_DIR,
} from "../../src/services/aiSetup/catalog.js";
import { SOURCES } from "../../src/services/aiSetup/sources.js";
import { AiSetupService, findByName, linkTarget } from "../../src/services/aiSetupService.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("catalog: every set of sources.js is pinned, every file has a size, a SHA-256 and a pinned source", () => {
  for (const L of SOURCES) for (const s of L.sets) {
    const set = modelSet(L.layer, s.id);
    assert.ok(set, `${L.layer}/${s.id} missing from catalog.json`);
    assert.ok(set.files.length > 0);
    assert.equal(set.bytes, set.files.reduce((n, f) => n + f.size, 0));
    for (const f of set.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.file);
      assert.ok(f.size > 0, f.file);
      assert.ok(f.url || f.archive || f.derived, `${f.file}: no way to get it`);
      // Downloads come from a pinned commit / versioned path of an official host, never a moving branch.
      if (f.url) {
        assert.match(f.url, /^https:\/\/(huggingface\.co|raw\.githubusercontent\.com|media\.githubusercontent\.com|zenodo\.org|storage\.googleapis\.com)\//, f.url);
        if (/huggingface\.co|githubusercontent/.test(f.url)) assert.match(f.url, /\/[0-9a-f]{40}\//, `${f.url} is not pinned to a commit`);
      }
      if (f.archive) { assert.match(f.archive.sha256, /^[0-9a-f]{64}$/); assert.ok(f.archive.member); }
    }
  }
});

test("catalog: gated and locally made sets are import-only; the layers borrow what they share", () => {
  assert.equal(modelSet("perception", "speakers").importOnly, true);
  assert.ok(modelSet("perception", "speakers").gated.url.includes("huggingface.co/pyannote"));
  assert.equal(modelSet("perception", "shots").importOnly, true); // the converted TransNetV2 weights
  assert.equal(modelSet("perception", "vision").importOnly, false);
  const links = layerSets("links");
  assert.deepEqual(links.map((s) => s.key), ["perception/vision", "perception/omni"]);
  assert.ok(links.every((s) => s.borrowed));
  // B-roll captions: Qwen3.5 (the dubbing translator + this projector), measured better than Qwen3.6 in round 4
  assert.ok(layerSets("broll").some((s) => s.key === "broll/captioner" && !s.borrowed));
  assert.ok(LAYERS.find((l) => l.id === "broll").depends.includes("translator"));
  for (const L of LAYERS) assert.ok(ENVS[L.env], L.id);
  for (const e of Object.values(ENVS)) assert.ok(fs.existsSync(path.join(AI_SETUP_DIR, e.requirements)), e.requirements);
  assert.ok(CATALOG.generated);
});

test("layerState: missing without a runtime or any required set, partial when something lacks, ready otherwise", () => {
  const set = (installed, optional = false) => ({ installed, optional });
  assert.equal(layerState({ env: { installed: false }, sets: [set(true)] }), "missing");
  assert.equal(layerState({ env: { installed: true }, sets: [set(false), set(true, true)] }), "missing");
  assert.equal(layerState({ env: { installed: true }, sets: [set(true), set(false)] }), "partial");
  assert.equal(layerState({ env: { installed: true, ok: false }, sets: [set(true)] }), "partial");
  assert.equal(layerState({ env: { installed: true }, sets: [set(true)], deps: [{ ok: false }] }), "partial");
  assert.equal(layerState({ env: { installed: true, ok: true }, sets: [set(true), set(false, true)], deps: [{ ok: true }] }), "ready");
  assert.equal(layerState({ env: { installed: true }, sets: [] }), "ready"); // links: borrows only
});

test("locateFiles + linkableTops: by place (the models folder or the set folder itself), by name and size", () => {
  const set = { dirs: ["a"], files: [{ dir: "a", file: "w.bin", size: 4 }, { dir: "a/sub", file: "c.json", size: 2 }] };
  const files = { "/m/a/w.bin": 4, "/m/a/sub/c.json": 2, "/x/w.bin": 4, "/x/deep/c.json": 2, "/y/w.bin": 9 };
  const norm = (p) => p.replace(/\\/g, "/");
  const exists = (p) => norm(p) in files, sizeOf = (p) => files[norm(p)];
  // the layer's models folder
  let r = locateFiles(set, "/m", new Map(), exists, sizeOf);
  assert.deepEqual(r.map((x) => x.how), ["place", "place"]);
  assert.deepEqual(Object.keys(linkableTops(set, r)), ["a"]);
  assert.equal(norm(linkableTops(set, r).a), "/m/a");
  // the set's own folder picked directly
  r = locateFiles(set, "/m/a", new Map(), exists, sizeOf);
  assert.deepEqual(r.map((x) => x.how), ["place", "place"]);
  assert.equal(norm(linkableTops(set, r).a), "/m/a");
  // scattered files: found by name and size, never linkable as a folder; a wrong size is not taken
  r = locateFiles(set, "/x", new Map([["w.bin", ["/y/w.bin", "/x/w.bin"]], ["c.json", ["/x/deep/c.json"]]]), (p) => false, sizeOf);
  assert.deepEqual(r.map((x) => [x.how, x.path]), [["name", "/x/w.bin"], ["name", "/x/deep/c.json"]]);
  assert.deepEqual(linkableTops(set, r), {});
  r = locateFiles(set, "/z", new Map(), () => false, sizeOf);
  assert.deepEqual(r.map((x) => x.path), [null, null]);
});

test("pinLocalWheels / requirementOf: the CUDA wheels become local files; pip-style name matching", () => {
  const text = "numpy==2.5.4\ntorch==2.11.0+cu130\ntorchaudio==2.11.0+cu130\nonnxruntime-gpu==1.31.0\n";
  const out = pinLocalWheels(text, { torch: "file:///w/torch.whl", torchaudio: "file:///w/ta.whl" });
  assert.match(out, /^torch @ file:\/\/\/w\/torch\.whl$/m);
  assert.match(out, /^torchaudio @ file:\/\/\/w\/ta\.whl$/m);
  assert.match(out, /^numpy==2\.5\.4$/m);
  assert.equal(requirementOf(text, "ONNXRuntime_GPU"), "onnxruntime-gpu==1.31.0");
  assert.equal(requirementOf(text, "torch"), "torch==2.11.0+cu130");
  assert.equal(requirementOf(text, "scipy"), null);
  assert.equal(fmtBytes(18_629_793_472), "18.6 GB");
  assert.equal(fmtBytes(1_200_000), "1 MB");
});

test("the pinned requirements have no local paths and pin torch to the CUDA 13.0 build", () => {
  for (const env of ["perception", "takes"]) {
    const text = fs.readFileSync(path.join(AI_SETUP_DIR, ENVS[env].requirements), "utf8");
    assert.doesNotMatch(text, /file:\/\//);
    assert.match(text, /^torch==2\.11\.0\+cu130$/m);
    for (const line of text.split(/\r?\n/).filter((l) => /^[A-Za-z]/.test(l))) assert.match(line, /^[A-Za-z0-9_.-]+==\S+$/, line);
  }
});

test("findByName: walks a folder (skipping caches and site-packages)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-find-"));
  try {
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".cache"));
    fs.writeFileSync(path.join(dir, "a", "b", "x.onnx"), "1");
    fs.writeFileSync(path.join(dir, ".cache", "x.onnx"), "2");
    const m = findByName(dir, new Set(["x.onnx"]));
    assert.equal(m.get("x.onnx").length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("perception skips a stage whose runtime, llama.cpp or required model is missing (degrades, never fails)", async () => {
  const { PerceptionService } = await import("../../src/services/perception/perceptionService.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-perc-"));
  try {
    const p = new PerceptionService({ runtimeDir: tmp });
    p.runtime = tmp; p.models = path.join(tmp, "models", "perception");
    assert.match(p.missing("speakers"), /perception runtime not installed/);
    assert.match(p.missing("words"), /asr runtime not installed/);
    const py = path.join(tmp, "perception", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    fs.mkdirSync(path.dirname(py), { recursive: true }); fs.writeFileSync(py, "");
    assert.match(p.missing("speakers"), /model not installed: pyannote/);
    assert.match(p.missing("vision"), /llama\.cpp not installed/);
    // a required file of the right size makes the stage runnable (sizes only: no hashing on the hot path)
    const set = modelSet("perception", "shots");
    for (const f of set.files) { const d = path.join(p.models, ...f.dir.split("/")); fs.mkdirSync(d, { recursive: true }); const fd = fs.openSync(path.join(d, f.file), "w"); fs.ftruncateSync(fd, f.size); fs.closeSync(fd); }
    assert.equal(p.missing("shots"), null);
    assert.ok(p.status().missing.speakers);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// The real cycle on the smallest set (DNSMOS, 1.2 MB) when this PC has the phases' runtime: import, a missing file,
// a damaged file, verify and repair (the repair downloads the pinned file again: skipped offline).
const DEV = path.join(REPO, "runtime");
const haveDev = fs.existsSync(path.join(DEV, "models", "takes", "dnsmos", "sig_bak_ovr.onnx"));
test("service: import a set, detect a missing and a damaged file, repair", { skip: !haveDev && "no development runtime here" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-setup-"));
  const svc = new AiSetupService({ paths: { root: tmp }, runtimeRoot: path.join(tmp, "runtime") });
  try {
    let st = await svc.setStatus(modelSet("takes", "voice"));
    assert.equal(st.installed, false);
    // From the dev runtime's models folder: complete in place → linked (junction), nothing copied.
    const r = await svc.importSet("takes/voice", path.join(DEV, "models", "takes"));
    assert.ok(r.report.every((x) => x.result === "linked"), JSON.stringify(r.report));
    const at = path.join(tmp, "runtime", "models", "takes", "dnsmos");
    assert.ok(linkTarget(at));
    assert.equal(r.status.installed, true);
    // Unlinking (never deleting through the link) makes it missing again.
    fs.unlinkSync(at);
    assert.ok(fs.existsSync(path.join(DEV, "models", "takes", "dnsmos", "sig_bak_ovr.onnx")), "the source was not touched");
    st = await svc.setStatus(modelSet("takes", "voice"));
    assert.equal(st.installed, false);
    assert.deepEqual(st.files.map((f) => f.state), ["missing", "missing"]);
    // Copy mode: real files, then one is damaged (same size, other bytes): only a hash check sees it.
    await svc.importSet("takes/voice", path.join(DEV, "models", "takes"), { copy: true });
    const onnx = path.join(at, "sig_bak_ovr.onnx");
    assert.equal(linkTarget(at), null);
    const buf = fs.readFileSync(onnx); buf[100] ^= 0xff; fs.writeFileSync(onnx, buf);
    assert.equal((await svc.setStatus(modelSet("takes", "voice"))).installed, true);
    const v = await svc.verifySet("takes/voice");
    assert.equal(v.files.find((f) => f.file === "sig_bak_ovr.onnx").state, "damaged");
    let online = true;
    try { await fetch("https://raw.githubusercontent.com", { method: "HEAD", signal: AbortSignal.timeout(5000) }); } catch { online = false; }
    if (online) {
      const fixed = await svc.repairSet("takes/voice");
      assert.equal(fixed.installed, true);
      assert.ok(fixed.files.every((f) => f.state === "ok"));
    }
  } finally {
    for (const d of ["dnsmos"]) { const p = path.join(tmp, "runtime", "models", "takes", d); if (linkTarget(p)) fs.unlinkSync(p); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
