// The graphics layer's runtime: the Chrome Headless Shell that Remotion renders with, and the prebuilt Remotion
// bundle (the React graphics compiled once by src/graphics/build.js). Both live outside the app's asar: the browser
// in runtime/remotion (next to the app, then the user's data folder — like every other engine), the bundle in
// src/graphics/build (unpacked from the asar, see package.json build.asarUnpack). Nothing here downloads on its own:
// installBrowser() is called by the setup command (npm run setup:graphics) or by the app's setup button.
//
// Run directly: node src/graphics/setup.js            → install the browser into ./runtime/remotion
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { runtimeDirs } from "../services/engineSetupService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const unpacked = (p) => p.replace(/\.asar([\\/])/i, ".asar.unpacked$1");

/** Chrome for Testing build that this Remotion version is tested with (the renderer's own constant). */
export const CHROME_VERSION = "157.0.8080.0";
/** Google's official download (the same URL Remotion's ensureBrowser() uses on Windows). */
export const CHROME_URL = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/win64/chrome-headless-shell-win64.zip`;
const SHELL_REL = path.join(`chrome-headless-shell-${CHROME_VERSION}`, "chrome-headless-shell-win64", "chrome-headless-shell.exe");

/** Folder of the prebuilt Remotion bundle (index.html + bundle.js + public/), or null when it is not built. */
export function bundleDir() {
  const dir = unpacked(path.join(HERE, "build", "remotion"));
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}

/** The editor's Player bundle (window.MontajGraphics), or null when it is not built. */
export function previewBundle() {
  const file = path.join(HERE, "build", "preview.js");
  return fs.existsSync(file) ? file : null;
}

/** Path of the installed headless browser, or null. MONTAJ_REMOTION_BROWSER overrides (tests, another Chrome). */
export function browserPath(userData) {
  if (process.env.MONTAJ_REMOTION_BROWSER && fs.existsSync(process.env.MONTAJ_REMOTION_BROWSER)) return process.env.MONTAJ_REMOTION_BROWSER;
  for (const dir of runtimeDirs("remotion", userData)) {
    const exe = path.join(dir, SHELL_REL);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** { ready, browser, bundle, missing: [...] } — what the graphics layer needs to render. */
export function graphicsRuntime(userData) {
  const browser = browserPath(userData), bundle = bundleDir();
  const missing = [...(browser ? [] : ["browser"]), ...(bundle ? [] : ["bundle"])];
  return { ready: !missing.length, browser, bundle, missing };
}

/**
 * Download and unpack the headless browser into dest (default: runtime/remotion next to the app). About 100 MB
 * download; resumable is not needed (the zip is downloaded to a .part file and only renamed when complete).
 */
export async function installBrowser({ dest = runtimeDirs("remotion")[0], onProgress = () => {}, fetchImpl = fetch } = {}) {
  const exe = path.join(dest, SHELL_REL);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dest, { recursive: true });
  const zip = path.join(dest, `chrome-headless-shell-${CHROME_VERSION}.zip`);
  if (!fs.existsSync(zip)) {
    const res = await fetchImpl(CHROME_URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${CHROME_URL}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const part = `${zip}.part`, out = fs.createWriteStream(part);
    let got = 0;
    for await (const chunk of res.body) { out.write(chunk); got += chunk.length; if (total) onProgress(got / total); }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
    fs.renameSync(part, zip);
  }
  const into = path.join(dest, `chrome-headless-shell-${CHROME_VERSION}`);
  fs.mkdirSync(into, { recursive: true });
  // Windows 10+ ships bsdtar, which reads zip (by full path: a GNU tar on PATH, e.g. Git's, reads "D:" as a host)
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", zip, "-C", into]);
  if (!fs.existsSync(exe)) throw new Error(`the browser was not found after unpacking: ${exe}`);
  fs.rmSync(zip, { force: true });
  return exe;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  installBrowser({ onProgress: (p) => process.stdout.write(`\r${Math.round(p * 100)}%`) })
    .then((exe) => console.log(`\nheadless browser: ${exe}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
