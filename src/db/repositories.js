// Data Access Layer. Every write goes through a Realm write transaction; reads return plain objects.
import Realm from "realm";
import { write } from "./realmClient.js";
import { segmentToRealm, timelineFromRealm, mediaFromRealm, projectFromRealm } from "./mappers.js";
import { AppError, validateName, validateId } from "../core/validation.js";
import { newTimeline, timelineDuration } from "../core/model.js";
import { uid } from "../core/util.js";

const now = () => new Date();
const TRASH_DAYS = 30; // report FEAT-006: items kept up to 30 days

function must(obj, key = "err.notFound") {
  if (!obj || !obj.isValid?.()) throw new AppError("NOT_FOUND", key);
  return obj;
}

// ====================================================================== projects
export class ProjectRepository {
  constructor(realm) { this.realm = realm; }

  list({ status = "active", search = "", sort = "updatedAt", desc = true, isTemplate = false, workspaceId = null } = {}) {
    let res = this.realm.objects("Project").filtered("status == $0 AND isTemplate == $1", status, isTemplate);
    if (search) res = res.filtered("name CONTAINS[c] $0", search);
    if (workspaceId) res = res.filtered("ANY workspaces._id == $0", workspaceId);
    const key = ["updatedAt", "createdAt", "name", "durationUs", "sizeBytes", "lastOpenedAt"].includes(sort) ? sort : "updatedAt";
    return [...res.sorted(key, desc)].map(projectFromRealm);
  }

  names({ isTemplate = false } = {}) {
    return [...this.realm.objects("Project").filtered("isTemplate == $0", isTemplate)].map((p) => p.name);
  }

  get(id) { return projectFromRealm(must(this.realm.objectForPrimaryKey("Project", id), "err.projectNotFound")); }
  raw(id) { return must(this.realm.objectForPrimaryKey("Project", id), "err.projectNotFound"); }

  create({ name, canvas = {}, fps = 30, isTemplate = false, template = null }) {
    const clean = validateName(name);
    return write(this.realm, () => {
      const pid = uid();
      const tl = newTimeline(pid, { ratio: canvas.ratio || "original", width: canvas.width || 1920, height: canvas.height || 1080, fps });
      const timeline = this.realm.create("Timeline", {
        _id: tl.id, name: tl.name, order: 0, fps, isCompound: false, canvas: tl.canvas, markers: [], createdAt: now(), updatedAt: now(),
        tracks: tl.tracks.map((t) => ({ _id: t.id, type: t.type, order: t.order, isMain: t.isMain, name: t.name, role: t.role || "", segments: [] })),
      });
      const p = this.realm.create("Project", {
        _id: pid, name: clean, createdAt: now(), updatedAt: now(), lastOpenedAt: now(), status: "active",
        mainTimelineId: timeline._id, timelines: [timeline], media: [], tags: [], isTemplate, template,
      });
      return projectFromRealm(p);
    });
  }

  rename(id, name) {
    const clean = validateName(name);
    return write(this.realm, () => { const p = this.raw(id); p.name = clean; p.updatedAt = now(); return projectFromRealm(p); });
  }

  touch(id, { opened = false, editSeconds = 0 } = {}) {
    return write(this.realm, () => {
      const p = this.raw(id);
      p.updatedAt = now();
      if (opened) p.lastOpenedAt = now();
      if (editSeconds) p.realEditSeconds += Math.round(editSeconds);
    });
  }

  updateStats(id, { durationUs, sizeBytes, coverPath }) {
    return write(this.realm, () => {
      const p = this.raw(id);
      if (durationUs !== undefined) p.durationUs = Math.round(durationUs);
      if (sizeBytes !== undefined) p.sizeBytes = Math.round(sizeBytes);
      if (coverPath !== undefined) p.coverPath = coverPath;
      p.updatedAt = now();
    });
  }

