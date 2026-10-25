// The speech engines: the Egyptian NeMo model ships in the source and is chosen first; its runtime is the program's
// own (never a Python found elsewhere); its output is parsed like faster-whisper's. A real run of the model is in the
// e2e suite (skipped when the runtime is not set up).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CaptionService, NEMO_MODEL, nemoModel, nemoPython } from "../../src/services/captionService.js";

const settings = (providers) => ({ get: () => ({ whisperPath: "", whisperModel: "", asrEngine: "auto", ...providers }) });

test("engine choice: the Egyptian model first, then faster-whisper, then whisper.cpp; a forced engine is not replaced", () => {
  const svc = new CaptionService({ repos: {}, paths: { root: os.tmpdir() }, settings: settings({}) });
  assert.equal(svc.engine(), null);
  svc.fw = { ok: true };
  assert.equal(svc.engine(), "fasterwhisper");
  svc.nemo = { ok: true };
  assert.equal(svc.engine(), "nemo");
  assert.equal(svc.engine("ar"), "nemo");
  assert.equal(svc.engine("en"), "fasterwhisper", "the Egyptian model understands Arabic only");
  svc.settings = settings({ asrEngine: "fasterwhisper" });
  assert.equal(svc.engine(), "fasterwhisper");
  svc.settings = settings({ asrEngine: "nemo" });
  svc.nemo = { ok: false };
  assert.equal(svc.engine(), null, "the Egyptian model was asked for: no silent fallback");
});

test("the model lives in the source; the runtime is looked for only in the program's folders", () => {
  assert.match(NEMO_MODEL.replace(/\\/g, "/"), /src\/services\/asr\/models\/asr-egyptian-nemo-v2\.0\.nemo$/);
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-asr-"));
  try {
    const exe = process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python");
    const found = nemoPython(user);
    const project = path.resolve("runtime", "asr", exe);
    assert.ok(found === null || found === project, `only the project runtime may be found, got ${found}`);
    if (!found) {
      fs.mkdirSync(path.dirname(path.join(user, "runtime", "asr", exe)), { recursive: true });
      fs.writeFileSync(path.join(user, "runtime", "asr", exe), "");
      assert.equal(nemoPython(user), path.join(user, "runtime", "asr", exe), "falls back to the user-data runtime");
    }
    if (!fs.existsSync(NEMO_MODEL)) {
      assert.equal(nemoModel(user), null);
      fs.mkdirSync(path.join(user, "models"));
      fs.writeFileSync(path.join(user, "models", path.basename(NEMO_MODEL)), "");
      assert.equal(nemoModel(user), path.join(user, "models", path.basename(NEMO_MODEL)), "an installed copy keeps the model in its data folder");
    } else assert.equal(nemoModel(user), NEMO_MODEL, "the source copy first");
  } finally { fs.rmSync(user, { recursive: true, force: true }); }
});

test("the engine's JSON becomes words and segments with word indices", () => {
  const svc = new CaptionService({ repos: {}, paths: { root: os.tmpdir() }, settings: settings({}) });
  const out = JSON.stringify({ language: "ar", duration: 3, device: "cpu", segments: [
    { start: 0.16, end: 0.8, text: "فلو عملنا", words: [{ start: 0.16, end: 0.4, word: "فلو", p: null }, { start: 0.48, end: 0.8, word: "عملنا", p: null }] },
    { start: 1.6, end: 2.1, text: "تجربة", words: [{ start: 1.6, end: 2.1, word: "تجربة", p: null }] },
  ] });
  const r = svc.parseWordJson(out);
  assert.equal(r.language, "ar");
  assert.deepEqual(r.data.words.map((w) => [w.text, w.startUs, w.endUs]), [["فلو", 160_000, 400_000], ["عملنا", 480_000, 800_000], ["تجربة", 1_600_000, 2_100_000]]);
  assert.deepEqual(r.data.segments.map((s) => [s.w0, s.w1]), [[0, 1], [2, 2]]);
});
