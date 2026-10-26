// The sound-effects library: thousands of sounds on disk (sfxLibrary/fetch.js, or the user's own packs imported in
// place), each with Egyptian meaning tags («تريقة»، «صدمة»، «هيصة»…) and English tags, searched by meaning with CLAP
// (text → audio embeddings, LAION larger_clap_general). A request in Egyptian Arabic is expanded to English first
// (sfxLibrary/meaning.js: the tags it names, everyday words; an optional translator for the rest), then:
//   score = 0.05 × the best standardised cosine(query text, sound audio) over the English descriptions + a bonus when
//           the sound carries a meaning tag the request names (by how strongly it carries it) + a small one for its
//           category; sounds the moment's mood forbids
//           (rules.js: no cartoon or comic sound in a serious moment) and sounds used recently are left out / pushed down.
// Files: <dir>/library.json (sounds + their tags), clap_audio.f32 + clap_index.json (the audio embeddings),
// clap_meanings.f32 (the meaning tags' text embeddings). CLAP runs on the CPU for queries (≈1 GB RAM, no GPU lock).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/validation.js";
import { binaries } from "./ffmpeg.js";
import { fetchAll, load, save, walk } from "./sfxLibrary/fetch.js";
import { LIBRARY_CATEGORIES, UCS } from "./sfxLibrary/sources.js";
import { MEANINGS, expandQuery, CATEGORY_MEANINGS, SOURCE_TAG_MEANINGS, CARTOON_SOURCE_TAGS, normalizeAr } from "./sfxLibrary/meaning.js";
import { SFX_RULES, SERIOUS_MOODS, soundAllowed, checkSfxPlan, enforceSfxPlan, moodAt } from "./sfxLibrary/rules.js";
import { mediaRuntime, modelDir, runPy, PyWorker, readF32, cosineAll } from "./sfxLibrary/mediaRuntime.js";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "sfxLibrary").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
const CLAP_PY = path.join(HERE, "clap.py");
export const CLAP_REPO = "laion/larger_clap_general";
const AUDIO_EXT = /\.(wav|mp3|ogg|flac|aif|aiff|m4a)$/i;
const TAG_BONUS = 0.12, CATEGORY_BONUS = 0.03, RECENT_PENALTY = 0.08, PRIOR_Z = 3, CLAP_WEIGHT = 0.05;

/**
 * Meaning tags of every sound from the CLAP scores (sims: sounds × meanings, cosine) and the sounds' own source tags:
 * per meaning the scores are standardised over the library (z), a meaning is given when z ≥ zMin and it is among the
 * sound's best `top`, or when the sound's source/category names it. Pure (tests use small fake matrices).
 */
export function assignMeanings(sounds, sims, { zMin = 1.5, top = 3 } = {}) {
  const M = MEANINGS.length, N = sounds.length;
  const mean = new Float64Array(M), sd = new Float64Array(M);
  for (let j = 0; j < M; j++) {
    let s = 0; for (let i = 0; i < N; i++) s += sims[i * M + j]; mean[j] = s / Math.max(1, N);
    let v = 0; for (let i = 0; i < N; i++) v += (sims[i * M + j] - mean[j]) ** 2; sd[j] = Math.sqrt(v / Math.max(1, N)) || 1;
  }
  const idx = new Map(MEANINGS.map((m, j) => [m.ar, j]));
  return sounds.map((s, i) => {
    const z = MEANINGS.map((_, j) => (sims[i * M + j] - mean[j]) / sd[j]);
    const named = new Set((s.sourceTags || []).flatMap((t) => SOURCE_TAG_MEANINGS[t] || []));
    const prior = new Set([...(CATEGORY_MEANINGS[s.category] || []).slice(0, 1), ...named]);
    const best = z.map((v, j) => [v, j]).sort((a, b) => b[0] - a[0]).slice(0, top).filter(([v]) => v >= zMin).map(([, j]) => MEANINGS[j].ar);
    // A meaning the sound's own source names (Mixkit's "crickets" page → «إحراج») counts as strongly carried.
    const zOf = (t) => Math.max(z[idx.get(t)], named.has(t) ? PRIOR_Z : -Infinity);
    const tags = [...new Set([...prior, ...best])].filter((t) => idx.has(t)).sort((a, b) => zOf(b) - zOf(a));
    const cartoon = (s.sourceTags || []).some((t) => CARTOON_SOURCE_TAGS.has(t)) || (s.category === "comedy" && tags.some((t) => MEANINGS[idx.get(t)].cartoon));
    const comic = cartoon || tags.slice(0, 2).some((t) => MEANINGS[idx.get(t)].mood === "comic");
    const tagsEn = [...new Set(tags.flatMap((t) => MEANINGS[idx.get(t)].en.slice(0, 1)))];
    return { tagsAr: tags, tagsEn, cartoon, comic, z: Object.fromEntries(tags.map((t) => [t, Math.round(zOf(t) * 100) / 100])) };
  });
}