  /** Deep copy: timelines, tracks and segments are duplicated; media assets are shared (same files). */
  duplicate(id, newName, { asTemplate = null, template = undefined } = {}) {
    const clean = validateName(newName);
    return write(this.realm, () => {
      const src = this.raw(id);
      const idMap = new Map();
      const copyTimeline = (t) => {
        const nt = this.realm.create("Timeline", {
          _id: uid(), name: t.name, order: t.order, fps: t.fps, isCompound: t.isCompound, canvas: t.canvas ? { ...t.canvas.toJSON() } : null,
          markers: t.markers.map((m) => ({ ...m.toJSON(), id: uid() })), createdAt: now(), updatedAt: now(), tracks: [],
        });
        idMap.set(t._id, nt);
        return nt;
      };
      const newTimelines = [...src.timelines].map(copyTimeline);
      for (const t of src.timelines) {
        const nt = idMap.get(t._id);
        for (const tr of t.tracks) {
          const segs = [...tr.segments].map((s) => {
            const j = s.toJSON();
            delete j.track;
            return this.realm.create("Segment", { ...j, _id: uid(), media: s.media || null, compoundTimeline: s.compoundTimeline ? idMap.get(s.compoundTimeline._id) || null : null });
          });
          nt.tracks.push(this.realm.create("Track", { _id: uid(), type: tr.type, order: tr.order, isMain: tr.isMain, name: tr.name, locked: tr.locked, hidden: tr.hidden, muted: tr.muted, role: tr.role || "", segments: segs }));
        }
      }
      const p = this.realm.create("Project", {
        _id: uid(), name: clean, createdAt: now(), updatedAt: now(), lastOpenedAt: null, status: "active",
        mainTimelineId: idMap.get(src.mainTimelineId)._id, timelines: newTimelines, media: [...src.media], tags: [...src.tags],
        durationUs: src.durationUs, sizeBytes: src.sizeBytes, coverPath: src.coverPath,
        isTemplate: asTemplate ?? src.isTemplate,
        template: template !== undefined ? template : src.template ? src.template.toJSON() : null,
      });
      return projectFromRealm(p);
    });
  }

  trash(id) {
    return write(this.realm, () => { const p = this.raw(id); p.status = "trashed"; p.trashedAt = now(); return projectFromRealm(p); });
  }

  restore(id) {
    return write(this.realm, () => { const p = this.raw(id); p.status = "active"; p.trashedAt = null; p.updatedAt = now(); return projectFromRealm(p); });
  }

  /** Permanently delete a project and everything it owns. Returns media file paths no longer referenced. */
  deleteForever(id) {
    return write(this.realm, () => {
      const p = this.raw(id);
      const orphanMedia = [];
      for (const t of p.timelines) {
        for (const tr of t.tracks) this.realm.delete(tr.segments);
        this.realm.delete(t.tracks);
      }
      this.realm.delete(p.timelines);
      for (const r of this.realm.objects("ExportRecord").filtered("project._id == $0", id)) r.project = null;
      const media = [...p.media];
      this.realm.delete(p);
      for (const m of media) {
        if (m.isValid() && m.projects.length === 0 && this.realm.objects("Segment").filtered("media._id == $0", m._id).length === 0) {
          orphanMedia.push({ id: m._id, origin: m.origin, path: m.path, thumbPath: m.thumbPath, waveformPath: m.waveformPath, proxyPath: m.proxyPath });
          this.realm.delete(m);
        }
      }
      return orphanMedia;
    });
  }

  daysLeft(p) {
    if (!p.trashedAt) return TRASH_DAYS;
    return Math.max(0, TRASH_DAYS - Math.floor((Date.now() - new Date(p.trashedAt).getTime()) / 86_400_000));
  }

  /** Purge projects trashed more than 30 days ago (run at startup). */
  purgeExpired(at = new Date()) {
    const cutoff = new Date(at.getTime() - TRASH_DAYS * 86_400_000);
    const ids = [...this.realm.objects("Project").filtered("status == 'trashed' AND trashedAt < $0", cutoff)].map((p) => p._id);
    const orphans = [];
    for (const id of ids) orphans.push(...this.deleteForever(id));
    return { purged: ids, orphans };
  }

