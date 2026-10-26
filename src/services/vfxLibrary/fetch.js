// Builds (or tops up) the VFX/overlay library from Mixkit (sources.js): reads each category's tag pages, keeps the
// clips whose title says they are overlays (black or green background), downloads the 1080p (else 720p) file into
// <lib>/<category>/, and records where each came from and under which licence in <lib>/sources.json. The index with
// blend modes and contracts is built afterwards by vfxLibraryService.buildIndex (it analyses the pictures).
// Run: node src/services/vfxLibrary/fetch.js "D:\capcut new\assets-library\vfx"
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MIXKIT_VFX, OVERLAY_WORDS, NOT_OVERLAY, PER_CATEGORY, LICENSES } from "./sources.js";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MontajStudio/1.13 personal" };
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

async function download(url, file) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  fs.writeFileSync(part, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(part, file);
}

/** Video cards of a Mixkit tag page: [{ id (the asset id of its files), title, description, page }]. */
export function parseMixkitVideoPage(html) {
  const out = [];
  for (const block of html.split('class="item-grid-card"').slice(1)) {
    const id = /assets\.mixkit\.co\/videos\/(\d+)\/\1-360\.mp4/.exec(block)?.[1];
    const title = /overlay-video-title">([\s\S]*?)<\/span>/.exec(block)?.[1];
    const href = /href="(\/free-stock-video\/[^"]+)"/.exec(block)?.[1];
    if (!id || !title || !href) continue;
    out.push({ id, title: decode(title), description: decode(/overlay-video-description">([\s\S]*?)<\/span>/.exec(block)?.[1] || ""), page: `https://mixkit.co${href}` });
  }
  return out;
}

/** The licence of an item from its page's structured data ("Free" or "Mixkit Restricted License"). */
export function licenseOf(html, id) {
  const block = html.split('"@type":"VideoObject"').find((b) => b.includes(`/${id}/`) || b.includes(`-${id}/`)) || "";
  return /"copyrightNotice":"Mixkit Restricted License"/.test(block) ? "mixkit-restricted" : "mixkit-free";
}

export async function fetchVfx(lib, { log = console.log, perCategory = PER_CATEGORY } = {}) {
  fs.mkdirSync(lib, { recursive: true });
  const srcFile = path.join(lib, "sources.json");
  const prev = fs.existsSync(srcFile) ? JSON.parse(fs.readFileSync(srcFile, "utf8")) : { licenses: LICENSES, items: [] };
  const have = new Set(prev.items.map((i) => i.id));
  for (const [category, tags] of Object.entries(MIXKIT_VFX)) {
    let kept = prev.items.filter((i) => i.category === category).length;
    for (const tag of tags) {
      if (kept >= perCategory) break;
      let cards;
      try { cards = parseMixkitVideoPage(await get(`https://mixkit.co/free-stock-video/${tag}/`)); } catch (e) { log(`mixkit ${tag}: ${e.message}`); continue; }
      const overlays = cards.filter((c) => OVERLAY_WORDS.test(`${c.title} ${c.description}`) && !NOT_OVERLAY.test(`${c.title} ${c.description}`));
      log(`mixkit ${category}/${tag}: ${cards.length} cards, ${overlays.length} overlays`);
      for (const c of overlays) {
        if (kept >= perCategory) break;
        const id = `mixkit-${c.id}`;
        const rel = `${category}/${id}.mp4`;
        if (prev.items.some((i) => i.file === rel)) continue;
        const other = prev.items.find((i) => i.id === id);
        if (other) { // already in another category: a hard link (no second copy on disk)
          try { fs.linkSync(path.join(lib, other.file), path.join(lib, rel)); } catch { fs.copyFileSync(path.join(lib, other.file), path.join(lib, rel)); }
          prev.items.push({ ...other, category, file: rel });
          kept++;
          log(`  = ${rel} (linked) ${c.title}`);
          continue;
        }
        let res = "1080";
        try { await download(`https://assets.mixkit.co/videos/${c.id}/${c.id}-1080.mp4`, path.join(lib, rel)); } catch {
          res = "720";
          try { await download(`https://assets.mixkit.co/videos/${c.id}/${c.id}-720.mp4`, path.join(lib, rel)); } catch (e) { log(`  ${c.id}: ${e.message}`); continue; }
        }
        let license = "mixkit-free";
        try { license = licenseOf(await get(c.page), c.id); } catch { /* keep the page's default */ }
        prev.items.push({ id, category, file: rel, title: c.title, description: c.description, tag, source: "mixkit", license, url: c.page, resolution: res });
        have.add(id);
        kept++;
        log(`  + ${rel} (${license}) ${c.title}`);
        fs.writeFileSync(srcFile, JSON.stringify(prev, null, 1));
      }
    }
  }
  fs.writeFileSync(srcFile, JSON.stringify(prev, null, 1));
  return prev;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  fetchVfx(process.argv[2] || "D:\\capcut new\\assets-library\\vfx").then((r) => console.log(`done: ${r.items.length} clips`)).catch((e) => { console.error(e); process.exit(1); });
}
