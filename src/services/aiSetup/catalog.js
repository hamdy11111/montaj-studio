// What the AI layers need, layer by layer — the runtime each one runs in and its model sets, every file pinned to a
// commit of its official source with its size and SHA-256 (catalog.json, made by buildCatalog.mjs from sources.js and
// proved against the copies the phases installed by hand). Sizes, licences and sources are shown on the set-up page
// before anything is downloaded. Pure data + small pure helpers: nothing here touches the disk at import time except
// reading catalog.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "./sources.js";
import { TORCH_WHEELS, TORCH_INDEX, MIN_DRIVER, PYTHON312 } from "../video/catalog.js";
import { LLAMA } from "../dubSetupService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
export const AI_SETUP_DIR = HERE;
export const CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, "catalog.json"), "utf8"));

// The perception and best-take runtimes use the same torch CUDA 13.0 build as the video studio (driver R580+).
export { TORCH_WHEELS, TORCH_INDEX, MIN_DRIVER, PYTHON312, LLAMA };

/**
 * The runtimes. `imports` must work once installed (the health check imports each); `requirements` is pinned;
 * `torch` → the CUDA wheels are fetched by the app (resumable, checked) and pip installs the local files;
 * `overlay` → a venv whose own packages sit on top of another runtime's site-packages (a .pth file), not a full one.
 */
export const ENVS = {
  perception: { name: "perception", requirements: "requirements-perception.txt", torch: true, bytes: 4_200_000_000,
    imports: ["torch", "torchaudio", "pyannote.audio", "funasr", "onnxruntime", "panns_inference", "librosa", "cv2", "sklearn", "python_speech_features", "transformers"] },
  takes: { name: "takes", requirements: "requirements-takes.txt", torch: true, bytes: 4_100_000_000,
    imports: ["torch", "opensmile", "mediapipe", "onnxruntime", "cv2", "librosa", "soundfile", "scipy", "safetensors"] },
  media: { name: "media", requirements: path.join("..", "sfxLibrary", "requirements-media.txt"), overlay: "video", bytes: 200_000_000,
    imports: ["torch", "transformers", "timm", "cv2", "qwen_vl_utils"] },
};

