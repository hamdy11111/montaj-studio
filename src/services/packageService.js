// Project packages (.mstudio = zip): the local, offline equivalent of "Share project" (FEAT-120) and
// "Share history" (FEAT-121, Shared by you / Shared with you). Uses the tar.exe (bsdtar) shipped with Windows 10+.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AppError, validateName } from "../core/validation.js";
import { uid } from "../core/util.js";
import { uniqueName } from "../core/naming.js";

const FORMAT = 1;

// Always use Windows' own bsdtar (System32) — another "tar" on PATH (e.g. GNU tar from Git) cannot write zip.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

function tar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(TAR, args, { cwd, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(new AppError("IO", "err.packageTool", { message: e.message })));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new AppError("IO", "err.packageFailed", { stderr: err.slice(-1000) }))));
  });
}

export class PackageService {
  constructor({ repos, paths, media }) {
    this.repos = repos;
    this.paths = paths;
    this.media = media;
  }

  async exportPackage(projectId, destFile) {
    const p = this.repos.projects.get(projectId);
    const work = path.join(this.paths.packages, `out-${uid()}`);
    fs.mkdirSync(path.join(work, "media"), { recursive: true });
    try {
      const media = this.repos.media.listByProject(projectId);
      const files = {};
      for (const m of media) {
        if (!fs.existsSync(m.path)) throw new AppError("MEDIA", "err.mediaMissingPackage", { name: m.name });
        const name = `${m.id}${path.extname(m.path)}`;
        fs.copyFileSync(m.path, path.join(work, "media", name));
        files[m.id] = name;
      }
      const timelines = p.timelines.map((t) => this.repos.timelines.get(t.id));
      const doc = { format: FORMAT, app: "Montaj Studio", exportedAt: new Date().toISOString(), project: { name: p.name, mainTimelineId: p.mainTimelineId, tags: p.tags }, timelines,
        media: media.map((m) => ({ ...m, file: files[m.id], thumbPath: null, waveformPath: null, proxyPath: null })) };
      fs.writeFileSync(path.join(work, "project.json"), JSON.stringify(doc));
      fs.rmSync(destFile, { force: true });
      await tar(["--format", "zip", "-c", "-f", destFile, "project.json", "media"], work);
      this.repos.shares.create({ projectId, projectName: p.name, packagePath: destFile, direction: "out" });
      return { path: destFile, sizeBytes: fs.statSync(destFile).size };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async importPackage(file) {
    if (!fs.existsSync(file)) throw new AppError("IO", "err.fileNotFound", { file });
    const dest = path.join(this.paths.packages, `in-${uid()}`);
    fs.mkdirSync(dest, { recursive: true });
    await tar(["-x", "-f", file], dest);
    const docFile = path.join(dest, "project.json");
    if (!fs.existsSync(docFile)) throw new AppError("VALIDATION", "err.packageInvalid");
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    if (doc.app !== "Montaj Studio" || doc.format > FORMAT) throw new AppError("VALIDATION", "err.packageInvalid");
    const name = uniqueName(validateName(doc.project.name), this.repos.projects.names());
    const main = doc.timelines.find((t) => t.id === doc.project.mainTimelineId) || doc.timelines[0];
    const p = this.repos.projects.create({ name, canvas: main.canvas, fps: main.fps });
    // Re-create media with new ids pointing to the extracted files.
    const idMap = {};
    for (const m of doc.media) {
      const filePath = path.join(dest, "media", path.basename(m.file));
      const created = this.repos.media.add(p.id, { ...m, id: undefined, path: filePath, origin: m.origin === "import" ? "import" : m.origin });
      idMap[m.id] = created.id;
      this.media.generateDerivatives(created.id).catch(() => {});
    }
    const tlMap = {};
    const created = this.repos.projects.get(p.id);
    tlMap[main.id] = created.mainTimelineId;
    for (const t of doc.timelines) if (t.id !== main.id) tlMap[t.id] = this.repos.timelines.create(p.id, { name: t.name, canvas: t.canvas, fps: t.fps, isCompound: t.isCompound }).id;
    for (const t of doc.timelines) {
      const state = JSON.parse(JSON.stringify(t));
      state.id = tlMap[t.id];
      state.projectId = p.id;
      for (const tr of state.tracks) {
        tr.id = uid();
        for (const s of tr.segments) {
          s.id = uid();
          if (s.mediaId) s.mediaId = idMap[s.mediaId] || null;
          if (s.compoundTimelineId) s.compoundTimelineId = tlMap[s.compoundTimelineId] || null;
          s.keyframes = (s.keyframes || []).map((k) => ({ ...k, id: uid() }));
        }
      }
      if (state.id === created.mainTimelineId) state.tracks.forEach((tr) => { if (tr.isMain) { const existing = this.repos.timelines.get(state.id).tracks.find((x) => x.isMain); tr.id = existing.id; } });
      this.repos.timelines.saveState(state);
    }
    this.repos.shares.create({ projectId: p.id, projectName: name, packagePath: file, direction: "in" });
    return this.repos.projects.get(p.id);
  }
}