/** Category of a user's file from its UCS CatID ("WHSH_…") or the words of its folders and name. */
export function categoryOfFile(rel) {
  const base = path.basename(rel).replace(/\.[^.]+$/, "");
  const cat = /^([A-Za-z]{2,10})[_\s-]/.exec(base)?.[1];
  if (cat && UCS[cat.toUpperCase()]) return UCS[cat.toUpperCase()];
  if (cat && UCS[cat]) return UCS[cat];
  const words = rel.toLowerCase();
  const rules = [
    [/cartoon|toon|comic|comedy|funny|boing|slide.?whistle|squeak|honk|kazoo/, "comedy"], [/laugh|crowd|applause|cheer|clap|audience|gasp/, "reactions"],
    [/whoosh|swoosh|swish|whip|swipe|woosh/, "whooshes"], [/riser|rise|build|uplift|swell/, "risers"], [/impact|hit|punch|thud|boom|slam|smash|crash|stomp/, "impacts"],
    [/transition|sweep|glitch|zoom|rewind|stutter/, "transitions"], [/ui|click|button|beep|notification|interface|menu|pop|blip|ding/, "ui"],
    [/kitchen|cook|fry|sizzle|chop|knife|plate|pan|pot|eat|drink|pour|food/, "kitchen"], [/magic|sparkle|shimmer|fairy|chime/, "magic"],
    [/drama|horror|suspense|tension|scary|sad|stinger|braam|drone|cinematic/, "drama"],
  ];
  for (const [re, c] of rules) if (re.test(words)) return c;
  return "ui";
}

export class SfxLibraryService {
  /** @param {{ dir: string, userData?: string, log?: Function, translate?: (words: string[]) => Promise<string[]> }} o */
  constructor({ dir, userData = null, log = () => {}, translate = null }) {
    Object.assign(this, { dir, userData, log, translate });
    this.cache = null;   // { sounds, byId, ids, mat, dims }
    this.worker = null;  // CLAP text encoder (serve mode)
  }

  runtime() {
    const rt = mediaRuntime(this.userData);
    const model = rt && modelDir(rt, CLAP_REPO);
    return rt && model ? { ...rt, model } : null;
  }

  status() {
    const sounds = load(this.dir);
    const idx = this.readIndex();
    const bySource = {}, byCategory = {};
    for (const s of sounds) { bySource[s.source] = (bySource[s.source] || 0) + 1; byCategory[s.category] = (byCategory[s.category] || 0) + 1; }
    return { dir: this.dir, sounds: sounds.length, indexed: idx?.ids.length || 0, tagged: sounds.filter((s) => s.tagsAr).length, bySource, byCategory, clap: !!this.runtime() };
  }

