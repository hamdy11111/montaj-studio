// Phase 8 — the story order for footage shot out of order: moments never across a clip joint, scenes (segments),
// story beats from Egyptian Arabic cue words, hard constraints (cause → reaction, promise → payoff) and soft ones,
// the exact / local-search order, a model's proposal repaired by the rules, the treatments following the story with
// the shooting order as an alternative, phase 6's own document read through its view, media spans through the clip
// that shows them, recording times, and the measurement helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { momentsWithLinks, clipMoments, ruleTreatments, validateTreatment, executionSpec, phase6Shape, mediaToAxis, mediaSpanToAxis, eventsOnAxis } from "../../src/core/treatments.js";
import { beatCues, segmentMoments, describeSegments, storyConstraints, storyMatrices, bestOrder, orderScore, repairOrder, violations, storyPlan, expand, voteOrders, storySheet, storyTable, kendallTau, exactShare, keptNeighbours, topicTokens } from "../../src/core/story.js";
import { directPlan } from "../../src/core/director.js";
import { probeTime, mediaTimes } from "../../src/services/story/clipTimes.js";
import { llmStoryOrder, storyPrompt, STORY_SCHEMA, planPrompt } from "../../src/services/directorLLM.js";
import { US } from "../../src/core/util.js";

// Words of a sentence spread evenly over [s, e] (seconds).
const said = (text, s, e) => { const ws = text.split(" "), d = (e - s) / ws.length; return ws.map((w, i) => ({ text: w, startUs: Math.round((s + i * d) * US), endUs: Math.round((s + (i + 1) * d - 0.05) * US) })); };
// A tiny vlog told in four clips: setup, promise, payoff, ending (each ~10 s, its own topic and place).
const SCENES = {
  setup: "السلام عليكم يا جماعه النهارده هنروح البحر مع اصحابي في العربيه الجديده",
  promise: "لو عرفت اعوم لحد الصخره هاخد من صاحبي الف جنيه والرهان ده كبير اوي",
  payoff: "اخيرا وصلت الصخره وكسبت الرهان والفلوس بقت معايا شوفوا الصخره",
  ending: "شكرا انكم اتفرجتوا متنسوش تشتركوا في القناه ونشوفكم الفيديو الجاي سلام",
};
const PLACE = { setup: "a parked car on a street", promise: "a sandy beach with umbrellas", payoff: "a rock in the sea water", ending: "a living room sofa at home" };
/** The four clips laid in `order` on the axis: words, events (a shot log per clip), clips, joints. */
function shot(order) {
  const words = [], events = [], clips = [];
  order.forEach((k, i) => {
    const v = i * 10;
    words.push(...said(SCENES[k], v + 0.5, v + 9));
    events.push({ type: "shot_log", t0: v * US, t1: (v + 10) * US, confidence: 0.9, extra: { where: PLACE[k], indoor: k === "ending", who: [{ looks: k === "ending" ? "man in a blue hoodie" : "man in a red swimsuit" }], energy: 3 } });
    clips.push({ mediaId: `m-${k}`, srcStart: 0, srcEnd: 10 * US, vStart: v * US, speed: 1 });
  });
  return { words, events, clips, joints: clips.slice(1).map((c) => c.vStart), durationUs: order.length * 10 * US };
}

test("beats from cue words: a greeting opens, a goodbye closes («السلام عليكم» is not a goodbye), a bet is a promise", () => {
  const open = beatCues("السلام عليكم يا جماعه النهارده هنعمل تحدي");
  assert.ok(open.scores.setup >= 2 && !open.scores.ending, JSON.stringify(open.scores));
  assert.ok(open.hits.some((h) => h.strong && h.beat === "setup"));
  assert.ok(beatCues("متنسوش تشتركوا في القناه سلام").scores.ending >= 2);
  assert.ok(beatCues("لو كسبت هاخد الف جنيه").scores.promise > 0);
  assert.ok(beatCues("يا تري هينجح؟").scores.promise > 0);
  assert.ok(beatCues("اخيرا خلصنا").scores.payoff > 0);
  assert.ok(beatCues("للاسف الاكل اتحرق").scores.conflict > 0);
  assert.deepEqual(topicTokens("انا في البحر مع اصحابي"), ["بحر", "اصحابي"]);
});

