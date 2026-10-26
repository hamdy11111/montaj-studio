// The raw files of a bench case (its خام\ folder, or the paths listed in خام\مسارات.txt — read in place, never copied)
// and the alignment of a published edit against them (bench/align.py, run with the music runtime's Python).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { binaries } from "../src/services/ffmpeg.js";
import { musicRuntime } from "../src/services/musicSetupService.js";

const VIDEO = /\.(mp4|mov|mkv|webm|m4v|avi|mts|wav|mp3|m4a)$/i;
const ALIGN = fileURLToPath(new URL("./align.py", import.meta.url));

/** The raw files of a case, in their recording order (by name). */
export function rawFiles(caseDir) {
  const dir = path.join(caseDir, "خام");
  if (!fs.existsSync(dir)) return [];
  const listed = path.join(dir, "مسارات.txt");
  const fromList = fs.existsSync(listed)
    ? fs.readFileSync(listed, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, "")).filter((l) => l && fs.existsSync(l))
    : [];
  const inside = fs.readdirSync(dir).filter((f) => VIDEO.test(f)).map((f) => path.join(dir, f));
  return [...inside, ...fromList].sort((a, b) => path.basename(a).localeCompare(path.basename(b), "en", { numeric: true }));
}

/** Align `published` against `raws`; resolves the parsed report. */
export function align(published, raws, out) {
  const rt = musicRuntime(path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  if (!rt) return Promise.reject(new Error("bench alignment needs the music runtime (numpy + librosa)"));
  const args = [ALIGN, "--ffmpeg", binaries().ffmpeg, "--published", published, "--out", out, ...raws.flatMap((r) => ["--raw", r])];
  return new Promise((resolve, reject) => {
    const p = spawn(rt.python, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(fs.readFileSync(out, "utf8"))) : reject(new Error(`align failed (${code}): ${err}`))));
  });
}
