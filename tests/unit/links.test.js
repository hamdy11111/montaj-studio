// Cause ↔ reaction links and moment roles (Phase 6): reactions from the perception timeline, scenes, the content
// profile, candidate windows in both directions, the prior, the model's answers, the protection rule, the roles,
// the label file and its scores, the WAV reader and the sudden silences.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findReactions, findScenes, contentProfile, findCauses, candidates, timePrior, relation, isPromise, finalizeLinks, buildLinks,
  verifyQueries, controlQueries, calibrationFrom, applyAnswers, protectKeeps, checkEdit, envelopeDb, suddenSilences, semanticP, LINKS_SCHEMA, LINK_DEFAULTS, peopleIn, samePeople,
} from "../../src/core/causeLinks.js";
import { momentUnits, assignRoles, ROLES } from "../../src/core/momentRoles.js";
import { labelTemplate, validateLabels, evaluate, pooled, labelPageHtml, indexHtml, LABELS_SCHEMA } from "../../src/services/links/labels.js";
import { readWav, splitAnswers } from "../../src/services/links/linkService.js";

let n = 0;
const ev = (type, t0, t1, o = {}) => ({ id: `e${String(++n).padStart(6, "0")}`, t0, t1, type, source_model: "test", confidence: o.confidence ?? null, speaker: o.speaker ?? null, entity: o.entity ?? null, text: o.text ?? null, extra: o.extra ?? null });
const words = (t0, text, speaker) => text.split(" ").map((w, i) => ev("word", t0 + i * 0.4, t0 + i * 0.4 + 0.35, { text: w, speaker }));
const utt = (t0, text, speaker) => { const w = words(t0, text, speaker); return [ev("utterance", t0, w[w.length - 1].t1, { text, speaker }), ...w]; };

/** A small talk timeline: a line, a laugh 1 s after it, a far laugh, faces P1 (speaker S1) and P2 on screen. */
function talk() {
  const events = [
    ev("shot", 0, 60),
    ...utt(2, "انا قلتله روح هات الفلوس", "S1"),
    ev("laughter", 5.4, 6.4, { confidence: 0.8, speaker: "S2" }),
    ...utt(8, "وبعدين رجع من غير حاجه خالص", "S1"),
    ev("laughter", 10.6, 11.2, { confidence: 0.75 }),
    ...utt(30, "طيب نكمل الشرح بقى", "S1"),
    ev("face_track", 0, 60, { entity: "P1" }), ev("face_track", 0, 60, { entity: "P2" }),
  ];
  return { media: { path: "x.mp4", name: "x.mp4", hash: "h1", duration: 60 }, speakers: [{ id: "S1", face: "P1" }, { id: "S2", face: "P2" }], events: events.sort((a, b) => a.t0 - b.t0) };
}

/** A challenge timeline: a promise at 2 s, little talk, the game, an action window, a scream + applause at 50 s. */
function challenge() {
  const events = [
    ev("shot", 0, 90),
    ...utt(2, "لو عملتها هاخد الف جنيه", "S1"),
    ev("shot_log", 0, 12, { extra: { indoor: false, energy: 3, change: "none", where: "yard", summary: "people line up" } }),
    ev("shot_log", 36, 48, { extra: { indoor: false, energy: 5, change: "a man jumps onto a chair", where: "yard", summary: "a man jumps", keyframes: [38, 42, 46] } }),
    ev("shot_log", 48, 60, { extra: { indoor: false, energy: 4, change: "the girl turns and smiles at the camera", where: "yard", summary: "cheering", keyframes: [50, 54, 58] } }),
    ev("audio_tag", 50, 52, { text: "Applause", confidence: 0.5 }),
    ev("audio_tag", 49.6, 50.2, { text: "Screaming", confidence: 0.6 }),
    ev("loudness_spike", 49.5, 50, { confidence: 0.9, extra: { db: -12, aboveDb: 18 } }),
    ev("shot_log", 60, 72, { extra: { indoor: true, energy: 2, change: "none", where: "inside", summary: "inside the house" } }),
    ev("shot_log", 72, 84, { extra: { indoor: true, energy: 2, change: "none", where: "inside", summary: "inside the house" } }),
  ];
  return { media: { path: "y.mp4", name: "y.mp4", hash: "h2", duration: 90 }, speakers: [], events: events.sort((a, b) => a.t0 - b.t0) };
}

