// Composition root: builds every service over one Realm instance. Used by the Electron main process and tests.
import path from "node:path";
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
import { AsrSetupService } from "./asrSetupService.js";
import { MatteService } from "./matteService.js";
import { StabilizeService } from "./stabilizeService.js";
import { DubService } from "./dubService.js";
import { DubSetupService } from "./dubSetupService.js";
import { MusicSetupService } from "./musicSetupService.js";
import { GpuQueue } from "./gpuQueue.js";
import { VideoSetupService } from "./videoSetupService.js";
import { VideoService } from "./videoService.js";
import { MusicService } from "./musicService.js";
import { BackupService } from "./backupService.js";
import { PackageService } from "./packageService.js";
import { setBinaries } from "./ffmpeg.js";
// Phase 9 media
import { SfxLibraryService } from "./sfxLibrary.js";
import { BrollService } from "./brollService.js";
import { ImagegenService } from "./imagegenService.js";
import { defaultBindings } from "../core/shortcuts.js";
import { binaries } from "./ffmpeg.js";
import { PerceptionService, makeGpuLock } from "./perception/perceptionService.js";
import { TakeService } from "./takes/takeService.js";
import { LinkService } from "./links/linkService.js";

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
  const asrSetup = new AsrSetupService({ paths, notify, log });
  const mattes = new MatteService({ repos, paths, settings, log, notify });
  const stabilizer = new StabilizeService({ repos, paths, log, notify });
  const dubber = new DubService({ repos, paths, notify, log });
  const dubSetup = new DubSetupService({ paths, notify, log });
  // Music studio: nothing starts here; the engine starts only when the user asks.
  const musicSetup = new MusicSetupService({ paths, settings, notify, log });
  const gpu = new GpuQueue({ exporter });
  const music = new MusicService({ repos, paths, settings, media, setup: musicSetup, exporter, gpu, notify, log });
  // Video studio («توليد الفيديو»): the same — nothing starts here; one heavy GPU job at a time with the music (gpu).
  const videoSetup = new VideoSetupService({ paths, settings, notify, log });
  const video = new VideoService({ repos, paths, settings, media, timelines, setup: videoSetup, exporter, gpu, notify, log });
  exporter.mattes = mattes;
  exporter.stabilizer = stabilizer;
  exporter.captions = captions;
  const backup = new BackupService({
    paths, appVersion,
    onReopen: (r) => { Object.assign(repos, createRepositories(r)); timelines.open.clear(); },
  });
  const packages = new PackageService({ repos, paths, media });
  // Phase 9 media: the sound library and the B-roll index live in the library folder (settings media.libraryDir);
  // image tools in their own ComfyUI engine; every heavy job takes its turn on the GPU (gpu).
  mattes.gpu = gpu;
  const libDir = settings.get("media").libraryDir || path.join(paths.library, "assets-library");
  const sfxLib = new SfxLibraryService({ dir: path.join(libDir, "sfx"), userData: paths.root, log });
  const broll = new BrollService({ dir: path.join(libDir, "broll-index"), userData: paths.root, gpu, log });
  const imagegen = new ImagegenService({ paths, gpu, log, notify });
  // Perception (Phase 4): nothing runs until asked; its models take the shared GPU queue one stage at a time.
  let ff = {};
  try { ff = binaries(); } catch (e) { log("perception: ffmpeg missing", e.message); }
  const perception = new PerceptionService({ userData: root, cacheDir: path.join(paths.cache, "perception"), ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe, gpuLock: makeGpuLock({ queue: gpu }), log: (l) => log("perception", l) });
  // Best take (Phase 5): scores the takes of every retake group; reads perception's cached timelines; the AI judge
  // (close calls only) takes the shared GPU queue. The user's picks and learned weights live in the data folder.
  const takes = new TakeService({ userData: root, cacheDir: path.join(paths.cache, "takes"), storeDir: path.join(root, "takes-picks"), ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe, perception, gpuLock: makeGpuLock({ queue: gpu, name: "takes" }), log: (l) => log("takes", l) });
  // Cause ↔ reaction links + moment roles (Phase 6): read perception's timeline; the vision check takes the GPU queue.
  const links = new LinkService({ userData: root, cacheDir: path.join(paths.cache, "links"), perception, ffmpeg: ff.ffmpeg, gpuLock: makeGpuLock({ queue: gpu, name: "links" }), log: (l) => log("links", l) });
  const purged = projects.purgeExpired();
  if (settings.get("draft").autoBackup) { try { backup.autoBackup(); } catch (e) { log("auto backup failed", e.message); } }
  return { paths, repos, settings, media, analysis, timelines, exporter, projects, tts, captions, asrSetup, mattes, stabilizer, dubber, dubSetup, musicSetup, music, videoSetup, video, gpu, backup, packages, sfxLib, broll, imagegen, perception, takes, links, startup: { purged } };
}
