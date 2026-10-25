// One-click set-up of the dubbing tools for an installed copy (≈ 40 GB; the installer carries none of it). Everything
// lands in the app's data folder (runtime/), where updates leave it alone, from each tool's own source:
//   runtime/python             the portable CPython 3.11 the speech engine set-up also uses (shared, SHA-256 checked)
//   runtime/dub                Chatterbox, sherpa-onnx, faster-whisper… pinned in dub/requirements-dub.txt; torch's
//                              CUDA build when an NVIDIA GPU is present, else the CPU build
//   runtime/sep                audio-separator (Mel-Band RoFormer), pinned in dub/requirements-sep.txt
//   runtime/llama              llama.cpp b11870 (MIT), the CUDA 12.4 build with its runtime DLLs, or the CPU build
//   runtime/models/speaker     pyannote segmentation 3.0 (MIT) and NeMo TitaNet large (CC-BY-4.0), sherpa-onnx's ONNX
//                              exports, from k2-fsa/sherpa-onnx's releases; the gender and child classifiers
//   runtime/models/separation  vocals_mel_band_roformer.ckpt (MIT), fetched by audio-separator from its model list
//   runtime/models/translate   Qwen3.5-35B-A3B Q4_K_M (Apache-2.0), unsloth's GGUF, pinned revision, SHA-256 checked
// and the voice and listening models (Chatterbox, Whisper) into the user's Hugging Face cache. Each step is skipped
// when already done, so a cancelled or failed set-up resumes. Progress is sent as "dub:setup".
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/validation.js";
import { AsrSetupService, PYTHON, cpuRequirements, runProc, sha256File } from "./asrSetupService.js";

