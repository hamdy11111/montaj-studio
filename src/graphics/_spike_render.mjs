import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";
import { browserPath } from "./setup.js";
const [serveUrl, out, codec = "prores", conc = "8", frames = "900"] = process.argv.slice(2);
const browserExecutable = browserPath();
const t0 = Date.now();
const browser = await openBrowser("chrome", { browserExecutable, chromiumOptions: { gl: "angle" } });
const comp = await selectComposition({ serveUrl, id: "Spike", inputProps: {}, puppeteerInstance: browser, browserExecutable });
const t1 = Date.now();
await renderMedia({ serveUrl, composition: { ...comp, durationInFrames: Number(frames) }, outputLocation: out, puppeteerInstance: browser, browserExecutable,
  codec, ...(codec === "prores" ? { proResProfile: "4444", pixelFormat: "yuva444p10le", imageFormat: "png" } : codec === "vp9" ? { pixelFormat: "yuva420p", imageFormat: "png" } : {}),
  concurrency: Number(conc), chromiumOptions: { gl: "angle" } });
console.log(JSON.stringify({ codec, conc, frames, openMs: t1 - t0, renderMs: Date.now() - t1 }));
await browser.close({ silent: true });
