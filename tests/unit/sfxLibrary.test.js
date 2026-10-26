// Sound-effects library: Egyptian request → meanings and English, the usage rules, meaning tagging from CLAP scores,
// user-pack categories, and search over a small fake index (no Python, no model).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandQuery, meaningsOf, normalizeAr, MEANINGS } from "../../src/services/sfxLibrary/meaning.js";
import { checkSfxPlan, enforceSfxPlan, soundAllowed, moodAt, SFX_RULES } from "../../src/services/sfxLibrary/rules.js";
import { SfxLibraryService, assignMeanings, categoryOfFile, SFX_TOOLS, sfxToolHandlers } from "../../src/services/sfxLibrary.js";
import { parseMixkitPage, save } from "../../src/services/sfxLibrary/fetch.js";
import { US } from "../../src/core/util.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montaj-sfx-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const tagOf = (ar) => MEANINGS.findIndex((m) => m.ar === ar);

test("Egyptian requests: meanings by tag or by an everyday way of saying it, words translated, the rest left unknown", () => {
  assert.equal(normalizeAr("يا نَهار أبْيَض!!"), "يا نهار ابيض");
  assert.deepEqual(meaningsOf("يانهار ابيض على ده"), [tagOf("يا نهار أبيض")]);
  assert.ok(meaningsOf("عايز صوت تريقة").includes(tagOf("تريقة")));
  assert.ok(meaningsOf("لما اتفضح قدام الناس").includes(tagOf("فضيحة")));
  assert.ok(meaningsOf("هيصه وزيطة").includes(tagOf("هيصة")));
  const e = expandQuery("صوت باب بيتقفل جامد");
  assert.ok(e.en.includes("door"), "باب → door");
  assert.ok(e.unknown.includes("بيتقفل"), "an unknown verb is left for the translator");
  const en = expandQuery("cartoon boing");
  assert.equal(en.en[0], "cartoon boing", "English stays as it is");
  const t = expandQuery("قفشة");
  assert.ok(t.en.some((x) => /rimshot/.test(x)), "a meaning brings its CLAP descriptions");
});

test("rules: no cartoon in serious moments, comic sounds capped and spaced, any two sounds 1 s apart", () => {
  const cartoon = { id: "c", cartoon: true, comic: true }, sting = { id: "s", cartoon: false, comic: false };
  const moments = [{ startUs: 10 * US, endUs: 20 * US, mood: "sad" }];
  assert.equal(moodAt(moments, 15 * US), "sad");
  assert.equal(moodAt(moments, 25 * US), "neutral");
  assert.equal(soundAllowed(cartoon, "sad").ok, false);
  assert.equal(soundAllowed(sting, "sad").ok, true, "a dramatic sting is fine in a serious moment");
  const v = checkSfxPlan([{ atUs: 12 * US, sound: cartoon }, { atUs: 12.5 * US, sound: sting }], { moments });
  assert.deepEqual(v.map((x) => x.rule).sort(), ["cartoon-in-serious", "too-close"]);
  // Five comic sounds 9 s apart in a minute: two over the cap of 3.
  const ev = [0, 9, 18, 27, 36].map((s, i) => ({ atUs: (30 + s) * US, sound: { id: `c${i}`, comic: true } }));
  assert.ok(checkSfxPlan(ev).some((x) => x.rule === "comic-per-minute"));
  const r = enforceSfxPlan(ev);
  assert.equal(r.kept.length, SFX_RULES.comicPerMin);
  assert.equal(r.dropped.length, 2);
  // Priority wins: the high-priority sound stays even though it comes later.
  const p = enforceSfxPlan([{ atUs: 0, sound: { id: "a", comic: true } }, { atUs: 3 * US, sound: { id: "b", comic: true }, priority: 5 }]);
  assert.deepEqual(p.kept.map((e) => e.sound.id), ["b"]);
  assert.equal(p.dropped[0].rule, "comic-too-close");
  // Layered: two sounds 0.05 s apart are one event.
  assert.deepEqual(checkSfxPlan([{ atUs: 0, sound: sting }, { atUs: 50_000, sound: sting }]), []);
});

test("meaning tags: standardised CLAP scores plus the sound's own source tags; cartoon and comic flags follow", () => {
  const M = MEANINGS.length;
  const sounds = [
    { id: "a", category: "comedy", sourceTags: ["cartoon", "funny"] },
    { id: "b", category: "impacts", sourceTags: ["impact"] },
    { id: "c", category: "drama", sourceTags: ["sad"] },
    { id: "d", category: "ui", sourceTags: ["click"] },
  ];
  const sims = new Float32Array(sounds.length * M).fill(0.1);
  sims[0 * M + tagOf("تريقة")] = 0.5; // a stands out for mockery
  sims[1 * M + tagOf("صدمة")] = 0.45;
  const t = assignMeanings(sounds, sims, { zMin: 1.2 });
  assert.ok(t[0].tagsAr.includes("تريقة"));
  assert.ok(t[0].cartoon && t[0].comic);
  assert.ok(t[1].tagsAr.includes("صدمة") && t[1].tagsAr.includes("ضربة"), "zero-shot + source tag");
  assert.ok(t[2].tagsAr.includes("حزن") && !t[2].comic && !t[2].cartoon);
  assert.ok(t[3].tagsAr.includes("كليك"));
});

