// The VFX/overlay library (plan item 10): ready-made effect clips (smoke, fire, sparks, confetti, light leaks, glitches…)
// on disk under D:\capcut new\assets-library\vfx\<category>\ (comedy, drama, action, kitchen, transitions; never in
// git), an index with each clip's measured properties and its contract — when to use it, how long, and how to blend
// it over the picture — and a deterministic pick by the same need tags the graphics selection uses.
// Blend: a clip on a black background is screened (or added, for light sources: fire, sparks, explosions — their
// cores burn to white like real light); a clip on a green background is keyed (chroma); a clip with an alpha channel
// is laid as it is; anything else is footage (a transition or B-roll, not an overlay).
// Clips come from vfxLibrary/fetch.js (Mixkit, no account) or the user's own files dropped into a category folder.
import fs from "node:fs";
import path from "node:path";
import { ffprobe, binaries, run } from "./ffmpeg.js";
import { LICENSES } from "./vfxLibrary/sources.js";
import { EMOJI_DIR, lottieFor, animatedFor, emojiCode } from "../graphics/emoji.js";

export const DEFAULT_VFX_DIR = process.env.MONTAJ_VFX_DIR || "D:\\capcut new\\assets-library\\vfx";
export const VFX_CATEGORIES = ["comedy", "drama", "action", "kitchen", "transitions"];
const VIDEO = /\.(mp4|mov|webm|mkv|m4v)$/i;
const US = 1_000_000;

/** What a clip is for, from its words (title, tag, file name): need tags, energy (1–5) and whether it is a light. */
const KINDS = [
  { re: /explo|blast|boom/i, tags: ["peak", "surprise", "reaction"], energy: 5, light: true },
  { re: /fire|flame|bonfire|lava|burn/i, tags: ["reaction", "peak", "food"], energy: 4, light: true },
  { re: /spark|ember|firework/i, tags: ["celebrate", "surprise", "reaction"], energy: 4, light: true },
  { re: /confetti|balloon|celebrat|party/i, tags: ["celebrate"], energy: 4, light: false },
  { re: /glitch|static|noise|vhs/i, tags: ["transition", "surprise", "flashback"], energy: 4, light: false },
  { re: /lightning|thunder|storm/i, tags: ["peak", "mood", "surprise"], energy: 5, light: true },
  { re: /light leak|leak|lens flare|flare|bokeh|light/i, tags: ["transition", "memory", "mood"], energy: 2, light: true },
  { re: /ink|paint|splash/i, tags: ["transition", "title"], energy: 3, light: false },
  { re: /steam|vapou?r|flour|cook|kitchen/i, tags: ["food"], energy: 2, light: false },
  { re: /smoke|fog|mist|dust/i, tags: ["mood", "memory", "peak"], energy: 2, light: false },
  { re: /rain|snow|drop/i, tags: ["mood", "weather"], energy: 1, light: false },
  { re: /bubble|star|particle|glitter|magic/i, tags: ["celebrate", "mood", "reaction"], energy: 3, light: true },
];
export function kindOf(words) {
  return KINDS.find((k) => k.re.test(words)) || { tags: ["mood"], energy: 2, light: false };
}

/**
 * Background of a clip from small sample frames (raw RGB): black (dark borders and a dark majority), green (green
 * borders), or footage. Returns { bg, darkShare, greenShare, key } (key: the measured green, for the chroma key).
 */
export function classifyBackground(frames, w, h, { saysBlack = false } = {}) {
  let border = 0, dark = 0, green = 0, total = 0, gr = 0, gg = 0, gb = 0, gn = 0, bdark = 0, bwhite = 0;
  for (const f of frames) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, r = f[i], g = f[i + 1], b = f[i + 2];
      const edge = x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total++;
      if (lum < 28) dark++;
      if (edge) {
        border++;
        if (lum < 32) bdark++;
        if (lum > 225) bwhite++;
        if (g > 90 && g > r * 1.35 && g > b * 1.35) { green++; gr += r; gg += g; gb += b; gn++; }
      }
    }
  }
  const darkShare = dark / Math.max(1, total), greenShare = green / Math.max(1, border);
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  const borderDark = bdark / Math.max(1, border), borderWhite = bwhite / Math.max(1, border);
  if (greenShare > 0.6) return { bg: "green", darkShare, greenShare, key: `#${hex(gr / gn)}${hex(gg / gn)}${hex(gb / gn)}` };
  // Black: a dark majority, or dark borders (big bright smoke fills the middle but the frame's edges stay black).
  // The source's own words ("on a black background") settle a clip whose effect fills much of the frame.
  if (darkShare > 0.45 || (borderDark > 0.6 && darkShare > 0.2) || (saysBlack && (darkShare > 0.08 || borderDark > 0.25))) return { bg: "black", darkShare, greenShare, borderDark };
  if (borderWhite > 0.6) return { bg: "white", darkShare, greenShare, borderWhite }; // ink on paper: multiplied
  return { bg: "footage", darkShare, greenShare, borderDark };
}