test("promises and stakes are recognised in Egyptian phrasing", () => {
  assert.ok(isPromise("لو عملتها هاخد الف جنيه"));
  assert.ok(isPromise("اللي يكسب ياخد الجايزه"));
  assert.ok(isPromise("ده التحدي بتاع النهارده"));
  assert.ok(!isPromise("انا رايح السوق"));
});

test("reactions: laughs, sound tags, bursts and exclamations, merged when close; weak bumps in speech dropped", () => {
  const tl = challenge();
  const R = findReactions(tl);
  const big = R.find((r) => r.t0 <= 50 && r.t1 >= 50);
  assert.ok(big, "the scream + applause + burst is one reaction");
  assert.deepEqual(new Set(big.kinds), new Set(["applause", "scream", "loud_spike"]));
  assert.ok(big.strength > 0.8);
  assert.ok(R.some((r) => r.kind === "face_change"), "the shot log's smile is a face change");
  // An exclamation said out loud is a verbal reaction.
  const tl2 = { media: { duration: 10 }, events: [...utt(1, "يا نهار ابيض", "S1")] };
  assert.equal(findReactions(tl2)[0].kind, "verbal");
  // A small burst inside a sentence is emphasis, not a reaction.
  const tl3 = { media: { duration: 10 }, events: [...utt(1, "كلام عادي جدا هنا", "S1"), ev("loudness_spike", 1.5, 1.7, { extra: { aboveDb: 9.5 } })] };
  assert.equal(findReactions(tl3).length, 0);
  assert.deepEqual(R.map((r) => r.id), R.map((_, i) => `R${String(i + 1).padStart(3, "0")}`));
});

test("scenes: shots, and a stable indoor/outdoor change (one stray window is not a scene)", () => {
  const sc = findScenes(challenge());
  assert.deepEqual(sc.map((s) => [s.t0, s.t1, s.why]), [[0, 60, "start"], [60, 90, "place"]]);
  const tl = challenge();
  tl.events.find((e) => e.type === "shot_log" && e.t0 === 72).extra.indoor = false; // flips back: not stable
  assert.equal(findScenes(tl).length, 1);
});

test("content profile: hint first, then how much is said, then a promise", () => {
  assert.equal(contentProfile(talk(), "challenge").kind, "event");
  assert.equal(contentProfile(challenge(), "comedy").kind, "speech");
  assert.equal(contentProfile(challenge()).kind, "event");
  const t = talk(); t.media.duration = 20;
  assert.equal(contentProfile(t).kind, "speech");
});

test("time prior: talk −2…+8 s around the line, both directions; events far back, promise at any distance", () => {
  const c = { t0: 10, t1: 12, kind: "speech" };
  assert.equal(timePrior("speech", c, { t0: 13, t1: 14 }), 1);
  assert.ok(timePrior("speech", c, { t0: 19, t1: 20 }) > 0.3);
  assert.equal(timePrior("speech", c, { t0: 21, t1: 22 }), 0); // 9 s after: outside the talk window
  assert.ok(timePrior("speech", c, { t0: 8.5, t1: 9.5 }) > 0, "a laugh just before the line (anticipation)");
  assert.deepEqual(relation({ t0: 8.5, t1: 9.5 }, c), { direction: "before", offsetS: -1.5, gapS: 0.5 });
  assert.equal(timePrior("speech", c, { t0: 5, t1: 6 }), 0);
  assert.ok(timePrior("event", { t0: 0, t1: 2, kind: "promise" }, { t0: 80, t1: 81 }) >= 0.5);
  assert.ok(timePrior("event", { t0: 0, t1: 12, kind: "action" }, { t0: 70, t1: 71 }) >= 0.15);
});