test("user packs: UCS CatIDs and folder words give the category", () => {
  assert.equal(categoryOfFile("BOOM Toons/WHSH_Cartoon Fast Swipe 01.wav"), "whooshes");
  assert.equal(categoryOfFile("TOON_Boing Spring_BOOM.wav"), "comedy");
  assert.equal(categoryOfFile("Sonniss/Kitchen/Pan Sizzle 02.wav"), "kitchen");
  assert.equal(categoryOfFile("misc/Big Impact Hit.wav"), "impacts");
});

test("Mixkit page parsing: id, title and the page's tags of each card", () => {
  const html = `<div data-controller="audio-player" data-audio-player-item-id-value="108" x><h2 class="item-grid-card__title">
      Silly pop cluster
  </h2><a class="meta-links__link" href="/free-sound-effects/pop/">Pop</a><a href="/free-sound-effects/cartoon/">Cartoon</a>
  <div class="item-grid-sfx-preview__meta-time">0:01</div><a href="/free-sound-effects/other/">x</a></div>`;
  assert.deepEqual(parseMixkitPage(html), [{ id: "108", title: "Silly pop cluster", tags: ["pop", "cartoon"] }]);
});

test("search: CLAP score + meaning-tag bonus, mood rules, recent penalty, import in place; director tools", async () => {
  const sounds = [
    { id: "boing", source: "mixkit", file: "files/boing.wav", title: "Cartoon boing", category: "comedy", sourceTags: ["cartoon"], tagsAr: ["تريقة"], cartoon: true, comic: true, stats: { accentS: 0.1 } },
    { id: "boom", source: "remotion", file: "files/boom.wav", title: "Deep boom", category: "impacts", sourceTags: ["vine-boom"], tagsAr: ["صدمة"], cartoon: false, comic: false, stats: { accentS: 0 } },
    { id: "sad", source: "mixkit", file: "files/sad.wav", title: "Sad piano", category: "drama", sourceTags: ["sad"], tagsAr: ["حزن"], cartoon: false, comic: false },
  ];
  save(dir, sounds);
  const D = 4;
  const rows = { boing: [1, 0, 0, 0], boom: [0, 1, 0, 0], sad: [0, 0, 1, 0] };
  fs.writeFileSync(path.join(dir, "clap_index.json"), JSON.stringify({ dims: D, ids: Object.keys(rows), meta: {} }));
  fs.writeFileSync(path.join(dir, "clap_audio.f32"), Buffer.from(new Float32Array(Object.values(rows).flat()).buffer));
  const lib = new SfxLibraryService({ dir });
  const q = [0.8, 0.6, 0, 0]; // close to boing, then boom
  let r = await lib.search("تريقة", { textVectors: [q] });
  assert.equal(r.results[0].id, "boing");
  assert.equal(r.results[0].leadUs, 100_000);
  assert.ok(r.results[0].file.endsWith(path.join("files", "boing.wav")));
  r = await lib.search("صدمة", { textVectors: [[0.7, 0.65, 0, 0]] });
  assert.equal(r.results[0].id, "boom", "the meaning tag outweighs a slightly better CLAP match");
  r = await lib.search("تريقة", { textVectors: [q], mood: "sad" });
  assert.deepEqual(r.results, [], "a comic meaning in a sad moment: nothing");
  assert.equal(r.blocked, "comic-in-serious");
  r = await lib.search("صدمة", { textVectors: [q], mood: "sad" });
  assert.ok(!r.results.some((x) => x.id === "boing"), "no cartoon sound in a sad moment");
  r = await lib.search("تريقة", { textVectors: [q], recent: ["boing"], limit: 3 });
  assert.ok(r.results.find((x) => x.id === "boing").score < 0.92);
  // Import a user's pack in place.
  const pack = path.join(dir, "pack", "BOOM Toons");
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, "TOON_Slide Whistle Down.wav"), "x");
  const imp = lib.importFolder(path.join(dir, "pack"), { name: "BOOM" });
  assert.deepEqual(imp, { added: 1, total: 4 });
  assert.equal(lib.importFolder(path.join(dir, "pack"), { name: "BOOM" }).added, 0, "importing again adds nothing");
  const st = lib.status();
  assert.equal(st.bySource.user, 1);
  // Director tools.
  assert.deepEqual(SFX_TOOLS.map((t) => t.name), ["sfx_search", "sfx_check_plan"]);
  const h = sfxToolHandlers(lib);
  const plan = h.sfx_check_plan({ events: [{ atUs: 0, soundId: "boing" }, { atUs: 2 * US, soundId: "boing" }, { atUs: 4 * US, soundId: "boom" }] });
  assert.equal(plan.kept.length, 2);
  assert.equal(plan.dropped[0].rule, "comic-too-close");
});
