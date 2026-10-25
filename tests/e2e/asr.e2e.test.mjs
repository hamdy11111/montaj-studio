// The Egyptian Arabic model end to end: the program's own runtime (runtime/asr) runs the model shipped in the source on
// real Arabic speech (an Arabic Windows voice through the app's own text-to-speech) and returns words with times in
// order, inside the audio, as words and segments the editor uses. Skipped when the runtime is not set up (npm run setup:asr) or no
// Arabic Windows voice is installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CaptionService, nemoPython } from "../../src/services/captionService.js";
import { TtsService } from "../../src/services/ttsService.js";
import { US } from "../../src/core/util.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-asr-e2e-"));
const TEXT = "مرحبا بكم في البرنامج. النهارده هنعمل تجربة جديدة للمونتاج.";
let skip = null, media = null;

const svc = new CaptionService({ repos: { media: { get: () => media } }, paths: { root, cache: root }, settings: { get: () => ({ asrEngine: "auto", whisperPath: "", whisperModel: "" }) } });

before(async () => {
  if (!nemoPython(root)) { skip = "speech runtime not set up (npm run setup:asr)"; return; }
  fs.mkdirSync(path.join(root, "media"), { recursive: true });
  let file = null;
  const tts = new TtsService({ paths: { cache: root, media: path.join(root, "media") }, media: { importFiles: async (_p, files) => { file = files[0]; return { imported: [{ path: files[0] }], errors: [] }; } } });
  const voice = (await tts.voices().catch(() => [])).find((v) => /^ar/i.test(v.language));
  if (!voice) { skip = "no Arabic Windows voice installed"; return; }
  await tts.synthesize("p", { text: TEXT, voice: voice.name, rate: 0.9 });
  const { ffprobe } = await import("../../src/services/ffmpeg.js");
  media = { id: "a1", path: file, hasAudio: true, durationUs: Math.round(Number((await ffprobe(file)).format.duration) * US) };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the shipped Egyptian model is ready through the program's runtime and is the engine for Arabic", async (t) => {
  if (skip) return t.skip(skip);
  const st = await svc.status(true);
  assert.ok(st.nemo?.ready, JSON.stringify(st.nemo));
  assert.equal(st.engine, "nemo");
  assert.ok(st.nemo.python.replace(/\\/g, "/").includes("/runtime/asr/"), "the program's own runtime");
});

test("Arabic speech becomes timed words and segments", { timeout: 600_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const tr = await svc.transcribeWords({ mediaId: "a1", language: "ar", fresh: true });
  assert.equal(tr.engine, "nemo");
  const text = tr.words.map((w) => w.text).join(" ");
  t.diagnostic(`${tr.words.length} words: ${text}`);
  assert.ok(tr.words.length >= 6, text);
  for (const key of ["مرحبا", "البرنامج", "تجرب", "مونتاج"]) assert.ok(text.includes(key), `«${key}» in «${text}»`);
  tr.words.forEach((w, i) => {
    assert.ok(w.endUs > w.startUs && w.startUs >= 0 && w.endUs <= media.durationUs + 200_000, JSON.stringify(w));
    if (i) assert.ok(w.startUs >= tr.words[i - 1].startUs, "in order");
  });
  assert.ok(tr.segments.length >= 1 && tr.segments.every((s) => s.w1 >= s.w0));
  const again = await svc.transcribeWords({ mediaId: "a1", language: "ar" });
  assert.deepEqual(again.words, tr.words, "cached");
});
