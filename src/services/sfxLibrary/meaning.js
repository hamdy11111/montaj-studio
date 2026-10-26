// Egyptian meaning tags for sound effects. A sound is chosen by what the moment MEANS («تريقة», «صدمة», «هيصة»…),
// not only by what happens; each tag carries the English descriptions CLAP understands (text → audio search, and the
// zero-shot tagging of every sound in the library), the Egyptian ways of saying it (for matching a request), and
// what kind of moment it belongs to (rules.js: no cartoon sounds in serious moments, a cap on comic sounds).
//   mood: "comic" | "joy" | "shock" | "serious" | "neutral"   cartoon: a cartoon/meme sound (never in serious moments)

export const MEANINGS = [
  { ar: "تريقة", alt: ["بتريق", "يتريق", "سخرية", "استهزاء", "تهزيق"], mood: "comic", cartoon: true,
    en: ["sarcastic cartoon trombone wah wah", "comedic mocking sound effect", "funny cartoon taunt"] },
  { ar: "قفشة", alt: ["قفش", "مسكته", "اتقفش", "ضبطته", "نكتة", "إفيه", "افيه"], mood: "comic", cartoon: true,
    en: ["rimshot drum ba dum tss joke sting", "comedic gotcha sting", "funny punchline drum hit"] },
  { ar: "فضيحة", alt: ["اتفضح", "فضحته", "جرسة", "اتجرس"], mood: "comic", cartoon: true,
    en: ["record scratch sudden stop", "embarrassing fail sound", "awkward comedic sting"] },
  { ar: "إحراج", alt: ["احراج", "محرج", "كسفة", "اتكسف", "سكتة", "صمت"], mood: "comic", cartoon: true,
    en: ["crickets chirping awkward silence", "awkward embarrassing silence", "small sad comedic sting"] },
  { ar: "صدمة", alt: ["مصدوم", "اتصدم", "مفاجأة", "مفاجأه", "اتخض", "خضة"], mood: "shock", cartoon: false,
    en: ["dramatic shock hit deep boom", "sudden dramatic sting", "gasp of surprise"] },
  { ar: "يا نهار أبيض", alt: ["يانهار ابيض", "يا نهار", "يا خبر", "يا لهوي", "يالهوي", "يا مصيبة", "مصيبة"], mood: "shock", cartoon: true,
    en: ["oh my god shocked meme sound", "dramatic boom meme", "dramatic disbelief sting"] },
  { ar: "حركة نص كم", alt: ["نص كم", "حركة بيئة", "بيئة", "رخمة", "سخيفة", "قديمة"], mood: "comic", cartoon: true,
    en: ["sad trombone fail", "lame cheap comedic fail sound", "cartoon disappointment sound"] },
  { ar: "هيصة", alt: ["هيصه", "فرح", "احتفال", "زيطة", "زفة", "مولد"], mood: "joy", cartoon: false,
    en: ["party crowd cheering and celebrating", "celebration party horns", "festive crowd applause"] },
  { ar: "لقطة", alt: ["لقطه", "تحفة", "جامدة", "جامد", "عظمة", "حلوة"], mood: "joy", cartoon: false,
    en: ["bright sparkle highlight ding", "shiny magical shimmer", "success chime"] },
  { ar: "فرحة", alt: ["مبسوط", "سعادة", "انبساط", "يااااي", "ياي"], mood: "joy", cartoon: false,
    en: ["happy cheerful chime", "kids cheering yay", "joyful short jingle"] },
  { ar: "ضحك", alt: ["بيضحك", "هزار", "موت من الضحك", "ضحكة"], mood: "comic", cartoon: false,
    en: ["audience laughing laugh track", "crowd laughter", "people laughing"] },
  { ar: "تصفيق", alt: ["سقفة", "سقف", "برافو", "تحية"], mood: "joy", cartoon: false,
    en: ["applause clapping crowd", "audience clapping", "people clapping hands"] },
  { ar: "فشل", alt: ["خيبة", "خسارة", "خسر", "باظت", "باظ", "فشلت", "هزيمة"], mood: "comic", cartoon: true,
    en: ["game over fail sound", "losing buzzer sad tune", "failure sound effect"] },
  { ar: "غلط", alt: ["خطأ", "غلطة", "لأ", "إجابة غلط"], mood: "neutral", cartoon: false,
    en: ["wrong answer buzzer", "error beep", "incorrect game show buzzer"] },
  { ar: "صح", alt: ["صحيح", "إجابة صح", "تمام", "مظبوط", "نجاح", "نجح"], mood: "joy", cartoon: false,
    en: ["correct answer chime", "success ding", "positive notification"] },
  { ar: "استغراب", alt: ["إيه ده", "ايه ده", "مش فاهم", "حيرة", "استعجاب", "عجيب"], mood: "comic", cartoon: true,
    en: ["confused cartoon sound what", "curious questioning cartoon sound", "boing question sound"] },
  { ar: "وقعة", alt: ["وقع", "اتزحلق", "اتكعبل", "سقوط", "طاح"], mood: "comic", cartoon: true,
    en: ["cartoon slip and fall", "slide whistle falling down", "cartoon crash fall"] },
  { ar: "ضربة", alt: ["رزعة", "خبطة", "بوكس", "لكمة", "قلم", "ضرب"], mood: "neutral", cartoon: false,
    en: ["heavy punch impact hit", "body hit thud", "strong impact boom"] },
  { ar: "دراما", alt: ["درامي", "تراجيدي", "مأساة", "حزين", "زعل"], mood: "serious", cartoon: false,
    en: ["dramatic orchestral hit", "sad emotional piano sting", "cinematic dramatic boom"] },
  { ar: "حزن", alt: ["حزين", "زعلان", "بكا", "عياط", "دموع"], mood: "serious", cartoon: false,
    en: ["sad violin sting", "melancholic piano note", "soft emotional drone"] },
  { ar: "تشويق", alt: ["توتر", "قلق", "ترقب", "استنى", "هيحصل ايه"], mood: "serious", cartoon: false,
    en: ["suspense tension drone", "rising suspense riser", "heartbeat tension"] },
  { ar: "رعب", alt: ["مرعب", "خوف", "بيخوف", "اتخضيت"], mood: "serious", cartoon: false,
    en: ["horror scary sting", "creepy jump scare hit", "scary dark drone"] },
  { ar: "تصاعد", alt: ["قبل المفاجأة", "بيعلى", "رايزر", "تمهيد"], mood: "neutral", cartoon: false,
    en: ["riser build up whoosh", "rising tension swell", "cinematic riser"] },
  { ar: "انتقال", alt: ["نقلة", "ترانزيشن", "تحويل", "مشهد جديد"], mood: "neutral", cartoon: false,
    en: ["transition swoosh", "fast whoosh transition", "glitch transition"] },
  { ar: "سرعة", alt: ["بسرعة", "طاير", "جري", "فوت", "ووش"], mood: "neutral", cartoon: false,
    en: ["fast whoosh", "quick swish pass by", "whip swoosh"] },
  { ar: "ظهور", alt: ["طلع", "بوب", "يظهر", "نط"], mood: "neutral", cartoon: false,
    en: ["cartoon pop", "bubble pop", "quick pop in"] },
  { ar: "سحر", alt: ["إبهار", "ابهار", "واو", "خيال", "سحري"], mood: "joy", cartoon: false,
    en: ["magic sparkle shimmer", "fairy magic chime", "enchanted glitter sound"] },
  { ar: "مطبخ", alt: ["أكل", "اكل", "طبخ", "تسوية", "تقطيع", "قلي", "سلطة"], mood: "neutral", cartoon: false,
    en: ["sizzling frying pan", "knife chopping vegetables", "kitchen cooking sounds", "eating crunch"] },
  { ar: "فلوس", alt: ["فلوس كتير", "مكسب", "كاش", "غالي", "رخيص", "تمن"], mood: "neutral", cartoon: false,
    en: ["cash register cha ching", "coins dropping", "money sound"] },
  { ar: "إشعار", alt: ["رسالة", "موبايل", "نوتيفكيشن", "تليفون"], mood: "neutral", cartoon: false,
    en: ["phone notification", "message alert ping", "smartphone notification sound"] },
  { ar: "كليك", alt: ["ضغطة", "زرار", "اختيار", "تكة"], mood: "neutral", cartoon: false,
    en: ["UI click", "button click", "mouse click"] },
  { ar: "وقفة", alt: ["استنى كده", "ستوب", "فريز", "لحظة"], mood: "comic", cartoon: true,
    en: ["record scratch freeze frame", "sudden stop rewind", "tape stop"] },
  { ar: "رومانسي", alt: ["حب", "عشق", "قلوب", "غزل"], mood: "comic", cartoon: true,
    en: ["cheesy romantic harp", "romantic meme music", "love chime"] },
  { ar: "غضب", alt: ["متعصب", "زعيق", "خناقة", "اتنرفز", "عصبية"], mood: "comic", cartoon: true,
    en: ["angry distorted meme", "cartoon angry steam", "boxing bell fight"] },
  { ar: "ملل", alt: ["زهق", "مفيش حاجة", "رخامة", "ممل"], mood: "comic", cartoon: true,
    en: ["crickets chirping", "yawn", "slow boring tick"] },
];

