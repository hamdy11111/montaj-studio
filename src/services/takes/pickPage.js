// The pick page («اختار الإعادة»): one Arabic HTML page where the user plays every take of every retake group (the raw
// file is played in place, from the take's start to its end — nothing is copied), sees what the scorer chose and why,
// and picks the take they would keep. «احفظ اختياراتي» downloads a small JSON file that `cli.mjs --import-picks` stores
// as the user's picks (the material learnWeights and the agreement measurement need when no published video exists).
import { pathToFileURL } from "node:url";
import { SIGNALS, arGate } from "../../core/takeScore.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sec = (us) => (us / 1e6).toFixed(2);

/** pages: [{ name, res }] — res a montaj.takes/1 result. */
export function pickPageHtml(pages) {
  const cases = pages.map(({ name, res }) => {
    const src = res.media?.path ? pathToFileURL(res.media.path).href : "";
    const groups = res.groups.map((g, gi) => {
      const rows = g.takes.map((t) => {
        const sig = g.signalsUsed.map((s) => `<span title="${esc(SIGNALS[s].en)}">${esc(SIGNALS[s].ar)}: ${t.scores[s].rel === null ? "—" : Math.round(t.scores[s].rel * 100)}</span>`).join(" · ");
        return `<div class="take${t.index === g.kept ? " kept" : ""}">
  <label><input type="radio" name="${esc(name)}__${gi}" value="${t.index}"> الإعادة ${t.index + 1}</label>
  <button type="button" data-v="${esc(name)}__${gi}" data-a="${sec(t.fromUs)}" data-b="${sec(t.toUs)}">▶ اسمع وشوف</button>
  <span class="t">${sec(t.fromUs)}–${sec(t.toUs)} ث</span> «${esc(t.text)}»
  ${t.index === g.kept ? '<b class="tag">اختيار البرنامج</b>' : ""}${t.eligible ? "" : ` <span class="bad">(${esc(t.ineligible.map(arGate).join("، "))})</span>`}
  <div class="sig">${sig || "مفيش إشارات اتقاست"}</div></div>`;
      }).join("\n");
      return `<section class="group"><h3>«${esc(String(g.line).slice(0, 80))}» — ${g.takes.length} إعادات</h3>
<video id="v-${esc(name)}__${gi}" preload="metadata" playsinline src="${esc(src)}"></video>
${rows}
<p class="why">ليه: ${esc(g.reasonAr)}</p>
<label class="note">ملاحظة (اختياري): <input type="text" data-note="${esc(name)}__${gi}"></label></section>`;
    }).join("\n");
    return `<article><h2>${esc(name)} <small>(${esc(res.type)})</small></h2>${groups || "<p>مفيش إعادات في الفيديو ده.</p>"}</article>`;
  }).join("\n");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اختار الإعادة</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1c;--muted:#6b6b6b;--card:#fff;--line:#e3e3df;--acc:#0b6bcb;--ok:#1b7f3b;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ececec;--muted:#a0a0a0;--card:#202020;--line:#333;--acc:#5aa9ff;--ok:#5fd38a;--bad:#ff8a80}}
body{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif;margin:0;padding:16px;max-width:980px;margin-inline:auto}
article,section.group{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}
video{max-width:100%;max-height:360px;background:#000;border-radius:8px;display:block;margin:6px 0}
.take{padding:6px 0;border-top:1px dashed var(--line)}.take.kept{background:color-mix(in srgb,var(--ok) 8%,transparent)}
.tag{color:var(--ok);font-size:.85em}.bad{color:var(--bad)}.t,.sig,.why,small{color:var(--muted);font-size:.85em}
button{font:inherit;padding:2px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
#save{position:sticky;bottom:12px;background:var(--acc);color:#fff;border:0;padding:10px 18px;font-size:1.05em}
.note input{width:min(420px,90%)}
</style></head><body>
<h1>اختار الإعادة اللي كنت هتسيبها</h1>
<p>في كل جملة اتقالت أكتر من مرة: اسمع كل إعادة، واختار اللي انت كنت هتحطها في الفيديو. البرنامج بيتعلّم ذوقك من اختياراتك. لما تخلّص دوس «احفظ اختياراتي» وابعت الملف اللي هيتنزّل.</p>
${cases}
<button id="save" type="button">احفظ اختياراتي</button>
<script>
let stopAt=null,cur=null;
document.querySelectorAll("button[data-v]").forEach(b=>b.addEventListener("click",()=>{const v=document.getElementById("v-"+b.dataset.v);if(cur&&cur!==v)cur.pause();cur=v;v.currentTime=Math.max(0,+b.dataset.a-0.15);stopAt=+b.dataset.b+0.3;v.play();}));
document.querySelectorAll("video").forEach(v=>v.addEventListener("timeupdate",()=>{if(v===cur&&stopAt!==null&&v.currentTime>=stopAt){v.pause();stopAt=null;}}));
document.getElementById("save").addEventListener("click",()=>{const picks=[];document.querySelectorAll("input[type=radio]:checked").forEach(r=>{const i=r.name.lastIndexOf("__");const note=document.querySelector('[data-note="'+r.name+'"]');picks.push({name:r.name.slice(0,i),group:+r.name.slice(i+2),picked:+r.value,note:note&&note.value||null});});
const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify({version:1,at:new Date().toISOString(),picks},null,1)],{type:"application/json"}));a.download="takes-picks.json";a.click();});
</script></body></html>`;
}
