// Generates build/icon.png (512×512, original artwork) without external tools: a teal rounded tile with a white
// play triangle over three timeline bars. electron-builder converts it to .ico for the installer and the window.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const N = 512;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, [r, g, b], a = 255) => { const i = (y * N + x) * 4; const k = a / 255, o = px[i + 3] / 255; px[i] = r * k + px[i] * (1 - k); px[i + 1] = g * k + px[i + 1] * (1 - k); px[i + 2] = b * k + px[i + 2] * (1 - k); px[i + 3] = Math.min(255, (k + o * (1 - k)) * 255); };
const inRound = (x, y, x0, y0, x1, y1, r) => { const cx = Math.max(x0 + r, Math.min(x1 - r, x)), cy = Math.max(y0 + r, Math.min(y1 - r, y)); return Math.hypot(x - cx, y - cy) <= r; };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  // Supersampled rounded tile with a diagonal teal gradient.
  let cov = 0;
  for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) cov += inRound(x + dx, y + dy, 16, 16, N - 16, N - 16, 110) ? 0.25 : 0;
  if (!cov) continue;
  const t = (x + y) / (2 * N);
  set(x, y, [Math.round(0 + 20 * t), Math.round(193 - 90 * t), Math.round(205 - 80 * t)], Math.round(255 * cov));
}
const tri = [[196, 120], [196, 312], [356, 216]];
const inTri = (x, y) => { const [a, b, c] = tri; const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]); const d1 = s([x, y], a, b), d2 = s([x, y], b, c), d3 = s([x, y], c, a); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
for (let y = 100; y < 330; y++) for (let x = 180; x < 370; x++) { let cov = 0; for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) cov += inTri(x + dx, y + dy) ? 0.25 : 0; if (cov) set(x, y, [255, 255, 255], Math.round(255 * cov)); }
for (const [x0, x1, y0] of [[110, 300, 350], [150, 402, 384], [110, 250, 418]]) for (let y = y0; y < y0 + 22; y++) for (let x = x0; x < x1; x++) if (inRound(x + 0.5, y + 0.5, x0, y0, x1, y0 + 22, 11)) set(x, y, [255, 255, 255], 235);

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png(N, N, px));
console.log("wrote", out);
