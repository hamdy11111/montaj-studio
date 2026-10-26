// A short Arabic HTML page per analysed file: what the perception layer found (speakers ↔ faces, laughs, sounds,
// feelings, shots and the shot log), a strip of the timeline, and each stage's time and GPU memory. Pure: timeline →
// HTML string (no external files; the face thumbnails, when given, are data URIs).
import { countByType } from "./timeline.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clock = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, "0")}`; };
const sec = (ms) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} ث`);

export const TYPE_AR = {
  word: "كلمات", utterance: "جمل", pause: "سكتات", speaker_turn: "أدوار الكلام", overlap: "كلام متداخل", face_track: "مسارات الوشوش",
  active_speaker: "بيتكلم في الصورة", audio_tag: "أصوات", laughter: "ضحك", emotion: "إحساس", loudness_spike: "علو مفاجئ",
  pitch_spike: "نبرة عالية", shot: "لقطات", shot_log: "وصف اللقطات",
};
const STAGE_AR = { words: "الكلام + المحاذاة", speakers: "المتكلمين", audio: "الأصوات والضحك", emotion: "الإحساس", shots: "حدود اللقطات", faces: "الوشوش", asd: "مين بيتكلم", vision: "عين Qwen3.6" };
const EMO_AR = { angry: "غضب", disgusted: "قرف", fearful: "خوف", happy: "فرحة", neutral: "عادي", other: "تاني", sad: "حزن", surprised: "مفاجأة" };
const LANES = [["speaker_turn", "#5b8def"], ["overlap", "#e8590c"], ["active_speaker", "#2f9e44"], ["laughter", "#f59f00"], ["audio_tag", "#868e96"], ["loudness_spike", "#e03131"], ["pitch_spike", "#ae3ec9"], ["shot", "#1098ad"]];

function strip(tl) {
  const d = tl.media?.duration || Math.max(1, ...tl.events.map((e) => e.t1));
  const W = 1000, lh = 16;
  const speakers = [...new Set(tl.events.filter((e) => e.type === "speaker_turn").map((e) => e.speaker))];
  const hue = (s) => ["#5b8def", "#d6336c", "#37b24d", "#f08c00", "#7048e8", "#0ca678"][Math.max(0, speakers.indexOf(s)) % 6];
  const rows = LANES.map(([type, color], i) => {
    const ev = tl.events.filter((e) => e.type === type);
    const rects = ev.map((e, k) => {
      const x = (e.t0 / d) * W, w = Math.max(1, ((e.t1 - e.t0) / d) * W);
      const fill = type === "speaker_turn" ? hue(e.speaker) : type === "shot" ? (k % 2 ? "#1098ad" : "#66d9e8") : color;
      return `<rect x="${x.toFixed(1)}" y="${i * (lh + 4)}" width="${w.toFixed(1)}" height="${lh}" fill="${fill}"><title>${esc(TYPE_AR[type])} ${clock(e.t0)}–${clock(e.t1)} ${esc(e.speaker || e.entity || e.text || "")}</title></rect>`;
    }).join("");
    return `<text x="${W + 8}" y="${i * (lh + 4) + 12}" font-size="11" fill="currentColor">${esc(TYPE_AR[type])}</text>${rects}`;
  }).join("");
  const ticks = Array.from({ length: Math.floor(d / 30) + 1 }, (_, k) => `<text x="${((k * 30) / d) * W}" y="${LANES.length * (lh + 4) + 12}" font-size="10" fill="currentColor">${clock(k * 30)}</text>`).join("");
  return `<svg viewBox="0 0 ${W + 110} ${LANES.length * (lh + 4) + 18}" width="100%" style="direction:ltr">${rows}${ticks}</svg>`;
}

/** The page. `extra.thumbs`: {P1: dataUri}; `extra.check`: the hand-check rows ([{t, what, verdict, note}]). */
export function summaryHtml(tl, extra = {}) {
  const c = countByType(tl.events);
  const ev = (t) => tl.events.filter((e) => e.type === t);
  const rep = tl.report?.stages || {};
  const computeMs = Object.values(rep).reduce((a, r) => a + (r.ms || 0), 0); // first-run model time (cached stages keep theirs)
  const stageRows = Object.entries(rep).map(([s, r]) => `<tr><td>${esc(STAGE_AR[s] || s)}</td><td>${r.failed ? "❌ فشلت" : r.skipped ? `⏭️ ${esc(r.skipped)}` : r.cached ? "♻️ من الكاش" : "✅"}</td><td>${sec(r.ms)}</td><td>${r.vram?.deltaMB ?? "—"}</td><td>${r.torchPeakMB ?? "—"}</td><td>${esc(r.device || "")}</td><td dir="ltr">${esc(r.model || "")}</td></tr>`).join("");
  const spk = (tl.speakers || []).map((s) => `<tr><td>${esc(s.id)}</td><td>${s.seconds.toFixed(1)} ث</td><td>${s.face ? `${extra.thumbs?.[s.face] ? `<img src="${extra.thumbs[s.face]}" alt="">` : ""} ${esc(s.face)}` : "برّه الكادر"}</td><td>${s.linkConfidence ?? "—"}</td></tr>`).join("");
  const faces = (tl.faces || []).map((f) => `<span class="face">${extra.thumbs?.[f.id] ? `<img src="${extra.thumbs[f.id]}" alt="">` : ""}<b>${esc(f.id)}</b> ${f.seconds.toFixed(0)} ث${f.voice ? ` · صوته ${esc(f.voice)}` : ""}${f.poor ? " · إضاءة ضعيفة" : ""}</span>`).join("");
  const laughs = ev("laughter").slice(0, 40).map((e) => `<li>${clock(e.t0)}–${clock(e.t1)} · ثقة ${e.confidence ?? "—"} · ${esc((e.extra?.sources || []).join(" + "))}${e.speaker ? ` · ${esc(e.speaker)}` : ""}</li>`).join("");
  const tagCount = {};
  for (const e of ev("audio_tag")) tagCount[e.text] = (tagCount[e.text] || 0) + (e.t1 - e.t0);
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `<span class="tag" dir="ltr">${esc(k)} · ${v.toFixed(0)}s</span>`).join("");
  const emo = {};
  for (const e of ev("emotion")) emo[e.text] = (emo[e.text] || 0) + 1;
  const emoTxt = Object.entries(emo).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(EMO_AR[k] || k)} ${v}`).join(" · ");
  const logs = ev("shot_log").map((e) => `<tr><td>${clock(e.t0)}–${clock(e.t1)}</td><td>${esc(e.extra?.summary_ar || "")}</td><td dir="ltr">${esc(e.extra?.shot_size || "")} · ${esc(e.extra?.camera || "")}</td><td>${e.extra?.energy ?? ""}</td><td>${e.extra?.broll_candidate ? "✅" : ""}</td></tr>`).join("");
  const check = (extra.check || []).map((r) => `<tr><td>${esc(r.what)}</td><td>${clock(r.t)}</td><td>${r.verdict === true ? "✅ صح" : r.verdict === false ? "❌ غلط" : "❔ مش متأكد"}</td><td>${esc(r.note || "")}</td></tr>`).join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>الإدراك · ${esc(tl.media?.name || "")}</title>
