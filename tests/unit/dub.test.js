// Dubbing on the timeline (core/timelineOps applyDub/removeDub) and the dub service's plan of a run: the new voice
// and the kept background follow the video's clips exactly (cuts, source offsets, speed), the clips' own sound is off,
// a second dub replaces the first, and removing it gives the original sound back.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline, mainTrack } from "../../src/core/model.js";
import { DubService, DUB_LANGUAGES } from "../../src/services/dubService.js";
import { US } from "../../src/core/util.js";
import { has } from "../../src/renderer/js/i18n.js";

const media = (id, durS, type = "video") => ({ id, name: `${id}.mp4`, type, durationUs: durS * US, width: 1920, height: 1080, hasAudio: true });

function cutVideo() {
  const tl = newTimeline("p1");
  ops.addMediaSegment(tl, media("v", 10));
  const main = mainTrack(tl);
  ops.splitSegment(tl, main.segments[0].id, 4 * US);
  ops.deleteSegments(tl, [main.segments[0].id], { magnet: true, linkage: true, linkTypes: [] }); // the first 4 s cut
  main.segments[0].speed = 1.25;
  main.segments[0].duration = Math.round((6 * US) / 1.25);
  return tl;
}

test("a dub follows the clips of its video and turns their own sound off", () => {
  const tl = cutVideo();
  const clip = mainTrack(tl).segments[0];
  const layers = [{ media: media("voice", 10, "audio"), name: "Dub (EN)", volumeDb: 0 }, { media: media("bg", 10, "audio"), name: "Background (EN)", volumeDb: -2 }];
  const ids = ops.applyDub(tl, "v", layers);
  assert.equal(ids.length, 2);
  const tracks = tl.tracks.filter((t) => t.role === ops.dubRole("v"));
  assert.equal(tracks.length, 2);
  for (const [k, t] of tracks.entries()) {
    assert.equal(t.type, "audio");
    assert.equal(t.segments.length, 1);
    const s = t.segments[0];
    assert.equal(s.mediaId, layers[k].media.id);
    assert.deepEqual([s.start, s.duration, s.sourceStart, s.speed], [clip.start, clip.duration, clip.sourceStart, clip.speed], "same place, same source time, same speed");
    assert.equal(s.sourceStart, 4 * US, "the cut part of the video is cut in the dub too");
    assert.equal(s.volumeDb, layers[k].volumeDb);
  }
  assert.equal(clip.audioDetached, true);
  assert.deepEqual(ops.validateTimeline(tl), []);
  // A second dub (another language, or voiced again) replaces the first.
  ops.applyDub(tl, "v", layers);
  assert.equal(tl.tracks.filter((t) => t.role === ops.dubRole("v")).length, 2);
  ops.removeDub(tl, "v");
  assert.equal(tl.tracks.filter((t) => t.role === ops.dubRole("v")).length, 0);
  assert.equal(clip.audioDetached, false, "the original sound is back");
});

test("a dub needs its video on the timeline", () => {
  const tl = cutVideo();
  assert.throws(() => ops.applyDub(tl, "other", [{ media: media("voice", 10, "audio") }]), (e) => e.messageKey === "err.dubNoClip");
});

test("the run is planned in stages; cached audio work costs nothing; every language and error has a name", () => {
  const svc = new DubService({ repos: {}, paths: { root: "", cache: "" } });
  const fresh = svc.estimate(150), cached = svc.estimate(150, { separate: true, words: true, speakers: true });
  assert.deepEqual(fresh.stages.map((s) => s.key), ["separate", "words", "speakers", "translate", "voices", "timeline"]);
  assert.ok(cached.totalSec < fresh.totalSec - 60);
  assert.ok(svc.estimate(600).totalSec > fresh.totalSec, "longer video, longer run");
  for (const l of DUB_LANGUAGES) assert.ok(has(`dub.l.${l}`), l);
  for (const s of fresh.stages) assert.ok(has(`dub.stage.${s.key}`), s.key);
  for (const k of ["err.dubNotReady", "err.dubNotArabic", "err.dubFailed", "err.dubTranslator", "err.dubNone", "err.dubNoClip", "err.dubOneVideo", "err.dubBusy"]) assert.ok(has(k), k);
});