  readIndex() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "clap_index.json"), "utf8")); } catch { return null; } }

  /** Download the free sources (resumes; files already there are kept). */
  async fetch({ only } = {}) { const r = await fetchAll(this.dir, { only, log: this.log }); this.cache = null; return { sounds: r.length }; }

  /**
   * A folder of the user's own sounds (BOOM Toons, Sonniss, Freesound or Pixabay downloads…) indexed in place, never
   * copied. Files are entries with an absolute path; their category comes from UCS names or folder words.
   */
  importFolder(folder, { name = path.basename(folder), license = "user" } = {}) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new AppError("IO", "err.fileNotFound", { file: folder });
    const sounds = load(this.dir);
    const have = new Set(sounds.map((s) => s.id));
    let added = 0;
    for (const f of walk(folder).filter((x) => AUDIO_EXT.test(x))) {
      const rel = path.relative(folder, f);
      const id = `user-${crypto.createHash("sha1").update(`${name}|${rel}`).digest("hex").slice(0, 12)}`;
      if (have.has(id)) continue;
      const words = rel.replace(/\.[^.]+$/, "").replace(/[\\/_\-.]+/g, " ").replace(/\s+/g, " ").trim();
      sounds.push({ id, source: "user", pack: name, file: f, abs: true, title: words, category: categoryOfFile(rel), sourceTags: words.toLowerCase().split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w)), license });
      have.add(id); added++;
    }
    save(this.dir, sounds);
    this.cache = null;
    return { added, total: sounds.length };
  }

  /**
   * Embed every sound with CLAP and tag it with Egyptian meanings. `device` "cuda" is quicker for a large library
   * (CLAP holds < 2 GB of GPU memory, below the shared lock's threshold).
   */
  async index({ device = "cpu", onProgress } = {}) {
    const rt = this.runtime();
    if (!rt) throw new AppError("PROVIDER", "err.mediaModelMissing", { model: CLAP_REPO });
    // Imported files live outside the library: index.py reads `file` relative to the library, so abs paths are passed as is.
    const r = await runPy(rt, CLAP_PY, ["index", "--lib", this.dir, "--model", rt.model, "--ffmpeg", binaries().ffmpeg, "--device", device], { onLine: (l) => l.progress != null && onProgress?.(l.progress * 0.9) });
    const idx = this.readIndex();
    const mat = readF32(path.join(this.dir, "clap_audio.f32"));
    // The meanings' text embeddings: the mean of each tag's English descriptions.
    const texts = MEANINGS.flatMap((m) => m.en);
    const { vectors } = await this.textWorker().request({ texts });
    const D = idx.dims, M = MEANINGS.length;
    const tagVec = new Float32Array(M * D);
    let k = 0;
    MEANINGS.forEach((m, j) => {
      for (let e = 0; e < m.en.length; e++, k++) for (let d = 0; d < D; d++) tagVec[j * D + d] += vectors[k][d] / m.en.length;
      let n = 0; for (let d = 0; d < D; d++) n += tagVec[j * D + d] ** 2; n = Math.sqrt(n) || 1;
      for (let d = 0; d < D; d++) tagVec[j * D + d] /= n;
    });
    fs.writeFileSync(path.join(this.dir, "clap_meanings.f32"), Buffer.from(tagVec.buffer));
    const sounds = load(this.dir);
    const pos = new Map(idx.ids.map((id, i) => [id, i]));
    const indexed = sounds.filter((s) => pos.has(s.id));
    const sims = new Float32Array(indexed.length * M);
    indexed.forEach((s, i) => { const row = mat.subarray(pos.get(s.id) * D, pos.get(s.id) * D + D); for (let j = 0; j < M; j++) { let v = 0; for (let d = 0; d < D; d++) v += row[d] * tagVec[j * D + d]; sims[i * M + j] = v; } });
    const tags = assignMeanings(indexed, sims);
    indexed.forEach((s, i) => { Object.assign(s, tags[i], { stats: idx.meta[s.id] ? { durationS: idx.meta[s.id].durationS, peakDb: idx.meta[s.id].peakDb, rmsDb: idx.meta[s.id].rmsDb, accentS: idx.meta[s.id].accentS } : null }); });
    save(this.dir, sounds);
    this.cache = null;
    onProgress?.(1);
    return { indexed: idx.ids.length, failed: idx.failed?.length || 0, tagged: indexed.length, seconds: r?.seconds };
  }

  textWorker() {
    if (!this.worker) {
      const rt = this.runtime();
      if (!rt) throw new AppError("PROVIDER", "err.mediaModelMissing", { model: CLAP_REPO });
      this.worker = new PyWorker(rt, CLAP_PY, ["serve", "--model", rt.model, "--device", "cpu"], { log: this.log });
    }
    return this.worker;
  }

  close() { this.worker?.stop(); this.worker = null; }

  loadCache() {
    if (this.cache) return this.cache;
    const sounds = load(this.dir);
    const idx = this.readIndex();
    const byId = new Map(sounds.map((s) => [s.id, s]));
    let mat = null;
    try { mat = readF32(path.join(this.dir, "clap_audio.f32")); } catch { /* not indexed: tag search only */ }
    this.cache = { sounds, byId, ids: idx?.ids || [], dims: idx?.dims || 512, mat };
    return this.cache;
  }

  /** The file of a sound (absolute path). */
  fileOf(s) { return s.abs ? s.file : path.join(this.dir, s.file); }

  /**
   * Search by meaning. `query`: Egyptian Arabic or English («صوت تريقة لما حد يقع», "door slam"). Options: `mood` of the
   * moment (rules.js — forbidden sounds are left out), `category`, `limit`, `recent` (ids used lately: pushed down),
   * `exclude` (ids never returned), `textVectors` (precomputed query embeddings, for tests).
   * Returns { query, expanded, results: [{ id, title, file, category, tagsAr, tagsEn, cartoon, comic, score, why, leadUs }] }.
   */
  async search(query, { mood = "neutral", category = null, limit = 10, recent = [], exclude = [], textVectors = null } = {}) {
    const c = this.loadCache();
    const ex = expandQuery(query);
    if (ex.unknown.length && this.translate) { try { ex.en.push(...(await this.translate(ex.unknown))); } catch (e) { this.log("sfx: translate failed", e.message); } }
    const texts = ex.en.length ? ex.en : [query];
    let vecs = textVectors;
    if (!vecs && c.mat) vecs = (await this.textWorker().request({ texts })).vectors;
    // CLAP: per description, the cosine standardised over the library (a generic description is close to many sounds,
    // a precise one to few: z makes them comparable), the best description per sound.
    const clap = new Map();
    if (vecs && c.mat) {
      for (const v of vecs) {
        const s = cosineAll(c.mat, c.dims, v);
        let m = 0; for (const x of s) m += x; m /= s.length || 1;
        let sd = 0; for (const x of s) sd += (x - m) ** 2; sd = Math.sqrt(sd / (s.length || 1)) || 1;
        c.ids.forEach((id, i) => { const z = (s[i] - m) / sd; if (!clap.has(id) || clap.get(id) < z) clap.set(id, z); });
      }
    }
    const wantTags = new Set(ex.tags.map((i) => MEANINGS[i].ar));
    // A comic meaning asked for a serious moment: nothing (the rules would drop it anyway; say why instead).
    if (ex.tags.length && SERIOUS_MOODS.has(mood) && ex.tags.every((i) => MEANINGS[i].mood === "comic" || MEANINGS[i].cartoon)) {
      return { query, expanded: { tags: [...wantTags], en: texts, unknown: ex.unknown }, results: [], blocked: "comic-in-serious" };
    }
    const wantCats = new Set(ex.tags.flatMap((i) => Object.entries(CATEGORY_MEANINGS).filter(([, t]) => t.includes(MEANINGS[i].ar)).map(([k]) => k)));
    const recentSet = new Set(recent), exSet = new Set(exclude);
    const q = normalizeAr(query);
    const out = [];
    for (const s of c.sounds) {
      if (exSet.has(s.id) || (category && s.category !== category)) continue;
      if (!soundAllowed(s, mood).ok) continue;
      const tagHits = (s.tagsAr || []).filter((t) => wantTags.has(t));
      let score = CLAP_WEIGHT * (clap.get(s.id) ?? -3);
      if (!clap.size) score = (s.title || "").toLowerCase().includes(q) ? 0.3 : 0; // no index: words only
      // A named meaning the sound carries counts by how strongly it carries it (its z over the library, capped).
      const tagScore = tagHits.slice(0, 2).reduce((a, t) => a + TAG_BONUS * (0.5 + Math.min(4, Math.max(0, s.z?.[t] ?? 1.5)) / 4), 0);
      score += tagScore + (wantCats.has(s.category) ? CATEGORY_BONUS : 0) - (recentSet.has(s.id) ? RECENT_PENALTY : 0);
      if (score <= 0.05) continue; // below ~1 standard deviation and no meaning: not a match
      out.push({ s, score, tagHits });
    }
    out.sort((a, b) => b.score - a.score);
    return {
      query, expanded: { tags: [...wantTags], en: texts, unknown: ex.unknown },
      results: out.slice(0, limit).map(({ s, score, tagHits }) => ({
        id: s.id, title: s.title, file: this.fileOf(s), source: s.source, license: s.license, category: s.category, tagsAr: s.tagsAr || [], tagsEn: s.tagsEn || [],
        cartoon: !!s.cartoon, comic: !!s.comic, score: Math.round(score * 1000) / 1000, durationS: s.stats?.durationS ?? null,
        leadUs: Math.round((s.stats?.accentS ?? 0) * 1e6), why: tagHits.length ? `tags: ${tagHits.join("، ")}` : "CLAP",
      })),
    };
  }

  /** Rules for the director: is this plan of sounds within the limits? (ids → the library's cartoon/comic flags) */
  checkPlan(events, { moments = [] } = {}) {
    const c = this.loadCache();
    const ev = events.map((e) => ({ ...e, sound: e.sound?.id ? e.sound : { id: e.soundId, ...(c.byId.get(e.soundId) || {}) } }));
    return { violations: checkSfxPlan(ev, { moments }), ...enforceSfxPlan(ev, { moments }) };
  }
}

