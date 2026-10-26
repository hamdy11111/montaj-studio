// The director and the pieces under it (the edit-hamdy skill's rules — core/policy.js): creator pacing (beats kept), speech regions and the between-words gain,
// the static master gain (no per-clip loudness that lifted pauses), word scores and concepts, and a whole plan from a
// synthetic talk + person track that must validate as an edit plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { suggestCuts, speechRegions, correctWords, smartCuts, speechRemovals } from "../../src/core/speech.js";
import { POLICY } from "../../src/core/policy.js";
import { findNumbers } from "../../src/core/numbers.js";
import { detectMoments } from "../../src/core/moments.js";
import { qaPlan, fitHead, headInside, reasonsToWatch, deadSpans } from "../../src/core/qa.js";
import { directPlan, wordScore, conceptOf, visualBeats, videoFit, estimateWork } from "../../src/core/director.js";
import { reelSelect } from "../../src/core/reel.js";
import { EDIT_PLAN_SCHEMA } from "../../src/core/editPlan.js";
import { betweenWords, buildExport } from "../../src/core/exportGraph.js";
import * as ops from "../../src/core/timelineOps.js";
import { newTimeline } from "../../src/core/model.js";
import { US } from "../../src/core/util.js";

const W = (text, s, e) => ({ text, startUs: Math.round(s * US), endUs: Math.round(e * US) });
// Arabic talk: an opening, a concept (شعري), a question, a sentence with two nouns, an end.
const TALK = [
  W("دي", 0.5, 0.7), W("تجربة", 0.7, 1.3), W("جديدة.", 1.3, 1.9),
  W("انا", 3.0, 3.2), W("شعري", 3.2, 3.8), W("منكوش.", 3.8, 4.5),
  W("شايفين", 6.5, 7.0), W("ده؟", 7.0, 7.4),
  W("الفيديو", 9.0, 9.6), W("والصوت", 9.7, 10.3), W("مهمين.", 10.3, 11.0),
  W("ونشوف", 13.0, 13.5), W("التجربة.", 13.5, 14.2),
];
// Person track: head at x 0.4, room on the right; the head jumps (a close-up) inside the 4.5–6.5 s pause.
const TRACK = Array.from({ length: 150 }, (_, i) => {
  const t = i * 100_000, close = t > 5_200_000 && t < 6_000_000;
  return [t, 0.25, 0.1, 0.55, 1, 0.4, close ? 0.45 : 0.35, close ? 0.4 : 0.22, close ? 0.6 : 0.4, 0.3];
});

test("creator pacing: every pause cut, a beat kept after a question, protected moments never cut", () => {
  const cuts = suggestCuts(TALK, { style: "creator", durationUs: 15 * US });
  const after = (w) => cuts.find((c) => c.fromUs >= TALK[w].endUs && c.fromUs < TALK[w].endUs + US);
  assert.ok(after(7).reason.includes("beat"), "after «ده؟»: a beat");
  assert.equal(after(7).fromUs - TALK[7].endUs, 140_000, "40 % of the 350 ms beat after the question");
  assert.equal(after(2).fromUs - TALK[2].endUs, 72_000, "40 % of 180 ms at a sentence end");
  const kept = suggestCuts(TALK, { style: "creator", durationUs: 15 * US, keep: [[5_000_000, 5_600_000]] });
  assert.ok(kept.every((c) => c.toUs <= 5_000_000 || c.fromUs >= 5_600_000), "the protected moment stays");
});

