// Developer tool: resolves sources.js into catalog.json — every file of every AI-layer model set pinned to a commit of
// its official source, with its size and SHA-256 — and proves each pin against the copy already on this PC:
//   Hugging Face  the tree of the pinned commit: an LFS file's published SHA-256, or a small file's git blob id
//                 (sha1 of "blob <size>\0" + content) must equal the local file's. "main" is resolved to its commit;
//                 when main moved on, older commits are tried until every file matches.
//   GitHub        the same through the git trees API (gh); git LFS pointers are read for their SHA-256
//   zenodo        the record's published MD5; Google's model store: the x-goog-hash MD5 of the object
//   archives      downloaded once into a scratch folder, unpacked, each member compared, the folder removed
//   derived       hashed locally (made on this PC; the catalog says how)
// Usage: node src/services/aiSetup/buildCatalog.mjs <runtime dir> [--scratch <dir>] [--only perception,takes]
// Writes src/services/aiSetup/catalog.json and prints every mismatch (a mismatch fails the run).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SOURCES } from "./sources.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const RUNTIME = path.resolve(args[0] || path.join(HERE, "..", "..", "..", "runtime"));
const SCRATCH = path.resolve(opt("--scratch") || path.join(os.tmpdir(), "ai-setup-catalog"));
const ONLY = opt("--only")?.split(",") || null;
const HASHES = path.join(SCRATCH, "hashes.json");
fs.mkdirSync(SCRATCH, { recursive: true });
const hashCache = (() => { try { return JSON.parse(fs.readFileSync(HASHES, "utf8")); } catch { return {}; } })();

/** sha256, md5 and the git blob id of a file in one read (cached by path + size + mtime). */
async function hashes(file) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (hashCache[key]) return hashCache[key];
  const s256 = crypto.createHash("sha256"), md5 = crypto.createHash("md5"), git = crypto.createHash("sha1");
  git.update(`blob ${st.size}\0`);
  await new Promise((resolve, reject) => fs.createReadStream(file, { highWaterMark: 8 << 20 }).on("data", (d) => { s256.update(d); md5.update(d); git.update(d); }).on("error", reject).on("end", resolve));
  const h = { size: st.size, sha256: s256.digest("hex"), md5: md5.digest("hex"), git: git.digest("hex") };
  hashCache[key] = h;
  fs.writeFileSync(HASHES, JSON.stringify(hashCache));
  return h;
}

const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return { body: await r.json(), link: r.headers.get("link") }; };
const gh = (p) => { const r = spawnSync("gh", ["api", p], { encoding: "utf8", maxBuffer: 256 << 20 }); if (r.status !== 0) throw new Error(`gh api ${p}: ${r.stderr}`); return JSON.parse(r.stdout); };

/** A repo in the user's Hugging Face cache (for `local: "hf-cache"`): its newest snapshot and its blobs folder. */
function hfCache(repo) {
  const base = path.join(process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface"), "hub", `models--${repo.replace("/", "--")}`);
  const snaps = fs.readdirSync(path.join(base, "snapshots"));
  return { rev: snaps[0], snapshot: path.join(base, "snapshots", snaps[0]), blobs: path.join(base, "blobs") };
}

/** git's blob id of the LFS pointer of a file (a gated repo hides the LFS SHA-256 but not the pointer's id). */
const lfsPointerId = (sha256, size) => {
  const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${size}\n`;
  return crypto.createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
};

/** Every file under `dir` (relative, forward slashes), skipping .cache/ and .gitattributes. */
function listFiles(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === ".cache" || e.name === ".gitattributes" || e.name.endsWith(".part")) continue;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

async function hfTree(repo, sha) {
  const out = [];
  let url = `https://huggingface.co/api/models/${repo}/tree/${sha}?recursive=true`;
  while (url) {
    const { body, link } = await json(url);
    out.push(...body);
    url = /<([^>]+)>;\s*rel="next"/.exec(link || "")?.[1] || null;
  }
  return new Map(out.filter((e) => e.type === "file").map((e) => [e.path, e]));
}

async function resolveHf(s, localDir) {
  // From the Hugging Face cache: the snapshot's files, or (when the snapshot folder was emptied) the blobs they name.
  if (s.local === "hf-cache") {
    const c = hfCache(s.hf);
    const tree = await hfTree(s.hf, c.rev);
    const out = [];
    for (const [f, e] of tree) {
      if (f === ".gitattributes") continue;
      const p = [path.join(c.snapshot, f), path.join(c.blobs, e.lfs?.oid || e.oid)].find((x) => fs.existsSync(x));
      if (!p) throw new Error(`${s.hf}/${f}: not in the cache`);
      const h = await hashes(p);
      if (e.lfs ? e.lfs.oid !== h.sha256 : e.oid !== h.git) throw new Error(`${s.hf}/${f}: the cached file differs from ${c.rev.slice(0, 7)}`);
      out.push({ rel: f, size: h.size, sha256: h.sha256, git: e.lfs ? undefined : e.oid, url: `https://huggingface.co/${s.hf}/resolve/${c.rev}/${f}`, source: `huggingface.co/${s.hf}@${c.rev.slice(0, 7)}` });
    }
    return { rev: c.rev, files: out };
  }
  const files = s.files === "all" ? listFiles(localDir) : s.files;
  const local = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await hashes(path.join(localDir, f))])));
  const head = (await json(`https://huggingface.co/api/models/${s.hf}/revision/${s.rev}`)).body.sha;
  let commits = [head];
  if (s.rev === "main") {
    try { commits = [head, ...(await json(`https://huggingface.co/api/models/${s.hf}/commits/main`)).body.map((c) => c.id).filter((c) => c !== head).slice(0, 30)]; } catch { /* gated or old API: head only */ }
  }
  let firstBad = null;
  for (const sha of commits) {
    const tree = await hfTree(s.hf, sha);
    const bad = [], out = [];
    for (const f of files) {
      const e = tree.get(f), h = local[f];
      if (!e) { bad.push(`${f}: not in ${sha.slice(0, 7)}`); continue; }
      const masked = e.lfs && /^\*+$/.test(e.lfs.oid); // gated repo: compare the pointer's git id instead
      const ok = e.lfs ? (masked ? e.oid === lfsPointerId(h.sha256, h.size) : e.lfs.oid === h.sha256) && e.lfs.size === h.size : e.oid === h.git;
      if (!ok) { bad.push(`${f}: differs from ${sha.slice(0, 7)}`); continue; }
      out.push({ rel: f, size: h.size, sha256: h.sha256, git: e.lfs ? undefined : e.oid, url: `https://huggingface.co/${s.hf}/resolve/${sha}/${f.split("/").map(encodeURIComponent).join("/")}`, source: `huggingface.co/${s.hf}@${sha.slice(0, 7)}` });
    }
    if (!bad.length) return { rev: sha, files: out };
    firstBad ||= bad;
  }
  throw new Error(`${s.hf}: no commit matches the local files — ${firstBad.join("; ")}`);
}