test("moments of several clips never run across a joint; word indices stay global; each moment knows its clip", () => {
  // One sentence whose words run on across the joint at 5 s (no pause): it must become two moments.
  const words = [...said("كنت رايح السوق وبعدين", 1, 4.98), ...said("لقيت صاحبي هناك واتكلمنا", 5.02, 9)];
  const ms = clipMoments({ words, events: [], durationUs: 10 * US }, [5 * US]);
  assert.ok(ms.every((m) => m.s >= 5 * US || m.e <= 5 * US), "no moment crosses the joint");
  assert.equal(ms[0].s, 0); assert.equal(ms[ms.length - 1].e, 10 * US);
  for (let i = 1; i < ms.length; i++) assert.equal(ms[i].s, ms[i - 1].e);
  ms.forEach((m, i) => assert.equal(m.n, i + 1));
  const second = ms.find((m) => m.kind === "speech" && m.clip === 1);
  assert.equal(words[second.w0].text, "لقيت", "w0 indexes input.words");
  // momentsWithLinks takes `joints`; a derived link never crosses a clip joint.
  const ev = eventsOnAxis({ a: { events: [{ type: "laughter", t0: 5.2, t1: 6, confidence: 0.9 }] } }, [{ mediaId: "a", srcStart: 0, srcEnd: 10 * US, vStart: 0, speed: 1 }]);
  const w2 = said("قال حاجه تضحك اوي", 1, 4.6);
  const one = momentsWithLinks({ words: w2, events: ev, durationUs: 10 * US });
  const two = momentsWithLinks({ words: w2, events: ev, durationUs: 10 * US, joints: [5 * US] });
  assert.ok(one.links.length >= 1, "in one clip the moment before a laugh causes it");
  assert.equal(two.links.length, 0, "across a joint nothing is derived");
});

test("segments: clip joints always cut, a long raw is cut on its best boundaries within the length limits", () => {
  const s = shot(["setup", "promise", "payoff", "ending"]);
  const { moments, links } = momentsWithLinks(s);
  const segs = segmentMoments(moments, { events: eventsOnAxis({}, []), links });
  assert.equal(segs.length, 4, "four clips → four segments");
  segs.forEach((g, i) => assert.equal(g.clip, i));
  // One 120 s raw of 12 sentences in three topics with long pauses between the topics: cut there.
  const topics = ["الاكل النهارده كان طعمه حلو والرز والفراخ", "العربيه اتعطلت في الطريق والموتور سخن", "الماتش كان جامد والفريق كسب في الاخر"];
  const words = [];
  let t = 0;
  for (let k = 0; k < 3; k++) { for (let j = 0; j < 4; j++) { words.push(...said(topics[k], t, t + 8)); t += 9; } t += 4; }
  const long = momentsWithLinks({ words, events: [], durationUs: Math.round(t * US) });
  const cut = segmentMoments(long.moments, { minUs: 8 * US, maxUs: 45 * US });
  assert.ok(cut.length >= 3 && cut.length <= 5, `${cut.length} segments`);
  for (const g of cut) assert.ok(g.e - g.s <= 50 * US, "none much longer than the limit");
  const starts = cut.slice(1).map((g) => g.s / US);
  assert.ok(starts.some((x) => Math.abs(x - 36) < 4) && starts.some((x) => Math.abs(x - 76) < 4), `cuts at the topic changes: ${starts}`);
});

test("constraints: a sure cross-segment link and a promise are hard, an unsure link soft, a cycle is broken at its weakest link", () => {
  const segs = [0, 1, 2].map((k) => ({ moments: [k + 1] }));
  const { hard, soft } = storyConstraints(segs, {
    links: [{ cause: 1, reaction: 2, direction: "after", confidence: 0.9 }, { cause: 2, reaction: 3, direction: "after", confidence: 0.3, unsure: true }, { cause: 3, reaction: 1, direction: "after", confidence: 0.6 }, { cause: 2, reaction: 1, direction: "before", confidence: 0.8 }],
    promises: [{ promise: 1, payoff: 3 }],
  });
  assert.ok(hard.some((h) => h.a === 0 && h.b === 1), "cause before reaction");
  assert.ok(hard.some((h) => h.a === 0 && h.b === 2 && /promise/.test(h.why)), "promise before payoff");
  assert.ok(soft.some((x) => x.a === 1 && x.b === 2 && !x.cycle), "unsure → soft");
  assert.ok(soft.some((x) => x.a === 2 && x.b === 0 && x.cycle), "3 → 1 would close a cycle: soft");
  assert.ok(hard.some((h) => h.a === 0 && h.b === 1 && /reaction/.test(h.why)), "a 'before' link: the reaction first");
});