/** Arabic letters folded the way people type them (hamza forms, ta marbuta, alef maqsura, tatweel, diacritics). */
export const normalizeAr = (s) => String(s || "").toLowerCase()
  .replace(/[ً-ْٰـ]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
  .replace(/(.)\1{2,}/g, "$1$1") // "يااااي" → "ياي"-ish
  .replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/** Everyday Egyptian/Arabic words → English, for requests that name a thing rather than a meaning. */
export const WORDS = {
  باب: "door", عربيه: "car", عربية: "car", موتوسيكل: "motorcycle", ميه: "water", مية: "water", نار: "fire", مطر: "rain", رعد: "thunder",
  كلب: "dog", قطه: "cat", قطة: "cat", فرخه: "chicken", ديك: "rooster", طفل: "baby", عيل: "kid", عيال: "kids", ناس: "crowd", جمهور: "audience",
  كوبايه: "glass", كوباية: "glass", طبق: "plate", سكينه: "knife", سكينة: "knife", حله: "pot", حلة: "pot", طاسه: "pan", طاسة: "pan", زيت: "oil frying",
  شاي: "tea pouring", قهوه: "coffee", قهوة: "coffee", تلاجه: "fridge", تلاجة: "fridge", فرن: "oven", ميكروويف: "microwave beep",
  جرس: "bell", ساعه: "clock ticking", ساعة: "clock ticking", منبه: "alarm", صفاره: "whistle", صفارة: "whistle", طبله: "drum", طبلة: "drum",
  كاميرا: "camera shutter", صوره: "camera shutter", صورة: "camera shutter", كيبورد: "keyboard typing", كتابه: "typing", كتابة: "typing",
  تليفون: "phone ringing", موبايل: "phone", رساله: "message notification", رسالة: "message notification", فلوس: "money coins",
  بوكس: "punch", ضرب: "hit", خبط: "knock", كسر: "break glass", انفجار: "explosion", رصاص: "gunshot", صاروخ: "rocket",
  ضحك: "laughing", عياط: "crying", صريخ: "scream", زغروطه: "ululation celebration", زغروطة: "ululation celebration", تصفيق: "applause",
  رياح: "wind", هوا: "wind", بحر: "sea waves", موج: "waves", شارع: "street traffic", زحمه: "traffic", زحمة: "traffic", كوره: "football", كورة: "football",
  ووش: "whoosh", سويش: "swish", بوب: "pop", دينج: "ding", تيك: "tick", طرقعه: "snap", طرقعة: "snap", بوينج: "boing",
};

/** Tags of a request: the meanings it names (by tag or by an Egyptian alternative), as indexes into MEANINGS. */
export function meaningsOf(query) {
  const q = ` ${normalizeAr(query)} `;
  const out = [];
  MEANINGS.forEach((m, i) => {
    const forms = [m.ar, ...m.alt].map(normalizeAr).filter(Boolean);
    if (forms.some((f) => q.includes(` ${f} `) || (f.length >= 4 && q.includes(f)))) out.push(i);
  });
  return out;
}

/**
 * A request in Egyptian Arabic (or English) → what to search for: the meaning tags it names, English descriptions for
 * CLAP (the tags' own, the words it knows, and English words kept as they are), and the words left unknown (an
 * optional translator can add English for those).
 */
export function expandQuery(query) {
  const tags = meaningsOf(query);
  const en = tags.flatMap((i) => MEANINGS[i].en);
  const norm = normalizeAr(query);
  const unknown = [];
  const covered = new Set(tags.flatMap((i) => [MEANINGS[i].ar, ...MEANINGS[i].alt].map(normalizeAr).join(" ").split(" ")));
  const latin = [];
  for (const w of norm.split(" ").filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(w)) { latin.push(w); continue; }
    const hit = WORDS[w] || WORDS[w.replace(/^ال/, "")] || WORDS[w.replace(/^(و|ب|ل|ف)ال?/, "")];
    if (hit) en.push(hit);
    else if (!covered.has(w) && w.length > 2 && !STOP.has(w)) unknown.push(w);
  }
  if (latin.length) en.unshift(latin.join(" "));
  return { tags, en: [...new Set(en)], unknown };
}
const STOP = new Set(["عايز", "عاوز", "صوت", "حاجه", "حاجة", "زي", "لما", "لحظه", "لحظة", "بتاع", "بتاعة", "فيه", "كده", "اوي", "قوي", "شويه", "شوية", "مع", "على", "علي", "في", "من", "اللي", "الي", "ده", "دي", "هو", "هي", "انا", "عشان", "علشان", "مؤثر", "افكت", "ساوند"]);

