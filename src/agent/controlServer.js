// Agent Control Server: the gate between external agents (via the MCP bridge) and the Editing API, running inside
// the app's main process so agents and the user edit the same in-memory project state.
//   transport  local named pipe (\\.\pipe\montaj-studio-<user>) or a unix socket — no network; off by default
//   framing    newline-delimited JSON-RPC 2.0, 1 MB max per message
//   auth       per-client bearer token (only its SHA-256 is stored), sent in "hello"; revocable at any time
//   policy     scopes (read by default), project allowlist, import roots, export folder, rate limit, approvals
//   audit      every call → agents/audit.jsonl (client, operation, argument summary, outcome, duration)
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AppError, toErrorEnvelope } from "../core/validation.js";
import { uid } from "../core/util.js";
import { OPERATIONS, OPERATION_INDEX, SCOPES, requiredScopes, IMPORTABLE, summarizeTimeline } from "./operations.js";
import { JobManager } from "./jobs.js";
import { SkillRegistry } from "./skills/registry.js";
import { SkillRuntime, checkInputs } from "./skills/runtime.js";

export const PROTOCOL = "montaj.agent/1";
const MAX_LINE = 1024 * 1024;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function defaultPipeName() {
  const user = (os.userInfo().username || "user").replace(/[^A-Za-z0-9_-]/g, "_");
  return process.platform === "win32" ? `\\\\.\\pipe\\montaj-studio-${user}` : path.join(os.tmpdir(), `montaj-studio-${user}.sock`);
}

// ------------------------------------------------------------------ clients
export class ClientStore {
  constructor(dir) { this.file = path.join(dir, "clients.json"); this.tokenDir = path.join(dir, "tokens"); fs.mkdirSync(this.tokenDir, { recursive: true }); }
  all() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return []; } }
  save(list) { fs.writeFileSync(this.file, JSON.stringify(list, null, 1)); }
  /** New client; the plain token is returned once (and written to a token file only the user can read). */
  create({ name, scopes = ["read"], projects = "*", importRoots = [], exportDir = "" }) {
    const bad = scopes.filter((s) => !SCOPES.includes(s));
    if (bad.length) throw new AppError("VALIDATION", "err.enum", { field: "scopes", allowed: SCOPES });
    const token = `mtj_${crypto.randomBytes(32).toString("base64url")}`;
    const client = { id: uid(), name: String(name || "Agent").slice(0, 60), tokenHash: sha256(token), scopes: [...new Set(["read", ...scopes])], projects, importRoots: importRoots.map((r) => path.resolve(r)), exportDir: exportDir ? path.resolve(exportDir) : "", createdAt: new Date().toISOString(), lastSeenAt: null, revoked: false };
    this.save([...this.all(), client]);
    const tokenFile = path.join(this.tokenDir, `${client.id}.token`);
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    return { client: this.public(client), token, tokenFile };
  }
  update(id, patch) {
    const list = this.all();
    const c = list.find((x) => x.id === id);
    if (!c) throw new AppError("NOT_FOUND", "err.clientNotFound");
    if (patch.scopes) { if (patch.scopes.some((s) => !SCOPES.includes(s))) throw new AppError("VALIDATION", "err.enum", { field: "scopes" }); c.scopes = [...new Set(["read", ...patch.scopes])]; }
    if (patch.projects !== undefined) c.projects = patch.projects === "*" ? "*" : [...new Set(patch.projects)];
    if (patch.importRoots) c.importRoots = patch.importRoots.map((r) => path.resolve(r));
    if (patch.exportDir !== undefined) c.exportDir = patch.exportDir ? path.resolve(patch.exportDir) : "";
    if (patch.name) c.name = String(patch.name).slice(0, 60);
    this.save(list);
    return this.public(c);
  }
  revoke(id) {
    const list = this.all();
    const c = list.find((x) => x.id === id);
    if (!c) throw new AppError("NOT_FOUND", "err.clientNotFound");
    c.revoked = true;
    this.save(list);
    fs.rmSync(path.join(this.tokenDir, `${id}.token`), { force: true });
    return true;
  }
  byToken(token) {
    if (typeof token !== "string" || token.length < 20) return null;
    const h = sha256(token);
    return this.all().find((c) => !c.revoked && c.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(c.tokenHash), Buffer.from(h))) || null;
  }
  touch(id) { const list = this.all(); const c = list.find((x) => x.id === id); if (c) { c.lastSeenAt = new Date().toISOString(); this.save(list); } }
  public(c) { const { tokenHash, ...rest } = c; void tokenHash; return rest; }
}