<style>:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--card:#f7f7f9}@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f5;--mut:#a1a1a6;--line:#2c2c30;--card:#1c1c1f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Segoe UI",Tahoma,sans-serif}main{max-width:1100px;margin:auto;padding:16px}h1{font-size:22px;margin:.2em 0}h2{font-size:17px;margin:1.4em 0 .4em}
.mut{color:var(--mut)}.cards{display:flex;flex-wrap:wrap;gap:8px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px}.card b{font-size:18px;display:block}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:start;vertical-align:top}.tag,.face{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:2px 10px;margin:2px;font-size:13px}
img{width:40px;height:40px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-inline-end:4px}.scroll{overflow-x:auto}</style></head><body><main>
<h1>الإدراك: ${esc(tl.media?.name || "")}</h1>
<p class="mut">${clock(tl.media?.duration || 0)} · ${tl.media?.width}×${tl.media?.height} · ${tl.media?.fps} فريم/ث · بصمة ${esc(tl.media?.hash || "")} · وقت التحليل (أول مرة) ${sec(computeMs)}</p>
<div class="cards">${Object.entries(TYPE_AR).filter(([k]) => c[k]).map(([k, v]) => `<div class="card"><b>${c[k]}</b>${esc(v)}</div>`).join("")}</div>
<h2>الخط الزمني</h2><div class="scroll">${strip(tl)}</div>
<h2>المتكلمين ووشوشهم</h2><table><tr><th>الصوت</th><th>مدة الكلام</th><th>الوش</th><th>ثقة الربط</th></tr>${spk || '<tr><td colspan="4">—</td></tr>'}</table>
<p>${faces || '<span class="mut">مفيش وشوش.</span>'}</p>
<h2>الضحك (${c.laughter || 0})</h2><ul>${laughs || "<li>—</li>"}</ul>
<h2>الأصوات</h2><p>${tags || "—"}</p>
<h2>الإحساس (لكل جملة، للمقارنة بين الإعادات بس)</h2><p>${emoTxt || "—"}</p>
<h2>وصف اللقطات (Qwen3.6)</h2><div class="scroll"><table><tr><th>الوقت</th><th>الوصف</th><th>الحجم · الكاميرا</th><th>الطاقة</th><th>بي-رول</th></tr>${logs || '<tr><td colspan="5">—</td></tr>'}</table></div>
${check ? `<h2>مراجعة بالعين</h2><table><tr><th>إيه</th><th>الوقت</th><th>الحكم</th><th>ملاحظة</th></tr>${check}</table>` : ""}
<h2>وقت كل مرحلة وذاكرة الكارت</h2><div class="scroll"><table><tr><th>المرحلة</th><th>الحالة</th><th>الوقت</th><th>ذاكرة الكارت (زيادة MB)</th><th>torch أقصى MB</th><th>الجهاز</th><th>النموذج</th></tr>${stageRows}</table></div>
<p class="mut">«زيادة الذاكرة» = أعلى استهلاك للكارت كله أثناء المرحلة ناقص اللي كان مستخدم قبلها (nvidia-smi كل نص ثانية).</p>
</main></body></html>`;
}
