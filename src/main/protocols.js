// Custom protocols:
//   app://bundle/...   the renderer (HTML/CSS/JS) and the shared core modules, with a strict CSP
//   media://asset/<id>[?proxy=1], media://thumb/<id>, media://cover/<projectId>, media://lib/<libraryItemId>,
//   media://sticker/<builtin>, media://compound/<timelineId>, media://matte/<mediaId>[?v=stab], media://stab/<mediaId>, media://export/<recordId> — streamed from disk with HTTP Range support (needed for <video> seeking)
import { protocol, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' media: data: blob:",
  "media-src 'self' media: blob:",
  "font-src 'self' data:",
  "connect-src 'self' media:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false } },
  ]);
}

function fileResponse(file, request, extraHeaders = {}) {
  if (!file || !fs.existsSync(file)) return new Response("not found", { status: 404 });
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = request.headers.get("range");
  // CORS lets the renderer read decoded pixels (canvas getImageData) and route audio through Web Audio.
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "app://bundle", ...extraHeaders };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - Number(m[2])); end = stat.size - 1; }
    if (start >= stat.size || end >= stat.size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(stream, { status: 206, headers: { ...base, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${stat.size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...base, "Content-Length": String(stat.size) } });
}

/** @param {{rendererDir: string, coreDir: string, assetsDir: string, getServices: () => object}} o */
export function handleProtocols(o) {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let root = o.rendererDir;
    if (rel.startsWith("core/")) { root = o.coreDir; rel = rel.slice(5); }
    if (!rel) rel = "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(path.normalize(root))) return new Response("forbidden", { status: 403 });
    if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
    const headers = { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" };
    return new Response(fs.readFileSync(file), { headers });
  });

  protocol.handle("media", async (request) => {
    const url = new URL(request.url);
    const kind = url.hostname;
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const s = o.getServices();
    if (!s || !/^[A-Za-z0-9_-]+$/.test(id)) return new Response("bad request", { status: 400 });
    try {
      if (kind === "asset") {
        const m = s.repos.media.get(id);
        const file = url.searchParams.get("proxy") === "1" && m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path;
        return fileResponse(file, request);
      }
      if (kind === "thumb") return fileResponse(s.repos.media.get(id).thumbPath, request);
      if (kind === "cover") return fileResponse(s.repos.projects.get(id).coverPath, request);
      if (kind === "lib") { const item = s.repos.library.list().find((i) => i.id === id); return fileResponse(item?.path, request); }
      if (kind === "sticker") return fileResponse(path.join(o.assetsDir, "stickers", `${id}.svg`), request);
      if (kind === "compound") return fileResponse(s.exporter.compoundPath(id), request); // pre-processed compound clip
      if (kind === "matte") { const v = url.searchParams.get("v") === "stab" ? "stab" : ""; return fileResponse(s.mattes?.ready(id, v) ? s.mattes.file(id, v) : null, request); } // person matte (text behind the person)
      if (kind === "stab") { const fps = Number(url.searchParams.get("fps")) || 30; return fileResponse(s.stabilizer?.ready(id, fps) ? s.stabilizer.file(id, fps) : null, request); } // stabilized copy
      if (kind === "export") { const r = s.repos.exports.list().find((x) => x.id === id); return fileResponse(r?.path, request); }
    } catch {
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  });
}

export { pathToFileURL, net };