test("the order: the exact program equals brute force; local search keeps the hard constraints", () => {
  const rnd = (() => { let x = 7; return () => { x = (x * 48271) % 2147483647; return x / 2147483647; }; })();
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  for (let trial = 0; trial < 4; trial++) {
    const n = 6, P = Array.from({ length: n }, () => Float64Array.from({ length: n }, () => rnd() * 2 - 1)), A = Array.from({ length: n }, () => Float64Array.from({ length: n }, () => rnd()));
    const M = { P, A };
    const best = Math.max(...perms([...Array(n).keys()]).map((o) => orderScore(o, M)));
    assert.ok(Math.abs(orderScore(bestOrder(n, M), M) - best) < 1e-9, "exact");
  }
  const n = 16, P = Array.from({ length: n }, () => Float64Array.from({ length: n }, () => rnd() - 0.5)), A = Array.from({ length: n }, () => new Float64Array(n));
  const hard = [{ a: 15, b: 0 }, { a: 7, b: 3 }];
  for (const h of hard) P[h.b][h.a] -= 1000;
  const o = bestOrder(n, { P, A });
  assert.equal(new Set(o).size, n);
  assert.equal(violations(o, hard).length, 0);
});

test("the story of four clips given out of order: setup, promise, payoff, ending — a link across clips holds", () => {
  const given = ["payoff", "ending", "setup", "promise"];
  const s = shot(given);
  const { moments, links, promises } = momentsWithLinks(s);
  const sp = storyPlan({ moments, links, promises, events: s.events, clips: s.clips }, { useTime: false });
  assert.equal(sp.segments.length, 4);
  const told = sp.order.map((i) => given[sp.segments[i].clip]);
  assert.deepEqual(told, ["setup", "promise", "payoff", "ending"], told.join(","));
  assert.ok(sp.segments.find((g) => given[g.clip] === "setup").opens && sp.segments.find((g) => given[g.clip] === "ending").closes);
  assert.equal(sp.rank.get(sp.moments[0]), 0);
  // Recording times (the hints): the shooting order wins when the words say nothing.
  const flat = { setup: "كلام عادي عن اليوم", promise: "كلام عادي عن الطريق", payoff: "كلام عادي عن الاكل", ending: "كلام عادي عن الجو" };
  const w = []; given.forEach((k, i) => w.push(...said(flat[k], i * 10 + 1, i * 10 + 8)));
  const m2 = momentsWithLinks({ words: w, events: [], durationUs: 40 * US, joints: s.joints });
  const timed = s.clips.map((c, i) => ({ ...c, timeUs: [3, 4, 1, 2][i] * 3600 * US }));
  const sp2 = storyPlan({ moments: m2.moments, events: [], clips: timed }, { useTime: true });
  assert.deepEqual(sp2.order.map((i) => sp2.segments[i].clip), [2, 3, 0, 1], "by recording time");
  // A sure link from the ending clip's moment to the setup clip (contrived) forces the ending first.
  const ms = moments, end = ms.find((m) => m.clip === 1 && m.kind === "speech"), open = ms.find((m) => m.clip === 2 && m.kind === "speech");
  const sp3 = storyPlan({ moments, links: [{ cause: end.n, reaction: open.n, direction: "after", confidence: 0.9 }], events: s.events, clips: s.clips }, { useTime: false });
  const pos = (clip) => sp3.order.findIndex((i) => sp3.segments[i].clip === clip);
  assert.ok(pos(1) < pos(2), "the hard link is kept even against the beats");
});

test("a model's order is repaired: invented and repeated numbers out, a missing scene put where it fits, hard rules kept", () => {
  const s = shot(["payoff", "ending", "setup", "promise"]);
  const { moments } = momentsWithLinks(s);
  const sp = storyPlan({ moments, events: s.events, clips: s.clips }, { useTime: false });
  const hard = [{ a: 3, b: 0, why: "promise → payoff", whyAr: "وعد ← نتيجته" }];
  const r = repairOrder([3, 9, 3, 1, 4], sp.segments, { hard }, sp.matrices);
  assert.equal(r.order.length, 4);
  assert.equal(new Set(r.order).size, 4);
  assert.equal(violations(r.order, hard).length, 0);
  assert.ok(r.fixes.some((f) => /does not exist/.test(f.en)) && r.fixes.some((f) => /twice/.test(f.en)) && r.fixes.some((f) => /missing/.test(f.en)) && r.fixes.some((f) => /moved before/.test(f.en)));
  assert.ok(r.fixes.every((f) => f.ar));
  // Votes: two model orders on top of the rules; where they agree they win.
  const v = voteOrders(sp.matrices, [[1, 0, 3, 2], [1, 0, 3, 2]], { w: 50 });
  assert.deepEqual(v.order, [1, 0, 3, 2]);
  assert.equal(v.agreement, 1);
});

