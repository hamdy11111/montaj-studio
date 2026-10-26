// صفحة «اكتب الكلام»: prepares the reference-transcription page from the media in montaj-bench\للكتابة.
//
//   node bench/transcript.mjs [--in "<...\montaj-bench\للكتابة>"] [--out "<...\montaj-bench\النتائج\الكتابة>"]
//   node bench/transcript.mjs --cases          (the raw files of all bench cases instead of the للكتابة folder)
//
// Runs bench/transcript_prepare.py with the dubbing runtime's Python (faster-whisper + the local large-v3 model) and
// puts "اكتب الكلام.html" next to the clips. The user's corrections end up in reference.json next to the page.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { binaries } from "../src/services/ffmpeg.js";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MEDIA = /\.(mp4|mov|mkv|webm|m4v|avi|mts|wav|mp3|m4a|aac|flac|ogg)$/i;
const BENCH = path.resolve(APP, "..", "montaj-bench");

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const input = opt("--in", path.join(BENCH, "للكتابة"));
const out = opt("--out", path.join(BENCH, "النتائج", "الكتابة"));
// --cases: the raw files of every bench case (read in place) when no separate transcription material was given.
const fromCases = a.includes("--cases")
  ? (await import("./align.mjs")).rawFiles
  : null;
const files = fromCases
  ? fs.readdirSync(path.join(BENCH, "الحالات")).flatMap((c) => fromCases(path.join(BENCH, "الحالات", c)))
  : fs.existsSync(input) ? fs.readdirSync(input).filter((f) => MEDIA.test(f)).sort().map((f) => path.join(input, f)) : [];
if (!files.length) { console.error(`مفيش ملفات صوت أو فيديو في ${input}`); process.exit(2); }
const python = [path.join(APP, "runtime", "dub", "Scripts", "python.exe"), path.join(process.env.APPDATA || "", "Montaj Studio", "runtime", "dub", "Scripts", "python.exe")].find((p) => fs.existsSync(p));
if (!python) { console.error("محتاج بيئة الدبلجة (فيها faster-whisper)."); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const p = spawn(python, [path.join(APP, "bench", "transcript_prepare.py"), "--ffmpeg", binaries().ffmpeg, "--out", out, ...files], { stdio: "inherit", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
p.on("close", (code) => {
  if (code !== 0) { console.error("التجهيز فشل."); process.exit(code || 1); }
  fs.copyFileSync(path.join(APP, "bench", "transcript.html"), path.join(out, "اكتب الكلام.html"));
  console.log(path.join(out, "اكتب الكلام.html"));
});
