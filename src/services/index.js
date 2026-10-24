// Composition root: builds every service over one Realm instance. Used by the Electron main process and tests.
import { openDatabase } from "../db/realmClient.js";
import { createRepositories } from "../db/repositories.js";
import { makePaths } from "./paths.js";
import { MediaService } from "./mediaService.js";
import { SettingsService } from "./settingsService.js";
import { TimelineService } from "./timelineService.js";
import { ExportService } from "./exportService.js";
import { ProjectService } from "./projectService.js";
import { AnalysisService } from "./analysisService.js";
import { TtsService } from "./ttsService.js";
import { CaptionService } from "./captionService.js";
import { MatteService } from "./matteService.js";
import { StabilizeService } from "./stabilizeService.js";
import { BackupService } from "./backupService.js";
import { PackageService } from "./packageService.js";
import { setBinaries } from "./ffmpeg.js";
import { defaultBindings } from "../core/shortcuts.js";

export async function createServices({ root, appVersion = "1.0.0", notify = () => {}, log = () => {} }) {
  const paths = makePaths(root);
  const realm = await openDatabase({ file: paths.db });
  const repos = createRepositories(realm);
  repos.shortcuts.ensure(defaultBindings());
  repos.exports.failInterrupted();
  const settings = new SettingsService({ repos, paths });
  const perf = settings.get("performance");
  if (perf.ffmpegPath || perf.ffprobePath) {
    try { setBinaries({ ffmpeg: perf.ffmpegPath || undefined, ffprobe: perf.ffprobePath || undefined }); } catch (e) { log("custom ffmpeg rejected", e.message); setBinaries({}); }
  }
  const media = new MediaService({ repos, paths, log, notify, shouldProxy: () => settings.get("performance").proxy });
  const analysis = new AnalysisService({ repos });
  const timelines = new TimelineService({ repos, media, settings, analysis });
  const exporter = new ExportService({ repos, paths, settings, notify });
  timelines.exporter = exporter;
  const projects = new ProjectService({ repos, paths, media, settings, timelines });
  const tts = new TtsService({ paths, media });
  const captions = new CaptionService({ repos, paths, settings });
  const mattes = new MatteService({ repos, paths, settings, log, notify });
  const stabilizer = new StabilizeService({ repos, paths, log, notify });
  exporter.mattes = mattes;
  exporter.stabilizer = stabilizer;
  exporter.captions = captions;
  const backup = new BackupService({
    paths, appVersion,
    onReopen: (r) => { Object.assign(repos, createRepositories(r)); timelines.open.clear(); },
  });
  const packages = new PackageService({ repos, paths, media });
  const purged = projects.purgeExpired();
  if (settings.get("draft").autoBackup) { try { backup.autoBackup(); } catch (e) { log("auto backup failed", e.message); } }
  return { paths, repos, settings, media, analysis, timelines, exporter, projects, tts, captions, mattes, stabilizer, backup, packages, startup: { purged } };
}