test("candidates: the line just before the laugh ranks first; same people and scene are checked", () => {
  const tl = talk();
  const R = findReactions(tl), C = findCauses(tl, R);
  const cs = candidates(tl, R, C, { profile: "speech" });
  const first = cs.filter((x) => x.reaction === R[0].id && x.rank === 1)[0];
  assert.equal(C.find((c) => c.id === first.cause).text, "انا قلتله روح هات الفلوس");
  assert.equal(first.direction, "after");
  assert.equal(first.checks.sameScene, true);
  assert.equal(first.checks.samePeople, true); // S2 laughs, P2 (S2's face) is on screen during the line
  assert.ok(!cs.some((x) => C.find((c) => c.id === x.cause).t0 >= 30), "the line at 30 s is outside every window");
  assert.equal(samePeople({ entities: ["P1"], voices: [] }, { entities: ["P3"], voices: ["S4"] }), false);
  assert.equal(samePeople({ entities: [], voices: [] }, { entities: ["P3"], voices: [] }), null);
  assert.deepEqual(peopleIn(tl, 2, 4).entities.sort(), ["P1", "P2"]);
});

test("event profile: the promise of the scene is always a candidate of the final reaction", () => {
  const tl = challenge();
  const doc = buildLinks(tl);
  assert.equal(doc.profile.kind, "event");
  const big = doc.reactions.find((r) => r.t0 <= 50 && r.t1 >= 50);
  const C = new Map(doc.causes.map((c) => [c.id, c]));
  assert.ok(doc.links.some((l) => l.reaction === big.id && C.get(l.cause).kind === "promise"));
  assert.ok(doc.links.some((l) => l.reaction === big.id && C.get(l.cause).kind === "action"));
});

test("unchecked links are never «متأكد»; a model yes makes the best link sure; nothing is dropped", () => {
  const cands = [
    { reaction: "R001", cause: "C001", prior: 1, direction: "after", offsetS: 2, gapS: 0.5, checks: { samePeople: true, sameScene: true } },
    { reaction: "R001", cause: "C002", prior: 0.5, direction: "after", offsetS: 6, gapS: 4, checks: { samePeople: true, sameScene: true } },
  ];
  const a = finalizeLinks(cands);
  assert.equal(a.length, 2);
  assert.ok(a.every((l) => l.status === "unsure" && l.label_ar === "مش متأكد" && l.confidence <= LINK_DEFAULTS.unverifiedCap));
  const b = finalizeLinks(cands, { "R001|C002": { yes: true, confidence: 0.9 }, "R001|C001": { yes: false, confidence: 0.8 } });
  const best = b.find((l) => l.best);
  assert.equal(best.cause, "C002");
  assert.equal(best.status, "sure");
  assert.equal(b.find((l) => l.cause === "C001").status, "unsure");
  assert.equal(b.find((l) => l.cause === "C002").keepGap, false); // 4 s gap > nearGapS
  assert.equal(semanticP(null), null);
  assert.equal(semanticP({ yes: false, confidence: 1 }), 0);
  // A reaction the model says is not one keeps its links, all «مش متأكد».
  const c = finalizeLinks(cands, { "R001|C002": { yes: true, confidence: 0.9 } }, { reactionChecks: { R001: { real: false, confidence: 0.9 } } });
  assert.equal(c.length, 2);
  assert.ok(c.every((l) => l.status === "unsure"));
});