test("treatments follow the story order; the shooting order is an alternative, not a candidate", () => {
  const given = ["payoff", "ending", "setup", "promise"];
  const s = shot(given);
  const { moments, links, promises } = momentsWithLinks(s);
  const sp = storyPlan({ moments, links, promises, events: s.events, clips: s.clips }, { useTime: false });
  const ts = ruleTreatments(moments, { durationUs: s.durationUs, links, promises, story: { rank: sp.rank } });
  const story = ts.find((t) => t.id === "story-full"), shoot = ts.find((t) => t.id === "shooting-order");
  assert.ok(story && shoot, ts.map((t) => t.id).join(","));
  assert.equal(shoot.alternative, true);
  assert.ok(ts.filter((t) => t.alternative).length === 1);
  const clipOf = (n) => given[moments[n - 1].clip];
  assert.equal(clipOf(story.order[0]), "setup");
  assert.equal(clipOf(story.order[story.order.length - 1]), "ending");
  assert.deepEqual(shoot.order, [...shoot.order].sort((a, b) => a - b));
  // validateTreatment sorts by the story's rank when it has to sort.
  const v = validateTreatment({ order: [moments.length], hook: { kind: "result", moment: 1 } }, moments, [], [], { rank: sp.rank });
  assert.deepEqual(v.treatment.order, [moments.length, 1].sort((a, b) => sp.rank.get(a) - sp.rank.get(b)));
  // The executor lays the clips in the story order (setup's file first, ending's last).
  const spec = executionSpec(story, moments, s.words);
  const r = directPlan({ mediaId: s.clips[0].mediaId, clips: s.clips, protect: [], words: s.words, wordsCorrected: true, durationUs: s.durationUs, track: [], style: "energetic", spec: { ...spec, story: true } });
  const files = r.plan.segments.filter((g) => g.role !== "hook").map((g) => g.mediaId);
  assert.equal(files[0], "m-setup"); assert.equal(files[files.length - 1], "m-ending");
  assert.ok(r.notes.some((n) => /story order/.test(n)));
});

test("phase 6's own document is read through its view; media spans map through the clip that shows them", () => {
  const doc = { schema: "montaj.links/1", reactions: [{ id: "R1", t0: 5, t1: 6, kind: "laughter", kinds: ["laughter"], strength: 0.8, verified: { real: true } }, { id: "R2", t0: 1, t1: 2, kind: "cheer", kinds: ["cheer"], strength: 0.5, verified: null }],
    causes: [{ id: "C1", t0: 3, t1: 4.5, kind: "promise", text: "لو كسبت هاخد" }, { id: "C2", t0: 2.5, t1: 3, kind: "speech", text: "x" }],
    links: [{ id: "L1", reaction: "R1", cause: "C1", rank: 1, best: true, direction: "after", offsetS: 2, gapS: 0.5, prior: 0.7, confidence: 0.8, status: "sure", label_ar: "متأكد", keepGap: true, checks: { semantic: { reason: "he laughs at the bet" } } },
      { id: "L2", reaction: "R2", cause: "C1", rank: 1, best: true, direction: "before", offsetS: -2, gapS: 1, prior: 0.5, confidence: 0.4, status: "unsure", label_ar: "مش متأكد", keepGap: true, checks: {} }],
    moments: [{ id: "M1", t0: 3, t1: 4.5, role: "build_up", roleConfidence: 0.6 }] };
  const sh = phase6Shape(doc);
  assert.equal(sh.links.length, 2);
  const l1 = sh.links.find((l) => l.reaction.type === "laughter");
  assert.deepEqual([l1.cause.t0, l1.reaction.t0, l1.unsure, l1.why], [3, 5, false, "he laughs at the bet"]);
  assert.equal(sh.links.find((l) => l.reaction.type === "cheer").unsure, true);
  assert.equal(sh.roles[0].role, "build");
  assert.deepEqual(sh.promises[0].payoff, { t0: 5, t1: 6 }, "the payoff of a promise: a reaction AFTER it");
  assert.equal(phase6Shape({ links: [] }).links.length, 0, "the adapter's own shape passes through");
  // A file cut in two pieces placed in reverse: each time goes through its own piece.
  const clips = [{ mediaId: "f", srcStart: 10 * US, srcEnd: 20 * US, vStart: 0 }, { mediaId: "f", srcStart: 0, srcEnd: 10 * US, vStart: 10 * US }];
  assert.equal(mediaToAxis(clips)("f", 12), 2 * US);
  assert.equal(mediaToAxis(clips)("f", 3), 13 * US);
  assert.equal(mediaToAxis(clips)("f", 25), null);
  assert.deepEqual(mediaSpanToAxis(clips)("f", 8, 11), { t0: 18 * US, t1: 20 * US }, "a span across the two pieces keeps its larger part");
  assert.equal(mediaSpanToAxis(clips)("g", 1, 2), null);
});