const ghCommit = new Map();
const ghTrees = new Map();
async function resolveGh(s, localDir) {
  if (!ghCommit.has(`${s.gh}@${s.ref}`)) ghCommit.set(`${s.gh}@${s.ref}`, gh(`repos/${s.gh}/commits/${s.ref}`).sha);
  const head = ghCommit.get(`${s.gh}@${s.ref}`);
  if (!ghTrees.has(head)) ghTrees.set(head, new Map(gh(`repos/${s.gh}/git/trees/${head}?recursive=1`).tree.filter((e) => e.type === "blob").map((e) => [e.path, e])));
  const tree = ghTrees.get(head);
  const out = [];
  for (const [repoPath, rel] of s.files) {
    const h = await hashes(path.join(localDir, rel));
    // The file at HEAD, or (when it changed since) at the latest commit of that path whose blob matches.
    const candidates = [{ sha: head, blob: tree.get(repoPath) }];
    if (candidates[0].blob?.sha !== h.git) {
      for (const c of gh(`repos/${s.gh}/commits?path=${encodeURIComponent(repoPath)}&per_page=30`)) {
        try { candidates.push({ sha: c.sha, blob: gh(`repos/${s.gh}/contents/${repoPath.split("/").map(encodeURIComponent).join("/")}?ref=${c.sha}`) }); } catch { /* removed there */ }
      }
    }
    let found = null;
    for (const { sha, blob } of candidates) {
      if (!blob) continue;
      if (blob.sha === h.git) { found = { rel, size: h.size, sha256: h.sha256, url: `https://raw.githubusercontent.com/${s.gh}/${sha}/${repoPath}`, source: `github.com/${s.gh}@${sha.slice(0, 7)}` }; break; }
      if (blob.size < 400 && h.size > 400) {
        const text = Buffer.from(gh(`repos/${s.gh}/git/blobs/${blob.sha}`).content, "base64").toString("utf8");
        const oid = /oid sha256:([0-9a-f]{64})/.exec(text)?.[1], size = Number(/size (\d+)/.exec(text)?.[1]);
        if (oid === h.sha256 && size === h.size) { found = { rel, size, sha256: oid, url: `https://media.githubusercontent.com/media/${s.gh}/${sha}/${repoPath}`, source: `github.com/${s.gh}@${sha.slice(0, 7)} (git LFS)` }; break; }
      }
    }
    if (!found) throw new Error(`${s.gh}/${repoPath}: no commit has the local file (${rel})`);
    out.push(found);
  }
  return { files: out };
}