test("questions and answers: lettered candidates, frames around the reaction, a long window narrowed to the moment", () => {
  const tl = challenge();
  const first = buildLinks(tl);
  const qs = verifyQueries(tl, first);
  assert.equal(qs.length, first.reactions.length);
  const big = first.reactions.find((r) => r.t0 <= 50 && r.t1 >= 50);
  const q = qs.find((x) => x.reaction === big.id);
  assert.ok(q.frames.length >= 4 && q.frames.length <= 12);
  assert.ok(q.frames.some((t) => t >= big.t0 - 0.3 && t <= big.t1 + 0.3));
  assert.equal(q.candidates[0].key, "A");
  const act = q.candidates.find((c) => c.kind === "action" && c.t0 === 36);
  assert.ok(act);
  const answers = { [big.id]: { reaction_real: true, reaction_confidence: 0.9, cause: act.key, cause_time: 46, confidence: 0.8, reason: "he lands the jump", also_related: [] } };
  const got = applyAnswers(qs, answers, first.causes, { engine: "test" });
  assert.equal(got.extra.length, 1);
  assert.deepEqual([got.extra[0].cause.t0, got.extra[0].cause.t1], [44.5, 46.5]);
  const doc = buildLinks(tl, { answers, verify: { engine: "test", available: true } });
  const best = doc.links.find((l) => l.reaction === big.id && l.best);
  const cause = doc.causes.find((c) => c.id === best.cause);
  assert.equal(cause.refines, act.cause);
  assert.equal(best.status, "sure");
  assert.equal(doc.schema, LINKS_SCHEMA);
  assert.ok(doc.report.verify.answers[big.id]);
  // "none": every candidate becomes a soft no; the links stay.
  const none = buildLinks(tl, { answers: { [big.id]: { reaction_real: true, cause: "none", cause_time: -1, confidence: 0.7, reason: "" } } });
  assert.ok(none.links.filter((l) => l.reaction === big.id).every((l) => l.status === "unsure" && l.checks.semantic?.yes === false));
});

/** A document with one sure link: cause 10–12 s, reaction 12.5–13.5 s (near), and one far link (cause 2–4, reaction 40–41). */
function protectedDoc() {
  return {
    reactions: [{ id: "R001", t0: 12.5, t1: 13.5, kind: "laughter" }, { id: "R002", t0: 40, t1: 41, kind: "applause" }],
    causes: [{ id: "C001", t0: 10, t1: 12, kind: "speech" }, { id: "C002", t0: 2, t1: 4, kind: "promise" }],
    links: [
      { id: "L001", reaction: "R001", cause: "C001", best: true, status: "sure", confidence: 0.9, direction: "after", gapS: 0.5, keepGap: true },
      { id: "L002", reaction: "R002", cause: "C002", best: true, status: "sure", confidence: 0.8, direction: "after", gapS: 36, keepGap: false },
    ],
  };
}

test("protection: a kept reaction brings its cause (and a near link its gap) back; µs scale works", () => {
  const doc = protectedDoc();
  const r = protectKeeps(doc, [[12.5, 14], [39, 42]]);
  assert.deepEqual(r.keeps, [[2, 4], [10, 14], [39, 42]]);
  assert.deepEqual(new Set(r.added.map((a) => a.why)), new Set(["cause", "gap"]));
  const us = protectKeeps(doc, [[12.5e6, 14e6]], { scale: 1e6 });
  assert.deepEqual(us.keeps, [[10e6, 14e6]]);
  assert.deepEqual(protectKeeps(doc, [[20, 30]]).added, [], "links with neither side kept are left alone");
  // Unsure links are protected only when asked.
  doc.links[0].status = "unsure";
  assert.ok(!protectKeeps(doc, [[12.5, 14]]).added.some((a) => a.link === "L001"));
  assert.ok(protectKeeps(doc, [[12.5, 14]], { includeUnsure: true }).added.some((a) => a.link === "L001"));
});

test("checking an edit: lost cause, split gap, wrong order, and a hook that borrows the reaction", () => {
  const doc = protectedDoc();
  const types = (segs) => checkEdit(doc, segs).map((v) => `${v.type}:${v.link}`).sort();
  assert.deepEqual(types([{ t0: 2, t1: 4 }, { t0: 10, t1: 13.5 }, { t0: 40, t1: 41 }]), []);
  assert.deepEqual(types([{ t0: 12.5, t1: 13.5 }]), ["cause_lost:L001"]);
  assert.deepEqual(types([{ t0: 10, t1: 11.9 }, { t0: 12.6, t1: 13.5 }]), ["split:L001"]);
  assert.deepEqual(types([{ t0: 12.4, t1: 13.5 }, { t0: 10, t1: 12.6 }]), ["order:L001"]);
  assert.deepEqual(types([{ t0: 40, t1: 41, hook: true }, { t0: 10, t1: 13.5 }]), ["hook_cause_missing:L002"]);
  assert.deepEqual(types([{ t0: 40, t1: 41, hook: true }, { t0: 2, t1: 4 }, { t0: 10, t1: 13.5 }, { t0: 40, t1: 41 }]), []);
  assert.ok(checkEdit(doc, [{ t0: 12.5, t1: 13.5 }])[0].message_ar.length > 0);
});

