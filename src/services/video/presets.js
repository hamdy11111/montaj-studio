// The description helper's choices (ported from the user's H3 Studio prompt assistant): the scene, the character's
// rendering style and optional extra attention. Each fills the two text fields with plain English the model reads; the
// Arabic labels and help are what the user sees. Nothing here calls a model or the network.
export const CHARACTER_BASE = "Keep the identity shown in <Picture 1>: its facial structure, hairstyle, body proportions and visible outfit remain consistent throughout the clip. Use the reference for appearance while following the source performer's pose and movement.";

export const SCENES = [
  { id: "general", ar: "عام — مناسب كبداية", help: "الصورة بتحدد الشخصية، والفيديو بيحدد الحركة والتوقيت والكاميرا.",
    text: "Follow the source performer's actions, expressions, gaze and timing throughout the selected video segment. Keep the original framing, camera movement, background and interaction with the environment." },
  { id: "talking", ar: "شخص بيتكلم", help: "بيركّز على تعبيرات الوش وحركة الفم وقت الكلام.",
    text: "During visible speech, follow the source performer's mouth shapes, pauses, eye movements, facial expressions and small head gestures at their original timing. Keep the reference identity stable as the face moves. Preserve the source camera framing and environment." },
  { id: "singing", ar: "غُنا", help: "بيتبع أداء المغني وحركة فمه؛ وصوت المصدر بيتحكم فيه اختيار الصوت.",
    text: "Follow the visible singer's mouth articulation, breaths, facial expression, head movement and gestures at the same moments as the source performance. Preserve the singer's visible pauses and the reference character's identity throughout the performance." },
  { id: "movement", ar: "حركة أو رقص", help: "بيركّز على تسلسل حركة الجسم وثبات الأطراف والهدوم.",
    text: "Follow the source performer's body pose, weight shifts, foot placement, arm gestures and hand movement in the same sequence and at the same timing. Keep the reference body proportions consistent as the character turns and moves. Let the reference clothing follow that movement naturally, including source occlusions and contact with the environment." },
  { id: "closeup", ar: "لقطة قريبة للوش", help: "بيركّز على الملامح والنظرات والتعبيرات اللي في اللقطة.",
    text: "Preserve the source framing and camera distance. Give attention to the reference character's facial structure, eyes, eyebrows and hairstyle as the source performer changes expression and turns the head. Follow the source gaze, blinking and visible mouth movement with consistent facial proportions." },
];

export const STYLES = [
  { id: "reference", ar: "زي الصورة المرجعية", help: "بيحافظ على طريقة رسم الشخصية أو تصويرها زي ما هي في الصورة.",
    prompt: "Preserve the visual rendering style of <Subject 1> as shown in <Picture 1>, including its characteristic shapes, surface appearance and level of stylization. Integrate the character into the source scene while retaining that reference style." },
  { id: "realistic", ar: "واقعي", help: "بيخلّي الشخصية شكلها فوتوغرافي؛ ممكن يغيّر طابع صورة كرتونية.",
    prompt: "Render <Subject 1> photorealistically, with natural surface detail and materials, while retaining the reference identity, proportions and outfit. Integrate the character into the source scene." },
  { id: "cartoon", ar: "كرتوني", help: "بيخلّي الشخصية مرسومة كرتون، والخلفية تفضل زي الفيديو.",
    prompt: "Render <Subject 1> as an illustrated cartoon character with coherent contours, consistent shapes and a stable color palette based on the reference identity and outfit. Preserve the source background and camera framing." },
  { id: "three_d", ar: "ثلاثي الأبعاد", help: "بيخلّي الشخصية أنيميشن 3D جوّه المشهد الأصلي.",
    prompt: "Render <Subject 1> as a coherent three-dimensional animated character with consistent volume, materials and shading, retaining the reference identity, proportions and outfit. Preserve the source background and camera framing." },
];

export const PRIORITIES = [
  { id: "outfit", ar: "تفاصيل الهدوم", help: "اهتمام بألوان الهدوم ونقوشها وخاماتها اللي في الصورة.", field: "characterNotes",
    text: "Pay attention to the visible outfit colors, patterns, fabric appearance and garment shapes in <Picture 1>, keeping them consistent as the character moves." },
  { id: "accessories", ar: "الإكسسوارات الظاهرة", help: "بيحافظ على الإكسسوارات اللي في الصورة لو ظاهرة في اللقطة.", field: "characterNotes",
    text: "Retain the accessories actually visible on the reference character wherever they are visible in the target framing, keeping their shape and placement consistent with the character's movement." },
  { id: "lighting", ar: "إضاءة المشهد", help: "بيظبط الإضاءة والضل على الشخصية عشان تناسب الفيديو.", field: "instructions",
    text: "Match the source scene's light direction, shadow placement and color temperature on the replacement character, interpreted within the selected rendering style, so the character belongs to the same environment." },
];

/** The helper's output for a choice: the two text fields and the style (the user can edit both before generating). */
export function composeDescription({ scene = "general", style = "reference", priorities = [] } = {}) {
  const sc = SCENES.find((x) => x.id === scene) || SCENES[0];
  const st = STYLES.find((x) => x.id === style) || STYLES[0];
  const parts = { characterNotes: [CHARACTER_BASE], instructions: [sc.text] };
  for (const p of PRIORITIES) if (priorities.includes(p.id)) parts[p.field].push(p.text);
  return { characterNotes: parts.characterNotes.join("\n"), instructions: parts.instructions.join("\n"), promptStyle: st.id };
}
