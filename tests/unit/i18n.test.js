// UI text: every key is defined once. Parallel branches each append their own block to i18n.js; a key defined again
// silently replaces the first one (the AI set-up page once renamed the editor's EditPilot button this way).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("i18n: no key is defined twice", () => {
  const src = fs.readFileSync(new URL("../../src/renderer/js/i18n.js", import.meta.url), "utf8");
  const keys = [...src.matchAll(/"([A-Za-z0-9_.-]+)":\s*\[/g)].map((m) => m[1]);
  assert.ok(keys.length > 500, "the key pattern still matches the file");
  const seen = new Set(), twice = new Set();
  for (const k of keys) (seen.has(k) ? twice : seen).add(k);
  assert.deepEqual([...twice], [], `defined more than once: ${[...twice].join(", ")}`);
});
