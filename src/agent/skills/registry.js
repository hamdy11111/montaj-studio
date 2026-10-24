// Skill Registry: official skills (shipped, read-only), user skills (saved by the user or an agent) and imported
// skills (external, disabled until the user enables them). Skills are data validated against skill.schema.json;
// every step must name a real operation (or another installed skill). History of changes in history.jsonl.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AppError } from "../../core/validation.js";
import { OPERATION_INDEX } from "../operations.js";
import { buildSkillFromText } from "./builder.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_SCHEMA = JSON.parse(fs.readFileSync(path.join(here, "skill.schema.json"), "utf8"));
export const BUILTIN_DIR = path.join(here, "..", "..", "skills");

export const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false });
const validateManifest = ajv.compile(SKILL_SCHEMA);

// ------------------------------------------------------------------ versions
const parseV = (v) => String(v).replace(/^[^\d]*/, "").split(".").map((x) => Number(x) || 0);
export const cmpVersion = (a, b) => { const x = parseV(a), y = parseV(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
/** "^1.2.0": same major, >= 1.2.0. "1.2.0": exact. */
export const satisfies = (v, range) => {
  if (!range) return true;
  if (range.startsWith("^")) { const r = range.slice(1); return parseV(v)[0] === parseV(r)[0] && cmpVersion(v, r) >= 0; }
  return cmpVersion(v, range) === 0;
};

/** Canonical JSON (sorted keys) → sha256, without the integrity/trust fields the registry owns. */
export function integrityOf(skill) {
  const { integrity, trust, ...rest } = skill; void integrity; void trust;
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canon(rest))).digest("hex")}`;
}

export class SkillRegistry {
  constructor({ userDir, builtinDir = BUILTIN_DIR, appVersion = "1.0.0", providers = () => ({}) }) {
    this.userDir = userDir;
    this.builtinDir = builtinDir;
    this.appVersion = appVersion;
    this.providers = providers; // () => { whisper: bool }
    fs.mkdirSync(userDir, { recursive: true });
    this.reload();
  }

  // ------------------------------------------------------------------ loading
  reload() {
    this.skills = new Map(); // id -> [{ manifest, trust, enabled, file }] newest first
    const add = (manifest, trust, enabled, file) => {
      const list = this.skills.get(manifest.id) || [];
      list.push({ manifest: { ...manifest, trust }, trust, enabled, file });
      list.sort((a, b) => cmpVersion(b.manifest.version, a.manifest.version));
      this.skills.set(manifest.id, list);
    };
    for (const f of fs.readdirSync(this.builtinDir).filter((x) => x.endsWith(".skill.json"))) {
      const m = JSON.parse(fs.readFileSync(path.join(this.builtinDir, f), "utf8"));
      add(m, "official", true, path.join(this.builtinDir, f));
    }
    for (const id of fs.readdirSync(this.userDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      if (this.isOfficial(id)) continue; // a user file can never shadow an official skill
      const dir = path.join(this.userDir, id);
      const meta = this.readMeta(id);
      for (const f of fs.readdirSync(dir).filter((x) => /^\d+\.\d+\.\d+\.json$/.test(x))) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (m.id !== id || !validateManifest(m)) continue;
          if (m.integrity && m.integrity !== integrityOf(m)) continue; // tampered on disk: ignore
          add(m, meta.trust, meta.enabled, path.join(dir, f));
        } catch { /* unreadable file: skip */ }
      }
    }
  }

  isOfficial(id) { return (this.skills?.get(id) || []).some((e) => e.trust === "official"); }
  readMeta(id) { try { return JSON.parse(fs.readFileSync(path.join(this.userDir, id, "meta.json"), "utf8")); } catch { return { trust: "user", enabled: true }; } }
  writeMeta(id, meta) { fs.writeFileSync(path.join(this.userDir, id, "meta.json"), JSON.stringify(meta, null, 1)); }
  logHistory(entry) { fs.appendFileSync(path.join(this.userDir, "history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); }
  history(id) {
    try { return fs.readFileSync(path.join(this.userDir, "history.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !id || e.id === id); } catch { return []; }
  }

  // ------------------------------------------------------------------ queries
  entries({ includeDisabled = false } = {}) {
    return [...this.skills.values()].map((list) => list[0]).filter((e) => includeDisabled || e.enabled);
  }

  list({ query = "", category = "", includeDisabled = false } = {}) {
    const q = String(query || "").toLowerCase();
    return this.entries({ includeDisabled }).filter((e) => {
      const m = e.manifest;
      if (category && m.category !== category) return false;
      if (!q) return true;
      return [m.id, m.name, m.description, ...(m.tags || []), ...(m.capabilities || [])].join(" ").toLowerCase().includes(q);
    }).map((e) => ({ ...e.manifest, enabled: e.enabled }));
  }

  /** Newest enabled version (or an exact version). */
  get(id, version = null, { includeDisabled = false } = {}) {
    const list = this.skills.get(id);
    if (!list) throw new AppError("NOT_FOUND", "err.skillNotFound", { id });
    const e = version ? list.find((x) => x.manifest.version === version) : list[0];
    if (!e) throw new AppError("NOT_FOUND", "err.skillNotFound", { id, version });
    if (!e.enabled && !includeDisabled) throw new AppError("FORBIDDEN", "err.skillDisabled", { id });
    return { ...e.manifest, enabled: e.enabled, versions: list.map((x) => x.manifest.version) };
  }

  /** Short description used by skills_list and the MCP tool list. */
  card(m) {
    return { id: m.id, name: m.name, description: m.description, version: m.version, trust: m.trust, enabled: m.enabled !== false, category: m.category, tags: m.tags || [],
      permissions: m.permissions, requires: m.requires || {}, inputs: m.inputs || { type: "object", properties: {} }, steps: m.steps.map((s) => s.title || s.op || s.skill), examples: m.examples || [] };
  }

  // ------------------------------------------------------------------ validation
  /** Schema + semantic checks. Returns { valid, errors: [{ path, message }] }. */
  validate(skill, { seen = new Set() } = {}) {
    const errors = [];
    if (!validateManifest(skill)) {
      for (const e of validateManifest.errors || []) errors.push({ path: e.instancePath || "/", message: e.message });
      return { valid: false, errors };
    }
    if (skill.requires?.app && cmpVersion(this.appVersion, skill.requires.app.slice(2)) < 0) errors.push({ path: "/requires/app", message: `needs Montaj Studio ${skill.requires.app}` });
    const inputs = new Set(Object.keys(skill.inputs?.properties || {}));
    const stepIds = new Set();
    const perms = new Set(skill.permissions);
    for (const [i, st] of skill.steps.entries()) {
      const p = `/steps/${i}`;
      if (stepIds.has(st.id)) errors.push({ path: p, message: `duplicate step id ${st.id}` });
      if (st.op) {
        const op = OPERATION_INDEX.get(st.op);
        if (!op) errors.push({ path: `${p}/op`, message: `unknown operation ${st.op}` });
        else {
          if (op.scope === "delete" || op.scope === "skills.write" || op.scope === "skills.run") errors.push({ path: `${p}/op`, message: `${st.op} cannot be used inside a skill` });
          for (const s of [op.scope, ...(op.needs || [])]) if (!perms.has(s)) errors.push({ path: `${p}/op`, message: `${st.op} needs permission "${s}"` });
        }
      }
      if (st.skill) {
        if (st.skill === skill.id || seen.has(st.skill)) errors.push({ path: `${p}/skill`, message: `cyclic skill reference ${st.skill}` });
        else if (!this.skills.has(st.skill)) errors.push({ path: `${p}/skill`, message: `unknown skill ${st.skill}` });
        else {
          const dep = (skill.dependsOn || []).find((d) => d.id === st.skill);
          if (!dep) errors.push({ path: `${p}/skill`, message: `${st.skill} must be listed in dependsOn` });
          const child = this.skills.get(st.skill).find((e) => satisfies(e.manifest.version, dep?.version));
          if (dep && !child) errors.push({ path: `${p}/skill`, message: `no installed version of ${st.skill} satisfies ${dep.version}` });
          if (child) {
            for (const s of child.manifest.permissions) if (!perms.has(s)) errors.push({ path: `${p}/skill`, message: `${st.skill} needs permission "${s}"` });
            const nested = this.validate(child.manifest, { seen: new Set([...seen, skill.id]) });
            for (const e of nested.errors) errors.push({ path: `${p}/skill → ${e.path}`, message: e.message });
          }
        }
      }
      // Templates may only reference known inputs and earlier steps.
      for (const ref of JSON.stringify(st.with || {}).match(/\{\{[^}]+\}\}/g) || []) {
        const expr = ref.slice(2, -2).trim();
        const [root, name] = expr.split(".");
        if (root === "inputs" && !inputs.has(name)) errors.push({ path: `${p}/with`, message: `unknown input ${name}` });
        else if (root === "steps" && !stepIds.has(name)) errors.push({ path: `${p}/with`, message: `step ${name} is not before ${st.id}` });
        else if (root === "settings" && !Object.prototype.hasOwnProperty.call(skill.settings || {}, expr.slice(9))) errors.push({ path: `${p}/with`, message: `unknown setting ${expr.slice(9)}` });
        else if (!["inputs", "steps", "ctx", "settings"].includes(root)) errors.push({ path: `${p}/with`, message: `unknown reference ${expr}` });
      }
      if (st.when) { const [root, name] = st.when.replace(/^!/, "").split("."); if (root === "inputs" && !inputs.has(name)) errors.push({ path: `${p}/when`, message: `unknown input ${name}` }); }
      stepIds.add(st.id);
    }
    if (skill.inputs) { try { ajv.compile(skill.inputs); } catch (e) { errors.push({ path: "/inputs", message: `invalid inputs schema: ${e.message}` }); } }
    return { valid: errors.length === 0, errors };
  }

  // ------------------------------------------------------------------ writing
  /** Save a user skill (new id, or a newer version of an existing user skill). */
  save(skill, { author = "user", source = "user" } = {}) {
    const s = { ...skill, author: skill.author || author, source: skill.source || source };
    delete s.trust; delete s.enabled; delete s.versions;
    const v = this.validate(s);
    if (!v.valid) throw new AppError("VALIDATION", "err.skillInvalid", { errors: v.errors.slice(0, 20) });
    if (this.isOfficial(s.id)) throw new AppError("CONFLICT", "err.skillOfficial", { id: s.id });
    const existing = this.skills.get(s.id) || [];
    if (existing.some((e) => e.trust === "external")) throw new AppError("CONFLICT", "err.skillExternal", { id: s.id });
    if (existing.length && cmpVersion(s.version, existing[0].manifest.version) <= 0) throw new AppError("CONFLICT", "err.skillVersion", { id: s.id, latest: existing[0].manifest.version });
    s.integrity = integrityOf(s);
    const dir = path.join(this.userDir, s.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.version}.json`), JSON.stringify(s, null, 1));
    if (!existing.length) this.writeMeta(s.id, { trust: "user", enabled: true });
    this.logHistory({ id: s.id, version: s.version, action: existing.length ? "update" : "create", by: author });
    this.reload();
    return this.card(this.get(s.id, s.version, { includeDisabled: true }));
  }

  /** Import a skill file from elsewhere: kept as "external" and disabled until the user enables it. */
  importSkill(skill, { from = "file" } = {}) {
    const s = { ...skill, source: from };
    delete s.trust; delete s.enabled; delete s.versions;
    const v = this.validate(s);
    if (!v.valid) throw new AppError("VALIDATION", "err.skillInvalid", { errors: v.errors.slice(0, 20) });
    if (this.isOfficial(s.id) || (this.skills.get(s.id) || []).some((e) => e.trust === "user")) throw new AppError("CONFLICT", "err.skillIdTaken", { id: s.id });
    const integrity = integrityOf(s);
    if (skill.integrity && skill.integrity !== integrity) throw new AppError("VALIDATION", "err.skillIntegrity", { id: s.id });
    s.integrity = integrity;
    const dir = path.join(this.userDir, s.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.version}.json`), JSON.stringify(s, null, 1));
    this.writeMeta(s.id, { trust: "external", enabled: false });
    this.logHistory({ id: s.id, version: s.version, action: "import", from });
    this.reload();
    return this.card(this.get(s.id, s.version, { includeDisabled: true }));
  }

  setEnabled(id, enabled) {
    if (this.isOfficial(id)) throw new AppError("VALIDATION", "err.skillOfficial", { id });
    if (!this.skills.has(id)) throw new AppError("NOT_FOUND", "err.skillNotFound", { id });
    this.writeMeta(id, { ...this.readMeta(id), enabled: !!enabled });
    this.logHistory({ id, action: enabled ? "enable" : "disable" });
    this.reload();
    return !!enabled;
  }

  /** Remove a user/imported skill (all versions). Official skills cannot be removed. */
  remove(id) {
    if (this.isOfficial(id)) throw new AppError("VALIDATION", "err.skillOfficial", { id });
    if (!this.skills.has(id)) throw new AppError("NOT_FOUND", "err.skillNotFound", { id });
    fs.rmSync(path.join(this.userDir, id), { recursive: true, force: true });
    this.logHistory({ id, action: "remove" });
    this.reload();
    return true;
  }

  exportSkill(id, version = null) {
    const s = this.get(id, version, { includeDisabled: true });
    const { trust, enabled, versions, ...rest } = s; void trust; void enabled; void versions;
    return { ...rest, integrity: integrityOf(rest) };
  }

  buildFromText(text, opts = {}) {
    const draft = buildSkillFromText(text, opts);
    return { ...draft, validation: this.validate(draft.skill) };
  }
}