  setTemplateInfo(id, info) {
    return write(this.realm, () => { const p = this.raw(id); p.isTemplate = true; p.template = { ...(p.template?.toJSON?.() || {}), ...info }; return projectFromRealm(p); });
  }
}

// ====================================================================== timelines
export class TimelineRepository {
  constructor(realm) { this.realm = realm; }

  raw(id) { return must(this.realm.objectForPrimaryKey("Timeline", id), "err.timelineNotFound"); }
  get(id) { return timelineFromRealm(this.raw(id)); }

  create(projectId, { name, canvas, fps = 30, isCompound = false } = {}) {
    return write(this.realm, () => {
      const p = must(this.realm.objectForPrimaryKey("Project", projectId), "err.projectNotFound");
      const tl = newTimeline(projectId, { name: name || `Timeline ${String(p.timelines.length + 1).padStart(2, "0")}`, ...(canvas || {}), fps });
      const t = this.realm.create("Timeline", {
        _id: tl.id, name: tl.name, order: p.timelines.length, fps, isCompound, canvas: canvas || tl.canvas, markers: [], createdAt: now(), updatedAt: now(),
        tracks: tl.tracks.map((tr) => ({ _id: tr.id, type: tr.type, order: tr.order, isMain: tr.isMain, name: tr.name, role: tr.role || "", segments: [] })),
      });
      p.timelines.push(t);
      p.updatedAt = now();
      return timelineFromRealm(t);
    });
  }

  rename(id, name) {
    const clean = validateName(name);
    return write(this.realm, () => { const t = this.raw(id); t.name = clean; t.updatedAt = now(); return timelineFromRealm(t); });
  }

  remove(id) {
    return write(this.realm, () => {
      const t = this.raw(id);
      const p = t.project[0];
      if (p && p.mainTimelineId === id) throw new AppError("VALIDATION", "err.cannotDeleteMainTimeline");
      if (this.realm.objects("Segment").filtered("compoundTimeline._id == $0", id).length) throw new AppError("VALIDATION", "err.timelineInUse");
      for (const tr of t.tracks) this.realm.delete(tr.segments);
      this.realm.delete(t.tracks);
      this.realm.delete(t);
      return true;
    });
  }

  /**
   * Persist a full plain timeline state (the editor's source of truth after each command).
   * Tracks and segments are upserted; tracks/segments that disappeared are deleted — all in one transaction.
   */
  saveState(state) {
    validateId(state.id, "timelineId");
    return write(this.realm, () => {
      const t = this.raw(state.id);
      t.name = state.name;
      t.fps = state.fps;
      t.canvas = state.canvas;
      t.markers = state.markers.map((m) => ({ id: m.id, timeUs: Math.round(m.timeUs), color: m.color, note: m.note || "" }));
      t.updatedAt = now();
      const keepSeg = new Set(), keepTrack = new Set();
      const tracks = [];
      for (const tr of state.tracks) {
        keepTrack.add(tr.id);
        const segs = tr.segments.map((s) => {
          keepSeg.add(s.id);
          return this.realm.create("Segment", segmentToRealm(s, this.realm), Realm.UpdateMode.Modified);
        });
        const track = this.realm.create("Track", { _id: tr.id, type: tr.type, order: tr.order, isMain: tr.isMain, name: tr.name || "", locked: !!tr.locked, hidden: !!tr.hidden, muted: !!tr.muted, role: tr.role || "" }, Realm.UpdateMode.Modified);
        track.segments.splice(0, track.segments.length, ...segs);
        tracks.push(track);
      }
      for (const old of [...t.tracks]) {
        // A removed track's segments go too — except those moved to a kept track (same id, now in its list).
        if (!keepTrack.has(old._id)) { for (const s of [...old.segments]) if (!keepSeg.has(s._id)) this.realm.delete(s); this.realm.delete(old); continue; }
        for (const s of [...old.segments]) if (!keepSeg.has(s._id)) this.realm.delete(s);
      }
      t.tracks.splice(0, t.tracks.length, ...tracks);
      // Orphaned segments (removed from every list) are deleted too.
      for (const s of this.realm.objects("Segment").filtered("track.@count == 0")) this.realm.delete(s);
      const p = t.project[0];
      if (p) { p.updatedAt = now(); if (p.mainTimelineId === t._id) p.durationUs = timelineDuration(state); }
      return true;
    });
  }
}

