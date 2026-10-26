// Builds the graphics layer's two bundles from src/graphics/remotion (run: npm run build:graphics):
//   src/graphics/build/remotion/              the Remotion bundle the renderer opens (webpack via @remotion/bundler),
//                                             with the app's bundled fonts in its public/fonts
//   src/renderer/js/editor/graphicsPlayer.js  the editor's Player module (esbuild, ES module, React + @remotion/player
//                                             + the same components) — loaded by graphicsRaster.js
// Both are build outputs (git-ignored); the packaged app carries them (package.json build: src/** + asarUnpack).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
export const REMOTION_OUT = path.join(HERE, "build", "remotion");
export const PLAYER_OUT = path.join(ROOT, "src", "renderer", "js", "editor", "graphicsPlayer.js");

/** Copy the app's fonts into a fresh public folder for the bundle (fonts/<family>/<file>). */
function stagePublic() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-gfx-public-"));
  fs.cpSync(path.join(ROOT, "src", "renderer", "assets", "fonts"), path.join(dir, "fonts"), { recursive: true, filter: (f) => !/LICENSE|\.txt$/i.test(path.basename(f)) || fs.statSync(f).isDirectory() });
  return dir;
}

export async function buildRemotion({ onProgress = () => {} } = {}) {
  const { bundle } = await import("@remotion/bundler");
  const publicDir = stagePublic();
  try {
    fs.rmSync(REMOTION_OUT, { recursive: true, force: true });
    await bundle({ entryPoint: path.join(HERE, "remotion", "index.jsx"), outDir: REMOTION_OUT, publicDir, enableCaching: true, onProgress });
  } finally {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
  return REMOTION_OUT;
}

export async function buildPlayer() {
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(HERE, "preview", "entry.jsx")], outfile: PLAYER_OUT, bundle: true, format: "esm", platform: "browser",
    target: "chrome120", minify: true, legalComments: "linked", jsx: "automatic", loader: { ".js": "jsx" },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
    banner: { js: "// Built by src/graphics/build.js from src/graphics/preview/entry.jsx — do not edit." },
  });
  return PLAYER_OUT;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const what = process.argv[2] || "all";
  const t0 = Date.now();
  (async () => {
    if (what === "all" || what === "player") console.log("player:", await buildPlayer(), `${Date.now() - t0} ms`);
    if (what === "all" || what === "remotion") {
      let last = -1;
      console.log("remotion:", await buildRemotion({ onProgress: (p) => { if (p - last >= 25) { last = p; console.log(`  ${p}%`); } } }), `${Date.now() - t0} ms`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