/** Parts other set-ups own; a layer that needs one shows its state and the button of its own set-up. */
export const DEPENDS = {
  llama: { what: "llama.cpp b11870 (MIT): runs the Qwen vision models", path: ["llama", process.platform === "win32" ? "llama-server.exe" : "llama-server"], installable: true },
  asr: { what: "the Egyptian speech engine (words for perception)", path: ["asr", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"], setup: "asr" },
  video: { what: "the video studio's runtime (torch + transformers the B-roll index runs on)", path: ["video", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"], setup: "video" },
  translator: { what: "the dubbing translator Qwen3.5-35B-A3B (it writes the B-roll captions)", path: ["models", "translate", "Qwen3.5-35B-A3B-Q4_K_M.gguf"], setup: "dub" },
};

const sourceSet = (layer, id) => SOURCES.find((l) => l.layer === layer)?.sets.find((s) => s.id === id) || null;

/**
 * The layers, in the order the page shows them. Each: its runtime (env), its own model sets, sets it borrows from
 * another layer ("perception/vision"), what it depends on, and what still works without it (the director's fallback).
 */
export const LAYERS = [
  { id: "perception", env: "perception", root: "perception", depends: ["llama", "asr"], borrows: [],
    sets: ["align", "speakers", "audio", "emotion", "shots", "faces", "adaface", "asd", "vision", "omni"] },
  { id: "takes", env: "takes", root: "takes", depends: [], borrows: [], sets: ["voice", "face", "gaze", "judge"], after: ["perception"] },
  { id: "links", env: "perception", root: "perception", depends: ["llama"], borrows: ["perception/vision", "perception/omni"], sets: [], after: ["perception"] },
  { id: "broll", env: "media", root: "media", depends: ["video", "llama", "translator"], borrows: [], sets: ["siglip2", "metaclip2", "qwen3vlEmb", "rerank", "bge", "captioner"] },
];
export const layerDef = (id) => LAYERS.find((l) => l.id === id) || null;

/** A model set with its metadata (sources.js) and its pinned files (catalog.json). */
export function modelSet(layer, id) {
  const src = sourceSet(layer, id);
  const pinned = CATALOG.layers?.[layer]?.sets?.[id];
  if (!src || !pinned) return null;
  const root = SOURCES.find((l) => l.layer === layer).root;
  return {
    id, layer, key: `${layer}/${id}`, root, name: src.name, license: src.license, stages: src.stages || [], gpuGB: src.gpuGB ?? 0,
    optional: !!src.optional, gated: src.gated || null, files: pinned.files, bytes: pinned.bytes,
    dirs: [...new Set(pinned.files.map((f) => f.dir.split("/")[0]))],
    sources: [...new Set(pinned.files.map((f) => f.source))],
    // Files made on this PC (a converted / exported checkpoint) cannot be downloaded; such a set is import-only.
    importOnly: !!src.gated || pinned.files.some((f) => f.derived),
  };
}

/** Every set a layer uses: its own, then the borrowed ones ("layer/id"). */
export function layerSets(layer) {
  const L = layerDef(layer);
  if (!L) return [];
  return [...L.sets.map((id) => modelSet(L.id, id)), ...L.borrows.map((k) => { const [l, id] = k.split("/"); return { ...modelSet(l, id), borrowed: true }; })].filter((s) => s && s.id);
}

/**
 * The state of a layer from its parts: "ready" (runtime healthy, every required set installed), "partial" (it runs,
 * but some required sets are missing — those stages are skipped), "missing" (no runtime, or nothing to run).
 * env: { installed, ok }, sets: [{ optional, installed }], deps: [{ ok }].
 */
export function layerState({ env, sets, deps = [] }) {
  if (!env?.installed) return "missing";
  const required = sets.filter((s) => !s.optional);
  const have = required.filter((s) => s.installed).length;
  if (!have && required.length) return "missing";
  if (env.ok === false || have < required.length || deps.some((d) => !d.ok)) return "partial";
  return "ready";
}

/**
 * Pick the files of a set that `folder` already has, by their place first (folder/<dir>/<file>, or the set's folder
 * picked directly: folder/<file under its dir>), then by name and size anywhere below. `candidates`: name → [paths]
 * of files found under the folder (only consulted for the name-and-size fallback). Returns per file the path or null.
 */
export function locateFiles(set, folder, candidates = new Map(), exists = fs.existsSync, sizeOf = (p) => fs.statSync(p).size) {
  return set.files.map((f) => {
    const rel = `${f.dir}/${f.file}`;
    const sub = rel.split("/").slice(1).join("/"); // without the set's top folder (the user picked that folder itself)
    const byPlace = [path.join(folder, ...rel.split("/")), path.join(folder, ...sub.split("/"))];
    for (const p of byPlace) if (exists(p) && sizeOf(p) === f.size) return { file: f, path: p, how: "place" };
    const byName = (candidates.get(f.file) || []).find((p) => sizeOf(p) === f.size);
    return { file: f, path: byName || null, how: byName ? "name" : null };
  });
}

/**
 * The folder a whole set's top folder can be linked from: `folder/<top>` when it holds every file of that top folder
 * at its place (a junction then adopts it with no copy). Returns { top → source folder } for the tops that qualify.
 */
export function linkableTops(set, located) {
  const out = {};
  for (const top of set.dirs) {
    const mine = located.filter((x) => x.file.dir.split("/")[0] === top);
    if (!mine.length || mine.some((x) => x.how !== "place")) continue;
    const rel = (x) => [x.file.dir, x.file.file].join("/").split("/").slice(1).join("/");
    const roots = new Set(mine.map((x) => x.path.slice(0, x.path.length - rel(x).length).replace(/[\\/]+$/, "")));
    if (roots.size === 1) out[top] = [...roots][0];
  }
  return out;
}

/** The CUDA wheels in a requirements text replaced by local wheel files (name → file URL). */
export function pinLocalWheels(text, files) {
  let out = text;
  for (const [name, url] of Object.entries(files)) out = out.replace(new RegExp(`^${name}==\\S+$`, "m"), `${name} @ ${url}`);
  return out;
}

/** The requirement line of `name` (normalised like pip: case, -_. alike), e.g. "onnxruntime-gpu==1.31.0", or null. */
export function requirementOf(text, name) {
  const norm = (s) => s.toLowerCase().replace(/[-_.]+/g, "-");
  return text.split(/\r?\n/).map((l) => l.split("#")[0].trim()).find((l) => { const m = /^([A-Za-z0-9_.-]+)\s*(==|@)/.exec(l); return m && norm(m[1]) === norm(name); }) || null;
}

/** Bytes as "18.6 GB" / "230 MB" (decimal, like the download sizes the sources publish). */
export const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