/** Tool definitions the director (an LLM) can call; handlers map them onto a SfxLibraryService. */
export const SFX_TOOLS = [
  {
    name: "sfx_search",
    description: "Find sound effects by the MEANING of the moment, in Egyptian Arabic or English (e.g. «تريقة»، «صدمة»، «يا نهار أبيض»، «هيصة»، «باب بيتقفل»). Pass the moment's mood: comic/cartoon sounds are never returned for serious, sad, emotional, religious or tense moments.",
    input_schema: { type: "object", properties: { query: { type: "string" }, mood: { type: "string", enum: ["comic", "joy", "shock", "neutral", "tense", "serious", "sad", "emotional", "religious"] }, category: { type: "string", enum: LIBRARY_CATEGORIES }, limit: { type: "integer", minimum: 1, maximum: 30 } }, required: ["query"] },
  },
  {
    name: "sfx_check_plan",
    description: `Check a plan of sound effects against the limits: no cartoon or comic sound in serious moments, at most ${SFX_RULES.comicPerMin} comic sounds a minute and ${SFX_RULES.comicMinGapS} s between them, any two sounds ${SFX_RULES.anyMinGapS} s apart, at most ${SFX_RULES.anyPerMin} a minute. Returns the violations and the plan with the offending sounds dropped (higher priority kept first).`,
    input_schema: { type: "object", properties: { events: { type: "array", items: { type: "object", properties: { atUs: { type: "integer" }, soundId: { type: "string" }, priority: { type: "number" } }, required: ["atUs", "soundId"] } }, moments: { type: "array", items: { type: "object", properties: { startUs: { type: "integer" }, endUs: { type: "integer" }, mood: { type: "string" } } } } }, required: ["events"] },
  },
];

export function sfxToolHandlers(lib) {
  return {
    sfx_search: (a) => lib.search(a.query, { mood: a.mood, category: a.category, limit: a.limit }),
    sfx_check_plan: (a) => lib.checkPlan(a.events, { moments: a.moments }),
  };
}

export { moodAt, SFX_RULES };