// ====================================================================== media
export class MediaRepository {
  constructor(realm) { this.realm = realm; }

  get(id) { return mediaFromRealm(must(this.realm.objectForPrimaryKey("MediaAsset", id), "err.mediaNotFound")); }
  find(id) { const m = this.realm.objectForPrimaryKey("MediaAsset", id); return m ? mediaFromRealm(m) : null; }

  listByProject(projectId, { type = null, search = "", favorite = false } = {}) {
    const p = must(this.realm.objectForPrimaryKey("Project", projectId), "err.projectNotFound");
    let items = [...p.media];
    if (type) items = items.filter((m) => m.type === type);
    if (search) items = items.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));
    if (favorite) items = items.filter((m) => m.favorite);
    return items.map(mediaFromRealm);
  }

  /** Add (or reuse by path) a media asset and attach it to the project. */
  add(projectId, meta) {
    return write(this.realm, () => {
      const p = must(this.realm.objectForPrimaryKey("Project", projectId), "err.projectNotFound");
      // An imported file (or a bundled sound effect) is one media item, reused by every project that adds it.
      let m = meta.origin === "import" || meta.origin === "sfx" ? this.realm.objects("MediaAsset").filtered("path == $0 AND origin == $1", meta.path, meta.origin)[0] : null;
      if (!m) {
        m = this.realm.create("MediaAsset", {
          _id: meta.id || uid(), name: meta.name, path: meta.path, type: meta.type, durationUs: Math.round(meta.durationUs || 0),
          width: meta.width || 0, height: meta.height || 0, fps: meta.fps || 0, hasAudio: !!meta.hasAudio, hasVideo: !!meta.hasVideo,
          videoCodec: meta.videoCodec || "", audioCodec: meta.audioCodec || "", sampleRate: meta.sampleRate || 0, channels: meta.channels || 0,
          sizeBytes: Math.round(meta.sizeBytes || 0), importedAt: now(), status: "ready", origin: meta.origin || "import",
          derivedFrom: meta.derivedFromId ? this.realm.objectForPrimaryKey("MediaAsset", meta.derivedFromId) : null,
        });
      }
      if (!p.media.some((x) => x._id === m._id)) p.media.push(m);
      return mediaFromRealm(m);
    });
  }

  update(id, patch) {
    const allowed = ["thumbPath", "thumbCount", "waveformPath", "proxyPath", "status", "favorite", "name", "path"];
    return write(this.realm, () => {
      const m = must(this.realm.objectForPrimaryKey("MediaAsset", id), "err.mediaNotFound");
      for (const [k, v] of Object.entries(patch)) if (allowed.includes(k)) m[k] = v;
      return mediaFromRealm(m);
    });
  }

  usageCount(id) { return this.realm.objects("Segment").filtered("media._id == $0", id).length; }

  /** Detach from a project; refused while a segment still uses it. */
  detach(projectId, id) {
    return write(this.realm, () => {
      const p = must(this.realm.objectForPrimaryKey("Project", projectId), "err.projectNotFound");
      const used = [...p.timelines].some((t) => [...t.tracks].some((tr) => [...tr.segments].some((s) => s.media?._id === id)));
      if (used) throw new AppError("VALIDATION", "err.mediaInUse");
      const i = p.media.findIndex((m) => m._id === id);
      if (i >= 0) p.media.remove(i);
      return true;
    });
  }
}

// ====================================================================== settings & shortcuts
export class SettingsRepository {
  constructor(realm) { this.realm = realm; }
  get(key, fallback = null) {
    const s = this.realm.objectForPrimaryKey("Setting", key);
    if (!s) return fallback;
    try { return JSON.parse(s.value); } catch { return fallback; }
  }
  set(key, value) {
    return write(this.realm, () => { this.realm.create("Setting", { key, value: JSON.stringify(value), updatedAt: now() }, Realm.UpdateMode.Modified); return value; });
  }
  all() { return Object.fromEntries([...this.realm.objects("Setting")].map((s) => [s.key, JSON.parse(s.value)])); }
}

