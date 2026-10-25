// The shared GPU queue: one heavy job at a time in order, none during an export, a waiting job can leave, and the other
// studios' engines free their models before a job starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GpuQueue } from "../../src/services/gpuQueue.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("jobs take their turn one at a time, in order", async () => {
  const q = new GpuQueue();
  const order = [];
  const waits = [];
  const r1 = await q.acquire("music", "a");
  order.push("a");
  const p2 = q.acquire("video", "b", { onWait: (w) => waits.push(w) }).then((rel) => { order.push("b"); return rel; });
  const p3 = q.acquire("music", "c").then((rel) => { order.push("c"); return rel; });
  await tick();
  assert.deepEqual(order, ["a"]);
  assert.ok(waits.includes("queue"));
  assert.deepEqual(q.state().waiting.map((w) => w.id), ["b", "c"]);
  r1();
  const r2 = await p2;
  await tick();
  assert.deepEqual(order, ["a", "b"]);
  r2();
  r2(); // releasing twice does nothing more
  (await p3)();
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(q.state().holder, null);
});

test("a job waits while an export runs, and a waiting job can be cancelled", async () => {
  let exporting = true;
  const q = new GpuQueue({ exporter: { busy: () => exporting } });
  const waits = [];
  let started = false;
  const p = q.acquire("video", "v", { onWait: (w) => waits.push(w) }).then((rel) => { started = true; return rel; });
  const gone = q.acquire("music", "m").catch((e) => e);
  await tick();
  assert.equal(started, false);
  assert.ok(waits.includes("export"));
  assert.equal(q.cancel("m"), true);
  assert.equal((await gone).cancelled, true);
  exporting = false;
  (await p)();
  assert.equal(started, true);
});

test("before a job starts, the other running engines free their models", async () => {
  const q = new GpuQueue();
  const freed = [];
  q.register("music", { running: true, release: async () => { freed.push("music"); } });
  q.register("video", { running: true, release: async () => { freed.push("video"); } });
  q.register("idle", { running: false, release: async () => { freed.push("idle"); } });
  (await q.acquire("video", "x"))();
  assert.deepEqual(freed, ["music"]);
});