async function resolveUrl(s, localDir) {
  const h = await hashes(path.join(localDir, s.file));
  if (s.zenodo) {
    let f = null;
    try { f = (await json(`https://zenodo.org/api/records/${s.zenodo.record}`)).body.files.find((x) => x.key === s.zenodo.key); } catch (e) { console.log(`     zenodo: ${e.message}`); }
    // zenodo refuses scripted API calls at times (HTTP 403): then the MD5 phase 4 checked against the record stands.
    const md5 = f ? f.checksum : s.zenodo.md5 ? `md5:${s.zenodo.md5}` : null;
    if (!md5 || !`md5:${h.md5}`.startsWith(md5) || (f && f.size !== h.size)) throw new Error(`${s.file}: zenodo says ${md5} / ${f?.size}, local md5:${h.md5} / ${h.size}`);
  } else {
    const r = await fetch(s.url, { method: "HEAD" });
    const md5 = /md5=([^,\s]+)/.exec(r.headers.get("x-goog-hash") || "")?.[1];
    const len = Number(r.headers.get("content-length"));
    if (!r.ok || len !== h.size || (md5 && Buffer.from(md5, "base64").toString("hex") !== h.md5)) throw new Error(`${s.url}: server ${r.status} ${len} md5 ${md5}, local ${h.size} ${h.md5}`);
  }
  return { files: [{ rel: s.file, size: h.size, sha256: h.sha256, url: s.url, source: new URL(s.url).host }] };
}

async function resolveArchive(s, localDir) {
  const tmp = path.join(SCRATCH, `archive-${crypto.createHash("md5").update(s.archive).digest("hex").slice(0, 8)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, "archive.zip");
  if (!fs.existsSync(file)) {
    const r = await fetch(s.archive, { redirect: "follow" });
    if (!r.ok) throw new Error(`${s.archive}: HTTP ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  const ah = await hashes(file);
  const out = path.join(tmp, "x");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  const tar = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", file, "-C", out]);
  if (tar.status !== 0) throw new Error(`unpack ${s.archive}: ${tar.stderr}`);
  const all = listFiles(out);
  const files = [];
  for (const [name, rel] of s.members) {
    const member = all.find((m) => path.posix.basename(m) === name);
    if (!member) throw new Error(`${s.archive}: no member ${name}`);
    const [mh, lh] = [await hashes(path.join(out, member)), await hashes(path.join(localDir, rel))];
    if (mh.sha256 !== lh.sha256) throw new Error(`${s.archive}: ${member} differs from the local ${rel}`);
    files.push({ rel, size: lh.size, sha256: lh.sha256, archive: { url: s.archive, sha256: ah.sha256, size: ah.size, member }, source: new URL(s.archive).host + new URL(s.archive).pathname });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { files };
}

async function resolveDerived(s, localDir) {
  const h = await hashes(path.join(localDir, s.file));
  return { files: [{ rel: s.file, size: h.size, sha256: h.sha256, derived: s.derived, source: "made on this PC" }] };
}

const catalog = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, "catalog.json"), "utf8")); } catch { return { version: 1, layers: {} }; } })();
const errors = [];
for (const L of SOURCES) {
  if (ONLY && !ONLY.includes(L.layer)) continue;
  const layer = { root: L.root, sets: {} };
  for (const set of L.sets) {
    const files = [];
    for (const s of set.src) {
      const localDir = path.join(RUNTIME, "models", L.root, s.dir);
      try {
        const r = s.hf ? await resolveHf(s, localDir) : s.gh ? await resolveGh(s, localDir) : s.archive ? await resolveArchive(s, localDir) : s.derived ? await resolveDerived(s, localDir) : await resolveUrl(s, localDir);
        for (const f of r.files) {
          const rel = f.rel.split("/");
          files.push({ file: rel.pop(), dir: [s.dir, ...rel].join("/"), size: f.size, sha256: f.sha256, ...(f.git ? { git: f.git } : {}), ...(f.url ? { url: f.url } : {}), ...(f.archive ? { archive: f.archive } : {}), ...(f.derived ? { derived: f.derived } : {}), source: f.source });
        }
        console.log(`ok   ${L.layer}/${set.id} ← ${s.hf || s.gh || s.archive || s.url || s.file} (${r.files.length} files${r.rev ? `, ${r.rev.slice(0, 7)}` : ""})`);
      } catch (e) {
        errors.push(`${L.layer}/${set.id}: ${e.message}`);
        console.log(`FAIL ${L.layer}/${set.id}: ${e.message}`);
      }
    }
    layer.sets[set.id] = { files, bytes: files.reduce((n, f) => n + f.size, 0) };
  }
  catalog.layers[L.layer] = layer;
}
catalog.generated = new Date().toISOString().slice(0, 10);
if (errors.length) { console.error(`\n${errors.length} problem(s); catalog.json not written`); process.exit(1); }
fs.writeFileSync(path.join(HERE, "catalog.json"), `${JSON.stringify(catalog, null, 1)}\n`);
console.log(`catalog.json written (${Object.values(catalog.layers).reduce((n, l) => n + Object.keys(l.sets).length, 0)} sets)`);