export class ShortcutRepository {
  constructor(realm) { this.realm = realm; }
  ensure(defaults) {
    return write(this.realm, () => {
      for (const id of [1, 2, 3, 4, 5]) {
        const existing = this.realm.objectForPrimaryKey("ShortcutPreset", id);
        if (!existing) this.realm.create("ShortcutPreset", { id, name: `Shortcut ${id}`, bindings: defaults });
        else for (const [k, v] of Object.entries(defaults)) if (!(k in existing.bindings)) existing.bindings[k] = v; // new commands after upgrades
      }
    });
  }
  get(id) {
    const p = must(this.realm.objectForPrimaryKey("ShortcutPreset", id), "err.presetNotFound");
    return { id: p.id, name: p.name, bindings: { ...p.bindings } };
  }
  save(id, bindings) {
    return write(this.realm, () => { const p = must(this.realm.objectForPrimaryKey("ShortcutPreset", id), "err.presetNotFound"); p.bindings = bindings; return this.get(id); });
  }
}

// ====================================================================== library / workspaces / exports / shares
export class LibraryRepository {
  constructor(realm) { this.realm = realm; }
  list({ kind = null, category = null, search = "", favorite = false, sort = "createdAt" } = {}) {
    let r = this.realm.objects("LibraryItem");
    if (kind) r = r.filtered("kind == $0", kind);
    if (category) r = r.filtered("category == $0", category);
    if (search) r = r.filtered("name CONTAINS[c] $0", search);
    if (favorite) r = r.filtered("favorite == true");
    return [...r.sorted(sort === "name" ? "name" : "createdAt", sort !== "name")].map((i) => ({ id: i._id, kind: i.kind, category: i.category, name: i.name, path: i.path, favorite: i.favorite, createdAt: i.createdAt.toISOString(), durationUs: i.durationUs, sizeBytes: i.sizeBytes, meta: JSON.parse(i.meta || "{}") }));
  }
  add({ kind, category = "yours", name, path, durationUs = 0, sizeBytes = 0, meta = {} }) {
    validateName(name);
    return write(this.realm, () => this.realm.create("LibraryItem", { _id: uid(), kind, category, name, path, durationUs: Math.round(durationUs), sizeBytes: Math.round(sizeBytes), meta: JSON.stringify(meta), createdAt: now() })._id);
  }
  update(id, patch) {
    return write(this.realm, () => {
      const i = must(this.realm.objectForPrimaryKey("LibraryItem", id));
      if (patch.name !== undefined) i.name = validateName(patch.name);
      if (patch.favorite !== undefined) i.favorite = !!patch.favorite;
      if (patch.category !== undefined) i.category = patch.category;
      if (patch.meta !== undefined) i.meta = typeof patch.meta === "string" ? patch.meta : JSON.stringify(patch.meta);
      return true;
    });
  }
  remove(id) { return write(this.realm, () => { const i = must(this.realm.objectForPrimaryKey("LibraryItem", id)); const p = i.path; this.realm.delete(i); return p; }); }
}

