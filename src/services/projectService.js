// Projects, templates, timelines and covers (FEAT-001..010, FEAT-034, FEAT-146 templates, FEAT-106 shorts).
import fs from "node:fs";
import path from "node:path";
import { defaultProjectName, duplicateName, uniqueName } from "../core/naming.js";
import { AppError, validateEnum } from "../core/validation.js";
import { canvasSize, CANVAS_RATIOS, mainTrack, timelineDuration } from "../core/model.js";
import { US } from "../core/util.js";

export class ProjectService {
  constructor({ repos, paths, media, settings, timelines }) {
    this.repos = repos;
    this.paths = paths;
    this.media = media;
    this.settings = settings;
    this.timelines = timelines;
  }

  list(q = {}) {
    const items = this.repos.projects.list(q);
    return q.status === "trashed" ? items.map((p) => ({ ...p, daysLeft: this.repos.projects.daysLeft(p) })) : items;
  }

  create({ name = null, ratio = "original", template = null } = {}) {
    const existing = this.repos.projects.names();
    const n = name ? uniqueName(name.trim(), existing) : defaultProjectName(existing);
    validateEnum(ratio, Object.keys(CANVAS_RATIOS), "ratio");
    const size = canvasSize(ratio, 1080);
    return this.repos.projects.create({ name: n, canvas: { ratio, ...size }, fps: this.settings.get("edit").fps || 30, template });
  }

  rename(id, name) {
    const p = this.repos.projects.get(id);
    if (p.name === name.trim()) return p;
    const taken = this.repos.projects.names({ isTemplate: p.isTemplate }).filter((x) => x !== p.name);
    if (taken.some((x) => x.toLowerCase() === name.trim().toLowerCase())) throw new AppError("CONFLICT", "err.nameTaken");
    return this.repos.projects.rename(id, name);
  }

  duplicate(id) {
    const p = this.repos.projects.get(id);
    return this.repos.projects.duplicate(id, duplicateName(p.name, this.repos.projects.names({ isTemplate: p.isTemplate })));
  }

  /** Open in the editor: verify media files, refresh stats and return everything the editor needs. */
  open(id) {
    const p = this.repos.projects.get(id);
    if (p.status !== "active") throw new AppError("VALIDATION", "err.projectTrashed");
    const missing = this.media.verifyProject(id);
    this.repos.projects.touch(id, { opened: true });
    return { project: this.repos.projects.get(id), missingMedia: missing };
  }

  /** Called when leaving the editor: recompute size/duration and refresh the cover image. */
  async finalize(id, { editSeconds = 0 } = {}) {
    const p = this.repos.projects.get(id);
    const media = this.repos.media.listByProject(id);
    const sizeBytes = media.reduce((a, m) => a + (m.sizeBytes || 0), 0);
    const tl = this.repos.timelines.get(p.mainTimelineId);
    let coverPath = p.coverPath;
    const first = mainTrack(tl)?.segments[0];
    const custom = path.join(this.paths.thumbs, `cover-${id}-custom.jpg`);
    if (fs.existsSync(custom)) coverPath = custom; // chosen with "Edit cover" (FEAT-033) — keep it
    else if (first?.mediaId) {
      try {
        const out = path.join(this.paths.thumbs, `cover-${id}.jpg`);
        await this.media.frameAt(first.mediaId, first.sourceStart + Math.min(first.duration / 2, US), out);
        coverPath = out;
      } catch { /* cover is optional */ }
    } else coverPath = null;
    this.repos.projects.updateStats(id, { durationUs: timelineDuration(tl), sizeBytes, coverPath });
    if (editSeconds) this.repos.projects.touch(id, { editSeconds });
    for (const t of p.timelines) this.timelines.close(t.id);
    return this.repos.projects.get(id);
  }

  /** Edit cover (FEAT-033): use the main-track frame at `atUs` as the project cover; `reset` returns to auto. */
  async setCover(id, { atUs = 0, reset = false } = {}) {
    const p = this.repos.projects.get(id);
    const custom = path.join(this.paths.thumbs, `cover-${id}-custom.jpg`);
    if (reset) { fs.rmSync(custom, { force: true }); return this.finalize(id); }
    const tl = this.repos.timelines.get(p.mainTimelineId);
    const seg = mainTrack(tl)?.segments.find((s) => atUs >= s.start && atUs < s.start + s.duration && s.mediaId);
    if (!seg) throw new AppError("VALIDATION", "err.coverNoFrame");
    const local = atUs - seg.start;
    await this.media.frameAt(seg.mediaId, seg.kind === "image" ? 0 : seg.sourceStart + local * (seg.speedMode === "curve" ? 1 : seg.speed || 1), custom);
    this.repos.projects.updateStats(id, { coverPath: custom });
    return this.repos.projects.get(id);
  }

  trash(id) { return this.repos.projects.trash(id); }
  restore(id) { return this.repos.projects.restore(id); }

