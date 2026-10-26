// IPC bridge: one "api:call" channel with an explicit allowlist of methods. Every result is an envelope
// {ok, data} | {ok:false, error:{code, messageKey, details}} — the renderer never sees raw exceptions or Realm objects.
import { ipcMain, dialog, shell, BrowserWindow, desktopCapturer, Notification, app, clipboard } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppError, toErrorEnvelope, validateId } from "../core/validation.js";
import { capabilities, capsSummary, setBinaries } from "../services/ffmpeg.js";
import { dirSize, clearDir } from "../services/paths.js";
import { defaultBindings, applyBinding, findConflicts, COMMANDS, checkBinding } from "../core/shortcuts.js";
import { planFromText } from "../core/assistant.js";
import { uid } from "../core/util.js";
import { CAPTION_TEMPLATES } from "../core/captionTemplates.js";
import { OPERATION_INDEX } from "../agent/operations.js";
import { autoEdit, directorEstimate } from "../agent/director.js";
import { dubEstimate, dubDetect, dubTimeline, redubLines, removeDubbing, dubSetLanguage, dubOnTimeline, dubSpeakerSample } from "../agent/dub.js";
import { applyCaptions, restyleCaptions, transact } from "../agent/captions.js";

const str = (v, field) => { if (typeof v !== "string") throw new AppError("VALIDATION", "err.string", { field }); return v; };
const id = (v, field = "id") => validateId(v, field);
const obj = (v) => (v && typeof v === "object" ? v : {});
const arr = (v, field) => { if (!Array.isArray(v)) throw new AppError("VALIDATION", "err.array", { field }); return v; };

