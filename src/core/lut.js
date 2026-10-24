// .cube 3D LUT parsing (FEAT-071/095). The exporter hands the file to FFmpeg's lut3d; the preview samples it.
import { AppError } from "./validation.js";

export function parseCube(text) {
  let size = 0;
  const data = [];
  let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("TITLE")) continue;
    if (line.startsWith("LUT_3D_SIZE")) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (line.startsWith("LUT_1D_SIZE")) throw new AppError("VALIDATION", "err.lut1d");
    if (line.startsWith("DOMAIN_MIN")) { domainMin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (line.startsWith("DOMAIN_MAX")) { domainMax = line.split(/\s+/).slice(1).map(Number); continue; }
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) data.push(parts);
  }
  if (!size || size < 2 || size > 128 || data.length !== size ** 3) throw new AppError("VALIDATION", "err.lutFormat", { size, entries: data.length });
  const table = new Float32Array(size ** 3 * 3);
  data.forEach((rgb, i) => { table[i * 3] = rgb[0]; table[i * 3 + 1] = rgb[1]; table[i * 3 + 2] = rgb[2]; });
  return { size, table, domainMin, domainMax };
}

/** Trilinear sample; r,g,b in 0..1. Cube data is ordered with red changing fastest. */
export function sampleLut(lut, r, g, b) {
  const n = lut.size - 1;
  const fx = Math.min(n, Math.max(0, r * n)), fy = Math.min(n, Math.max(0, g * n)), fz = Math.min(n, Math.max(0, b * n));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const x1 = Math.min(n, x0 + 1), y1 = Math.min(n, y0 + 1), z1 = Math.min(n, z0 + 1);
  const dx = fx - x0, dy = fy - y0, dz = fz - z0;
  const s = lut.size, t = lut.table;
  const idx = (x, y, z) => (x + y * s + z * s * s) * 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = t[idx(x0, y0, z0) + c], c100 = t[idx(x1, y0, z0) + c], c010 = t[idx(x0, y1, z0) + c], c110 = t[idx(x1, y1, z0) + c];
    const c001 = t[idx(x0, y0, z1) + c], c101 = t[idx(x1, y0, z1) + c], c011 = t[idx(x0, y1, z1) + c], c111 = t[idx(x1, y1, z1) + c];
    const c00 = c000 + (c100 - c000) * dx, c10 = c010 + (c110 - c010) * dx, c01 = c001 + (c101 - c001) * dx, c11 = c011 + (c111 - c011) * dx;
    const c0 = c00 + (c10 - c00) * dy, c1 = c01 + (c11 - c01) * dy;
    out[c] = c0 + (c1 - c0) * dz;
  }
  return out;
}
