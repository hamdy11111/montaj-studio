// Fast small decodes for analysis passes (person matte, stabilization): 4K HEVC decodes at ~1× real time on the
// CPU; NVIDIA decoding with the resize on the GPU is ~4× faster. GPU frames skip FFmpeg's automatic rotation, so the
// orientation is chosen by comparing one GPU frame (as is, flipped, turned) with the CPU frame (rotated by FFmpeg).
// No NVIDIA GPU, or no match: the CPU path. Recipes are cached per file and size.
import { binaries, run } from "./ffmpeg.js";

const recipes = new Map();

/** { gpu, pre: [input args], vf: "filters ending at W×H yuv420p", cpu: <the CPU recipe> } */
export async function decodeRecipe(src, W, H, atS = 1, log = () => {}) {
  const key = `${src}|${W}x${H}`;
  if (recipes.has(key)) return recipes.get(key);
  const { ffmpeg } = binaries();
  const cpu = { gpu: false, pre: [], vf: `scale=${W}:${H}:flags=bicubic` };
  cpu.cpu = cpu;
  const grab = async (pre, vf) => (await run(ffmpeg, ["-hide_banner", "-loglevel", "error", ...pre, "-ss", atS.toFixed(3), "-i", src, "-an", "-vf", `${vf},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeoutMs: 60_000 })).stdout;
  let best = cpu;
  try {
    const ref = await grab(cpu.pre, cpu.vf);
    const pre = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
    let bestErr = Infinity;
    for (const [turn, sw, sh] of [["", W, H], [",hflip,vflip", W, H], [",transpose=clock", H, W], [",transpose=cclock", H, W]]) {
      const vf = `scale_cuda=${sw}:${sh}:format=yuv420p,hwdownload,format=yuv420p${turn}`;
      const img = await grab(pre, vf).catch(() => null);
      if (!img || img.length !== ref.length) continue;
      let err = 0;
      for (let i = 0; i < ref.length; i += 7) { const d = ref[i] - img[i]; err += d * d; }
      err /= ref.length / 7;
      if (err < bestErr) { bestErr = err; best = { gpu: true, pre, vf, cpu }; }
    }
    if (bestErr > 120) best = cpu; // PSNR under ~27 dB: not the same picture
  } catch (e) { log("fast decode probe failed", e.message); best = cpu; }
  recipes.set(key, best);
  return best;
}

/** Forget a recipe (tests force a failing GPU recipe through this map). */
export const decodeRecipes = recipes;
