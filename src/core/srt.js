// SRT parsing/formatting (FEAT-087 Local captions import, FEAT-117 Export captions).
import { US } from "./util.js";
import { AppError } from "./validation.js";

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m) throw new AppError("VALIDATION", "err.captionFormat");
  const [, h, mi, se, ms] = m;
  return ((+h * 3600 + +mi * 60 + +se) * 1000 + +ms.padEnd(3, "0")) * 1000;
}

function fmtTime(us) {
  const ms = Math.max(0, Math.round(us / 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

/** Parse SRT (or simple WebVTT) text into [{startUs, endUs, text}]. */
export function parseSrt(text) {
  if (typeof text !== "string") throw new AppError("VALIDATION", "err.captionFormat");
  const clean = text.replace(/^﻿/, "").replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = clean.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split("-->");
    const startUs = parseTime(a);
    const endUs = parseTime(z.trim().split(/\s+/)[0]);
    const body = lines.slice(ti + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (endUs > startUs && body) cues.push({ startUs, endUs, text: body });
  }
  if (!cues.length) throw new AppError("VALIDATION", "err.captionFormat");
  return cues.sort((x, y) => x.startUs - y.startUs);
}

export function formatSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.startUs)} --> ${fmtTime(c.endUs)}\n${c.text}\n`).join("\n");
}

export function formatTxt(cues) {
  return cues.map((c) => c.text).join("\n");
}

/** Captions from text segments flagged isCaption (or all text segments when none are flagged). */
export function cuesFromTimeline(tl) {
  const texts = [];
  for (const t of tl.tracks) if (t.type === "text") for (const s of t.segments) texts.push(s);
  const caps = texts.filter((s) => s.text?.isCaption);
  return (caps.length ? caps : texts).sort((a, b) => a.start - b.start).map((s) => ({ startUs: s.start, endUs: s.start + s.duration, text: s.text?.content || "" }));
}

export { US };