// ------------------------------------------------------------------ guard (policy for one client)
export function makeGuard({ client, services, hub }) {
  const all = client.projects === "*";
  const allowed = new Set(all ? [] : client.projects);
  const realRoots = (client.importRoots || []).map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
  const within = (file, root) => { const rel = path.relative(root, file); return rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
  const guard = {
    hasScope: (s) => client.scopes.includes(s),
    projectAllowed: (pid) => all || allowed.has(pid),
    grantProject: (pid) => { if (!all) { allowed.add(pid); hub.clients.update(client.id, { projects: [...allowed] }); } },
    mediaAllowed: (mid) => all || [...allowed].some((pid) => services.repos.media.listByProject(pid).some((m) => m.id === mid)),
    /** Resolve and check the project an operation touches. */
    checkTarget(op, a) {
      let pid = null;
      if (op.project) pid = op.project(a);
      if (op.timeline) { const tid = op.timeline(a); pid = services.repos.timelines.get(tid).projectId; }
      if (pid && !guard.projectAllowed(pid)) throw new AppError("FORBIDDEN", "err.projectNotAllowed", { projectId: pid });
      if (op.media) { const mid = op.media(a); services.repos.media.get(mid); if (!guard.mediaAllowed(mid)) throw new AppError("FORBIDDEN", "err.mediaNotAllowed", { mediaId: mid }); }
    },
    /** A file an agent asks to import: must exist, be media, and resolve inside one of the client's import roots. */
    readablePath(p) {
      if (typeof p !== "string" || !path.isAbsolute(p)) throw new AppError("VALIDATION", "err.pathAbsolute");
      let real;
      try { real = fs.realpathSync(p); } catch { throw new AppError("IO", "err.fileNotFound", { file: path.basename(p) }); }
      if (!IMPORTABLE.test(real)) throw new AppError("FORBIDDEN", "err.fileTypeNotAllowed", { file: path.basename(real) });
      if (!realRoots.some((r) => within(real, r))) throw new AppError("FORBIDDEN", "err.pathNotAllowed", { file: path.basename(real) });
      if (!fs.statSync(real).isFile()) throw new AppError("IO", "err.fileNotFound", { file: path.basename(p) });
      return real;
    },
    exportDir() {
      const dir = client.exportDir || path.join(services.settings.get("export").dir, "Montaj agents");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
  return guard;
}

// ------------------------------------------------------------------ hub
export class AgentHub {
  constructor({ services, dir, appVersion = "1.0.0", notify = () => {}, approver = null }) {
    this.services = services;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.clients = new ClientStore(dir);
    this.notify = notify;
    this.approver = approver; // async ({ client, op, args, summary }) => boolean — the UI dialog; null = deny
    this.pendingApprovals = new Map();
    this.jobs = new JobManager({ onChange: (j) => notify("agents:job", j) });
    this.skills = new SkillRegistry({ userDir: services.paths.skills, appVersion });
    this.runtime = new SkillRuntime({ registry: this.skills });
    this.skillsApi = {
      list: (q) => this.skills.list(q), card: (m) => this.skills.card(m), get: (id, v) => this.skills.get(id, v), validate: (s) => this.skills.validate(s),
      buildFromText: (t, o) => this.skills.buildFromText(t, o), save: (s, o) => this.skills.save(s, o),
      run: (args) => this.runtime.run(args),
    };
    this.buckets = new Map();
    this.auditFile = path.join(dir, "audit.jsonl");
    // Exports started by agents report through the exporter's events.
    const ex = services.exporter;
    const orig = ex.notify;
    ex.notify = (e, p) => { orig(e, p); this.jobs.onExportEvent(e, p); };
  }

  /** The user acting in the app: every scope, every project, no rate limit (the in-app Skills panel). */
  userContext() {
    const client = { id: "user", name: "Montaj Studio", scopes: [...SCOPES], projects: "*", importRoots: [], exportDir: "" };
    return this.context(client, "ui");
  }

  context(client, source = `agent:${client.name}`) {
    const guard = makeGuard({ client, services: this.services, hub: this });
    return { services: this.services, guard, jobs: this.jobs, skills: this.skillsApi, clientId: client.id, clientName: client.name, source, notify: this.notify };
  }

  /** Operations this client may call (MCP tool list). */
  visibleOperations(client) {
    return OPERATIONS.filter((op) => requiredScopes(op).every((s) => client.scopes.includes(s))).map((op) => ({ name: op.name, title: op.title, description: op.description, scope: op.scope, inputSchema: op.input, readOnly: op.scope === "read", destructive: op.scope === "delete", approval: !!op.approval }));
  }

  rateLimit(clientId) {
    const now = Date.now();
    const b = this.buckets.get(clientId) || { tokens: 40, at: now };
    b.tokens = Math.min(40, b.tokens + ((now - b.at) / 1000) * 20);
    b.at = now;
    if (b.tokens < 1) throw new AppError("RATE_LIMITED", "err.rateLimited");
    b.tokens -= 1;
    this.buckets.set(clientId, b);
  }

  audit(entry) {
    try { fs.appendFileSync(this.auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch { /* audit must not break calls */ }
  }

  recentAudit(n = 100) {
    try { return fs.readFileSync(this.auditFile, "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
  }

  async approve(client, op, args) {
    let target = "";
    if (args.projectId) { try { target = this.services.repos.projects.get(args.projectId).name; } catch { target = args.projectId; } }
    const summary = `${client.name} → ${op.title}${target ? ` (${target})` : ""}`;
    if (!this.approver) return false;
    const id = uid();
    this.pendingApprovals.set(id, { client: client.name, op: op.name, summary });
    try { return !!(await Promise.race([this.approver({ id, client: client.name, op: op.name, title: op.title, target, summary }), new Promise((r) => setTimeout(() => r(false), 120_000))])); }
    finally { this.pendingApprovals.delete(id); }
  }

  /** Run one operation for a client, with every policy check, and audit it. */
  async call(client, name, args = {}) {
    const t0 = Date.now();
    const entry = { clientId: client.id, client: client.name, op: name, args: summarizeArgs(args) };
    try {
      this.rateLimit(client.id);
      const op = OPERATION_INDEX.get(name);
      if (!op) throw new AppError("NOT_FOUND", "err.unknownOperation", { op: name });
      for (const s of requiredScopes(op)) if (!client.scopes.includes(s)) throw new AppError("FORBIDDEN", "err.scopeMissing", { scope: s, op: name });
      const clean = checkInputs(op.input, args, name);
      const ctx = this.context(client);
      ctx.guard.checkTarget(op, clean);
      if (op.approval && !(await this.approve(client, op, clean))) throw new AppError("DENIED", "err.userDenied", { op: name });
      const result = await op.run(ctx, clean);
      this.audit({ ...entry, ok: true, ms: Date.now() - t0, revision: result?.revision });
      if (op.scope !== "read") this.notify("agents:activity", { op: name, client: client.name });
      return result;
    } catch (err) {
      const env = toErrorEnvelope(err);
      this.audit({ ...entry, ok: false, code: env.code, messageKey: env.messageKey, ms: Date.now() - t0 });
      throw err;
    }
  }

  /** Read an MCP resource for a client. */
  async readResource(client, uri) {
    const m = /^montaj:\/\/(projects|skills|audit\/recent|project\/([A-Za-z0-9-]+)|timeline\/([A-Za-z0-9-]+)|skill\/([a-z0-9-]+))$/.exec(uri);
    if (!m) throw new AppError("NOT_FOUND", "err.resourceNotFound", { uri });
    if (m[1] === "projects") return this.call(client, "project_list", {});
    if (m[1] === "skills") return this.call(client, "skills_list", {});
    if (m[1] === "audit/recent") return this.recentAudit(50).filter((e) => e.clientId === client.id);
    if (m[2]) return this.call(client, "project_inspect", { projectId: m[2] });
    if (m[3]) return this.call(client, "timeline_inspect", { timelineId: m[3] });
    return this.call(client, "skills_inspect", { skillId: m[4] });
  }

  // ---------------------------------------------------------------- pipe server
  listen(pipe = defaultPipeName()) {
    if (this.server) return this.pipe;
    if (process.platform !== "win32") { try { fs.rmSync(pipe, { force: true }); } catch { /* stale socket */ } }
    this.pipe = pipe;
    this.server = net.createServer((sock) => this.connection(sock));
    this.server.on("error", (e) => { this.lastError = e.message; });
    this.lastError = null;
    return new Promise((resolve, reject) => {
      this.server.once("error", (e) => { this.server = null; this.pipe = null; this.lastError = e.message; reject(e); });
      this.server.listen(pipe, () => {
        fs.writeFileSync(path.join(this.dir, "endpoint.json"), JSON.stringify({ protocol: PROTOCOL, pipe, pid: process.pid, startedAt: new Date().toISOString() }));
        resolve(pipe);
      });
    });
  }

  close() {
    for (const s of this.sockets || []) s.destroy();
    this.server?.close();
    this.server = null;
    try { fs.rmSync(path.join(this.dir, "endpoint.json"), { force: true }); } catch { /* ignore */ }
  }

  connection(sock) {
    this.sockets = this.sockets || new Set();
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    let client = null;
    let buf = "";
    const helloTimer = setTimeout(() => { if (!client) sock.destroy(); }, 5000);
    const send = (msg) => { if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n"); };
    sock.setEncoding("utf8");
    sock.on("data", async (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes("\n")) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "message too large" } }); sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
        const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
        const fail = (err) => { const e = toErrorEnvelope(err); send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.messageKey, data: e } }); };
        try {
          if (!client) {
            if (msg.method !== "hello") throw new AppError("FORBIDDEN", "err.notAuthenticated");
            const c = this.clients.byToken(msg.params?.token);
            if (!c) { this.audit({ op: "hello", ok: false, code: "FORBIDDEN" }); throw new AppError("FORBIDDEN", "err.badToken"); }
            client = c;
            clearTimeout(helloTimer);
            this.clients.touch(c.id);
            this.audit({ clientId: c.id, client: c.name, op: "hello", ok: true, agent: String(msg.params?.agent || "").slice(0, 80) });
            this.notify("agents:connected", { clientId: c.id, name: c.name });
            reply({ protocol: PROTOCOL, client: { id: c.id, name: c.name, scopes: c.scopes, projects: c.projects } });
            continue;
          }
          // Re-read the client each call so revocation and scope changes apply immediately.
          const live = this.clients.all().find((x) => x.id === client.id);
          if (!live || live.revoked) { fail(new AppError("FORBIDDEN", "err.clientRevoked")); sock.destroy(); return; }
          client = live;
          if (msg.method === "ops.list") reply({ operations: this.visibleOperations(client), skills: client.scopes.includes("skills.run") ? this.skills.list({}).map((s) => this.skills.card(s)) : [] });
          else if (msg.method === "ops.call") reply(await this.call(client, String(msg.params?.name || ""), msg.params?.args || {}));
          else if (msg.method === "resources.read") reply(await this.readResource(client, String(msg.params?.uri || "")));
          else throw new AppError("NOT_FOUND", "err.unknownMethod", { method: msg.method });
        } catch (err) { fail(err); }
      }
    });
    sock.on("error", () => {});
  }
}

/** Audit-safe summary of arguments: paths reduced to file names, long strings and objects shortened. */
function summarizeArgs(a) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (k === "token") continue;
    if (k === "paths" && Array.isArray(v)) out[k] = v.map((p) => path.basename(String(p)));
    else if (typeof v === "string") out[k] = v.length > 80 ? `${v.slice(0, 80)}…` : v;
    else if (v && typeof v === "object") out[k] = Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).slice(0, 8).join(",")}}`;
    else out[k] = v;
  }
  return out;
}

export { summarizeTimeline };