const DUB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dub").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const GH = "https://github.com";
export const LLAMA = {
  cuda: [
    { url: `${GH}/ggml-org/llama.cpp/releases/download/b11870/llama-b11870-bin-win-cuda-12.4-x64.zip`, sha256: "0e3c2ed58e08362c37274e578b20bfaa5c73970052f333be832f139ce2ee0f48", size: 272_663_995 },
    { url: `${GH}/ggml-org/llama.cpp/releases/download/b11870/cudart-llama-bin-win-cuda-12.4-x64.zip`, sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6", size: 391_443_627 },
  ],
  cpu: [{ url: `${GH}/ggml-org/llama.cpp/releases/download/b11870/llama-b11870-bin-win-cpu-x64.zip`, sha256: "95d12ad225891399faa0b5a5dec48bb042c9cda1ef178c4ae770ccbe3bdba8d8", size: 24_214_736 }],
};
export const TRANSLATOR = {
  url: "https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/bc014a17be43adabd7066b7a86075ff935c6a4e2/Qwen3.5-35B-A3B-Q4_K_M.gguf",
  file: "Qwen3.5-35B-A3B-Q4_K_M.gguf",
  sha256: "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375",
  size: 22_016_023_168,
};
export const SPEAKER = [
  { url: `${GH}/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, file: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488", size: 6_958_444, extract: true },
  { url: `${GH}/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx`, file: "nemo_en_titanet_large.onnx", sha256: "d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77", size: 101_405_493 },
];
export const SEPARATION = { file: "vocals_mel_band_roformer.ckpt", sha256: "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e" };
/** Approximate download for the dialog. */
export const DUB_DOWNLOAD_BYTES = 40_000_000_000;

const STEPS = [["python", 0.01], ["dubEnv", 0.17], ["sepEnv", 0.12], ["llama", 0.03], ["speaker", 0.01], ["separation", 0.03], ["voices", 0.08], ["translator", 0.54], ["check", 0.01]];

/** Is there an NVIDIA GPU (its driver's nvidia-smi answers)? */
export function hasNvidia() {
  try { return spawnSync("nvidia-smi", ["-L"], { windowsHide: true, timeout: 10_000 }).status === 0; } catch { return false; }
}

export class DubSetupService extends AsrSetupService {
  get dirs() {
    const rt = path.join(this.paths.root, "runtime");
    return { runtime: rt, python: path.join(rt, "python"), dub: path.join(rt, "dub"), sep: path.join(rt, "sep"), llama: path.join(rt, "llama"), models: path.join(rt, "models") };
  }

  status() { return { ...this.state, downloadBytes: DUB_DOWNLOAD_BYTES }; }

  emit(patch) {
    Object.assign(this.state, patch);
    this.notify("dub:setup", this.status());
  }

  at(name, p) {
    let base = 0;
    for (const [n, w] of STEPS) { if (n === name) { this.emit({ step: name, progress: Math.min(1, base + w * Math.max(0, Math.min(1, p))) }); return; } base += w; }
  }

  /** A virtual environment with pinned requirements; the CUDA builds of torch from PyTorch's index when `cuda`. */
  async env(basePy, dir, reqFile, cuda, step, signal) {
    const py = path.join(dir, "Scripts", "python.exe");
    if (!fs.existsSync(py)) await runProc(basePy, ["-m", "venv", dir], { signal });
    const text = fs.readFileSync(path.join(DUB_DIR, reqFile), "utf8");
    const index = /\+(cu\d+)/.exec(text)?.[1];
    const req = path.join(dir, "requirements.txt");
    fs.writeFileSync(req, cuda ? text : cpuRequirements(text));
    const total = text.split(/\r?\n/).filter((l) => /^[A-Za-z0-9]/.test(l)).length;
    let seen = 0;
    await runProc(py, ["-m", "pip", "install", "--progress-bar", "off", "-r", req, ...(cuda && index ? ["--extra-index-url", `https://download.pytorch.org/whl/${index}`] : [])], {
      signal,
      onLine: (l) => { if (/^(Collecting|Requirement already satisfied)/.test(l)) this.at(step, 0.9 * (++seen / total)); },
    });
    this.at(step, 1);
    return py;
  }

  async run(signal) {
    if (process.platform !== "win32") throw new AppError("PROVIDER", "err.asrSetupWindows");
    const d = this.dirs, cuda = hasNvidia();
    for (const x of [d.runtime, path.join(d.models, "speaker"), path.join(d.models, "separation"), path.join(d.models, "translate")]) fs.mkdirSync(x, { recursive: true });
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

    // 1. The portable Python (shared with the speech engine).
    const basePy = path.join(d.python, "python.exe");
    if (!fs.existsSync(basePy)) {
      const archive = await this.download(PYTHON, path.join(d.runtime, "python.tar.gz"), "python", signal);
      fs.rmSync(d.python, { recursive: true, force: true });
      await runProc(tar, ["-xzf", archive, "-C", d.runtime], { signal });
      fs.rmSync(archive, { force: true });
      if (!fs.existsSync(basePy)) throw new AppError("PROVIDER", "err.dubSetupFailed", { message: "python.exe missing after extraction" });
    }
    this.at("python", 1);

    // 2–3. The two environments (the separator needs numpy 2 and a newer torch than the voices).
    const dubPy = await this.env(basePy, d.dub, "requirements-dub.txt", cuda, "dubEnv", signal);
    const sepPy = await this.env(basePy, d.sep, "requirements-sep.txt", cuda, "sepEnv", signal);

    // 4. llama.cpp's server.
    if (!fs.existsSync(path.join(d.llama, "llama-server.exe"))) {
      fs.mkdirSync(d.llama, { recursive: true });
      const parts = cuda ? LLAMA.cuda : LLAMA.cpu;
      for (const [i, part] of parts.entries()) {
        const zip = await this.download(part, path.join(d.runtime, path.basename(new URL(part.url).pathname)), "llama", signal);
        await runProc(tar, ["-xf", zip, "-C", d.llama], { signal });
        fs.rmSync(zip, { force: true });
        this.at("llama", (i + 1) / parts.length);
      }
    }
    this.at("llama", 1);

    // 5. The speaker models.
    const spk = path.join(d.models, "speaker");
    for (const m of SPEAKER) {
      const done = m.extract ? fs.existsSync(path.join(spk, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")) : fs.existsSync(path.join(spk, m.file));
      if (done) continue;
      const f = await this.download(m, path.join(spk, m.file), "speaker", signal);
      if (m.extract) { await runProc(tar, ["-xjf", f, "-C", spk], { signal }); fs.rmSync(f, { force: true }); }
    }
    this.at("speaker", 1);

    // 6. The separation model, fetched by audio-separator itself, then checked.
    const sepDir = path.join(d.models, "separation"), ckpt = path.join(sepDir, SEPARATION.file);
    if (!fs.existsSync(ckpt)) await runProc(path.join(d.sep, "Scripts", "audio-separator.exe"), ["--download_model_only", "-m", SEPARATION.file, "--model_file_dir", sepDir], { signal });
    if ((await sha256File(ckpt)) !== SEPARATION.sha256) { fs.rmSync(ckpt, { force: true }); throw new AppError("IO", "err.asrChecksum", { file: SEPARATION.file }); }
    this.at("separation", 1);

    // 7. The voice, listening and speaker classifier models.
    await runProc(dubPy, ["-X", "utf8", path.join(DUB_DIR, "dub.py"), "prefetch", "--out", path.join(d.runtime, "dub-check"), "--models", spk], {
      signal, onLine: (l) => { const m = /^PROGRESS ([\d.]+)/.exec(l); if (m) this.at("voices", Number(m[1])); },
    });
    this.at("voices", 1);

    // 8. The translator (any GGUF already in models/translate is kept).
    const tdir = path.join(d.models, "translate");
    if (!fs.readdirSync(tdir).some((f) => f.endsWith(".gguf"))) await this.download(TRANSLATOR, path.join(tdir, TRANSLATOR.file), "translator", signal);
    this.at("translator", 1);

    // 9. Everything imports.
    await runProc(dubPy, ["-c", "import chatterbox, sherpa_onnx, faster_whisper, librosa, soundfile; print('ok')"], { signal });
    await runProc(sepPy, ["-c", "import audio_separator; print('ok')"], { signal });
    this.at("check", 1);
  }
}