export function registerIpc({ getServices, getAgents = () => null, getWindow, appInfo, updater = null }) {
  const S = () => getServices();
  const A = () => { const a = getAgents(); if (!a) throw new AppError("VALIDATION", "err.agentsUnavailable"); return a; };
  const win = () => getWindow() || BrowserWindow.getFocusedWindow();
  // One dub at a time (it uses the whole GPU); "dub.cancel" stops it.
  let dubRun = null;
  const dubOpts = (o) => { const q = obj(o); return { mediaId: q.mediaId ? id(q.mediaId, "mediaId") : undefined, lang: q.lang ? str(q.lang, "lang") : "en", context: q.context ? String(q.context).slice(0, 500) : "", duckDb: Number.isFinite(q.duckDb) ? Math.max(0, Math.min(20, q.duckDb)) : 6 }; };
  async function dubJob(fn) {
    if (dubRun) throw new AppError("CONFLICT", "err.dubBusy");
    dubRun = new AbortController();
    try {
      return await fn({ signal: dubRun.signal, progress: (p, label) => notifyAll("dub:progress", { progress: p, label }) });
    } finally { dubRun = null; }
  }

  const methods = {
    // ---------------------------------------------------------------- app
    "app.info": () => ({ ...appInfo(), paths: { media: S().paths.media, backups: S().paths.backups }, startup: S().startup }),
    "app.capabilities": async () => ({ ffmpeg: capsSummary(await capabilities()), tts: S().tts.available(), captions: await S().captions.status() }),
    "app.showInFolder": (p) => { const f = str(p, "path"); if (fs.existsSync(f)) shell.showItemInFolder(f); return true; },
    "app.openPath": async (p) => { const f = str(p, "path"); if (!fs.existsSync(f)) throw new AppError("IO", "err.fileNotFound"); await shell.openPath(f); return true; },
    // Low memory / disk warnings (FEAT-142): free RAM and free space on the media and export drives.
    "app.resources": () => {
      const free = (dir) => { try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch { return null; } };
      return { freeMem: os.freemem(), totalMem: os.totalmem(), freeDiskMedia: free(S().paths.media), freeDiskExport: free(S().settings.get("export").dir) };
    },
    "app.relaunch": () => { app.relaunch(); app.exit(0); return true; },
    // Software updates from the GitHub releases (installed app only; progress: "update:status").
    "update.status": () => updater?.status() || { status: "unsupported" },
    "update.check": () => updater ? updater.check({ manual: true }) : { status: "unsupported" },
    "update.download": () => updater?.download(),
    "update.install": () => !!updater?.install(),
    "app.quit": () => { app.quit(); return true; },
    "app.notify": (title, body) => { if (S().settings.get("general").notifications && Notification.isSupported()) new Notification({ title: str(title, "title"), body: String(body || "") }).show(); return true; },
    "app.setFullScreen": (v) => { win()?.setFullScreen(!!v); return !!v; },
    "app.isFullScreen": () => !!win()?.isFullScreen(),

    // ---------------------------------------------------------------- dialogs
    "dialog.openFiles": async (o = {}) => {
      const filters = { media: [{ name: "Media files", extensions: ["mp4", "mov", "m4v", "mkv", "avi", "webm", "wmv", "mpg", "mpeg", "mts", "m2ts", "3gp", "flv", "jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff", "heic", "mp3", "wav", "aac", "m4a", "flac", "ogg", "opus", "wma"] }],
        audio: [{ name: "Audio", extensions: ["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus", "wma"] }], image: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] }],
        video: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] }], refimage: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
        captions: [{ name: "Captions", extensions: ["srt", "vtt", "lrc"] }], lut: [{ name: "LUT", extensions: ["cube", "3dl"] }], package: [{ name: "Montaj package", extensions: ["mstudio", "zip"] }],
        exe: [{ name: "Program", extensions: ["exe"] }], model: [{ name: "Model", extensions: ["bin", "gguf"] }], json: [{ name: "JSON", extensions: ["json"] }], any: [{ name: "All files", extensions: ["*"] }] };
      const r = await dialog.showOpenDialog(win(), { title: o.title, properties: ["openFile", ...(o.multi ? ["multiSelections"] : [])], filters: filters[o.kind || "media"] || filters.any });
      return r.canceled ? [] : r.filePaths;
    },
    "dialog.openFolder": async (o = {}) => { const r = await dialog.showOpenDialog(win(), { title: o.title, properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; },
    "dialog.saveFile": async (o = {}) => { const r = await dialog.showSaveDialog(win(), { title: o.title, defaultPath: o.defaultPath, filters: o.filters }); return r.canceled ? null : r.filePath; },

    // ---------------------------------------------------------------- projects & templates
    "project.list": (q) => S().projects.list(obj(q)),
    "project.get": (pid) => S().repos.projects.get(id(pid)),
    "project.create": (o) => S().projects.create(obj(o)),
    "project.rename": (pid, name) => S().projects.rename(id(pid), str(name, "name")),
    "project.duplicate": (pid) => S().projects.duplicate(id(pid)),
    "project.trash": (pid) => S().projects.trash(id(pid)),
    "project.restore": (pid) => S().projects.restore(id(pid)),
    "project.deleteForever": (pid) => S().projects.deleteForever(id(pid)),
    "project.emptyTrash": () => { let n = 0; for (const p of S().projects.list({ status: "trashed" })) { S().projects.deleteForever(p.id); n++; } return n; },
    "project.open": (pid) => S().projects.open(id(pid)),
    "project.finalize": (pid, o) => S().projects.finalize(id(pid), obj(o)),
    "project.setCover": (pid, o) => S().projects.setCover(id(pid), obj(o)),
    "project.createShorts": (pid, mid, cands, o) => S().projects.createShorts(id(pid), id(mid, "mediaId"), arr(cands, "candidates"), obj(o)),
    "template.save": (pid, o) => S().projects.saveAsTemplate(id(pid), obj(o)),
    "template.list": (q) => S().projects.listTemplates(obj(q)),
    "template.use": (tid) => S().projects.useTemplate(id(tid)),
    "template.toggleFavorite": (tid) => S().projects.toggleTemplateFavorite(id(tid)),

    // ---------------------------------------------------------------- timelines
    "timeline.get": (tid) => S().timelines.get(id(tid)),
    "timeline.exec": (tid, cmd, a) => S().timelines.exec(id(tid), str(cmd, "cmd"), obj(a)),
    "timeline.create": (pid, name) => S().projects.createTimeline(id(pid), name ? str(name, "name") : undefined),
    "timeline.rename": (tid, name) => S().projects.renameTimeline(id(tid), str(name, "name")),
    "timeline.delete": (tid) => S().projects.deleteTimeline(id(tid)),

    // ---------------------------------------------------------------- media
    "media.list": (pid, q) => S().repos.media.listByProject(id(pid), obj(q)),
    "media.get": (mid) => S().repos.media.get(id(mid)),
    "media.import": async (pid, files) => {
      const r = await S().media.importFiles(id(pid), arr(files, "files").map((f) => str(f, "file")));
      for (const m of r.imported) S().media.generateDerivatives(m.id).then((x) => notifyAll("media:updated", x)).catch(() => {});
      return r;
    },
    "media.importFolder": async (pid, dir) => {
      const files = S().media.listFolder(str(dir, "dir"));
      const r = await S().media.importFiles(id(pid), files);
      for (const m of r.imported) S().media.generateDerivatives(m.id).then((x) => notifyAll("media:updated", x)).catch(() => {});
      return r;
    },
    "media.waveform": (mid) => S().media.readWaveform(id(mid)),
    "media.makeProxy": async (mid) => { const m = await S().media.makeProxy(id(mid)); notifyAll("media:updated", m); return m; },
    "media.relink": async (mid, file) => S().media.relink(id(mid), str(file, "file")),
    "media.setFavorite": (mid, v) => S().repos.media.update(id(mid), { favorite: !!v }),
    "media.detach": (pid, mid) => S().repos.media.detach(id(pid), id(mid)),
    "media.usage": (mid) => S().repos.media.usageCount(id(mid)),

    // ---------------------------------------------------------------- library, workspaces
    "library.list": (q) => S().repos.library.list(obj(q)),
    "library.importFiles": async (kind, files, category) => {
      const k = ["audio", "sticker", "lut", "element"].includes(kind) ? kind : null;
      if (!k) throw new AppError("VALIDATION", "err.enum", { field: "kind" });
      const dir = path.join(S().paths.library, k);
      fs.mkdirSync(dir, { recursive: true });
      const out = [];
      for (const f of arr(files, "files")) {
        const src = str(f, "file");
        if (!fs.existsSync(src)) continue;
        if (k === "lut") { const { parseCube } = await import("../core/lut.js"); if (src.toLowerCase().endsWith(".cube")) parseCube(fs.readFileSync(src, "utf8")); }
        const dest = path.join(dir, `${uid()}${path.extname(src)}`);
        fs.copyFileSync(src, dest);
        let durationUs = 0;
        if (k === "audio") { try { durationUs = (await S().media.probe(dest)).durationUs; } catch { /* keep 0 */ } }
        out.push(S().repos.library.add({ kind: k, category: category || "yours", name: path.basename(src), path: dest, durationUs, sizeBytes: fs.statSync(dest).size }));
      }
      return out;
    },
    "library.update": (lid, patch) => S().repos.library.update(id(lid), obj(patch)),
    "library.remove": (lid) => { const p = S().repos.library.remove(id(lid)); if (p && p.startsWith(S().paths.library)) fs.rmSync(p, { force: true }); return true; },
    "library.readLut": (lid) => { const item = S().repos.library.list({ kind: "lut" }).find((i) => i.id === id(lid)); if (!item) throw new AppError("NOT_FOUND", "err.notFound"); return fs.readFileSync(item.path, "utf8"); },
    "library.useAudio": async (pid, lid) => { const item = S().repos.library.list({ kind: "audio" }).find((i) => i.id === id(lid)); if (!item) throw new AppError("NOT_FOUND", "err.notFound"); const existing = S().repos.media.listByProject(id(pid), {}).find((m) => m.path === item.path); if (existing) return existing; return (await S().media.importFiles(id(pid), [item.path], { origin: item.category === "music" ? "music" : "import" })).imported[0]; },
    "workspace.list": () => S().repos.workspaces.list(),
    "workspace.create": (name, color) => S().repos.workspaces.create(str(name, "name"), color || "#00C1CD"),
    "workspace.rename": (wid, name) => S().repos.workspaces.rename(id(wid), str(name, "name")),
    "workspace.remove": (wid) => S().repos.workspaces.remove(id(wid)),
    "workspace.addProject": (wid, pid) => S().repos.workspaces.addProject(id(wid), id(pid)),
    "workspace.removeProject": (wid, pid) => S().repos.workspaces.removeProject(id(wid), id(pid)),

    // ---------------------------------------------------------------- settings & shortcuts
    "settings.all": () => S().settings.all(),
    "settings.set": (section, patch) => {
      const r = S().settings.set(str(section, "section"), obj(patch));
      if (section === "performance" && ("ffmpegPath" in patch || "ffprobePath" in patch)) setBinaries({ ffmpeg: r.ffmpegPath || undefined, ffprobe: r.ffprobePath || undefined });
      if (section === "performance") fs.writeFileSync(path.join(app.getPath("userData"), "boot.json"), JSON.stringify({ gpuUI: r.gpuUI, hwDecode: r.hwDecode }));
      return r;
    },
    "settings.reset": (section) => S().settings.reset(str(section, "section")),
    "settings.cacheInfo": () => ({ cacheBytes: dirSize(S().paths.cache), proxyBytes: dirSize(S().paths.proxy), renderBytes: dirSize(S().paths.render) + dirSize(S().paths.compound) }),
    "settings.clearCache": (which = "all") => {
      const p = S().paths;
      const dirs = { all: [p.render, p.compound, p.overlays], proxy: [p.proxy], render: [p.render, p.compound] }[which] || [];
      return dirs.reduce((n, d) => n + clearDir(d), 0);
    },
    "settings.shellMenu": async (enabled) => setShellMenu(!!enabled),
    "shortcuts.get": (pid) => { const p = S().repos.shortcuts.get(Number(pid) || 1); return { ...p, conflicts: findConflicts(p.bindings), commands: COMMANDS }; },
    "shortcuts.check": (pid, cmd, chord) => checkBinding(S().repos.shortcuts.get(Number(pid) || 1).bindings, str(cmd, "cmd"), String(chord || "")),
    "shortcuts.set": (pid, cmd, chord, override) => { const p = S().repos.shortcuts.get(Number(pid) || 1); return S().repos.shortcuts.save(p.id, applyBinding(p.bindings, str(cmd, "cmd"), String(chord || ""), { override: !!override })); },
    "shortcuts.saveAll": (pid, bindings) => { const b = obj(bindings); if (findConflicts(b).length) throw new AppError("CONFLICT", "err.shortcutConflict"); return S().repos.shortcuts.save(Number(pid) || 1, b); },
    "shortcuts.reset": (pid) => S().repos.shortcuts.save(Number(pid) || 1, defaultBindings()),

    // ---------------------------------------------------------------- export
    "export.estimate": async (tid, req) => { if (!S().exporter.caps) await S().exporter.loadCaps(); return S().exporter.estimate(id(tid), obj(req)); },
    "export.start": (req) => S().exporter.start(obj(req)),
    "export.cancel": (jobId) => S().exporter.cancel(str(jobId, "jobId")),
    "export.list": (q) => S().repos.exports.list(obj(q)),
    "export.remove": (eid) => S().repos.exports.remove(id(eid)),
    "export.renderCompound": async (tid, overlays) => { const p = await S().exporter.renderCompound(id(tid), { overlays: obj(overlays) }); return p; },
    "export.compoundStatus": (tid) => S().exporter.compoundFresh(id(tid)),

    // ---------------------------------------------------------------- captions, tts, analysis, assistant
    "captions.status": (force) => S().captions.status(!!force),
    "asr.setupStatus": () => S().asrSetup.status(),
    "asr.setupStart": async () => { await S().asrSetup.start(); return S().captions.status(true); },
    "asr.setupCancel": () => S().asrSetup.cancel(),
    "captions.templates": () => Object.entries(CAPTION_TEMPLATES).map(([tid, t]) => ({ id: tid, name: t.name, use: t.use })),
    // Animated word-timed captions for the open timeline (same code path as agents; one undo step).
    "captions.generatePro": async (tid, o) => { const ctx = A().userContext(); const q = obj(o); return transact(ctx, id(tid), `captions:${q.template || "karaoke-yellow"}`, undefined, () => applyCaptions(ctx, id(tid), { template: q.template ? str(q.template, "template") : undefined, language: q.language ? str(q.language, "language") : "auto", keywords: q.keywords ? arr(q.keywords, "keywords").map(String) : [], reveal: !!q.reveal, corrections: q.corrections ? arr(q.corrections, "corrections").map((c) => ({ from: String(c?.from ?? ""), to: String(c?.to ?? "") })) : undefined })); },
    // Smart edit: the director plans and applies a whole edit (progress: "director:progress").
    "director.estimate": (tid, o) => directorEstimate(A().userContext(), id(tid), obj(o)),
    "director.run": async (tid, o) => { const q = obj(o); return autoEdit(A().userContext(), id(tid), { ...q, apply: true }, { progress: (p, label) => notifyAll("director:progress", { progress: p, label }) }); },
    // Dubbing an Arabic video into another language, all on this computer (progress: "dub:progress"; one run at a time).
    "dub.estimate": (tid, o) => dubEstimate(A().userContext(), id(tid), obj(o)),
    "dub.detect": (tid, o) => dubDetect(A().userContext(), id(tid), obj(o)),
    "dub.run": (tid, o) => dubJob((job) => dubTimeline(A().userContext(), id(tid), dubOpts(o), job)),
    "dub.revoice": (tid, o) => dubJob((job) => redubLines(A().userContext(), id(tid), { ...dubOpts(o), edits: arr(obj(o).edits || [], "edits").map(obj) }, job)),
    "dub.cancel": () => { dubRun?.abort(); return true; },
    "dub.setupStatus": () => ({ ...S().dubSetup.status(), ready: S().dubber.status().ready }),
    "dub.setupStart": async () => { await S().dubSetup.start(); return { ...S().dubSetup.status(), ready: S().dubber.status().ready }; },
    "dub.setupCancel": () => S().dubSetup.cancel(),
    "dub.remove": (tid, o) => removeDubbing(A().userContext(), id(tid), obj(o)),
    "dub.setLanguage": (tid, o) => dubSetLanguage(A().userContext(), id(tid), obj(o)),
    "dub.languages": (tid, o) => dubOnTimeline(A().userContext(), id(tid), obj(o)),
    "dub.speakerSample": (tid, o) => dubSpeakerSample(A().userContext(), id(tid), obj(o)),
    // Music studio (the engine starts only on "music.start" or a generation; progress: "music:job", "music:setup").
    "music.setupStatus": (o) => S().musicSetup.status(obj(o)),
    "music.installRuntime": () => S().musicSetup.installRuntime(),
    "music.downloadSet": (sid) => S().musicSetup.download(str(sid, "set")),
    "music.importSet": (sid, folder) => S().musicSetup.importFrom(str(sid, "set"), str(folder, "folder")),
    "music.repairSet": (sid) => S().musicSetup.repair(str(sid, "set")),
    "music.setupCancel": () => S().musicSetup.cancel(),
    "music.setModelsDir": (dir) => { S().settings.set("music", { modelsDir: dir ? str(dir, "dir") : "" }); return S().musicSetup.status(); },
    "music.status": () => S().music.status(),
    "music.resources": () => S().music.resources(),
    "music.start": () => S().music.start(),
    "music.stop": () => S().music.stop(),
    "music.release": () => S().music.release(),
    "music.choices": async () => { const m = await import("../services/music/presets.js"); return { presets: m.COMPOSE_PRESETS, energies: m.ENERGIES, vibes: m.VIBES, meters: m.METERS, keys: m.KEYS, duration: m.DURATION }; },
    "music.interpret": async (text) => (await import("../services/music/presets.js")).interpret(String(text || "").slice(0, 1500)),
    "music.submit": (req) => S().music.submit(obj(req)),
    "music.cancel": (jid) => S().music.cancel(str(jid, "job")),
    "music.jobs": () => S().music.jobsList(),
    "music.library": (q) => S().music.library(obj(q)),
    "music.item": (lid) => S().music.item(str(lid, "id")),
    "music.rate": (lid, rating, reason) => S().music.rate(str(lid, "id"), rating ?? null, reason || ""),
    "music.rename": (lid, name) => S().music.rename(str(lid, "id"), str(name, "name")),
    "music.favorite": (lid, on) => { S().repos.library.update(str(lid, "id"), { favorite: !!on }); return S().music.item(lid); },
    "music.remove": (lid) => S().music.remove(str(lid, "id")),
    "music.saveAs": (lid, dest) => S().music.saveAs(str(lid, "id"), str(dest, "dest")),
    "music.addToProject": (lid, pid) => S().music.addToProject(str(lid, "id"), id(pid)),
    "music.addSource": async (file, name) => S().music.addSource(str(file, "file"), name ? String(name).slice(0, 120) : null),
    "music.addMediaSource": async (mid) => { const m = S().repos.media.get(id(mid)); return S().music.addSource(m.path, m.name); },
    "music.sources": () => S().music.sources(),
    "music.peaks": (lid) => S().music.peaks(str(lid, "id")),
    "music.templates": () => S().music.templates(),
    "music.saveTemplate": (name, settings) => S().music.saveTemplate(String(name || ""), obj(settings)),
    "music.removeTemplate": (tid) => S().music.removeTemplate(str(tid, "id")),
    // Video studio «توليد الفيديو» (the engine starts only on "video.start", a generation or an enhancement; progress: "video:job", "video:setup").
    "video.setupStatus": (o) => S().videoSetup.status(obj(o)),
    "video.installRuntime": () => S().videoSetup.installRuntime(),
    "video.acceptLicense": (sid) => S().videoSetup.accept(str(sid, "set")),
    "video.downloadSet": (sid) => S().videoSetup.download(str(sid, "set")),
    "video.importSet": (sid, folder) => S().videoSetup.importFrom(str(sid, "set"), str(folder, "folder")),
    "video.repairSet": (sid) => S().videoSetup.repair(str(sid, "set")),
    "video.setupCancel": () => S().videoSetup.cancel(),
    "video.setModelsDir": (dir) => { S().settings.set("video", { modelsDir: dir ? str(dir, "dir") : "" }); return S().videoSetup.status(); },
    "video.status": () => S().video.status(),
    "video.resources": () => S().video.resources(),
    "video.start": () => S().video.start(),
    "video.stop": () => S().video.stop(),
    "video.release": () => S().video.release(),
    "video.choices": () => S().video.choices(),
    "video.describe": (sel) => S().video.describe(obj(sel)),
    "video.saveDefaults": (o) => S().video.saveDefaults(obj(o)),
    "video.importTemplate": (file) => S().video.importTemplate(str(file, "file")),
    "video.removeTemplate": () => S().video.removeTemplate(),
    "video.addSource": (file, name) => S().video.addSource(str(file, "file"), name ? String(name).slice(0, 120) : null),
    "video.addMediaSource": (mid) => S().video.addMediaSource(id(mid)),
    "video.addRangeSource": (tid, startUs, endUs) => S().video.addRangeSource(id(tid), Number(startUs), Number(endUs)),
    "video.sources": () => S().video.sources(),
    "video.plan": (req) => S().video.plan(obj(req)),
    "video.submit": (req) => S().video.submit(obj(req)),
    "video.cancel": (jid) => S().video.cancel(str(jid, "job")),
    "video.jobs": () => S().video.jobsList(),
    "video.library": (q) => S().video.library(obj(q)),
    "video.item": (lid) => S().video.item(str(lid, "id")),
    "video.rate": (lid, rating, reason) => S().video.rate(str(lid, "id"), rating ?? null, reason || ""),
    "video.rename": (lid, name) => S().video.rename(str(lid, "id"), str(name, "name")),
    "video.favorite": (lid, on) => S().video.favorite(str(lid, "id"), !!on),
    "video.remove": (lid) => S().video.remove(str(lid, "id")),
    "video.saveAs": (lid, dest) => S().video.saveAs(str(lid, "id"), str(dest, "dest")),
    "video.addToProject": (lid, pid) => S().video.addToProject(str(lid, "id"), id(pid)),
    "video.addToTimeline": (lid, pid, atUs) => S().video.addToTimeline(str(lid, "id"), id(pid), atUs === null || atUs === undefined ? null : Math.max(0, Number(atUs) || 0)),
    // A motion graphic through the same operation as agents (person-aware templates get the head's track).
    "graphics.add": async (tid, o) => { const q = obj(o); return OPERATION_INDEX.get("timeline_add_graphic").run(A().userContext(), { timelineId: id(tid), template: str(q.template, "template"), params: q.params ? obj(q.params) : {}, atUs: Math.max(0, Number(q.atUs) || 0), durationUs: q.durationUs ? Number(q.durationUs) : undefined, inline: true }); },
    "captions.restyle": (tid, o) => restyleCaptions(A().userContext(), id(tid), obj(o)),
    // Text behind the person: person mattes of the videos the cutouts of a timeline use (made once, cached).
    "mattes.status": (force) => S().mattes.status(!!force),
    // Stabilized copies and person mattes the open timeline needs (progress events: "derived:progress").
    "mattes.prepare": async (tid) => {
      const tl = S().timelines.get(id(tid)).timeline;
      if (S().exporter.derivedReady(tl)) return { made: 0 };
      await S().exporter.prepareDerived(tl, (stage, p) => notifyAll("derived:progress", { stage, progress: p }));
      return { made: 1 };
    },
    "captions.importFile": (file) => S().captions.importFile(str(file, "file")),
    "captions.segmentsFromCues": (cues, o) => S().captions.segmentsFromCues(arr(cues, "cues"), obj(o)),
    "captions.transcribe": (o) => S().captions.transcribe(obj(o)),
    "tts.voices": () => S().tts.voices(),
    "tts.synthesize": (pid, o) => S().tts.synthesize(id(pid), obj(o)),
    "analysis.scenes": (mid, o) => S().analysis.scenes(id(mid), obj(o)),
    "analysis.silences": (mid, o) => S().analysis.silences(id(mid), obj(o)),
    "analysis.suggestions": (tid) => S().analysis.suggestions(S().timelines.get(id(tid)).timeline),
    "analysis.globalEditPatches": (tid, kind) => S().analysis.globalEditPatches(S().timelines.get(id(tid)).timeline, str(kind, "kind"), S().settings),
    "analysis.shortsCandidates": (mid, o) => S().analysis.shortsCandidates(id(mid), obj(o)),
    "assistant.plan": (text, ctx) => planFromText(str(text, "text"), obj(ctx)),

    // ---------------------------------------------------------------- backup, packages, share history
    "backup.create": (dir, o) => S().backup.backup(dir ? str(dir, "dir") : undefined, obj(o)),
    "backup.list": () => S().backup.list(),
    "backup.restore": async (dir) => { const r = await S().backup.restore(str(dir, "dir")); return r; },
    "package.export": (pid, file) => S().packages.exportPackage(id(pid), str(file, "file")),
    "package.import": (file) => S().packages.importPackage(str(file, "file")),
    "share.list": (direction) => S().repos.shares.list(direction || null),

    // ---------------------------------------------------------------- agents (MCP bridge) — management from the app
    "agents.status": () => {
      const a = A();
      return { enabled: S().settings.get("agents").enabled, listening: !!a.server, pipe: a.pipe || null, lastError: a.lastError || null, clients: a.clients.all().map((c) => a.clients.public(c)), scopes: ["read", "media", "edit", "skills.run", "skills.write", "export", "delete"], launch: mcpLaunch() };
    },
    "agents.createClient": (o) => {
      const q = obj(o);
      const r = A().clients.create({ name: q.name ? str(q.name, "name") : "Agent", scopes: q.scopes ? arr(q.scopes, "scopes") : ["read"], projects: q.projects === undefined ? "*" : q.projects, importRoots: q.importRoots ? arr(q.importRoots, "importRoots") : [], exportDir: q.exportDir || "" });
      return { ...r, config: mcpConfig(r.tokenFile) };
    },
    "agents.updateClient": (cid, patch) => A().clients.update(id(cid), obj(patch)),
    "agents.revokeClient": (cid) => A().clients.revoke(id(cid)),
    "agents.config": (cid) => mcpConfig(path.join(S().paths.agents, "tokens", `${id(cid)}.token`)),
    "agents.audit": (n) => A().recentAudit(Math.min(500, Number(n) || 100)),
    "agents.jobs": () => A().jobs.list(),
    "agents.respond": (rid, allow) => A().respond(str(rid, "id"), !!allow),
    "app.copyText": (text) => { clipboard.writeText(str(text, "text").slice(0, 20000)); return true; },

    // ---------------------------------------------------------------- skills (the user's own Skills panel)
    "skills.list": (q) => A().skills.list({ ...obj(q), includeDisabled: true }).map((s) => A().skills.card(s)),
    "skills.get": (sid, v) => A().skills.get(str(sid, "id"), v || null, { includeDisabled: true }),
    "skills.validate": (skill) => A().skills.validate(obj(skill)),
    "skills.buildFromText": (text, o) => A().skills.buildFromText(str(text, "text"), obj(o)),
    "skills.save": (skill) => A().skills.save(obj(skill), { author: "user" }),
    "skills.import": (file) => { const f = str(file, "file"); if (fs.statSync(f).size > 256 * 1024) throw new AppError("VALIDATION", "err.fileTooLarge"); return A().skills.importSkill(JSON.parse(fs.readFileSync(f, "utf8")), { from: path.basename(f) }); },
    "skills.export": (sid, file) => { fs.writeFileSync(str(file, "file"), JSON.stringify(A().skills.exportSkill(str(sid, "id")), null, 1)); return true; },
    "skills.remove": (sid) => A().skills.remove(str(sid, "id")),
    "skills.setEnabled": (sid, v) => A().skills.setEnabled(str(sid, "id"), !!v),
    "skills.history": (sid) => A().skills.history(sid ? str(sid, "id") : null),
    "skills.run": async (sid, tid, inputs) => {
      const hub = A();
      const ctx = hub.userContext();
      const job = hub.jobs.start({ kind: "skill", clientId: "user", label: str(sid, "id"), run: (j) => hub.runtime.run({ skillId: sid, timelineId: id(tid), inputs: obj(inputs), ctx, job: j }) });
      return hub.jobs.wait(job.jobId, 15 * 60_000, "user");
    },
    "skills.cancel": (jid) => A().jobs.cancel(str(jid, "jobId"), "user"),

    // ---------------------------------------------------------------- recording (FEAT-014)
    "record.sources": async () => (await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 240, height: 135 } })).map((x) => ({ id: x.id, name: x.name, thumbnail: x.thumbnail.toDataURL() })),
    "record.save": async (pid, bytes, ext) => {
      const e = ["webm", "wav", "ogg"].includes(ext) ? ext : "webm";
      const buf = Buffer.from(bytes);
      if (!buf.length) throw new AppError("VALIDATION", "err.recordingEmpty");
      const file = path.join(S().settings.get("draft").recordDir || S().paths.media, `record-${new Date().toISOString().replace(/[:.]/g, "-")}.${e}`);
      fs.writeFileSync(file, buf);
      const r = await S().media.importFiles(id(pid), [file], { origin: "record" });
      for (const m of r.imported) S().media.generateDerivatives(m.id).then((x) => notifyAll("media:updated", x)).catch(() => {});
      return r.imported[0] || null;
    },

    // ---------------------------------------------------------------- perception (Phase 4): one event timeline per media file
    "perception.status": () => S().perception.status(),
    "perception.analyze": (mid, o) => {
      const m = S().repos.media.get(id(mid));
      const q = obj(o);
      return S().perception.analyze(m.path, { stages: q.stages ? arr(q.stages, "stages").map(String) : undefined, options: q.options ? obj(q.options) : {}, onProgress: (p) => notifyAll("perception:progress", { mediaId: m.id, ...p }) });
    },
    "perception.timeline": (mid) => S().perception.cached(S().repos.media.get(id(mid)).path),
  };

  function notifyAll(event, payload) {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("api:event", event, payload);
  }

  ipcMain.handle("api:call", async (event, method, args) => {
    const fn = methods[method];
    if (!fn) return { ok: false, error: { code: "VALIDATION", messageKey: "err.unknownMethod", details: { method } } };
    if (!event.senderFrame?.url?.startsWith("app://")) return { ok: false, error: { code: "VALIDATION", messageKey: "err.forbidden", details: {} } };
    try {
      const data = await fn(...(Array.isArray(args) ? args : []));
      return { ok: true, data };
    } catch (err) {
      if (!(err instanceof AppError)) console.error(`[ipc] ${method}`, err);
      return { ok: false, error: toErrorEnvelope(err) };
    }
  });

  return { notifyAll, methods };
}

