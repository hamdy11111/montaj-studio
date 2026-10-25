// The video engine's set-up and model manager: the shared engine set-up (engineSetupService.js) with its own runtime
// (torch's CUDA 13.0 build — apart from the music runtime, whose torch is CUDA 12.8; an NVIDIA GPU and driver 580+ are
// required) and the video model sets of video/catalog.js.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineSetupService, engineRuntime } from "./engineSetupService.js";
import { COMFYUI, PYTHON312, MODEL_SETS, RUNTIME_BYTES, TORCH_WHEELS, TORCH_INDEX, MIN_DRIVER } from "./video/catalog.js";

const VIDEO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "video").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
export const VIDEO_NODE_PACKAGE = path.join(VIDEO_DIR, "engine", "montaj_video");

export const videoRuntime = (userData) => engineRuntime("video", userData);

export class VideoSetupService extends EngineSetupService {
  constructor(deps) {
    super(deps, {
      name: "video", comfyui: COMFYUI, python: PYTHON312, torchWheels: TORCH_WHEELS, torchIndex: TORCH_INDEX,
      requirements: path.join(VIDEO_DIR, "requirements-video.txt"), modelSets: MODEL_SETS, runtimeBytes: RUNTIME_BYTES,
      needsGpu: true, minDriver: MIN_DRIVER,
      importCheck: "import torch, comfy_kitchen, av; assert torch.cuda.is_available(), 'no CUDA'; print(torch.__version__, torch.version.cuda)",
    });
  }
}
