// Dubbing end to end through the services and the agent layer: an Arabic video (MONTAJ_DUB_SAMPLE, a path to a
// video with Arabic speech; MONTAJ_DUB_LANG, default en) is dubbed with the program's own runtime (runtime/dub, sep,
// llama and their models) and the result is checked: the language found, the speakers, every line placed inside the
// video with no two voices at once, each line heard back as meant, two dub tracks that follow the clip, the clip's own
// sound off — and one step back to the original sound. Skipped without a sample or the runtime.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../../src/agent/controlServer.js";
import { dubEstimate, dubTimeline, removeDubbing } from "../../src/agent/dub.js";
import { dubRole } from "../../src/core/timelineOps.js";
import { ffprobe } from "../../src/services/ffmpeg.js";
import { US } from "../../src/core/util.js";

const SAMPLE = process.env.MONTAJ_DUB_SAMPLE || "";
const LANG = process.env.MONTAJ_DUB_LANG || "en";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-dub-e2e-"));
let S, hub, ctx, tid, mid, skip = null, closeDatabase = null;

before(async () => {
  if (!SAMPLE || !fs.existsSync(SAMPLE)) { skip = "set MONTAJ_DUB_SAMPLE to an Arabic video"; return; }
  // Realm is loaded only when the test runs (a loaded Realm keeps a skipped run from exiting).
  const { createServices } = await import("../../src/services/index.js");
  ({ closeDatabase } = await import("../../src/db/realmClient.js"));
  S = await createServices({ root, notify: () => {} });
  if (!S.dubber.status().ready) { skip = `dub runtime missing: ${S.dubber.status().missing.join(", ")}`; return; }
  hub = new AgentHub({ services: S, dir: S.paths.agents });
  ctx = hub.userContext();
  const p = await S.projects.create({ name: "dub" });
  tid = p.mainTimelineId;
  mid = (await S.media.importFiles(p.id, [SAMPLE])).imported[0].id;
  await S.timelines.exec(tid, "addMedia", { mediaId: mid, atUs: null, toMain: true });
});
after(() => { hub?.close(); if (S) closeDatabase?.({ shutdown: true }); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

test("an Arabic video is dubbed: speakers, timed lines heard back as meant, dub tracks, original speech off", { timeout: 60 * 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const est = dubEstimate(ctx, tid, { lang: LANG });
  assert.ok(est.ready && est.totalSec > 0);
  const seen = new Set();
  const r = await dubTimeline(ctx, tid, { lang: LANG }, { progress: (p, label) => { seen.add(label); assert.ok(p >= 0 && p <= 1); } });
  for (const s of ["separate", "words", "speakers", "translate", "voices", "timeline"]) assert.ok(seen.has(s), `stage ${s} reported`);
  const durS = S.repos.media.get(mid).durationUs / US;
  assert.ok(r.speakers.length >= 1 && r.speakers.every((s) => ["male", "female", "child"].includes(s.kind)), JSON.stringify(r.speakers));
  assert.ok(r.lines.length >= 3);
  // MONTAJ_DUB_KEEP: a folder to keep the run's files in (to listen to and score them).
  if (process.env.MONTAJ_DUB_KEEP) fs.cpSync(path.join(S.dubber.workDir(S.repos.media.get(mid))), process.env.MONTAJ_DUB_KEEP, { recursive: true });
  const full = JSON.parse(fs.readFileSync(path.join(S.dubber.workDir(S.repos.media.get(mid)), LANG, "lines.json"), "utf8")).lines.filter((l) => l.duration);
  let prevEnd = -1;
  for (const l of full) {
    assert.ok(l.placed >= l.start - 1e-6 && l.placed - l.start <= 2, `line at ${l.start} placed at ${l.placed}`);
    assert.ok(l.placed >= prevEnd + 0.05, `no two voices at once (${l.placed} after ${prevEnd})`);
    assert.ok(l.placed + l.duration <= durS + 1.5);
    assert.ok(l.speed <= 1.5 + 1e-6);
    prevEnd = l.placed + l.duration;
  }
  const late = full.filter((l) => l.placed - l.start > 0.6).length;
  assert.ok(late <= Math.ceil(0.1 * full.length), `${late}/${full.length} lines start more than 0.6 s late`);
  const heard = full.filter((l) => (l.check ?? 1) >= 0.7).length;
  assert.ok(heard >= 0.9 * full.length, `${heard}/${full.length} lines heard back as meant`);
  // The timeline: two dub tracks that follow the clip, the clip's own sound off.
  const tl = S.timelines.get(tid).timeline;
  const dubTracks = tl.tracks.filter((x) => x.role === dubRole(mid));
  assert.equal(dubTracks.length, 2);
  const clip = tl.tracks.find((x) => x.isMain).segments[0];
  assert.equal(clip.audioDetached, true);
  for (const tr of dubTracks) {
    assert.equal(tr.segments.length, 1);
    assert.equal(tr.segments[0].start, clip.start);
    assert.equal(tr.segments[0].duration, clip.duration);
    const m = S.repos.media.get(tr.segments[0].mediaId);
    assert.equal(m.origin, "dub");
    assert.ok(Math.abs(Number((await ffprobe(m.path)).format.duration) - durS) < 1.5, "the dub runs the whole video");
  }
  // Back to the original sound in one step.
  await removeDubbing(ctx, tid);
  const back = S.timelines.get(tid).timeline;
  assert.equal(back.tracks.filter((x) => x.role === dubRole(mid)).length, 0);
  assert.equal(back.tracks.find((x) => x.isMain).segments[0].audioDetached, false);
});