export class WorkspaceRepository {
  constructor(realm) { this.realm = realm; }
  list() { return [...this.realm.objects("Workspace").sorted("createdAt")].map((w) => this.toPlain(w)); }
  toPlain(w) { return { id: w._id, name: w.name, color: w.color, quotaBytes: w.quotaBytes, createdAt: w.createdAt.toISOString(), projectIds: w.projects.filter((p) => p.status === "active").map((p) => p._id), usedBytes: w.projects.reduce((a, p) => a + p.sizeBytes, 0) }; }
  create(name, color = "#00C1CD", quotaBytes = 0) { const n = validateName(name); return write(this.realm, () => this.toPlain(this.realm.create("Workspace", { _id: uid(), name: n, color, createdAt: now(), quotaBytes: Math.round(quotaBytes), projects: [] }))); }
  rename(id, name) { const n = validateName(name); return write(this.realm, () => { const w = must(this.realm.objectForPrimaryKey("Workspace", id)); w.name = n; return this.toPlain(w); }); }
  remove(id) { return write(this.realm, () => { this.realm.delete(must(this.realm.objectForPrimaryKey("Workspace", id))); return true; }); }
  addProject(id, projectId) {
    return write(this.realm, () => {
      const w = must(this.realm.objectForPrimaryKey("Workspace", id));
      const p = must(this.realm.objectForPrimaryKey("Project", projectId), "err.projectNotFound");
      if (!w.projects.some((x) => x._id === projectId)) w.projects.push(p);
      return this.toPlain(w);
    });
  }
  removeProject(id, projectId) {
    return write(this.realm, () => { const w = must(this.realm.objectForPrimaryKey("Workspace", id)); const i = w.projects.findIndex((x) => x._id === projectId); if (i >= 0) w.projects.remove(i); return this.toPlain(w); });
  }
}

export class ExportRepository {
  constructor(realm) { this.realm = realm; }
  create({ projectId, projectName, path, kind = "video", settings = {} }) {
    return write(this.realm, () => this.realm.create("ExportRecord", {
      _id: uid(), project: projectId ? this.realm.objectForPrimaryKey("Project", projectId) : null, projectName, path, kind,
      settings: JSON.stringify(settings), status: "running", progress: 0, startedAt: now(),
    })._id);
  }
  update(id, patch) {
    return write(this.realm, () => {
      const r = must(this.realm.objectForPrimaryKey("ExportRecord", id));
      for (const k of ["status", "progress", "sizeBytes", "error"]) if (patch[k] !== undefined) r[k] = patch[k];
      if (patch.status && patch.status !== "running") r.finishedAt = now();
    });
  }
  list({ projectId = null, kind = null } = {}) {
    let r = this.realm.objects("ExportRecord");
    if (projectId) r = r.filtered("project._id == $0", projectId);
    if (kind) r = r.filtered("kind == $0", kind);
    return [...r.sorted("startedAt", true)].map((x) => ({ id: x._id, projectId: x.project?._id ?? null, projectName: x.projectName, path: x.path, kind: x.kind, settings: JSON.parse(x.settings), status: x.status, progress: x.progress, startedAt: x.startedAt.toISOString(), finishedAt: x.finishedAt?.toISOString() ?? null, sizeBytes: x.sizeBytes, error: x.error ?? null }));
  }
  remove(id) { return write(this.realm, () => { this.realm.delete(must(this.realm.objectForPrimaryKey("ExportRecord", id))); return true; }); }
  /** Exports interrupted by a crash/quit are marked failed on the next start. */
  failInterrupted() { return write(this.realm, () => { for (const r of this.realm.objects("ExportRecord").filtered("status == 'running'")) { r.status = "failed"; r.error = "interrupted"; r.finishedAt = now(); } }); }
}

export class ShareRepository {
  constructor(realm) { this.realm = realm; }
  create({ projectId, projectName, packagePath, direction = "out" }) {
    return write(this.realm, () => this.realm.create("ShareRecord", { _id: uid(), project: projectId ? this.realm.objectForPrimaryKey("Project", projectId) : null, projectName, packagePath, createdAt: now(), direction })._id);
  }
  list(direction = null) {
    let r = this.realm.objects("ShareRecord");
    if (direction) r = r.filtered("direction == $0", direction);
    return [...r.sorted("createdAt", true)].map((s) => ({ id: s._id, projectId: s.project?._id ?? null, projectName: s.projectName, packagePath: s.packagePath, createdAt: s.createdAt.toISOString(), direction: s.direction }));
  }
}

export function createRepositories(realm) {
  return {
    projects: new ProjectRepository(realm), timelines: new TimelineRepository(realm), media: new MediaRepository(realm),
    settings: new SettingsRepository(realm), shortcuts: new ShortcutRepository(realm), library: new LibraryRepository(realm),
    workspaces: new WorkspaceRepository(realm), exports: new ExportRepository(realm), shares: new ShareRepository(realm),
  };
}
