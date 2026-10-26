// Builds (or tops up) the sound-effects library from the sources that need no account (sources.js): Mixkit category
// pages, Kenney's CC0 packs and the @remotion/sfx sounds. Files land under <library>/files/<source>/ and every sound is
// an entry of <library>/library.json; a file already there is not fetched again, so the command can be run again to
// resume. Meaning tags and the CLAP index are made afterwards (sfxLibrary.js → index()).
//   node src/services/sfxLibrary/fetch.js "D:\capcut new\assets-library\sfx" [--only mixkit,kenney,remotion]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MIXKIT, MIXKIT_PAGES, KENNEY, REMOTION, REMOTION_BASE, LICENSES } from "./sources.js";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MontajStudio/1.13 (personal sound library)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { tries = 3, binary = false } = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1500 * i);
    }
  }
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = await get(url, { binary: true });
  fs.writeFileSync(`${file}.part`, buf);
  fs.renameSync(`${file}.part`, file);
  return true;
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** The sound cards of one Mixkit category page: [{ id, title, tags }]. */
export function parseMixkitPage(html) {
  const out = [];
  const parts = html.split('data-controller="audio-player"').slice(1);
  for (const p of parts) {
    const id = /data-audio-player-item-id-value="(\d+)"/.exec(p)?.[1];
    const title = /item-grid-card__title">\s*([^<]+?)\s*<\/h2>/.exec(p)?.[1];
    if (!id || !title) continue;
    const meta = p.slice(0, p.indexOf("item-grid-sfx-preview__meta-time") + 1 || undefined);
    const tags = [...meta.matchAll(/href="\/free-sound-effects\/([a-z-]+)\/">/g)].map((m) => m[1]);
    out.push({ id, title: decode(title), tags: [...new Set(tags)] });
  }
  return out;
}

async function mixkit(lib, entries, log) {
  const seen = new Set(entries.filter((e) => e.source === "mixkit").map((e) => e.id));
  for (const [category, pages] of Object.entries(MIXKIT)) {
    for (const page of pages) {
      for (let n = 1; n <= MIXKIT_PAGES; n++) {
        const url = `https://mixkit.co/free-sound-effects/${page}/${n > 1 ? `?page=${n}` : ""}`;
        let cards;
        try { cards = parseMixkitPage(await get(url)); } catch (e) { log(`mixkit ${page} p${n}: ${e.message}`); break; }
        if (!cards.length) break;
        let fresh = 0;
        for (const c of cards) {
          const id = `mixkit-${c.id}`;
          if (seen.has(id)) { const e = entries.find((x) => x.id === id); if (e) e.sourceTags = [...new Set([...e.sourceTags, page, ...c.tags])]; continue; }
          // The WAV; a few sounds refuse it (403) and only have the MP3 preview, which is the same sound.
          let rel = `files/mixkit/${c.id}.wav`;
          try { await download(`https://assets.mixkit.co/active_storage/sfx/${c.id}/${c.id}.wav`, path.join(lib, rel)); } catch {
            rel = `files/mixkit/${c.id}.mp3`;
            try { await download(`https://assets.mixkit.co/active_storage/sfx/${c.id}/${c.id}-preview.mp3`, path.join(lib, rel)); } catch (e) { log(`mixkit ${c.id}: ${e.message}`); continue; }
          }
          seen.add(id); fresh++;
          entries.push({ id, source: "mixkit", file: rel, title: c.title, category, sourceTags: [...new Set([page, ...c.tags])], license: "mixkit", url: `https://mixkit.co/free-sound-effects/${page}/` });
        }
        log(`mixkit ${category}/${page} p${n}: ${cards.length} cards, ${fresh} new (${entries.length} total)`);
        if (cards.length < 30) break; // the last page
        await sleep(400);
      }
    }
    save(lib, entries);
  }
}

async function kenney(lib, entries, log) {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "unzip";
  for (const { pack, category } of KENNEY) {
    const dir = path.join(lib, "files", "kenney", pack);
    if (!fs.existsSync(dir)) {
      const page = await get(`https://kenney.nl/assets/${pack}`);
      const zip = /https:\/\/kenney\.nl\/media\/pages\/assets\/[^"]+\.zip/.exec(page)?.[0];
      if (!zip) { log(`kenney ${pack}: no zip link`); continue; }
      const tmp = path.join(lib, "files", "kenney", `${pack}.zip`);
      await download(zip, tmp);
      fs.mkdirSync(dir, { recursive: true });
      const r = process.platform === "win32" ? spawnSync(tar, ["-xf", tmp, "-C", dir], { encoding: "utf8" }) : spawnSync("unzip", ["-o", "-q", tmp, "-d", dir], { encoding: "utf8" });
      if (r.status !== 0) { log(`kenney ${pack}: unzip failed ${r.stderr}`); fs.rmSync(dir, { recursive: true, force: true }); continue; }
      fs.rmSync(tmp, { force: true });
    }
    const files = walk(dir).filter((f) => /\.(ogg|wav|mp3)$/i.test(f));
    let fresh = 0;
    for (const f of files) {
      const rel = path.relative(lib, f).replace(/\\/g, "/");
      const id = `kenney-${pack}-${path.basename(f).replace(/\.[^.]+$/, "")}`.toLowerCase();
      if (entries.some((e) => e.id === id)) continue;
      const words = path.basename(f).replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").replace(/\d+/g, "").trim();
      entries.push({ id, source: "kenney", file: rel, title: words, category, sourceTags: [pack, ...words.toLowerCase().split(" ").filter(Boolean)], license: "kenney", url: `https://kenney.nl/assets/${pack}` });
      fresh++;
    }
    log(`kenney ${pack}: ${files.length} files, ${fresh} new`);
    save(lib, entries);
  }
}

async function remotion(lib, entries, log) {
  for (const [name, [category, what]] of Object.entries(REMOTION)) {
    const id = `remotion-${name}`;
    if (entries.some((e) => e.id === id)) continue;
    const rel = `files/remotion/${name}.wav`;
    try { await download(`${REMOTION_BASE}/${name}.wav`, path.join(lib, rel)); } catch (e) { log(`remotion ${name}: ${e.message}`); continue; }
    entries.push({ id, source: "remotion", file: rel, title: what, category, sourceTags: [name, ...what.split(/[ ,]+/)], license: "remotion", url: `${REMOTION_BASE}/${name}.wav` });
  }
  log(`remotion: ${entries.filter((e) => e.source === "remotion").length} sounds`);
  save(lib, entries);
}

export const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

export function load(lib) {
  try { return JSON.parse(fs.readFileSync(path.join(lib, "library.json"), "utf8")).sounds || []; } catch { return []; }
}
export function save(lib, sounds) {
  const file = path.join(lib, "library.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, licenses: LICENSES, sounds }, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

export async function fetchAll(lib, { only = ["remotion", "kenney", "mixkit"], log = console.log } = {}) {
  fs.mkdirSync(lib, { recursive: true });
  const entries = load(lib);
  if (only.includes("remotion")) await remotion(lib, entries, log);
  if (only.includes("kenney")) await kenney(lib, entries, log);
  if (only.includes("mixkit")) await mixkit(lib, entries, log);
  save(lib, entries);
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lib = process.argv[2];
  if (!lib) { console.error("usage: fetch.js <library dir> [--only a,b]"); process.exit(1); }
  const i = process.argv.indexOf("--only");
  const only = i > 0 ? process.argv[i + 1].split(",") : undefined;
  fetchAll(lib, { only }).then((e) => console.log(`done: ${e.length} sounds`), (e) => { console.error(e); process.exit(1); });
}