/** Blend mode of a clip over the picture (transform.blend), from its background and kind. */
export const blendOf = (bg, kind, hasAlpha) => (hasAlpha ? "normal" : bg === "black" ? (kind.light ? "add" : "screen") : bg === "white" ? "multiply" : "normal");

/** Sample frames of a clip as raw RGB (w×h), n frames spread over its length. */
async function sampleFrames(file, durationUs, { w = 64, h = 36, n = 5 } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = ((k + 0.5) / n) * Math.max(0.2, durationUs / US);
    const tmp = path.join(path.dirname(file), `.vfx-sample-${process.pid}-${k}.rgb`);
    try {
      await run(binaries().ffmpeg, ["-hide_banner", "-v", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", tmp], { timeoutMs: 60_000 });
      if (fs.existsSync(tmp)) out.push(fs.readFileSync(tmp));
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  return out;
}

export class VfxLibraryService {
  constructor({ root = DEFAULT_VFX_DIR, repos = null } = {}) {
    this.root = root;
    this.repos = repos;
    this.index = null;
  }

  indexPath() { return path.join(this.root, "index.json"); }

  /** The index ({ version, root, licenses, items }) — built if missing. */
  async load() {
    if (this.index) return this.index;
    if (fs.existsSync(this.indexPath())) { this.index = JSON.parse(fs.readFileSync(this.indexPath(), "utf8")); return this.index; }
    return this.buildIndex();
  }

  /**
   * Scan the category folders (fetched clips and the user's own), probe and classify every clip, write index.json.
   * Unchanged files keep their entries (by size and modification time), so a re-scan is quick.
   */
  async buildIndex({ log = () => {} } = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    const sources = fs.existsSync(path.join(this.root, "sources.json")) ? JSON.parse(fs.readFileSync(path.join(this.root, "sources.json"), "utf8")).items : [];
    const bySrc = new Map(sources.map((s) => [s.file.replace(/\\/g, "/"), s]));
    const old = fs.existsSync(this.indexPath()) ? JSON.parse(fs.readFileSync(this.indexPath(), "utf8")) : { items: [] };
    const prev = new Map(old.items.map((i) => [i.file, i]));
    const items = [];
    for (const category of VFX_CATEGORIES) {
      const dir = path.join(this.root, category);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of fs.readdirSync(dir).filter((f) => VIDEO.test(f) && !f.endsWith(".part")).sort()) {
        const rel = `${category}/${name}`, file = path.join(dir, name), st = fs.statSync(file);
        const p = prev.get(rel);
        if (p && p.sizeBytes === st.size && p.mtimeMs === Math.round(st.mtimeMs)) { items.push(p); continue; }
        try {
          const info = await ffprobe(file);
          const v = info.streams.find((s) => s.codec_type === "video");
          if (!v) continue;
          const durationUs = Math.round(Number(info.format.duration) * US);
          const src = bySrc.get(rel);
          const words = `${src?.title || ""} ${src?.description || ""} ${src?.tag || ""} ${name}`;
          const kind = kindOf(words);
          const hasAlpha = /yuva|rgba|argb|bgra/.test(v.pix_fmt || "");
          const saysBlack = /black (back(ground|drop)|surface|sky)|dark background|against (a )?black|on black/i.test(words) && !/glass|wine|champagne/i.test(words);
          const cls = hasAlpha ? { bg: "alpha" } : classifyBackground(await sampleFrames(file, durationUs), 64, 36, { saysBlack });
          const blend = blendOf(cls.bg, kind, hasAlpha);
          const [fn, fd] = String(v.r_frame_rate || "30/1").split("/").map(Number);
          items.push({
            id: `${category}/${src?.id || `user-${name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-")}`}`, category, file: rel,
            title: src?.title || name.replace(/\.[^.]+$/, ""), source: src?.source || "user", license: src?.license || "user", url: src?.url || "",
            durationUs, width: v.width, height: v.height, fps: fd ? Math.round((fn / fd) * 100) / 100 : 30, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs),
            background: cls.bg, blend, overlay: cls.bg !== "footage", ...(cls.key ? { chroma: { color: cls.key } } : {}),
            contract: { tags: [...new Set([...kind.tags, ...(category === "transitions" ? ["transition"] : []), ...(category === "kitchen" ? ["food"] : [])])], minSec: 0.5, maxSec: Math.max(0.5, durationUs / US), energy: kind.energy, region: "full", loop: cls.bg !== "footage" },
          });
          log(`${rel}: ${cls.bg} → ${blend}`);
        } catch (e) { log(`${rel}: ${e.message}`); }
      }
    }
    this.index = { version: 1, root: this.root, licenses: LICENSES, categories: VFX_CATEGORIES, items };
    fs.writeFileSync(this.indexPath(), JSON.stringify(this.index, null, 1));
    return this.index;
  }

  /** Full path of an item. */
  file(item) { return path.join(this.root, ...item.file.split("/")); }

  /**
   * The best clips for a need: overlays only (unless footage is asked for), sharing a tag, energy close, long enough
   * (or loopable), in the category if one is given, not one of `avoid` (recently used). Deterministic ranking.
   */
  async pick({ tags = [], category = null, energy = 3, durationSec = 1, avoid = [], footage = false, limit = 3 } = {}) {
    const idx = await this.load();
    const scored = [];
    for (const it of idx.items) {
      if (!footage && !it.overlay) continue;
      if (category && it.category !== category) continue;
      if (avoid.includes(it.id)) continue;
      const shared = it.contract.tags.filter((t) => tags.includes(t));
      if (tags.length && !shared.length) continue;
      if (!it.contract.loop && it.durationUs / US < durationSec) continue;
      if (Math.abs(it.contract.energy - energy) > 2) continue;
      const score = shared.length * 2 - Math.abs(it.contract.energy - energy) * 0.5 + (it.license === "mixkit-free" ? 0.2 : 0) + (it.width >= 1080 || it.height >= 1080 ? 0.3 : 0);
      scored.push({ item: it, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, limit).map((s) => s.item);
  }

  /** The segment patch that lays a clip over the picture: its blend mode, or a chroma key for green backgrounds. */
  segmentPatch(item) {
    if (item.background === "green") return { transform: { blend: "normal" }, videoFx: { chroma: { enabled: true, color: item.chroma?.color || "#00FF00", intensity: 40, shadow: 20 } } };
    return { transform: { blend: item.blend } };
  }

  /**
   * The pack's emoji family in the app's library (kind "emoji": Lottie JSON and transparent videos), so graphics can
   * point at them as media://lib/<id> — loadable by the editor's Player and served to the render the same way.
   */
  registerEmoji(repos = this.repos, dir = EMOJI_DIR) {
    if (!repos) return 0;
    const known = new Set(repos.library.list({ kind: "emoji" }).map((i) => i.path));
    let n = 0;
    for (const [sub, re] of [["noto-lottie", /\.json$/i], ["animated-webm", /\.webm$/i]]) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => re.test(x))) {
        const file = path.join(d, f);
        if (known.has(file)) continue;
        repos.library.add({ kind: "emoji", category: sub, name: f.replace(/\.[^.]+$/, ""), path: file, sizeBytes: fs.statSync(file).size, meta: { family: "noto-animated", license: "CC BY 4.0 (Google)" } });
        n++;
      }
    }
    return n;
  }

  /** media://lib/<id> of an emoji's Lottie (or its video with video: true), registering the family first; null when missing. */
  emojiRef(ch, { video = false } = {}, repos = this.repos) {
    const file = video ? animatedFor(ch)?.file : lottieFor(ch);
    if (!file) return null;
    if (!repos) return file;
    let item = repos.library.list({ kind: "emoji" }).find((i) => i.path === file);
    if (!item) { this.registerEmoji(repos); item = repos.library.list({ kind: "emoji" }).find((i) => i.path === file); }
    return item ? `media://lib/${item.id}` : file;
  }

  /** Put the clips in the app's library (kind "vfx") so the editor can show and place them (media://lib/<id>). */
  registerInLibrary(repos = this.repos) {
    if (!repos || !this.index) return 0;
    const known = new Set(repos.library.list({ kind: "vfx" }).map((i) => i.path));
    let n = 0;
    for (const it of this.index.items) {
      const file = this.file(it);
      if (known.has(file)) continue;
      repos.library.add({ kind: "vfx", category: it.category, name: it.title.slice(0, 100) || it.id, path: file, durationUs: it.durationUs, sizeBytes: it.sizeBytes, meta: { id: it.id, blend: it.blend, background: it.background, chroma: it.chroma || null, contract: it.contract, license: it.license, source: it.source, url: it.url } });
      n++;
    }
    return n;
  }
}

export { emojiCode };