/**
 * How an MCP client starts the bridge: the app's own executable in Node mode (ELECTRON_RUN_AS_NODE) running
 * src/mcp/server.mjs — no separate Node install needed. In packaged builds the script and its modules load straight
 * from app.asar (Electron's Node mode reads ES modules from the archive).
 */
function mcpLaunch() {
  const script = path.join(app.getAppPath(), "src", "mcp", "server.mjs");
  return { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Ready-to-paste client configuration for one agent client (the token stays in its file). */
function mcpConfig(tokenFile) {
  const l = mcpLaunch();
  const env = { ...l.env, MONTAJ_USER_DATA: app.getPath("userData"), MONTAJ_TOKEN_FILE: tokenFile };
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  return {
    json: { mcpServers: { "montaj-studio": { command: l.command, args: l.args, env } } },
    claudeCode: `claude mcp add montaj-studio --scope user ${Object.entries(env).map(([k, v]) => `--env ${k}=${q(v)}`).join(" ")} -- ${q(l.command)} ${l.args.map(q).join(" ")}`,
    codexToml: `[mcp_servers.montaj-studio]
command = ${JSON.stringify(l.command)}
args = ${JSON.stringify(l.args)}
env = { ${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }
`,
  };
}

/** "Add Montaj Studio to Windows right-click menu" (Settings › General) — per-user registry keys only. */
async function setShellMenu(enabled) {
  if (process.platform !== "win32") throw new AppError("VALIDATION", "err.windowsOnly");
  const { execFile } = await import("node:child_process");
  const exe = process.execPath;
  const key = "HKCU\\Software\\Classes\\*\\shell\\MontajStudio";
  const runReg = (args) => new Promise((resolve, reject) => execFile("reg.exe", args, { windowsHide: true }, (e) => (e ? reject(new AppError("IO", "err.registry", { message: e.message })) : resolve())));
  if (enabled) {
    await runReg(["add", key, "/ve", "/d", "Open with Montaj Studio", "/f"]);
    await runReg(["add", key, "/v", "Icon", "/d", exe, "/f"]);
    await runReg(["add", `${key}\\command`, "/ve", "/d", `"${exe}" "%1"`, "/f"]);
  } else {
    await runReg(["delete", key, "/f"]).catch(() => {});
  }
  return enabled;
}
