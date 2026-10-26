// Measurable signals of a rendered video, in one FFmpeg pass: a visual-change score for every frame (scdet), the
// silences (silencedetect) and the loudness (loudnorm's measurement). Used by the quality report — it judges the
// finished video, never the plan that made it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { binaries, run, ffprobe } from "../../src/services/ffmpeg.js";

/**
 * @returns {{ duration, fps, width, height, scores: {t, s}[], silences: {start, end}[], loudness: {i, tp, lra} | null }}
 */
export async function measure(file, { silenceDb = -35, silenceMin = 0.6 } = {}) {
  const info = await ffprobe(file);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  const duration = Number(info.format?.duration) || 0;
  const [fn, fd] = String(v?.avg_frame_rate || "0/1").split("/").map(Number);
  const tmp = path.join(os.tmpdir(), `montaj-bench-${process.pid}-${Date.now()}.txt`);
  // metadata=print writes every frame's scene score; the file path goes through FFmpeg's filter syntax, so escape it.
  const esc = tmp.replace(/\\/g, "/").replace(/:/g, "\\:");
  const args = ["-hide_banner", "-nostats", "-i", file];
  if (v) args.push("-map", "0:v:0", "-filter:v", `scale=320:-2,scdet=threshold=100,metadata=mode=print:file='${esc}'`);
  if (a) args.push("-map", "0:a:0", "-filter:a", `silencedetect=noise=${silenceDb}dB:d=${silenceMin},loudnorm=print_format=json`);
  args.push("-f", "null", "-");
  const silences = [];
  let open = null, tail = "";
  await run(binaries().ffmpeg, args, {
    timeoutMs: 60 * 60_000,
    onStderr: (s) => {
      tail = (tail + s).slice(-6000);
      for (const m of s.matchAll(/silence_start: (-?[\d.]+)/g)) open = Math.max(0, Number(m[1]));
      for (const m of s.matchAll(/silence_end: ([\d.]+)/g)) { silences.push({ start: open ?? 0, end: Number(m[1]) }); open = null; }
    },
  });
  if (open !== null) silences.push({ start: open, end: duration });
  const scores = [];
  if (v && fs.existsSync(tmp)) {
    let t = null;
    for (const line of fs.readFileSync(tmp, "utf8").split(/\r?\n/)) {
      const ft = /pts_time:([\d.]+)/.exec(line);
      if (ft) { t = Number(ft[1]); continue; }
      const sc = /lavfi\.scd\.score=([\d.]+)/.exec(line);
      if (sc && t !== null) scores.push({ t, s: Number(sc[1]) });
    }
    fs.rmSync(tmp, { force: true });
  }
  let loudness = null;
  const j = /\{[^{}]*"input_i"[^{}]*\}/.exec(tail);
  if (j) { try { const o = JSON.parse(j[0]); loudness = { i: Number(o.input_i), tp: Number(o.input_tp), lra: Number(o.input_lra) }; } catch { /* no measurement */ } }
  return { duration, fps: fd ? fn / fd : 0, width: v?.width || 0, height: v?.height || 0, hasAudio: !!a, scores, silences, loudness };
}

/**
 * Cuts from the per-frame scores: a frame whose change is a clear spike over its neighbourhood (a hard cut, or a jump
 * cut / punch-in inside the same framing, which scores lower than a scene change but still stands out).
 */
export function detectCuts(scores, { minScore = 5, ratio = 3, radius = 12, minGap = 0.25 } = {}) {
  const cuts = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i].s;
    if (s < minScore) continue;
    const lo = Math.max(0, i - radius), hi = Math.min(scores.length, i + radius + 1);
    const around = [];
    let peak = true;
    for (let k = lo; k < hi; k++) { if (k === i) continue; around.push(scores[k].s); if (scores[k].s > s) peak = false; }
    if (!peak) continue;
    around.sort((x, y) => x - y);
    const med = around.length ? around[Math.floor(around.length / 2)] : 0;
    if (s < ratio * Math.max(med, 0.5)) continue;
    if (cuts.length && scores[i].t - cuts[cuts.length - 1] < minGap) continue;
    cuts.push(scores[i].t);
  }
  return cuts;
}