/** The model's answer we expect for talk(): each laugh is caused by the line that ends just before it. */
function lastLineAnswers(tl, doc) {
  return Object.fromEntries(verifyQueries(tl, doc).map((q) => {
    const c = q.candidates.filter((x) => x.kind === "speech" && x.t1 <= q.t0 + 0.05).sort((a, b) => b.t1 - a.t1)[0];
    return [q.reaction, { reaction_real: true, reaction_confidence: 0.9, cause: c.key, cause_time: c.t0, confidence: 0.9, reason: "", also_related: [] }];
  }));
}

test("moment roles: punch, reaction, setup before it, filler; every moment gets one of the five", () => {
  const tl = talk();
  const first = buildLinks(tl);
  const answers = lastLineAnswers(tl, first);
  const doc = buildLinks(tl, { answers });
  const M = assignRoles(tl, doc);
  assert.ok(M.every((m) => ROLES.includes(m.role) && m.role_ar));
  const at = (t) => M.find((m) => m.t0 <= t && t < m.t1);
  assert.equal(at(3).role, "punch");
  assert.equal(at(5.8).role, "reaction");
  assert.equal(at(9).role, "punch");
  assert.equal(at(30.5).role, "setup"); // plain information, no linked punch
  assert.equal(at(20).role, "filler"); // a calm stretch with nothing in it
  const units = momentUnits(tl, doc);
  for (let i = 1; i < units.length; i++) assert.ok(units[i].t0 >= units[i - 1].t1 - 1e-9, "moments do not overlap");
  // A promise is the setup of the challenge.
  const ch = challenge();
  const d2 = buildLinks(ch);
  const big = d2.reactions.find((r) => r.t0 <= 50 && r.t1 >= 50);
  const qs = verifyQueries(ch, d2);
  const promiseKey = qs.find((q) => q.reaction === big.id).candidates.find((c) => c.kind === "promise").key;
  const d3 = buildLinks(ch, { answers: { [big.id]: { reaction_real: true, cause: promiseKey, cause_time: 2, confidence: 0.9, reason: "", also_related: [] } } });
  assert.equal(assignRoles(ch, d3).find((m) => m.t0 <= 3 && 3 < m.t1).role, "setup");
});

test("labels: template, validation, precision and recall, pooled scores, the labelling page", () => {
  const tl = talk();
  const first = buildLinks(tl);
  const answers = lastLineAnswers(tl, first);
  const doc = buildLinks(tl, { answers });
  const L = labelTemplate(doc);
  assert.equal(L.schema, LABELS_SCHEMA);
  assert.equal(L.reactions.length, doc.reactions.length);
  // The first laugh is right (cause = the first line); the second laugh's real cause is the line at 8 s; one invented row is not a reaction.
  L.reactions[0].real = true; L.reactions[0].causes = [{ t0: 2, t1: 4.2 }];
  L.reactions[1].real = true; L.reactions[1].causes = [{ t0: 8, t1: 10.4 }];
  L.reactions.push({ id: "H9", t0: 50, t1: 51, kind: "laughter", real: true, unsure: false, noCause: true, causes: [] });
  assert.deepEqual(validateLabels(L), []);
  assert.ok(validateLabels({ schema: "x", reactions: [{ t0: 2, t1: 1 }] }).length >= 2);
  const e = evaluate(doc, L);
  assert.equal(e.counts.real, 3);
  assert.equal(e.reactions.recall, 0.667); // the hand-added laugh at 50 s was not found
  assert.equal(e.reactions.precision, 1);
  assert.equal(e.links.recall, 1);
  assert.equal(e.links.precision, 1);
  const p = pooled([e, e]);
  assert.equal(p.linkPrecision, 1);
  assert.equal(p.real, 6);
  const front = indexHtml([{ name: "x", doc, eval: e }], p);
  assert.ok(front.includes("x.labels.html") && front.includes("100 %"));
  assert.ok(labelPageHtml(doc, { fileName: "02-x.labels.json" }).includes('"fileName":"02-x.labels.json"'));
  const html = labelPageHtml(doc);
  assert.ok(html.includes("<video") && html.includes("حفظ الملف") && html.includes(doc.reactions[0].id));
  assert.ok(!/<\/script>[^]*<\/script>[^]*<\/script>/.test(html.replace(/<\/script><\/body>/, "")), "the embedded data cannot close the script");
});

