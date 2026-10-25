// The "compose" path's choices as the interface shows them: Arabic names that describe what is heard, and one line
// on what each changes. The ids and values are the engine's (engine/montaj_music/compose.py, ported from the source
// studio's original.py). All of them guide the model; none is a guarantee of the exact notes.
export const COMPOSE_PRESETS = [
  { id: "reference_vibe", ar: "قريبة من وصفك", help: "قطعة آلية فيها لحن واحد واضح ومساحة تتنفس؛ أنسب لما الوصف هو اللي يقود" },
  { id: "family_challenge", ar: "تحدي عائلي مضحك", help: "فرقة صغيرة نطاطة، وقفات كوميدية، وإيقاع يد خفيف" },
  { id: "suspense", ar: "ترقّب قبل المفاجأة", help: "نبض متقطع وتوتر بيعلى بالتدريج، ونهاية كشف قصيرة" },
  { id: "chase", ar: "مطاردة مرحة", help: "لحن سريع متقطع وإيقاع خفيف سريع" },
  { id: "egyptian_comedy", ar: "كوميديا مصرية", help: "فرقة مصرية مرحة، ردود آلية قصيرة ودربكة خفيفة" },
  { id: "happy_family", ar: "لحظات عائلية سعيدة", help: "جمل لحنية دافية ومبهجة بفرقة صغيرة" },
  { id: "competition", ar: "منافسة حماسية", help: "نبض قوي واثق، لازمة صاعدة وإيقاع قوي مضبوط" },
  { id: "secret_mission", ar: "غموض ومهمة سرية", help: "نبض منخفض متسلل ولازمة غامضة متباعدة" },
  { id: "emotional", ar: "مشهد عائلي مؤثر", help: "لحن هادي مؤثر، مساحة تتنفس، ومرافقة رقيقة" },
  { id: "winner", ar: "إعلان الفائز", help: "تصاعد قصير مهيب، لازمة لامعة، ونهاية حاسمة" },
  { id: "daily_vlog", ar: "طبخ وفلوج يومي", help: "مرافقة إيقاعية خفيفة وجمل مريحة تتكرر تحت الكلام" },
];

export const ENERGIES = [
  { id: "auto", ar: "حسب الطابع", help: "الطاقة اللي تناسب الطابع المختار" },
  { id: "calm", ar: "هادية", help: "طاقة أهدى وإيقاع أخف" },
  { id: "energetic", ar: "حماسية", help: "نبض أنشط وحيوية أعلى مع ديناميكية مضبوطة" },
];

export const VIBES = [
  { id: "close", ar: "ملتزمة بالوصف", help: "آلات وأسلوب أقرب للطابع المكتوب" },
  { id: "balanced", ar: "متوازنة", help: "توازن بين الالتزام بالطابع والتجديد" },
  { id: "free", ar: "حرة", help: "لون آلي مختلف وتجديد أكتر في نفس العائلة الموسيقية" },
];

export const METERS = [
  { id: 0, ar: "تلقائي" }, { id: 4, ar: "رباعي (4)" }, { id: 3, ar: "ثلاثي (3)" }, { id: 6, ar: "سداسي (6/8)" }, { id: 2, ar: "ثنائي (2)" },
];
export const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"].flatMap((n) => ["major", "minor"].map((m) => `${n} ${m}`));
export const DURATION = { min: 4, max: 180, preview: 15 };

const plain = (s) => String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");

/**
 * Suggestions from a free Arabic description (no language model — the source studio's rules): never applied on their
 * own; the interface shows them and the user picks. Returns { suggestions, ambiguous, scope }.
 */
export function interpret(text) {
  const t = plain(text), suggestions = {}, ambiguous = [];
  const patterns = {
    energy: { calm: ["هادي", "هادئ", "هاد"], energetic: ["حماس", "نشاط"] },
    vibe: { free: ["تجديد", "مختلف", "حر"], close: ["زي الوصف", "ملتزم"] },
  };
  for (const [key, choices] of Object.entries(patterns)) {
    const hits = Object.entries(choices).filter(([, terms]) => terms.some((w) => t.includes(plain(w)))).map(([v]) => v);
    if (hits.length === 1) suggestions[key] = hits[0];
    else if (hits.length > 1) ambiguous.push(key);
  }
  const moods = [["suspense", ["تشويق", "مشوق", "ترقب", "توتر"]], ["egyptian_comedy", ["كوميدي", "مصري"]], ["emotional", ["مؤثر", "حزين", "حزينه"]],
    ["happy_family", ["مبهج", "فرحان", "سعيد", "عائلي"]], ["competition", ["منافسه", "تحدي قوي"]], ["chase", ["مطارده", "جري"]], ["secret_mission", ["غموض", "غامض", "سري"]],
    ["winner", ["فائز", "فوز", "انتصار"]], ["daily_vlog", ["فلوج", "طبخ", "يومي"]], ["family_challenge", ["تحدي", "مضحك"]]];
  for (const [id, words] of moods) if (!suggestions.preset && words.some((w) => t.includes(plain(w)))) suggestions.preset = id;
  for (const p of COMPOSE_PRESETS) if (t.includes(plain(p.ar))) suggestions.preset = p.id;
  if (/بدون (طبول|ايقاع)|من غير (طبول|طبله|ايقاع)/.test(t)) suggestions.description = "no percussion";
  return { suggestions, ambiguous, scope: "قواعد عربية محددة؛ راجع الاقتراح قبل تطبيقه. النص الحر وحده لا يبدّل الاختيارات." };
}