  /** Permanent delete; removes app-owned files (TTS, recordings, reversed/freeze clips, caches). */
  deleteForever(id) {
    const orphans = this.repos.projects.deleteForever(id);
    for (const o of orphans) {
      for (const f of [o.thumbPath, o.waveformPath, o.proxyPath]) if (f) fs.rmSync(f, { force: true });
      if (o.origin !== "import" && o.path && path.resolve(o.path).startsWith(path.resolve(this.paths.media))) fs.rmSync(o.path, { force: true });
    }
    fs.rmSync(path.join(this.paths.thumbs, `cover-${id}.jpg`), { force: true });
    fs.rmSync(path.join(this.paths.thumbs, `cover-${id}-custom.jpg`), { force: true });
    return orphans.length;
  }

  purgeExpired() {
    const { purged } = this.repos.projects.purgeExpired();
    return purged.length;
  }

  // ------------------------------------------------------------------ timelines (FEAT-034)
  createTimeline(projectId, name) {
    const p = this.repos.projects.get(projectId);
    const main = this.repos.timelines.get(p.mainTimelineId);
    return this.repos.timelines.create(projectId, { name, canvas: main.canvas, fps: main.fps });
  }
  renameTimeline(id, name) { return this.repos.timelines.rename(id, name); }
  deleteTimeline(id) { this.timelines.close(id); return this.repos.timelines.remove(id); }

  // ------------------------------------------------------------------ templates (FEAT-096 / FEAT-146)
  saveAsTemplate(projectId, { name, category = "general", description = "" }) {
    const p = this.repos.projects.get(projectId);
    const tl = this.repos.timelines.get(p.mainTimelineId);
    const clips = mainTrack(tl)?.segments.length || 0;
    const orientation = tl.canvas.width > tl.canvas.height ? "landscape" : tl.canvas.width < tl.canvas.height ? "portrait" : "square";
    const tName = uniqueName((name || p.name).trim(), this.repos.projects.names({ isTemplate: true }));
    return this.repos.projects.duplicate(projectId, tName, { asTemplate: true, template: { category, description, orientation, clipCount: clips, usageCount: 0, favorite: false } });
  }

  listTemplates({ search = "", orientation = "all", clips = "any", duration = "any", category = null, favorite = false, sort = "updatedAt" } = {}) {
    let items = this.repos.projects.list({ isTemplate: true, search, sort });
    if (orientation !== "all") items = items.filter((t) => t.template?.orientation === orientation);
    if (category) items = items.filter((t) => t.template?.category === category);
    if (favorite) items = items.filter((t) => t.template?.favorite);
    const inRange = (n, spec) => {
      if (spec === "any") return true;
      if (spec.includes("-")) { const [a, b] = spec.split("-").map(Number); return n >= a && n <= b; }
      if (spec.startsWith(">")) return n > Number(spec.slice(1));
      return n === Number(spec);
    };
    items = items.filter((t) => inRange(t.template?.clipCount || 0, clips));
    if (duration !== "any") items = items.filter((t) => inRange(t.durationUs / US, duration));
    return items;
  }

  useTemplate(templateId) {
    const t = this.repos.projects.get(templateId);
    if (!t.isTemplate) throw new AppError("VALIDATION", "err.notTemplate");
    const p = this.repos.projects.duplicate(templateId, defaultProjectName(this.repos.projects.names()), { asTemplate: false, template: null });
    this.repos.projects.setTemplateInfo(templateId, { usageCount: (t.template?.usageCount || 0) + 1 });
    // setTemplateInfo marks isTemplate=true; it already is for the template itself.
    return p;
  }

  toggleTemplateFavorite(templateId) {
    const t = this.repos.projects.get(templateId);
    return this.repos.projects.setTemplateInfo(templateId, { favorite: !t.template?.favorite });
  }

  // ------------------------------------------------------------------ shorts (FEAT-106 local alternative)
  async createShorts(projectId, mediaId, candidates, { ratio = "9:16" } = {}) {
    const src = this.repos.media.get(mediaId);
    const base = this.repos.projects.get(projectId);
    const created = [];
    let i = 1;
    for (const c of candidates) {
      const p = this.create({ name: `${base.name} short ${i++}`, ratio });
      this.repos.media.add(p.id, { ...src, origin: src.origin, id: src.id });
      const tid = p.mainTimelineId;
      await this.timelines.exec(tid, "addMedia", { mediaId: src.id });
      const st = this.timelines.get(tid).timeline;
      const seg = st.tracks[0].segments[0];
      await this.timelines.exec(tid, "trim", { segId: seg.id, edge: "start", timeUs: c.startUs });
      const st2 = this.timelines.get(tid).timeline;
      const seg2 = st2.tracks[0].segments[0];
      await this.timelines.exec(tid, "trim", { segId: seg2.id, edge: "end", timeUs: c.endUs - c.startUs });
      // Fill the vertical frame (centre crop, the local equivalent of auto reframe).
      const cover = Math.max(st2.canvas.width / (src.width || 1), st2.canvas.height / (src.height || 1)) / Math.min(st2.canvas.width / (src.width || 1), st2.canvas.height / (src.height || 1));
      await this.timelines.exec(tid, "updateSegment", { segId: seg2.id, patch: { transform: { scale: Number(cover.toFixed(4)) } } });
      created.push(this.repos.projects.get(p.id));
    }
    return created;
  }
}