/** Library category → the meanings its sounds usually carry (a prior added to CLAP's zero-shot scores). */
export const CATEGORY_MEANINGS = {
  comedy: ["تريقة", "قفشة", "فشل", "استغراب", "وقعة"], reactions: ["هيصة", "ضحك", "تصفيق", "صدمة"], drama: ["دراما", "تشويق", "صدمة"],
  kitchen: ["مطبخ"], transitions: ["انتقال", "سرعة"], impacts: ["ضربة", "صدمة"], risers: ["تصاعد", "تشويق"], whooshes: ["سرعة", "انتقال"],
  ui: ["كليك", "إشعار", "ظهور"], magic: ["سحر", "لقطة"],
};

/** Source tags (Mixkit pages, file-name words) that name a meaning outright. */
export const SOURCE_TAG_MEANINGS = {
  crickets: ["إحراج", "ملل"], "dj-record-scratch": ["وقفة", "فضيحة"], "record-scratch": ["وقفة", "فضيحة"], "game-over": ["فشل"], lose: ["فشل"], wrong: ["غلط"],
  correct: ["صح"], win: ["هيصة", "فرحة"], applause: ["تصفيق"], clapping: ["تصفيق"], cheer: ["هيصة"], party: ["هيصة"], laugh: ["ضحك"], gasp: ["صدمة"],
  wow: ["سحر", "صدمة"], fart: ["تريقة"], falling: ["وقعة"], slide: ["وقعة"], horror: ["رعب"], scary: ["رعب"], terror: ["رعب"], sad: ["حزن"], cry: ["حزن"],
  "suspense-music": ["تشويق"], heartbeat: ["تشويق"], swell: ["تصاعد"], coin: ["فلوس"], notification: ["إشعار"], click: ["كليك"], pop: ["ظهور"],
  magic: ["سحر"], sparkle: ["سحر", "لقطة"], cooking: ["مطبخ"], kitchen: ["مطبخ"], food: ["مطبخ"], eat: ["مطبخ"], punch: ["ضربة"], impact: ["ضربة"],
  whoosh: ["سرعة"], swoosh: ["سرعة"], transition: ["انتقال"], glitch: ["انتقال"], bruh: ["تريقة", "حركة نص كم"], "vine-boom": ["صدمة", "يا نهار أبيض"],
  "oh-my-god-vine": ["يا نهار أبيض"], "price-is-right-fail": ["فشل", "حركة نص كم"], "spongebob-fail": ["فشل", "تريقة"], triggered: ["غضب"],
  "romance-meme": ["رومانسي"], "illuminati-confirmed": ["قفشة"], "sanctuary-guardian-what": ["استغراب"], "omg-hell-nah": ["تريقة"], yippee: ["فرحة"],
  "anime-wow": ["سحر", "صدمة"], "wilhelm-scream": ["وقعة"], "windows-xp-error": ["غلط"], "dramatic-boomer": ["دراما", "صدمة"], kiss: ["رومانسي"],
};

/** Cartoon/meme sounds by their sources (rules.js keeps them out of serious moments). */
export const CARTOON_SOURCE_TAGS = new Set(["cartoon", "funny", "fart", "squeak", "toy", "game-show", "cute", "spin", "slide", "jump", "falling", "boing",
  "bruh", "fah", "mac-quack", "minecraft-hurt", "nelly-ahh", "omg-hell-nah", "price-is-right-fail", "romance-meme", "sanctuary-guardian-what", "skedaddle",
  "spongebob-fail", "triggered", "vine-boom", "illuminati-confirmed", "loading-lag", "bone-crack", "windows-xp-error", "anime-wow", "oh-my-god-vine", "yippee", "wilhelm-scream"]);