test("recording times: QuickTime / MP4 tags, an empty 1904 date ignored, the file time as the weaker fallback", async () => {
  assert.equal(probeTime({ format: { tags: { "com.apple.quicktime.creationdate": "2026-08-26T10:49:03+0300" } } }).ms, Date.parse("2026-08-26T10:49:03+0300"));
  assert.equal(probeTime({ streams: [{ tags: { creation_time: "2026-07-07T17:26:00.000000Z" } }] }).source, "creation_time");
  assert.equal(probeTime({ format: { tags: { creation_time: "1904-01-01T00:00:00Z" } } }), null);
  const times = await mediaTimes(["a.mp4", "b.mp4", "a.mp4"], { probe: async (p) => (p === "a.mp4" ? { format: { tags: { creation_time: "2026-01-02T03:04:05Z" } } } : {}) });
  assert.equal(times.size, 2);
  assert.equal(times.get("a.mp4").source, "creation_time");
  assert.equal(times.get("b.mp4"), null, "no tag and no file: unknown");
});

test("the model's story call: numbers only, the listing order, its beats; the planner sees the story order", async () => {
  const s = shot(["payoff", "setup"]);
  const { moments } = momentsWithLinks(s);
  const sp = storyPlan({ moments, events: s.events, clips: s.clips }, { useTime: false });
  const p = storyPrompt({ segments: sp.segments, constraints: { hard: [{ a: 1, b: 0, why: "promise → payoff (moments 3 → 1)" }], soft: [] }, listOrder: [1, 0] });
  assert.ok(/Must: 2 before 1/.test(p));
  assert.ok(p.indexOf("\n2 |") < p.indexOf("\n1 |"), "listed in the given order, numbers kept");
  assert.equal(STORY_SCHEMA.properties.order.items.type, "integer");
  let asked = null;
  const fake = { json: async (q) => { asked = q; return { json: { order: [2, 1], beats: [{ segment: 2, beat: "setup" }, { segment: 1, beat: "payoff" }], why: "التمهيد الأول" }, ms: 5, tokens: 9 }; } };
  const got = await llmStoryOrder(fake, { segments: sp.segments });
  assert.deepEqual(got.order, [2, 1]);
  assert.equal(got.beats.get(1), "setup");
  assert.equal(asked.schema, STORY_SCHEMA);
  assert.ok(/Story order/.test(planPrompt({ moments, links: [], durationS: 20, storyOrder: [3, 4, 1, 2] })));
  assert.ok(!/Story order/.test(planPrompt({ moments, links: [], durationS: 20 })));
  // The cut sheet: the order with each scene's beat and why, the shooting order as the alternative.
  const sheet = storySheet({ segments: sp.segments, order: sp.order, shooting: sp.shooting, constraints: sp.constraints, source: "Qwen3.8-27B", why: "التمهيد الأول", beats: got.beats });
  assert.equal(sheet.order.length, 2);
  assert.ok(sheet.text[0].startsWith("ترتيب القصة"));
  assert.ok(sheet.text.some((l) => l.startsWith("البديل") || l.includes("نفسه")));
  assert.ok(storyTable(sp.segments).split("\n").length >= 2);
});

test("measurement helpers: Kendall tau, exact places, kept neighbours", () => {
  assert.equal(kendallTau([0, 1, 2, 3], [0, 1, 2, 3]), 1);
  assert.equal(kendallTau([3, 2, 1, 0], [0, 1, 2, 3]), -1);
  assert.equal(kendallTau([1, 0, 2, 3], [0, 1, 2, 3]), 0.67);
  assert.equal(exactShare([0, 2, 1, 3], [0, 1, 2, 3]), 0.5);
  assert.equal(keptNeighbours([2, 3, 0, 1], [0, 1, 2, 3]), 0.67);
  const { moments, rank } = expand([{ moments: [1, 2] }, { moments: [3] }], [1, 0]);
  assert.deepEqual(moments, [3, 1, 2]);
  assert.equal(rank.get(1), 1);
});
