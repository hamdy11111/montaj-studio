// The render worker: a separate Node process (Electron runs it with ELECTRON_RUN_AS_NODE) that keeps one headless
// browser open and renders graphics from the prebuilt Remotion bundle. It never decodes the user's video — only the
// transparent overlay is rendered (the edit-hamdy "hybrid render"); FFmpeg composites it at export.
// Pictures the graphics use are served from a local HTTP server that only answers for the files listed in the job.
// Protocol (process IPC): parent → { id, cmd: "render" | "still" | "sheet" | "close", job } ; worker → { id, ok, result }
// | { id, error } | { id, progress }.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".json": "application/json", ".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime", ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2" };

let R = null, browser = null, server = null, base = "", allowed = new Map(), cfg = {};

/** The asset server: GET /a?u=<reference> → the file the parent resolved for that reference (only those). */
function startServer() {
  return new Promise((ok) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x").searchParams.get("u");
      const file = u && allowed.get(u);
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const st = fs.statSync(file), type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      const head = { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes" };
      if (range) {
        const a = range[1] ? Number(range[1]) : 0, b = range[2] ? Number(range[2]) : st.size - 1;
        res.writeHead(206, { ...head, "Content-Range": `bytes ${a}-${b}/${st.size}`, "Content-Length": b - a + 1 });
        fs.createReadStream(file, { start: a, end: b }).pipe(res);
      } else { res.writeHead(200, { ...head, "Content-Length": st.size }); fs.createReadStream(file).pipe(res); }
    });
    server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}/a?u=`; ok(); });
  });
}

async function ready() {
  if (!R) R = await import("@remotion/renderer");
  if (!server) await startServer();
  if (!browser) browser = await R.openBrowser("chrome", { browserExecutable: cfg.browser, chromiumOptions: { gl: cfg.gl || "angle" }, logLevel: "error" });
}

const common = () => ({ serveUrl: cfg.bundle, puppeteerInstance: browser, browserExecutable: cfg.browser, binariesDirectory: cfg.binaries || null, chromiumOptions: { gl: cfg.gl || "angle" }, logLevel: "error" });

async function composition(id, inputProps) {
  return R.selectComposition({ ...common(), id, inputProps });
}

const concurrency = (n) => Math.max(1, Math.min(n || cfg.concurrency || 16, os.cpus().length));

/** One graphic → a transparent ProRes 4444 clip (or another codec for the sample videos). */
async function render(job, progress) {
  allowed = new Map(Object.entries(job.assets || {}));
  const id = job.composition || "Graphic";
  const inputProps = { ...(job.props || { template: job.template, params: job.params, pack: job.pack }), assetBase: base, durationInFrames: job.durationInFrames, fps: job.fps, width: job.width, height: job.height };
  const comp = await composition(id, inputProps);
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  const alpha = (job.codec || "prores") === "prores";
  const t0 = Date.now();
  await R.renderMedia({
    ...common(), composition: comp, inputProps, outputLocation: job.out, overwrite: true, concurrency: concurrency(job.concurrency),
    codec: job.codec || "prores", ...(alpha ? { proResProfile: "4444", pixelFormat: "yuva444p10le", imageFormat: "png" } : { imageFormat: "jpeg", crf: job.crf ?? 18, pixelFormat: "yuv420p" }),
    ...(job.scale ? { scale: job.scale } : {}), ...(job.frameRange ? { frameRange: job.frameRange } : {}),
    onProgress: ({ progress: p }) => progress(p),
  });
  return { out: job.out, frames: comp.durationInFrames, ms: Date.now() - t0 };
}

/** One frame → PNG (transparent). */
async function still(job) {
  allowed = new Map(Object.entries(job.assets || {}));
  const inputProps = { ...(job.props || { template: job.template, params: job.params, pack: job.pack }), assetBase: base, durationInFrames: job.durationInFrames, fps: job.fps, width: job.width, height: job.height };
  const comp = await composition(job.composition || "Graphic", inputProps);
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  await R.renderStill({ ...common(), composition: comp, inputProps, output: job.out, frame: job.frame || 0, imageFormat: "png", overwrite: true, ...(job.scale ? { scale: job.scale } : {}) });
  return { out: job.out };
}

process.on("message", async (msg) => {
  const { id, cmd, job } = msg || {};
  try {
    if (cmd === "config") { cfg = { ...cfg, ...job }; process.send({ id, ok: true, result: null }); return; }
    if (cmd === "close") { await browser?.close({ silent: true }).catch(() => {}); server?.close(); process.send({ id, ok: true, result: null }); process.exit(0); }
    await ready();
    const result = cmd === "still" ? await still(job) : await render(job, (p) => process.send({ id, progress: p }));
    process.send({ id, ok: true, result });
  } catch (err) {
    process.send({ id, error: { message: String(err?.message || err), stack: String(err?.stack || "").slice(0, 4000) } });
  }
});
process.on("disconnect", () => { browser?.close({ silent: true }).catch(() => {}).finally(() => process.exit(0)); });