test("WAV reader and sudden silences", () => {
  const sr = 1000, n = 6000;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  // 3 s of loud noise, then near silence, then quiet hum.
  for (let i = 0; i < n; i++) buf.writeInt16LE(i < 3000 ? Math.round(Math.sin(i * 1.7) * 12000) : i < 4500 ? Math.round(Math.sin(i) * 60) : Math.round(Math.sin(i) * 800), 44 + i * 2);
  const { samples, sampleRate } = readWav(buf);
  assert.equal(sampleRate, sr);
  assert.equal(samples.length, n);
  const env = envelopeDb(samples, sampleRate, 0.1);
  assert.equal(env.length, 60);
  const s = suddenSilences(env);
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].t0 - 3) < 0.15);
  assert.ok(s[0].dropDb > 30);
  assert.throws(() => readWav(Buffer.from("nope")));
});

test("decoys and calibration: questions away from every reaction; a model that says yes to decoys loses its weight", () => {
  const tl = challenge();
  const doc = buildLinks(tl);
  const X = controlQueries(tl, doc, { n: 4 });
  assert.ok(X.length >= 1 && X.length <= 4);
  assert.deepEqual(X, controlQueries(tl, doc, { n: 4 }), "deterministic");
  for (const q of X) {
    assert.ok(q.control && /^X\d\d$/.test(q.reaction));
    assert.ok(doc.reactions.every((r) => q.t0 <= r.t0 - 4 || q.t0 >= r.t1 + 4), "away from the reactions");
  }
  assert.equal(calibrationFrom(null), null);
  assert.deepEqual(calibrationFrom({ X01: { reaction_real: true, cause: "A" }, X02: { reaction_real: true, reaction_seen: "nothing_visible", cause: "none" } }), { n: 2, realRate: 0.5, causeRate: 0.5 });
  // The same yes, with and without a model that also says yes to every decoy.
  const qs = verifyQueries(tl, doc);
  const big = doc.reactions.find((r) => r.t0 <= 50 && r.t1 >= 50);
  const q = qs.find((x) => x.reaction === big.id);
  const ans = { [big.id]: { reaction_real: true, reaction_confidence: 0.9, cause: q.candidates[0].key, cause_time: -1, confidence: 0.9 } };
  const plain = applyAnswers(qs, ans, doc.causes);
  const blind = applyAnswers(qs, ans, doc.causes, { calibration: { n: 6, realRate: 1, causeRate: 1 } });
  const k = `${big.id}|${q.candidates[0].cause}`;
  assert.equal(plain.verdicts[k].confidence, 0.9);
  assert.equal(blind.verdicts[k].confidence, 0);
  assert.equal(blind.reactionChecks[big.id].confidence, 0);
  const d2 = buildLinks(tl, { answers: ans, controls: { X01: { reaction_real: true, cause: "A" } } });
  assert.ok(d2.links.filter((l) => l.reaction === big.id).every((l) => l.status === "unsure"), "a blind model makes nothing «متأكد»");
  assert.deepEqual(d2.report.verify.calibration, { n: 1, realRate: 1, causeRate: 1 });
});

