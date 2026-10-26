// media://libfile (main/libraryFiles.js): the library browsers' previews read only the libraries' own files — a sound
// of the sound library, a B-roll keyframe, a video the B-roll index lists — by real path; traversal, links out of the
// folders, look-alike folder names, other file types and unlisted files are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { libraryFiles, servicesLibraryFiles, libraryFileId, libraryFileFromId, isInside, PREVIEW_EXT } from "../../src/main/libraryFiles.js";

function tree() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "montaj-lib-")));
  const mk = (rel, body = "x") => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const sfx = path.join(root, "lib", "sfx"), broll = path.join(root, "lib", "broll-index");
  const files = {
    sound: mk("lib/sfx/files/mixkit/560.wav"),
    manifest: mk("lib/sfx/library.json", JSON.stringify({ sounds: [{ id: "u1", file: path.join(root, "mine", "imported.mp3"), abs: true }, { id: "m", file: "files/mixkit/560.wav" }] })),
    imported: mk("mine/imported.mp3"),
    keyframe: mk("lib/broll-index/frames/k1/0000_1.jpg"),
    shots: mk("lib/broll-index/shots.json", JSON.stringify({ version: 1, media: { k1: { path: path.join(root, "footage", "clip.mp4") } }, shots: [] })),
    video: mk("footage/clip.mp4"),
    other: mk("footage/other.mp4"),
    secret: mk("secret/notes.wav"),
    lookalike: mk("lib/sfx-evil/a.wav"),
  };
  return { root, sfx, broll, files, mk };
}

test("ids: base64url of the UTF-8 path, absolute paths only", () => {
  const p = "D:\\capcut new\\montaj-bench\\الحالات\\01-فلوق\\خام\\IMG_3039.MP4";
  const id = libraryFileId(p);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  assert.equal(libraryFileFromId(id), p);
  assert.equal(libraryFileFromId(libraryFileId("relative/file.wav")), null);
  assert.equal(libraryFileFromId("not base64!"), null);
  assert.equal(libraryFileFromId(""), null);
  assert.ok(isInside("C:\\lib\\sfx\\a.wav", "C:\\lib\\sfx") || process.platform !== "win32");
  assert.ok(!isInside(path.join("/lib", "sfx-evil", "a.wav"), path.join("/lib", "sfx")), "a look-alike folder is not inside");
  assert.ok(!isInside(path.join("/lib", "sfx"), path.join("/lib", "sfx")), "the folder itself is not a file inside it");
  assert.ok(PREVIEW_EXT.has(".wav") && !PREVIEW_EXT.has(".json"));
});

test("the resolver serves the libraries' files and refuses everything else", () => {
  const { root, sfx, broll, files } = tree();
  try {
    const lf = libraryFiles({ roots: () => [sfx, broll], listed: () => [files.imported, files.video] });
    assert.equal(lf.resolve(files.sound), files.sound, "a sound of the library");
    assert.equal(lf.resolve(files.keyframe), files.keyframe, "a B-roll keyframe");
    assert.equal(lf.resolve(files.video), files.video, "a video the index lists");
    assert.equal(lf.resolve(files.imported), files.imported, "a sound imported by path");
    assert.equal(lf.resolve(files.other), null, "an unlisted video next to a listed one");
    assert.equal(lf.resolve(files.secret), null, "anything else of the disk");
    assert.equal(lf.resolve(files.lookalike), null, "a look-alike folder name");
    assert.equal(lf.resolve(path.join(sfx, "..", "..", "secret", "notes.wav")), null, "traversal out of the folder");
    assert.equal(lf.resolve(files.manifest), null, "not a picture, sound or video");
    assert.equal(lf.resolve(path.join(sfx, "missing.wav")), null);
    assert.equal(lf.resolve("files/mixkit/560.wav"), null, "relative paths are refused");
    // A link inside the library pointing out of it: its real path is outside, so it is refused.
    const link = path.join(sfx, "escape");
    fs.symlinkSync(path.join(root, "secret"), link, "junction");
    try { assert.equal(lf.resolve(path.join(link, "notes.wav")), null, "a junction out of the library"); }
    finally { fs.rmdirSync(link); } // unlink the junction only, never delete through it
    assert.ok(fs.existsSync(files.secret));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the app's resolver reads the services' folders and their lists, and follows the index when it changes", () => {
  const { root, sfx, broll, files, mk } = tree();
  try {
    const services = { sfxLib: { dir: sfx }, broll: { dir: broll, file: () => files.shots, read: () => JSON.parse(fs.readFileSync(files.shots, "utf8")) } };
    const lf = servicesLibraryFiles(() => services);
    assert.equal(lf.resolve(files.sound), files.sound);
    assert.equal(lf.resolve(files.imported), files.imported, "the library's imported (abs) sound");
    assert.equal(lf.resolve(files.video), files.video, "the B-roll index's video");
    assert.equal(lf.resolve(files.other), null);
    // The index gains a video: served once the index file changes.
    const later = mk("footage/later.mp4");
    fs.writeFileSync(files.shots, JSON.stringify({ version: 1, media: { k1: { path: files.video }, k2: { path: later } }, shots: [] }));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(files.shots, t, t);
    assert.equal(lf.resolve(later), later);
    assert.equal(servicesLibraryFiles(() => null).resolve(files.sound), null, "no services: nothing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
