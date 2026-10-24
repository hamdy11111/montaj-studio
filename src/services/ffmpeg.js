// FFmpeg/FFprobe runner. Binaries come from ffmpeg-static / ffprobe-static (unpacked from the asar in builds)
// or from a user-configured path (Settings › Performance). Everything runs locally — no network.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { AppError } from "../core/validation.js";

const require = createRequire(import.meta.url);
const unpacked = (p) => (p ? p.replace(`app.asar${process.platform === "win32" ? "\\" : "/"}`, `app.asar.unpacked${process.platform === "win32" ? "\\" : "/"}`) : p);

let paths = null;
let caps = null;

export function binaries(override = {}) {
  if (paths && !override.ffmpeg && !override.ffprobe) return paths;
  const ff = override.ffmpeg || unpacked(require("ffmpeg-static"));
  const fp = override.ffprobe || unpacked(require("ffprobe-static").path);
  if (!ff || !fs.existsSync(ff)) throw new AppError("MEDIA", "err.ffmpegMissing", { path: ff });
  if (!fp || !fs.existsSync(fp)) throw new AppError("MEDIA", "err.ffprobeMissing", { path: fp });
  paths = { ffmpeg: ff, ffprobe: fp };
  caps = null;
  return paths;
}

export function setBinaries(override) { paths = null; return binaries(override); }

/** Run a process and collect stdout/stderr. */
export function run(bin, args, { timeoutMs = 0, onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = Buffer.alloc(0), err = "";
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    if (signal) signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on("data", (d) => { const s = d.toString(); err += s; if (err.length > 200_000) err = err.slice(-100_000); onStderr?.(s); });
    child.on("error", (e) => { clearTimeout(timer); reject(new AppError("MEDIA", "err.ffmpegSpawn", { message: e.message })); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(new AppError("MEDIA", "err.cancelled"));
      if (code !== 0) return reject(new AppError("MEDIA", "err.ffmpegFailed", { code, stderr: err.slice(-4000) }));
      resolve({ stdout: out, stderr: err });
    });
  });
}

export async function ffprobe(file) {
  const { ffprobe: fp } = binaries();
  const { stdout } = await run(fp, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
  try { return JSON.parse(stdout.toString("utf8")); } catch { throw new AppError("MEDIA", "err.probeParse"); }
}

/**
 * Run ffmpeg with machine-readable progress. `durationUs` lets us report 0..1.
 * Returns { promise, cancel }.
 */
export function ffmpegJob(args, { durationUs = 0, onProgress } = {}) {
  const { ffmpeg } = binaries();
  const ac = new AbortController();
  let lastErr = "";
  const promise = new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-y", "-progress", "pipe:1", "-nostats", ...args], { windowsHide: true });
    ac.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && durationUs > 0) onProgress?.(Math.min(0.999, Number(m[1]) / durationUs));
        if (line === "progress=end") onProgress?.(1);
      }
    });
    child.stderr.on("data", (d) => { lastErr += d.toString(); if (lastErr.length > 60_000) lastErr = lastErr.slice(-30_000); });
    child.on("error", (e) => reject(new AppError("MEDIA", "err.ffmpegSpawn", { message: e.message })));
    child.on("close", (code) => {
      if (ac.signal.aborted) return reject(new AppError("MEDIA", "err.cancelled"));
      if (code !== 0) return reject(new AppError("MEDIA", "err.exportFailed", { code, stderr: lastErr.slice(-8000), code }));
      resolve(true);
    });
  });
  return { promise, cancel: () => ac.abort() };
}

/** Detect available filters/encoders once (features are disabled gracefully when missing). */
export async function capabilities() {
  if (caps) return caps;
  const { ffmpeg } = binaries();
  const [{ stdout: f }, { stdout: e }, { stdout: v }] = await Promise.all([
    run(ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 20_000 }),
    run(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 20_000 }),
    run(ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 20_000 }),
  ]);
  const filters = new Set([...f.toString().matchAll(/^\s*[TSC.]{3}\s+(\S+)/gm)].map((m) => m[1]));
  const encoders = new Set([...e.toString().matchAll(/^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/gm)].map((m) => m[1]));
  // Filters with timeline support (flag "T") accept `enable=…`, which lets the exporter grade in place.
  const timeline = new Set([...f.toString().matchAll(/^\s*T[S.][C.]\s+(\S+)/gm)].map((m) => m[1]));
  caps = { version: v.toString().split("\n")[0], filters, encoders, timeline };
  return caps;
}

export function capsSummary(c) {
  return {
    version: c.version,
    encoders: ["libx264", "libx265", "libaom-av1", "libsvtav1", "h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf", "prores_ks", "gif", "flac", "libmp3lame", "aac", "pcm_s16le"].filter((x) => c.encoders.has(x)),
    filters: ["xfade", "huesaturation", "colortemperature", "lut3d", "chromakey", "afftdn", "curves", "loudnorm", "deshake", "vidstabdetect", "rgbashift", "pixelize", "afftfilt"].filter((x) => c.filters.has(x)),
  };
}