test("answers stay pinned to the causes their letters meant; a time at a window's edge does not narrow it", () => {
  const tl = challenge();
  const doc = buildLinks(tl);
  const qs = verifyQueries(tl, doc);
  const big = doc.reactions.find((r) => r.t0 <= 50 && r.t1 >= 50);
  const q = qs.find((x) => x.reaction === big.id);
  const act = q.candidates.find((c) => c.kind === "action" && c.t0 === 36);
  const raw = { [big.id]: { reaction_real: true, cause: act.key, cause_frame: "45.50", cause_time: 36, confidence: 0.8 }, X01: { reaction_real: false, cause: "none" } };
  const { answers, controlAnswers } = splitAnswers(raw, qs, [{ reaction: "X01", candidates: [] }]);
  assert.equal(answers[big.id].cause_time, 45.5, "the named frame wins over a free time");
  assert.equal(answers[big.id]._map[act.key], act.cause);
  assert.ok(controlAnswers.X01);
  // Re-lettered questions (e.g. a new candidate order) still read the old answer right through _map.
  const shuffled = qs.map((x) => ({ ...x, candidates: x.candidates.map((c, i, all) => ({ ...c, key: all[all.length - 1 - i].key })) }));
  const got = applyAnswers(shuffled, answers, doc.causes);
  assert.equal(got.verdicts[`${big.id}|${act.cause}`].yes, true);
  // The model echoing the window's start time is not a moment inside it.
  const echo = applyAnswers(qs, { [big.id]: { reaction_real: true, cause: act.key, cause_time: 36, confidence: 0.8 } }, doc.causes);
  assert.equal(echo.extra.length, 0);
});

test("eye + ear: a heard laugh makes a reaction real; crying or talk heard leaves only a strong visible one", async () => {
  const { mergeAnswers } = await import("../../src/core/causeLinks.js");
  const m = { A: "C001", B: "C002" };
  const eye = (seen, cause, confidence = 0.8) => ({ reaction_real: seen !== "nothing_visible", reaction_seen: seen, reaction_confidence: 0.9, cause, cause_time: 3, confidence, _map: m });
  const ear = (heard, cause, confidence = 0.8) => ({ reaction_real: ["laughter", "cheering"].includes(heard), sound_heard: heard, reaction_confidence: 0.9, cause, cause_time: 3, confidence, _map: m });
  const r = mergeAnswers({ R1: eye("smiling", "A"), R2: eye("smiling", "A"), R3: eye("hands_on_head", "B"), R4: eye("nothing_visible", "none"), R5: eye("laughing", "A", 0.9) },
    { R1: ear("crying", "none"), R2: ear("laughter", "A"), R3: ear("talking", "B"), R4: ear("laughter", "B", 0.6), R5: ear("laughter", "B", 0.5) });
  assert.equal(r.R1.reaction_real, false, "a smile over a crying child is not a reaction");
  assert.equal(r.R2.reaction_real, true);
  assert.equal(r.R2.confidence, 0.9, "both name A: confidence up");
  assert.equal(r.R3.reaction_real, true, "hands on head is strong enough over talk");
  assert.equal(r.R4.reaction_real, true, "the ear heard a laugh the eye could not see");
  assert.equal(r.R4.cause, "B");
  assert.equal(r.R4.reaction_seen, "heard_laughter", "heard, not seen: still real downstream");
  assert.equal(r.R5.cause, "A");
  assert.equal(r.R5.confidence, 0.63);
  assert.deepEqual(r.R5.also_related, ["B"]);
  assert.equal(mergeAnswers(null, null), null);
  assert.equal(mergeAnswers({ R1: eye("smiling", "A") }, null).R1.cause, "A");
});

test("director view: best links with spans inline, in µs when asked; sure-only filter", async () => {
  const { directorView } = await import("../../src/core/causeLinks.js");
  const doc = { schema: LINKS_SCHEMA, media: null, profile: { kind: "speech" }, ...protectedDoc(), moments: [{ id: "M001", t0: 10, t1: 12, role: "punch", roleConfidence: 0.9, links: ["L001"] }] };
  doc.links[1].status = "unsure";
  const v = directorView(doc, { scale: 1e6 });
  assert.equal(v.unit, "us");
  assert.equal(v.links.length, 2);
  assert.deepEqual([v.links[0].cause.t0, v.links[0].reaction.t1], [10e6, 13.5e6]);
  assert.equal(v.moments[0].t1, 12e6);
  assert.equal(directorView(doc, { sureOnly: true }).links.length, 1);
});
