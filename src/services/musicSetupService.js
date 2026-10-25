// The music engine's set-up and model manager: the shared engine set-up (engineSetupService.js) with the music
// runtime (torch's CUDA 12.8 build; a CPU build without an NVIDIA GPU) and the music model sets of music/catalog.js.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineSetupService, engineRuntime, relinkVenv } from "./engineSetupService.js";
import { COMFYUI, PYTHON312, MODEL_SETS, RUNTIME_BYTES, TORCH_WHEELS } from "./music/catalog.js";

const MUSIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "music").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
export const NODE_PACKAGE = path.join(MUSIC_DIR, "engine", "montaj_music");
export { relinkVenv };

export const musicRuntime = (userData) => engineRuntime("music", userData);

export class MusicSetupService extends EngineSetupService {
  constructor(deps) {
    super(deps, {
      name: "music", comfyui: COMFYUI, python: PYTHON312, torchWheels: TORCH_WHEELS, torchIndex: "https://download.pytorch.org/whl/cu128",
      requirements: path.join(MUSIC_DIR, "requirements-music.txt"), modelSets: MODEL_SETS, runtimeBytes: RUNTIME_BYTES,
      importCheck: "import torch, comfy_kitchen, soundfile, librosa; print(torch.__version__, torch.cuda.is_available())",
    });
  }
}