test("speech regions and the between-words gain; the master gain is static", () => {
  const r = speechRegions([W("a", 1, 1.5), W("b", 1.6, 2), W("c", 3, 3.5)]);
  assert.deepEqual(r, [[880_000, 2_120_000], [2_880_000, 3_620_000]]);
  const e = betweenWords(r, 0, 1, 4 * US);
  assert.match(e, /^0\.1\+0\.9\*min\(1,clip\(/);
  assert.equal((e.match(/clip\(/g) || []).length, 2);
  assert.equal(betweenWords(r, 10 * US, 1, US), "0.1", "no words in this span: lowered");
  assert.equal(betweenWords(null, 0, 1, US), null, "words unknown: untouched");
  const tl = newTimeline("p", { width: 640, height: 360 });
  const media = { a: { id: "a", path: "a.mp4", type: "video", durationUs: 4 * US, width: 640, height: 360, hasAudio: true, hasVideo: true, sampleRate: 48000, videoCodec: "h264" } };
  const seg = ops.addMediaSegment(tl, media.a);
  seg.audioFx = { normalize: { enabled: true, targetLufs: -14 }, denoise: { enabled: true }, enhanceVoice: { enabled: false }, isolate: "none", voiceChanger: "none" };
  const caps = { encoders: new Set(["libx264"]), filters: new Set(), timeline: new Set() };
  const base = { media, width: 640, height: 360, fps: 30, mode: "audio", audio: { enabled: true, format: "aac" }, caps, speech: { a: r }, rnnModel: "C:/m/sh.rnnn" };
  const g = buildExport(tl, { ...base, masterGainDb: 6.5 }).graph;
  assert.doesNotMatch(g, /loudnorm/, "no per-clip dynamic loudness");
  assert.match(g, /volume=6\.50dB,alimiter=limit=0\.84:attack=5:release=60:level=0/);
  assert.match(g, /arnndn=model='C\\:\/m\/sh\.rnnn'/);
  assert.match(g, /volume='0\.1\+0\.9\*min\(1,clip/);
  assert.match(buildExport(tl, { ...base, measureLoudness: true }).graph, /ebur128/);
});

test("word scores prefer named concepts and nouns over verbs and participles; concepts survive prefixes", () => {
  assert.ok(wordScore("تجربة") > wordScore("شايفين"));
  assert.ok(wordScore("الفيديو") > wordScore("هتشوفوا"));
  assert.ok(wordScore("عيوب") > wordScore("عملنا"));
  assert.equal(wordScore("عليه"), -3);
  assert.equal(conceptOf("وشعري").emoji, "barber-pole");
  assert.equal(conceptOf("بالفلوس").emoji, "money-bag");
  assert.equal(conceptOf("قل"), null, "short stems do not catch unrelated words");
  assert.deepEqual(correctWords([{ t: "شاكله", s: 0, e: 1 }], [{ from: "شاكله", to: "شكله" }]).map((w) => w.t), ["شكله"]);
});

test("the director's plan (the skill's rules): angles never repeat, the head is never cropped, graphics never early; it validates and passes its guards", () => {
  const beats = visualBeats(TALK, TRACK);
  assert.equal(beats.length, 1, "the close-up inside the pause is a beat");
  const { plan, notes, qa } = directPlan({ mediaId: "m1", words: TALK, durationUs: 15 * US, track: TRACK, cta: "تابعني", captionTemplate: "clean-pro", corrections: [{ from: "منكوش", to: "منكوش!" }], media: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } });
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, plan), JSON.stringify(ajv.errors));
  assert.equal(plan.schema, "montaj.editplan/2");
  assert.ok(plan.segments.some((x) => x.fromUs <= beats[0][0] && x.toUs >= beats[0][1]), "the beat is not cut");
  assert.ok(plan.segments.every((x, i) => !i || x.fromUs > plan.segments[i - 1].toUs), "one clip: its kept spans in source order");
  assert.ok(plan.graphics.filter((g) => g.template !== "progress-bar" && g.template !== "follow-cta").every((g) => g.anchor?.word && g.reason), "every graphic lands on a word, with a reason");
  // Angles: medium and close alternate; within a 1080p source's sharpness the close shot is ×1.25.
  const angles = plan.zooms.filter((z) => z.reason.startsWith("angle"));
  assert.ok(angles.length >= 3);
  for (let i = 1; i < angles.length; i++) assert.notEqual(angles[i].scale, angles[i - 1].scale, "two shots in a row never share an angle");
  assert.ok(angles.every((z) => z.scale <= 1.25 + 1e-9), "no zoom past the source's sharpness (with the skill's ×1.25 floor)");
  assert.ok(angles.every((z) => z.x > 0), "the head is left of centre: the picture moves right");
  // Graphics: the opening's key word, «شعري» → 💈, never entering before their word.
  const t = (name) => plan.graphics.filter((g) => g.template === name);
  assert.ok(t("rise-behind").concat(t("emerge-side")).some((g) => g.params.text === "تجربة"));
  assert.ok(t("head-emoji").some((g) => g.params.emoji === "barber-pole"));
  const start = (w) => TALK.find((x) => x.text.startsWith(w)).startUs;
  assert.ok(t("rise-behind").every((g) => g.fromUs >= start(g.params.text) - 40_000), "an element never enters before its word");
  assert.equal(t("follow-cta")[0].params.text, "تابعني");
  assert.equal(plan.captions.template, "clean-pro");
  assert.ok(plan.stabilize && plan.audio.denoise && plan.audio.normalizeLufs === -14);
  assert.ok(qa.ok, JSON.stringify(qa.checks));
  assert.ok(qa.passed.includes("face.cropped") && qa.passed.includes("retention.dead") && qa.passed.includes("speech.lostWord"));
  assert.ok(notes.some((n) => n.startsWith("quality guards")));
});

test("the skill's pacing: question glued, more air after a sentence, never above 0.6 s; hesitations, stutters, restarts and hallucinations go — «اه» stays", () => {
  const P = POLICY.pace;
  const words = [W("انت", 0, 0.3), W("جاهز؟", 0.3, 0.8), W("اه", 2.0, 2.2), W("خلاص.", 2.2, 2.7), W("امممم", 4.0, 4.6), W("انا", 5.0, 5.2), W("انا", 5.4, 5.6), W("رحت", 5.6, 6.0), W("السوق", 6.0, 6.5)];
  const { cuts, removed } = smartCuts(words, { pace: P, rhythm: "mrbeast", durationUs: 7 * US });
  assert.equal(removed.get(4), "filler", "a stretched hesitation goes");
  assert.equal(removed.get(5), "stutter", "«انا انا»: the first goes");
  assert.ok(!removed.has(2), "«اه» means yes: it stays");
  const after = (i) => cuts.find((c) => c.fromUs >= words[i].endUs && c.fromUs < words[i].endUs + US);
  // After «جاهز؟» the kept silence is capped by the question gap (0.16 s), half on each side of the cut.
  assert.equal(Math.round(after(1).fromUs - words[1].endUs - P.wordPad.after * US), Math.round((Math.min(P.baseGap * P.rhythm.mrbeast, P.questionGap) * US) / 2));
  const calm = smartCuts(words, { pace: P, rhythm: "calm", durationUs: 7 * US }).cuts.find((x) => x.fromUs >= words[1].endUs && x.fromUs < words[1].endUs + US);
  assert.equal(Math.round(calm.fromUs - words[1].endUs - P.wordPad.after * US), Math.round((P.questionGap * US) / 2), "calm: the question is still glued to its answer");
  // After «خلاص.» the kept gap is base × rhythm = 0.15 s; the hesitation and the stutter are inside the cut.
  const c = after(3);
  assert.equal(Math.round(c.fromUs - words[3].endUs - P.wordPad.after * US), Math.round((P.baseGap * P.rhythm.mrbeast * US) / 2));
  assert.match(c.reason, /filler/);
  const r = speechRemovals([W("انا", 0, 0.2), W("كنت", 0.2, 0.5), W("انا", 0.9, 1.1), W("كنت", 1.1, 1.4), W("هناك", 1.45, 1.8), W("امبارح", 1.85, 2.3)]);
  assert.deepEqual([...r.keys()], [0, 1], "a restarted sentence: the first attempt goes");
  const deliberate = speechRemovals([W("عايز", 0, 0.3), W("اربعة.", 0.3, 0.8), W("عايز", 1.2, 1.5), W("اربعة.", 1.5, 2.0)]);
  assert.equal(deliberate.size, 0, "a deliberate repetition stays");
  assert.equal(speechRemovals([W("اشتركوا", 0, 0.4), W("في", 0.4, 0.5), W("القناة", 0.5, 1.0)]).get(0), "hallucination");
});

test("numbers said in Egyptian Arabic become graphics; lists become montages; moments are found", () => {
  const say = (txt, t0 = 0) => txt.split(" ").map((w, i) => W(w, t0 + i * 0.35, t0 + i * 0.35 + 0.3));
  const list = findNumbers(say("اشترينا ١٠٥ رغيف و٣٤ علبة و٩٦ عصير."));
  assert.deepEqual(list.numbers.map((x) => [x.label, x.kind]), [["١٠٥ رغيف", "list"], ["٣٤ علبة", "list"], ["٩٦ عصير", "list"]]);
  assert.equal(findNumbers(say("خسرنا ٨٠ جنيه")).numbers[0].label, "-٨٠ جنيه");
  assert.equal(findNumbers(say("خمسة وعشرين كيلو؟!")).numbers[0].kind, "impact");
  assert.equal(findNumbers(say("عشرتلاف جنيه")).numbers[0].value, 10000);
  assert.equal(findNumbers(say("مية وخمسين مرة")).numbers[0].value, 150);
  assert.equal(findNumbers(say("عندي واحد صاحبي")).numbers.length, 0, "«واحد» alone is a person");
  const m = detectMoments(say("يا نهار ابيض نجحت!"));
  assert.ok(m.some((x) => x.type === "shock" && x.score >= 3) && m.some((x) => x.type === "win"));
  const { plan, qa } = directPlan({ mediaId: "m1", words: [...say("النهارده اشترينا ١٠٥ رغيف و٣٤ علبة و٩٦ عصير.", 0.2), ...say("وبعدها خسرنا ٨٠ جنيه كمان.", 5)], durationUs: 8 * US, track: [] });
  assert.equal(plan.graphics.filter((g) => g.template === "list-item").length, 3);
  const loss = plan.graphics.find((g) => g.template === "counter");
  assert.ok(loss && loss.params.to === 80 && loss.params.prefix === "−" && loss.params.suffix === " جنيه");
  assert.ok(qa.passed.includes("sync.early"), "each point enters on its item's word");
});

test("the face guard keeps the head inside its margins, or lowers the zoom; a letterboxed axis is never cropped", () => {
  const box = { top: 0.2, bottom: 0.45, left: 0.35, right: 0.55, cx: 0.45, cy: 0.32 };
  for (const z of [1.18, 1.42, 1.8]) { const f = fitHead(z, box); assert.ok(headInside(f, box), `×${z}`); }
  const tall = { top: 0.02, bottom: 0.9, left: 0.3, right: 0.7, cx: 0.5, cy: 0.46 };
  assert.ok(fitHead(1.42, tall).scale < 1.42, "a head filling the frame: the zoom is reduced");
  assert.ok(!headInside({ scale: 1.6, x: 0, y: -0.3 }, box), "a window that cuts the hair is caught");
  const lb = videoFit({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
  assert.ok(lb.dx === 1 && lb.dy < 0.4 && lb.sharpZoom > 1.7);
  assert.equal(fitHead(1.42, box, lb).y, 0, "the letterboxed axis is not moved");
});

test("quality guards catch a cut inside a word, a lost word, a dead stretch, crowded sounds and emoji, an early word", () => {
  const words = [W("كلمة", 0, 1), W("تانية", 1.2, 2), W("بعدين", 9, 10)];
  const bad = {
    cuts: [{ mediaId: "m", fromUs: 700_000, toUs: 1_100_000 }, { mediaId: "m", fromUs: 1_300_000, toUs: 1_900_000 }],
    graphics: [
      { mediaId: "m", template: "head-emoji", fromUs: 2_000_000, toUs: 3_000_000, params: { emoji: "fire" }, sfx: true },
      { mediaId: "m", template: "head-emoji", fromUs: 2_500_000, toUs: 3_500_000, params: { emoji: "fire" }, sfx: true },
      { mediaId: "m", template: "emerge-side", fromUs: 6_000_000, toUs: 7_000_000, params: { text: "بعدين" }, sfx: false },
      { mediaId: "m", template: "word-stack", fromUs: 6_500_000, toUs: 8_000_000, params: { words: ["كلمة"] }, sfx: false },
    ],
    zooms: [], sfx: [],
  };
  const qa = qaPlan(bad, { words, durationUs: 10 * US });
  const ids = new Set(qa.checks.map((c) => c.id));
  for (const id of ["speech.cutInsideWord", "speech.lostWord", "emoji.gap", "emoji.repeat", "sfx.gap", "sync.early", "text.overlap"]) assert.ok(ids.has(id), id);
  assert.equal(qa.ok, false);
  const dead = deadSpans(reasonsToWatch({ graphics: [], zooms: [] }, { words: [W("كلام", 0, 1)], cuts: [] }), 14 * US);
  assert.equal(dead.length, 1, "14 s with nothing new");
});

test("a selfie close-up (the head fills the frame, the model's face class runs down the neck): only zooms that fit, never below ×1.02", () => {
  // Hair at the top edge, the "head" box reaching the bottom of a 16:9 frame; the person moves a little.
  const big = Array.from({ length: 150 }, (_, i) => [i * 100_000, 0.2, 0, 0.75, 1, 0.45 + 0.05 * Math.sin(i / 9), 0.5, 0.33 + 0.08 * (i % 30 > 20), 1.0, 0.5]);
  const { plan, qa } = directPlan({ mediaId: "m1", words: TALK, durationUs: 15 * US, track: big, media: { width: 1920, height: 1080 }, canvas: { width: 1920, height: 1080 } });
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.ok(ajv.validate(EDIT_PLAN_SCHEMA, plan), JSON.stringify(ajv.errors));
  assert.ok(plan.zooms.every((z) => z.scale >= 1.02));
  assert.ok(plan.zooms.length > 0, "the chin is estimated from the head's width: zooms are possible");
  assert.ok(qa.passed.includes("face.cropped"));
});

test("a reel from a long talk: the strongest whole sentences within the target, in order; the opening always stays", () => {
  // 40 sentences of ~2.4 s each (~110 s of speech): plain ones, a stakes line, a result, a laugh.
  const words = [];
  let t = 0.5;
  const line = (txt) => { for (const w of txt.split(" ")) { words.push(W(w, t, t + 0.35)); t += 0.4; } t += 0.9; };
  line("النهارده هنجرب حاجة جديدة خالص.");
  for (let i = 0; i < 36; i++) line(i === 12 ? "لو نجحنا هنكسب مليون جنيه." : i === 25 ? "في الآخر نجحنا وعملناها!" : i === 30 ? "يا نهار ابيض ده حصل بجد." : "وبعدين رحنا هناك وشفنا الدنيا.");
  line("تابعوني عشان الجاي.");
  const moments = detectMoments(words);
  const sel = reelSelect(words, { targetUs: 20 * US, moments });
  const kept = sel.units.filter((u) => u.kept);
  assert.ok(kept[0].must && kept[0].text.startsWith("النهارده"), "the opening stays");
  assert.ok(kept.some((u) => u.role === "stakes") && kept.some((u) => u.role === "result") && kept.some((u) => /يا نهار/.test(u.text)), "stakes, result and the reaction are chosen first");
  assert.ok(sel.estUs <= 20 * US, `${sel.estUs}`);
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i].w0 > kept[i - 1].w1, "the video's order is kept");
  // In the director: a 20 s reel, paced, within 2 s of the target, no word cut inside a kept sentence.
  const { plan, qa, notes } = directPlan({ mediaId: "m1", words, durationUs: Math.round((t + 1) * US), track: [], targetUs: 20 * US, retakes: false });
  assert.ok(qa.stats.editUs <= 22 * US, `${qa.stats.editUs}`);
  assert.ok(qa.passed.includes("speech.cutInsideWord") && qa.passed.includes("speech.lostWord"));
  assert.ok(notes.some((n) => n.startsWith("reel of 20 s")));
  assert.ok(plan.segments.some((x) => /reel/.test(x.reason || "")));
});

test("the work estimate: stages weighted by measured speeds; cached stages are nearly free; a fast run drops the slow steps", () => {
  const full = estimateWork({ durationS: 1163, width: 1280, height: 720 }); // the 19-minute 720p video
  assert.deepEqual(full.stages.map((s) => s.key), ["words", "stabilize", "person", "plan", "apply"]);
  assert.ok(full.totalSec > 18 * 60 && full.totalSec < 26 * 60, `${full.totalSec}`); // measured there: ~10.5 min stabilizing + ~8 min mask
  const hd = estimateWork({ durationS: 76 });
  assert.ok(Math.abs(hd.totalSec - 186) < 40, `${hd.totalSec}`); // 1080p30, 76 s: measured 186 s
  const fast = estimateWork({ durationS: 1163, width: 1280, height: 720, stabilize: false, person: false });
  assert.ok(fast.totalSec < 4 * 60, `${fast.totalSec}`);
  const again = estimateWork({ durationS: 1163, cached: { words: true, stabilize: true, person: true } });
  assert.ok(again.totalSec < 3 * 60, `${again.totalSec}`);
});
